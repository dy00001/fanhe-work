/**
 * 事件接口的集成测试。
 *
 * 需要真实数据库。这里要验证的东西有一半依赖库的真实行为：所有权隔离靠 where
 * 条件落到 SQL 上才算数，软删除后的可见性靠 deletedAt 过滤，标签筛选走的是
 * PostgreSQL 的数组包含判断 —— 用内存替身测这些，测的是替身自己。
 *
 * 另一半是本板块的核心：**状态变更必须同时改状态与写日志，两件事在同一个事务里**。
 * 这条只有对着真库跑完整请求链路才有意义 —— 它与「接口返回了什么」无关，而是
 * 「库里最终多了哪一行」，用替身测等于把最要紧的那一段漏掉。
 *
 * 用 `inject` 驱动完整路由链路（preHandler、schema、序列化）。这些接口的价值有一半
 * 在「绕过前端直接调」这条路径上：权限与归属校验只测 service 的返回值，等于把最
 * 有意义的那一段漏掉。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { EVENT_LIMITS, ROLE_CODES, type RoleCode } from '@fanhe/shared'

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
/**
 * RFC 5737 的 TEST-NET-2 段。本文件独占一个地址，清理时能精确圈定 —— 与
 * note.test.ts 用不同的地址，否则两个文件并行跑时会把对方的登录尝试一并清掉。
 */
const TEST_IP = '198.51.100.42'
/** 测试账号的显示名。完成人快照断言要用到它。 */
const TEST_DISPLAY_NAME = '事件测试'

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
  console.warn('[event.test] 数据库不可达，事件接口的集成测试未执行')
}

