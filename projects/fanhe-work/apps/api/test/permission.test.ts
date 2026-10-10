/**
 * 权限守卫的集成测试。
 *
 * 需要真实数据库。授权判定依赖角色与权限的关联表，权限点的展开结果就写在库里，
 * 用内存替身测不出「角色配置对不对」，因此这里连真实实例。
 *
 * 测试用 `inject` 驱动完整的路由链路，包括 preHandler、schema 与序列化。守卫的
 * 价值全在「绕过前端直接调接口」这一条路径上，只测函数返回值等于把最有意义的那
 * 一段漏掉。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { PERMISSIONS, ROLE_CODES, type RoleCode } from '@fanhe/shared'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

// test-env.ts 已经把 DATABASE_URL 指向一个不可达地址，这里在 env.ts 被求值之前
// 换回真实值。下面一律用动态 import，静态 import 会被提升到本段之前执行。
// `@fanhe/shared` 是静态 import 的，它不读环境变量，因此不受这个顺序影响。
const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const { signAccessToken } = await import('../src/auth/tokens.js')
const { requirePermission } = await import('../src/auth/guard.js')
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
/** RFC 5737 的 TEST-NET-2 段。本文件独占一个地址，清理时能精确圈定。 */
const TEST_IP = '198.51.100.20'

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
  console.warn('[permission.test] 数据库不可达，权限守卫的集成测试未执行')
}

