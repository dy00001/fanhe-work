/**
 * 运营看板的展示规则。**纯函数，不碰 React、不发请求。**
 *
 * 这条约定的理由在本项目已经付过一次代价：比率、涨跌配色、日期归一这类判断写在
 * 组件里，只有开浏览器才能验证；写成纯函数就能进 `test/*.test.mjs`，一次跑完。
 * 界面层只负责把结果摆到该在的位置。
 *
 * 四条规则集中在这里，不允许在组件里各写一遍：
 *
 *   1. **金额一律以「分」进来，除 100 只在这里发生一次。** 组件里再除一次就会出现
 *      「某个卡片差了 100 倍」，而这种错只在那一张卡上看得出。
 *   2. **涨跌配色用中国电商惯例：涨红跌绿。** 与欧美相反，也与本项目的告警色无关。
 *      写反了不会有任何报错，只会让所有人误读经营状况。
 *   3. **比率统一是 0~1 的比例**，百分号由这里加。混用「比例」与「百分点」是
 *      环比最常见的错源。
 *   4. **空值不等于 0。** `null` 显示为「—」，`0` 显示为 0。把「没采到」「没权限」
 *      显示成 0，会让使用者据此做决策。
 */

import type {
  OpsCollectStatus,
  OpsCollectorStatus,
  OpsDimensionRow,
  OpsLoginState,
  OpsMetricSource,
  OpsShopSummary,
} from '@fanhe/shared'

/** 千分位 + 最多两位小数，去掉无意义的尾零。 */
function groupNumber(value: number, digits = 0): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: digits,
  })
}

/**
 * 分 → 人民币。
 *
 * `compact` 用于指标卡这类位置：一万以上收成「万」，避免 ¥108,000 与 ¥1,234,567
 * 两种长度把卡片撑得参差不齐。精确到分仍保留在小字副标题里（见 `formatFenExact`）。
 */
export function formatFen(fen: number | null, options: { compact?: boolean } = {}): string {
  if (fen === null) return '—'
  const yuan = fen / 100
  if (options.compact === true && Math.abs(yuan) >= 10_000) {
    const wan = yuan / 10_000
    return `¥${groupNumber(wan, wan >= 100 ? 0 : 1)}万`
  }
  // 整元不显示小数：¥3,890 比 ¥3,890.00 好读，也不会在窄卡里换行。
  return `¥${groupNumber(yuan, Number.isInteger(yuan) ? 0 : 2)}`
}

/**
 * 分 → 人民币，**强制两位小数**。用于明细表与副标题。
 *
 * 与 `formatFen` 的差别不只是精度：这里必须让 `¥3,890` 显示成 `¥3,890.00`。
 * 一列金额上下对齐时，缺了小数位的那几行会让视觉重心左右跳。
 * `groupNumber` 的 `minimumFractionDigits` 是 0，所以这一处单独收口。
 */
