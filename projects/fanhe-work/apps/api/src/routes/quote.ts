import {
  PERMISSIONS,
  QUOTE_LIMITS,
  QUOTE_SOURCES,
  QUOTE_ITEM_STATUSES,
  type QuoteItemStatus,
  type QuoteSource,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requireAuth, requirePermission } from '../auth/guard.js'
import {
  getAccessState,
  resolveWriteAccess,
  setAccessSecret,
  unlockWithPassword,
  type QuoteAccessFailure,
} from '../quote/access.js'
import {
  getItem,
  getLedgerStats,
  getMeta,
  listRevisions,
  readImage,
  removeItemImage,
  saveItemImage,
  searchItems,
  setItemStatus,
  updateItemPrice,
  type QuoteFailureReason,
} from '../quote/store.js'

/**
 * 报价查价的接口。
 *
 * ## 两组鉴权，刻意不同
 *
 * - **读**（meta / search / 详情 / 取图）挂 `personal.quote.read`。查价是销售与设计
 *   的日常动作，1225 条台账本来就是给大家查的。
 * - **写**（改价 / 停用 / 换图 / 设口令）**不挂权限点**。owner 直入，其他人必须
 *   在 `x-quote-unlock` 里带一个有效的解锁令牌。判据与理由写在
 *   `quote/access.ts` 顶部 —— 一句话：`personal.*` 通配会把任何 write 点静默地
 *   发给全部业务角色，那时口令就是摆设。
 *
 * ## 图片走 base64 JSON，不引 multipart
 *
 * 与案例库上传同一条链路（`POST /api/cases/uploads`）：`bodyLimit` 单条放开到
 * 8MB，其他路由仍是默认的 1MB。引一个 multipart 解析器要处理边界串、临时文件、
 * 分片超时，而这里每次只传一张图。
 *
 * ## 取图接口的缓存要带版本
 *
 * 案例图用 `immutable` 是安全的（id 每次新生成）；这里的 `imageKey` 是**复用的**
 * —— 同一条目换一张图，URL 还是那个。所以缓存策略是 `max-age` 一天加一个
 * `?v=<版本>` 的缓存键，而不是 `immutable`。写成 `immutable` 的后果是「换了图，
 * 客户那边看到的还是旧图」，而且刷新也没用。
 */

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

/** 写权限失败的状态码。`no_secret` 用 409：请求没错，是还没设过口令。 */
const ACCESS_STATUS: Record<QuoteAccessFailure, number> = {
  not_authenticated: 401,
  forbidden: 403,
  no_secret: 409,
  secret_exists: 409,
  invalid_password: 401,
  invalid_password_shape: 400,
  locked: 429,
}

const ACCESS_MESSAGE: Record<QuoteAccessFailure, string> = {
  not_authenticated: '请先登录',
  forbidden: '需要维护权限：请输入维护口令，或使用超级管理员账号',
  no_secret: '还没有设置维护口令，请先由超级管理员设置',
  secret_exists: '已经设置过维护口令，如需更换请使用「修改口令」',
  invalid_password: '口令不正确',
  invalid_password_shape: `口令长度需在 ${QUOTE_LIMITS.PASSWORD_MIN}–${QUOTE_LIMITS.PASSWORD_MAX} 位之间`,
  locked: `口令已锁定，请 ${QUOTE_LIMITS.UNLOCK_LOCK_MINUTES} 分钟后再试`,
}

const ITEM_STATUS: Record<QuoteFailureReason, number> = {
  not_found: 404,
  invalid_price: 400,
  invalid_reason: 400,
  invalid_image: 400,
  invalid_status: 409,
}

const ITEM_MESSAGE: Record<QuoteFailureReason, string> = {
  not_found: '找不到这条报价',
  invalid_price: '价格不合法：请填写数字、金额，或「1.5 倍」这类原文',
  invalid_reason: `说明不能超过 ${QUOTE_LIMITS.REASON_MAX} 字`,
  invalid_image: '图片格式不支持，或超出了体积 / 尺寸上限',
  invalid_status: '状态没有变化',
}

function currentAuth(request: FastifyRequest) {
  return request.authContext
}

/** 响应体里带上锁定时间与剩余次数，前端据此显示倒计时，不必自己算。 */
function sendAccessFailure(
  reply: FastifyReply,
  reason: QuoteAccessFailure,
  extra: { lockedUntil?: Date; failCount?: number } = {},
): FastifyReply {
  return reply.code(ACCESS_STATUS[reason]).send({
    error: reason,
    message: ACCESS_MESSAGE[reason],
    ...(extra.lockedUntil === undefined ? {} : { lockedUntil: extra.lockedUntil.toISOString() }),
    ...(extra.failCount === undefined ? {} : { failCount: extra.failCount }),
  })
}

