import {
  CUSTOMER_LIMITS,
  CUSTOMER_ROLES,
  CUSTOMER_STAGES,
  PERMISSIONS,
  type CustomerDetailResponse,
  type CustomerListResponse,
  type CustomerStage,
  type AssignableUsersResponse,
  type PoolListResponse,
  type ReviewPoolSuggestionRequest,
  type AssignCustomerRequest,
  type ClassifyPoolRequest,
  type ClassifyPoolResponse,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
  assignCustomer,
  createCustomer,
  createOrder,
  getCustomer,
  listCustomers,
  setStage,
  updateCustomer,
  updateStep,
  type CreateCustomerInput,
  type CreateOrderInput,
  type CustomerFailureReason,
  type SetStageInput,
  type UpdateCustomerInput,
  type UpdateStepInput,
} from '../customer/customers.js'
import {
  classifyPool,
  listAssignableUsers,
  listPool,
  reviewPoolSuggestion,
} from '../customer/pool.js'
import { viewerFromRequest, type CustomerViewer } from '../customer/scope.js'
import { requirePermission } from '../auth/guard.js'

/**
 * 客户信息平台的接口。
 *
 * 权限分三层，对应 `permissions.ts` 里客户段的七个点：
 *
 *   - 进页面与读档案 → `customer.record.read`
 *   - 改档案        → `customer.record.write`
 *   - 推进订单环节   → `customer.order.write`
 *   - 看金额        → `customer.finance.read`（字段级，在可见行内不遮金额）
 *   - 能看哪些行     → `customer.scope.read`（不持有则只看本人负责的）
 *   - 转派归属      → `customer.scope.write`
 *   - 复核归类      → `customer.import.review`
 *
 * **金额为什么仍然单独一个点。** 虽然本期设计师与销售都拿到了它，但它与行范围是
 * 两个维度：范围回答「能不能打开这一行」，金额回答「打开之后数字是否打码」。
 * 某些岗位（例如财务外包）可能只需要金额汇总不需要客户电话，拆开才表达得出。
 *
 * **观察者（viewer）在每个处理器里算一次**，然后整条链路往下传。不在 service 里
 * 重新读 `request`：那会让「当前账号能看什么」这件事散落在多层，而任何一层拿到
 * 的上下文不同时，表现是同一页面里两个接口的可见范围不一致。
 */

const FAILURE_STATUS: Record<CustomerFailureReason, number> = {
  not_found: 404,
  invalid_name: 400,
  invalid_region: 400,
  invalid_phone: 400,
  invalid_stage: 400,
  invalid_amount: 400,
  missing_reason: 400,
  duplicate_chatroom: 409,
  duplicate_code: 409,
  // 400 而不是 403：403 在这一层会把「字段级拒绝」与「行级越权」混成同一个码，
  // 前端就无法区分「该重拉详情」还是「该收起这个输入框」。
  field_not_allowed: 400,
  invalid_assignee: 400,
}

const FAILURE_MESSAGE: Record<CustomerFailureReason, string> = {
  not_found: '客户或订单不存在',
  invalid_name: `姓名不能为空，且不超过 ${CUSTOMER_LIMITS.REAL_NAME_MAX} 字`,
  invalid_region: `地区不能为空，且不超过 ${CUSTOMER_LIMITS.REGION_MAX} 字`,
  invalid_phone: `电话不超过 ${CUSTOMER_LIMITS.PHONE_MAX} 位`,
  invalid_stage: '阶段或日期不合法',
  invalid_amount: '金额必须是非负整数，单位为分',
  missing_reason: '回退阶段或调整归属必须填写原因',
  duplicate_chatroom: '这个微信群已经绑定过客户',
  duplicate_code: '订单编号重复',
  field_not_allowed: '该字段不在你的可编辑范围内',
  invalid_assignee: '目标账号不存在、已停用，或与该角色的身份不符',
}

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

function sendFailure(reply: FastifyReply, reason: CustomerFailureReason): FastifyReply {
  return reply
    .code(FAILURE_STATUS[reason])
    .send({ error: reason, message: FAILURE_MESSAGE[reason] })
}

/**
 * 取观察者。未认证直接 401。
 *
 * 这里**不再单独算 `hasFinanceRead`**：金额权限是观察者的一部分，随其余字段一并
 * 算出。分开算的结果是同一个请求里两处判断各读一次权限数组，而两者漂移时表现是
 * 「列表遮了金额、详情没遮」。
 */
