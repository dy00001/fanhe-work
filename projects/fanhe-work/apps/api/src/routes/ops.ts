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
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requirePermission } from '../auth/guard.js'
import { env } from '../config/env.js'
import { isLoopbackAddress } from '../launch/loopback.js'
import { ingestFailureMessage, ingestOpsSnapshot } from '../ops/ingest.js'
import {
  latestCoveredDate,
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
 * 三个分支的失败都必须给出**可读的原因**，因为自定义区间是用户在地址栏里手输的：
 * 静默回退到默认区间，用户会以为自己输错了却没被提示。
 */
async function resolveRange(
  query: DashboardQuery,
): Promise<{ ok: true; value: OpsDateRange } | { ok: false; message: string }> {
  if (query.from === undefined && query.to === undefined) {
    const anchor = (await latestCoveredDate()) ?? new Date().toISOString().slice(0, 10)
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
      const range = await resolveRange(request.query)
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
      return reply.code(200).send(body)
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
      return reply.code(200).send(body)
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
      const range = await resolveRange(request.query)
      if (!range.ok) {
        return reply.code(400).send({ error: 'invalid_range', message: range.message })
      }
      const board = await loadOpsShopBoards({
        range: range.value,
        viewer: { permissions: request.authContext.permissions },
      })
      return reply.code(200).send(board)
    },
  )

  app.get(
    '/api/ops/shops',
    { preHandler: requirePermission(PERMISSIONS.OPS_SHOP_READ) },
    async (_request, reply) => {
      return reply.code(200).send({ shops: await listOpsShops() })
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
}
