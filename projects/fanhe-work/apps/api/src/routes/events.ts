import {
  EVENT_LIMITS,
  EVENT_PRIORITIES,
  EVENT_STATUSES,
  PERMISSIONS,
  type CreateEventRequest,
  type DeleteEventResponse,
  type EventListResponse,
  type EventLogListResponse,
  type EventResponse,
  type EventTagListResponse,
  type SetEventStatusRequest,
  type UpdateEventRequest,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requirePermission } from '../auth/guard.js'
import {
  createEvent,
  getEvent,
  listEventLogs,
  listEvents,
  listEventTags,
  removeEvent,
  setEventStatus,
  updateEvent,
  type EventActor,
  type EventFailureReason,
} from '../event/events.js'

/**
 * 事件记录的接口。
 *
 * 读写分成两个权限点：`personal.event.read` 与 `personal.event.write`。只读访客
 * 这一档因此能看到事件但改不了任何一条，而这条限制由服务端强制 —— 前端的按钮隐藏
 * 只承担体验职责，任何人改一个请求就能绕过它。
 *
 * **状态变更单独一条路径**（`PUT /api/events/:id/status`），不并进 PATCH。它要做的
 * 事比改字段多一件：在同一事务里往 `event_logs` 追加一行。放在一条路径上，就得在
 * service 里判断「这次改的算不算状态变更」，而那个判断迟早会漏掉某条分支，表现为
 * 「状态变了但历史里没有这一行」—— 不报错，只有人翻详情面板时才会发现。
 *
 * **不写审计。** 与启动配置、纪要同一条判断，理由见 `event/events.ts` 顶部。
 */

/**
 * 失败原因到 HTTP 状态码。
 *
 * 六种 `invalid_*` 全部落在 400：请求本身的内容不合法，改请求就能解决。这张表里
 * 没有 409 —— 事件允许重名，也不存在「请求合法但与当前状态冲突」的失败：状态切换
 * 是幂等的，重复提交返回当前状态而不是冲突。
 *
 * 用 `Record<EventFailureReason, ...>` 而不是散在分支里的字面量：新增一种失败原因时
 * 这两张表会先在编译期报缺项，而不是让那条路径默默落进某个 `default` 分支里返回一个
 * 不准确的状态码。
 */
const FAILURE_STATUS: Record<EventFailureReason, number> = {
  not_found: 404,
  invalid_title: 400,
  invalid_description: 400,
  invalid_tags: 400,
  invalid_due_at: 400,
  invalid_comment: 400,
  invalid_range: 400,
}

const FAILURE_MESSAGE: Record<EventFailureReason, string> = {
  not_found: '事件不存在',
  invalid_title: `标题不能为空，且不超过 ${EVENT_LIMITS.TITLE_MAX} 字`,
  invalid_description: '描述长度超出上限',
  invalid_tags: `标签格式不正确，或数量超过 ${EVENT_LIMITS.TAGS_MAX_COUNT} 个`,
  invalid_due_at: '截止时间不是合法的日期',
  invalid_comment: `备注不超过 ${EVENT_LIMITS.COMMENT_MAX} 字`,
  invalid_range: '时间范围不是合法的日期',
}

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

/**
 * 取当前操作人。
 *
 * preHandler 已经保证认证通过，判空只是为了收窄类型。真出现 null 说明守卫没挂上，
 * 那时返回 401 比抛一个 500 更贴近事实，与其余模块的处理一致。
 *
 * 操作人取自认证上下文而不是请求体：让客户端传操作人等于让它自己声明身份，
 * 那条路径上的校验形同虚设。
 */
function currentActor(request: FastifyRequest): EventActor | null {
  const context = request.authContext
  if (context === null) return null
  return { id: context.userId, displayName: context.displayName }
}

function sendFailure(reply: FastifyReply, reason: EventFailureReason): FastifyReply {
  return reply
    .code(FAILURE_STATUS[reason])
    .send({ error: reason, message: FAILURE_MESSAGE[reason] })
}

/** 路径参数。id 是 UUID，长度上限给到 64 只是留余地，真正的作用是挡住超长字符串。 */
const ID_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

/**
 * 标签数组属性。创建与修改共用。
 *
 * 单项 `minLength: 1` 只是挡住空串这一类明显非法值，真正去重与判重的是 service 层
 * 的 `normalizeNoteTags`：schema 管的是「形状」，不归它管「哪些算是同一个标签」。
 */
