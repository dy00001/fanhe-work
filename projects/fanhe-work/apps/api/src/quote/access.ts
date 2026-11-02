import { createHash, randomBytes } from 'node:crypto'

import { QUOTE_LIMITS, ROLE_CODES, type QuoteAccessStateResponse } from '@fanhe/shared'

import { hashPassword, verifyPassword } from '../auth/password.js'
import type { AuthContext } from '../auth/guard.js'
import { prisma } from '../db/prisma.js'

/**
 * 价格维护的准入。
 *
 * ## 判据是**角色**，不是权限点
 *
 * 需求是「只有超管能直接改价，其他人凭超管设的口令」。而权限点表达不了「口令」
 * 这一层，更要紧的是：admin / designer / sales / member 四个角色都持有
 * `personal.*` 通配（见 `packages/shared/src/permissions.ts` 的 ROLES）。只要
 * 加一个 `personal.quote.write`，它就会被通配静默地一并授予 —— 那时口令是摆设，
 * 而且**没有任何报错**：库里的授权行是对的、日志干净、界面上也看不出谁能改。
 *
 * 所以这里的判据只有两条，与权限点无关：
 *   1. `roleCode === 'owner'` → 直入（`direct`）；
 *   2. 否则必须出示一个**有效的解锁令牌**。
 *
 * ## 为什么口令只有一把、失败计数也是全局的
 *
 * 场景是店里几个人共用一台电脑、一个浏览器。按人计数要回答「换台设备算不算
 * 同一个人」，而按人锁也很容易被「换个账号登录」绕开。锁这把锁本身最直接：
 * 连续错 5 次，15 分钟内谁都不能试。代价是 owner 本人也可能被锁 15 分钟 ——
 * 这个代价可以接受，因为它只在有人连续猜错时发生。
 *
 * ## 令牌只存哈希
 *
 * 明文令牌只在那一次响应里出现。库里存 SHA-256（64 位十六进制，列宽正好），
 * 即使有人拿到库也换不出能用的令牌。改口令时 `version` 加一，所有旧令牌立刻
 * 失效 —— 不需要逐行去删，也不会漏掉某一台设备上的旧会话。
 */

/** 一次请求的写权限。`unlockSessionId` 为 null 表示 owner 直入。 */
export type QuoteWriteAccess = {
  direct: boolean
  unlockSessionId: string | null
}

export type QuoteAccessFailure =
  | 'not_authenticated'
  | 'forbidden'
  | 'no_secret'
  | 'secret_exists'
  | 'invalid_password'
  | 'invalid_password_shape'
  | 'locked'

export type QuoteAccessResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: QuoteAccessFailure; lockedUntil?: Date; failCount?: number }

/** 口令表是单行表。取第一行即可，没有「选哪一行」的问题。 */
async function readSecret() {
  return prisma.quoteAccessSecret.findFirst({
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      hash: true,
      version: true,
      failCount: true,
      lockedUntil: true,
    },
  })
}

/** owner 直入。**只认角色**，理由见文件头。 */
export function isDirectOperator(auth: AuthContext): boolean {
  return auth.roleCode === ROLE_CODES.OWNER
}

