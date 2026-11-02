import { activityWindow } from '@fanhe/shared'

/**
 * 客户平台两个栏目的筛选层。
 *
 * 综合看板与客户进度共用这一份：筛选状态整份存在地址栏，两栏各自从地址解析出同一
 * 个对象再发给同一接口。若把状态放在组件里，从看板点图表跳到进度页时筛选会丢，
 * 而丢掉之后列表显示的是一批与刚才那张图不对应的客户，界面上没有任何提示。
 *
 * **全部是纯函数，「现在」由调用方传进来。** 年、季、周该从哪天算起是这类代码里最
 * 容易在月初、季初、跨年出错的地方，写在组件里只有开浏览器才能验。
 */

/** 时间档位。取值写进地址的 `p` 参数，改名会让旧链接失效。 */
export type CustomerRangeKey = 'all' | 'year' | 'quarter' | 'month' | 'week' | 'day' | 'custom'

export const CUSTOMER_RANGE_OPTIONS = [
  { key: 'all', label: '全部' },
  { key: 'year', label: '年' },
  { key: 'quarter', label: '季' },
  { key: 'month', label: '月' },
  { key: 'week', label: '周' },
  { key: 'day', label: '日' },
  { key: 'custom', label: '自定义' },
] as const satisfies readonly { key: CustomerRangeKey; label: string }[]

/**
 * 一个已解析的时间区间。**半开区间**：含 `from`，不含 `to`。
 *
 * 半开是唯一能同时表达「按天」与「按小时」的写法：闭区间在按天时要写 23:59:59.999，
 * 那个毫秒值一旦漏掉，当天最后一秒的消息就落在区间外，而差一秒的结果看起来完全正常。
 */
export type CustomerRange = {
  key: CustomerRangeKey
  /** 起点（含）。`null` 表示不限。 */
  from: Date | null
  /** 终点（不含）。`null` 表示不限。 */
  to: Date | null
  /** 栏目上显示的区间说明，例如「本月（10-01 ~ 10-31）」。 */
  label: string
  /** 地址里的起点写法。`null` 表示不写进地址。 */
  fromParam: string | null
  toParam: string | null
  /**
   * 地址里的自定义参数不合法时为真。此时区间回落到「全部」，界面据此提示一句，
   * 避免用户看着一个既不是链接里那个、也没有任何解释的区间。
   */
  degraded: boolean
}

const HOUR_MS = 60 * 60 * 1000

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 本地零点。用本地时区而不是 UTC：界面上说的「今天」是日历上的今天。 */
export function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

/** `MM-DD`。区间标签上不重复写年份，跨年时才补。 */
function monthDay(value: Date): string {
  return `${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}

function hourMinute(value: Date): string {
  return `${pad(value.getHours())}:${pad(value.getMinutes())}`
}

/**
 * 日期 → 地址参数。
 *
 * 零点整写成 `2026-10-30`，其余写成 `2026-10-30T14:00`。两种写法都能被服务端按
 * 本地时区解析，且地址栏里一眼能看出筛的是哪一天或哪一个小时。
 */
export function formatRangeParam(value: Date): string {
  const day = `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  if (value.getHours() === 0 && value.getMinutes() === 0) return day
  return `${day}T${hourMinute(value)}`
}

/**
 * 地址参数 → 日期。非法返回 `null`，不兜底成「今天」。
 *
 * 兜底会把「链接被截断」伪装成「今天的数据」，而这两件事的处理方式完全不同。
 */
export function parseRangeParam(text: string | null | undefined): Date | null {
  if (text === null || text === undefined) return null
  const trimmed = text.trim()
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(trimmed)) return null

  const parsed = new Date(dateOnly ? `${trimmed}T00:00:00` : `${trimmed}:00`)
  if (Number.isNaN(parsed.getTime())) return null
  // 拼回去比对，挡住 `2026-02-31` 被 Date 静默滚到 3 月。
  return formatRangeParam(parsed) === trimmed ? parsed : null
}

