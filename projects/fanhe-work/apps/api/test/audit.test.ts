/**
 * 审计日志的集成测试。
 *
 * 需要真实数据库。写入点分布在登录、登出、重放检测与首次初始化四条路径上，验证的
 * 是「这些路径确实各自留下了记录」，用替身测不出路由与 service 之间的接线。
 *
 * 来源 IP 用 RFC 5737 的 TEST-NET-3 段 `203.0.113.0/24`，本文件独占，清理时能精确
 * 圈定。每个用例再分一个独立地址，避免同一文件内的记录互相干扰。
 *
 * 从零初始化的用例要求库里没有 owner 角色账号，与 setup.test.ts 是同一个前提，
 * 因此本套测试同样依赖串行执行，理由见 setup.test.ts 的文件头。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { AUDIT_ACTIONS } from '@fanhe/shared'

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
const { login } = await import('../src/auth/login.js')
const { logout, rotateRefreshToken } = await import('../src/auth/session.js')
const { hashRefreshToken } = await import('../src/auth/tokens.js')
const { initializeOwner } = await import('../src/auth/setup.js')
const { recordAudit } = await import('../src/audit/audit.js')
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
/** RFC 5737 的 TEST-NET-3。本文件独占这一段。 */
const TEST_IP_PREFIX = '203.0.113.'

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

let ownerCountBefore = 0
if (reachable) {
  ownerCountBefore = await prisma.user.count({ where: { role: { code: 'owner' } } })
}
const cleanStart = ownerCountBefore === 0

if (!reachable) {
  // 必须显式出声。describe 的 skip 只会让整个 suite 从统计里消失，总数变少而
  // skipped 与 fail 都是 0，输出全绿。静默跳过会把「没跑」显示成「跑过了」。
  console.warn('[audit.test] 数据库不可达，审计日志的集成测试未执行')
}

