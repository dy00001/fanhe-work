import { AUDIT_ACTIONS } from '@fanhe/shared'

import { recordAudit, type AuditContext } from '../audit/audit.js'
import { env } from '../config/env.js'
import { prisma } from '../db/prisma.js'
import type { Prisma } from '../generated/prisma/client.js'
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  signAccessToken,
} from './tokens.js'

/**
 * 会话的轮换与撤销。
 *
 * 刷新令牌是唯一长期有效的凭证，它的安全模型建立在两点上。
 *
 * 一是**轮换**。每用一次即作废，换一个新的。即使某个令牌被复制走，它的可用
 * 窗口也只到合法客户端下一次刷新为止。库里只存哈希，明文只在签发的那一刻出现。
 *
 * 二是**重放检测**。已作废的令牌被再次使用时，要么是客户端并发提交，要么是
 * 有人拿走了旧令牌。库里无法区分这两者，只能按时间判断：撤销后极短时间内的
 * 重复提交算并发，超出宽限期的算泄露。前者返回失败即可，后者按 familyId
 * 整链撤销。合法用户与攻击者一起失效，用户重新登录，而攻击者手里的令牌
 * 全部作废。
 *
 * 需要明确的一条边界：**撤销不会让已签发的访问令牌立刻失效**。访问令牌是无
 * 状态的 JWT，服务端不查库，它最多再活一个有效期（默认 15 分钟）。要做到
 * 「撤销即刻生效」就必须每个请求查库，那等于放弃无状态。两者不能同时要，
 * 所以访问令牌的有效期必须短。
 */

/** 撤销原因。写入 `refresh_tokens.revoked_reason`，长度受 VarChar(32) 限制。 */
export type RevokeReason =
  /** 正常轮换，旧令牌被新令牌取代。 */
  | 'rotated'
  /** 检测到重放，整条链被撤销。 */
  | 'reuse_detected'
  /** 用户主动登出当前会话。 */
  | 'logout'
  /** 用户登出该设备上的全部会话。 */
  | 'logout_device'
  /** 用户登出全部设备。 */
  | 'logout_all'
  /** 账号被停用或删除，链失去意义。 */
  | 'user_unavailable'

/** 撤销范围。session 只影响当前会话，device 覆盖同一设备，all 覆盖所有设备。 */
export type LogoutScope = 'session' | 'device' | 'all'

/** 轮换失败的原因。只在服务端流转，对外一律是 401。 */
export type RotateFailureReason =
  'token_not_found' | 'token_expired' | 'token_revoked' | 'reuse_detected' | 'user_unavailable'

export type SessionTokens = {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export type RotateResult =
  { ok: true; data: SessionTokens } | { ok: false; reason: RotateFailureReason }

export type LogoutResult = {
  /** 本次实际被撤销的令牌数。已经是撤销状态的不计入。 */
  revoked: number
}

/**
 * 撤销一条链上所有仍然有效的令牌。
 *
 * 用 `updateMany` 加 `revokedAt: null` 条件，而不是按 id 逐个更新：并发下
 * 可能有另一处已经撤销了其中一部分，带条件的更新不会把它们的时间戳覆盖成
 * 后来的原因。撤销时间是「第一次失效的时刻」，不该被后续操作改写。
 */
async function revokeFamily(
  tx: Prisma.TransactionClient,
  familyId: string,
  reason: RevokeReason,
  now: Date,
): Promise<void> {
  await tx.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: now, revokedReason: reason },
  })
}

/**
 * 重放命中时要写进审计的信息。
 *
 * 单独带出来而不是直接在事务里写审计：审计是另一次 INSERT，放进事务会把行锁多
 * 持有一段时间，而这段时间正好卡着并发刷新的第二个请求。
 */
type ReuseAudit = {
  userId: string
  actorName: string
  familyId: string
}

type RotationOutcome =
  | {
      ok: true
      userId: string
      roleCode: string
      passwordChangedAt: Date | null
      refreshToken: string
    }
  | { ok: false; reason: RotateFailureReason; reuse?: ReuseAudit }

