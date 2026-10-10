/**
 * 刷新令牌轮换与撤销的集成测试。
 *
 * 这个文件里的测试**需要真实数据库**。轮换的并发安全、重放检测、按设备撤销
 * 这些行为全部落在数据库事务与行锁上，用内存替身测出来的只是替身自己的行为，
 * 不能说明真实实现是对的。因此这里连真实实例，库不可达时整体跳过，而不是
 * 降级成一个必然通过的假测试。
 *
 * 测试数据统一带 `zz_test_` 前缀，结束时按 id 删除。删除用户会级联删掉它的
 * 刷新令牌，所以不必单独清理令牌表。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

// test-env.ts 已经把 DATABASE_URL 指向一个不可达地址，这里在 env.ts 被求值之前
// 换回真实值。下面一律用动态 import：静态 import 会被提升到本段之前执行，
// 那样 env.ts 读到的仍是不达的地址，测试会全部误判为「库不可达」。
const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { env } = await import('../src/config/env.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const { hashRefreshToken, verifyAccessToken } = await import('../src/auth/tokens.js')
const { logout, rotateRefreshToken } = await import('../src/auth/session.js')

const TEST_PASSWORD = 'integration-test-password'
/**
 * 本文件所有登录共用一个来源地址，取自 RFC 5737 的 TEST-NET-2 段。
 *
 * 共用一个地址是安全的，这里只发生成功登录，而 IP 维度的限速只统计失败。
 * 用独立的地址段是为了清理时能精确圈定本文件产生的记录，不会误删另一个
 * 测试文件正在使用的数据。
 */
const SESSION_TEST_IP = '198.51.100.10'

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
  // 必须显式出声。describe 的 skip 只会让整个 suite 从统计里消失：总数从 37
  // 降到 23，而 skipped 仍然是 0、fail 仍然是 0，输出全绿。静默跳过比测试
  // 失败危险得多，它会让「没跑」看起来像「跑过了」。
  console.warn('[session.test] 数据库不可达，轮换与撤销的集成测试未执行')
}

