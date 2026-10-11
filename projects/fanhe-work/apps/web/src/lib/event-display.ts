import {
  isEventLogAction,
  type Event,
  type EventLogAction,
  type EventPriority,
  type EventStatus,
} from '@fanhe/shared'

/**
 * 事件板块的展示映射与派生判断。
 *
 * 放在 lib 而不是组件里，是为了**能被单测直接跑**：分组、逾期判定、时间在两个输入
 * 形态之间的往返，全是纯函数。把它们写进组件就等于把这几条规则锁在浏览器里 ——
 * 而它们恰恰是最容易在某次改动中被弄错的那部分（例如「逾期」把已完成的事件也算进去）。
 *
 * **这里只回答「怎么显示」，不回答「哪些算合法」。** 取值域与长度上限在共享包
 * （`event.ts`），校验两侧共用那一份；本文件只做取值到文案与样式的映射。
 */

/**
 * 优先级的中文说法。
 *
 * 写成 `Record<EventPriority, string>` 而不是散在各处的三目表达式：新增一档优先级时
 * 这里会在编译期报缺项，而散写的三目只会静默落进 `else` 分支，表现是「界面上多出
 * 一个没名字的档位」。
 */
export const EVENT_PRIORITY_LABELS: Record<EventPriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
}

/**
 * 优先级徽标的配色。
 *
 * **只有「高」是醒目的。** 三档里真正需要一眼看出来的只有它；把「低」也涂成一种颜色，
 * 一整列就都是颜色，而颜色一多就不再是信号。其余两档共用同一套中性色，靠文字区分。
 */
export const EVENT_PRIORITY_CLASSES: Record<EventPriority, string> = {
  low: 'border-border text-muted-foreground',
  normal: 'border-border text-foreground',
  high: 'border-destructive/30 bg-destructive/10 text-destructive',
}

/** 状态的中文说法。勾选框的替代文本也用它，见 `EventRow`。 */
export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  todo: '未完成',
  done: '已完成',
}

/**
 * 状态变更动作的中文说法。
 *
 * 只有这三个：写的一侧由服务端收口（见共享包里 `EVENT_LOG_ACTIONS` 的说明）。写成
 * `Record<EventLogAction, string>` 而不是三目表达式，理由与 `EVENT_PRIORITY_LABELS`
 * 相同 —— 将来多出第四种动作时，这里会在编译期报缺项。
 *
 * 注意「撤销完成」而不是「撤销」：详情面板上「撤销」会与提示条上那个「撤销」按钮
 * 撞词，而那两者是不同层面的东西（一个是回溯历史里发生过的事，一个是当下的一次操作）。
 */
export const EVENT_LOG_ACTION_LABELS: Record<EventLogAction, string> = {
  created: '创建',
  completed: '完成',
  reopened: '撤销完成',
}

/**
 * 一条日志的动作文案。
 *
 * **认不出的动作码原样返回。** 库侧对 `action` 没有约束，而这是一条只追加的历史：
 * 一个动作码在写入之后才被引入时，旧版本的代码读它必须能如实展示，而不是因为
 * 「类型上不该出现」就把它丢掉或显示成空白。共享包的 `isEventLogAction` 是「认不认得」
 * 的唯一判据，这里消费它的结论。
 */
export function eventLogActionText(action: string): string {
  return isEventLogAction(action) ? EVENT_LOG_ACTION_LABELS[action] : action
}

/**
 * 一条日志的状态流转，例如「未完成 → 已完成」。两端都可能缺：创建日志没有 `fromStatus`。
 * 两端都缺时返回 `null`，调用方据此不显示这一行。
 *
 * **只在动作码认不出来时才用它**（见 `eventLogActionText`）：认识的那三个动作，
 * 「完成」「撤销完成」本身已经说清了流向，再跟一句「未完成 → 已完成」是同一件事说两遍。
 * 而动作码不认识时，状态流转往往是**唯一**能看懂的线索，那时候它就不是冗余了。
 */
export function eventLogTransitionText(
  from: EventStatus | null,
  to: EventStatus | null,
): string | null {
  if (from !== null && to !== null) {
    return `${EVENT_STATUS_LABELS[from]} → ${EVENT_STATUS_LABELS[to]}`
  }
  if (from !== null) return EVENT_STATUS_LABELS[from]
  if (to !== null) return EVENT_STATUS_LABELS[to]
  return null
}