/**
 * 用刷新令牌换一组新令牌。
 *
 * 整个判定与写入在一个事务里完成，并用行锁串行化同一令牌的并发请求。没有行锁
 * 的话，两个请求会同时读到「未撤销」，各自签发一份新令牌。一次登录就此裂成
 * 两条互不知晓的链，而两条链都能用，轮换的意义随之消失。
 */
export async function rotateRefreshToken(
  providedToken: string,
  context?: AuditContext,
): Promise<RotateResult> {
  const tokenHash = hashRefreshToken(providedToken)
  const now = new Date()

  const outcome = await prisma.$transaction(async (tx): Promise<RotationOutcome> => {
    // SELECT ... FOR UPDATE 锁住这一行，并发的第二个事务会阻塞在这里，直到
    // 第一个提交后再读，届时它看到的就是已撤销状态。
    const locked = await tx.$queryRaw<Array<{ locked: number }>>`
      SELECT 1 AS locked FROM refresh_tokens WHERE token_hash = ${tokenHash} FOR UPDATE
    `
    if (locked.length === 0) {
      return { ok: false, reason: 'token_not_found' }
    }

    const stored = await tx.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: { include: { role: true } } },
    })
    if (stored === null) {
      // 锁到了行却查不到，只能是并发删除。按不存在处理。
      return { ok: false, reason: 'token_not_found' }
    }

    if (stored.revokedAt !== null) {
      const graceMs = env.jwt.rotationGraceSeconds * 1000
      const withinGrace = now.getTime() - stored.revokedAt.getTime() <= graceMs

      // 因轮换而失效、且落在宽限期内：同一个客户端的并发提交，不是泄露。
      // 不撤链。撤了会把用户正常持有的新令牌一并作废，代价远大于收益。
      if (stored.revokedReason === 'rotated' && withinGrace) {
        return { ok: false, reason: 'token_revoked' }
      }

      // 超出宽限期的重放：这条链已经泄露，整链撤销。
      if (stored.revokedReason === 'rotated') {
        await revokeFamily(tx, stored.familyId, 'reuse_detected', now)
        return {
          ok: false,
          reason: 'reuse_detected',
          reuse: {
            userId: stored.userId,
            actorName: stored.user.displayName,
            familyId: stored.familyId,
          },
        }
      }

      // 因登出或其它原因已撤销的令牌被再次使用。链本身已经失效，无需再撤。
      return { ok: false, reason: 'token_revoked' }
    }

    if (stored.expiresAt.getTime() <= now.getTime()) {
      return { ok: false, reason: 'token_expired' }
    }

    if (stored.user.deletedAt !== null || stored.user.status !== 'active') {
      await revokeFamily(tx, stored.familyId, 'user_unavailable', now)
      return { ok: false, reason: 'user_unavailable' }
    }

    const nextToken = generateRefreshToken()
    await tx.refreshToken.create({
      data: {
        userId: stored.userId,
        tokenHash: hashRefreshToken(nextToken),
        // 沿用同一个 familyId。轮换不产生新链，只是链上的下一环，否则重放
        // 检测就无从追溯到「这一串令牌原本属于同一次登录」。
        familyId: stored.familyId,
        deviceId: stored.deviceId,
        deviceName: stored.deviceName,
        userAgent: stored.userAgent,
        ip: stored.ip,
        // 过期时间从当前时刻重新起算，即滑动过期：持续在用的会话不会因为
        // 累计时长到期而中断。代价是链没有绝对寿命，因此重放检测与手动撤销
        // 是仅有的两道止损，二者都不能省。
        expiresAt: refreshTokenExpiry(now),
      },
    })
    await tx.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: now, revokedReason: 'rotated' },
    })

    return {
      ok: true,
      userId: stored.userId,
      roleCode: stored.user.role.code,
      // 换发出来的访问令牌要带改密时间的快照，判据见 tokens.ts 的
      // isStaleByPasswordChange。上面那次查询是 `include: { user: ... }`，
      // 整行用户字段都在，因此这里不需要额外查库。
      passwordChangedAt: stored.user.passwordChangedAt,
      refreshToken: nextToken,
    }
  })

  if (!outcome.ok) {
    // 重放是真正的安全事件，值得单独留痕：要么有人拿到了旧令牌，要么客户端在
    // 宽限期之外重试。记在事务外，不延长持锁时间。
    //
    // `user_unavailable` 不记。那是账号状态变更的连带结果，账号管理本身会有对应
    // 的事件；而且合法客户端在账号被停用后每次刷新都会撞上它，记下来只有噪声。
    if (outcome.reuse !== undefined) {
      await recordAudit({
        action: AUDIT_ACTIONS.AUTH_SESSION_REUSE,
        result: 'failure',
        actor: { id: outcome.reuse.userId, name: outcome.reuse.actorName },
        // 记的是会话链而不是单个令牌：整链被撤销，而令牌明文与哈希都不该进审计。
        target: { type: 'session_family', id: outcome.reuse.familyId },
        detail: { reason: 'reuse_detected' },
        ip: context?.ip,
        userAgent: context?.userAgent,
      })
    }
    return { ok: false, reason: outcome.reason }
  }

  // 签发放在事务之外：它是纯计算，放进事务只会延长持锁时间，让并发的第二个
  // 请求多等一次签名。
  const accessToken = await signAccessToken({
    sub: outcome.userId,
    role: outcome.roleCode,
    pwd: outcome.passwordChangedAt === null ? null : outcome.passwordChangedAt.getTime(),
  })
  return {
    ok: true,
    data: {
      accessToken,
      refreshToken: outcome.refreshToken,
      expiresIn: env.jwt.accessTtlSeconds,
    },
  }
}