function sendItemFailure(reply: FastifyReply, reason: QuoteFailureReason): FastifyReply {
  return reply.code(ITEM_STATUS[reason]).send({ error: reason, message: ITEM_MESSAGE[reason] })
}

/**
 * 解锁令牌从请求头取。
 *
 * 用自定义头而不是 query 参数：`?token=` 会进访问日志、Referer 与浏览器历史，
 * 而这是一个能改价的凭据。与案例库拒绝把图片令牌放进 URL 是同一条判断。
 */
function readUnlockToken(request: FastifyRequest): string | null {
  const raw = request.headers['x-quote-unlock']
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw[0] ?? null
  return null
}

const CODE_PATTERN = '^[A-Za-z0-9_-]{1,64}$'

const CODE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: { type: 'string', minLength: 1, maxLength: 64, pattern: CODE_PATTERN } },
} as const

/**
 * 取图路由的路径参数。
 *
 * **必须单独写一份。** 取图的路径段叫 `:key`（图可能挂在条目自己的 code 上，也可能
 * 挂在产品族的键上，两者都不是「条目 code」），而上面那份要求 `code` 且
 * `additionalProperties: false` —— 套在 `{ key }` 上时请求会因为「缺少 code」被判
 * 400，即**所有图都取不到**，而响应看起来只是「图片接口不工作」。这一条是集成测试
 * 里「取图 200」那一条抓出来的，纯看代码看不出来：两处都叫 `:key`/`:code` 之外的
 * 东西都长得一样。
 */
const IMAGE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['key'],
  additionalProperties: false,
  properties: { key: { type: 'string', minLength: 1, maxLength: 64, pattern: CODE_PATTERN } },
} as const

const SEARCH_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: QUOTE_LIMITS.QUERY_MAX },
    source: { type: 'string', enum: [...QUOTE_SOURCES] },
    category: { type: 'string', maxLength: 80 },
    limit: { type: 'integer', minimum: 1, maximum: QUOTE_LIMITS.PAGE_SIZE_MAX },
    offset: { type: 'integer', minimum: 0, maximum: 100_000 },
    includeArchived: { type: 'boolean' },
  },
} as const

const UNLOCK_BODY_SCHEMA = {
  type: 'object',
  required: ['password'],
  additionalProperties: false,
  // 下限给 1 而不是 PASSWORD_MIN：这里校验的是「用户输进来的那一串」，不是策略。
  // 说「长度不对」会把口令长度泄露给正在试的人。
  properties: { password: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.PASSWORD_MAX } },
} as const

const SET_SECRET_BODY_SCHEMA = {
  type: 'object',
  required: ['password'],
  additionalProperties: false,
  properties: {
    password: {
      type: 'string',
      minLength: QUOTE_LIMITS.PASSWORD_MIN,
      maxLength: QUOTE_LIMITS.PASSWORD_MAX,
    },
  },
} as const

const UPDATE_ITEM_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    priceFen: { type: ['integer', 'null'], minimum: 0, maximum: 100_000_000 },
    priceText: { type: 'string', maxLength: 200 },
    reason: { type: 'string', maxLength: QUOTE_LIMITS.REASON_MAX },
  },
} as const

const SET_STATUS_BODY_SCHEMA = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: [...QUOTE_ITEM_STATUSES] },
    reason: { type: 'string', maxLength: QUOTE_LIMITS.REASON_MAX },
  },
} as const

/**
 * 上传体。`data` / `thumb` 是纯 base64（不带 `data:` 前缀）。
 *
 * **没有 `mime` / 缩略图尺寸这两栏。** 类型由服务端读魔数判断，缩略图尺寸按 320
 * 长边自己算 —— 客户端能声明的字段越少，能填错的地方就越少。形状与案例库上传的
 * `CreateCaseUploadItem` 逐字相同，前端复用同一个压缩器。
 *
 * `maxLength` 比 `IMAGE_BYTES_MAX` 大 4/3 再留一点余量：base64 的膨胀是固定的，
 * 而这里只是挡住明显过大的串，真正的字节数校验在 service 层按解码后的长度做。
 */