describe('事件接口', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
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
      // 外键都是 Cascade，删账号本可连带清掉事件与日志。这里显式删一次的理由与
      // 其余集成测试相同：级联生效与否取决于外键真的建上了，而「测试留下的数据
      // 没清干净」在下次运行时表现为莫名其妙的计数不符，排查成本远高于多写这几行。
      //
      // 顺序按依赖倒着来：日志挂在事件上，事件挂在账号上。
      await prisma.eventLog.deleteMany({ where: { event: { userId: { in: createdUserIds } } } })
      await prisma.event.deleteMany({ where: { userId: { in: createdUserIds } } })
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
        displayName: TEST_DISPLAY_NAME,
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

  /** 建一条事件并返回响应体里的那条。多数用例只关心后续动作，不关心创建的回显。 */
  async function seedEvent(
    headers: { authorization: string },
    title: string,
    extra: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: { title, ...extra },
    })
    assert.equal(response.statusCode, 201, `建事件失败：${response.body}`)
    return response.json().event
  }

  async function listEvents(
    headers: { authorization: string },
    query = '',
  ): Promise<Record<string, unknown>[]> {
    const response = await app.inject({ method: 'GET', url: `/api/events${query}`, headers })
    assert.equal(response.statusCode, 200, `列事件失败：${response.body}`)
    return response.json().events
  }

  /** 取某条事件的状态变更历史。 */
  async function listLogs(
    headers: { authorization: string },
    eventId: unknown,
  ): Promise<Record<string, unknown>[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/events/${String(eventId)}/logs`,
      headers,
    })
    assert.equal(response.statusCode, 200, `取历史失败：${response.body}`)
    return response.json().logs
  }

  /**
   * 取列表的第一条，空列表时直接断言失败。
   *
   * 项目开启了 `noUncheckedIndexedAccess`，直接写 `events[0].title` 是类型错误：
   * 索引访问的结果总是带上 `undefined`。解构出来再断言，既满足类型检查，也把
   * 「这里预期至少有一条」这层意思写进了代码。
   */
  function firstOf(events: Record<string, unknown>[]): Record<string, unknown> {
    const [first] = events
    assert.ok(first !== undefined, '列表应当至少有一条事件')
    return first
  }

  /** 取列表的标题序列，用于断言顺序。 */
  function titlesOf(events: Record<string, unknown>[]): unknown[] {
    return events.map((event) => event.title)
  }

  test('未认证时返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/events' })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'unauthorized')
  })

  test('只读访客能列出事件但不能新增', async () => {
    const { token } = await signIn(ROLE_CODES.VIEWER)
    const headers = authHeader(token)

    const read = await app.inject({ method: 'GET', url: '/api/events', headers })
    assert.equal(read.statusCode, 200)
    assert.deepEqual(read.json().events, [])

    const write = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: { title: '只读访客不该建得出来' },
    })
    assert.equal(write.statusCode, 403)
    assert.equal(write.json().error, 'forbidden')
  })

  test('新增后能列出，字段原样返回且内部状态不外泄', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const created = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: {
        title: '与客户确认衣柜尺寸',
        description: '带上门板厚度与见光板做法',
        priority: 'high',
        tags: ['客户', '复尺'],
      },
    })
    assert.equal(created.statusCode, 201)

    const event = created.json().event
    assert.equal(event.title, '与客户确认衣柜尺寸')
    assert.equal(event.description, '带上门板厚度与见光板做法')
    assert.equal(event.priority, 'high')
    assert.deepEqual(event.tags, ['客户', '复尺'])
    // 新建的事件一律是未完成，且完成信息为空。
    assert.equal(event.status, 'todo')
    assert.equal(event.completedAt, null)
    assert.equal(event.completedBy, null)
    // 没传截止时间时是 null 而不是字段缺失：字段缺失会让前端区分「没设」与
    // 「这个字段还没上线」两件事。
    assert.equal(event.dueAt, null)
    assert.equal(typeof event.createdAt, 'string')
    // 内部状态不外泄。
    assert.equal(event.userId, undefined)
    assert.equal(event.deletedAt, undefined)
    assert.equal(event.completedById, undefined)

    const listed = await listEvents(headers)
    assert.equal(listed.length, 1)
    assert.equal(firstOf(listed).id, event.id)
  })

  test('未传的字段取默认值', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '只有标题的事件')
    // 描述默认为空串而不是 null：详情面板与列表都不需要为「这个字段是 null」
    // 单独分一次支，而空串在 Markdown 渲染下就是一片空白，语义与「没写」一致。
    assert.equal(event.description, '')
    assert.equal(event.priority, 'normal')
    assert.deepEqual(event.tags, [])
  })

  test('标题去掉首尾空白后落库', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '  与客户确认尺寸  ')
    assert.equal(event.title, '与客户确认尺寸')
  })

  test('描述原样保留，不被 trim', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    // Markdown 的前导空白决定列表层级与代码块，首尾空行是用户看得见的内容。
    const description = '\n\n    缩进的代码块\n\n'
    const event = await seedEvent(headers, '描述保留', { description })
    assert.equal(event.description, description)
  })

  test('空标题与被拒，全空白同样被拒', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const blank = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: { title: '' },
    })
    assert.equal(blank.statusCode, 400)

    // 全空白通过 schema 的 minLength，由 service 的 trim 判断挡下。两处都要有，
    // 因为 schema 挡的是「没填」，service 挡的是「填了空格」。
    const spaces = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: { title: '   ' },
    })
    assert.equal(spaces.statusCode, 400)
    assert.equal(spaces.json().error, 'invalid_title')
  })

  test('标签归一后再落库', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    // 归一规则与纪要共用同一份实现（共享包的 normalizeNoteTags）：去空白、
    // 丢全空白、去重，并保留首次出现的顺序。
    const event = await seedEvent(headers, '标签归一', {
      tags: ['  客户 ', '客户', '复尺', '   '],
    })
    assert.deepEqual(event.tags, ['客户', '复尺'])
  })

  test('标签数量超过上限返回 400', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const tags = Array.from({ length: EVENT_LIMITS.TAGS_MAX_COUNT + 1 }, (_, i) => `标签${i}`)
    const response = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: { title: '标签太多', tags },
    })
    // 这一条由路由 schema 的 maxItems 挡下，走不到 service：请求体的形状问题
    // 属于 schema 的职责。
    assert.equal(response.statusCode, 400)
  })

  test('非法优先级与非法状态被 schema 拒绝', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    // 取值域来自共享包的常量，schema 与类型定义不会各写一份。
    const badPriority = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: { title: '优先级非法', priority: 'urgent' },
    })
    assert.equal(badPriority.statusCode, 400)

    const event = await seedEvent(headers, '状态非法')
    const badStatus = await app.inject({
      method: 'PUT',
      url: `/api/events/${String(event.id)}/status`,
      headers,
      payload: { status: 'doing' },
    })
    assert.equal(badStatus.statusCode, 400)

    // 列表参数里的非法状态同样被挡在 schema 层，不必让 service 去判断。
    const badQuery = await app.inject({
      method: 'GET',
      url: '/api/events?status=doing',
      headers,
    })
    assert.equal(badQuery.statusCode, 400)
  })

  test('截止时间可设、可改、可清空，非法值被拒', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const due = new Date(Date.now() + 86_400_000).toISOString()
    const event = await seedEvent(headers, '有截止时间', { dueAt: due })
    assert.equal(event.dueAt, due)

    // 改成一个更早的时刻。允许填过去的时刻：补录既有事件时截止时间早于创建时间
    // 是常态，拒绝它只会逼用户填一个假的。
    const earlier = new Date(Date.now() - 86_400_000).toISOString()
    const past = await app.inject({
      method: 'PATCH',
      url: `/api/events/${String(event.id)}`,
      headers,
      payload: { dueAt: earlier },
    })
    assert.equal(past.statusCode, 200)
    assert.equal(past.json().event.dueAt, earlier)

    // 显式传 null 表示清除。这里「没传」与「传 null」必须区分开：前者是不改，
    // 后者是清空 —— 不区分的话用户就没法把已经设过的截止时间取消掉。
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/events/${String(event.id)}`,
      headers,
      payload: { dueAt: null },
    })
    assert.equal(cleared.statusCode, 200)
    assert.equal(cleared.json().event.dueAt, null)

    // schema 只限长度，合法性由 service 的 Date 解析判断。
    const bad = await app.inject({
      method: 'POST',
      url: '/api/events',
      headers,
      payload: { title: '截止时间非法', dueAt: '下周三' },
    })
    assert.equal(bad.statusCode, 400)
    assert.equal(bad.json().error, 'invalid_due_at')
  })

  test('创建时会写下第一条状态变更日志', async () => {
    // 详情面板的历史要有起点：只有「完成」「撤销」而没有「创建」，那条时间线看起来
    // 像是从半路开始的，而「什么时候建的」正是耗时计算的基准。
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '创建日志')
    const logs = await listLogs(headers, event.id)

    assert.equal(logs.length, 1)
    const log = firstOf(logs)
    assert.equal(log.action, 'created')
    // 此前没有状态，因此是 null 而不是 'todo' —— 写成 'todo' 会让这条记录看起来
    // 像一次「从 todo 变成 todo」的空流转。
    assert.equal(log.fromStatus, null)
    assert.equal(log.toStatus, 'todo')
    assert.equal(log.actor, TEST_DISPLAY_NAME)
    assert.equal(typeof log.createdAt, 'string')
  })

  test('勾选完成写入完成时间与操作人，并追加一行日志，不改动已有那行', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '待完成')
    const response = await app.inject({
      method: 'PUT',
      url: `/api/events/${String(event.id)}/status`,
      headers,
      payload: { status: 'done' },
    })
    assert.equal(response.statusCode, 200)

    const updated = response.json().event
    assert.equal(updated.status, 'done')
    assert.equal(typeof updated.completedAt, 'string')
    assert.equal(updated.completedBy, TEST_DISPLAY_NAME)

    const logs = await listLogs(headers, event.id)
    // 两条：创建与完成。原来那条 `created` 原样还在 —— 追加而不是原地改，
    // 这是本板块最核心的一条设计。
    assert.equal(logs.length, 2)
    assert.equal(logs[0]?.action, 'created')
    assert.equal(logs[1]?.action, 'completed')
    assert.equal(logs[1]?.fromStatus, 'todo')
    assert.equal(logs[1]?.toStatus, 'done')
    assert.equal(logs[1]?.actor, TEST_DISPLAY_NAME)
  })

  test('重复勾选完成是幂等的，且不写出第二条日志', async () => {
    // 客户端超时重试、用户连点两下都会走到写入点。让它们各写一行，历史里就会出现
    // 一串相同的动作，而「这条到底完成过几次」这个问题的答案就此失真。
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '重复完成')
    const url = `/api/events/${String(event.id)}/status`

    const first = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { status: 'done' },
    })
    const second = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { status: 'done' },
    })

    assert.equal(first.statusCode, 200)
    assert.equal(second.statusCode, 200)
    assert.equal(second.json().event.status, 'done')

    // 创建一行 + 完成一行，就这么多。
    const logs = await listLogs(headers, event.id)
    assert.equal(logs.length, 2)
    assert.equal(logs[1]?.action, 'completed')
  })

  test('撤销完成清空完成信息，并追加一行撤销记录而保留原完成记录', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '完成后撤销')
    const url = `/api/events/${String(event.id)}/status`

    await app.inject({ method: 'PUT', url, headers, payload: { status: 'done' } })
    const reopened = await app.inject({
      method: 'PUT',
      url,
      headers,
      payload: { status: 'todo', comment: '点错了' },
    })
    assert.equal(reopened.statusCode, 200)

    const restored = reopened.json().event
    assert.equal(restored.status, 'todo')
    // 三列一起清空：留一个「完成了但不知道是谁」的中间状态只会让详情面板多一个
    // 分支去猜。
    assert.equal(restored.completedAt, null)
    assert.equal(restored.completedBy, null)

    const logs = await listLogs(headers, event.id)
    assert.equal(logs.length, 3)
    // 撤销不是删掉「完成」那一行，而是再追加一行 —— 删掉它等于抹去「这件事曾经
    // 被完成过」，而详情面板要展示的耗时正需要那个时刻。
    assert.deepEqual(
      logs.map((log) => log.action),
      ['created', 'completed', 'reopened'],
    )
    assert.equal(logs[2]?.fromStatus, 'done')
    assert.equal(logs[2]?.toStatus, 'todo')
    // 撤销时写的备注落库了：撤销这件事通常需要一个理由。
    assert.equal(logs[2]?.comment, '点错了')
  })

  test('备注重去空白，空备注归一为 null', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '空备注')
    await app.inject({
      method: 'PUT',
      url: `/api/events/${String(event.id)}/status`,
      headers,
      payload: { status: 'done', comment: '   ' },
    })

    const logs = await listLogs(headers, event.id)
    assert.equal(logs[1]?.comment, null)
  })

  test('备注超长被 schema 拒绝', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '备注超长')
    const response = await app.inject({
      method: 'PUT',
      url: `/api/events/${String(event.id)}/status`,
      headers,
      payload: { status: 'done', comment: '中'.repeat(EVENT_LIMITS.COMMENT_MAX + 1) },
    })
    assert.equal(response.statusCode, 400)
  })

  test('修改只改传入的字段，且不写状态变更日志', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '原标题', {
      description: '原描述',
      tags: ['原标签'],
      priority: 'low',
    })

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/events/${String(event.id)}`,
      headers,
      payload: { title: '新标题' },
    })
    assert.equal(updated.statusCode, 200)

    const result = updated.json().event
    assert.equal(result.title, '新标题')
    // 没传的字段原样保留。写成「缺省时填回原值」会让每次修改都触碰所有列。
    assert.equal(result.description, '原描述')
    assert.deepEqual(result.tags, ['原标签'])
    assert.equal(result.priority, 'low')

    // 编辑不写日志：详情面板要回答的是「状态怎么变的」，把每次改标题也塞进去，
    // 这条流水就从状态变更历史变成一份全字段的修改记录。
    const logs = await listLogs(headers, event.id)
    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.action, 'created')
  })

  test('空修改体被拒', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '空修改体')
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/events/${String(event.id)}`,
      headers,
      payload: {},
    })
    assert.equal(response.statusCode, 400)
  })

  test('修改不改变状态与完成信息', async () => {
    // 状态只能通过独立的接口改。若 PATCH 也能顺手改掉它，那条路径不会写日志，
    // 于是「状态变了但没有历史」这件事就有了入口。
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '改标题不动状态')
    await app.inject({
      method: 'PUT',
      url: `/api/events/${String(event.id)}/status`,
      headers,
      payload: { status: 'done' },
    })

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/events/${String(event.id)}`,
      headers,
      payload: { title: '换了个名字' },
    })
    assert.equal(patched.statusCode, 200)
    assert.equal(patched.json().event.status, 'done')
    assert.equal(typeof patched.json().event.completedAt, 'string')
  })

  test('状态字段不接受通过 PATCH 传入', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '状态不可直改')
    // schema 里没有 status 这一项，additionalProperties: false 让它成为一个
    // 被拒绝的请求，而不是一次静默删除 —— 后者会让调用方以为生效了。
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/events/${String(event.id)}`,
      headers,
      payload: { status: 'done' },
    })
    assert.equal(response.statusCode, 400)
  })

  test('读不到、改不了、切不了、删不了别人的事件，且一律返回 404', async () => {
    const owner = await signIn(ROLE_CODES.MEMBER)
    const other = await signIn(ROLE_CODES.MEMBER)

    const event = await seedEvent(authHeader(owner.token), '别人的事件')
    const otherHeaders = authHeader(other.token)

    // 归属不符与真的不存在共用同一个响应。403 等于确认「这个 id 存在，只是不属于
    // 你」，而 id 是 UUID，能问出存在性就意味着可以逐个试探。
    const read = await app.inject({
      method: 'GET',
      url: `/api/events/${String(event.id)}`,
      headers: otherHeaders,
    })
    assert.equal(read.statusCode, 404)

    // 历史接口单独检查一次：日志表里没有 user_id 一列，它的归属完全靠事件那一次
    // 确认来保证，漏掉就是一个「拿到任意 eventId 就能读别人历史」的口子。
    const logs = await app.inject({
      method: 'GET',
      url: `/api/events/${String(event.id)}/logs`,
      headers: otherHeaders,
    })
    assert.equal(logs.statusCode, 404)

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/events/${String(event.id)}`,
      headers: otherHeaders,
      payload: { title: '改别人的' },
    })
    assert.equal(patch.statusCode, 404)

    const status = await app.inject({
      method: 'PUT',
      url: `/api/events/${String(event.id)}/status`,
      headers: otherHeaders,
      payload: { status: 'done' },
    })
    assert.equal(status.statusCode, 404)

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/events/${String(event.id)}`,
      headers: otherHeaders,
    })
    assert.equal(remove.statusCode, 200)
    // 删除是幂等的软删除，删不到别人的那条时返回 removed: false 而不是 404 ——
    // 这条路径不泄漏存在性，因为响应形状与「删一条本来就不存在的」完全一致。
    assert.equal(remove.json().removed, false)

    // 原主人那边这条事件还在。
    const still = await app.inject({
      method: 'GET',
      url: `/api/events/${String(event.id)}`,
      headers: authHeader(owner.token),
    })
    assert.equal(still.statusCode, 200)
  })

  test('软删除后不再出现，历史也不再可读，重复删除返回 removed false', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const event = await seedEvent(headers, '待删除')

    const first = await app.inject({
      method: 'DELETE',
      url: `/api/events/${String(event.id)}`,
      headers,
    })
    assert.equal(first.statusCode, 200)
    assert.equal(first.json().removed, true)

    const second = await app.inject({
      method: 'DELETE',
      url: `/api/events/${String(event.id)}`,
      headers,
    })
    assert.equal(second.json().removed, false)

    assert.equal((await listEvents(headers)).length, 0)

    const read = await app.inject({
      method: 'GET',
      url: `/api/events/${String(event.id)}`,
      headers,
    })
    assert.equal(read.statusCode, 404)

    // 详情面板的入口随事件一起消失。日志行仍在库里（软删除不抹数据），但对外
    // 与「这条事件不存在」是同一个结果。
    const logs = await app.inject({
      method: 'GET',
      url: `/api/events/${String(event.id)}/logs`,
      headers,
    })
    assert.equal(logs.statusCode, 404)
  })

  test('列表把未完成排在已完成前面', async () => {
    // 这条同时钉住了实现里那个不显眼的依赖：`status: 'asc'` 让 todo 排在 done
    // 前面，靠的是 PostgreSQL 按枚举的定义顺序比较。改动 event_status 枚举里的
    // 书写顺序就会翻转这个结果，所以那不是一个纯排版动作。
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const done = await seedEvent(headers, '已经完成的')
    await seedEvent(headers, '还没做的')

    await app.inject({
      method: 'PUT',
      url: `/api/events/${String(done.id)}/status`,
      headers,
      payload: { status: 'done' },
    })

    const listed = await listEvents(headers)
    assert.deepEqual(titlesOf(listed), ['还没做的', '已经完成的'])
  })

  test('组内按截止时间升序，没有截止时间的排在组尾', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const soon = new Date(Date.now() + 86_400_000).toISOString()
    const later = new Date(Date.now() + 172_800_000).toISOString()

    // 建的顺序刻意打乱，用来证明结果不是「按创建顺序」。
    await seedEvent(headers, '没有截止时间')
    await seedEvent(headers, '后天', { dueAt: later })
    await seedEvent(headers, '明天', { dueAt: soon })

    const listed = await listEvents(headers)
    // 近的在前；没有截止时间的靠 PostgreSQL 对 ASC 的默认行为（NULLS LAST）
    // 落在组尾。
    assert.deepEqual(titlesOf(listed), ['明天', '后天', '没有截止时间'])
  })

  test('中文关键词同时命中标题与描述', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    await seedEvent(headers, '衣柜尺寸复尺', { description: '与客户确认' })
    await seedEvent(headers, '其他事项', { description: '衣柜要考虑见光板与收口条' })
    await seedEvent(headers, '完全无关的一条', { description: '与关键词毫无关系' })

    const hits = await listEvents(headers, `?q=${encodeURIComponent('衣柜')}`)
    assert.equal(hits.length, 2)
    assert.deepEqual(titlesOf(hits).sort(), ['其他事项', '衣柜尺寸复尺'])

    // 描述里的关键词同样能被搜到 —— 只搜标题的实现也能让标题那条命中，
    // 因此必须单独确认描述这一半。
    const descriptionOnly = await listEvents(headers, `?q=${encodeURIComponent('见光板')}`)
    assert.equal(descriptionOnly.length, 1)
    assert.equal(firstOf(descriptionOnly).title, '其他事项')

    assert.equal((await listEvents(headers, `?q=${encodeURIComponent('搜不到的词')}`)).length, 0)
  })

  test('按状态与标签筛选，并与检索取交集', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const done = await seedEvent(headers, '客户的事已完成', {
      tags: ['客户'],
      description: '衣柜',
    })
    await seedEvent(headers, '客户的事还没做', { tags: ['客户'], description: '衣柜' })
    await seedEvent(headers, '别的事', { description: '衣柜' })

    await app.inject({
      method: 'PUT',
      url: `/api/events/${String(done.id)}/status`,
      headers,
      payload: { status: 'done' },
    })

    const doneOnly = await listEvents(headers, '?status=done')
    assert.deepEqual(titlesOf(doneOnly), ['客户的事已完成'])

    const todoOnly = await listEvents(headers, '?status=todo')
    assert.deepEqual(titlesOf(todoOnly).sort(), ['别的事', '客户的事还没做'])

    // 三个条件同时给：状态、标签、关键词取交集。
    const both = await listEvents(
      headers,
      `?status=todo&tag=${encodeURIComponent('客户')}&q=${encodeURIComponent('衣柜')}`,
    )
    assert.deepEqual(titlesOf(both), ['客户的事还没做'])
  })

  test('检索不会搜到别人的事件', async () => {
    // 加检索最容易破的就是所有权的边界：条件从「恒带 userId」变成 OR 之后，
    // 写错括号就会让 OR 把 userId 一起纳进去。这类缺陷不报错，只会多出别人的数据。
    const mine = await signIn(ROLE_CODES.MEMBER)
    const other = await signIn(ROLE_CODES.MEMBER)

    await seedEvent(authHeader(other.token), '别人的衣柜')

    assert.equal(
      (await listEvents(authHeader(mine.token), `?q=${encodeURIComponent('衣柜')}`)).length,
      0,
    )
    assert.equal(
      (await listEvents(authHeader(other.token), `?q=${encodeURIComponent('衣柜')}`)).length,
      1,
    )
  })

  test('空检索词与全空白检索词都按不检索处理', async () => {
    // 防的是「空串被当成一个真实的词」：`contains: ''` 会匹配每一行，表面上与
    // 「不检索」结果相同，因此只在实现里看才分得清 —— 而它同时意味着前端一旦传了
    // 空串，服务端就没有任何机会发现语义已经错了。
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    await seedEvent(headers, '第一条')
    await seedEvent(headers, '第二条')

    assert.equal((await listEvents(headers, '?q=')).length, 2)
    assert.equal((await listEvents(headers, `?q=${encodeURIComponent('   ')}`)).length, 2)
    assert.equal((await listEvents(headers, '')).length, 2)
  })

  test('非法的时间范围返回 400', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const response = await app.inject({ method: 'GET', url: '/api/events?from=昨天', headers })
    assert.equal(response.statusCode, 400)
    assert.equal(response.json().error, 'invalid_range')
  })

  test('标签清单按未删除的事件计数，已完成的也计入', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)

    const first = await seedEvent(headers, '标签计数一', { tags: ['客户', '复尺'] })
    await seedEvent(headers, '标签计数二', { tags: ['客户'] })

    const listed = await app.inject({ method: 'GET', url: '/api/events/tags', headers })
    assert.equal(listed.statusCode, 200)
    const tags = listed.json().tags as { tag: string; count: number }[]

    assert.deepEqual(tags[0], { tag: '客户', count: 2 })
    assert.deepEqual(tags[1], { tag: '复尺', count: 1 })

    // 完成不是「不要了」，完成后计数不变。
    await app.inject({
      method: 'PUT',
      url: `/api/events/${String(first.id)}/status`,
      headers,
      payload: { status: 'done' },
    })
    const afterComplete = await app.inject({ method: 'GET', url: '/api/events/tags', headers })
    assert.deepEqual(afterComplete.json().tags[0], { tag: '客户', count: 2 })

    // 删除之后才从候选里消失。
    await app.inject({ method: 'DELETE', url: `/api/events/${String(first.id)}`, headers })
    const afterDelete = await app.inject({ method: 'GET', url: '/api/events/tags', headers })
    assert.deepEqual(afterDelete.json().tags, [{ tag: '客户', count: 1 }])
  })

  test('取不存在的事件与历史都返回 404', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const headers = authHeader(token)
    const missing = randomUUID()

    const read = await app.inject({ method: 'GET', url: `/api/events/${missing}`, headers })
    assert.equal(read.statusCode, 404)
    assert.equal(read.json().error, 'not_found')

    const logs = await app.inject({ method: 'GET', url: `/api/events/${missing}/logs`, headers })
    assert.equal(logs.statusCode, 404)

    const status = await app.inject({
      method: 'PUT',
      url: `/api/events/${missing}/status`,
      headers,
      payload: { status: 'done' },
    })
    assert.equal(status.statusCode, 404)
  })
})