/**
 * 登出。
 *
 * 幂等：令牌不存在、已撤销、已过期，一律返回成功。客户端在令牌失效后重试登出、
 * 或用户重复点击，都不该看到一个失败提示。登出的目的是「让这个凭证不再可用」，
 * 而它已经不可用了，目标本身是达成的。
 *
 * 撤销范围决定影响面。`device` 与 `all` 都需要先从令牌反查出账号，因此登出本身
 * 就是一次「用刷新令牌证明身份」的操作，不需要访问令牌参与。
 */
export async function logout(
  providedToken: string,
  scope: LogoutScope,
  context?: AuditContext,
): Promise<LogoutResult> {
  const tokenHash = hashRefreshToken(providedToken)
  const now = new Date()

  const outcome = await prisma.$transaction(
    async (tx): Promise<{ revoked: number; actor: { id: string; name: string } | null }> => {
      const stored = await tx.refreshToken.findUnique({
        where: { tokenHash },
        select: {
          userId: true,
          familyId: true,
          deviceId: true,
          user: { select: { displayName: true } },
        },
      })
      if (stored === null) {
        return { revoked: 0, actor: null }
      }

      const reason: RevokeReason =
        scope === 'all' ? 'logout_all' : scope === 'device' ? 'logout_device' : 'logout'

      // scope 为 device 但令牌没有记录设备号时退化为只撤当前会话。无从识别设备
      // 就把整个账号的会话全撤掉，会把用户从其它正常的设备上踢出去。
      const where: Prisma.RefreshTokenWhereInput =
        scope === 'all'
          ? { userId: stored.userId, revokedAt: null }
          : scope === 'device' && stored.deviceId !== null
            ? { userId: stored.userId, deviceId: stored.deviceId, revokedAt: null }
            : { familyId: stored.familyId, revokedAt: null }

      const result = await tx.refreshToken.updateMany({
        where,
        data: { revokedAt: now, revokedReason: reason },
      })
      return { revoked: result.count, actor: { id: stored.userId, name: stored.user.displayName } }
    },
  )

  // 只在实际撤销了令牌时记。登出是幂等的，客户端在令牌失效后重试、用户重复点击
  // 都会走到这里，每次都记一条只会把审计淹掉。没撤销任何东西，就等于没有事件。
  if (outcome.revoked > 0 && outcome.actor !== null) {
    await recordAudit({
      action: AUDIT_ACTIONS.AUTH_SESSION_LOGOUT,
      actor: outcome.actor,
      detail: { scope, revoked: outcome.revoked },
      ip: context?.ip,
      userAgent: context?.userAgent,
    })
  }

  return { revoked: outcome.revoked }
}
