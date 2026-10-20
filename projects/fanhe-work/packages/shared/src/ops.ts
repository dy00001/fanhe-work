/**
 * 运营数据（千牛 / 生意参谋）的跨进程契约。
 *
 * 这个文件回答三类问题，不回答「页面长什么样」：
 *
 *   1. **数据长什么样。** 采集器交上来的东西（`OpsIngestRequest`）与看板能拿到的
 *      东西（`OpsDashboardResponse`）各有哪些字段、单位是什么。
 *   2. **哪些量能相加。** `OpsMetricSource` 把指标压成三档，这是本模块最容易被
 *      写错的地方 —— 把「30 天整段的跳失率」当成逐日值去重算区间，界面看起来
 *      一切正常，数字却是错的。档位写进契约，前端必须按档位给徽标。
 *   3. **日期怎么算。** 区间与上一个等长区间的推导放在这里，API 与前端共用同一份，
 *      否则「环比」在不同页面会按不同边界切分。
 *
 * 不放在 web 或 api 内部：两侧都要用，各写一份必然漂。也不把 Prisma 类型引进来：
 * 一旦引入，web 的构建会被拖上数据库依赖（`packages/shared` 的既有约束）。
 */

/**
 * 上限。三条都有实际理由，不是防御性编程的摆设。
 *
 * - `RANGE_MAX_DAYS`：无上限的区间查询在数据攒够一年后会把 API 拖垮，而界面上的
 *   时间条最远只提供「近 90 天」与自定义，366 天足够覆盖同比。
 * - `DIMENSION_TOP`：商品 / 关键词 / 地域都是长尾分布，取前 100 已经能看到结构，
 *   前端也没有滚一万行的场景。
 * - `DAILY_MAX_ROWS`：逐日序列一天一行，一年 366 行。超过说明上报方把粒度搞错了。
 */
export const OPS_LIMITS = {
  RANGE_MAX_DAYS: 366,
  DEFAULT_RANGE_DAYS: 30,
  RANGE_OPTIONS: [7, 14, 30, 90] as const,
  DIMENSION_TOP: 100,
  DAILY_MAX_ROWS: 400,
  SHOP_CODE_MAX: 40,
  SHOP_NAME_MAX: 120,
  DIMENSION_KEY_MAX: 120,
  DIMENSION_LABEL_MAX: 300,
  RAW_PATH_MAX: 300,
  INGEST_DIMENSION_MAX: 2000,
  TRIGGER_MAX: 20,
} as const

/**
 * 维度类型。
 *
 * `summary` 与前五个不是一类：前五个是「一行一个对象」（一个商品、一个渠道），
 * `summary` 是「一行一个指标」（客单价、跳失率）。分成一档是为了让「整段口径」
 * 有一个明确的落位点 —— 它们无法逐日拆开，也就不该混进逐日表。
 */
export const OPS_DIMENSION_TYPES = [
  'item',
  'channel',
  'area',
  'keyword',
  'content',
  'summary',
] as const

export type OpsDimensionType = (typeof OPS_DIMENSION_TYPES)[number]

/** 采集来源。报表导出与接口直取的口径偶尔不同，对账时靠这一列区分。 */
export const OPS_COLLECT_SOURCES = ['report', 'api'] as const
export type OpsCollectSource = (typeof OPS_COLLECT_SOURCES)[number]

/** 采集批次的触发方式。`backfill` 指历史回填，与日常计划任务分开记。 */
export const OPS_COLLECT_TRIGGERS = ['schedule', 'manual', 'backfill'] as const
export type OpsCollectTrigger = (typeof OPS_COLLECT_TRIGGERS)[number]

export const OPS_COLLECT_STATUSES = ['running', 'succeeded', 'partial', 'failed'] as const
export type OpsCollectStatus = (typeof OPS_COLLECT_STATUSES)[number]

/** 店铺平台。当前只有淘宝系，字段保留是为了加店时不改事实表。 */
export const OPS_PLATFORMS = ['taobao', 'tmall'] as const
export type OpsPlatform = (typeof OPS_PLATFORMS)[number]

/** 指标单位。展示层据此决定加哪种前缀与小数位，组件里不判断。 */
export const OPS_METRIC_UNITS = ['fen', 'count', 'percent', 'minute'] as const
export type OpsMetricUnit = (typeof OPS_METRIC_UNITS)[number]

/**
 * 指标口径，三档。
 *
 * - `daily`：逐日真值，区间内可以相加（支付金额、访客、买家、商品访客）。
 * - `derived`：由逐日真值算出来的比率（支付转化率、客单价）。它随区间重算，
 *   但**不能跨维度相加**。
 * - `period`：只有整段值，没有逐日序列（跳失率、停留时长、加购人数、渠道结构、
 *   商品排行）。它带着自己的窗口，换成别的区间它不会变，界面必须显式说明。
 *
 * 第四档「演示」不在契约里：演示数据不该从接口流出来，它只存在于原型页面。
 */
