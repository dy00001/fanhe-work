import { randomBytes } from 'node:crypto'

import { normalizeUsername } from '@fanhe/shared'

import { env } from '../config/env.js'
import { prisma } from '../db/prisma.js'
import type { LoginOutcome } from '../generated/prisma/client.js'
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
 * 对外只有一种失败。账号不存在、密码错误、账号被停用、账号被锁定，返回给调用方
 * 的结果完全相同，因此调用方拿不到判断用户名是否存在的依据。把原因分开看起来
 * 更友好，但「该用户不存在」与「密码错误」这两条提示凑在一起，本身就是一个可用
 * 的账号枚举接口。攻击者可以先跑一遍常见用户名，把存在的挑出来再针对它们爆破。
 *
 * 唯一的例外是 IP 维度限速，它返回 429 而不是 401。它不涉及任何账号信息，只说明
 * 「这个来源短时间内失败太多次」。把限速也伪装成 401，会让正常用户以为密码错了
 * 而反复重试，把窗口越拖越长。
 *
 * 内部仍然区分原因，计数、锁定与尝试记录都需要知道是哪一种。这些原因留在服务端，
 * 只进日志与 login_attempts 表。
 */

/** 账号维度的阈值。按机器调整改 .env，改这里的默认值等于改所有环境的行为。 */
const MAX_FAILED_ATTEMPTS = env.login.maxFailedAttempts
/** 锁定时长。 */
const LOCK_DURATION_MS = env.login.lockMinutes * 60_000

/**
 * 账号不存在时用来消耗时间的假哈希。
 *
 * 在模块加载时现算一个，不写死常量。写死的哈希会进版本控制，任何人都能从仓库
 * 读到它的参数，换了哈希算法之后也容易忘记同步。
 *
 * 它的作用只在于让各条失败路径的耗时接近，与验证无关。少了它，不存在的账号会
 * 立刻返回，而存在的账号要等一次 Argon2 计算，几十毫秒的稳定差别足以用来枚举
 * 用户名。
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

/** 失败原因。只在服务端流转，不进入响应体。ip_rate_limited 是唯一决定状态码的一个。 */
export type LoginFailureReason =
  'invalid_credentials' | 'account_unavailable' | 'account_locked' | 'ip_rate_limited'

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

/**
 * 统计某个 IP 在窗口内的失败次数。
 *
 * 只统计失败。成功登录不计入，否则一个正常用户在多标签页里反复登录，也会把自己
 * 挡在外面。窗口是滑动的，没有「整点归零」这种边界，因此不存在窗口切换瞬间允许
 * 双倍尝试的问题。
 */
async function countRecentFailures(ip: string): Promise<number> {
  const since = new Date(Date.now() - env.login.ipWindowMinutes * 60_000)
  return prisma.loginAttempt.count({
    where: { ip, createdAt: { gte: since }, outcome: { not: 'success' } },
  })
}

/**
 * 记一条登录尝试，并顺带清理超期记录。
 *
 * 清理挂在写入路径上，不引入定时任务。个人工作台的登录频率很低，每次多一条走
 * 索引的删除语句，开销可以忽略；为一张几天才写几十行的表专门起一个调度器，复杂度
 * 远大于收益。
 *
 * 删除条件用全局时间范围，不按 IP 限定。超期记录对任何 IP 都没有价值，留着只会
 * 让表持续变大。
 */
async function recordAttempt(ip: string, username: string, outcome: LoginOutcome): Promise<void> {
  const cutoff = new Date(Date.now() - env.login.attemptRetentionHours * 3600_000)
  await prisma.$transaction([
    prisma.loginAttempt.create({ data: { ip, username, outcome } }),
    prisma.loginAttempt.deleteMany({ where: { createdAt: { lt: cutoff } } }),
  ])
}

export async function login(input: LoginInput): Promise<LoginResult> {
  // 没有来源地址时归到一个统一的桶里。Fastify 的 request.ip 取自 socket，正常
  // 路径下一定有值；测试与内部调用可能不传。
  const ip = input.ip ?? 'unknown'
  // 提交的原值用于记录，归一后的值用于查询，两者不能合并。库里存的是归一形式，
  // 拿原值去比会漏掉大小写与首尾空白的差异，用户输入 Admin 就登不上 admin 这个
  // 账号。而尝试记录要忠实反映提交了什么，归一之后就看不出有人在试大小写变体。
  const submittedUsername = input.username
  const username = normalizeUsername(submittedUsername)

  // IP 维度先判。被限速的请求直接返回，连哈希校验都不做。限速的目的就是阻止
  // 攻击者消耗资源，如果这里还照常算一次 Argon2，限速本身就成了 CPU 放大器：
  // 攻击者用大量请求就能把服务端打满，而挡在前面的限速恰恰在帮他完成这件事。
  //
  // 被限速的请求也不写 login_attempts。写的话，攻击者只要持续发请求就能让这张表
  // 按请求量增长，同样是放大器。计数只需要「窗口内已有多少次失败」，被拒绝的尝试
  // 对它是无贡献的。
  const recentFailures = await countRecentFailures(ip)
  if (recentFailures >= env.login.ipMaxFailedAttempts) {
    return { ok: false, reason: 'ip_rate_limited' }
  }

  const user = await prisma.user.findFirst({
    where: { username, deletedAt: null },
    include: { role: true },
  })

  if (user === null) {
    await burnTime(input.password)
    await recordAttempt(ip, submittedUsername, 'unknown_user')
    return { ok: false, reason: 'invalid_credentials' }
  }

  // 状态与锁定都先于密码校验判断，但同样要消耗一次哈希时间。否则「账号被停用」
  // 会比「密码错误」快得多，这个时间差本身就是一种可用的枚举信号。
  if (user.status !== 'active') {
    await burnTime(input.password)
    await recordAttempt(ip, submittedUsername, 'account_unavailable')
    return { ok: false, reason: 'account_unavailable' }
  }

  if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
    await burnTime(input.password)
    await recordAttempt(ip, submittedUsername, 'account_locked')
    return { ok: false, reason: 'account_locked' }
  }

  const passwordMatches = await verifyPassword(user.passwordHash, input.password)
  if (!passwordMatches) {
    await recordFailedAttempt(user.id, user.failedLoginAttempts)
    await recordAttempt(ip, submittedUsername, 'wrong_password')
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

  await recordAttempt(ip, username, 'success')

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
