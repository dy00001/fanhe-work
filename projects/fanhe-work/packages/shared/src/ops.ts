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
  /**
   * 一条 `running` 记录停留多久算超时（毫秒）。
   *
   * **取值依据**：库里 4 次成功入库的耗时是 0.107 / 0.107 / 0.129 / 0.200 秒
   * （含一次 30 天回填），量级是「一次事务」。10 分钟是实测最大值的 3000 倍，
   * 余量足够覆盖进程被换出、库连接等待、GC 长停顿这类偶发卡顿，又不至于让一条
   * 真挂死的记录在界面上挂一整天。
   *
   * 注意它衡量的是**入库这一步**，不是浏览器抓取那一段 —— 抓取耗时不在
   * `ecom_collect_runs` 里，采集器是先抓完再调 `POST /api/ops/ingest`。
   */
  COLLECT_RUNNING_TIMEOUT_MS: 10 * 60 * 1000,
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

/**
 * 一条停在 `running` 的采集记录是否已经超时。
 *
 * 只有 `running` 会被判超时：其余三种状态本来就带 `finishedAt`，时间再久也只是
 * 「历史记录」。判据放在共享包里，是为了让后端算出的 `stale` 与前端要展示的
 * 中文口径同源 —— 两处各写一份阈值，迟早会出现「列表说采集中、顶部说中断」。
 *
 * 解析不出时间的当「不超时」：宁可把一条可疑记录继续显示成采集中，也不要把
 * 一条正常记录误判成中断 —— 后者的代价是运维去查一个不存在的故障。
 */
export function isCollectRunStale(
  run: { status: OpsCollectStatus; startedAt: string },
  nowMs: number,
): boolean {
  if (run.status !== 'running') return false
  const started = Date.parse(run.startedAt)
  if (!Number.isFinite(started)) return false
  return nowMs - started > OPS_LIMITS.COLLECT_RUNNING_TIMEOUT_MS
}

/** 店铺平台。当前只有淘宝系，字段保留是为了加店时不改事实表。 */
export const OPS_PLATFORMS = ['taobao', 'tmall'] as const
export type OpsPlatform = (typeof OPS_PLATFORMS)[number]

/**
 * 指标单位。展示层据此决定加哪种前缀与小数位，组件里不判断。
 *
 * `second` 与 `minute` 分开而不是全用 min：客服平均响应时长的实测值是 23.38 秒，
 * 折成分钟是 0.39 分 —— 单位换成分钟会让一个「正常」的数看起来像「异常的小数」。
 */
export const OPS_METRIC_UNITS = ['fen', 'count', 'percent', 'minute', 'second'] as const
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

  /**
   * 归属账号。null 表示公共店铺，所有持 `ops.shop.read` 的账号都能看到。
   *
   * 归属只决定「谁能看到」，不参与任何授权判断：能改什么仍然只看权限点。
   */
  ownerId: string | null
  /** 归属账号的显示名，null 时与 `ownerId` 一致。 */
  ownerName: string | null
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

  /**
   * ---- 绑定状态。由绑定入口写入、采集器回写，界面只读。 ----
   *
   * 没有绑定过（种子或 ingest upsert 建出来的行）时 `boundAt` 为 null，
   * 界面据此区分「登记过的占位店」与「真正绑定过的店」。
   */
  boundAt: string | null
  /** 采集浏览器登录态。判据只有采集器一份，平台不猜。 */
  loginState: OpsLoginState
  /** 最近一次校验登录态的时刻。绿点旁边要显示这个时间，否则看不出是不是上周验的。 */
  loginCheckedAt: string | null
  /** 该店专属的 Edge 调试端口，与 `shops.config.json` 必须一致。 */
  collectPort: number | null
  /** 待处理的同步请求时刻。非空表示「已请求，采集器还没处理」。 */
  syncRequestedAt: string | null
  /** 最近一次同步失败的原因，成功后清空。 */
  lastSyncError: string | null
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
  /**
   * 组里有行来自另一份快照时的那个窗口，`null` 表示全部同源。
   *
   * 存在的理由：少数指标平台只按日出（见 `OPS_DAILY_ONLY_SUMMARY_KEYS`），查
   * 「近 30 天」时选中那份快照里根本没有它们。要么让它们在区间视图里永远缺，
   * 要么从最近一份单日快照补进来 —— 选后者，但**必须留下来源窗口**，否则界面
   * 会把「某一天的值」当成「这段区间的值」显示，两者在经营上不是一回事。
   *
   * 界面看到非 null 时要在数值旁注明日期，不能只显示数字。
   */
  supplementedFrom?: OpsDateRange | null
  /**
   * 上面那个窗口补进来的键。只有这些键需要标注，其余行仍属于 `window`。
   *
   * 分到键这一级而不是整组标记：同一次响应里，「支付金额」来自区间快照、
   * 「三分钟响应」来自单日快照是正常的，整组打标会让人以为所有数字都只有一天。
   */
  supplementedKeys?: readonly string[]
}