/**
 * 按状态把列表分成两组，**组内保持传入顺序**。
 *
 * 不做任何排序：顺序由服务端定（未完成在前、组内按截止时间升序、无截止时间的落在
 * 组尾），界面再排一遍就有了两份顺序定义，而它们会在某次改动后悄悄分叉 —— 那时的
 * 表现是「刚改完截止时间的那条没动位置」，很像是接口没生效。这里只做「挑出来」。
 *
 * 用两个数组而不是一个 `Map`：分组固定只有两个、界面也固定按这个顺序画两段，
 * 而 `Map` 的迭代顺序取决于插入顺序，读的人得先推一遍才确定「未完成」在前。
 */
export type EventGroups = {
  /** 未完成。 */
  open: readonly Event[]
  /** 已完成。 */
  done: readonly Event[]
}

export function groupEvents(events: readonly Event[]): EventGroups {
  const open: Event[] = []
  const done: Event[] = []
  for (const event of events) {
    if (event.status === 'done') done.push(event)
    else open.push(event)
  }
  return { open, done }
}

/**
 * 把列表里某一条的状态改成目标值，返回新数组；其余条目按原引用原样带过去。
 *
 * 这是勾选切换做**乐观更新**时改本地副本的那一步：点下去立刻按新状态重画，不等
 * 服务端回话。写成纯函数而不是在事件处理函数里就地改，一是能被单测钉住，二是它与
 * `groupEvents` 一样属于「怎么显示」，不该埋在一个 async 函数的中段。
 *
 * **只改 `status`，不碰 `completedAt` / `completedBy`。** 那两个是服务端的时间与身份
 * 快照，界面猜不出来（本机时钟可能偏，显示名还得再问一次会话）；而列表这一版也不
 * 展示它们 —— 展示要给 T3-12 的详情面板。这一步的全部作用就是让「点下去 → 界面重画」
 * 之间不等网络，权威版本紧接着由服务端返回的那条覆盖进来（见 `EventsPanel` 的
 * `handleToggle`）。
 *
 * **找不到 `id` 时原样返回。** 切换可能在「这条已被别处删掉」之后才回到界面，此时手上
 * 的列表里已经没有它 —— 为了「让它有个状态」而补一条进去，只会让它短暂复活，而用户
 * 看到的是一行凭空出现又消失。
 */
export function applyEventStatus(
  events: readonly Event[],
  id: string,
  status: EventStatus,
): readonly Event[] {
  return events.map((event) => (event.id === id ? { ...event, status } : event))
}

/**
 * 是否已逾期：设了截止时间、那个时刻已经过去、且**尚未完成**。
 *
 * **已完成的不再算逾期。** 一件做完了的事，当初的截止时间只影响「是按时还是晚了些」，
 * 而那个判断属于详情面板（T3-12 要展示耗时）。若在列表上继续标红，用户会看到一片
 * 红色却无从下手 —— 那些事他已经做完了。
 *
 * `now` 可传入，只为让测试能固定基准：不固定的话，用例会在某个具体时刻恰好翻转。
 */
export function isOverdue(event: Event, now: number = Date.now()): boolean {
  if (event.status === 'done' || event.dueAt === null) return false
  const at = Date.parse(event.dueAt)
  return !Number.isNaN(at) && at < now
}

/** 同一年内省略年份，跨年时补上（见 `formatDueAt` 的说明）。 */
const DUE_MONTH_DAY = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })
const DUE_FULL_DATE = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
})
const DUE_TIME = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * 把截止时间说成一句话，例如「10月15日 18:00」。
 *
 * **刻意不用相对时间**（「3 天后」）：截止时间要回答的是「哪一天之前」，而相对说法
 * 把一天之内的位置抹掉了 —— 而「今天 18:00」与「明天 09:00」谁更紧，正是排优先级时
 * 在看的东西。所以这里是绝对日期加时刻。
 *
 * 今年的日期省掉年份、跨年时补上：绝大多数截止时间落在今年，而一旦跨年，「1月3日」
 * 这种写法就产生了歧义。判断基准用 `now` 而不是「当前年」，同样是为了可测。
 *
 * 解析不了的值原样返回：它只可能来自手工改库。界面不该因为一个时间戳整行白掉 ——
 * 显示一个看不懂的字符串，也比抛异常好（与 `formatRelativeTime` 同一条处理）。
 */
