/**
 * 业务日与数据库 DATE 列的互转。
 *
 * 这两件事**不能**直接用共享包的 `parseOpsDate`：那个函数按 UTC 正午解析，是为了
 * 让加减天数的运算落在安全区间（避免夏令时与闰秒把 00:00 推到前一天）；而 pg 的
 * `DATE` 列在读写时按 UTC 零点对齐，传一个正午的时间戳过去，西部时区的驱动会把它
 * 截成前一天。
 *
 * 于是这里只做一件事：字符串 ↔ 零点。区间算术仍然走共享包，两边职责不重叠。
 */

/** `YYYY-MM-DD` → DATE 列可用的 Date（UTC 零点）。非法输入返回 null。 */
export function toDbDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(date.getTime())) return null
  // 回读校验，挡掉 2026-02-31 这类会被 Date 静默滚到下个月的输入。
  return date.toISOString().slice(0, 10) === value ? date : null
}

/** DATE 列 → `YYYY-MM-DD`。null 原样返回，不造一个假日期。 */
export function fromDbDate(value: Date | null): string | null {
  if (value === null) return null
  return value.toISOString().slice(0, 10)
}

/** 列表用：把 DATE 列批量转成字符串，保持顺序。 */
export function fromDbDateList(values: readonly Date[]): string[] {
  return values.map((value) => value.toISOString().slice(0, 10))
}

const MS_PER_DAY = 24 * 60 * 60 * 1000

/** 按 UTC 零点算天数差。两个参数都必须是 `toDbDate` 产出的零点，混入带时分秒的值会得到小数。 */
function daySpan(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MS_PER_DAY)
}

/**
 * 两个闭区间的重叠天数。不相交返回 0。
 *
 * 用日期字符串直接比较而不是转 Date：`YYYY-MM-DD` 的字典序与时间序一致，少一处
 * 时区换算就少一处出错的地方。
 */
export function rangeOverlapDays(
  a: { from: string; to: string },
  b: { from: string; to: string },
): number {
  const start = a.from > b.from ? a.from : b.from
  const end = a.to < b.to ? a.to : b.to
  if (start > end) return 0
  const startDate = toDbDate(start)
  const endDate = toDbDate(end)
  if (startDate === null || endDate === null) return 0
  return daySpan(startDate, endDate) + 1
}

/**
 * 在候选快照里挑「与查询区间最贴合」的那一份，返回下标；没有候选返回 -1。
 *
 * **为什么不是简单取最新。** 维度快照带的窗口是它自己的事实范围：30 天排行说的是
 * 「这 30 天」，单日排行说的是「那一天」。日增采集上线后，库里会同时存在一份 30 天
 * 快照和此后每天一份的单日快照。若仍按 `statTo` 取最新，看「近 30 天」时商品榜会
 * 变成「最新一天的前 5 名」—— 数字本身没错，但它回答的不是用户问的那个问题，而且
 * 那份数据在页面上并不会自己说明「我只覆盖一天」。
 *
 * 规则按优先级：
 *   1. 与查询区间重叠天数最多的（重叠 0 的不参与）；
 *   2. 重叠天数相同时取 `to` 更晚的（同等覆盖下用更新的数据）；
 *   3. 再相同取 `from` 更晚的（窗口更短、更精确的那一份）。
 *
 * 全部不相交时退回第 0 个（调用方已按 `statTo` 降序传入），保留旧行为 —— 那种情况
 * 说明库里根本没有覆盖该区间的快照，给一个最近的、并在界面上标出它自己的窗口，
 * 比返回空表更有用。
 */
export function pickSnapshotIndex(
  windows: readonly { from: string; to: string }[],
  range: { from: string; to: string },
): number {
  let best = 0
  let bestOverlap = windows[0] === undefined ? 0 : rangeOverlapDays(windows[0], range)
  for (let index = 1; index < windows.length; index += 1) {
    const window = windows[index]
    if (window === undefined) continue
    const overlap = rangeOverlapDays(window, range)
    if (overlap > bestOverlap) {
      best = index
      bestOverlap = overlap
      continue
    }
    if (overlap !== bestOverlap) continue
    const current = windows[best]
    if (current === undefined) continue
    if (window.to > current.to || (window.to === current.to && window.from > current.from)) {
      best = index
    }
  }
  return windows.length === 0 ? -1 : best
}