describe('权限守卫', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  const roleIds = new Map<RoleCode, string>()
  let passwordHash = ''
  let app: ReturnType<typeof buildApp>

  before(async () => {
    const roleCodes: RoleCode[] = [
      ROLE_CODES.OWNER,
      ROLE_CODES.ADMIN,
      ROLE_CODES.MEMBER,
      ROLE_CODES.VIEWER,
    ]
    for (const code of roleCodes) {
      const role = await prisma.role.findUnique({ where: { code }, select: { id: true } })
      if (role === null) {
        throw new Error(`库里没有 ${code} 角色，先执行 pnpm db:seed`)
      }
      roleIds.set(code, role.id)
    }
    passwordHash = await hashPassword(TEST_PASSWORD)

    app = buildApp({ logger: false })

    // 挂三个受保护端点用于验证授权。真实业务路由要到阶段三才有，这里先构造最小的
    // 一组，让守卫的行为能被独立验证，也免得把权限测试绑在某个业务模块上。
    app.get(
      '/api/_test/note-read',
      { preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_READ) },
      async () => ({ ok: true }),
    )
    app.get(
      '/api/_test/note-write',
      { preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_WRITE) },
      async () => ({ ok: true }),
    )
    app.get(
      '/api/_test/role-manage',
      { preHandler: requirePermission(PERMISSIONS.SYSTEM_ROLE_MANAGE) },
      async () => ({ ok: true }),
    )
  })

  after(async () => {
    await app.close()
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    // 本文件用 login 取令牌，会顺带写入审计。
    await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
  })

  /** 建一个指定角色的账号并登录，返回访问令牌。 */
  async function signIn(roleCode: RoleCode): Promise<{ userId: string; token: string }> {
    const roleId = roleIds.get(roleCode)
    if (roleId === undefined) {
      throw new Error(`未知角色：${roleCode}`)
    }

    const user = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        passwordHash,
        displayName: '集成测试账号',
        roleId,
      },
      select: { id: true, username: true },
    })
    createdUserIds.push(user.id)

    const result = await login({ username: user.username, password: TEST_PASSWORD, ip: TEST_IP })
    if (!result.ok) {
      throw new Error(`测试账号登录失败：${result.reason}`)
    }
    return { userId: user.id, token: result.data.accessToken }
  }

  function authHeader(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` }
  }

  test('缺少 Authorization 头时返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/_test/note-read' })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'unauthorized')
  })

  test('未认证响应带 WWW-Authenticate 头', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/_test/note-read' })
    assert.equal(response.headers['www-authenticate'], 'Bearer')
  })

  test('Authorization 头格式不正确时返回 401', async () => {
    for (const header of ['', 'Bearer', 'Bearer ', 'Basic abc', 'token abc']) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/_test/note-read',
        headers: { authorization: header },
      })
      assert.equal(response.statusCode, 401, `头部：${JSON.stringify(header)}`)
    }
  })

  test('令牌无效时返回 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/_test/note-read',
      headers: authHeader('not-a-real-token'),
    })
    assert.equal(response.statusCode, 401)
  })

  test('owner 可以访问需要 system.role.manage 的接口', async () => {
    const { token } = await signIn(ROLE_CODES.OWNER)
    const response = await app.inject({
      method: 'GET',
      url: '/api/_test/role-manage',
      headers: authHeader(token),
    })
    assert.equal(response.statusCode, 200)
  })

  test('admin 没有 system.role.manage，返回 403', async () => {
    const { token } = await signIn(ROLE_CODES.ADMIN)
    const response = await app.inject({
      method: 'GET',
      url: '/api/_test/role-manage',
      headers: authHeader(token),
    })
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error, 'forbidden')
  })

  test('viewer 可以读 personal 段，但不能写', async () => {
    const { token } = await signIn(ROLE_CODES.VIEWER)
    const headers = authHeader(token)

    const read = await app.inject({ method: 'GET', url: '/api/_test/note-read', headers })
    const write = await app.inject({ method: 'GET', url: '/api/_test/note-write', headers })

    assert.equal(read.statusCode, 200)
    assert.equal(write.statusCode, 403)
  })

  test('member 对 personal 段读写皆可，但没有 system 段权限', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/_test/note-read', headers })).statusCode,
      200,
    )
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/_test/note-write', headers })).statusCode,
      200,
    )
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/_test/role-manage', headers })).statusCode,
      403,
    )
  })

  test('授权以库里的角色为准，令牌中的 role 声明不参与判定', async () => {
    const { userId } = await signIn(ROLE_CODES.VIEWER)

    // 用真实密钥签一个 sub 指向 viewer、role 却写成 owner 的令牌。这是在服务端
    // 可控范围内「篡改令牌里的角色」这一攻击的最强形式，密钥没有泄露就签不出来，
    // 因此这条断言同时验证了「即使签得出来也不起作用」。
    const forged = await signAccessToken({ sub: userId, role: ROLE_CODES.OWNER })

    const response = await app.inject({
      method: 'GET',
      url: '/api/_test/role-manage',
      headers: authHeader(forged),
    })

    assert.equal(response.statusCode, 403)
  })

  test('账号被停用后，已签发的访问令牌立即失效', async () => {
    const { userId, token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/_test/note-read', headers })).statusCode,
      200,
    )

    await prisma.user.update({ where: { id: userId }, data: { status: 'disabled' } })

    // 访问令牌本身还有效，签名与过期时间都没问题。失效来自守卫对账号状态的检查，
    // 这是「撤销立刻生效」在无状态令牌下唯一可行的实现方式。
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/_test/note-read', headers })).statusCode,
      401,
    )
  })

  test('账号被软删除后，已签发的访问令牌立即失效', async () => {
    const { userId, token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } })

    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/_test/note-read', headers })).statusCode,
      401,
    )
  })

  test('/api/auth/me 未认证时返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' })
    assert.equal(response.statusCode, 401)
  })

  test('/api/auth/me 返回当前用户与展开后的权限点', async () => {
    const { userId, token } = await signIn(ROLE_CODES.VIEWER)

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(token),
    })
    assert.equal(response.statusCode, 200)

    const body = response.json() as {
      user: { id: string; username: string; displayName: string; role: string }
      permissions: string[]
    }

    assert.equal(body.user.id, userId)
    assert.equal(body.user.role, ROLE_CODES.VIEWER)

    // viewer 的授权模式是 personal.*.read，展开后恰好是三个读权限。这条断言同时
    // 验证了通配符按「非末尾只匹配一段」解释，与 T1-02 修正后的规则一致。
    assert.deepEqual(
      [...body.permissions].sort(),
      [
        PERMISSIONS.PERSONAL_EVENT_READ,
        PERMISSIONS.PERSONAL_LAUNCH_READ,
        PERMISSIONS.PERSONAL_NOTE_READ,
      ].sort(),
    )
  })

  test('/api/auth/me 返回的权限点不含任何写权限（viewer）', async () => {
    const { token } = await signIn(ROLE_CODES.VIEWER)

    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: authHeader(token),
    })

    const body = response.json() as { permissions: string[] }
    assert.equal(
      body.permissions.some((code) => code.endsWith('.write') || code.endsWith('.manage')),
      false,
    )
  })
})
