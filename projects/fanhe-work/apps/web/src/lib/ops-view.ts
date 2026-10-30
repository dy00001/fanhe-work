import type { NavCode, OpsDateRange } from '@fanhe/shared'
import { addOpsDays, opsRangeDays, parseOpsDate } from '@fanhe/shared'

import { NAV_CODES } from '@fanhe/shared'

/**
 * 运营看板的视图与区间预设。
 *
 * 这一层是「地址 ↔ 看板」的翻译表，纯函数、可测：
 *
 *   1. 导航编号 → 视图。七个入口各自落到一块看板，**不靠页面内部的 tab 状态**。
 *      侧栏高亮由 `navPath` 派生、右侧内容由 `item.code` 决定，两者同源，天然同步。
 *   2. 预设 → 具体区间。原型的时间条有六档（单日 / 近 7 / 近 30 / 本月 / 上月 /
 *      自定义），而接口只认两个日期。换算放在这里，页面只负责把结果写进地址栏。
 *
 * 为什么不把两者塞进页面组件：这些规则一旦写在 JSX 里，只有开浏览器才能验；
 * 而「本月」该从哪天算起、「单日」落在哪一天，恰恰是最容易在月初月末出错的地方。
 */

/** 七个入口对应的视图标识。与 `OPS_VIEWS` 的 key 一致。 */
export type OpsView = 'screen' | 'trade' | 'items' | 'flow' | 'service' | 'ads' | 'content'

/**
 * 导航编号 → 视图。
 *
 * 用 `NavCode` 做键而不是用路径字符串：路径可以改，编号是身份。漏映射时返回 null，
 * 由调用方渲染兜底，而不是悄悄落到第一个视图 —— 那会让「新增入口忘了接页面」
 * 表现成「点进去看到的是数据大屏」。
 */
const NAV_VIEW: Partial<Record<NavCode, OpsView>> = {
  [NAV_CODES.DASHBOARD]: 'screen',
  [NAV_CODES.OPS_TRADE]: 'trade',
  [NAV_CODES.OPS_ITEMS]: 'items',
  [NAV_CODES.OPS_FLOW]: 'flow',
  [NAV_CODES.OPS_SERVICE]: 'service',
  [NAV_CODES.OPS_ADS]: 'ads',
  [NAV_CODES.OPS_CONTENT]: 'content',
}

export function viewFromNav(code: NavCode): OpsView | null {
  return NAV_VIEW[code] ?? null
}

/** 是否属于运营看板的七个入口。路由分派用它判断要不要交给 `OpsDashboardPage`。 */
export function isOpsNavCode(code: NavCode): boolean {
  return NAV_VIEW[code] !== undefined
}

/**
 * 区间预设。取值与原型一致（`d1` / `7d` / `30d` / `tm` / `lm` / `custom`）。
 *
 * 地址栏里的参数名沿用 `p`：原型、既有文档与分享链接都用它，改名会让旧链接失效。
 */
export const OPS_PRESETS = [
  { key: 'd1', label: '单日' },
  { key: '7d', label: '近 7 天' },
  { key: '30d', label: '近 30 天' },
  { key: 'tm', label: '本月' },
  { key: 'lm', label: '上月' },
  { key: 'custom', label: '自定义' },
] as const

export type OpsPresetKey = (typeof OPS_PRESETS)[number]['key']
export type OpsPreset = OpsPresetKey

export function isOpsPreset(value: string | null): value is OpsPreset {
  return OPS_PRESETS.some((preset) => preset.key === value)
}

/**
 * 从地址参数解析出「当前是哪个区间档」。
 *
 * `p` 缺省、但地址里带了一对合法的 `from` / `to` 时，按**自定义**理解。这一条不是
 * 锦上添花：看板的链接经常是手拼的（发给同事、贴进工单、从采集日期反查），只写两端
 * 日期是最自然的写法。若这时静默回落到「近 30 天」，页面会显示一个既不是链接里那个、
 * 也没有任何提示的区间 —— 用户会以为「那天就是这些数」。
 *
 * `p` 有值但不是合法档位（拼错、旧链接），且两端日期合法时，同样按自定义理解：
 * 能确定的事实优先于猜错的标签。
 */
export function resolvePreset(presetParam: string | null, custom: OpsDateRange | null): OpsPreset {
  if (isOpsPreset(presetParam)) return presetParam
  if (custom !== null && opsRangeDays(custom) > 0) return 'custom'
  return '30d'
}

/** 预设 → 天数。`custom` / 月份类没有固定天数，返回 null。 */
export function presetDays(preset: OpsPreset): number | null {
  switch (preset) {
    case 'd1':
      return 1
    case '7d':
      return 7
    case '30d':
      return 30
    case 'tm':
    case 'lm':
    case 'custom':
      return null
  }
}

/** `2026-10-18` → `2026-10-01`。非法输入原样返回，由调用方拦住。 */
export function monthStart(iso: string): string {
  return `${iso.slice(0, 7)}-01`
}

/**
 * 月末。
 *
 * 用「下月 1 日减一天」而不是写死 28/30/31：闰年 2 月与大小月都能一次算对，
 * 而这类错误只在特定月份出现，测试很容易漏。
 */