function requireViewer(request: FastifyRequest, reply: FastifyReply): CustomerViewer | null {
  const viewer = viewerFromRequest(request)
  if (viewer === null) {
    reply.code(401).send(UNAUTHORIZED_BODY)
    return null
  }
  return viewer
}

/**
 * 列表查询参数。
 *
 * `review` 与运营看板的 `archived` 同理，只能声明成字符串枚举：查询串里读到的
 * 永远是字符串，写 `type: 'boolean'` 会让 `?review=pending` 被 AJV 拒绝。
 *
 * `from` / `to` 是**半开区间**（含起点、不含终点），只接受两种写法：
 * `2026-10-30`（按本地零点解释）与 `2026-10-30T14:00`（按本地时刻解释）。
 * 不接受带时区的完整 ISO 串：地址栏里那一长串既难读，也会在复制粘贴时被截断，
 * 而两种写法已经能覆盖「按天」与「按小时」两种下钻粒度。
 */
const LIST_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    region: { type: 'string', maxLength: CUSTOMER_LIMITS.REGION_MAX },
    scope: { type: 'string', enum: ['special-region', 'overseas', 'domestic'] },
    stage: { type: 'string', enum: [...CUSTOMER_STAGES] },
    review: { type: 'string', enum: ['pending', 'confirmed', 'rejected'] },
    q: { type: 'string', maxLength: CUSTOMER_LIMITS.SEARCH_MAX },
    from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$' },
    to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}(T\\d{2}:\\d{2})?$' },
    mode: { type: 'string', enum: ['list', 'summary'] },
    limit: { type: 'integer', minimum: 1, maximum: CUSTOMER_LIMITS.PAGE_MAX },
  },
} as const

type ListQuery = {
  region?: string
  scope?: string
  stage?: string
  review?: string
  q?: string
  from?: string
  to?: string
  mode?: string
  limit?: number
}

/**
 * 把 `from` / `to` 解析成本地时刻。
 *
 * **不用 `new Date('2026-10-30')`。** 那种写法按 UTC 解释，在东八区会得到前一天
 * 早上八点，于是「按 10-30 筛」实际筛的是 10-29 08:00 到 10-30 08:00。这个偏差
 * 在界面上完全看不出来：列表有数据、图表有数字，只是整体错了一天。
 *
 * 解析完再拼回字符串比对一次，挡住 `2026-02-31` 这种被 `Date` 静默滚到下个月的写法。
 */