export const OPS_METRIC_SOURCES = ['daily', 'derived', 'period'] as const
export type OpsMetricSource = (typeof OPS_METRIC_SOURCES)[number]

/** 店铺的对外投影。不暴露内部主键以外的任何服务端状态。 */
export type OpsShopSummary = {
  id: string
  code: string
  name: string
  platform: OpsPlatform
  sellerNick: string | null
  timezone: string
  /**
   * 最近一次成功采集完成的时刻（ISO 字符串）。
   *
   * 放在店铺投影里而不是只放 `flags` 里：多店接入后切换店铺时，界面需要同时看到
   * 「这家店的数据新不新」，否则会拿上一家店的徽标显示在新店旁边。null 表示还没
   * 成功采过 —— 与「很久没采」是两件事，前者该引导去配置采集器。
   */
  lastCollectedAt: string | null
}

/** 业务日区间，闭区间。两端都是 `YYYY-MM-DD`，不带时区。 */
export type OpsDateRange = {
  from: string
  to: string
}

/**
 * 指标卡。
 *
 * `value` 为 `null` 有两种含义，靠 `masked` 区分：**没权限看不到**，还是**这段时间
 * 确实没有数据**。混成一个 `null` 会让使用者把「看不到」读成「没成交」，这是数字
 * 类界面里最伤信任的一类歧义。
 */
export type OpsKpi = {
  key: string
  label: string
  value: number | null
  unit: OpsMetricUnit
  previous: number | null
  deltaPct: number | null
  source: OpsMetricSource
  masked: boolean
  /** 口径说明，直接展示在卡片副标题。不写就没有副标题。 */
  hint: string | null
}

/** 逐日序列。缺失的一天用 `null`，不补 0。 */
export type OpsDailyPoint = {
  date: string
  payAmountFen: number | null
  visitors: number | null
  payBuyers: number | null
  itemVisitors: number | null
}

/**
 * 维度行。`metrics` 用松散的键值而不是为每种维度建一个类型：这些字段来自平台
 * 接口，改名的频率高于业务的频率，写死类型只会让每次字段调整都要改三处。
 * 取用时一律按 `metricNumber()` 读，读不到就当作缺失，不猜 0。
 */
export type OpsDimensionRow = {
  key: string
  label: string
  metrics: Record<string, number | string | null>
}

/**
 * 一组维度。`window` 是这组数据自己的统计窗口 —— 与查询区间不一定相同。
 * 两者不同时界面必须显式提示，否则「切了区间但数字没动」会被当成缺陷。
 */
export type OpsDimensionGroup = {
  type: OpsDimensionType
  window: OpsDateRange | null
  rows: readonly OpsDimensionRow[]
}

export type OpsFlags = {
  lastCollectedAt: string | null
  lastRunStatus: OpsCollectStatus | null
  /** 本次响应里因为权限被裁掉的字段名。前端据此渲染「无权限」而不是空白。 */
  masked: readonly string[]
  /** 实际有数的天数。0 表示这段时间一行数据都没有，界面该走空态。 */
  dailyDays: number
  /** 逐日表覆盖的窗口，可能与查询区间不同（数据只到某一天）。 */
  covered: OpsDateRange | null
}

export type OpsDashboardResponse = {
  shop: OpsShopSummary
  range: OpsDateRange
  days: number
  previous: OpsDateRange | null
  kpi: readonly OpsKpi[]
  series: readonly OpsDailyPoint[]
  dimensions: {
    items: OpsDimensionGroup
    channels: OpsDimensionGroup
    areas: OpsDimensionGroup
    keywords: OpsDimensionGroup
    content: OpsDimensionGroup
    summary: OpsDimensionGroup
  }
  flags: OpsFlags
}