describe('刷新令牌轮换与撤销', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  let memberRoleId = ''
  let passwordHash = ''

  before(async () => {
    const role = await prisma.role.findUnique({
      where: { code: 'member' },
      select: { id: true },
    })
    if (role === null) {
      throw new Error('库里没有 member 角色，先执行 pnpm db:seed')
    }
    memberRoleId = role.id
    // 只算一次。Argon2 单次要几十毫秒，每个账号各算一遍会让整个文件明显变慢。
    passwordHash = await hashPassword(TEST_PASSWORD)
  })

  after(async () => {
    if (createdUserIds.length > 0) {
      // 审计行必须**先于**账号删除。actor_id 的外键是 SetNull，账号一删归属就断了，
      // 之后按 actorId 再也查不到这些行。本文件直接调 service，登出与轮换都没有
      // 来源地址，落库的 ip 是 NULL，按 ip 清理同样圈不住它们。
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } })
      // 删除用户会级联删掉它的刷新令牌，不必单独清令牌表。
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    // 登录会顺带写入 login_attempts，按来源地址精确清掉本文件的那些。
    await prisma.loginAttempt.deleteMany({ where: { ip: SESSION_TEST_IP } })
    await prisma.$disconnect()
  })

  /** 建一个测试账号。用户名带前缀，便于识别与清理。 */
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

  /** 走真实登录流程拿一组令牌。 */
  async function signIn(
    user: { username: string },
    device?: { id: string; name: string },
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const result = await login({
      username: user.username,
      password: TEST_PASSWORD,
      deviceId: device?.id,
      deviceName: device?.name,
      ip: SESSION_TEST_IP,
    })
    if (!result.ok) {
      throw new Error(`测试账号登录失败：${result.reason}`)
    }
    return result.data
  }

  test('轮换返回新的一组令牌，旧的随即失效', async () => {
    const user = await createUser()
    const session = await signIn(user)

    const rotated = await rotateRefreshToken(session.refreshToken)
    assert.equal(rotated.ok, true)
    if (!rotated.ok) return

    // 只断言刷新令牌变了。访问令牌**可能**与上一份逐字节相同，这不算缺陷：
    // JWT 的 iat 与 exp 都是秒级精度，同一账号在同一秒内签发两次，载荷与
    // 签名必然一致。刷新令牌是随机串，它必须每次都不同。
    assert.notEqual(rotated.data.refreshToken, session.refreshToken)
    assert.equal(rotated.data.expiresIn, env.jwt.accessTtlSeconds)

    // 新访问令牌必须可用，且载荷指向同一个账号。
    assert.deepEqual(await verifyAccessToken(rotated.data.accessToken), {
      sub: user.id,
      role: 'member',
    })

    const replay = await rotateRefreshToken(session.refreshToken)
    assert.equal(replay.ok, false)
  })

  test('新令牌可以继续轮换，链上每一环都只能使用一次', async () => {
    const user = await createUser()
    const session = await signIn(user)

    const first = await rotateRefreshToken(session.refreshToken)
    assert.ok(first.ok)
    if (!first.ok) return

    const second = await rotateRefreshToken(first.data.refreshToken)
    assert.ok(second.ok)
    if (!second.ok) return

    const third = await rotateRefreshToken(second.data.refreshToken)
    assert.ok(third.ok)
  })

  test('轮换保持同一 familyId，并继承设备信息', async () => {
    const user = await createUser()
    const session = await signIn(user, { id: 'device-a', name: '工作机' })

    const rotated = await rotateRefreshToken(session.refreshToken)
    assert.ok(rotated.ok)
    if (!rotated.ok) return

    const oldRow = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(session.refreshToken) },
      select: { familyId: true, revokedAt: true, revokedReason: true },
    })
    const newRow = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(rotated.data.refreshToken) },
      select: { familyId: true, deviceId: true, deviceName: true, revokedAt: true },
    })

    assert.ok(oldRow !== null)
    assert.ok(newRow !== null)
    if (oldRow === null || newRow === null) return

    assert.equal(newRow.familyId, oldRow.familyId)
    assert.equal(newRow.deviceId, 'device-a')
    assert.equal(newRow.deviceName, '工作机')
    assert.equal(newRow.revokedAt, null)
    assert.ok(oldRow.revokedAt !== null)
    assert.equal(oldRow.revokedReason, 'rotated')
  })

  test('库中只存哈希，明文令牌查不到任何记录', async () => {
    const user = await createUser()
    const session = await signIn(user)

    const byPlaintext = await prisma.refreshToken.findUnique({
      where: { tokenHash: session.refreshToken },
    })
    assert.equal(byPlaintext, null)

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(session.refreshToken) },
      select: { tokenHash: true },
    })
    assert.ok(stored !== null)
    if (stored === null) return
    assert.match(stored.tokenHash, /^[0-9a-f]{64}$/)
  })

  test('不存在的刷新令牌被拒绝', async () => {
    const result = await rotateRefreshToken('a'.repeat(43))
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'token_not_found')
  })

  test('过期的刷新令牌被拒绝', async () => {
    const user = await createUser()
    const session = await signIn(user)

    await prisma.refreshToken.update({
      where: { tokenHash: hashRefreshToken(session.refreshToken) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })

    const result = await rotateRefreshToken(session.refreshToken)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'token_expired')
  })

  test('宽限期内重复提交视为并发竞态，整条链保持有效', async () => {
    const user = await createUser()
    const session = await signIn(user)

    const first = await rotateRefreshToken(session.refreshToken)
    assert.ok(first.ok)
    if (!first.ok) return

    // 立刻拿旧令牌再刷一次。落在宽限期内，按并发处理。
    const again = await rotateRefreshToken(session.refreshToken)
    assert.equal(again.ok, false)
    if (again.ok) return
    assert.equal(again.reason, 'token_revoked')

    // 关键断言：链没有被撤销，当前有效的令牌仍能继续轮换。
    const next = await rotateRefreshToken(first.data.refreshToken)
    assert.equal(next.ok, true)
  })

  test('超出宽限期重放旧令牌，整条链被撤销', async () => {
    const user = await createUser()
    const session = await signIn(user)

    const first = await rotateRefreshToken(session.refreshToken)
    assert.ok(first.ok)
    if (!first.ok) return

    const second = await rotateRefreshToken(first.data.refreshToken)
    assert.ok(second.ok)
    if (!second.ok) return

    // 把第一个令牌的撤销时间改到宽限期之外，模拟真正的重放：攻击者隔了很久
    // 才拿出偷到的旧令牌。
    await prisma.refreshToken.update({
      where: { tokenHash: hashRefreshToken(session.refreshToken) },
      data: { revokedAt: new Date(Date.now() - 60_000) },
    })

    const replay = await rotateRefreshToken(session.refreshToken)
    assert.equal(replay.ok, false)
    if (replay.ok) return
    assert.equal(replay.reason, 'reuse_detected')

    // 关键断言：当前正在使用的令牌也被撤销了。这正是「整链撤销」的含义，
    // 攻击者可能已经拿到了它，不撤就等于没检测到。
    const afterReplay = await rotateRefreshToken(second.data.refreshToken)
    assert.equal(afterReplay.ok, false)
    if (afterReplay.ok) return
    assert.equal(afterReplay.reason, 'token_revoked')
  })

  test('同一令牌并发轮换，恰好一次成功', async () => {
    const user = await createUser()
    const session = await signIn(user)

    const results = await Promise.all([
      rotateRefreshToken(session.refreshToken),
      rotateRefreshToken(session.refreshToken),
    ])

    const succeeded = results.filter((result) => result.ok)
    assert.equal(succeeded.length, 1, '并发轮换必须只有一个请求拿到新令牌')
  })

  test('登出当前会话后，该令牌立即无法刷新', async () => {
    const user = await createUser()
    const session = await signIn(user)

    const result = await logout(session.refreshToken, 'session')
    assert.equal(result.revoked, 1)

    const afterLogout = await rotateRefreshToken(session.refreshToken)
    assert.equal(afterLogout.ok, false)
    if (afterLogout.ok) return
    assert.equal(afterLogout.reason, 'token_revoked')
  })

  test('按设备撤销，该设备的多个会话同时失效，其它设备不受影响', async () => {
    const user = await createUser()
    // 同一台设备登录两次，产生两条互不相干的链。
    const firstOnDeviceA = await signIn(user, { id: 'device-a', name: '工作机' })
    const secondOnDeviceA = await signIn(user, { id: 'device-a', name: '工作机' })
    const onDeviceB = await signIn(user, { id: 'device-b', name: '家用机' })

    const result = await logout(firstOnDeviceA.refreshToken, 'device')
    assert.equal(result.revoked, 2)

    assert.equal((await rotateRefreshToken(firstOnDeviceA.refreshToken)).ok, false)
    assert.equal((await rotateRefreshToken(secondOnDeviceA.refreshToken)).ok, false)
    // 另一台设备的会话必须完好。撤错了会把用户从所有地方踢下线。
    assert.equal((await rotateRefreshToken(onDeviceB.refreshToken)).ok, true)
  })

  test('全局登出撤销该账号在所有设备上的会话', async () => {
    const user = await createUser()
    const onDeviceA = await signIn(user, { id: 'device-a', name: '工作机' })
    const onDeviceB = await signIn(user, { id: 'device-b', name: '家用机' })

    const result = await logout(onDeviceA.refreshToken, 'all')
    assert.equal(result.revoked, 2)

    assert.equal((await rotateRefreshToken(onDeviceA.refreshToken)).ok, false)
    assert.equal((await rotateRefreshToken(onDeviceB.refreshToken)).ok, false)
  })

  test('登出是幂等的，重复调用与未知令牌都返回成功', async () => {
    const user = await createUser()
    const session = await signIn(user)

    const first = await logout(session.refreshToken, 'session')
    assert.equal(first.revoked, 1)

    // 已撤销的令牌再登出一次：没有可撤的行，但不报错。
    const second = await logout(session.refreshToken, 'session')
    assert.equal(second.revoked, 0)

    // 从未存在过的令牌：同样不报错。
    const unknown = await logout('a'.repeat(43), 'session')
    assert.equal(unknown.revoked, 0)
  })

  test('账号被停用后刷新失败，且整条链被撤销', async () => {
    const user = await createUser()
    const session = await signIn(user)

    await prisma.user.update({ where: { id: user.id }, data: { status: 'disabled' } })

    const result = await rotateRefreshToken(session.refreshToken)
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'user_unavailable')

    const stored = await prisma.refreshToken.findUnique({
      where: { tokenHash: hashRefreshToken(session.refreshToken) },
      select: { revokedAt: true, revokedReason: true },
    })
    assert.ok(stored !== null)
    if (stored === null) return
    assert.ok(stored.revokedAt !== null)
    assert.equal(stored.revokedReason, 'user_unavailable')
  })
})