const TAGS_PROPERTY = {
  type: 'array',
  maxItems: EVENT_LIMITS.TAGS_MAX_COUNT,
  items: { type: 'string', minLength: 1, maxLength: EVENT_LIMITS.TAG_MAX },
} as const

/**
 * 状态与优先级的取值。用共享包的常量展开，避免 schema 与类型定义各写一份取值 ——
 * 两处不一致时，多出来的那个取值会在 service 里变成一个没有分支处理的输入。
 */
const STATUS_PROPERTY = { type: 'string', enum: [...EVENT_STATUSES] } as const
const PRIORITY_PROPERTY = { type: 'string', enum: [...EVENT_PRIORITIES] } as const

/**
 * 截止时间与备注都允许显式传 `null`，因此类型写成 `['string', 'null']`。
 *
 * 用联合类型而不是 `nullable: true`：AJV 在 OpenAPI 严格模式下对 `nullable` 的处理
 * 依赖方言，而 `type` 数组是 JSON Schema 里语义最明确的一种写法 —— 两种情况都写
 * 在类型里，读 schema 的人不必再去查方言开关。
 *
 * `dueAt` 的 schema 只限长度，合法性交给 service 的 `new Date()` 判断，与纪要列表的
 * `from` / `to` 同一处理。
 */
const DUE_AT_PROPERTY = { type: ['string', 'null'], maxLength: 64 } as const
const COMMENT_PROPERTY = {
  type: ['string', 'null'],
  maxLength: EVENT_LIMITS.COMMENT_MAX,
} as const

/**
 * 请求体属性。创建与修改共用，只是必填项不同。
 *
 * `description` 允许省略也允许空串：先记下「要做什么」、细节回头再补，是记事件时
 * 最常见的动作，而一条没有描述的事件在列表上只是一行标题加一个勾选框。
 *
 * **不含 `status`。** 新建的事件一律是未完成，让客户端传意味着它要对这个状态负责，
 * 而它是「用户事后对这条事件做的动作」的产物。
 */
const EVENT_PROPERTIES = {
  title: { type: 'string', minLength: 1, maxLength: EVENT_LIMITS.TITLE_MAX },
  description: { type: 'string', maxLength: EVENT_LIMITS.DESCRIPTION_MAX },
  priority: PRIORITY_PROPERTY,
  tags: TAGS_PROPERTY,
  dueAt: DUE_AT_PROPERTY,
} as const

const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['title'],
  additionalProperties: false,
  properties: EVENT_PROPERTIES,
} as const

/**
 * 修改体。全部字段可选，但**至少要有一个**（`minProperties: 1`）。
 *
 * 空 body 等于什么都没改，却会走完一次查询与一次写入，`updatedAt` 随之变化 ——
 * 那会让「这条事件什么时候被改过」失真。直接拒绝比默默接受更诚实。
 */
const UPDATE_BODY_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: EVENT_PROPERTIES,
} as const

const STATUS_BODY_SCHEMA = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: { status: STATUS_PROPERTY, comment: COMMENT_PROPERTY },
} as const

/**
 * 列表查询参数。
 *
 * `status` 直接声明成枚举：它与 `archived` 那种布尔查询参数不同，取值本来就是字符串，
 * 不需要在服务端再转一次。写成枚举还顺带把非法值挡在 schema 层，不必让 service 去
 * 判断「这个 status 认不认识」。
 */
const LIST_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    status: STATUS_PROPERTY,
    tag: { type: 'string', maxLength: EVENT_LIMITS.TAG_MAX },
    from: { type: 'string', maxLength: 64 },
    to: { type: 'string', maxLength: 64 },
    // 检索词。名字用 `q` 而不是 `search`：这是查询串里的既有惯例，也短。
    q: { type: 'string', maxLength: EVENT_LIMITS.SEARCH_MAX },
  },
} as const

type ListQuery = { status?: string; tag?: string; from?: string; to?: string; q?: string }