/**
 * 模块入口卡里那几个「补充指标」。
 *
 * 共同点是既不逐日、也不属于任何长尾维度，落位统一是 `dimensions.summary` 的一行：
 * `key` 就是下表键名，值放在 `metrics.value`。走 summary 而非新增维度类型，是为了
 * 不动 `OPS_DIMENSION_TYPES` 白名单、不动库结构 —— 采集器上报一行 `type: 'summary'`
 * 就进得来，查询层原样透传。
 *
 * 写进契约的理由：卡片此前把这几个位置写死成「待接入」字符串，数据已经入库也不会
 * 显示，而且没有任何测试会红。键名集中在这里之后，采集映射、接口、界面引用同一个
 * 常量，拼错会变成编译错误而不是静默的空白。
 *
 * `pending` 只描述当前实施状态，**不参与任何运行时判断**。判断一律看 summary 里
 * 有没有这一行；状态变了要同步改 `apps/web/src/lib/ops-pending.ts` 的清单。
 */
export type OpsModuleKey = 'flow' | 'items' | 'service' | 'ads' | 'content'

export type OpsSummaryMetricSpec = {
  readonly key: string
  readonly label: string
  readonly unit: OpsMetricUnit
  readonly module: OpsModuleKey
  readonly source: OpsMetricSource
  /** 当前是否还没接入。仅作说明，运行时以 summary 里有没有这一行为准。 */
  readonly pending: boolean
}

export const OPS_SUMMARY_METRICS = [
  {
    key: 'flowRecommendUv',
    label: '推荐访客',
    unit: 'count',
    module: 'flow',
    source: 'period',
    pending: false,
  },
  {
    key: 'bounceRate',
    label: '跳失率',
    unit: 'percent',
    module: 'flow',
    source: 'period',
    pending: false,
  },
  {
    key: 'itemBaseScore',
    label: '商品基础分',
    unit: 'count',
    module: 'items',
    source: 'period',
    pending: true,
  },
  {
    key: 'csThreeMinRate',
    label: '三分钟响应',
    unit: 'percent',
    module: 'service',
    source: 'period',
    /*
     * 2026-10-30 起已接入（采集侧 `csp/api/core/monitor/overview/layer.json` 的
     * `base_avg` 行）。它**只有单日口径**：平台按 dateType=1d 返回，没有 30 天值。
     * 见 OPS_DAILY_ONLY_SUMMARY_KEYS。
     */
    pending: false,
  },
  {
    key: 'csAvgReplySec',
    label: '平均响应时长',
    unit: 'second',
    module: 'service',
    source: 'period',
    /*
     * 与 csThreeMinRate 同一个接口的同一行（`base_avg.avgReplyDur1d`，单位秒）。
     * 同样只有单日口径，见 OPS_DAILY_ONLY_SUMMARY_KEYS。
     */
    pending: false,
  },
  {
    key: 'csConsultUv',
    label: '咨询人数',
    unit: 'count',
    module: 'service',
    source: 'period',
    /* `base_avg.cstUv1d`。去重人数，跨天不可相加，所以同样走单日补齐。 */
    pending: false,
  },
  {
    key: 'csReplyUv',
    label: '接待人数',
    unit: 'count',
    module: 'service',
    source: 'period',
    /*
     * `base_avg.replyUv1d`。与咨询人数分开是因为差值本身有意义：咨询了但没被接待
     * 的那部分，正是响应率的分子缺口。
     */
    pending: false,
  },
  {
    key: 'rateUnrepliedCnt',
    label: '待回复',
    unit: 'count',
    module: 'service',
    source: 'period',
    pending: true,
  },
  {
    key: 'kwCost',
    label: '推广花费',
    unit: 'fen',
    module: 'ads',
    source: 'period',
    pending: true,
  },
  {
    key: 'kwCtr',
    label: '点击率',
    unit: 'percent',
    module: 'ads',
    source: 'period',
    pending: true,
  },
  {
    key: 'contentViewUv',
    label: '内容查看',
    unit: 'count',
    module: 'content',
    source: 'period',
    pending: true,
  },
] as const satisfies readonly OpsSummaryMetricSpec[]

