import {
  CUSTOMER_LIMITS,
  CUSTOMER_STAGES,
  PERMISSIONS,
  hasPermission,
  type CustomerDetailResponse,
  type CustomerListResponse,
  type CustomerStage,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import {
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
import { requirePermission } from '../auth/guard.js'

/**
 * 客户信息平台的接口。
 *
 * 权限分四层，对应 `permissions.ts` 里客户段的五个点：
 *
 *   - 进页面与读档案 → `customer.record.read`
 *   - 改档案        → `customer.record.write`
 *   - 看金额        → `customer.finance.read`（**字段级**，与上面两条正交）
 *   - 推进订单环节   → `customer.order.write`
 *
 * **金额为什么是字段级的。** 这是本模块唯一的非做不可的设计：客户姓名、电话、
 * 微信昵称在设计岗是日常需要，而合同额与回款是经营机密。合成一个权限点时，
 * 结果必然是所有人都能看到金额 —— 没人会为了看客户名字去开一道审批。因此
 * 每条返回客户的接口都做一次裁剪，判据统一走 `hasFinanceRead`。
 *
 * `customer.import.review` 这一轮还没有对应接口：复核是把导入预览整批放行的动作，
 * 要等导入脚本跑通、预览页做出来才落地。权限点先存在，是为了让账号授权表在那天
 * 不用再改一次。
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
}

const FAILURE_MESSAGE: Record<CustomerFailureReason, string> = {
  not_found: '客户或订单不存在',
  invalid_name: `姓名不能为空，且不超过 ${CUSTOMER_LIMITS.REAL_NAME_MAX} 字`,
  invalid_region: `地区不能为空，且不超过 ${CUSTOMER_LIMITS.REGION_MAX} 字`,
  invalid_phone: `电话不超过 ${CUSTOMER_LIMITS.PHONE_MAX} 位`,
  invalid_stage: '阶段或日期不合法',
  invalid_amount: '金额必须是非负整数，单位为分',
  missing_reason: '回退到更早的阶段必须填写原因',
  duplicate_chatroom: '这个微信群已经绑定过客户',
  duplicate_code: '订单编号重复',
}

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

function sendFailure(reply: FastifyReply, reason: CustomerFailureReason): FastifyReply {
  return reply
    .code(FAILURE_STATUS[reason])
    .send({ error: reason, message: FAILURE_MESSAGE[reason] })
}

/**
 * 当前账号能不能看金额。
 *
 * **只认权限点，不认角色。** 写 `roleCode === 'owner'` 那种判断会在「给某个成员
 * 单独授予金额点」时失效，而那种授予正是本模块设计的目的。
 *
 * 未认证时返回 false：走不到这条路径（守卫已经拦在前面），但默认值取「看不到」
 * 而不是「看得到」—— 判空的方向决定了一旦守卫出问题，是漏出金额还是漏出空白。
 */
function hasFinanceRead(request: FastifyRequest): boolean {
  const context = request.authContext
  if (context === null) return false
  return hasPermission(context.permissions, PERMISSIONS.CUSTOMER_FINANCE_READ)
}

function authorized(request: FastifyRequest): boolean {
  return request.authContext !== null
}

/**
 * 列表查询参数。
 *
 * `review` 与运营看板的 `archived` 同理，只能声明成字符串枚举：查询串里读到的
 * 永远是字符串，写 `type: 'boolean'` 会让 `?review=pending` 被 AJV 拒绝。
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
    limit: { type: 'integer', minimum: 1, maximum: CUSTOMER_LIMITS.PAGE_MAX },
  },
} as const

type ListQuery = {
  region?: string
  scope?: string
  stage?: string
  review?: string
  q?: string
  limit?: number
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

export function registerCustomerRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ListQuery }>(
    '/api/customers',
    {
      preHandler: requirePermission(PERMISSIONS.CUSTOMER_RECORD_READ),
      schema: { querystring: LIST_QUERY_SCHEMA },
    },
    async (request, reply) => {
      if (!authorized(request)) return reply.code(401).send(UNAUTHORIZED_BODY)

      const body: CustomerListResponse = await listCustomers(
        {
          region: request.query.region,
          scope: request.query.scope,
          stage: request.query.stage,
          pendingReview: request.query.review === 'pending',
          q: request.query.q,
          limit: request.query.limit,
        },
        hasFinanceRead(request),
      )
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
      if (!authorized(request)) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await getCustomer(request.params.id, hasFinanceRead(request))
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
      if (!authorized(request)) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await createCustomer(request.body)
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
      if (!authorized(request)) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await updateCustomer(request.params.id, request.body, hasFinanceRead(request))
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
      if (!authorized(request)) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await createOrder(request.params.id, request.body, hasFinanceRead(request))
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
      if (!authorized(request)) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await updateStep(
        request.params.id,
        request.params.orderId,
        request.params.idx,
        request.body,
        hasFinanceRead(request),
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
      if (!authorized(request)) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await setStage(
        request.params.id,
        { stage: request.body.stage as CustomerStage, reason: request.body.reason },
        hasFinanceRead(request),
      )
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CustomerDetailResponse = { customer: result.data }
      return reply.code(200).send(body)
    },
  )
}