export function isCustomerRangeKey(value: string | null | undefined): value is CustomerRangeKey {
  return CUSTOMER_RANGE_OPTIONS.some((option) => option.key === value)
}

/**
 * 预设档位 → 区间。
 *
 * 周从周一起算（国内习惯），季按自然季度（1/4/7/10 月起），两者都用 `to` 表达
 * 「下一档的起点」，因此区间里不会出现 23:59 这类末端时刻。
 */
export function presetRange(
  key: Exclude<CustomerRangeKey, 'all' | 'custom'>,
  now: Date,
): {
  from: Date
  to: Date
} {
  const today = startOfLocalDay(now)
  switch (key) {
    case 'day':
      return { from: today, to: addDays(today, 1) }
    case 'week': {
      // `getDay()` 的周日是 0，要折成 7 才能让周一当首日。
      const weekday = today.getDay() === 0 ? 7 : today.getDay()
      const from = addDays(today, 1 - weekday)
      return { from, to: addDays(from, 7) }
    }
    case 'month': {
      const from = new Date(today.getFullYear(), today.getMonth(), 1)
      return { from, to: new Date(today.getFullYear(), today.getMonth() + 1, 1) }
    }
    case 'quarter': {
      const quarterStart = Math.floor(today.getMonth() / 3) * 3
      return {
        from: new Date(today.getFullYear(), quarterStart, 1),
        to: new Date(today.getFullYear(), quarterStart + 3, 1),
      }
    }
    case 'year':
      return {
        from: new Date(today.getFullYear(), 0, 1),
        to: new Date(today.getFullYear() + 1, 0, 1),
      }
  }
}

/**
 * 区间文案。
 *
 * 按天与按小时分开写：按小时的区间（图表下钻点出来的那一格）如果只写日期，会被
 * 读成「一整天」，而列表里只有那一小时内的客户，看起来就像漏数据。
 *
 * 「同一天」按日历日比较，不按毫秒比较：半开区间的终点是次日零点，直接比时间戳
 * 永远不会相等，于是「只看这一天」会被写成「10-30 ~ 10-30」。
 */
export function rangeLabel(from: Date | null, to: Date | null): string {
  if (from === null && to === null) return '全部时间'
  if (from === null || to === null) {
    const single = from ?? to
    return single === null ? '全部时间' : `自 ${monthDay(single)} 起`
  }

  // `to` 是开区间终点，退一毫秒得到「最后一天」。
  const last = new Date(to.getTime() - 1)
  const sameDay =
    from.getFullYear() === last.getFullYear() &&
    from.getMonth() === last.getMonth() &&
    from.getDate() === last.getDate()

  if (from.getHours() === 0 && from.getMinutes() === 0) {
    if (sameDay) return monthDay(from)
    // 跨年时把年份补上，否则「12-01 ~ 01-15」分不清是往前还是往后。
    if (from.getFullYear() !== last.getFullYear()) {
      return `${fullDay(from)} ~ ${fullDay(last)}`
    }
    return `${monthDay(from)} ~ ${monthDay(last)}`
  }

  return sameDay
    ? `${monthDay(from)} ${hourMinute(from)} ~ ${hourMinute(to)}`
    : `${monthDay(from)} ${hourMinute(from)} ~ ${monthDay(last)} ${hourMinute(to)}`
}

/** `YYYY-MM-DD`。跨年区间才用它，平时不重复写年份。 */
function fullDay(value: Date): string {
  return `${value.getFullYear()}-${monthDay(value)}`
}

const PRESET_LABEL: Record<Exclude<CustomerRangeKey, 'custom'>, string> = {
  all: '全部时间',
  day: '今天',
  week: '本周',
  month: '本月',
  quarter: '本季',
  year: '本年',
}

/**
 * 地址参数 → 区间。
 *
 * `p` 缺省按「全部」理解。`p=custom` 但两端不完整或非法时回落到「全部」并置
 * `degraded`，由界面显式提示一句。
 */