export type OpsSummaryMetricKey = (typeof OPS_SUMMARY_METRICS)[number]['key']

/**
 * 只有单日口径的 summary 指标。查询区间不是单日时，它们从最近一份单日快照补齐。
 *
 * 为什么需要这份名单，而不是「缺什么补什么」：
 *
 *   - 有些键缺失是因为采集没跑（真缺），补齐它们会让「昨天下线了」变成「显示
 *     上周的数字」，故障被藏起来；
 *   - 有些键是平台压根没有区间口径（三分钟响应率按 `dateType=1d` 返回），不补
 *     就永远只有单日视图能看到，等于没接入。
 *
 * 名单只放后者。加进来之前先确认：平台确实没有区间口径，不是我们没采。
 */
export const OPS_DAILY_ONLY_SUMMARY_KEYS: readonly OpsSummaryMetricKey[] = [
  'csThreeMinRate',
  'csAvgReplySec',
  'csConsultUv',
  'csReplyUv',
]

/**
 * 从 summary 组里取一项。
 *
 * 找不到行、或行在但 `value` 不是有限数，一律返回 `null`。`null` 的含义是「这一项
 * 没有数据」，由界面显示「待接入」；返回 0 会把「没采到」说成「为零」，这两件事在
 * 经营上的含义完全相反。
 *
 * 键名用 `OpsSummaryMetricKey` 而不是 `string`：拼错时是编译错误，不会变成一次
 * 静默的「取不到值」。
 */
