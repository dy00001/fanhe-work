/**
 * 登录限速的集成测试。
 *
 * 需要真实数据库。限速的判定建立在「窗口内的失败记录条数」上，用内存替身测不出
 * 真实的时间条件与并发行为，因此这里连真实实例，库不可达时整体跳过。
 *
 * 测试数据分两类，都带可识别的标记，结束时统一清理。账号用 `zz_test_` 前缀的
 * 用户名，登录记录用 RFC 5737 的文档用地址段 `192.0.2.0/24` 作为来源 IP，两者
 * 都不会与真实数据或其它测试文件冲突。
 *
 * 阈值不写死在测试里，一律从 `env.login` 读。默认值改了，测试跟着走，不会因为
 * 「测试还在按旧阈值构造数据」而误报。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

// test-env.ts 已经把 DATABASE_URL 指向一个不可达地址，这里在 env.ts 被求值之前
// 换回真实值。下面一律用动态 import，静态 import 会被提升到本段之前执行。
const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { env } = await import('../src/config/env.js')
const { hashPassword } = await import('../src/auth/password.js')
const { hashRefreshToken } = await import('../src/auth/tokens.js')
const { login } = await import('../src/auth/login.js')
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
/** RFC 5737 的 TEST-NET-1，专供文档与测试使用，不会与真实地址冲突。 */
const TEST_IP_PREFIX = '192.0.2.'

