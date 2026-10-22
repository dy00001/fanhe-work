import { createHash, timingSafeEqual } from 'node:crypto'

import {
  OPS_DIMENSION_TYPES,
  OPS_LIMITS,
  opsRangeDays,
  PERMISSIONS,
  clampOpsRange,
  isValidOpsRange,
  opsRangeEndingAt,
  parseOpsDate,
  type OpsDashboardResponse,
  type OpsDateRange,
  type OpsHealthResponse,
  type OpsIngestRequest,
  type OpsIngestResponse,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requirePermission } from '../auth/guard.js'
import { env } from '../config/env.js'
import { isLoopbackAddress } from '../launch/loopback.js'
import { ingestFailureMessage, ingestOpsSnapshot } from '../ops/ingest.js'
import { readCollectorStatus, touchCollectorHeartbeat } from '../ops/collector-heartbeat.js'
import {
  bindShop,
  listPendingShopCodes,
  reportShopState,
  requestShopSync,
  unbindShop,
  updateShop,
} from '../ops/shop-binding.js'
import {
  latestCoveredDate,
  latestCoveredDateAllShops,
  listOpsShops,
  loadOpsDashboard,
  loadOpsHealth,
  loadOpsShopBoards,
} from '../ops/query.js'

/**
 * 运营数据看板的接口。
 *
 * 读接口走登录态 + `ops.shop.read`，写接口走回环 + 共享密钥。两条路径**不共用**
 * 鉴权方式，各有各的理由：
 *
 *   - 读接口面对的是人，人没有「共享密钥」这种东西，判断依据只能是会话与权限点。
 *   - 写接口面对的是计划任务，任务没有会话。强行让它模拟登录，等于在磁盘上放一份
 *     长期口令，而且那份口令会随用户改密码失效 —— 采集会在某个没人注意的夜里
 *     静默停止。
 *
 * 金额裁剪发生在 `ops/query.ts`，不在这一层。路由只做参数校验与权限门槛，因为
 * 「哪些字段算金额」是业务判断，散在路由里就会有两处定义。
 */

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

/**
 * 带 ETag 的 JSON 响应。
 *
 * 为什么值得做：这三个接口的数据一天变一次，而界面在切标签页、切区间、点重试时会
 * 反复取同一份内容。没有 ETag 时每次都是完整响应体；有了之后内容没变就是 304、
 * 零字节。这不是为了省流量，是为了让「切回来就静默重取」这个动作变得没有代价 ——
 * 否则每次切标签页都要拉一遍几十 KB 的榜单，弱网下还会把界面拖成加载态。
 *
 * `max-age=0, must-revalidate` 是刻意选的，不是 `max-age=60`：后者在 60 秒内直接
 * 吃本地缓存，会让「刚采完数据、刷新页面」看到旧数。每次回源验证、内容没变就 304，
 * 既保住即时性，又省掉重复传输。
 *
 * `private` 必须有：响应里是带登录态、且经过权限裁剪的金额，任何中间缓存都不该留存。
 *
 * ETag 用弱校验（`W/`）：同一个对象序列化出来的字节可能因为键序不同而不同，但语义
 * 一致，这里要的正是语义比较。
 */