export function monthEnd(iso: string): string {
  const date = parseOpsDate(monthStart(iso))
  if (date === null) return iso
  const nextMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1, 12))
  const nextIso = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01`
  return addOpsDays(nextIso, -1)
}

/**
 * 把预设换算成具体区间，**以数据覆盖范围为界**。
 *
 * `coverage` 是库里实际有数的首尾两天（`flags.covered`）。用数据末日而不是今天作为
 * 锚点，是本模块的一条硬规则：采集天然滞后一天，按今天算会让「近 7 天」里塞进两天空白，
 * 而用户在后台看到的是 7 天都有数 —— 两边的数字必然对不上。
 *
 * 返回 null 表示这个预设在当前数据下没有意义（例如上月整月都在数据范围之前）。
 * 调用方据此显示「该区间无数据」，而不是悄悄换成默认区间。
 */
export function presetRange(
  preset: OpsPreset,
  coverage: OpsDateRange,
  custom: OpsDateRange | null,
): OpsDateRange | null {
  const days = presetDays(preset)

  if (preset === 'custom') {
    if (custom === null) return null
    return opsRangeDays(custom) > 0 ? custom : null
  }

  if (days !== null) {
    const from = addOpsDays(coverage.to, -(days - 1))
    // 夹到数据起点：9 月 19 日之前没有数，请求出去只会换回一片空。
    return { from: from < coverage.from ? coverage.from : from, to: coverage.to }
  }

  if (preset === 'tm') {
    const from = monthStart(coverage.to)
    const start = from < coverage.from ? coverage.from : from
    return opsRangeDays({ from: start, to: coverage.to }) > 0
      ? { from: start, to: coverage.to }
      : null
  }

  // 上月：整月，且夹在数据范围内。月初时上月可能整段都在数据之前 → null。
  const previousMonthAnchor = addOpsDays(monthStart(coverage.to), -1)
  const from = monthStart(previousMonthAnchor)
  const to = monthEnd(previousMonthAnchor)
  const start = from < coverage.from ? coverage.from : from
  const end = to > coverage.to ? coverage.to : to
  return opsRangeDays({ from: start, to: end }) > 0 ? { from: start, to: end } : null
}

/**
 * 时间条右侧的说明。**七个入口一视同仁**，没有哪个视图可以不给区间控件。
 *
 * 2026-10-30 之前，服务 / 推广 / 内容三栏走的是时间条的 `simple` 模式：只显示一行
 * 「30 天整段快照」，把六档预设与两个日期框整块藏起来。当时的理由是那三页的数字
 * 不随区间变，摆一个点了不动的控件像坏了。实际效果相反 —— 同一排按钮在三个入口里
 * 凭空消失，用户第一反应是「这页没加载完」。
 *
 * 现在统一给出控件，用一句话说清「这个区间的数字是怎么来的」：
 *
 *   - 客服指标是单日口径（`OPS_DAILY_ONLY_SUMMARY_KEYS`），区间不累加，它决定的是
 *     「取用哪一天的单日快照」。不点明的话，用户会把 30 天响应率当成加权平均。
 *   - 推广 / 内容还没有真实数据，切换区间确实不会改变下方内容。与其藏控件，不如
 *     直说「尚未接入」，让「点了没反应」有一个明确解释。
 */
export function opsToolbarNote(view: OpsView, rangeLabel: string): string {
  switch (view) {
    case 'service':
      return `${rangeLabel} · 客服指标为单日口径，区间决定取用哪一天`
    case 'ads':
      return `${rangeLabel} · 推广指标尚未接入，切换区间暂不改变下方说明`
    case 'content':
      return `${rangeLabel} · 内容指标尚未接入，切换区间暂不改变下方说明`
    case 'screen':
    case 'trade':
    case 'items':
    case 'flow':
      return rangeLabel
  }
}

/** 区间说明。原型在时间条右侧写「数据范围 …（N 天）」，这里统一成一句。 */
export function rangeCaption(coverage: OpsDateRange | null, days: number): string {
  if (coverage === null) return `当前区间 ${days} 天`
  return `数据范围 ${coverage.from} ~ ${coverage.to}（${opsRangeDays(coverage)} 天）`
}

/**
 * 预设 → 请求参数。
 *
 * 固定天数（单日 / 近 7 / 近 30）直接交给服务端的 `days`：服务端以**库里最新一天**
 * 为锚，正是我们要的口径，而且不需要前端先知道数据覆盖范围 —— 首屏因此只发一次请求。
 *
 * 月份类与自定义必须给具体两端：「本月」的起点由数据末日所在月决定，服务端无法从
 * 「N 天」推出来。首屏还不知道覆盖范围时（`coverage` 为 null）退回近 30 天，等第一份
 * 响应回来后再换成真正的月份区间 —— 这一次额外的请求只发生在打开「本月 / 上月」时。
 */
export type OpsRangeQuery = { days: number } | { from: string; to: string }

export function presetQuery(
  preset: OpsPreset,
  coverage: OpsDateRange | null,
  custom: OpsDateRange | null,
): OpsRangeQuery {
  const days = presetDays(preset)
  if (days !== null) return { days }

  if (preset === 'custom') {
    return custom !== null && opsRangeDays(custom) > 0
      ? { from: custom.from, to: custom.to }
      : { days: 30 }
  }

  // tm / lm：还不知道覆盖范围时先按 30 天取一份，拿到响应后立刻换成月份区间。
  if (coverage === null) return { days: 30 }
  const range = presetRange(preset, coverage, null)
  return range === null ? { days: 30 } : { from: range.from, to: range.to }
}