async function databaseReachable(): Promise<boolean> {
  if (databaseUrl === null) {
    return false
  }
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

const reachable = await databaseReachable()

if (!reachable) {
  // 必须显式出声。describe 的 skip 只会让整个 suite 从统计里消失，总数变少而
  // skipped 与 fail 都是 0，输出全绿。静默跳过会把「没跑」显示成「跑过了」。
  console.warn('[login.test] 数据库不可达，登录限速的集成测试未执行')
}

describe('登录限速', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  let memberRoleId = ''
  let passwordHash = ''
  let ipCounter = 0

  before(async () => {
    const role = await prisma.role.findUnique({
      where: { code: 'member' },
      select: { id: true },
    })
    if (role === null) {
      throw new Error('库里没有 member 角色，先执行 pnpm db:seed')
    }
    memberRoleId = role.id
    passwordHash = await hashPassword(TEST_PASSWORD)
  })

  after(async () => {
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: TEST_IP_PREFIX } } })
    // 每次登录尝试都会写一条审计，同样按来源地址清掉。
    await prisma.auditLog.deleteMany({ where: { ip: { startsWith: TEST_IP_PREFIX } } })
    await prisma.$disconnect()
  })

  /** 每个用例分配一个独立 IP，避免限速计数互相污染。 */
  function nextIp(): string {
    ipCounter += 1
    return `${TEST_IP_PREFIX}${ipCounter}`
  }

  async function createUser(): Promise<{ id: string; username: string }> {
    const user = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        passwordHash,
        displayName: '集成测试账号',
        roleId: memberRoleId,
      },
      select: { id: true, username: true },
    })
    createdUserIds.push(user.id)
    return user
  }

  /** 一个确定不存在的用户名。用它制造失败，可以不触碰任何账号的锁定计数。 */
  function ghostUsername(): string {
    return `${TEST_DATA_PREFIX}ghost`
  }

  /** 用同一个 IP 连续失败若干次，把它的失败计数填到阈值。 */
  async function exhaustIp(ip: string, times: number): Promise<void> {
    for (let i = 0; i < times; i += 1) {
      const result = await login({ username: ghostUsername(), password: 'wrong-password', ip })
      assert.equal(result.ok, false)
    }
  }

  test('连续失败达到阈值后锁定账号，锁定期内密码正确也被拒绝', async () => {
    const ip = nextIp()
    const user = await createUser()

    for (let i = 0; i < env.login.maxFailedAttempts; i += 1) {
      const result = await login({ username: user.username, password: 'wrong-password', ip })
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.equal(result.reason, 'invalid_credentials')
    }

    const locked = await prisma.user.findUnique({
      where: { id: user.id },
      select: { failedLoginAttempts: true, lockedUntil: true },
    })
    assert.ok(locked !== null)
    if (locked === null) return
    assert.equal(locked.failedLoginAttempts, env.login.maxFailedAttempts)
    assert.ok(locked.lockedUntil !== null)

    // 密码正确也一样被挡。对外仍然只有一种响应，调用方分不出是锁定还是密码错。
    const correct = await login({ username: user.username, password: TEST_PASSWORD, ip })
    assert.equal(correct.ok, false)
    if (correct.ok) return
    assert.equal(correct.reason, 'account_locked')
  })

  test('登录成功后失败计数清零，锁定一并解除', async () => {
    const ip = nextIp()
    const user = await createUser()

    await login({ username: user.username, password: 'wrong-password', ip })
    await login({ username: user.username, password: 'wrong-password', ip })

    const beforeLogin = await prisma.user.findUnique({
      where: { id: user.id },
      select: { failedLoginAttempts: true },
    })
    assert.equal(beforeLogin?.failedLoginAttempts, 2)

    const success = await login({ username: user.username, password: TEST_PASSWORD, ip })
    assert.equal(success.ok, true)

    const afterLogin = await prisma.user.findUnique({
      where: { id: user.id },
      select: { failedLoginAttempts: true, lockedUntil: true },
    })
    assert.equal(afterLogin?.failedLoginAttempts, 0)
    assert.equal(afterLogin?.lockedUntil, null)
  })

  test('同一 IP 窗口内失败超过阈值后，该来源的登录一律被拒绝', async () => {
    const ip = nextIp()
    await exhaustIp(ip, env.login.ipMaxFailedAttempts)

    // 阈值用尽。此后即使提交正确的账号与密码，也先被 IP 这一层挡住。
    // 这正是 IP 维度存在的意义：它不关心账号是否存在，只看来源的失败密度。
    const user = await createUser()
    const blocked = await login({ username: user.username, password: TEST_PASSWORD, ip })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.reason, 'ip_rate_limited')
  })

  test('被限速的请求不写登录记录，记录量不随请求量增长', async () => {
    const ip = nextIp()
    await exhaustIp(ip, env.login.ipMaxFailedAttempts)

    const beforeBlocking = await prisma.loginAttempt.count({ where: { ip } })
    assert.equal(beforeBlocking, env.login.ipMaxFailedAttempts)

    for (let i = 0; i < 5; i += 1) {
      const result = await login({ username: ghostUsername(), password: 'wrong-password', ip })
      assert.equal(result.ok, false)
    }

    // 否则攻击者只要持续发请求就能让这张表按请求量增长，限速反而成了放大器。
    const afterBlocking = await prisma.loginAttempt.count({ where: { ip } })
    assert.equal(afterBlocking, beforeBlocking)
  })

  test('限速按 IP 隔离，另一个来源不受影响', async () => {
    const blockedIp = nextIp()
    const otherIp = nextIp()
    await exhaustIp(blockedIp, env.login.ipMaxFailedAttempts)

    const blocked = await login({ username: ghostUsername(), password: 'x', ip: blockedIp })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.reason, 'ip_rate_limited')

    const user = await createUser()
    const other = await login({ username: user.username, password: TEST_PASSWORD, ip: otherIp })
    assert.equal(other.ok, true)
  })

  test('窗口之外的失败不计入限速', async () => {
    const ip = nextIp()
    await exhaustIp(ip, env.login.ipMaxFailedAttempts)

    const blocked = await login({ username: ghostUsername(), password: 'x', ip })
    assert.equal(blocked.ok, false)
    if (blocked.ok) return
    assert.equal(blocked.reason, 'ip_rate_limited')

    // 把这些记录的时间挪到窗口之外，模拟时间流逝。
    await prisma.loginAttempt.updateMany({
      where: { ip },
      data: { createdAt: new Date(Date.now() - (env.login.ipWindowMinutes + 1) * 60_000) },
    })

    const user = await createUser()
    const afterWindow = await login({ username: user.username, password: TEST_PASSWORD, ip })
    assert.equal(afterWindow.ok, true)
  })

  test('登录记录写入正确的 outcome 与用户名', async () => {
    const ip = nextIp()
    const user = await createUser()
    const ghost = ghostUsername()

    await login({ username: ghost, password: 'x', ip })
    await login({ username: user.username, password: 'wrong-password', ip })
    await login({ username: user.username, password: TEST_PASSWORD, ip })

    const rows = await prisma.loginAttempt.findMany({
      where: { ip },
      select: { outcome: true, username: true },
    })

    // 按 outcome 建映射而不依赖行顺序。三次登录间隔都在几十毫秒以上，理论上
    // 排序是稳定的，但依赖时间戳排序会让这个断言在机器变快时变得脆弱。
    const byOutcome = new Map(rows.map((row) => [row.outcome, row.username]))
    assert.equal(rows.length, 3)
    assert.equal(byOutcome.get('unknown_user'), ghost)
    assert.equal(byOutcome.get('wrong_password'), user.username)
    assert.equal(byOutcome.get('success'), user.username)
  })

  test('账号被停用时记为 account_unavailable', async () => {
    const ip = nextIp()
    const user = await createUser()
    await prisma.user.update({ where: { id: user.id }, data: { status: 'disabled' } })

    const result = await login({ username: user.username, password: TEST_PASSWORD, ip })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'account_unavailable')

    const row = await prisma.loginAttempt.findFirst({ where: { ip }, select: { outcome: true } })
    assert.equal(row?.outcome, 'account_unavailable')
  })

  test('超出保留期的登录记录会在写入时被清理', async () => {
    const ip = nextIp()
    const staleIp = nextIp()

    await prisma.loginAttempt.create({
      data: {
        ip: staleIp,
        username: `${TEST_DATA_PREFIX}stale`,
        outcome: 'wrong_password',
        createdAt: new Date(Date.now() - (env.login.attemptRetentionHours + 1) * 3600_000),
      },
    })
    assert.equal(await prisma.loginAttempt.count({ where: { ip: staleIp } }), 1)

    // 任意一次登录写入都会顺带清理超期记录，不依赖定时任务。
    await login({ username: ghostUsername(), password: 'x', ip })

    assert.equal(await prisma.loginAttempt.count({ where: { ip: staleIp } }), 0)
  })

  test('路由层对 IP 限速返回 429，并给出 Retry-After', async () => {
    const ip = nextIp()
    await exhaustIp(ip, env.login.ipMaxFailedAttempts)

    const app = buildApp({ logger: false })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: ghostUsername(), password: 'wrong-password' },
        remoteAddress: ip,
      })

      assert.equal(response.statusCode, 429)
      assert.equal(response.headers['retry-after'], String(env.login.ipWindowMinutes * 60))
      assert.equal(response.json().error, 'too_many_requests')
    } finally {
      await app.close()
    }
  })

  test('路由层对其余失败仍返回统一的 401', async () => {
    const ip = nextIp()
    const user = await createUser()

    const app = buildApp({ logger: false })
    try {
      const wrongPassword = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: user.username, password: 'wrong-password' },
        remoteAddress: ip,
      })
      const unknownUser = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: ghostUsername(), password: 'wrong-password' },
        remoteAddress: ip,
      })

      assert.equal(wrongPassword.statusCode, 401)
      assert.equal(unknownUser.statusCode, 401)
      // 两条响应必须逐字节一致，否则状态码与正文的差异本身就是账号枚举接口。
      assert.equal(wrongPassword.body, unknownUser.body)
    } finally {
      await app.close()
    }
  })

  /**
   * schema 校验发生在进入处理器之前，因此这些请求不会写 login_attempts 与审计。
   * 这也正是「被拒的请求不产生任何写入」这条规则的一部分。
   */
  test('路由层拒绝缺字段、多余字段与超长账号名的登录请求', async () => {
    const ip = nextIp()
    const app = buildApp({ logger: false })
    try {
      const missingPassword = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'someone' },
        remoteAddress: ip,
      })
      assert.equal(missingPassword.statusCode, 400)

      // 多余字段必须被拒绝，而不是被静默丢弃。Fastify 的 AJV 默认
      // removeAdditional: true，那会让 additionalProperties: false 变成一次
      // 删除，请求照常返回 200，调用方以为某个字段生效了而它从未被读取。
      const extraField = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'someone', password: 'whatever', admin: true },
        remoteAddress: ip,
      })
      assert.equal(extraField.statusCode, 400)

      const tooLong = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'a'.repeat(65), password: 'whatever' },
        remoteAddress: ip,
      })
      assert.equal(tooLong.statusCode, 400)

      assert.equal(await prisma.loginAttempt.count({ where: { ip } }), 0)
    } finally {
      await app.close()
    }
  })

  test('登录成功后写入刷新令牌哈希并更新最后登录时间', async () => {
    const ip = nextIp()
    const user = await createUser()

    const result = await login({ username: user.username, password: TEST_PASSWORD, ip })
    assert.equal(result.ok, true)
    if (!result.ok) return

    // 明文只在签发的那一刻出现在响应里，库里只有它的摘要。这条断言是「拖库者
    // 拿不到可用凭证」这个保证的直接验证。
    const stored = await prisma.refreshToken.findFirst({
      where: { userId: user.id },
      select: { tokenHash: true, expiresAt: true, revokedAt: true },
    })
    assert.ok(stored !== null)
    if (stored === null) return
    assert.equal(stored.tokenHash, hashRefreshToken(result.data.refreshToken))
    // SHA-256 的十六进制表示固定 64 字符。长度不对说明存错了东西。
    assert.equal(stored.tokenHash.length, 64)
    assert.notEqual(stored.tokenHash, result.data.refreshToken)
    assert.equal(stored.revokedAt, null)
    assert.ok(stored.expiresAt.getTime() > Date.now())

    const after = await prisma.user.findUnique({
      where: { id: user.id },
      select: { lastLoginAt: true, failedLoginAttempts: true, lockedUntil: true },
    })
    assert.ok(after !== null)
    if (after === null) return
    assert.ok(after.lastLoginAt !== null)
    assert.equal(after.failedLoginAttempts, 0)
    assert.equal(after.lockedUntil, null)
  })

  test('路由层登录成功返回双令牌与用户信息，且不泄露任何哈希', async () => {
    const ip = nextIp()
    const user = await createUser()
    const app = buildApp({ logger: false })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: user.username, password: TEST_PASSWORD },
        remoteAddress: ip,
      })

      assert.equal(response.statusCode, 200)
      const body = response.json()
      assert.equal(typeof body.accessToken, 'string')
      assert.equal(typeof body.refreshToken, 'string')
      // 客户端靠这个值安排静默续期，必须与服务端配置一致。对不上会让续期
      // 要么过早（多发请求）要么过晚（每个到期点先失败一次）。
      assert.equal(body.expiresIn, env.jwt.accessTtlSeconds)
      assert.equal(body.user.username, user.username)
      assert.equal(body.user.role, 'member')
      assert.equal(Object.hasOwn(body, 'passwordHash'), false)
      assert.equal(Object.hasOwn(body.user, 'passwordHash'), false)
    } finally {
      await app.close()
    }
  })
})