function sendJsonWithEtag<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: T,
): FastifyReply {
  const body = JSON.stringify(payload)
  const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`
  reply.header('etag', etag)
  reply.header('cache-control', 'private, max-age=0, must-revalidate')

  const header = request.headers['if-none-match']
  if (typeof header === 'string') {
    const candidates = header.split(',').map((value) => value.trim())
    if (candidates.includes(etag) || candidates.includes('*')) {
      // 304 不带响应体。浏览器会沿用本地那份，界面的数据与请求前完全一致。
      return reply.code(304).send()
    }
  }
  return reply.code(200).type('application/json; charset=utf-8').send(body)
}

/** 日期参数的形状校验。合法性（2 月 31 日这类）交给 `parseOpsDate`。 */
const DATE_PATTERN = '^\\d{4}-\\d{2}-\\d{2}$'

const DASHBOARD_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    from: { type: 'string', pattern: DATE_PATTERN },
    to: { type: 'string', pattern: DATE_PATTERN },
    days: { type: 'integer', minimum: 1, maximum: OPS_LIMITS.RANGE_MAX_DAYS },
    shop: { type: 'string', minLength: 1, maxLength: OPS_LIMITS.SHOP_CODE_MAX },
  },
} as const

const HEALTH_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    shop: { type: 'string', minLength: 1, maxLength: OPS_LIMITS.SHOP_CODE_MAX },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
} as const

/**
 * 上报体。**逐条声明到最细一层**，不做 `additionalProperties: true`。
 *
 * 理由与 `app.ts` 里关掉 `removeAdditional` 同源：多带一个字段就被静默丢弃，
 * 上报方会以为它生效了。契约变了就该报错，而不是在三个月后有人发现「某个指标
 * 一直没入库」。
 */
/**
 * 可空的联合类型一律写成 `anyOf`，不写 `type: ['number', 'null']`。
 *
 * ajv 的 strictTypes 会把「一个 type 关键字带多个取值」判为歧义，Fastify 每次注册
 * 路由都会打一条 warning。warning 不影响行为，但「每次启动都刷一行」会让真正的
 * 告警被淹掉 —— 这也是服务端 schema 一直保持零 warning 的原因。
 */
const NULLABLE_INT = { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] } as const
const NULLABLE_SHORT_STRING = {
  anyOf: [{ type: 'string', maxLength: 80 }, { type: 'null' }],
} as const
const NULLABLE_PATH = {
  anyOf: [{ type: 'string', maxLength: OPS_LIMITS.RAW_PATH_MAX }, { type: 'null' }],
} as const

const METRICS_SCHEMA = {
  type: 'object',
  additionalProperties: { anyOf: [{ type: 'number' }, { type: 'string' }, { type: 'null' }] },
} as const

const INGEST_BODY_SCHEMA = {
  type: 'object',
  required: ['contractVersion', 'shop', 'window', 'source', 'trigger', 'daily', 'dimensions'],
  additionalProperties: false,
  properties: {
    contractVersion: { type: 'integer', enum: [1] },
    shop: {
      type: 'object',
      required: ['code', 'name', 'platform'],
      additionalProperties: false,
      properties: {
        code: { type: 'string', minLength: 1, maxLength: OPS_LIMITS.SHOP_CODE_MAX },
        name: { type: 'string', minLength: 1, maxLength: OPS_LIMITS.SHOP_NAME_MAX },
        platform: { type: 'string', enum: ['taobao', 'tmall'] },
        sellerNick: NULLABLE_SHORT_STRING,
      },
    },
    window: {
      type: 'object',
      required: ['from', 'to'],
      additionalProperties: false,
      properties: {
        from: { type: 'string', pattern: DATE_PATTERN },
        to: { type: 'string', pattern: DATE_PATTERN },
      },
    },
    source: { type: 'string', enum: ['report', 'api'] },
    trigger: { type: 'string', enum: ['schedule', 'manual', 'backfill'] },
    rawPath: NULLABLE_PATH,
    daily: {
      type: 'array',
      maxItems: OPS_LIMITS.DAILY_MAX_ROWS,
      items: {
        type: 'object',
        required: ['date'],
        additionalProperties: false,
        properties: {
          date: { type: 'string', pattern: DATE_PATTERN },
          payAmountFen: NULLABLE_INT,
          visitors: NULLABLE_INT,
          payBuyers: NULLABLE_INT,
          itemVisitors: NULLABLE_INT,
        },
      },
    },
    dimensions: {
      type: 'array',
      maxItems: OPS_LIMITS.INGEST_DIMENSION_MAX,
      items: {
        type: 'object',
        required: ['type', 'key', 'label', 'metrics'],
        additionalProperties: false,
        properties: {
          type: { type: 'string', enum: [...OPS_DIMENSION_TYPES] },
          key: { type: 'string', minLength: 1, maxLength: OPS_LIMITS.DIMENSION_KEY_MAX },
          label: { type: 'string', minLength: 1, maxLength: OPS_LIMITS.DIMENSION_LABEL_MAX },
          metrics: METRICS_SCHEMA,
        },
      },
    },
  },
} as const

/**
 * 定长摘要后再比较。
 *
 * `timingSafeEqual` 要求两个 Buffer 等长，而用户提交的 token 长度是任意的 ——
 * 直接比较会抛 `RangeError`，那个异常会变成 500，反而把「长度不对」这个信息
 * 暴露出去。先各自 sha256 再比，长度恒定，且比较耗时不随前缀匹配长度变化。
 */
function safeTokenEquals(expected: string, received: string): boolean {
  const a = createHash('sha256').update(expected, 'utf8').digest()
  const b = createHash('sha256').update(received, 'utf8').digest()
  return timingSafeEqual(a, b)
}

/**
 * 采集入口的两道门。返回 null 表示通过。
 *
 * 顺序是有意的：**先判 token，再判来源**。来源校验在桌面壳反代之后会全部落在
 * 回环上，此时它提供的安全性接近于零，真正的门是 token。把弱的放在前面，会让
 * 「没有 token 也能试探」这种错误印象成立。
 */
function checkIngestAccess(request: FastifyRequest): { status: number; body: object } | null {
  const expected = env.ops.ingestToken
  if (expected === null) {
    return {
      status: 503,
      body: {
        error: 'ingest_disabled',
        message: '未配置 OPS_INGEST_TOKEN，采集入口未启用。在部署环境中设置该变量后重启 API。',
      },
    }
  }

  const header = request.headers['x-ops-token']
  const received = Array.isArray(header) ? header[0] : header
  if (typeof received !== 'string' || received === '' || !safeTokenEquals(expected, received)) {
    return { status: 401, body: { error: 'invalid_token', message: '采集密钥不正确' } }
  }

  if (!isLoopbackAddress(request.ip)) {
    return {
      status: 403,
      body: { error: 'forbidden_origin', message: '采集入口只接受本机回环请求' },
    }
  }

  return null
}

type DashboardQuery = { from?: string; to?: string; days?: number; shop?: string }
type HealthQuery = { shop?: string; limit?: number }

/**
 * 解析区间。
 *
 * 三种入参形态，优先级从高到低：
 *
 *   1. `from` + `to`：自定义区间，原样使用（超过上限时收口）。
 *   2. `days`：近 N 天。**以库里最新一天为锚**，不以今天为锚 —— 见
 *      `latestCoveredDate` 的注释，锚点错了会让 KPI 与维度窗口错位。
 *   3. 都不给：近 30 天，同样以库里最新一天为锚。
 *
 * 锚点由调用方以函数形式传入，而不是在这一层自己算。原因是**不同接口该用哪个锚点
 * 并不相同**：单店看板要跟着它自己看的那家店，五店并列要取全库最大。若在这里写死
 * 一种口径，另一个接口就必然是错的，而且错得很安静（区间照样返回、接口照样 200，
 * 只是窗口悄悄偏了几天）。
 *
 * 传函数还有一个附带好处：自定义区间那条分支根本不会调用它，省掉一次聚合查询。
 *
 * 三个分支的失败都必须给出**可读的原因**，因为自定义区间是用户在地址栏里手输的：
 * 静默回退到默认区间，用户会以为自己输错了却没被提示。
 */
async function resolveRange(
  query: DashboardQuery,
  anchorOf: () => Promise<string | null>,
): Promise<{ ok: true; value: OpsDateRange } | { ok: false; message: string }> {
  if (query.from === undefined && query.to === undefined) {
    const anchor = (await anchorOf()) ?? new Date().toISOString().slice(0, 10)
    const days = query.days ?? OPS_LIMITS.DEFAULT_RANGE_DAYS
    return { ok: true, value: opsRangeEndingAt(anchor, days) }
  }
  if (query.from === undefined || query.to === undefined) {
    return { ok: false, message: '自定义区间需要同时给出 from 与 to' }
  }
  if (parseOpsDate(query.from) === null || parseOpsDate(query.to) === null) {
    return { ok: false, message: `区间不是合法日期：${query.from} ~ ${query.to}` }
  }
  const range = { from: query.from, to: query.to }
  // 起止颠倒必须显式拒绝，不能靠 clamp 兜底：clamp 只处理「跨度太长」，
  // 对倒置区间是空操作，于是它会带着一个非法区间一路查下去，返回一屏
  // 「全为空但成功」的结果。那种响应看起来像「这段时间没数据」，
  // 实际是参数写反了，两者要区分开。
  if (opsRangeDays(range) === 0) {
    return { ok: false, message: `起止顺序不对：${query.from} 晚于 ${query.to}` }
  }
  if (!isValidOpsRange(range)) {
    // 超过上限时收口而不是报错：用户点「近 90 天」和手输一年区间，意图是一样的
    // （想看尽量长的一段），拒绝只会让他反复改数字。
    return { ok: true, value: clampOpsRange(range) }
  }
  return { ok: true, value: range }
}

export function registerOpsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: DashboardQuery }>(
    '/api/ops/dashboard',
    {
      preHandler: requirePermission(PERMISSIONS.OPS_SHOP_READ),
      schema: { querystring: DASHBOARD_QUERY_SCHEMA },
    },
    async (request, reply) => {
      if (request.authContext === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      /* 锚点跟着「这次要看的那家店」走，与下面 loadOpsDashboard 的选店规则同源。 */
      const range = await resolveRange(request.query, () =>
        latestCoveredDate(request.query.shop ?? null),
      )
      if (!range.ok) {
        return reply.code(400).send({ error: 'invalid_range', message: range.message })
      }

      const dashboard = await loadOpsDashboard({
        shopCode: request.query.shop ?? null,
        range: range.value,
        viewer: { permissions: request.authContext.permissions },
      })
      if (dashboard === null) {
        return reply.code(404).send({ error: 'shop_not_found', message: '还没有配置任何店铺' })
      }
      const body: OpsDashboardResponse = dashboard
      return sendJsonWithEtag(request, reply, body)
    },
  )

  app.get<{ Querystring: HealthQuery }>(
    '/api/ops/health',
    {
      preHandler: requirePermission(PERMISSIONS.OPS_COLLECT_READ),
      schema: { querystring: HEALTH_QUERY_SCHEMA },
    },
    async (request, reply) => {
      if (request.authContext === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      const health = await loadOpsHealth(request.query.shop ?? null, request.query.limit ?? 20)
      if (health === null) {
        return reply.code(404).send({ error: 'shop_not_found', message: '还没有配置任何店铺' })
      }
      const body: OpsHealthResponse = health
      return sendJsonWithEtag(request, reply, body)
    },
  )

  /**
   * 五店并列指标带。数据大屏首屏一次取全，避免「五家店五次往返」。
   *
   * 没有数据的店铺也返回（`hasData: false`），由界面渲染「待接入」占位卡 ——
   * 布局固定五列是交互约定，后端不替界面决定「这家店该不该出现」。
   */
  app.get<{ Querystring: DashboardQuery }>(
    '/api/ops/overview-shops',
    {
      preHandler: requirePermission(PERMISSIONS.OPS_SHOP_READ),
      schema: { querystring: DASHBOARD_QUERY_SCHEMA },
    },
    async (request, reply) => {
      if (request.authContext === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      /* 五店同屏比较，锚点取全库最大；这里不认 `shop` 参数，因为它比较的就是全部店铺。 */
      const range = await resolveRange(request.query, latestCoveredDateAllShops)
      if (!range.ok) {
        return reply.code(400).send({ error: 'invalid_range', message: range.message })
      }
      const board = await loadOpsShopBoards({
        range: range.value,
        viewer: { permissions: request.authContext.permissions },
      })
      return sendJsonWithEtag(request, reply, board)
    },
  )

  /**
   * 店铺列表 + 采集器状态。
   *
   * 采集器状态放在同一个响应里而不是单开一条接口：界面拿到店铺列表就要顺带回答
   * 「点了立即同步有没有人接单」，分两次请求只会让这两件事有机会不一致。
   */
  app.get(
    '/api/ops/shops',
    { preHandler: requirePermission(PERMISSIONS.OPS_SHOP_READ) },
    async (_request, reply) => {
      const [shops, collector] = await Promise.all([listOpsShops(), readCollectorStatus()])
      return reply.code(200).send({ shops, collector })
    },
  )

  /**
   * 采集写入。
   *
   * 不挂 `requirePermission`：这条接口的调用方是计划任务。鉴权在 `checkIngestAccess`
   * 里完成，两道门（token、回环）都在那里。
   *
   * 返回值里带 `runId`，采集器把它写进自己的日志，排查时可以用它在库里定位到
   * 具体那一批 —— 光看时间戳对不上「哪次重试写了什么」。
   */
  app.post<{ Body: OpsIngestRequest }>(
    '/api/ops/ingest',
    { schema: { body: INGEST_BODY_SCHEMA } },
    async (request, reply) => {
      const denied = checkIngestAccess(request)
      if (denied !== null) return reply.code(denied.status).send(denied.body)

      const result = await ingestOpsSnapshot(request.body)
      if (!result.ok) {
        request.log.warn({ reason: result.reason, detail: result.detail }, '运营数据上报被拒绝')
        return reply.code(400).send({
          error: result.reason,
          message: `${ingestFailureMessage(result.reason)}：${result.detail}`,
        })
      }

      const body: OpsIngestResponse = result.data
      return reply.code(201).send(body)
    },
  )

  // -------------------------------------------------------------------------
  // 店铺绑定
  //
  // 读接口（`GET /api/ops/shops`）在上面，权限是 `ops.shop.read`。
  // 下面这几条都要求 `ops.shop.bind`：改采集配置与看数是两件事。
  // -------------------------------------------------------------------------

  /** 失败原因到状态码的映射。集中一处，避免每个 handler 各写一套。 */
  const mutationStatus: Record<string, number> = {
    invalid: 400,
    duplicate: 409,
    port_conflict: 409,
    not_found: 404,
    not_bound: 409,
  }

  app.post<{ Body: unknown }>(
    '/api/ops/shops',
    { preHandler: requirePermission(PERMISSIONS.OPS_SHOP_BIND) },
    async (request, reply) => {
      if (request.authContext === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      const result = await bindShop(request.body)
      if (!result.ok) {
        return reply
          .code(mutationStatus[result.reason] ?? 400)
          .send({ error: result.reason, message: result.message })
      }
      return reply.code(201).send({ shop: result.shop, slot: result.slot })
    },
  )

  app.patch<{ Params: { code: string }; Body: unknown }>(
    '/api/ops/shops/:code',
    { preHandler: requirePermission(PERMISSIONS.OPS_SHOP_BIND) },
    async (request, reply) => {
      if (request.authContext === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      const result = await updateShop(request.params.code, request.body)
      if (!result.ok) {
        return reply
          .code(mutationStatus[result.reason] ?? 400)
          .send({ error: result.reason, message: result.message })
      }
      return reply.code(200).send({ shop: result.shop, slot: result.slot })
    },
  )

  app.delete<{ Params: { code: string } }>(
    '/api/ops/shops/:code',
    { preHandler: requirePermission(PERMISSIONS.OPS_SHOP_BIND) },
    async (request, reply) => {
      if (request.authContext === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      const result = await unbindShop(request.params.code)
      if (!result.ok) {
        return reply
          .code(mutationStatus[result.reason] ?? 400)
          .send({ error: result.reason, message: result.message })
      }
      return reply.code(200).send({ shop: result.shop, slot: result.slot })
    },
  )

  /**
   * 请求立即同步。只置一个时间戳，采集器下一轮轮询会看到它。
   *
   * 不做成同步等待：一轮采集几十秒起，HTTP 等待会把「慢」与「失败」混在一起，
   * 而这两件事在界面上要给完全不同的提示。
   */
  app.post<{ Params: { code: string } }>(
    '/api/ops/shops/:code/sync',
    { preHandler: requirePermission(PERMISSIONS.OPS_SHOP_BIND) },
    async (request, reply) => {
      if (request.authContext === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      const result = await requestShopSync(request.params.code)
      if (!result.ok) {
        return reply
          .code(mutationStatus[result.reason] ?? 400)
          .send({ error: result.reason, message: result.message })
      }
      return reply.code(202).send({ shop: result.shop })
    },
  )

  /**
   * 采集器拉取待同步店铺。
   *
   * 鉴权与 ingest 同一套（token + 回环）：这两条接口的调用方都是本机的采集进程，
   * 不属于任何登录用户。走 `requirePermission` 反而无解 —— 计划任务没有会话。
   */
  app.get<{ Querystring: { limit?: number } }>('/api/ops/shops/pending', async (request, reply) => {
    const denied = checkIngestAccess(request)
    if (denied !== null) return reply.code(denied.status).send(denied.body)
    /* 「有人来拉待办」就是心跳，不需要另开一条心跳接口。写失败不影响主流程。 */
    await touchCollectorHeartbeat('http')
    const limit = Number(request.query.limit ?? 5)
    const codes = await listPendingShopCodes(Number.isFinite(limit) ? limit : 5)
    return reply.code(200).send({ codes })
  })

  /** 采集器回写登录态与失败原因。语义见 `reportShopState` 的注释。 */
  app.post<{ Params: { code: string }; Body: unknown }>(
    '/api/ops/shops/:code/state',
    async (request, reply) => {
      const denied = checkIngestAccess(request)
      if (denied !== null) return reply.code(denied.status).send(denied.body)
      const body = {
        ...(typeof request.body === 'object' && request.body !== null ? request.body : {}),
        code: request.params.code,
      }
      const result = await reportShopState(body)
      if (!result.ok) {
        return reply
          .code(mutationStatus[result.reason] ?? 400)
          .send({ error: result.reason, message: result.message })
      }
      return reply.code(200).send({ shop: result.shop })
    },
  )
}