/** 口令长度。前端也校验一遍（`QUOTE_LIMITS.PASSWORD_MIN`），但服务端这层才是强制。 */
function checkPasswordShape(password: string): boolean {
  return (
    password.length >= QUOTE_LIMITS.PASSWORD_MIN && password.length <= QUOTE_LIMITS.PASSWORD_MAX
  )
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 当前用户的准入状态。
 *
 * `unlockedUntil` 取的是**最近一个仍然有效的会话**，而不是前端手里的那个令牌的
 * 到期时间：同一个人可能开了两个标签页，其中一个先解锁 —— 让界面统一显示「已解锁
 * 至 X」比让人在第二个标签页里再输一次口令更合理。
 */
export async function getAccessState(auth: AuthContext): Promise<QuoteAccessStateResponse> {
  const direct = isDirectOperator(auth)
  const secret = await readSecret()

  let unlockedUntil: string | null = null
  if (secret !== null) {
    const session = await prisma.quoteUnlockSession.findFirst({
      where: {
        userId: auth.userId,
        revoked: false,
        expiresAt: { gt: new Date() },
        secretVersion: secret.version,
      },
      orderBy: { expiresAt: 'desc' },
      select: { expiresAt: true },
    })
    unlockedUntil = session?.expiresAt.toISOString() ?? null
  }

  const now = new Date()
  const lockedUntil =
    secret?.lockedUntil !== null && secret?.lockedUntil !== undefined && secret.lockedUntil > now
      ? secret.lockedUntil.toISOString()
      : null

  return {
    role: auth.roleCode,
    direct,
    hasSecret: secret !== null,
    unlockedUntil,
    lockedUntil,
    failCount: secret?.failCount ?? 0,
    failLimit: QUOTE_LIMITS.UNLOCK_FAIL_LIMIT,
    passwordMin: QUOTE_LIMITS.PASSWORD_MIN,
  }
}

/**
 * 设置或轮换口令。**仅 owner。**
 *
 * 首次设置与轮换分开返回原因（`secret_exists`），是为了让界面能给出不同的文案：
 * 「设一个口令」与「改口令会让其他设备立即失效」是两件需要不同确认的事。
 */
export async function setAccessSecret(
  auth: AuthContext,
  password: string,
  mode: 'create' | 'rotate',
): Promise<QuoteAccessResult<{ version: number }>> {
  if (!isDirectOperator(auth)) return { ok: false, reason: 'forbidden' }
  if (!checkPasswordShape(password)) return { ok: false, reason: 'invalid_password_shape' }

  const existing = await readSecret()
  if (mode === 'create' && existing !== null) return { ok: false, reason: 'secret_exists' }
  if (mode === 'rotate' && existing === null) return { ok: false, reason: 'no_secret' }

  const hash = await hashPassword(password)

  if (existing === null) {
    await prisma.quoteAccessSecret.create({
      data: { hash, version: 1, updatedBy: auth.userId },
    })
    return { ok: true, value: { version: 1 } }
  }

  const version = existing.version + 1
  await prisma.$transaction([
    prisma.quoteAccessSecret.update({
      where: { id: existing.id },
      data: { hash, version, failCount: 0, lockedUntil: null, updatedBy: auth.userId },
    }),
    // 显式作废旧会话。`secretVersion` 比对本来就能挡住它们，这里再标一次是为了
    // 让「当前有效的解锁有几次」这个查询不必每次都带上版本条件。
    prisma.quoteUnlockSession.updateMany({
      where: { revoked: false },
      data: { revoked: true },
    }),
  ])

  return { ok: true, value: { version } }
}

/**
 * 用口令换一个解锁令牌。
 *
 * 锁定态直接拒绝，**不去校验口令** —— 否则「锁定期间仍然能靠响应时间区分对错」
 * 就成了一条旁路。
 */
export async function unlockWithPassword(
  auth: AuthContext,
  password: string,
  ip: string | null,
): Promise<QuoteAccessResult<{ unlockToken: string; expiresAt: Date }>> {
  const secret = await readSecret()
  if (secret === null) return { ok: false, reason: 'no_secret' }

  const now = new Date()
  if (secret.lockedUntil !== null && secret.lockedUntil > now) {
    return { ok: false, reason: 'locked', lockedUntil: secret.lockedUntil }
  }

  // 锁定期已过：把计数清零再验，否则上一次攒下的 4 次会让这次输错直接触发锁定。
  if (secret.lockedUntil !== null || secret.failCount > 0) {
    await prisma.quoteAccessSecret.update({
      where: { id: secret.id },
      data: { failCount: 0, lockedUntil: null },
    })
  }

  const matched = await verifyPassword(secret.hash, password)

  if (!matched) {
    const failCount = secret.failCount + 1
    const shouldLock = failCount >= QUOTE_LIMITS.UNLOCK_FAIL_LIMIT
    const lockedUntil = shouldLock
      ? new Date(now.getTime() + QUOTE_LIMITS.UNLOCK_LOCK_MINUTES * 60_000)
      : null
    await prisma.quoteAccessSecret.update({
      where: { id: secret.id },
      // 触发锁定时把计数归零：锁定期间不再累加，解锁后也不该带着旧计数。
      data: { failCount: shouldLock ? 0 : failCount, lockedUntil },
    })
    return {
      ok: false,
      reason: 'invalid_password',
      failCount: shouldLock ? 0 : failCount,
      ...(lockedUntil === null ? {} : { lockedUntil }),
    }
  }

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(now.getTime() + QUOTE_LIMITS.UNLOCK_MINUTES * 60_000)

  await prisma.$transaction([
    prisma.quoteAccessSecret.update({
      where: { id: secret.id },
      data: { failCount: 0, lockedUntil: null },
    }),
    prisma.quoteUnlockSession.create({
      data: {
        userId: auth.userId,
        tokenHash: hashToken(token),
        secretVersion: secret.version,
        expiresAt,
        ip,
      },
    }),
  ])

  return { ok: true, value: { unlockToken: token, expiresAt } }
}

/**
 * 解析一次写请求的权限。
 *
 * owner 直入；其余人必须在 `x-quote-unlock` 里带令牌。**令牌与用户绑定**：A 解锁
 * 得到的令牌，B 拿着也不能用 —— 否则同一个人解锁一次，整个办公室就都进来了。
 */
export async function resolveWriteAccess(
  auth: AuthContext,
  rawToken: string | null,
): Promise<QuoteAccessResult<QuoteWriteAccess>> {
  if (isDirectOperator(auth)) {
    return { ok: true, value: { direct: true, unlockSessionId: null } }
  }
  if (rawToken === null || rawToken.trim() === '') return { ok: false, reason: 'forbidden' }

  const secret = await readSecret()
  if (secret === null) return { ok: false, reason: 'no_secret' }

  const session = await prisma.quoteUnlockSession.findUnique({
    where: { tokenHash: hashToken(rawToken.trim()) },
    select: { id: true, userId: true, secretVersion: true, expiresAt: true, revoked: true },
  })

  if (session === null) return { ok: false, reason: 'forbidden' }
  if (session.userId !== auth.userId) return { ok: false, reason: 'forbidden' }
  if (session.revoked || session.expiresAt <= new Date()) return { ok: false, reason: 'forbidden' }
  if (session.secretVersion !== secret.version) return { ok: false, reason: 'forbidden' }

  return { ok: true, value: { direct: false, unlockSessionId: session.id } }
}