export function resolveCustomerRange(
  input: { preset: string | null; from: string | null; to: string | null },
  now: Date,
): CustomerRange {
  const key: CustomerRangeKey = isCustomerRangeKey(input.preset) ? input.preset : 'all'

  if (key === 'custom') {
    const from = parseRangeParam(input.from)
    const to = parseRangeParam(input.to)
    if (from !== null && to !== null && to.getTime() > from.getTime()) {
      return {
        key,
        from,
        to,
        label: rangeLabel(from, to),
        fromParam: formatRangeParam(from),
        toParam: formatRangeParam(to),
        degraded: false,
      }
    }
    return {
      key: 'all',
      from: null,
      to: null,
      label: PRESET_LABEL.all,
      fromParam: null,
      toParam: null,
      degraded: true,
    }
  }

  if (key === 'all') {
    return {
      key,
      from: null,
      to: null,
      label: PRESET_LABEL.all,
      fromParam: null,
      toParam: null,
      degraded: false,
    }
  }

  const { from, to } = presetRange(key, now)
  return {
    key,
    from,
    to,
    label: `${PRESET_LABEL[key]}（${rangeLabel(from, to)}）`,
    fromParam: null,
    toParam: null,
    degraded: false,
  }
}

/**
 * 自定义区间的日期输入框该显示什么。
 *
 * 输入框是**闭区间**语义（用户选 10-01 到 10-15 就是含 15 日），而地址里的 `to`
 * 是开区间终点。换算集中在这里，别让组件自己减一天。
 */
export function customInputs(range: CustomerRange): { from: string; to: string } {
  if (range.from === null || range.to === null) return { from: '', to: '' }
  const fromDay = formatRangeParam(range.from)
  const last = new Date(range.to.getTime() - 1)
  return {
    from: fromDay.slice(0, 10),
    to: formatRangeParam(last).slice(0, 10),
  }
}

/**
 * 用起止日期构造自定义区间（输入框语义：两端都含）。
 *
 * 两端相同的一天是常态（「就看这一天」），因此不要求 `from < to`，只要求合法。
 */
export function customRange(fromText: string, toText: string): CustomerRange | null {
  const from = parseRangeParam(fromText)
  const end = parseRangeParam(toText)
  if (from === null || end === null) return null
  const to = addDays(end, 1)
  if (to.getTime() <= from.getTime()) return null
  return {
    key: 'custom',
    from,
    to,
    label: rangeLabel(from, to),
    fromParam: formatRangeParam(from),
    toParam: formatRangeParam(to),
    degraded: false,
  }
}

/**
 * 区间 → 请求接口用的 `from` / `to`。
 *
 * **必须是地址里那套短格式**（`YYYY-MM-DD` 或 `YYYY-MM-DDTHH:mm`），不能拿
 * `Date` 直接 `toISOString()`。两个理由各自都能把功能打挂：
 *
 *   1. 服务端的 `LIST_QUERY_SCHEMA` 只认这两种写法，完整 ISO 会命中 pattern 校验，
 *      整个列表回 400「querystring/from must match pattern」；
 *   2. 完整 ISO 末尾那个 `Z` 是 UTC。东八区的「本月」按 UTC 解释会退成上月最后
 *      一天的 16:00，数据少一天而界面上没有任何提示。
 *
 * 把这件事放在这里而不是留在页面里，是因为页面里那一行出错时只在浏览器里才看得见。
 */
export function rangeQuery(range: CustomerRange): { from: string; to: string } {
  return {
    from: range.from === null ? '' : formatRangeParam(range.from),
    to: range.to === null ? '' : formatRangeParam(range.to),
  }
}

/**
 * 某一个整点小时的区间，供活跃度折线下钻。
 */
export function hourRange(hourStart: string): CustomerRange | null {
  const from = new Date(hourStart)
  if (Number.isNaN(from.getTime())) return null
  const to = new Date(from.getTime() + HOUR_MS)
  return {
    key: 'custom',
    from,
    to,
    label: rangeLabel(from, to),
    fromParam: formatRangeParam(from),
    toParam: formatRangeParam(to),
    degraded: false,
  }
}

