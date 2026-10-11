import type { Event, EventPriority, EventStatus } from '@fanhe/shared'

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