export function formatFenExact(fen: number | null): string {
  if (fen === null) return '—'
  const yuan = fen / 100
  return `¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** 计数。`null` 显示破折号，不显示 0。 */
export function formatCount(value: number | null): string {
  if (value === null) return '—'
  return groupNumber(Math.round(value))
}

/**
 * 比率 → 百分比字符串。
 *
 * 默认两位小数，因为支付转化率这类指标的真实量级在 1%~3%，一位小数会把 1.49%
 * 与 2.34% 都显示成 1.5% 与 2.3%，看不出差别；而展示成 0.01 与 0.02 又完全失去
 * 可读性。需要更粗的场合（环比）用 `digits: 1`。
 */
export function formatPercent(ratio: number | null, digits = 2): string {
  if (ratio === null) return '—'
  return `${(ratio * 100).toFixed(digits)}%`
}

/** 秒 → 「14.2 秒」/「2 分 10 秒」。平台给的是秒（可能是小数）。 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  return `${minutes} 分 ${rest} 秒`
}

/**
 * 趋势图可切换的四个指标。
 *
 * 只列逐日真值那四个 —— 整段指标（跳失率、停留时长）没有逐日序列，画不出趋势。
 * 把这条边界写成类型而不是运行时判断，选错指标会在编译期报错。
 */
export type OpsMetricKey = 'payAmountFen' | 'visitors' | 'payBuyers' | 'itemVisitors'

export const OPS_METRIC_META: Record<
  OpsMetricKey,
  { label: string; format: (value: number | null) => string; hint: string }
> = {
  payAmountFen: {
    label: '支付金额',
    format: (value) => formatFen(value, { compact: true }),
    hint: '逐日真值，可相加',
  },
  visitors: {
    label: '访客数',
    format: formatCount,
    hint: '逐日真值，跨日重复访客按天各计一次',
  },
  payBuyers: {
    label: '支付买家',
    format: formatCount,
    hint: '逐日真值，同一天内去重',
  },
  itemVisitors: {
    label: '商品访客',
    format: formatCount,
    hint: '逐日真值，含同一访客看多个商品',
  },
}

export type DeltaTone = 'up' | 'down' | 'flat'

/**
 * 涨跌方向。
 *
 * `null` 也算 `flat`：没有基线时不该染成红或绿 —— 那两种颜色本身就是一个结论。
 * 界面需要在 `flat` 且原值为 null 时显示「不可比」，判断依据是传入的 ratio 是否为
 * null，见 `formatDelta`。
 */
export function deltaTone(ratio: number | null): DeltaTone {
  if (ratio === null || ratio === 0) return 'flat'
  return ratio > 0 ? 'up' : 'down'
}

/** +70.1% / -56.2% / 不可比。正数带号是必要的：没有号就看不出方向。 */
export function formatDelta(ratio: number | null): string {
  if (ratio === null) return '不可比'
  const sign = ratio > 0 ? '+' : ''
  return `${sign}${(ratio * 100).toFixed(1)}%`
}

/** 口径徽标文案。四档里的「演示」不在接口出现，只在原型页面里，所以这里只有三档。 */
export function sourceLabel(source: OpsMetricSource): string {
  switch (source) {
    case 'daily':
      return '逐日'
    case 'derived':
      return '推算'
    case 'period':
      return '整段'
  }
}

export function sourceHint(source: OpsMetricSource): string {
  switch (source) {
    case 'daily':
      return '区间内逐日真值相加，可随区间重算'
    case 'derived':
      return '由逐日真值相除得到，随区间重算但不可跨维度相加'
    case 'period':
      return '平台只提供整段值，切到其它区间这份数字不会变'
  }
}

export type FreshnessLevel = 'fresh' | 'stale' | 'old' | 'none'

export type Freshness = {
  level: FreshnessLevel
  label: string
  hours: number | null
}

/**
 * 数据新鲜度。
 *
 * 分档依据是「采集是每天一次」：26 小时内算正常（容忍一次失败与半天的延迟），
 * 超过 26 小时说明今天的采集没跑成，超过 48 小时说明连续两天没跑 —— 后者往往
 * 意味着采集器所在的那台机器没开机，而不是脚本报错。
 *
 * `now` 由调用方传入而不是在函数里取 `Date.now()`：否则这个函数没法进单元测试
 * （每次运行结果都不同），而它恰恰是最需要测试的那类时间判断。
 */
export function freshnessOf(lastCollectedAt: string | null, now: Date): Freshness {
  if (lastCollectedAt === null) return { level: 'none', label: '尚未采集', hours: null }
  const collected = new Date(lastCollectedAt)
  if (Number.isNaN(collected.getTime())) return { level: 'none', label: '尚未采集', hours: null }

  const hours = (now.getTime() - collected.getTime()) / 3_600_000
  if (hours <= 26) return { level: 'fresh', label: '数据新鲜', hours }
  if (hours <= 48) return { level: 'stale', label: '已超过一天未更新', hours }
  return { level: 'old', label: '已超过两天未更新', hours }
}

/** 本地时刻，`MM-DD HH:mm`。用于「上次采集」。 */
export function formatCollectedAt(lastCollectedAt: string | null): string {
  if (lastCollectedAt === null) return '—'
  const date = new Date(lastCollectedAt)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** `2026-09-19` → `09-19`。图表横轴用，年份在页头的区间里已经有了。 */
export function shortDate(iso: string): string {
  const parts = iso.split('-')
  if (parts.length !== 3) return iso
  return `${parts[1] ?? ''}-${parts[2] ?? ''}`
}

/** `2026-09-19` → `9月19日`。表格与提示用，中文里这个读起来比 09-19 自然。 */
export function chineseDate(iso: string): string {
  const parts = iso.split('-')
  if (parts.length !== 3) return iso
  const month = Number(parts[1])
  const day = Number(parts[2])
  if (!Number.isFinite(month) || !Number.isFinite(day)) return iso
  return `${month}月${day}日`
}

/**
 * 占比。分母为 0 或缺失时返回 null —— 返回 0 会被读成「占比 0%」，而实际是
 * 「这段时间没有整体数据」。
 */
export function shareOf(value: number | null, total: number | null): number | null {
  if (value === null || total === null || total === 0) return null
  return value / total
}

/**
 * 采集批次状态的中文与色档。色档给徽标用，不直接写颜色。
 *
 * `stale` 不是第五种状态，是「`running` 已经停了但没来得及收尾」——服务端按
 * `COLLECT_RUNNING_TIMEOUT_MS` 判好后放在响应里。这里只在文案上把它和真正的
 * 采集区分开：不加这一项，一条挂死的记录会一直显示「采集中」，而运维看到
 * 「正在采」就不会去查它。
 */
export function collectStatusLabel(status: OpsCollectStatus | null, stale = false): string {
  if (stale && status === 'running') return '采集中断'
  switch (status) {
    case 'running':
      return '采集中'
    case 'succeeded':
      return '成功'
    case 'partial':
      return '部分成功'
    case 'failed':
      return '失败'
    case null:
      return '无记录'
  }
}

export type CollectStatusTone = 'ok' | 'warn' | 'bad' | 'idle'

export function collectStatusTone(
  status: OpsCollectStatus | null,
  stale = false,
): CollectStatusTone {
  if (stale && status === 'running') return 'bad'
  switch (status) {
    case 'succeeded':
      return 'ok'
    case 'running':
      return 'warn'
    case 'partial':
      return 'warn'
    case 'failed':
      return 'bad'
    case null:
      return 'idle'
  }
}

/**
 * 一组数的 0 值上限，用于图表的纵轴。
 *
 * 为什么要单独算：10-08 单日 4.9 万那一根会把其余 29 根压成 2px。原型的处理是
 * 长尾指标用 √ 压缩，但压缩会改变「柱高等于数值」的直觉。这里的折中是**不给**
 * 压缩，而是把异常峰值在图上标出来，读数交给悬停 —— 数量少的时候直觉比压缩更重要。
 * 上限取最大值，且保证不为 0（全是 0 时给 1，否则除法得到 NaN，整张图空白）。
 */
export function seriesCeiling(values: readonly (number | null)[]): number {
  let max = 0
  for (const value of values) {
    if (value !== null && value > max) max = value
  }
  return max === 0 ? 1 : max
}

/** 峰值下标。用于在图上标出异常日。返回 -1 表示没有非零值。 */
export function peakIndex(values: readonly (number | null)[]): number {
  let index = -1
  let max = 0
  values.forEach((value, i) => {
    if (value !== null && value > max) {
      max = value
      index = i
    }
  })
  return index
}

/**
 * 从维度行里读一个数值。
 *
 * 与 API 侧的同名逻辑同构，但**不能共用**：共享包不该知道 JSON 列的读取细节，
 * 而读完之后的排序、占比、展示都在前端。读不到一律 `null` —— 不补 0，理由与
 * 其余金额处理一致：0 是一个业务结论，缺失不是。
 */
export function metricOf(row: Pick<OpsDimensionRow, 'metrics'>, key: string): number | null {
  const raw = row.metrics[key]
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export type SortDirection = 'asc' | 'desc'

/**
 * 按某个指标排序。空值永远排在最后，与升降序无关。
 *
 * 理由：把缺失值参与升序排序会让一整屏「—」浮到最上面，而那些行恰恰是最没有
 * 信息量的。界面上的默认排序是按支付金额降序，空值垫底正是想要的效果。
 */
export function sortByMetric<T extends { metrics: Record<string, number | string | null> }>(
  rows: readonly T[],
  key: string,
  direction: SortDirection,
): T[] {
  const factor = direction === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const left = metricOf(a, key)
    const right = metricOf(b, key)
    if (left === null && right === null) return 0
    if (left === null) return 1
    if (right === null) return -1
    return (left - right) * factor
  })
}

/** 一组维度里某个指标的最大值。用于条形图的相对宽度。 */
export function maxMetric(
  rows: readonly { metrics: Record<string, number | string | null> }[],
  key: string,
): number {
  let max = 0
  for (const row of rows) {
    const value = metricOf(row, key)
    if (value !== null && value > max) max = value
  }
  return max
}

/**
 * 整段指标的展示元数据。
 *
 * 这些键来自平台的汇总接口（跳失率、停留时长、加购人数…），它们**不能相加、
 * 不能按区间重算**，只能整段展示。把「怎么显示」集中在这里，页面就只剩布局。
 *
 * 表里没有的键返回 null，界面按「不认识的指标」跳过 —— 采集侧新增一个指标时，
 * 界面不会因为多了一个键而渲染出一行 `undefined`。
 */
export const OPS_SUMMARY_META: Record<
  string,
  { label: string; unit: 'fen' | 'count' | 'percent' | 'second'; hint: string }
> = {
  bounceRate: { label: '跳失率', unit: 'percent', hint: '只看了一个页面的访客占比' },
  stayTime: { label: '平均停留时长', unit: 'second', hint: '单次访问的平均停留秒数' },
  pv: { label: '浏览量', unit: 'count', hint: '页面浏览次数，含同一访客多次' },
  cartByrCnt: { label: '加购人数', unit: 'count', hint: '整段去重人数' },
  itmAvgPv: { label: '商品人均浏览量', unit: 'count', hint: '商品页浏览量 ÷ 商品访客' },
  newPayByrCnt: { label: '新买家', unit: 'count', hint: '首次在本店成交的买家' },
  payOldByrCnt: { label: '老买家', unit: 'count', hint: '此前已在本店成交过的买家' },
  flowRecommendUv: { label: '推荐渠道访客', unit: 'count', hint: '手淘推荐位的访客' },
  flowSearchUv: { label: '搜索渠道访客', unit: 'count', hint: '手淘搜索的访客' },
}

/** 按摘要键格式化。未知键返回 null，调用方据此跳过。 */
export function formatSummary(key: string, value: number | null): string | null {
  const meta = OPS_SUMMARY_META[key]
  if (meta === undefined) return null
  switch (meta.unit) {
    case 'fen':
      return formatFen(value, { compact: true })
    case 'count':
      return formatCount(value)
    case 'percent':
      return formatPercent(value, 1)
    case 'second':
      return formatDuration(value)
  }
}

// ---------------------------------------------------------------------------
// 店铺绑定与同步状态
// ---------------------------------------------------------------------------

/**
 * 这三条规则放在 `ops-display` 而不是单独开一个文件：它们要复用上面的
 * `freshnessOf`，而前端测试用 `node --experimental-strip-types` 直接跑源码，
 * 跨文件的相对导入（不带扩展名）在那种加载方式下解析不到。合成一份既省掉
 * 一处重复的阈值定义，也让「同步状态」与「数据新鲜度」永远用同一套判据。
 */

export type ShopStateTone = 'ok' | 'warn' | 'error' | 'muted'

export const LOGIN_STATE_META: Record<
  OpsLoginState,
  { label: string; tone: ShopStateTone; hint: string }
> = {
  /* `unknown` 不是错误态：刚绑定的店还没被采集器验过。用红色会让人去点一个
     本来就不需要点的「重新登录」。 */
  unknown: { label: '未校验', tone: 'muted', hint: '还没有采集器校验过这个浏览器里的登录态' },
  authenticated: { label: '已登录', tone: 'ok', hint: '采集器最近一次校验通过' },
  needs_login: {
    label: '需重新登录',
    tone: 'error',
    hint: '采集浏览器里的登录态已失效，需要在采集浏览器里登录一次',
  },
}

export type ShopSyncView = {
  label: string
  tone: ShopStateTone
  /** 第二行说明，通常是时刻或失败原因。 */
  detail: string
}

/**
 * 同步状态。判定顺序是有意的：
 *
 *   1. **待处理优先。** 已经请求了同步、采集器还没来，此时哪怕上一次失败过，
 *      显示的也该是「等待采集」，否则用户会立刻再点一次「立即同步」。
 *   2. 其次看失败原因。
 *   3. 最后看新鲜度。
 */
export function shopSyncView(shop: OpsShopSummary, now: Date): ShopSyncView {
  if (shop.syncRequestedAt !== null) {
    return {
      label: '等待采集器',
      tone: 'warn',
      detail: `请求于 ${formatCollectedAt(shop.syncRequestedAt)}`,
    }
  }
  if (shop.lastSyncError !== null && shop.lastSyncError !== '') {
    return { label: '同步失败', tone: 'error', detail: shop.lastSyncError }
  }
  const freshness = freshnessOf(shop.lastCollectedAt, now)
  if (freshness.level === 'none') {
    return { label: '尚未同步', tone: 'muted', detail: '绑定后由采集器自动补齐' }
  }
  return {
    label: freshness.label,
    tone: freshness.level === 'fresh' ? 'ok' : 'warn',
    detail: `上次采集 ${formatCollectedAt(shop.lastCollectedAt)}`,
  }
}

/** 登录态的第二行：校验时刻。没有它，绿点看不出是今天验的还是上周验的。 */
export function loginDetail(shop: OpsShopSummary): string {
  if (shop.loginCheckedAt === null) return LOGIN_STATE_META[shop.loginState].hint
  return `校验于 ${formatCollectedAt(shop.loginCheckedAt)}`
}

/** 端口与代号合成一行副标题，表格里省一列。 */
export function shopSlotText(shop: OpsShopSummary): string {
  const port = shop.collectPort === null ? '端口未登记' : `端口 ${shop.collectPort}`
  return `${shop.code} · ${port}`
}

/**
 * 采集器状态的一句话说明。
 *
 * 「离线」必须与「从未启动」分开：前者是进程掉了，后者是从来没人配过计划任务。
 * 两者的下一步动作不同（重启 vs 第一次注册），而合并成一句「离线」会让人去重启
 * 一个根本不存在的东西。
 */
export function collectorView(
  status: OpsCollectorStatus | null,
  now: Date,
): { label: string; tone: ShopStateTone; detail: string } {
  if (status === null) {
    return { label: '采集器状态未知', tone: 'muted', detail: '店铺列表还没读回来' }
  }
  if (status.online) {
    return {
      label: '采集器在线',
      tone: 'ok',
      detail: `最后心跳 ${formatCollectedAt(status.lastSeenAt)}`,
    }
  }
  if (status.lastSeenAt === null) {
    return {
      label: '采集器从未启动',
      tone: 'error',
      detail: '在采集机上运行 sync-shops.mjs --watch 60，否则「立即同步」不会被执行',
    }
  }
  const hours = (now.getTime() - new Date(status.lastSeenAt).getTime()) / 3_600_000
  return {
    label: '采集器离线',
    tone: 'warn',
    detail: `最后心跳 ${formatCollectedAt(status.lastSeenAt)}${
      Number.isFinite(hours) && hours >= 1 ? `（${Math.floor(hours)} 小时前）` : ''
    }`,
  }
}

/**
 * 这家店是否还缺采集端口。
 *
 * 早期种子写进来的店没有 `collect_port`，界面显示「端口未登记」。这不只是难看：
 * 补槽位那条链路只处理「库里有端口」的店，端口为空时它连碰都不碰，槽位丢了就
 * 补不回来。所以界面要能一眼看出哪几家还欠这一步。
 */
export function needsPortRegistration(shop: OpsShopSummary): boolean {
  return shop.collectPort === null || shop.collectPort === undefined
}