export function opsSummaryMetric(
  group: Pick<OpsDimensionGroup, 'rows'> | null | undefined,
  key: OpsSummaryMetricKey,
): number | null {
  if (group === null || group === undefined) return null
  for (const row of group.rows) {
    if (row.key !== key) continue
    const value = row.metrics.value
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  return null
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

/**
 * 单店的一块「铺面」：五店并列指标带里的一张卡。
 *
 * `hasData` 与「金额为 null」是两件事：前者说这家店有没有任何逐日数据，后者可能是
 * 权限裁剪的结果。卡片上的「待接入」标只看 `hasData`，金额显示只看 `masked`。
 */
export type OpsShopBoard = {
  shop: OpsShopSummary
  hasData: boolean
  /** 区间内实际有数的天数。用来区分「整段」与「只覆盖了几天」。 */
  coveredDays: number
  payAmountFen: number | null
  payBuyers: number | null
  visitors: number | null
  payRate: number | null
  /**
   * 金额是否被权限裁掉。true 时 `payAmountFen` 为 null，前端渲染成「—」。
   *
   * 只裁金额，不动 `payBuyers` 与 `payRate`：后两者是交易结果而不是金额，而且
   * `payRate` 的分母是访客数 —— 一并置空会让非财务角色看到「转化率也没有」，
   * 可他们本来就能看到访客数。这条边界要写清楚，否则很容易被「顺手补全」成
   * 三个都 null，界面就从「金额保密」变成「整块数据缺失」。
   */
  masked: boolean
  /** 迷你柱状用的逐日金额，直接取自逐日表，不插值。 */
  series: readonly OpsDailyPoint[]
}

export type OpsShopBoardsResponse = {
  range: OpsDateRange
  days: number
  shops: readonly OpsShopBoard[]
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
  /**
   * 这条记录停在 `running` 且已超过 `COLLECT_RUNNING_TIMEOUT_MS`。
   *
   * 它不是第五种状态，而是**对 `running` 的时间判定**：库里那一行确实是
   * `running`（写入中断时补写失败就会留下这种行），但「还在跑」已经不可能。
   * 放在响应里而不是让前端自己算，是因为判定要两端一致 —— 前端算一遍、后端
   * 算一遍，两处阈值不同就会出现「列表说采集中、顶部说中断」。
   */
  stale: boolean
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

// ---------------------------------------------------------------------------
// 店铺绑定
// ---------------------------------------------------------------------------

/**
 * 采集浏览器登录态。与 Prisma 的 `OpsLoginState` 一一对应。
 *
 * 三档而非两档：`unknown` 是「还没验过」。刚绑定的店一进来就顶着
 * 「需要重新登录」的红标，会让人去点一个本来没问题的按钮。
 */
export const OPS_LOGIN_STATES = ['unknown', 'authenticated', 'needs_login'] as const
export type OpsLoginState = (typeof OPS_LOGIN_STATES)[number]

export function isOpsLoginState(value: unknown): value is OpsLoginState {
  return typeof value === 'string' && (OPS_LOGIN_STATES as readonly string[]).includes(value)
}

/**
 * 店铺代号的字面规则。**必须与 `tools/collector/scripts/lib/shops.mjs` 的
 * `CODE_RE` 完全一致** —— 两处不一致时，绑定入口能建出一条采集器读不出来的
 * 槽位，表现是「绑定成功但永远没有数据」，且没有任何报错。
 */
export const OPS_SHOP_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/

/**
 * 采集端口下限。9222 是 Chromium 调试端口的惯用起点，`shops.config.json` 的
 * `basePort` 也从这里起。低于它的端口属于系统与常用服务，绑定入口不该占用。
 */
export const OPS_COLLECT_PORT_MIN = 9222
export const OPS_COLLECT_PORT_MAX = 65535

/** 绑定入口的入参。`collectPort` 由人给，不自动分配：自动分配会和手工配置的槽位撞车。 */
export type OpsShopBindInput = {
  code: string
  name: string
  platform: OpsPlatform
  sellerNick?: string | null
  /**
   * 采集端口。**可以不给**：2026-10-29 起界面不再让人填端口。
   *
   * 端口只对旧 CDP 链路（每店一个 Edge 调试端口）有意义，插件链路取数不经过
   * 它。但采集器的槽位表仍要求参与采集的店有唯一端口（`lib/shops.mjs` 会抛错），
   * 所以「不给」不等于「可以没有」—— 由 `bindShop` 自动分配一个未占用的。
   */
  collectPort?: number
}

export type OpsShopBindValidated = {
  code: string
  name: string
  platform: OpsPlatform
  sellerNick: string | null
  /** null 表示调用方没有指定，由写库那一层分配。 */
  collectPort: number | null
}

export type OpsShopBindValidation =
  { ok: true; value: OpsShopBindValidated } | { ok: false; message: string }

/**
 * 绑定入参校验。纯函数，便于反例测试。
 *
 * 只做「格式与范围」，不查重（查重要读库，属于路由层）。这一层拒绝的每一条都
 * 对应一种会安静出事的情况：
 *
 *   - code 不合法 → 采集器 `loadShops()` 直接抛错，整个采集端起不来；
 *   - name 含换行 → 写进 CSV 与 ingest 后会把一列拆成两行；
 *   - 端口越界 → Edge 起不来，但进程退出码与「账号过期」不好区分。
 */
export function validateShopBindInput(input: unknown): OpsShopBindValidation {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, message: '绑定参数必须是对象' }
  }
  const raw = input as Record<string, unknown>

  const code = typeof raw.code === 'string' ? raw.code.trim() : ''
  if (!OPS_SHOP_CODE_PATTERN.test(code)) {
    return {
      ok: false,
      message: `店铺代号只能是小写字母、数字与连字符，且以字母或数字开头（最长 32 位）：${String(raw.code ?? '')}`,
    }
  }

  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (name.length === 0 || name.length > OPS_LIMITS.SHOP_NAME_MAX) {
    return { ok: false, message: `店铺名称需为 1 到 ${OPS_LIMITS.SHOP_NAME_MAX} 个字符` }
  }
  if (/[\r\n\t]/.test(name)) {
    return { ok: false, message: '店铺名称不能包含换行或制表符' }
  }

  const platform = raw.platform
  if (platform !== 'taobao' && platform !== 'tmall') {
    return { ok: false, message: `暂不支持该平台：${String(platform ?? '')}` }
  }

  const sellerNick =
    raw.sellerNick === undefined || raw.sellerNick === null ? null : String(raw.sellerNick).trim()
  if (sellerNick !== null && sellerNick.length > 80) {
    return { ok: false, message: '掌柜昵称最长 80 个字符' }
  }

  /*
   * 端口可选。不传、传 null、传空串都表示「由写库那一层分配」；显式给了就必须
   * 在采集端口段内。
   *
   * 先 Number 再判整数，而不是比 typeof：表单 Input 的原生输出就是字符串
   * `'9222'`，按类型拒会把唯一正常的一条路径也挡掉。
   */
  let collectPort: number | null = null
  if (raw.collectPort !== undefined && raw.collectPort !== null && raw.collectPort !== '') {
    const port = Number(raw.collectPort)
    if (!Number.isInteger(port) || port < OPS_COLLECT_PORT_MIN || port > OPS_COLLECT_PORT_MAX) {
      return {
        ok: false,
        message: `采集端口必须是 ${OPS_COLLECT_PORT_MIN} 到 ${OPS_COLLECT_PORT_MAX} 之间的整数`,
      }
    }
    collectPort = port
  }

  return {
    ok: true,
    value: {
      code,
      name,
      platform,
      sellerNick: sellerNick === '' ? null : sellerNick,
      collectPort,
    },
  }
}

/**
 * 采集器回写的店铺状态。
 *
 * `clearSyncRequest` 由采集器决定：只有「这一轮真的处理过这家店」才置真。
 * 采集中途崩溃时不置真，下一轮会重试；反过来由平台按时间戳判断，会把一次
 * 崩溃当成「已经处理过」，那家店就再也不会被自动拉起来。
 */
export type OpsShopStateReport = {
  code: string
  loginState: OpsLoginState
  lastSyncError: string | null
  collectedAt: string | null
  clearSyncRequest: boolean
}

export type OpsShopStateReportValidation =
  { ok: true; value: OpsShopStateReport } | { ok: false; message: string }

export function validateShopStateReport(input: unknown): OpsShopStateReportValidation {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, message: '状态上报必须是对象' }
  }
  const raw = input as Record<string, unknown>

  const code = typeof raw.code === 'string' ? raw.code.trim() : ''
  if (!OPS_SHOP_CODE_PATTERN.test(code)) {
    return { ok: false, message: '店铺代号不合法' }
  }
  if (!isOpsLoginState(raw.loginState)) {
    return { ok: false, message: `登录态取值不合法：${String(raw.loginState ?? '')}` }
  }

  const lastSyncError =
    raw.lastSyncError === undefined || raw.lastSyncError === null
      ? null
      : String(raw.lastSyncError).slice(0, 500)
  const collectedAt =
    raw.collectedAt === undefined || raw.collectedAt === null ? null : String(raw.collectedAt)
  if (collectedAt !== null && Number.isNaN(Date.parse(collectedAt))) {
    return { ok: false, message: `采集时刻不是合法时间：${collectedAt}` }
  }

  return {
    ok: true,
    value: {
      code,
      loginState: raw.loginState,
      lastSyncError: lastSyncError === '' ? null : lastSyncError,
      collectedAt,
      clearSyncRequest: raw.clearSyncRequest === true,
    },
  }
}

