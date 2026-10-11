/**
 * 纪要接口的集成测试。
 *
 * 需要真实数据库。这里要验证的东西有一半依赖库的真实行为：所有权隔离靠 where
 * 条件落到 SQL 上才算数，软删除后的可见性靠 deletedAt 过滤，标签筛选走的是
 * PostgreSQL 的数组包含判断 —— 用内存替身测这些，测的是替身自己。
 *
 * 用 `inject` 驱动完整路由链路（preHandler、schema、序列化）。这些接口的价值有一半
 * 在「绕过前端直接调」这条路径上，权限与归属校验只测 service 的返回值，等于把最
 * 有意义的那一段漏掉。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { NOTE_LIMITS, ROLE_CODES, type RoleCode } from '@fanhe/shared'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

// test-env.ts 已经把 DATABASE_URL 指向一个不可达地址，这里在 env.ts 被求值之前
// 换回真实值。下面一律用动态 import，静态 import 会被提升到本段之前执行。
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
const TEST_IP = '198.51.100.41'

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
  console.warn('[note.test] 数据库不可达，纪要接口的集成测试未执行')
}

describe('纪要接口', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
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
      // 纪要的外键是 Cascade，删账号本可连带清掉。这里显式删一次的理由与 launch
      // 的集成测试相同：级联生效与否取决于外键真的建上了，而「测试留下的数据没清
      // 干净」在下次运行时表现为莫名其妙的计数不符，排查成本远高于多写这两行。
      await prisma.note.deleteMany({ where: { userId: { in: createdUserIds } } })
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
        displayName: '纪要测试',
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

  /** 建一条纪要并返回响应体里的那条。多数用例只关心后续动作，不关心创建的回显。 */
  async function seedNote(
    headers: { authorization: string },
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { title, content: '正文', ...extra },
    })
    assert.equal(response.statusCode, 201, `建纪要失败：${response.body}`)
    return response.json().note
  }

  async function listNotes(
    headers: { authorization: string },
    query = '',
  ): Promise<Record<string, unknown>[]> {
    const response = await app.inject({ method: 'GET', url: `/api/notes${query}`, headers })
    assert.equal(response.statusCode, 200, `列纪要失败：${response.body}`)
    return response.json().notes
  }

  /**
   * 取列表的第一条，空列表时直接断言失败。
   *
   * 直接写 `notes[0].title` 在项目开启的 `noUncheckedIndexedAccess` 下是类型错误：
   * 索引访问的结果总是带上 `undefined`。解构出来再断言，既满足类型检查，也把
   * 「这里预期至少有一条」这层意思写进了代码，比一个 `!` 断言更能说明意图。
   */
  function firstOf(notes: Record<string, unknown>[]): Record<string, unknown> {
    const [first] = notes
    assert.ok(first !== undefined, '列表应当至少有一条纪要')
    return first
  }

  test('未认证时返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/notes' })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'unauthorized')
  })

  test('只读访客能列出纪要但不能新增', async () => {
    const { token } = await signIn(ROLE_CODES.VIEWER)
    const headers = authHeader(token)

    const read = await app.inject({ method: 'GET', url: '/api/notes', headers })
    assert.equal(read.statusCode, 200)
    assert.deepEqual(read.json().notes, [])

    const write = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { title: '只读访客不该建得出来', content: '' },
    })
    assert.equal(write.statusCode, 403)
    assert.equal(write.json().error, 'forbidden')
  })

  test('新增后能列出，字段原样返回且内部状态不外泄', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const created = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { title: '周会记录', content: '# 议题\n\n- 排期', tags: ['会议', '排期'] },
    })
    assert.equal(created.statusCode, 201)

    const note = created.json().note
    assert.equal(note.title, '周会记录')
    assert.equal(note.content, '# 议题\n\n- 排期')
    assert.deepEqual(note.tags, ['会议', '排期'])
    assert.equal(note.pinned, false)
    // 新建的纪要未归档，archivedAt 是 null 而不是缺失：字段缺失会让前端区分
    // 「未归档」与「这个字段还没上线」两件事。
    assert.equal(note.archivedAt, null)
    assert.equal(typeof note.createdAt, 'string')
    // 内部状态不外泄。
    assert.equal(note.userId, undefined)
    assert.equal(note.deletedAt, undefined)

    const listed = await listNotes(headers)
    assert.equal(listed.length, 1)
    assert.equal(firstOf(listed).id, note.id)
  })

  test('标题去掉首尾空白后落库', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const note = await seedNote(headers, '  周会记录  ')
    assert.equal(note.title, '周会记录')
  })

  test('正文原样保留，不被 trim', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    // Markdown 的前导空白决定列表层级与代码块，首尾空行是用户看得见的内容。
    // 归一正文等于悄悄改写了用户写下的东西。
    const content = '\n\n    缩进的代码块\n\n'
    const note = await seedNote(headers, '正文保留', { content })
    assert.equal(note.content, content)
  })

  test('正文允许为空', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    // 先起标题、内容回头再补，是记纪要时最常见的动作。
    const note = await seedNote(headers, '只有标题', { content: '' })
    assert.equal(note.content, '')
  })

  test('标签归一后再落库', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    // 空串由路由 schema 的 minLength 挡下，全空白要走到 service 才被丢弃。两层
    // 各管一段：schema 管「有没有填」，service 管「填的是不是一片空白」。
    const note = await seedNote(headers, '标签归一', {
      tags: ['  会议 ', '会议', '排期', '   '],
    })
    // 去空白、丢全空白、去重，且保留首次出现的顺序。
    assert.deepEqual(note.tags, ['会议', '排期'])
  })

  test('标签数量超过上限返回 400', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const tags = Array.from({ length: NOTE_LIMITS.TAGS_MAX_COUNT + 1 }, (_, i) => `标签${i}`)
    const response = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { title: '标签太多', content: '', tags },
    })
    // 这一条由路由 schema 的 maxItems 挡下，走不到 service：请求体的形状问题
    // 属于 schema 的职责。
    assert.equal(response.statusCode, 400)
  })

  test('空标题被拒', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const blank = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { title: '', content: '' },
    })
    assert.equal(blank.statusCode, 400)

    // 全空白通过 schema 的 minLength，由 service 的 trim 判断挡下。两处都要有，
    // 因为 schema 挡的是「没填」，service 挡的是「填了空格」。
    const spaces = await app.inject({
      method: 'POST',
      url: '/api/notes',
      headers,
      payload: { title: '   ', content: '' },
    })
    assert.equal(spaces.statusCode, 400)
    assert.equal(spaces.json().error, 'invalid_title')
  })

  test('修改只改传入的字段', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const note = await seedNote(headers, '原标题', { content: '原正文', tags: ['原标签'] })

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${note.id}`,
      headers,
      payload: { title: '新标题' },
    })
    assert.equal(updated.statusCode, 200)

    const result = updated.json().note
    assert.equal(result.title, '新标题')
    // 没传的字段原样保留。写成「缺省时填回原值」会让每次修改都触碰所有列。
    assert.equal(result.content, '原正文')
    assert.deepEqual(result.tags, ['原标签'])
  })

  test('空修改体被拒', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const note = await seedNote(headers, '空修改体')
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${note.id}`,
      headers,
      payload: {},
    })
    assert.equal(response.statusCode, 400)
  })

  test('修改不存在的纪要返回 404', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${randomUUID()}`,
      headers,
      payload: { title: '改不到' },
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error, 'not_found')
  })

  test('读不到、改不了、删不了别人的纪要，且一律返回 404', async () => {
    const owner = await signIn(ROLE_CODES.MEMBER)
    const other = await signIn(ROLE_CODES.MEMBER)

    const note = await seedNote(authHeader(owner.token), '别人的纪要')
    const otherHeaders = authHeader(other.token)

    // 归属不符与真的不存在共用同一个响应。403 等于确认「这个 id 存在，只是不属于
    // 你」，而 id 是 UUID，能问出存在性就意味着可以逐个试探。
    const read = await app.inject({
      method: 'GET',
      url: `/api/notes/${note.id}`,
      headers: otherHeaders,
    })
    assert.equal(read.statusCode, 404)

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/notes/${note.id}`,
      headers: otherHeaders,
      payload: { title: '改别人的' },
    })
    assert.equal(patch.statusCode, 404)

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/notes/${note.id}`,
      headers: otherHeaders,
    })
    assert.equal(remove.statusCode, 200)
    // 删除是幂等的软删除，删不到别人的那条时返回 removed: false 而不是 404 ——
    // 这条路径不泄漏存在性，因为响应形状与「删一条本来就不存在的」完全一致。
    assert.equal(remove.json().removed, false)

    // 原主人那边这条纪要还在。
    const still = await app.inject({
      method: 'GET',
      url: `/api/notes/${note.id}`,
      headers: authHeader(owner.token),
    })
    assert.equal(still.statusCode, 200)
  })

  test('软删除后不再出现，重复删除返回 removed false', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const note = await seedNote(headers, '待删除')

    const first = await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}`, headers })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().removed, true)

    const second = await app.inject({ method: 'DELETE', url: `/api/notes/${note.id}`, headers })
    assert.equal(second.json().removed, false)

    const listed = await listNotes(headers)
    assert.equal(listed.length, 0)

    const read = await app.inject({ method: 'GET', url: `/api/notes/${note.id}`, headers })
    assert.equal(read.statusCode, 404)
  })

  test('置顶的纪要排在列表最前', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const first = await seedNote(headers, '第一条')
    await seedNote(headers, '第二条')

    // 新纪要按更新时间倒序，第二条在最前。
    const before = await listNotes(headers)
    assert.equal(firstOf(before).title, '第二条')

    const pinned = await app.inject({
      method: 'PUT',
      url: `/api/notes/${first.id}/pin`,
      headers,
      payload: { pinned: true },
    })
    assert.equal(pinned.statusCode, 200)
    assert.equal(pinned.json().note.pinned, true)

    // 置顶之后第一条跑到最前，更新顺序在它身上不再起作用。
    const after = await listNotes(headers)
    assert.equal(firstOf(after).title, '第一条')

    // 取消置顶后回到按时间的顺序。
    await app.inject({
      method: 'PUT',
      url: `/api/notes/${first.id}/pin`,
      headers,
      payload: { pinned: false },
    })
    const restored = await listNotes(headers)
    assert.equal(firstOf(restored).title, '第一条')
  })

  test('归档的纪要退出默认列表，能在归档视图里找到', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const note = await seedNote(headers, '归档我')

    const archived = await app.inject({
      method: 'PUT',
      url: `/api/notes/${note.id}/archive`,
      headers,
      payload: { archived: true },
    })
    assert.equal(archived.statusCode, 200)
    assert.equal(typeof archived.json().note.archivedAt, 'string')

    assert.equal((await listNotes(headers)).length, 0)

    const archivedView = await listNotes(headers, '?archived=true')
    assert.equal(archivedView.length, 1)
    assert.equal(firstOf(archivedView).id, note.id)

    // 取消归档后回到默认视图。归档与删除是两条不同的路径：归档可以在界面上原地
    // 撤销，删除只能靠服务端还留着那一行。
    await app.inject({
      method: 'PUT',
      url: `/api/notes/${note.id}/archive`,
      headers,
      payload: { archived: false },
    })
    const restored = await listNotes(headers)
    assert.equal(restored.length, 1)
    assert.equal(firstOf(restored).archivedAt, null)
  })

  test('按标签筛选', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    await seedNote(headers, '带标签的', { tags: ['会议'] })
    await seedNote(headers, '不带标签的')

    const hits = await listNotes(headers, `?tag=${encodeURIComponent('会议')}`)
    assert.equal(hits.length, 1)
    assert.equal(firstOf(hits).title, '带标签的')

    const misses = await listNotes(headers, `?tag=${encodeURIComponent('不存在')}`)
    assert.equal(misses.length, 0)
  })

  test('按创建时间范围筛选', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    await seedNote(headers, '时间范围内的')

    const past = new Date(Date.now() - 60_000).toISOString()
    const future = new Date(Date.now() + 60_000).toISOString()

    assert.equal((await listNotes(headers, `?from=${past}`)).length, 1)
    assert.equal((await listNotes(headers, `?to=${future}`)).length, 1)

    // 上界取在一分钟之前，这条刚建的纪要落在范围外。
    assert.equal((await listNotes(headers, `?to=${past}`)).length, 0)
    // 下界取在一分钟之后，同样落在范围外。
    assert.equal((await listNotes(headers, `?from=${future}`)).length, 0)
  })

  test('非法的时间范围返回 400', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    // schema 只限长度，合法性由 service 的 Date 解析判断。
    const response = await app.inject({ method: 'GET', url: '/api/notes?from=昨天', headers })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'invalid_range')
  })

  test('标签清单按未删除的纪要计数，归档的也计入', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const first = await seedNote(headers, '标签计数一', { tags: ['会议', '排期'] })
    await seedNote(headers, '标签计数二', { tags: ['会议'] })

    const listed = await app.inject({ method: 'GET', url: '/api/notes/tags', headers })
    assert.equal(listed.statusCode, 200)
    const tags = listed.json().tags as { tag: string; count: number }[]

    assert.deepEqual(tags[0], { tag: '会议', count: 2 })
    assert.deepEqual(tags[1], { tag: '排期', count: 1 })

    // 归档是「收起来」而不是「不要了」，归档后计数不变。
    await app.inject({
      method: 'PUT',
      url: `/api/notes/${first.id}/archive`,
      headers,
      payload: { archived: true },
    })
    const afterArchive = await app.inject({ method: 'GET', url: '/api/notes/tags', headers })
    assert.deepEqual(afterArchive.json().tags[0], { tag: '会议', count: 2 })

    // 删除之后才从候选里消失。
    await app.inject({ method: 'DELETE', url: `/api/notes/${first.id}`, headers })
    const afterDelete = await app.inject({ method: 'GET', url: '/api/notes/tags', headers })
    assert.deepEqual(afterDelete.json().tags, [{ tag: '会议', count: 1 }])
  })

  test('列表的筛选参数非法取值被 schema 拒绝', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    // archived 只接受 'true' / 'false' 两个字符串。写成 type: 'boolean' 会让
    // ?archived=false 被拒，因为查询串里读到的永远是字符串。
    const response = await app.inject({ method: 'GET', url: '/api/notes?archived=yes', headers })
    assert.equal(response.statusCode, 400)
  })
})
