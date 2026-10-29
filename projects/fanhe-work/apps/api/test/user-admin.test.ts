/**
 * 账号与权限管理的集成测试。
 *
 * 需要真实数据库。授权覆盖存在 `user_permissions` 表、层级判定读 `roles.rank`，
 * 两者都不是内存替身能覆盖的 —— 越权防护的价值恰恰在于「服务端真的拒绝了」，
 * 而这件事只有打通完整链路才算验证过。
 *
 * 用 `inject` 驱动完整路由，包括 preHandler、schema 与序列化。绕过前端直接调接口
 * 正是本功能的正确测法。
 *
 * **重点放在越权与叠加规则上**，那是这块功能最容易出错的地方：
 *   - 不能管理自己（防提权）
 *   - 不能管理同级或更高层级（admin 拿不到 owner）
 *   - owner 不可被修改、删除、改权限
 *   - denied 优先于 granted，且撤销一个角色自带权限能真的撤销
 *   - 权限调整在下一次请求就生效，不等令牌过期
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import {
  AUDIT_ACTIONS,
  PASSWORD_MIN_LENGTH,
  PERMISSIONS,
  ROLE_CODES,
  type PermissionCode,
  type RoleCode,
} from '@fanhe/shared'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
/** RFC 5737 的 TEST-NET-3 段。本文件独占一个地址，清理时能精确圈定。 */
const TEST_IP = '198.51.100.30'