const UPLOAD_BODY_SCHEMA = {
  type: 'object',
  required: ['data', 'width', 'height', 'thumb'],
  additionalProperties: false,
  properties: {
    data: {
      type: 'string',
      minLength: 1,
      maxLength: Math.ceil(QUOTE_LIMITS.IMAGE_BYTES_MAX * 1.4),
    },
    thumb: {
      type: 'string',
      minLength: 1,
      maxLength: Math.ceil(QUOTE_LIMITS.IMAGE_BYTES_MAX * 1.4),
    },
    width: { type: 'integer', minimum: 1, maximum: QUOTE_LIMITS.IMAGE_EDGE_MAX },
    height: { type: 'integer', minimum: 1, maximum: QUOTE_LIMITS.IMAGE_EDGE_MAX },
  },
} as const

const IMAGE_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'string', maxLength: 16 },
    variant: { type: 'string', enum: ['thumb', 'full'] },
  },
} as const

export function registerQuoteRoutes(app: FastifyInstance): void {
  const readGuard = [requireAuth, requirePermission(PERMISSIONS.PERSONAL_QUOTE_READ)]

  /** 数据集版本、分类清单、有没有设过口令。一次拿全，界面挂载时只发这一个请求。 */
  app.get('/api/quote/meta', { preHandler: readGuard }, async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return getMeta()
  })

  app.get<{
    Querystring: {
      q?: string
      source?: QuoteSource
      category?: string
      limit?: number
      offset?: number
      includeArchived?: boolean
    }
  }>(
    '/api/quote/search',
    { preHandler: readGuard, schema: { querystring: SEARCH_QUERY_SCHEMA } },
    async (request, reply) => {
      // 价格随时可能变，缓存一次就等于给旧价。`no-store` 是这条接口的默认，
      // 与「宁可空白不给旧价」同一个判断。
      reply.header('cache-control', 'no-store')
      const query = request.query
      return searchItems({
        q: query.q ?? '',
        source: query.source ?? null,
        category: query.category ?? null,
        includeArchived: query.includeArchived === true,
        limit: Math.min(query.limit ?? QUOTE_LIMITS.PAGE_SIZE_DEFAULT, QUOTE_LIMITS.PAGE_SIZE_MAX),
        offset: query.offset ?? 0,
      })
    },
  )

  app.get<{ Params: { code: string } }>(
    '/api/quote/items/:code',
    { preHandler: readGuard, schema: { params: CODE_PARAMS_SCHEMA } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const result = await getItem(request.params.code)
      if (result === null) {
        return reply.code(404).send({ error: 'not_found', message: '找不到这条报价' })
      }
      return result
    },
  )

  /**
   * 台账现状：绑定档位分布、图文件数、孤儿图数。
   *
   * 与 `meta` 分开是因为两者节奏不同：`meta` 每次挂载都要（版本号决定缓存能不能用），
   * 这组数字只有打开维护面板时才看，而它要扫三遍全表。塞进 `meta` 等于让每次查价
   * 都付一次全表统计的代价。
   */
  app.get('/api/quote/stats', { preHandler: readGuard }, async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return getLedgerStats()
  })

  /**
   * 变更记录。挂读权限而不是写权限 —— 审计的意义是「谁都能看改过什么」，
   * 只有能改的人能看，等于把审计变成了内部台账。
   */
  app.get<{ Querystring: { limit?: number } }>(
    '/api/quote/revisions',
    {
      preHandler: readGuard,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return listRevisions(request.query.limit ?? 20)
    },
  )
  /**
   * 取图。
   *
   * 要登录、要读权限，**不要解锁令牌**：图是商品图，不是价格。把它也锁在口令后面，
   * 结果是销售查价时看不到任何产品图 —— 而查价正是这张图唯一的用途。
   */
  app.get<{ Params: { key: string }; Querystring: { v?: string; variant?: 'thumb' | 'full' } }>(
    '/api/quote/images/:key',
    {
      preHandler: readGuard,
      schema: { params: IMAGE_PARAMS_SCHEMA, querystring: IMAGE_QUERY_SCHEMA },
    },
    async (request, reply) => {
      const variant = request.query.variant === 'full' ? 'full' : 'thumb'
      const image = await readImage(request.params.key, variant)
      if (image === null) {
        return reply.code(404).send({ error: 'not_found', message: '图片不存在' })
      }
      reply.header('content-type', image.mime)
      reply.header('content-length', String(image.bytes.length))
      // 不带 `immutable`，理由见文件头：同一个 key 的字节会被替换。
      reply.header('cache-control', 'private, max-age=86400')
      reply.header('etag', `"${image.version}-${variant}"`)
      return reply.send(image.bytes)
    },
  )

  app.get('/api/quote/access-state', { preHandler: requireAuth }, async (request, reply) => {
    const auth = currentAuth(request)
    if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)
    reply.header('cache-control', 'no-store')
    return getAccessState(auth)
  })

  app.post<{ Body: { password: string } }>(
    '/api/quote/unlock',
    { preHandler: requireAuth, schema: { body: UNLOCK_BODY_SCHEMA } },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await unlockWithPassword(auth, request.body.password, request.ip ?? null)
      if (!result.ok) {
        return sendAccessFailure(reply, result.reason, {
          ...(result.lockedUntil === undefined ? {} : { lockedUntil: result.lockedUntil }),
          ...(result.failCount === undefined ? {} : { failCount: result.failCount }),
        })
      }
      reply.header('cache-control', 'no-store')
      return {
        unlockToken: result.value.unlockToken,
        expiresAt: result.value.expiresAt.toISOString(),
      }
    },
  )

  /** 首次设置口令。仅 owner —— 判据在 service 层，那里是唯一强制的一层。 */
  app.post<{ Body: { password: string } }>(
    '/api/quote/access-secret',
    { preHandler: requireAuth, schema: { body: SET_SECRET_BODY_SCHEMA } },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      const result = await setAccessSecret(auth, request.body.password, 'create')
      if (!result.ok) return sendAccessFailure(reply, result.reason)
      return { ok: true, version: result.value.version }
    },
  )

  /** 轮换口令。版本 +1，其他设备上已开的解锁立刻失效。 */
  app.put<{ Body: { password: string } }>(
    '/api/quote/access-secret',
    { preHandler: requireAuth, schema: { body: SET_SECRET_BODY_SCHEMA } },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      const result = await setAccessSecret(auth, request.body.password, 'rotate')
      if (!result.ok) return sendAccessFailure(reply, result.reason)
      return { ok: true, version: result.value.version }
    },
  )

  app.patch<{
    Params: { code: string }
    Body: { priceFen?: number | null; priceText?: string; reason?: string }
  }>(
    '/api/quote/items/:code',
    {
      preHandler: requireAuth,
      schema: { params: CODE_PARAMS_SCHEMA, body: UPDATE_ITEM_BODY_SCHEMA },
    },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const access = await resolveWriteAccess(auth, readUnlockToken(request))
      if (!access.ok) return sendAccessFailure(reply, access.reason)

      const result = await updateItemPrice(
        request.params.code,
        {
          ...(request.body.priceFen === undefined ? {} : { priceFen: request.body.priceFen }),
          ...(request.body.priceText === undefined ? {} : { priceText: request.body.priceText }),
          ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
        },
        { userId: auth.userId, access: access.value },
      )
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  app.post<{ Params: { code: string }; Body: { status: QuoteItemStatus; reason?: string } }>(
    '/api/quote/items/:code/status',
    {
      preHandler: requireAuth,
      schema: { params: CODE_PARAMS_SCHEMA, body: SET_STATUS_BODY_SCHEMA },
    },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const access = await resolveWriteAccess(auth, readUnlockToken(request))
      if (!access.ok) return sendAccessFailure(reply, access.reason)

      const result = await setItemStatus(
        request.params.code,
        request.body.status,
        request.body.reason ?? '',
        { userId: auth.userId, access: access.value },
      )
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  app.post<{ Params: { code: string }; Body: Parameters<typeof saveItemImage>[1] }>(
    '/api/quote/items/:code/image',
    {
      preHandler: requireAuth,
      schema: { params: CODE_PARAMS_SCHEMA, body: UPLOAD_BODY_SCHEMA },
      // 默认 1MB 装不下一张压好的原图（1600px webp 约 300KB，但也常有 2MB 的
      // 手机直出图）。这条路由单独放开，其他路由仍是默认值。
      bodyLimit: 8 * 1024 * 1024,
    },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const access = await resolveWriteAccess(auth, readUnlockToken(request))
      if (!access.ok) return sendAccessFailure(reply, access.reason)

      const result = await saveItemImage(request.params.code, request.body, {
        userId: auth.userId,
        access: access.value,
      })
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  app.delete<{ Params: { code: string } }>(
    '/api/quote/items/:code/image',
    { preHandler: requireAuth, schema: { params: CODE_PARAMS_SCHEMA } },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const access = await resolveWriteAccess(auth, readUnlockToken(request))
      if (!access.ok) return sendAccessFailure(reply, access.reason)

      const result = await removeItemImage(request.params.code, {
        userId: auth.userId,
        access: access.value,
      })
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )
}
