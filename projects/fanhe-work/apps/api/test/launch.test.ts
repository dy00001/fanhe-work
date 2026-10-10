/**
 * 启动配置接口的集成测试。
 *
 * 需要真实数据库。这里要验证的东西有一半依赖库的真实行为：所有权隔离靠 where 条件
 * 落到 SQL 上才算数，软删除后的可见性靠 deletedAt 过滤，重排的事务性更是只有真库才
 * 能证明。用内存替身测这些，测的是替身自己。
 *
 * 用 `inject` 驱动完整路由链路（preHandler、schema、序列化）。这些接口的价值有一半
 * 在「绕过前端直接调」这条路径上 —— 权限与归属校验只测 service 的返回值，等于把最
 * 有意义的那一段漏掉。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { ROLE_CODES, type RoleCode } from '@fanhe/shared'

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
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
/** RFC 5737 的 TEST-NET-2 段。本文件独占一个地址，清理时能精确圈定。 */
const TEST_IP = '198.51.100.40'

const WECHAT_PATH = 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe'

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
  console.warn('[launch.test] 数据库不可达，启动配置接口的集成测试未执行')
}

describe('启动配置接口', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  const roleIds = new Map<RoleCode, string>()
  let passwordHash = ''
  let app: ReturnType<typeof buildApp>

  before(async () => {
    for (const code of [ROLE_CODES.MEMBER, ROLE_CODES.VIEWER]) {
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
      // 启动配置的外键是 Cascade，删账号本可连带清掉。这里显式删一次是因为级联
      // 生效与否取决于外键真的建上了，而「测试留下的数据没清干净」这件事在下次
      // 运行时表现为莫名其妙的计数不符，排查成本远高于多写这两行。
      await prisma.launchProfile.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    // 本文件用 login 取令牌，会顺带写入登录尝试与审计。
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
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
        displayName: '启动配置测试',
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

  function createPayload(name: string, extra: Record<string, unknown> = {}) {
    return { software: 'wechat', name, executablePath: WECHAT_PATH, ...extra }
  }

  test('未认证时返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/launch/profiles' })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'unauthorized')
  })

  test('只读访客能列出配置但不能新增', async () => {
    const { token } = await signIn(ROLE_CODES.VIEWER)
    const headers = authHeader(token)

    const read = await app.inject({ method: 'GET', url: '/api/launch/profiles', headers })
    assert.equal(read.statusCode, 200)
    assert.deepEqual(read.json().profiles, [])

    const write = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('只读访客不该建得出来'),
    })
    assert.equal(write.statusCode, 403)
    assert.equal(write.json().error, 'forbidden')
  })

  test('新增后能列出，字段原样返回', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const created = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('微信 · 工作号', {
        args: ['--multi-instance', ''],
        icon: 'wechat-work',
      }),
    })
    assert.equal(created.statusCode, 201)

    const profile = created.json().profile
    assert.equal(profile.name, '微信 · 工作号')
    assert.equal(profile.executablePath, WECHAT_PATH)
    // 空串参数必须原样保留：它是一个合法参数（表示显式的空值），过滤掉会改变命令行。
    assert.deepEqual(profile.args, ['--multi-instance', ''])
    assert.equal(profile.icon, 'wechat-work')
    // 第一条的排序号是 0，新增一律排在末尾。
    assert.equal(profile.sortOrder, 0)
    // 内部状态不外泄。
    assert.equal(profile.userId, undefined)
    assert.equal(profile.deletedAt, undefined)

    const listed = await app.inject({ method: 'GET', url: '/api/launch/profiles', headers })
    assert.equal(listed.statusCode, 200)
    assert.equal(listed.json().profiles.length, 1)
    assert.equal(listed.json().profiles[0].id, profile.id)
  })

  test('新增的配置依次排在末尾', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const first = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('第一条'),
    })
    const second = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('第二条'),
    })
    assert.equal(first.json().profile.sortOrder, 0)
    assert.equal(second.json().profile.sortOrder, 1)
  })

  test('修改只影响提交的字段', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const created = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('改名前', { args: ['--keep-me'] }),
    })
    const id = created.json().profile.id

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/launch/profiles/${id}`,
      headers,
      payload: { name: '改名后' },
    })
    assert.equal(updated.statusCode, 200)
    assert.equal(updated.json().profile.name, '改名后')
    // 没提交的字段保持原值 —— 「缺省时填回原值」的写法会让这里看起来一样，但那种
    // 写法每次都触碰所有列，updatedAt 随之变化，改动内容就看不出来了。
    assert.deepEqual(updated.json().profile.args, ['--keep-me'])
    assert.equal(updated.json().profile.executablePath, WECHAT_PATH)
  })

  test('空修改体被拒绝', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const created = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('空修改体'),
    })

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/launch/profiles/${created.json().profile.id}`,
      headers,
      payload: {},
    })
    assert.equal(response.statusCode, 400)
  })

  test('相对路径被拒绝', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const response = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(token),
      payload: { software: 'custom', name: '相对路径', executablePath: 'tools/launcher.exe' },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'invalid_path')
  })

  test('Unix 绝对路径被接受', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const response = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(token),
      payload: { software: 'custom', name: 'Unix 路径', executablePath: '/usr/bin/launcher' },
    })
    assert.equal(response.statusCode, 201)
  })

  test('清单外的软件标识被拒绝', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const response = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(token),
      payload: { software: 'telegram', name: '不支持的软件', executablePath: WECHAT_PATH },
    })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'invalid_software')
  })

  test('同一用户下显示名不能重复', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const first = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('重名检查'),
    })
    assert.equal(first.statusCode, 201)

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('重名检查'),
    })
    assert.equal(duplicate.statusCode, 409)
    assert.equal(duplicate.json().error, 'duplicate_name')

    // 改名撞上另一条也要拦，但保留自己的原名不算冲突。
    const second = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('另一条'),
    })
    const secondId = second.json().profile.id

    const keepOwnName = await app.inject({
      method: 'PATCH',
      url: `/api/launch/profiles/${secondId}`,
      headers,
      payload: { name: '另一条', icon: 'changed' },
    })
    assert.equal(keepOwnName.statusCode, 200)

    const collide = await app.inject({
      method: 'PATCH',
      url: `/api/launch/profiles/${secondId}`,
      headers,
      payload: { name: '重名检查' },
    })
    assert.equal(collide.statusCode, 409)
  })

  test('不同用户可以取相同的显示名', async () => {
    const first = await signIn(ROLE_CODES.MEMBER)
    const second = await signIn(ROLE_CODES.MEMBER)

    const a = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(first.token),
      payload: createPayload('同名跨用户'),
    })
    const b = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(second.token),
      payload: createPayload('同名跨用户'),
    })
    // 重名只在用户自己的范围内判断，否则一个用户能靠试错探出别人建过哪些名字。
    assert.equal(a.statusCode, 201)
    assert.equal(b.statusCode, 201)
  })

  test('列表只返回自己的配置', async () => {
    const owner = await signIn(ROLE_CODES.MEMBER)
    const other = await signIn(ROLE_CODES.MEMBER)

    await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(owner.token),
      payload: createPayload('只有主人看得见'),
    })

    const otherList = await app.inject({
      method: 'GET',
      url: '/api/launch/profiles',
      headers: authHeader(other.token),
    })
    assert.deepEqual(otherList.json().profiles, [])
  })

  test('改不了也删不了别人的配置，且返回 404 而不是 403', async () => {
    const owner = await signIn(ROLE_CODES.MEMBER)
    const other = await signIn(ROLE_CODES.MEMBER)

    const created = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(owner.token),
      payload: createPayload('别人的配置'),
    })
    const id = created.json().profile.id
    const otherHeaders = authHeader(other.token)

    const update = await app.inject({
      method: 'PATCH',
      url: `/api/launch/profiles/${id}`,
      headers: otherHeaders,
      payload: { name: '试图改名' },
    })
    // 403 等于确认「这个 id 存在，只是不属于你」，而 id 是 UUID，能问出存在性
    // 就意味着可以逐个试探。归属不符与真的不存在对外是同一种结果。
    assert.equal(update.statusCode, 404)

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/launch/profiles/${id}`,
      headers: otherHeaders,
    })
    // 删除是幂等的，别人的配置同样按「没删到任何一行」处理。
    assert.equal(remove.statusCode, 200)
    assert.equal(remove.json().removed, false)

    // 主人这边必须毫发无损。
    const ownerList = await app.inject({
      method: 'GET',
      url: '/api/launch/profiles',
      headers: authHeader(owner.token),
    })
    assert.equal(ownerList.json().profiles.length, 1)
    assert.equal(ownerList.json().profiles[0].name, '别人的配置')
  })

  test('删除是软删除，重复删除返回 removed: false', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const created = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('待删除'),
    })
    const id = created.json().profile.id

    const first = await app.inject({ method: 'DELETE', url: `/api/launch/profiles/${id}`, headers })
    const second = await app.inject({
      method: 'DELETE',
      url: `/api/launch/profiles/${id}`,
      headers,
    })
    assert.equal(first.json().removed, true)
    assert.equal(second.json().removed, false)

    const listed = await app.inject({ method: 'GET', url: '/api/launch/profiles', headers })
    assert.deepEqual(listed.json().profiles, [])

    // 行还在，只是被标记了 —— 软删除的可见性靠过滤而不是物理删除。
    const row = await prisma.launchProfile.findUnique({
      where: { id },
      select: { deletedAt: true },
    })
    assert.notEqual(row?.deletedAt, null)
  })

  test('删除后同名可以重新使用', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const created = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('删了再建'),
    })
    await app.inject({
      method: 'DELETE',
      url: `/api/launch/profiles/${created.json().profile.id}`,
      headers,
    })

    // 重名检查只看未删除的行。用数据库唯一约束实现这一条会在这里失败，而报错信息
    // 里看不出「是因为那条已删除的记录」。
    const again = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers,
      payload: createPayload('删了再建'),
    })
    assert.equal(again.statusCode, 201)
  })

  test('重排写入提交的顺序，并返回新列表', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const ids: string[] = []
    for (const name of ['甲', '乙', '丙']) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/launch/profiles',
        headers,
        payload: createPayload(name),
      })
      ids.push(created.json().profile.id)
    }

    const reordered = await app.inject({
      method: 'PUT',
      url: '/api/launch/profiles/order',
      headers,
      payload: { ids: [ids[2], ids[0], ids[1]] },
    })
    assert.equal(reordered.statusCode, 200)
    assert.deepEqual(
      reordered.json().profiles.map((profile: { name: string }) => profile.name),
      ['丙', '甲', '乙'],
    )

    // 再读一次，确认是落库的结果而不是响应里的临时排序。
    const listed = await app.inject({ method: 'GET', url: '/api/launch/profiles', headers })
    assert.deepEqual(
      listed.json().profiles.map((profile: { name: string }) => profile.name),
      ['丙', '甲', '乙'],
    )
    assert.deepEqual(
      listed.json().profiles.map((profile: { sortOrder: number }) => profile.sortOrder),
      [0, 1, 2],
    )
  })

  test('重排时 id 集合不完整会被拒绝', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const ids: string[] = []
    for (const name of ['甲', '乙']) {
      const created = await app.inject({
        method: 'POST',
        url: '/api/launch/profiles',
        headers,
        payload: createPayload(name),
      })
      ids.push(created.json().profile.id)
    }

    // 少一个：意味着有一行没有被分配新位置。
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/launch/profiles/order',
      headers,
      payload: { ids: [ids[0]] },
    })
    assert.equal(missing.statusCode, 409)
    assert.equal(missing.json().error, 'stale_order')

    // 多一个：意味着客户端拿着一份过期的列表在操作。
    const extra = await app.inject({
      method: 'PUT',
      url: '/api/launch/profiles/order',
      headers,
      payload: { ids: [...ids, randomUUID()] },
    })
    assert.equal(extra.statusCode, 409)

    // 重复：提交的 id 数量对得上，但集合大小不等于数组长度。
    const duplicated = await app.inject({
      method: 'PUT',
      url: '/api/launch/profiles/order',
      headers,
      payload: { ids: [ids[0], ids[0]] },
    })
    assert.equal(duplicated.statusCode, 409)
  })

  test('重排不能包含别人的配置', async () => {
    const owner = await signIn(ROLE_CODES.MEMBER)
    const other = await signIn(ROLE_CODES.MEMBER)

    const ownerProfile = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(owner.token),
      payload: createPayload('别人的'),
    })
    const otherProfile = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(other.token),
      payload: createPayload('自己的'),
    })

    const response = await app.inject({
      method: 'PUT',
      url: '/api/launch/profiles/order',
      headers: authHeader(other.token),
      payload: { ids: [ownerProfile.json().profile.id, otherProfile.json().profile.id] },
    })
    // 数量对得上（两条），但其中一条不属于当前用户 —— 按「集合不一致」拒绝。
    assert.equal(response.statusCode, 409)
  })
})