/**
 * 当前时间筛选与最近 24 小时有没有交集。
 *
 * 没有交集时活跃度折线必然是空的。这不是故障，但空图不解释就会被当成故障，
 * 界面按这个判断补一句说明。
 */
export function overlapsActivity(range: CustomerRange, now: Date): boolean {
  const window = activityWindow(now)
  if (range.from !== null && range.from.getTime() >= window.end.getTime()) return false
  if (range.to !== null && range.to.getTime() <= window.start.getTime()) return false
  return true
}

// ---------------------------------------------------------------------------
// 筛选状态与地址栏
// ---------------------------------------------------------------------------

/** 两个栏目共用的筛选状态。 */
export type CustomerFilters = {
  range: CustomerRange
  scope: string
  stage: string
  q: string
  pendingReview: boolean
}

export type CustomerFilterKey = 'range' | 'scope' | 'stage' | 'q' | 'review'

export const SCOPE_OPTIONS = [
  { value: 'domestic', label: '国内' },
  { value: 'overseas', label: '海外' },
  { value: 'special-region', label: '港澳台' },
] as const

export function filtersFromParams(params: URLSearchParams, now: Date): CustomerFilters {
  return {
    range: resolveCustomerRange(
      { preset: params.get('p'), from: params.get('from'), to: params.get('to') },
      now,
    ),
    scope: params.get('scope') ?? '',
    stage: params.get('stage') ?? '',
    q: params.get('q') ?? '',
    pendingReview: params.get('review') === 'pending',
  }
}

/**
 * 筛选状态 → 地址参数。**默认值不写进地址**：一屏筛选全空时地址应当是干净的
 * `/customer/overview`，带一串 `p=all&scope=&stage=` 的链接既难读也难比对。
 */
export function filtersToParams(filters: CustomerFilters): URLSearchParams {
  const params = new URLSearchParams()
  const { range } = filters
  if (range.key !== 'all') params.set('p', range.key)
  if (range.key === 'custom' && range.fromParam !== null && range.toParam !== null) {
    params.set('from', range.fromParam)
    params.set('to', range.toParam)
  }
  if (filters.scope !== '') params.set('scope', filters.scope)
  if (filters.stage !== '') params.set('stage', filters.stage)
  if (filters.q !== '') params.set('q', filters.q)
  if (filters.pendingReview) params.set('review', 'pending')
  return params
}

/** 移除一个筛选条件。用于筛选标签上的叉号。 */
export function clearFilter(filters: CustomerFilters, key: CustomerFilterKey): CustomerFilters {
  switch (key) {
    case 'range':
      return {
        ...filters,
        range: resolveCustomerRange({ preset: 'all', from: null, to: null }, new Date(0)),
      }
    case 'scope':
      return { ...filters, scope: '' }
    case 'stage':
      return { ...filters, stage: '' }
    case 'q':
      return { ...filters, q: '' }
    case 'review':
      return { ...filters, pendingReview: false }
  }
}

/** 生效中的条件数。为 0 时「重置」按钮置灰，避免点一个不会改变任何东西的按钮。 */
export function activeFilterCount(filters: CustomerFilters): number {
  let count = 0
  if (filters.range.key !== 'all') count += 1
  if (filters.scope !== '') count += 1
  if (filters.stage !== '') count += 1
  if (filters.q !== '') count += 1
  if (filters.pendingReview) count += 1
  return count
}

/** 两栏共用的请求指纹。切换栏目时若筛选没变，指纹不变，列表不会重新闪一次加载态。 */
export function filtersKey(filters: CustomerFilters): string {
  return [
    filters.range.from?.toISOString() ?? '',
    filters.range.to?.toISOString() ?? '',
    filters.scope,
    filters.stage,
    filters.q,
    String(filters.pendingReview),
  ].join('\u0000')
}