// ---------------------------------------------------------------------------
// 采集器心跳
// ---------------------------------------------------------------------------

/**
 * 「在线」的判定窗口。
 *
 * 常驻轮询默认 60 秒一轮，取三倍即容忍两次丢拍（机器休眠唤醒、一次慢查询）。
 * 再短会把正常的抖动显示成离线，而离线的提示会让人去重启一个没问题的进程。
 */
export const OPS_COLLECTOR_ONLINE_WINDOW_MS = 180_000

/**
 * 采集器状态。
 *
 * `lastSeenAt` 是「最近一次有人来拉待办」的时刻，不是「最近一次采集成功」的
 * 时刻。两者分开是有意的：采集失败也会更新心跳，因为那证明有人在干活。
 */
export type OpsCollectorStatus = {
  lastSeenAt: string | null
  online: boolean
}

/**
 * 纯函数：给最后心跳时刻与当前时刻，判断是否在线。
 *
 * 抽出来是为了能测边界（正好等于窗口、时钟倒退、非法时间串）。这些边界写错
 * 不会报错，只会让「在线」这个灯常年亮着或者常年灭着。
 */
export function isCollectorOnline(lastSeenAt: string | null, nowMs: number): boolean {
  if (lastSeenAt === null) return false
  const seen = Date.parse(lastSeenAt)
  if (Number.isNaN(seen)) return false
  /* 时钟倒退（换了机器时间、NTP 校正）时差值为负，那说明心跳是「未来」的，
     按在线处理：真实场景里它更可能是本机时钟被调过，而不是采集器撒谎。 */
  const elapsed = nowMs - seen
  if (elapsed < 0) return true
  return elapsed <= OPS_COLLECTOR_ONLINE_WINDOW_MS
}
