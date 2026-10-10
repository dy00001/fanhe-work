import { randomBytes } from 'node:crypto'

import { env } from '../config/env.js'
import { prisma } from '../db/prisma.js'
import { hashPassword, verifyPassword } from './password.js'
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  signAccessToken,
} from './tokens.js'

/**
 * 登录。
 *
 * 对外只有一种失败。账号不存在、密码错误、账号被停用、账号被锁定，返回给调用方的
 * 结果完全相同，因此调用方拿不到判断用户名是否存在的依据。把原因分开看起来更友好，
 * 但「该用户不存在」与「密码错误」这两条提示凑在一起，本身就是一个可用的账号
 * 枚举接口 —— 攻击者可以先跑一遍常见用户名，把存在的挑出来再针对它们做爆破。
 *
 * 内部仍然区分原因：计数、锁定与审计都需要知道是哪一种。这些原因留在服务端，
 * 只进日志。
 */

/** 连续失败多少次后锁定账号。T1-06 做限速时会连同 IP 维度一起配置化。 */
const MAX_FAILED_ATTEMPTS = 5
/** 锁定时长。 */
const LOCK_DURATION_MS = 15 * 60_000

/**
 * 账号不存在时用来消耗时间的假哈希。
 *
 * 在模块加载时现算一个，而不是写死一个常量：写死的哈希会进版本控制，任何人都能
 * 从仓库读到它的参数，而且换了哈希算法之后容易忘记同步更新。
 *
 * 它的作用不是「验证什么」，而是让各条失败路径的耗时接近。少了它，不存在的账号
 * 会立刻返回，而存在的账号要等一次 Argon2 计算 —— 几十毫秒的稳定差别，足以用
 * 来枚举用户名。
 */
const DUMMY_HASH = await hashPassword(randomBytes(32).toString('hex'))

export type LoginInput = {
  username: string
  password: string
  deviceId?: string | undefined
  deviceName?: string | undefined
  userAgent?: string | undefined
  ip?: string | undefined
}

export type AuthenticatedUser = {
  id: string
  username: string
  displayName: string
  role: string
}

export type LoginSuccess = {
  accessToken: string
  refreshToken: string
  expiresIn: number
  user: AuthenticatedUser
}

/** 失败原因。只在服务端流转，不进入响应体。 */
export type LoginFailureReason = 'invalid_credentials' | 'account_unavailable' | 'account_locked'

export type LoginResult =
  { ok: true; data: LoginSuccess } | { ok: false; reason: LoginFailureReason }

/** 走一次哈希校验并丢弃结果，只为让耗时与真实校验对齐。 */
async function burnTime(password: string): Promise<void> {
  await verifyPassword(DUMMY_HASH, password)
}

/** 记一次失败，达到阈值就锁定。 */
async function recordFailedAttempt(userId: string, previousAttempts: number): Promise<void> {
  const attempts = previousAttempts + 1
  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginAttempts: attempts,
      lockedUntil: attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCK_DURATION_MS) : null,
    },
  })
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const user = await prisma.user.findFirst({
    where: { username: input.username, deletedAt: null },
    include: { role: true },
  })

  if (user === null) {
    await burnTime(input.password)
    return { ok: false, reason: 'invalid_credentials' }
  }

  // 状态与锁定都先于密码校验判断，但同样要消耗一次哈希时间。否则「账号被停用」
  // 会比「密码错误」快得多，这个时间差本身就是一种可用的枚举信号。
  if (user.status !== 'active') {
    await burnTime(input.password)
    return { ok: false, reason: 'account_unavailable' }
  }

  if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
    await burnTime(input.password)
    return { ok: false, reason: 'account_locked' }
  }

  const passwordMatches = await verifyPassword(user.passwordHash, input.password)
  if (!passwordMatches) {
    await recordFailedAttempt(user.id, user.failedLoginAttempts)
    return { ok: false, reason: 'invalid_credentials' }
  }

  const refreshToken = generateRefreshToken()
  const accessToken = await signAccessToken({ sub: user.id, role: user.role.code })

  // 写令牌与更新登录状态放进一个事务：只写成一半的话，要么用户拿到一个库里没有
  // 对应记录的刷新令牌，要么登录成功却没有更新 lastLoginAt 与失败计数。
  await prisma.$transaction([
    prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: hashRefreshToken(refreshToken),
        expiresAt: refreshTokenExpiry(),
        deviceId: input.deviceId ?? null,
        deviceName: input.deviceName ?? null,
        userAgent: input.userAgent ?? null,
        ip: input.ip ?? null,
      },
    }),
    prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    }),
  ])

  return {
    ok: true,
    data: {
      accessToken,
      refreshToken,
      expiresIn: env.jwt.accessTtlSeconds,
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role.code,
      },
    },
  }
}