export function formatDueAt(iso: string, now: number = Date.now()): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const date = at.getFullYear() === new Date(now).getFullYear() ? DUE_MONTH_DAY : DUE_FULL_DATE
  return `${date.format(at)} ${DUE_TIME.format(at)}`
}

const MOMENT_FULL = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/**
 * 一个完整时刻，例如「2026年10月11日 22:31」。详情面板用它。
 *
 * **与 `formatDueAt` 的区别只有一个：年份永远在。** 那里省略今年是为了让一列截止时间
 * 读起来短，而这里读的是一条已经发生过的历史 —— 历史可以跨年（一条两年前建的、去年
 * 完成的、今年才被撤销的事件，三个时刻同屏），省掉年份会让「10月11日」指向哪一年变得
 * 要靠上下文推。多出来的四个字在这里买的是「不必推」。
 *
 * 解析不了的值原样返回，与 `formatDueAt` 和 `formatRelativeTime` 同一条处理：界面不该
 * 因为一个时间戳整块白掉。
 */
export function formatMoment(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return MOMENT_FULL.format(at)
}

const SECOND_MS = 1000
const MINUTE_MS = 60 * SECOND_MS
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/**
 * 两个时刻之间的时长，例如「1 小时 23 分」。详情面板用它算「从创建到完成的耗时」。
 *
 * **取最大的两个单位，第二个为零时省略**（「2 小时」而不是「2 小时 0 分」）。只取最大
 * 一个单位的话，「3 天」会掩盖「3 天 2 小时」与「3 天 23 小时」的差别 —— 而详情面板上
 * 这个数字是给人看出量级与细度的，不像列表上的相对时间那样只需量级。取三个又会读成
 * 「1 小时 23 分 45 秒」，后两位在这里没有决策价值。
 *
 * 秒只出现在「不到一分钟」这一档（`45 秒`）；一旦进了分钟档，第二个单位就是秒。
 *
 * **反过来的区间返回 `null`。** `to` 早于 `from` 只可能来自手工改库或时钟回拨，而这时
 * 显示一个负数或「不到 1 秒」都是在替数据编一个说得通的说法。返回 `null`，让调用方
 * 显示成「—」，把「这里有个数但它是坏的」如实说出来。
 */
export function formatDuration(fromIso: string, toIso: string): string | null {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (Number.isNaN(from) || Number.isNaN(to)) return null

  const ms = to - from
  if (ms < 0) return null
  if (ms < SECOND_MS) return '不到 1 秒'

  if (ms < MINUTE_MS) return `${Math.floor(ms / SECOND_MS)} 秒`

  if (ms < HOUR_MS) {
    const minutes = Math.floor(ms / MINUTE_MS)
    const seconds = Math.floor((ms % MINUTE_MS) / SECOND_MS)
    return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`
  }

  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS)
    const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS)
    return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`
  }

  const days = Math.floor(ms / DAY_MS)
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS)
  return hours === 0 ? `${days} 天` : `${days} 天 ${hours} 小时`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * 把 ISO 时刻转成 `<input type="datetime-local">` 需要的本地时间串（`YYYY-MM-DDTHH:mm`）。
 *
 * **不能用 `toISOString().slice(0, 16)`。** 那是 UTC：本地时区不是 UTC 时，显示的
 * 时刻会整体挪走（东八区的 18:00 会显示成 10:00）。用户据此改一下再存回去，时间就
 * 被改掉了，而且从界面上完全看不出是谁改的。
 *
 * `null` 与解析不了的值都返回空串 —— 输入框的空值就是空串，两者在界面上的表现一致。
 */
export function toDateTimeLocalValue(iso: string | null): string {
  if (iso === null) return ''
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`
}

/**
 * 把 `datetime-local` 的值转回 ISO 时刻。空串表示**清除**截止时间，返回 `null`。
 *
 * 非空但解析不出来的值也返回 `null`：浏览器对这个输入框有取值约束，走进来的字符串
 * 只可能是合法形态，真出现别的东西说明它是在别处被构造的。表单仍会先做一次同样的
 * 判断并给出内联错误（见 `EventFormDialog` 的校验），这里只是不让一个坏值发出去。
 */
export function fromDateTimeLocalValue(value: string): string | null {
  if (value === '') return null
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at.toISOString()
}