/** 采集批次的可读投影。健康面板与排查都读它。 */
export type OpsCollectRunSummary = {
  id: string
  trigger: string
  source: OpsCollectSource
  status: OpsCollectStatus
  window: OpsDateRange
  dailyRows: number
  dimensionRows: number
  rawPath: string | null
  errorMessage: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

export type OpsHealthResponse = {
  shop: OpsShopSummary | null
  lastCollectedAt: string | null
  runs: readonly OpsCollectRunSummary[]
}

/**
 * 上报契约（ops-ingest.v1）。
 *
 * `daily` 与 `dimensions` 分开两段，而不是揉成一个扁平数组：这两段的可加性不同，
 * 混在一起后接收方必须靠 `type` 逐行判断能不能聚合，判断一次写错就会把整段值
 * 累加进区间。
 */
export type OpsIngestDaily = {
  date: string
  payAmountFen: number | null
  visitors: number | null
  payBuyers: number | null
  itemVisitors: number | null
}

export type OpsIngestDimension = {
  type: OpsDimensionType
  key: string
  label: string
  metrics: Record<string, number | string | null>
}

export type OpsIngestRequest = {
  contractVersion: 1
  shop: {
    code: string
    name: string
    platform: OpsPlatform
    sellerNick: string | null
  }
  window: OpsDateRange
  source: OpsCollectSource
  trigger: OpsCollectTrigger
  rawPath: string | null
  daily: readonly OpsIngestDaily[]
  dimensions: readonly OpsIngestDimension[]
}

export type OpsIngestResponse = {
  shopId: string
  range: OpsDateRange
  dailyWritten: number
  dimensionsWritten: number
  /** 与库里已有值不同、被覆盖的天数。平台回溯改数时这里会大于 0。 */
  revisedDays: number
  runId: string
}

// ---------------------------------------------------------------------------
// 日期运算
// ---------------------------------------------------------------------------

/**
 * 业务日一律按 UTC 正午解析，再按 UTC 取年月日。
 *
 * 为什么要绕这一圈：`new Date('2026-10-01')` 按 UTC 零点解析，若再用本地时区的
 * `getDate()` 读回来，东八区会拿到 10 月 1 日 08:00（没问题），而西半球会拿到
 * 9 月 30 日 —— 一类只在月初月末暴露的错位。固定 UTC 后两端行为一致，也不受
 * 服务器时区影响。
 */
const MS_PER_DAY = 86_400_000

export function parseOpsDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number) as [number, number, number]
  const ms = Date.UTC(year, month - 1, day, 12, 0, 0, 0)
  const date = new Date(ms)
  // 挡掉 2026-02-31 这类「格式合法但日子不存在」的输入：Date.UTC 会把它滚到下个月，
  // 滚过的结果与原字符串对不上，据此判定非法。
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return date
}

export function formatOpsDate(date: Date): string {
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, '0')
  const day = String(date.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function addOpsDays(value: string, days: number): string {
  const date = parseOpsDate(value)
  if (date === null) return value
  return formatOpsDate(new Date(date.getTime() + days * MS_PER_DAY))
}

/**
 * 闭区间的天数。`2026-10-01 ~ 2026-10-01` 是 1 天，不是 0 天。
 *
 * 这个「加一」是区间统计里最常见的差一天来源：用它算日均、算上一区间、
 * 算环比基线，错一次全盘偏。
 */
export function opsRangeDays(range: OpsDateRange): number {
  const from = parseOpsDate(range.from)
  const to = parseOpsDate(range.to)
  if (from === null || to === null) return 0
  const days = Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1
  // 顺序颠倒时返回 0 而不是负数。负数会一路传下去：`opsRangeEndingAt` 会把它
  // 当成 1 天、`previousOpsRange` 会推出一个未来的区间，而调用方多半只判 `<= 0`
  // 拦不住 —— 到最后表现为「环比基线在未来」这种没人会去猜的现象。
  return days > 0 ? days : 0
}

export function isValidOpsRange(range: OpsDateRange): boolean {
  const days = opsRangeDays(range)
  return days > 0 && days <= OPS_LIMITS.RANGE_MAX_DAYS
}

/**
 * 上一个等长区间。取 A 之前**紧邻**的等长区间，不是 A 的前半段。
 *
 * 这个错误做过一次：早期版本拿 A 的前半段当基线，于是「环比」比的是本期内部，
 * 数字看上去总是接近 1。等长、紧邻、不重叠，三条都要成立。
 */
export function previousOpsRange(range: OpsDateRange): OpsDateRange | null {
  const days = opsRangeDays(range)
  if (days <= 0) return null
  const to = addOpsDays(range.from, -1)
  const from = addOpsDays(to, -(days - 1))
  return { from, to }
}

/** 从「截止日 + 天数」推区间。默认区间（近 30 天）与时间条都用它。 */
export function opsRangeEndingAt(to: string, days: number): OpsDateRange {
  const span = Math.max(1, Math.trunc(days))
  return { from: addOpsDays(to, -(span - 1)), to }
}

/** 区间夹在合法范围内。自定义区间越界时用它收口，不做静默失败。 */
export function clampOpsRange(range: OpsDateRange): OpsDateRange {
  const days = opsRangeDays(range)
  if (days <= 0) return range
  if (days <= OPS_LIMITS.RANGE_MAX_DAYS) return range
  return { from: addOpsDays(range.to, -(OPS_LIMITS.RANGE_MAX_DAYS - 1)), to: range.to }
}
