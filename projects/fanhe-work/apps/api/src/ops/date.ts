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
