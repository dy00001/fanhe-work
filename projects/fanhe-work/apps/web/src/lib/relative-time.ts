/**
 * 相对时间的展示。
 *
 * 用 `Intl.RelativeTimeFormat` 而不是自己拼字符串。它的输出是本地化的（「3 分钟前」
 * 「昨天」），而这些说法在中文里并不规则 —— 手写一份很快就会在「1 天前」与「昨天」
 * 这类边界上出错，而且没有地方可以改。浏览器内置的这份实现已经把这些边界处理好了。
 *
 * 时间精度取「最大的那一个完整单位」，不显示两级（「1 小时 23 分前」）：这个板块用
 * 它回答的是「多久没成功启动过了」，量级比精确值重要，而两级会让每一行的宽度都不一样。
 */

const RELATIVE = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' })

/**
 * 单位换算表，从大到小。
 *
 * 月与年用近似值（30 天、365 天）：这里的用途是「多久以前」的量级，不是日历计算。
 * 真要算日历差需要知道时区与月份长度，那是另一件事，而结论对用户没有区别 ——
 * 「上个月」与「31 天前」传达的是同一件事。
 */
const UNITS: readonly { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: 'year', ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: 'month', ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: 'day', ms: 24 * 60 * 60 * 1000 },
  { unit: 'hour', ms: 60 * 60 * 1000 },
  { unit: 'minute', ms: 60 * 1000 },
  { unit: 'second', ms: 1000 },
]

/**
 * 把一个 ISO 时刻说成相对现在的话。
 *
 * `now` 可传入，只为让调用方能固定基准（测试与「同一屏里多行要一致」的场景）。
 *
 * 解析不了的值原样返回：它只可能来自手工改库，界面不该因为一个时间戳而白掉 ——
 * 显示一个看不懂的字符串，也比抛异常好。
 */
export function formatRelativeTime(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return iso

  const diff = at - now
  for (const { unit, ms } of UNITS) {
    if (Math.abs(diff) >= ms) {
      // 向下取整而不是四舍五入：1.9 天说成「昨天」比说成「2 天前」更贴近事实，
      // 而四舍五入会把刚过去的一点时间说成更大的量级。
      return RELATIVE.format(Math.trunc(diff / ms), unit)
    }
  }

  // 差不到一秒时统一用零秒，避免放大毫秒级偏差；`numeric: 'auto'` 在 zh-CN 下
  // 输出「现在」，而不是「刚刚」或「0 秒后」，因此保留 Intl 的本地化结果。
  return RELATIVE.format(0, 'second')
}
