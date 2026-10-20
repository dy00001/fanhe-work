import {
  OPS_LIMITS,
  addOpsDays,
  hasPermission,
  opsRangeDays,
  previousOpsRange,
  type OpsCollectRunSummary,
  type OpsCollectStatus,
  type OpsDashboardResponse,
  type OpsDateRange,
  type OpsDimensionGroup,
  type OpsDimensionRow,
  type OpsDimensionType,
  type OpsHealthResponse,
  type OpsKpi,
  type OpsMetricSource,
  type OpsShopBoard,
  type OpsShopBoardsResponse,
  type OpsShopSummary,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import type { PermissionCode } from '@fanhe/shared'
import { fromDbDate, pickSnapshotIndex, toDbDate } from './date.js'

/**
 * 看板的读模型。
 *
 * 分三层，**顺序不能颠倒**：
 *
 *   1. 取数（SQL）—— 只按店铺与时间范围取，不做任何聚合。
 *   2. 口径（本文件的纯函数）—— 求和、算比率、算环比、标档位。
 *   3. 裁剪（`applyFinanceMask`）—— 按权限抹掉金额。
 *
 * 裁剪放在最后一步是有意的：先算完再抹，才能保证「无权限时看到的非金额指标」
 * 与「有权限时看到的」完全一致。若先裁剪再算，靠金额派生的转化率会被连带算错，
 * 而那种错只会表现为「两个账号看到的转化率不一样」，很难归因。
 *
 * 聚合放在应用层而不是 SQL：单店 366 天最多 366 行，逐日表的规模决定了不必上
 * 窗口函数。放应用层的收益是「空值与 0 的区别」能逐行判断（SQL 的 SUM 会把
 * 全 null 的列算成 null，但把「有 null 有值」的列算成值之和，接口拿不到
 * 「有几天没采到」这个信息）。
 */

/** 权限为空的调用方（例如内部脚本）看到的是完整数据。 */
export type OpsViewer = {
  permissions: readonly PermissionCode[]
}

const FINANCE_PERMISSION: PermissionCode = 'ops.finance.read'

/** JSON 里的数值读取。字符串数字也认，`null` / 缺失 / 非数字一律返回 null。 */
function metricNumber(metrics: Record<string, unknown>, key: string): number | null {
  const raw = metrics[key]
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * 环比。**返回比例，不返回百分点**：0.701 表示 +70.1%，展示层统一乘 100。
 *
 * 基数为 0 时返回 null 而不是 0 或 Infinity。0 → 100 的「涨幅」在数学上是无穷，
 * 在业务上通常意味着「上期没开张」，画成 +∞% 或 +100% 都会误导。界面拿到 null
 * 显示「不可比」，那才是实话。
 */
function deltaRatio(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null
  if (previous === 0) return current === 0 ? 0 : null
  return (current - previous) / previous
}

type SumResult = { sum: number | null; days: number }

/** 逐日表里可相加的四个字段。写成联合类型而不是常量数组：数组只在这里当类型用，
 * 留一个运行期没人读的常量会让 `no-unused-vars` 报错，而它本来就不是配置。 */
type DailyField = 'payAmountFen' | 'visitors' | 'payBuyers' | 'itemVisitors'

type DailyRow = {
  date: string
  payAmountFen: number | null
  visitors: number | null
  payBuyers: number | null
  itemVisitors: number | null
}

/** 求和：只累加非空值，同时给出「有几天有值」。全空时 sum 为 null，不返回 0。 */
function sumField(rows: readonly DailyRow[], field: DailyField): SumResult {
  let sum = 0
  let days = 0
  for (const row of rows) {
    const value = row[field]
    if (value === null) continue
    sum += value
    days += 1
  }
  return days === 0 ? { sum: null, days: 0 } : { sum, days }
}

/** 由两个计数派生比率。分母为 0 或缺失时返回 null。 */
function ratioOf(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null
  return numerator / denominator
}

/**
 * KPI 构造器。
 *
 * 环比**由调用方给**，不在这里现算。原因：整段口径下环比取自平台的 `cycleCrc`
 * （它比的是上个一等长周期，而库里可能压根没有上个月的数据），逐日口径下才是
 * 自己算的。两种来源混进一个默认值里，读数就会在「切区间」时悄悄换掉含义。
 */
function kpi(entry: {
  key: string
  label: string
  unit: OpsKpi['unit']
  value: number | null
  previous: number | null
  deltaPct: number | null
  source: OpsMetricSource
  hint: string | null
}): OpsKpi {
  return { ...entry, masked: false }
}

const KPI_LABELS: Record<string, string> = {
  payAmount: '支付金额',
  payBuyers: '支付买家',
  visitors: '访客数',
  itemVisitors: '商品访客',
  payRate: '支付转化率',
  orderValue: '客单价',
}

/** 金额类 KPI。无 `ops.finance.read` 时整块抹平。 */
const FINANCE_KPI_KEYS = new Set(['payAmount', 'orderValue'])

/**
 * 按权限抹掉金额。
 *
 * 抹法与「0」严格区分：`value` 置 null 且 `masked` 置 true，前端据此渲染「无权限」
 * 而不是「0」。这是本模块唯一一处权限会影响返回值形状的地方，也是唯一一处 ——
 * 别的字段一律原样返回，避免前端要为每个字段猜一种空值含义。
 */
function applyFinanceMask(kpiList: OpsKpi[], masked: Set<string>): OpsKpi[] {
  return kpiList.map((item) => {
    if (!FINANCE_KPI_KEYS.has(item.key)) return item
    masked.add(item.key)
    return { ...item, value: null, previous: null, deltaPct: null, masked: true }
  })
}

function maskDimensionRows(
  rows: readonly OpsDimensionRow[],
  masked: Set<string>,
): OpsDimensionRow[] {
  return rows.map((row) => {
    const metrics: Record<string, number | string | null> = {}
    for (const [key, value] of Object.entries(row.metrics)) {
      if (key.endsWith('Fen')) {
        masked.add(key)
        // 金额字段不留 null 占位：留着会让前端必须逐个字段判断「是没数还是没权限」，
        // 删掉之后前端统一按「字段不存在」处理，与「这个维度本来就没这个指标」同构。
        continue
      }
      metrics[key] = value
    }
    return { ...row, metrics }
  })
}

function sortDimensionRows(type: OpsDimensionType, rows: OpsDimensionRow[]): OpsDimensionRow[] {
  const byNumberDesc = (key: string) => (a: OpsDimensionRow, b: OpsDimensionRow) =>
    (metricNumber(b.metrics, key) ?? -1) - (metricNumber(a.metrics, key) ?? -1)

  const sorted = [...rows]
  switch (type) {
    case 'item':
      // 商品按支付金额排。无金额权限时金额字段已被抹掉，退化为按访客排，
      // 否则所有行都取到 -1，顺序变成数据库返回顺序 —— 那是一种「看起来有排序」
      // 的假象。
      sorted.sort(byNumberDesc('payAmountFen'))
      if (sorted.every((row) => metricNumber(row.metrics, 'payAmountFen') === null)) {
        sorted.sort(byNumberDesc('visitors'))
      }
      return sorted
    case 'channel':
    case 'area':
    case 'keyword':
    case 'content':
      sorted.sort(byNumberDesc('visitors'))
      return sorted
    case 'summary':
      // summary 一行一个指标，顺序无意义，保持上报顺序便于人工核对。
      return sorted
  }
}

async function loadShop(shopCode: string | null): Promise<OpsShopSummary | null> {
  const row = await prisma.ecomShop.findFirst({
    where: shopCode === null ? { enabled: true } : { code: shopCode },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      platform: true,
      sellerNick: true,
      timezone: true,
      lastCollectedAt: true,
    },
  })
  if (row === null) return null
  return {
    ...row,
    lastCollectedAt: row.lastCollectedAt === null ? null : row.lastCollectedAt.toISOString(),
  }
}

/**
 * 取某一维度类型的快照。
 *
 * **选哪一份窗口**：取 `statTo <= 查询末日` 里最新的那一份，而不是「全库最新」。
 * 差别在补采时体现 —— 补采一次 9 月的历史数据后，「全库最新」仍然是当前窗口，
 * 但若先按 statTo 倒序取第一条而不加条件，补采的历史窗口会被选中，看板会退回
 * 一个月前，而页面上没有任何提示。
 *
 * 找不到任何快照时返回 `window: null` 的空组，由界面渲染空态。
 */
async function loadDimensionGroup(
  shopId: string,
  type: OpsDimensionType,
  range: OpsDateRange,
  masked: Set<string>,
  /** 是否允许带出金额字段。**必须显式传**：漏传会让所有人看不到金额。 */
  allowFinance: boolean,
): Promise<OpsDimensionGroup> {
  const floor = addOpsDays(range.to, -OPS_LIMITS.RANGE_MAX_DAYS)
  const floorDate = toDbDate(floor)
  const toDate = toDbDate(range.to)

  const candidates = await prisma.ecomDimensionSnapshot.findMany({
    where: {
      shopId,
      dimType: type,
      ...(toDate === null ? {} : { statTo: { lte: toDate } }),
      ...(floorDate === null ? {} : { statFrom: { gte: floorDate } }),
    },
    orderBy: [{ statTo: 'desc' }, { statFrom: 'desc' }],
    select: { statFrom: true, statTo: true, dimKey: true, dimLabel: true, metrics: true },
  })

  /*
   * 按「与查询区间最贴合」挑快照，不按最新挑。
   *
   * 日增采集上线后，同一维度会同时存在一份 30 天快照和此后每天一份的单日快照。
   * 只看 `statTo` 最新的话，查「近 30 天」时商品榜会换成「最新一天的前 5 名」——
   * 那份数据自己不说「我只覆盖一天」，页面上就成了两个不同窗口的数字并排。
   * 选择规则与理由见 `pickSnapshotIndex`。
   */
  const windows = candidates.map((row) => ({
    from: fromDbDate(row.statFrom) ?? '',
    to: fromDbDate(row.statTo) ?? '',
  }))
  const picked = pickSnapshotIndex(windows, range)
  const latest = picked < 0 ? undefined : candidates[picked]
  if (latest === undefined) {
    return { type, window: null, rows: [] }
  }

  const windowFrom = fromDbDate(latest.statFrom)
  const windowTo = fromDbDate(latest.statTo)
  const window =
    windowFrom === null || windowTo === null ? null : { from: windowFrom, to: windowTo }

  const rows = candidates
    .filter(
      (row) =>
        row.statFrom.getTime() === latest.statFrom.getTime() &&
        row.statTo.getTime() === latest.statTo.getTime(),
    )
    .slice(0, OPS_LIMITS.DIMENSION_TOP)
    .map((row) => ({
      key: row.dimKey,
      label: row.dimLabel,
      metrics: (row.metrics ?? {}) as Record<string, number | string | null>,
    }))

  const visibleRows = allowFinance ? rows : maskDimensionRows(rows, masked)
  return { type, window, rows: sortDimensionRows(type, visibleRows) }
}

function toRunSummary(row: {
  id: string
  trigger: string
  source: string
  status: string
  statFrom: Date
  statTo: Date
  dailyRows: number
  dimensionRows: number
  rawPath: string | null
  errorMessage: string | null
  startedAt: Date
  finishedAt: Date | null
  durationMs: number | null
}): OpsCollectRunSummary {
  return {
    id: row.id,
    trigger: row.trigger,
    source: row.source as OpsCollectRunSummary['source'],
    status: row.status as OpsCollectStatus,
    window: { from: fromDbDate(row.statFrom) ?? '', to: fromDbDate(row.statTo) ?? '' },
    dailyRows: row.dailyRows,
    dimensionRows: row.dimensionRows,
    rawPath: row.rawPath,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt === null ? null : row.finishedAt.toISOString(),
    durationMs: row.durationMs,
  }
}

/**
 * 看板读模型。
 *
 * 返回 null 只表示「没有这家店」——店铺还没采集过数据是另一种情况（`shop` 存在、
 * `dailyDays` 为 0），由调用方渲染「尚未采集」的空态。把两者混成一个 null 会让
 * 界面无法给出「接下来该做什么」的提示。
 */
export async function loadOpsDashboard(input: {
  shopCode: string | null
  range: OpsDateRange
  viewer: OpsViewer
}): Promise<OpsDashboardResponse | null> {
  const shop = await loadShop(input.shopCode)
  if (shop === null) return null

  const canReadFinance = hasPermission(input.viewer.permissions, FINANCE_PERMISSION)
  const masked = new Set<string>()

  const previous = previousOpsRange(input.range)
  const queryFrom = previous === null ? input.range.from : previous.from
  const fromDate = toDbDate(queryFrom)
  const toDate = toDbDate(input.range.to)

  const rawRows =
    fromDate === null || toDate === null
      ? []
      : await prisma.ecomDailyMetric.findMany({
          where: { shopId: shop.id, statDate: { gte: fromDate, lte: toDate } },
          orderBy: { statDate: 'asc' },
          select: {
            statDate: true,
            payAmountFen: true,
            visitors: true,
            payBuyers: true,
            itemVisitors: true,
          },
        })

  const rows: DailyRow[] = rawRows.flatMap((row) => {
    const date = fromDbDate(row.statDate)
    if (date === null) return []
    return [
      {
        date,
        payAmountFen: row.payAmountFen,
        visitors: row.visitors,
        payBuyers: row.payBuyers,
        itemVisitors: row.itemVisitors,
      },
    ]
  })

  const currentRows = rows.filter(
    (row) => row.date >= input.range.from && row.date <= input.range.to,
  )
  const previousRows =
    previous === null
      ? []
      : rows.filter((row) => row.date >= previous.from && row.date <= previous.to)

  const payAmount = sumField(currentRows, 'payAmountFen')
  const payBuyers = sumField(currentRows, 'payBuyers')
  const visitors = sumField(currentRows, 'visitors')
  const itemVisitors = sumField(currentRows, 'itemVisitors')

  const prevPayAmount = sumField(previousRows, 'payAmountFen')
  const prevPayBuyers = sumField(previousRows, 'payBuyers')
  const prevVisitors = sumField(previousRows, 'visitors')
  const prevItemVisitors = sumField(previousRows, 'itemVisitors')

  const payRate = ratioOf(payBuyers.sum, visitors.sum)
  const prevPayRate = ratioOf(prevPayBuyers.sum, prevVisitors.sum)
  const orderValue = ratioOf(payAmount.sum, payBuyers.sum)
  const prevOrderValue = ratioOf(prevPayAmount.sum, prevPayBuyers.sum)

  const [items, channels, areas, keywords, content, summary] = await Promise.all([
    loadDimensionGroup(shop.id, 'item', input.range, masked, canReadFinance),
    loadDimensionGroup(shop.id, 'channel', input.range, masked, canReadFinance),
    loadDimensionGroup(shop.id, 'area', input.range, masked, canReadFinance),
    loadDimensionGroup(shop.id, 'keyword', input.range, masked, canReadFinance),
    loadDimensionGroup(shop.id, 'content', input.range, masked, canReadFinance),
    loadDimensionGroup(shop.id, 'summary', input.range, masked, canReadFinance),
  ])

  /*
   * 先取快照，再决定 KPI 用哪一档口径。
   *
   * 这个顺序不能颠倒：`summary` 里的 `uv` / `payByrCnt` 是平台**整段去重**后的
   * 人数，与逐日求和得到的值不等（30 天 3,890 对 4,038）—— 同一个访客在不同日子
   * 来两次，逐日求和多算一次。金额可加，人数不可加。
   *
   * 于是规则是：**查询区间恰好等于快照窗口时，用平台整段值**（与后台对得上，
   * 环比也取平台给的上一等长周期）；区间被用户改成其他跨度时，没有整段值可用，
   * 退回逐日求和并在卡片副标题写明「逐日求和，跨日重复访客会重复计入」。
   *
   * 把这条规则写在代码里而不是每次现算，是因为两种口径的数字都「看起来正常」，
   * 相差 3% 的那部分只有拿后台对照才会发现。
   */
  const summaryByKey = new Map(summary.rows.map((row) => [row.key, row.metrics]))
  const summaryWindow = summary.window
  const usePeriod =
    summaryWindow !== null &&
    summaryWindow.from === input.range.from &&
    summaryWindow.to === input.range.to

  const periodValue = (key: string): number | null => {
    const metrics = summaryByKey.get(key)
    return metrics === undefined ? null : metricNumber(metrics, 'value')
  }
  const periodCycle = (key: string): number | null => {
    const metrics = summaryByKey.get(key)
    return metrics === undefined ? null : metricNumber(metrics, 'cycleCrc')
  }

  const PERIOD_HINT = '整段去重口径，环比取自平台上一等长周期'
  const DAILY_HINT = '逐日求和平滑到区间，跨日重复访客会重复计入'

  const kpiList: OpsKpi[] = usePeriod
    ? [
        kpi({
          key: 'payAmount',
          label: KPI_LABELS.payAmount ?? '支付金额',
          unit: 'fen',
          value: periodValue('payAmount') ?? payAmount.sum,
          previous: null,
          deltaPct: periodCycle('payAmount'),
          source: 'period',
          hint: PERIOD_HINT,
        }),
        kpi({
          key: 'payBuyers',
          label: KPI_LABELS.payBuyers ?? '支付买家',
          unit: 'count',
          value: periodValue('payBuyers') ?? payBuyers.sum,
          previous: null,
          deltaPct: periodCycle('payBuyers'),
          source: 'period',
          hint: PERIOD_HINT,
        }),
        kpi({
          key: 'visitors',
          label: KPI_LABELS.visitors ?? '访客数',
          unit: 'count',
          value: periodValue('visitors') ?? visitors.sum,
          previous: null,
          deltaPct: periodCycle('visitors'),
          source: 'period',
          hint: PERIOD_HINT,
        }),
        kpi({
          key: 'itemVisitors',
          label: KPI_LABELS.itemVisitors ?? '商品访客',
          unit: 'count',
          value: periodValue('itemVisitors') ?? itemVisitors.sum,
          previous: null,
          deltaPct: periodCycle('itemVisitors'),
          source: 'period',
          hint: PERIOD_HINT,
        }),
        kpi({
          key: 'payRate',
          label: KPI_LABELS.payRate ?? '支付转化率',
          unit: 'percent',
          value: periodValue('payRate') ?? payRate,
          previous: null,
          deltaPct: periodCycle('payRate'),
          source: 'period',
          hint: '支付买家 ÷ 访客，整段口径',
        }),
        kpi({
          key: 'orderValue',
          label: KPI_LABELS.orderValue ?? '客单价',
          unit: 'fen',
          value: periodValue('orderValue') ?? orderValue,
          previous: null,
          deltaPct: periodCycle('orderValue'),
          source: 'period',
          hint: '支付金额 ÷ 支付买家，整段口径',
        }),
      ]
    : [
        kpi({
          key: 'payAmount',
          label: KPI_LABELS.payAmount ?? '支付金额',
          unit: 'fen',
          value: payAmount.sum,
          previous: prevPayAmount.sum,
          deltaPct: deltaRatio(payAmount.sum, prevPayAmount.sum),
          source: 'daily',
          hint: '区间内逐日真值求和',
        }),
        kpi({
          key: 'payBuyers',
          label: KPI_LABELS.payBuyers ?? '支付买家',
          unit: 'count',
          value: payBuyers.sum,
          previous: prevPayBuyers.sum,
          deltaPct: deltaRatio(payBuyers.sum, prevPayBuyers.sum),
          source: 'daily',
          hint: DAILY_HINT,
        }),
        kpi({
          key: 'visitors',
          label: KPI_LABELS.visitors ?? '访客数',
          unit: 'count',
          value: visitors.sum,
          previous: prevVisitors.sum,
          deltaPct: deltaRatio(visitors.sum, prevVisitors.sum),
          source: 'daily',
          hint: DAILY_HINT,
        }),
        kpi({
          key: 'itemVisitors',
          label: KPI_LABELS.itemVisitors ?? '商品访客',
          unit: 'count',
          value: itemVisitors.sum,
          previous: prevItemVisitors.sum,
          deltaPct: deltaRatio(itemVisitors.sum, prevItemVisitors.sum),
          source: 'daily',
          hint: DAILY_HINT,
        }),
        kpi({
          key: 'payRate',
          label: KPI_LABELS.payRate ?? '支付转化率',
          unit: 'percent',
          value: payRate,
          previous: prevPayRate,
          deltaPct: deltaRatio(payRate, prevPayRate),
          source: 'derived',
          hint: '支付买家 ÷ 访客，随区间重算',
        }),
        kpi({
          key: 'orderValue',
          label: KPI_LABELS.orderValue ?? '客单价',
          unit: 'fen',
          value: orderValue,
          previous: prevOrderValue,
          deltaPct: deltaRatio(orderValue, prevOrderValue),
          source: 'derived',
          hint: '支付金额 ÷ 支付买家',
        }),
      ]

  const [latestRun, coverage] = await Promise.all([
    prisma.ecomCollectRun.findFirst({
      where: { shopId: shop.id },
      orderBy: { startedAt: 'desc' },
      select: { status: true },
    }),
    prisma.ecomDailyMetric.aggregate({
      where: { shopId: shop.id },
      _min: { statDate: true },
      _max: { statDate: true },
    }),
  ])

  const coveredFrom = fromDbDate(coverage._min.statDate)
  const coveredTo = fromDbDate(coverage._max.statDate)

  return {
    shop,
    range: input.range,
    days: opsRangeDays(input.range),
    previous,
    kpi: canReadFinance ? kpiList : applyFinanceMask(kpiList, masked),
    series: currentRows,
    dimensions: { items, channels, areas, keywords, content, summary },
    flags: {
      lastCollectedAt: shop.lastCollectedAt,
      lastRunStatus: latestRun === null ? null : (latestRun.status as OpsCollectStatus),
      masked: [...masked].sort(),
      dailyDays: currentRows.filter((row) => Object.values(row).some((value) => value !== null))
        .length,
      covered:
        coveredFrom === null || coveredTo === null ? null : { from: coveredFrom, to: coveredTo },
    },
  }
}

/**
 * 库里最新一天的业务日。
 *
 * 默认区间要用它而不是「今天」：采集是攒出来的，库里最新一天往往比今天早一两天
 * （T-1 采集 + 周末）。以今天为锚点算「近 30 天」，开头会多出两三天空白，而
 * **整段口径的窗口也随之后移**，于是首屏的 KPI 与商品榜单取自两个不同窗口 ——
 * 两个数字各自都对，放在一起却不是一个故事。
 *
 * 返回 null 表示库里还没有任何逐日数据，调用方退回以今天为锚。
 */
export async function latestCoveredDate(): Promise<string | null> {
  const row = await prisma.ecomDailyMetric.aggregate({ _max: { statDate: true } })
  return fromDbDate(row._max.statDate)
}

/**
 * 五店并列指标带。
 *
 * 一次查全部店铺当区间的逐日行，再在内存里按店分组。不做「每家店一次查询」：
 * 五家店就是五次往返，而数据量本身很小（每店每天一行）。将来店铺数上到几十家时，
 * 这里要改成一条 `group by shop_id` 的聚合查询 —— 届时 `OpsShopBoard` 的字段不用动。
 *
 * **没有数据的店铺照常返回**，`hasData` 为 false。界面据此渲染「待接入」占位卡，
 * 而不是把这家店从列表里删掉：布局固定五列是这一版明确的交互约定，缺席比占位更容易
 * 让人误判成「这家店被删了」。
 */
export async function loadOpsShopBoards(input: {
  range: OpsDateRange
  viewer: OpsViewer
}): Promise<OpsShopBoardsResponse> {
  const canReadFinance = hasPermission(input.viewer.permissions, FINANCE_PERMISSION)
  const fromDate = toDbDate(input.range.from)
  const toDate = toDbDate(input.range.to)

  const shops = await prisma.ecomShop.findMany({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      platform: true,
      sellerNick: true,
      timezone: true,
      lastCollectedAt: true,
    },
  })

  const rows =
    fromDate === null || toDate === null || shops.length === 0
      ? []
      : await prisma.ecomDailyMetric.findMany({
          where: {
            shopId: { in: shops.map((shop) => shop.id) },
            statDate: { gte: fromDate, lte: toDate },
          },
          orderBy: { statDate: 'asc' },
          select: {
            shopId: true,
            statDate: true,
            payAmountFen: true,
            visitors: true,
            payBuyers: true,
            itemVisitors: true,
          },
        })

  const byShop = new Map<string, DailyRow[]>()
  for (const row of rows) {
    const date = fromDbDate(row.statDate)
    if (date === null) continue
    const list = byShop.get(row.shopId) ?? []
    list.push({
      date,
      payAmountFen: row.payAmountFen,
      visitors: row.visitors,
      payBuyers: row.payBuyers,
      itemVisitors: row.itemVisitors,
    })
    byShop.set(row.shopId, list)
  }

  const boards: OpsShopBoard[] = shops.map((shop) => {
    const daily = byShop.get(shop.id) ?? []
    const payAmount = sumField(daily, 'payAmountFen')
    const payBuyers = sumField(daily, 'payBuyers')
    const visitors = sumField(daily, 'visitors')
    const hasData = daily.some((row) =>
      [row.payAmountFen, row.visitors, row.payBuyers, row.itemVisitors].some(
        (value) => value !== null,
      ),
    )

    return {
      shop: {
        ...shop,
        lastCollectedAt: shop.lastCollectedAt === null ? null : shop.lastCollectedAt.toISOString(),
      },
      hasData,
      coveredDays: daily.filter((row) => row.payAmountFen !== null || row.visitors !== null).length,
      payAmountFen: canReadFinance ? payAmount.sum : null,
      payBuyers: payBuyers.sum,
      visitors: visitors.sum,
      payRate: ratioOf(payBuyers.sum, visitors.sum),
      masked: !canReadFinance,
      series: daily,
    }
  })

  return { range: input.range, days: opsRangeDays(input.range), shops: boards }
}