function parseLocalInstant(value: string | undefined): Date | null | 'invalid' {
  if (value === undefined || value === '') return null
  const text = value.trim()
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(text)
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)) return 'invalid'

  const parsed = new Date(dateOnly ? `${text}T00:00:00` : `${text}:00`)
  if (Number.isNaN(parsed.getTime())) return 'invalid'

  const pad = (input: number) => String(input).padStart(2, '0')
  const rebuilt = `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}`
  if (dateOnly) return rebuilt === text ? parsed : 'invalid'
  const withTime = `${rebuilt}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  return withTime === text ? parsed : 'invalid'
}

const ID_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

const STEP_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id', 'orderId', 'idx'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    orderId: { type: 'string', minLength: 1, maxLength: 64 },
    idx: { type: 'integer', minimum: 1, maximum: 14 },
  },
} as const

/**
 * 创建客户的请求体。
 *
 * **不接收 displayName 与 shortName。** 这两列由契约函数从「真名 + 地区 + 项目」
 * 算出，让前端传等于把派生规则复制到第二个地方，两边漂移后表现是同一个客户在
 * 两个页面上名字不同 —— 而这类偏差没有任何报错。
 */
const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['realName', 'region'],
  additionalProperties: false,
  properties: {
    realName: { type: 'string', minLength: 1, maxLength: CUSTOMER_LIMITS.REAL_NAME_MAX },
    region: { type: 'string', minLength: 1, maxLength: CUSTOMER_LIMITS.REGION_MAX },
    phone: { type: 'string', maxLength: CUSTOMER_LIMITS.PHONE_MAX },
    primaryNickname: { type: 'string', maxLength: CUSTOMER_LIMITS.NICKNAME_MAX },
    project: { type: 'string', maxLength: CUSTOMER_LIMITS.NAME_MAX },
    chatroom: { type: 'string', maxLength: 80 },
    stage: { type: 'string', enum: [...CUSTOMER_STAGES] },
  },
} as const

/**
 * 修改体。全部可选且至少一项。
 *
 * `reviewStatus` 是唯一的例外，它只能由人工复核接口改 —— 这里接受它是因为
 * 复核页与档案编辑共用同一个 PATCH，而拆出第二条路径会让「确认这个客户」多一次
 * 往返。取值范围在 schema 里钉住，不接受任意字符串。
 */
const UPDATE_BODY_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    realName: { type: 'string', minLength: 1, maxLength: CUSTOMER_LIMITS.REAL_NAME_MAX },
    region: { type: 'string', minLength: 1, maxLength: CUSTOMER_LIMITS.REGION_MAX },
    phone: { type: 'string', maxLength: CUSTOMER_LIMITS.PHONE_MAX },
    primaryNickname: { type: 'string', maxLength: CUSTOMER_LIMITS.NICKNAME_MAX },
    project: { type: 'string', maxLength: CUSTOMER_LIMITS.NAME_MAX },
    reviewStatus: { type: 'string', enum: ['pending', 'confirmed', 'rejected'] },
  },
} as const

const CREATE_ORDER_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // 上限 1 亿元（按分计即 1e10）。检查的不是「这笔生意不可能这么大」，
    // 而是「这个数字不可能是一位一位敲进去的」—— 多按几个零是最常见的手误，
    // 而它会让汇总金额凭空多出两个数量级。
    contractFen: { type: 'integer', minimum: 0, maximum: 10_000_000_000 },
    receivedFen: { type: 'integer', minimum: 0, maximum: 10_000_000_000 },
    unpaidFen: { type: 'integer', minimum: 0, maximum: 10_000_000_000 },
  },
} as const

const UPDATE_STEP_BODY_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    reached: { type: 'boolean' },
    done: { type: 'boolean' },
    startedAt: { type: ['string', 'null'], maxLength: 32 },
    finishedAt: { type: ['string', 'null'], maxLength: 32 },
    dateImprecise: { type: 'boolean' },
    note: { type: 'string', maxLength: CUSTOMER_LIMITS.NOTE_MAX },
  },
} as const

const SET_STAGE_BODY_SCHEMA = {
  type: 'object',
  required: ['stage'],
  additionalProperties: false,
  properties: {
    stage: { type: 'string', enum: [...CUSTOMER_STAGES] },
    reason: { type: 'string', maxLength: CUSTOMER_LIMITS.NOTE_MAX },
  },
} as const

/**
 * 调整归属。至少给一项，`null` 表示清空那一栏。
 *
 * **不接受「两个都清空」之外的隐式批量语义**：只传 `designerId: null` 时销售不动。
 * 一次操作只动一个人，是归属变更能被审计解释清楚的前提。
 */
const ASSIGN_BODY_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: {
    designerId: { type: ['string', 'null'], maxLength: 64 },
    salesId: { type: ['string', 'null'], maxLength: 64 },
    reason: { type: 'string', maxLength: CUSTOMER_LIMITS.NOTE_MAX },
  },
} as const

const POOL_CLASSIFY_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // 上限 500：全库 58 位客户，留足余量但不允许一次传一万个 id 把批处理拖死。
    customerIds: {
      type: 'array',
      maxItems: 500,
      items: { type: 'string', minLength: 1, maxLength: 64 },
    },
    force: { type: 'boolean' },
  },
} as const

const POOL_REVIEW_BODY_SCHEMA = {
  type: 'object',
  required: ['decision'],
  additionalProperties: false,
  properties: {
    decision: { type: 'string', enum: ['accepted', 'adjusted', 'rejected'] },
    role: { type: 'string', enum: [...CUSTOMER_ROLES] },
    userId: { type: ['string', 'null'], maxLength: 64 },
    note: { type: 'string', maxLength: CUSTOMER_LIMITS.NOTE_MAX },
  },
} as const

const SUGGESTION_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id', 'suggestionId'],
  additionalProperties: false,
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 64 },
    suggestionId: { type: 'string', minLength: 1, maxLength: 64 },
  },
} as const

export function registerCustomerRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ListQuery }>(
    '/api/customers',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_RECORD_READ),
      schema: { querystring: LIST_QUERY_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const from = parseLocalInstant(request.query.from)
      const to = parseLocalInstant(request.query.to)
      if (from === 'invalid' || to === 'invalid') {
        return reply.code(400).send({
          error: 'invalid_range',
          message: '时间范围格式不正确，应形如 2026-10-30 或 2026-10-30T14:00',
        })
      }
      // 起点晚于终点时直接拒掉。放过去的结果是一份空列表，而空列表同时表示
      // 「这段时间确实没有客户」，两种含义在界面上分不开。
      if (from !== null && to !== null && from.getTime() >= to.getTime()) {
        return reply.code(400).send({
          error: 'invalid_range',
          message: '时间范围的起点必须早于终点',
        })
      }

      const body: CustomerListResponse = await listCustomers({
        viewer,
        region: request.query.region,
        scope: request.query.scope,
        stage: request.query.stage,
        pendingReview: request.query.review === 'pending',
        q: request.query.q,
        from: from ?? undefined,
        to: to ?? undefined,
        mode: request.query.mode === 'summary' ? 'summary' : 'list',
        limit: request.query.limit,
      })
      return reply.code(200).send(body)
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/customers/:id',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_RECORD_READ),
      schema: { params: ID_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const result = await getCustomer(request.params.id, viewer)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CustomerDetailResponse = { customer: result.data }
      return reply.code(200).send(body)
    },
  )

  app.post<{ Body: CreateCustomerInput }>(
    '/api/customers',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_RECORD_WRITE),
      schema: { body: CREATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const result = await createCustomer(request.body, viewer)
      if (!result.ok) return sendFailure(reply, result.reason)

      // 201 与 200 的区别在这里是有意义的：这是唯一一条「库里多了一行」的接口。
      // 前端据此刷新列表，不用再猜自己刚才是新建还是改了已有的。
      const body: CustomerDetailResponse = { customer: result.data }
      return reply.code(201).send(body)
    },
  )

  app.patch<{ Params: { id: string }; Body: UpdateCustomerInput }>(
    '/api/customers/:id',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_RECORD_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: UPDATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const result = await updateCustomer(request.params.id, request.body, viewer)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CustomerDetailResponse = { customer: result.data }
      return reply.code(200).send(body)
    },
  )

  /**
   * 新建订单。
   *
   * 挂在 `customer.order.write` 而不是 `customer.record.write`：建单是推进业务，
   * 改档案是维护资料。两个动作的责任人经常不是同一个 —— 设计师维护客户信息，
   * 而排产建单是另一个岗位。
   */
  app.post<{ Params: { id: string }; Body: CreateOrderInput }>(
    '/api/customers/:id/orders',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_ORDER_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: CREATE_ORDER_BODY_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const result = await createOrder(request.params.id, request.body, viewer)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CustomerDetailResponse = { customer: result.data }
      return reply.code(201).send(body)
    },
  )

  /**
   * 更新一个环节。
   *
   * 用 PATCH 而不是 PUT：界面上的动作是「勾一下这一环完成」或「填上日期」，
   * 局部更新更贴近实际。PUT 要求提交整环的十项字段，任何一项漏传都会被当成清空。
   */
  app.patch<{ Params: { id: string; orderId: string; idx: number }; Body: UpdateStepInput }>(
    '/api/customers/:id/orders/:orderId/steps/:idx',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_ORDER_WRITE),
      schema: { params: STEP_PARAMS_SCHEMA, body: UPDATE_STEP_BODY_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const result = await updateStep(
        request.params.id,
        request.params.orderId,
        request.params.idx,
        request.body,
        viewer,
      )
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CustomerDetailResponse = { customer: result.data }
      return reply.code(200).send(body)
    },
  )

  app.put<{ Params: { id: string }; Body: SetStageInput }>(
    '/api/customers/:id/stage',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_ORDER_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: SET_STAGE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const result = await setStage(
        request.params.id,
        { stage: request.body.stage as CustomerStage, reason: request.body.reason },
        viewer,
      )
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CustomerDetailResponse = { customer: result.data }
      return reply.code(200).send(body)
    },
  )

  // -------------------------------------------------------------------------
  // 归属与公共池
  // -------------------------------------------------------------------------

  /**
   * 调整负责的设计师与销售。
   *
   * 用 PATCH 而不是 POST：它改的是客户行上的两列，语义是局部更新。`null` 表示清空
   * 那一栏，「两栏都 null」等于退回公共池 —— 这是唯一一种需要显式写两个 null 的用法。
   *
   * 只有 `customer.scope.write` 能调。**这是整条链上唯一能把越权合法化的入口**：
   * 把别人的客户划到自己名下之后，后续一切读写都合规。因此设计师与销售即便
   * 篡改请求体也进不来（守卫拦在处理器之前）。
   */
  app.patch<{ Params: { id: string }; Body: AssignCustomerRequest }>(
    '/api/customers/:id/assignment',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_SCOPE_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: ASSIGN_BODY_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const result = await assignCustomer(request.params.id, request.body, viewer)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CustomerDetailResponse = { customer: result.data }
      return reply.code(200).send(body)
    },
  )

  /**
   * 可指派的账号。复核页与详情页的归属下拉共用。
   *
   * 需要 `customer.scope.write`：能看这份名单的人一定有指派权，而反过来不成立 ——
   * 只读账号知道「公司有哪几位设计师」本身不是敏感信息，但这份接口的用途只有指派，
   * 给它配一个更宽的口径没有收益。
   */
  app.get(
    '/api/customers/assignable-users',
    { preHandler: requirePermission(PERMISSIONS.CUSTOMER_SCOPE_WRITE) },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const body: AssignableUsersResponse = await listAssignableUsers()
      return reply.code(200).send(body)
    },
  )

  /**
   * 公共池列表。
   *
   * 需要 `customer.scope.read`：公共池的定义就是「不属于任何人」，按本人范围过滤
   * 之后它恒为空集。给设计师看一个永远是空的队列没有意义，反而会让人以为功能坏了。
   */
  app.get(
    '/api/customers/pool',
    { preHandler: requirePermission(PERMISSIONS.CUSTOMER_SCOPE_READ) },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const body: PoolListResponse = await listPool(viewer)
      return reply.code(200).send(body)
    },
  )

  /**
   * 跑一次归类。
   *
   * 聊天库目录取 `FANHE_CHAT_DIR`。**API 容器里没有挂 D 盘**，所以在容器内触发时
   * 读不到原文，响应里的 `source` 会是 `stored` —— 置信度封顶 45。这是刻意暴露的
   * 信号，不是静默降级：复核人看到「没有读到群文件」就知道该用宿主机上的
   * `pnpm db:pool-classify` 补一次。
   */
  app.post<{ Body: ClassifyPoolRequest }>(
    '/api/customers/pool/classify',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_IMPORT_REVIEW),
      schema: { body: POOL_CLASSIFY_BODY_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const body: ClassifyPoolResponse = await classifyPool({
        viewer,
        customerIds: request.body.customerIds,
        force: request.body.force,
      })
      return reply.code(200).send(body)
    },
  )

  /**
   * 复核一条归类结果。
   *
   * **两个权限点都要**（`import.review` 与 `scope.write`）。复核的三种出口里有两种
   * 会落成归属，只给复核权而不给转派权的账号，点了「接受」也无法生效；而只给它
   * 转派权又不该看到机器判定依据。用两个 preHandler 而不是在处理器里手写判断：
   * 手写的那种一旦漏在某个分支上，表现是「按钮点了没反应」，日志里什么都没有。
   */
  app.post<{ Params: { id: string; suggestionId: string }; Body: ReviewPoolSuggestionRequest }>(
    '/api/customers/:id/pool-suggestions/:suggestionId/review',
    {
      preHandler: [
        requirePermission(PERMISSIONS.CUSTOMER_IMPORT_REVIEW),
        requirePermission(PERMISSIONS.CUSTOMER_SCOPE_WRITE),
      ],
      schema: { params: SUGGESTION_PARAMS_SCHEMA, body: POOL_REVIEW_BODY_SCHEMA },
    },
    async (request, reply) => {
      const viewer = requireViewer(request, reply)
      if (viewer === null) return reply

      const result = await reviewPoolSuggestion(
        request.params.id,
        request.params.suggestionId,
        request.body,
        viewer,
      )
      if (!result.ok) return sendFailure(reply, result.reason)

      return reply.code(200).send(result.data)
    },
  )
}