describe('审计日志', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
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
    // 审计行按来源地址清理。审计是长期保留的流水，测试造的记录没有保留价值。
    await prisma.auditLog.deleteMany({ where: { ip: { startsWith: TEST_IP_PREFIX } } })
    await prisma.loginAttempt.deleteMany({ where: { ip: { startsWith: TEST_IP_PREFIX } } })
    await prisma.$disconnect()
  })

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

  function loginAudits(ip: string) {
    return prisma.auditLog.findMany({
      where: { ip, action: AUDIT_ACTIONS.AUTH_SESSION_LOGIN },
      orderBy: { createdAt: 'asc' },
    })
  }

  test('登录成功写入审计，操作者与来源齐全', async () => {
    const ip = nextIp()
    const user = await createUser()

    const app = buildApp({ logger: false })
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: user.username, password: TEST_PASSWORD },
        remoteAddress: ip,
        headers: { 'user-agent': 'audit-test-agent' },
      })
      assert.equal(response.statusCode, 200)
    } finally {
      await app.close()
    }

    const rows = await loginAudits(ip)
    assert.equal(rows.length, 1)
    const row = rows[0]
    assert.ok(row !== undefined)
    if (row === undefined) return

    assert.equal(row.result, 'success')
    assert.equal(row.actorId, user.id)
    // actorName 是写入时的快照，账号删除后仍然留得住。
    assert.equal(row.actorName, '集成测试账号')
    assert.equal(row.userAgent, 'audit-test-agent')
    assert.deepEqual(row.detail, { username: user.username })
  })

  test('登录失败写入审计，不填操作者，原因与提交的账号名进 detail', async () => {
    const wrongPasswordIp = nextIp()
    const unknownUserIp = nextIp()
    const user = await createUser()

    // 密码错误：账号确实存在，但审计里仍然不填 actor。
    await login({
      username: user.username,
      password: 'wrong-password',
      ip: wrongPasswordIp,
      userAgent: 'audit-test-agent',
    })

    // 账号不存在：只留下有人试过这个名字。
    await login({ username: ghostUsername(), password: 'x', ip: unknownUserIp })

    const wrongPasswordRows = await loginAudits(wrongPasswordIp)
    assert.equal(wrongPasswordRows.length, 1)
    const wrongPasswordRow = wrongPasswordRows[0]
    assert.ok(wrongPasswordRow !== undefined)
    if (wrongPasswordRow === undefined) return

    assert.equal(wrongPasswordRow.result, 'failure')
    // 只在账号存在时才填 actor，等于让 actor 列变成「账号存不存在」的旁路判据。
    assert.equal(wrongPasswordRow.actorId, null)
    assert.equal(wrongPasswordRow.actorName, null)
    assert.deepEqual(wrongPasswordRow.detail, {
      username: user.username,
      reason: 'invalid_credentials',
    })

    const unknownUserRows = await loginAudits(unknownUserIp)
    assert.equal(unknownUserRows.length, 1)
    assert.deepEqual(unknownUserRows[0]?.detail, {
      username: ghostUsername(),
      reason: 'invalid_credentials',
    })
  })

  test('被限速的登录不写审计，记录量不随请求量增长', async () => {
    const ip = nextIp()
    await exhaustIp(ip, env.login.ipMaxFailedAttempts)

    const beforeBlocking = await prisma.auditLog.count({ where: { ip } })
    assert.equal(beforeBlocking, env.login.ipMaxFailedAttempts)

    for (let i = 0; i < 5; i += 1) {
      const result = await login({ username: ghostUsername(), password: 'x', ip })
      assert.equal(result.ok, false)
      if (result.ok) return
      assert.equal(result.reason, 'ip_rate_limited')
    }

    // 否则攻击者只要持续发请求就能让审计表按请求量增长，限速反而成了放大器。
    assert.equal(await prisma.auditLog.count({ where: { ip } }), beforeBlocking)
  })

  test('登出写入审计，记录撤销范围与实际撤销数', async () => {
    const ip = nextIp()
    const user = await createUser()

    const session = await login({ username: user.username, password: TEST_PASSWORD, ip })
    assert.equal(session.ok, true)
    if (!session.ok) return

    const result = await logout(session.data.refreshToken, 'session', {
      ip,
      userAgent: 'logout-agent',
    })
    assert.equal(result.revoked, 1)

    const row = await prisma.auditLog.findFirst({
      where: { ip, action: AUDIT_ACTIONS.AUTH_SESSION_LOGOUT },
    })
    assert.ok(row !== null)
    if (row === null) return

    assert.equal(row.result, 'success')
    assert.equal(row.actorId, user.id)
    assert.equal(row.userAgent, 'logout-agent')
    assert.deepEqual(row.detail, { scope: 'session', revoked: 1 })
  })

  test('重复登出不写第二条审计', async () => {
    const ip = nextIp()
    const user = await createUser()

    const session = await login({ username: user.username, password: TEST_PASSWORD, ip })
    assert.equal(session.ok, true)
    if (!session.ok) return

    await logout(session.data.refreshToken, 'session', { ip })
    // 登出是幂等的，第二次什么也没撤销。没撤销任何东西就等于没有事件。
    const second = await logout(session.data.refreshToken, 'session', { ip })
    assert.equal(second.revoked, 0)

    assert.equal(
      await prisma.auditLog.count({ where: { ip, action: AUDIT_ACTIONS.AUTH_SESSION_LOGOUT } }),
      1,
    )
  })

  test('刷新令牌重放写入审计，target 指向被整链撤销的会话', async () => {
    const ip = nextIp()
    const user = await createUser()

    const session = await login({ username: user.username, password: TEST_PASSWORD, ip })
    assert.equal(session.ok, true)
    if (!session.ok) return

    const rotated = await rotateRefreshToken(session.data.refreshToken, { ip })
    assert.equal(rotated.ok, true)

    const tokenHash = hashRefreshToken(session.data.refreshToken)

    // 把撤销时间挪到宽限期之外，模拟「旧令牌在很久之后被重放」。不睡够十几秒。
    await prisma.refreshToken.updateMany({
      where: { tokenHash },
      data: { revokedAt: new Date(Date.now() - (env.jwt.rotationGraceSeconds + 60) * 1000) },
    })

    const replay = await rotateRefreshToken(session.data.refreshToken, {
      ip,
      userAgent: 'replay-agent',
    })
    assert.equal(replay.ok, false)
    if (replay.ok) return
    assert.equal(replay.reason, 'reuse_detected')

    const stored = await prisma.refreshToken.findFirst({
      where: { tokenHash },
      select: { familyId: true },
    })

    const row = await prisma.auditLog.findFirst({
      where: { ip, action: AUDIT_ACTIONS.AUTH_SESSION_REUSE },
    })
    assert.ok(row !== null)
    if (row === null) return

    assert.equal(row.result, 'failure')
    assert.equal(row.actorId, user.id)
    // 记的是会话链而不是单个令牌：令牌明文与哈希都不该进审计。
    assert.equal(row.targetType, 'session_family')
    assert.equal(row.targetId, stored?.familyId)
    assert.equal(row.userAgent, 'replay-agent')
    assert.deepEqual(row.detail, { reason: 'reuse_detected' })
  })

  test('首次初始化写入审计', { skip: cleanStart ? false : '库里已存在 owner' }, async () => {
    const ip = nextIp()

    const result = await initializeOwner(
      {
        username: `${TEST_DATA_PREFIX}audit_owner`,
        password: TEST_PASSWORD,
        displayName: '审计测试管理员',
      },
      { ip, userAgent: 'setup-agent' },
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    createdUserIds.push(result.data.id)

    const row = await prisma.auditLog.findFirst({
      where: { ip, action: AUDIT_ACTIONS.SYSTEM_SETUP_INITIALIZE },
    })
    assert.ok(row !== null)
    if (row === null) return

    assert.equal(row.result, 'success')
    assert.equal(row.actorId, result.data.id)
    assert.equal(row.actorName, '审计测试管理员')
    assert.equal(row.targetType, 'user')
    assert.equal(row.targetId, result.data.id)
    assert.equal(row.userAgent, 'setup-agent')
    assert.deepEqual(row.detail, { username: result.data.username })
  })

  test('审计写入失败不影响调用方，但会出声', async () => {
    const captured: unknown[] = []

    // ip 列是 VarChar(64)，超长会让 INSERT 在数据库层真实失败，不需要替身。
    // recordAudit 必须把异常吞掉：登录、登出、初始化都是 await 它且不加 try/catch，
    // 它一旦抛出就会把主流程一起带下去。这条断言覆盖的正是那个保证。
    await recordAudit(
      { action: AUDIT_ACTIONS.AUTH_SESSION_LOGIN, ip: 'x'.repeat(100) },
      {
        error: (context: unknown) => {
          captured.push(context)
        },
      },
    )

    assert.equal(captured.length, 1)
    // 出声的内容要能定位到是哪一次写入失败，否则「出过声」等于没出。
    const context = captured[0] as { action?: string }
    assert.equal(context.action, AUDIT_ACTIONS.AUTH_SESSION_LOGIN)
  })
})