/** 采集批次与新鲜度。批次列表是「昨天为什么没数」的第一手材料。 */
export async function loadOpsHealth(
  shopCode: string | null,
  limit = 20,
): Promise<OpsHealthResponse | null> {
  const shop = await loadShop(shopCode)
  if (shop === null) return null

  const rows = await prisma.ecomCollectRun.findMany({
    where: { shopId: shop.id },
    orderBy: { startedAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 100),
    select: {
      id: true,
      trigger: true,
      source: true,
      status: true,
      statFrom: true,
      statTo: true,
      dailyRows: true,
      dimensionRows: true,
      rawPath: true,
      errorMessage: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
    },
  })

  return {
    shop,
    lastCollectedAt: shop.lastCollectedAt,
    runs: rows.map(toRunSummary),
  }
}

/** 店铺清单。多店接入前只有一个，界面用它渲染店铺选择器。 */
export async function listOpsShops(): Promise<OpsShopSummary[]> {
  const rows = await prisma.ecomShop.findMany({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      code: true,
      name: true,
      platform: true,
      sellerNick: true,
      timezone: true,
      lastCollectedAt: true,
    },
  })
  return rows.map((row) => ({
    ...row,
    lastCollectedAt: row.lastCollectedAt === null ? null : row.lastCollectedAt.toISOString(),
  }))
}