async function databaseReachable(): Promise<boolean> {
  if (databaseUrl === null) return false
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

const reachable = await databaseReachable()

if (!reachable) {
  console.warn('[user-admin.test] 数据库不可达，账号管理的集成测试未执行')
}

describe('账号与权限管理', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  const roleIds = new Map<RoleCode, string>()
  let passwordHash = ''
  let app: ReturnType<typeof buildApp>

  before(async () => {
    for (const code of [
      ROLE_CODES.OWNER,
      ROLE_CODES.ADMIN,
      ROLE_CODES.MEMBER,
      ROLE_CODES.VIEWER,
    ] satisfies RoleCode[]) {
      const role = await prisma.role.findUnique({ where: { code }, select: { id: true } })
      if (role === null) {
        throw new Error(`库里没有 ${code} 角色，先执行 pnpm db:seed`)
      }
      roleIds.set(code, role.id)
    }
    passwordHash = await hashPassword(TEST_PASSWORD)
    app = buildApp({ logger: false })
  })

  after(async () => {
    await app.close()
    if (createdUserIds.length > 0) {
      // 审计行必须**先于**账号清理。`audit_logs.actorId` 的外键是 SetNull，账号
      // 一删就匹配不上，那批行会永远留在库里。
      //
      // 只按 `ip: TEST_IP` 清理不够：账号管理取 `request.ip`，而 inject 的默认
      // 来源是 127.0.0.1。本文件此前没有审计断言，这批行因此无人过问 —— 实测库里
      // 积了近三百行（五类动作各几十条）。改用 actorId 圈定，与来源地址无关。
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
  })

  function roleId(code: RoleCode): string {
    const id = roleIds.get(code)
    if (id === undefined) throw new Error(`未知角色：${code}`)
    return id
  }

  /** 建一个指定角色的账号并登录，返回令牌与 id。 */
  async function signIn(
    roleCode: RoleCode,
  ): Promise<{ userId: string; token: string; username: string }> {
    const username = `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        displayName: '账号管理测试',
        roleId: roleId(roleCode),
      },
      select: { id: true },
    })
    createdUserIds.push(user.id)

    const result = await login({ username, password: TEST_PASSWORD, ip: TEST_IP })
    if (!result.ok) throw new Error(`测试账号登录失败：${result.reason}`)
    return { userId: user.id, token: result.data.accessToken, username }
  }

  /** 只建号不登录，用于「操作一个不存在的会话」这类场景。 */
  async function createUser(roleCode: RoleCode): Promise<{ id: string; username: string }> {
    const username = `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash,
        displayName: '账号管理测试',
        roleId: roleId(roleCode),
      },
      select: { id: true },
    })
    createdUserIds.push(user.id)
    return { id: user.id, username }
  }

  function auth(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` }
  }

  // -----------------------------------------------------------------------
  // 越权防护
  // -----------------------------------------------------------------------

  test('admin 拿不到 owner：列表里看不到对方，也改不动', async () => {
    const admin = await signIn(ROLE_CODES.ADMIN)
    const owner = await createUser(ROLE_CODES.OWNER)

    const list = await app.inject({
      method: 'GET',
      url: '/api/system/users',
      headers: auth(admin.token),
    })
    assert.equal(list.statusCode, 200)
    const ids = (list.json() as { users: { id: string }[] }).users.map((u) => u.id)
    assert.ok(!ids.includes(owner.id), 'admin 的列表里不应出现 owner')

    // 不可见的账号按「不存在」返回，不给 403 —— 403 等于承认它存在。
    const detail = await app.inject({
      method: 'GET',
      url: `/api/system/users/${owner.id}`,
      headers: auth(admin.token),
    })
    assert.equal(detail.statusCode, 404)

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/system/users/${owner.id}`,
      headers: auth(admin.token),
      payload: { displayName: '被篡改' },
    })
    assert.equal(patch.statusCode, 404)

    // 删除不在这里断言 404：admin 本来就没有 system.user.delete，删掉它会先撞上
    // 权限点缺失（403），那验证的是另一件事。删除路径的层级判定由下面那条
    // 「owner 恒有全部权限，且 owner 不可被修改」覆盖。
    const ownerAfter = await prisma.user.findUnique({
      where: { id: owner.id },
      select: { displayName: true, deletedAt: true },
    })
    assert.notEqual(ownerAfter?.displayName, '被篡改')
    assert.equal(ownerAfter?.deletedAt, null)
  })

  test('不能对自己动手 —— 这是提权路径的入口', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)

    for (const [method, url, payload] of [
      ['PATCH', `/api/system/users/${owner.userId}`, { displayName: '改名' }],
      ['DELETE', `/api/system/users/${owner.userId}`, undefined],
      [
        'POST',
        `/api/system/users/${owner.userId}/reset-password`,
        { newPassword: 'another-test-password' },
      ],
    ] as const) {
      const response = await app.inject({
        method,
        url,
        headers: auth(owner.token),
        ...(payload === undefined ? {} : { payload }),
      })
      assert.equal(response.statusCode, 400, `${method} ${url} 应当拒绝自我操作`)
      assert.equal(response.json().error, 'cannot_manage_self')
    }
  })

  test('同级账号互相不可管理', async () => {
    const first = await signIn(ROLE_CODES.ADMIN)
    const second = await createUser(ROLE_CODES.ADMIN)

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/system/users/${second.id}`,
      headers: auth(first.token),
      payload: { displayName: '同级篡改' },
    })
    // admin 能创建 member 也能管 member，唯独管不了与自己同 rank 的 admin。
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error, 'cannot_manage_peer_or_above')
  })

  test('不能分配同级或更高级的角色', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const admin = await createUser(ROLE_CODES.ADMIN)

    const response = await app.inject({
      method: 'POST',
      url: '/api/system/users',
      headers: auth(owner.token),
      payload: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 16)}`,
        password: TEST_PASSWORD,
        displayName: '试图升职的账号',
        roleCode: ROLE_CODES.OWNER,
      },
    })
    // 分配 owner 被拒。同时验证「不能给自己造一个 owner」。
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'role_not_assignable')

    const upgrade = await app.inject({
      method: 'PATCH',
      url: `/api/system/users/${admin.id}`,
      headers: auth(owner.token),
      payload: { roleCode: ROLE_CODES.OWNER },
    })
    assert.equal(upgrade.statusCode, 400)
    assert.equal(upgrade.json().error, 'role_not_assignable')
  })

  // -----------------------------------------------------------------------
  // 创建、编辑、停用
  // -----------------------------------------------------------------------

  test('owner 能创建子账号，字段落库正确', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    // 用户名必须每次唯一：用固定名的话，测试失败后残留的行会让下一次跑撞上
    // 409，而 409 看不出「上一次没清干净」，排查方向会先落到接口上。
    const username = `${TEST_DATA_PREFIX}created${randomUUID().replaceAll('-', '').slice(0, 12)}`

    const response = await app.inject({
      method: 'POST',
      url: '/api/system/users',
      headers: auth(owner.token),
      payload: {
        username,
        password: TEST_PASSWORD,
        displayName: '张三',
        department: '设计部',
        roleCode: ROLE_CODES.MEMBER,
      },
    })
    assert.equal(response.statusCode, 201)

    const created = (response.json() as { user: { id: string } }).user
    createdUserIds.push(created.id)

    const row = await prisma.user.findUnique({
      where: { id: created.id },
      select: { username: true, displayName: true, department: true, status: true },
    })
    assert.equal(row?.displayName, '张三')
    assert.equal(row?.department, '设计部')
    assert.equal(row?.status, 'active')

    // 新账号能立刻登录 —— 哈希算法与初始化时一致。
    const signInResult = await login({ username, password: TEST_PASSWORD, ip: TEST_IP })
    assert.ok(signInResult.ok, '新建的账号应当能立即登录')
  })

  test('密码短于下限被拒', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const response = await app.inject({
      method: 'POST',
      url: '/api/system/users',
      headers: auth(owner.token),
      payload: {
        username: `${TEST_DATA_PREFIX}shortpw`,
        password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
        displayName: '短密码',
        roleCode: ROLE_CODES.MEMBER,
      },
    })
    // 长度校验在 schema 层就拦下，请求根本没进业务层。
    assert.equal(response.statusCode, 400)
  })

  // 上一条只证明「短了被拒」。下限本身也要能过，否则把常量调小这件事在测试里
  // 是不可见的：两道关卡任意一处还留着旧数字，都表现为「还是不让建」。
  test('密码刚好等于下限时放行', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const username = `${TEST_DATA_PREFIX}minpw${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const password = 'a'.repeat(PASSWORD_MIN_LENGTH)

    const response = await app.inject({
      method: 'POST',
      url: '/api/system/users',
      headers: auth(owner.token),
      payload: {
        username,
        password,
        displayName: '下限密码',
        roleCode: ROLE_CODES.MEMBER,
      },
    })
    assert.equal(response.statusCode, 201)

    const created = (response.json() as { user: { id: string } }).user
    createdUserIds.push(created.id)

    const signInResult = await login({ username, password, ip: TEST_IP })
    assert.ok(signInResult.ok, '下限长度的密码应当能建号并登录')
  })

  test('停用会立刻吊销该账号的会话 —— 不是「下次不能登录」而已', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await signIn(ROLE_CODES.MEMBER)

    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/system/users/${target.userId}`,
      headers: auth(owner.token),
      payload: { status: 'disabled' },
    })
    assert.equal(disable.statusCode, 200)

    // 刷新令牌已被吊销，换不出新令牌。
    const refreshTokens = await prisma.refreshToken.count({
      where: { userId: target.userId, revokedAt: null },
    })
    assert.equal(refreshTokens, 0)

    // 老访问令牌也立刻失效（守卫查 status）。
    const withStaleToken = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(target.token),
    })
    assert.equal(withStaleToken.statusCode, 401)

    const signInAgain = await login({
      username: target.username,
      password: TEST_PASSWORD,
      ip: TEST_IP,
    })
    assert.ok(!signInAgain.ok)
  })

  test('重置密码后新密码可用，旧密码失效，锁定被清零', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await createUser(ROLE_CODES.MEMBER)

    // 制造一次密码错误，让账号进入失败计数状态。
    await prisma.user.update({
      where: { id: target.id },
      data: { failedLoginAttempts: 4, lockedUntil: new Date(Date.now() + 600_000) },
    })

    const newPassword = 'brand-new-password-1234'
    const response = await app.inject({
      method: 'POST',
      url: `/api/system/users/${target.id}/reset-password`,
      headers: auth(owner.token),
      payload: { newPassword },
    })
    assert.equal(response.statusCode, 200)

    const row = await prisma.user.findUnique({
      where: { id: target.id },
      select: { failedLoginAttempts: true, lockedUntil: true, passwordChangedAt: true },
    })
    assert.equal(row?.failedLoginAttempts, 0, '重置密码应当清零失败计数')
    assert.equal(row?.lockedUntil, null, '重置密码应当解除锁定')
    assert.ok(row?.passwordChangedAt !== null)

    const withNew = await login({
      username: target.username,
      password: newPassword,
      ip: TEST_IP,
    })
    assert.ok(withNew.ok, '新密码应当可以登录')
  })

  test('删除是软删除，账号即刻无法登录但历史记录保留', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await createUser(ROLE_CODES.MEMBER)

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/system/users/${target.id}`,
      headers: auth(owner.token),
    })
    assert.equal(response.statusCode, 200)

    const row = await prisma.user.findUnique({
      where: { id: target.id },
      select: { deletedAt: true, status: true },
    })
    assert.notEqual(row?.deletedAt, null, '应当是软删除，行仍在')
    assert.equal(row?.status, 'disabled')

    const list = await app.inject({
      method: 'GET',
      url: '/api/system/users',
      headers: auth(owner.token),
    })
    const ids = (list.json() as { users: { id: string }[] }).users.map((u) => u.id)
    assert.ok(!ids.includes(target.id), '已删除的账号不应出现在列表里')
  })

  // -----------------------------------------------------------------------
  // 权限叠加
  // -----------------------------------------------------------------------

  test('账号级拒绝优先于角色自带权限', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await createUser(ROLE_CODES.MEMBER)

    const before = await app.inject({
      method: 'GET',
      url: `/api/system/users/${target.id}`,
      headers: auth(owner.token),
    })
    const rolePermissions = (before.json() as { rolePermissions: PermissionCode[] }).rolePermissions
    assert.ok(
      rolePermissions.includes(PERMISSIONS.PERSONAL_NOTE_WRITE),
      'member 角色应当自带纪要写权限（前置条件）',
    )

    // 显式拒绝一个角色自带的权限。
    const deny = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${target.id}/permissions`,
      headers: auth(owner.token),
      payload: { granted: [], denied: [PERMISSIONS.PERSONAL_NOTE_WRITE] },
    })
    assert.equal(deny.statusCode, 200)

    const targetSignIn = await login({
      username: target.username,
      password: TEST_PASSWORD,
      ip: TEST_IP,
    })
    assert.ok(targetSignIn.ok, '被拒绝写权限后账号本身仍能登录')

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(targetSignIn.data.accessToken),
    })
    assert.equal(me.statusCode, 200)
    const permissions = (me.json() as { permissions: PermissionCode[] }).permissions
    assert.ok(
      !permissions.includes(PERMISSIONS.PERSONAL_NOTE_WRITE),
      '被拒绝的权限不应出现在最终权限里',
    )
    assert.ok(permissions.includes(PERMISSIONS.PERSONAL_NOTE_READ), '未被拒绝的权限应当保留')
  })

  test('账号级授予能加回角色没有的权限', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await createUser(ROLE_CODES.VIEWER)

    const grant = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${target.id}/permissions`,
      headers: auth(owner.token),
      payload: {
        granted: [PERMISSIONS.PERSONAL_NOTE_WRITE],
        denied: [],
      },
    })
    assert.equal(grant.statusCode, 200)

    const signInResult = await login({
      username: target.username,
      password: TEST_PASSWORD,
      ip: TEST_IP,
    })
    assert.ok(signInResult.ok)

    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(signInResult.data.accessToken),
    })
    const permissions = (me.json() as { permissions: PermissionCode[] }).permissions
    assert.ok(
      permissions.includes(PERMISSIONS.PERSONAL_NOTE_WRITE),
      'viewer 被单独授予写权限后应当能写纪要',
    )
  })

  test('同一权限点同时出现在授予与拒绝里会被拒', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await createUser(ROLE_CODES.MEMBER)

    const response = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${target.id}/permissions`,
      headers: auth(owner.token),
      payload: {
        granted: [PERMISSIONS.SYSTEM_USER_READ],
        denied: [PERMISSIONS.SYSTEM_USER_READ],
      },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'invalid_permissions')
  })

  test('权限调整在下一次请求就生效，不等令牌过期', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await createUser(ROLE_CODES.VIEWER)
    const signInResult = await login({
      username: target.username,
      password: TEST_PASSWORD,
      ip: TEST_IP,
    })
    assert.ok(signInResult.ok)
    const token = signInResult.data.accessToken

    // 先确认目标账号确实看不到系统设置（拿到 403）。
    const denied = await app.inject({
      method: 'GET',
      url: '/api/system/users',
      headers: auth(token),
    })
    assert.equal(denied.statusCode, 403)

    // 授予之后，同一个令牌立刻就能访问。
    await app.inject({
      method: 'PUT',
      url: `/api/system/users/${target.id}/permissions`,
      headers: auth(owner.token),
      payload: { granted: [PERMISSIONS.SYSTEM_USER_READ], denied: [] },
    })

    const allowed = await app.inject({
      method: 'GET',
      url: '/api/system/users',
      headers: auth(token),
    })
    assert.equal(allowed.statusCode, 200, '授权后同一个令牌应当立刻放行')
  })

  test('撤销一次授权会真的收回来', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await createUser(ROLE_CODES.VIEWER)

    // 先给，再撤。两次都是整体替换，因此第二次写空数组即撤销。
    await app.inject({
      method: 'PUT',
      url: `/api/system/users/${target.id}/permissions`,
      headers: auth(owner.token),
      payload: { granted: [PERMISSIONS.SYSTEM_USER_READ], denied: [] },
    })
    await app.inject({
      method: 'PUT',
      url: `/api/system/users/${target.id}/permissions`,
      headers: auth(owner.token),
      payload: { granted: [], denied: [] },
    })

    const overrides = await prisma.userPermission.count({ where: { userId: target.id } })
    assert.equal(overrides, 0, '撤销后不该残留覆盖行')
  })

  test('admin 不能配置 owner 的权限 —— 层级判定先于 owner 判定', async () => {
    // 用 admin 当操作者，而不是另一个 owner：owner 之间本就互不可管理，
    // 那条路径先被「同级不可见」拦下（404），永远到不了「owner 不可改」这一支。
    // 用 admin 才能真正验证到它。
    const admin = await signIn(ROLE_CODES.ADMIN)
    const ownerAccount = await createUser(ROLE_CODES.OWNER)

    const response = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${ownerAccount.id}/permissions`,
      headers: auth(admin.token),
      payload: { granted: [], denied: [PERMISSIONS.SYSTEM_USER_MANAGE] },
    })
    // 仍返回 404（不可见），但库里绝不能落行 —— 那才是这条规则要守的东西。
    assert.equal(response.statusCode, 404)
    const overrides = await prisma.userPermission.count({
      where: { userId: ownerAccount.id },
    })
    assert.equal(overrides, 0, 'owner 的权限覆盖不该被写入')
  })

  test('owner 恒有全部权限，且 owner 不可被修改', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const me = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(owner.token),
    })
    const permissions = (me.json() as { permissions: PermissionCode[] }).permissions
    assert.ok(permissions.includes(PERMISSIONS.SYSTEM_USER_MANAGE))
    assert.ok(permissions.includes(PERMISSIONS.SYSTEM_USER_DELETE))
    assert.ok(permissions.includes(PERMISSIONS.SYSTEM_AUDIT_READ))

    // 即使库里给它写了 denied，短路规则让它不生效。
    const anotherOwner = await createUser(ROLE_CODES.OWNER)
    const permission = await prisma.permission.findUnique({
      where: { code: PERMISSIONS.SYSTEM_USER_MANAGE },
      select: { id: true },
    })
    assert.ok(permission)
    await prisma.userPermission.create({
      data: { userId: anotherOwner.id, permissionId: permission.id, granted: false },
    })

    const ownerSignIn = await login({
      username: anotherOwner.username,
      password: TEST_PASSWORD,
      ip: TEST_IP,
    })
    assert.ok(ownerSignIn.ok)
    const stillAll = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: auth(ownerSignIn.data.accessToken),
    })
    const stillHas = (stillAll.json() as { permissions: PermissionCode[] }).permissions
    assert.ok(stillHas.includes(PERMISSIONS.SYSTEM_USER_MANAGE), 'owner 的 denied 行不应生效')
  })

  test('即便持有 delete 权限也删不掉 owner', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await createUser(ROLE_CODES.MEMBER)

    // owner 自己有 system.user.delete，因此这道关卡守的是层级判定本身，
    // 而不是权限点缺失。member 是它能看见也够得着的层级，用它做对照。
    const memberRemoved = await app.inject({
      method: 'DELETE',
      url: `/api/system/users/${target.id}`,
      headers: auth(owner.token),
    })
    assert.equal(memberRemoved.statusCode, 200, '对照：owner 删得掉 member')

    const selfDelete = await app.inject({
      method: 'DELETE',
      url: `/api/system/users/${owner.userId}`,
      headers: auth(owner.token),
    })
    assert.equal(selfDelete.statusCode, 400)
    assert.equal(selfDelete.json().error, 'cannot_manage_self')
  })

  // -----------------------------------------------------------------------
  // 门禁与错误处理
  // -----------------------------------------------------------------------

  test('未认证访问一律 401', async () => {
    for (const url of ['/api/system/users', '/api/system/permissions', '/api/system/roles']) {
      const response = await app.inject({ method: 'GET', url })
      assert.equal(response.statusCode, 401, `${url} 未认证应当 401`)
    }
  })

  test('缺少 manage 权限的账号不能创建子账号', async () => {
    const member = await signIn(ROLE_CODES.MEMBER)
    const response = await app.inject({
      method: 'POST',
      url: '/api/system/users',
      headers: auth(member.token),
      payload: {
        username: `${TEST_DATA_PREFIX}nope`,
        password: TEST_PASSWORD,
        displayName: '越权创建',
        roleCode: ROLE_CODES.VIEWER,
      },
    })
    assert.equal(response.statusCode, 403)
  })

  test('没有 delete 权限时不能删账号', async () => {
    // admin 有 user.manage 但按设计没有 user.delete（只有 owner 有）。
    const admin = await signIn(ROLE_CODES.ADMIN)
    const target = await createUser(ROLE_CODES.MEMBER)

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/system/users/${target.id}`,
      headers: auth(admin.token),
    })
    assert.equal(response.statusCode, 403)

    const row = await prisma.user.findUnique({
      where: { id: target.id },
      select: { deletedAt: true },
    })
    assert.equal(row?.deletedAt, null)
  })

  test('用户 id 不是合法 UUID 时被 schema 拦下', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const response = await app.inject({
      method: 'GET',
      url: '/api/system/users/not-a-uuid',
      headers: auth(owner.token),
    })
    assert.equal(response.statusCode, 400)
  })

  test('未知权限码被当作非法输入', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const target = await createUser(ROLE_CODES.MEMBER)

    const response = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${target.id}/permissions`,
      headers: auth(owner.token),
      payload: { granted: ['system.not.exist'], denied: [] },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'invalid_permissions')
  })

  // -----------------------------------------------------------------------
  // 审计留痕
  // -----------------------------------------------------------------------

  /**
   * 阶段一验收清单「关键操作在 `audit_logs` 有记录」的端到端断言。
   *
   * 这条此前一直悬空：`audit.ts` 有写入点、`user-admin.ts` 有调用，但没有任何
   * 用例从**读取端**确认过。写入端正确而读取端无人验证，等于「代码里写着会写」
   * 而没有证据。这里把五类账号管理动作一次性走完，再回查审计表。
   *
   * 来源地址显式给 `TEST_IP`：inject 默认落在 127.0.0.1，而清理只认 TEST_IP。
   * 不显式给的话这些行会留在库里（这正是本断言缺席期间发生的事）。
   */
  test('五个账号管理动作各留一条审计，操作者可追溯且不含凭证', async () => {
    const owner = await signIn(ROLE_CODES.OWNER)
    const from = { remoteAddress: TEST_IP }
    const username = `${TEST_DATA_PREFIX}audited${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const newPassword = 'audit-test-password-1234'

    const created = await app.inject({
      method: 'POST',
      url: '/api/system/users',
      headers: auth(owner.token),
      ...from,
      payload: {
        username,
        password: TEST_PASSWORD,
        displayName: '留痕测试',
        roleCode: ROLE_CODES.MEMBER,
      },
    })
    assert.equal(created.statusCode, 201)
    const targetId = (created.json() as { user: { id: string } }).user.id
    createdUserIds.push(targetId)

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/system/users/${targetId}`,
      headers: auth(owner.token),
      ...from,
      payload: { status: 'disabled' },
    })
    assert.equal(updated.statusCode, 200)

    const reset = await app.inject({
      method: 'POST',
      url: `/api/system/users/${targetId}/reset-password`,
      headers: auth(owner.token),
      ...from,
      payload: { newPassword },
    })
    assert.equal(reset.statusCode, 200)

    const granted = await app.inject({
      method: 'PUT',
      url: `/api/system/users/${targetId}/permissions`,
      headers: auth(owner.token),
      ...from,
      payload: { granted: [PERMISSIONS.PERSONAL_NOTE_WRITE], denied: [] },
    })
    assert.equal(granted.statusCode, 200)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/system/users/${targetId}`,
      headers: auth(owner.token),
      ...from,
    })
    assert.equal(removed.statusCode, 200)

    const rows = await prisma.auditLog.findMany({
      where: { ip: TEST_IP, targetId },
      orderBy: { createdAt: 'asc' },
    })
    const byAction = new Map(rows.map((row) => [row.action, row]))

    for (const action of [
      AUDIT_ACTIONS.SYSTEM_USER_CREATE,
      AUDIT_ACTIONS.SYSTEM_USER_UPDATE,
      AUDIT_ACTIONS.SYSTEM_USER_RESET_PASSWORD,
      AUDIT_ACTIONS.SYSTEM_USER_SET_PERMISSIONS,
      AUDIT_ACTIONS.SYSTEM_USER_DELETE,
    ]) {
      const row = byAction.get(action)
      assert.ok(row !== undefined, `${action} 应当留下一条审计`)
      assert.equal(row.actorId, owner.userId, `${action} 的操作者应当是发起请求的 owner`)
      assert.equal(
        row.actorName,
        '账号管理测试',
        'actorName 是快照：账号被删除后 actorId 会置空，没有快照就再答不出「谁做的」',
      )
      assert.equal(row.targetType, 'user')
      assert.equal(row.result, 'success')
    }

    // 凭证不得进审计表。写入端已守住，这里从读取端再钉一次。
    const serialized = JSON.stringify(rows.map((row) => row.detail))
    assert.ok(!serialized.includes(TEST_PASSWORD), '审计 detail 不得含创建时提交的口令')
    assert.ok(!serialized.includes(newPassword), '审计 detail 不得含重置后的新口令')
  })
})