export function registerEventRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ListQuery }>(
    '/api/events',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_EVENT_READ),
      schema: { querystring: LIST_QUERY_SCHEMA },
    },
    async (request, reply) => {
      const actor = currentActor(request)
      if (actor === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await listEvents(actor.id, {
        // schema 已经把取值限在 todo / done 两个字符串里，这里的断言只是把
        // 「查询串读出来是 string」收窄成服务端枚举。写成运行时判断反而是多余的
        // 一层 —— 真出现别的值说明 schema 没生效，那时更该让它落进 where 条件里
        // 报错，而不是被静默当成「不过滤」。
        status: request.query.status as 'todo' | 'done' | undefined,
        tag: request.query.tag,
        from: request.query.from,
        to: request.query.to,
        q: request.query.q,
      })
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: EventListResponse = { events: result.data }
      return reply.code(200).send(body)
    },
  )

  /**
   * 标签清单。挂在 `read` 上：标签是「我有哪些分类」这一事实，不含任何改动。
   *
   * 路径段 `tags` 与下面的 `:id` 不会冲突：Fastify 的路由树里静态段优先于参数段，
   * 与 `/api/notes/tags`、`/api/launch/profiles/status` 是同一条规则。
   */
  app.get(
    '/api/events/tags',
    { preHandler: requirePermission(PERMISSIONS.PERSONAL_EVENT_READ) },
    async (request, reply) => {
      const actor = currentActor(request)
      if (actor === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const body: EventTagListResponse = { tags: await listEventTags(actor.id) }
      return reply.code(200).send(body)
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/events/:id',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_EVENT_READ),
      schema: { params: ID_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const actor = currentActor(request)
      if (actor === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const event = await getEvent(actor.id, request.params.id)
      if (event === null) return sendFailure(reply, 'not_found')

      const body: EventResponse = { event }
      return reply.code(200).send(body)
    },
  )

  /**
   * 状态变更历史。T3-12 的详情面板靠它展示「谁在什么时候把状态改成了什么」。
   *
   * 单独一条接口而不是把日志塞进单条的响应里：列表与详情都用不上它，塞进去意味着
   * 每次取一条事件都要多查一次日志表 —— 而真正需要它的只有详情面板这一个入口。
   */
  app.get<{ Params: { id: string } }>(
    '/api/events/:id/logs',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_EVENT_READ),
      schema: { params: ID_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const actor = currentActor(request)
      if (actor === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      // null 表示事件不存在、不属于你、或已被删除，三种情况对外同为 404 ——
      // 日志表里没有 user_id 一列，少这一步归属确认就等于「拿到任意 eventId
      // 就能读到别人的历史」。
      const logs = await listEventLogs(actor.id, request.params.id)
      if (logs === null) return sendFailure(reply, 'not_found')

      const body: EventLogListResponse = { logs }
      return reply.code(200).send(body)
    },
  )

  app.post<{ Body: CreateEventRequest }>(
    '/api/events',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_EVENT_WRITE),
      schema: { body: CREATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const actor = currentActor(request)
      if (actor === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await createEvent(actor, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: EventResponse = { event: result.data }
      return reply.code(201).send(body)
    },
  )

  app.patch<{ Params: { id: string }; Body: UpdateEventRequest }>(
    '/api/events/:id',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_EVENT_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: UPDATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const actor = currentActor(request)
      if (actor === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await updateEvent(actor.id, request.params.id, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: EventResponse = { event: result.data }
      return reply.code(200).send(body)
    },
  )

  /**
   * 状态切换。勾选完成与撤销共用这一条，撤销就是把它设回 `todo`。
   *
   * 用 PUT 而不是 POST：它替换的是「这条事件处于哪个状态」这个整体，天然幂等 ——
   * 重复提交 `{ status: 'done' }` 的结果一样，也不会写出第二条日志。前端因此可以
   * 放心重试，切换失败时重发一次就够了。
   *
   * 返回更新后的整条事件，让界面不必再拉一次列表。撤销时的 `completedAt` 会变回
   * null，前端据此恢复「未完成」的展示。
   */
  app.put<{ Params: { id: string }; Body: SetEventStatusRequest }>(
    '/api/events/:id/status',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_EVENT_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: STATUS_BODY_SCHEMA },
    },
    async (request, reply) => {
      const actor = currentActor(request)
      if (actor === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await setEventStatus(actor, request.params.id, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: EventResponse = { event: result.data }
      return reply.code(200).send(body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/events/:id',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_EVENT_WRITE),
      schema: { params: ID_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const actor = currentActor(request)
      if (actor === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await removeEvent(actor.id, request.params.id)
      if (!result.ok) return sendFailure(reply, result.reason)

      // 删除是软删除且幂等，重复删除返回 removed: false 而不是 404。返回这个布尔值
      // 是为了让「点了删除但什么都没发生」在排查时有据可查，与其余两个板块一致。
      const body: DeleteEventResponse = result.data
      return reply.code(200).send(body)
    },
  )
}
