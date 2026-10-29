import type { OpsDailyPoint } from '@fanhe/shared'

import { OPS_SCREEN_SERIES, seriesValue, type OpsScreenSeriesKey } from './ops-series.ts'

/**
 * 折线图的悬停读数。
 *
 * 曲线本身是 `<path>`，一条 path 覆盖整段 X 轴，**没有任何可悬停的「点」** ——
 * 所以浏览器原生 `<title>` 在这里给不出「这一天」的读数（它只会显示整条线的说明）。
 * 要按日读数就必须自己把鼠标位置换算成数据点下标。
 *
 * 换算规则写在这里而不是组件里：边界条件（只有一个点、鼠标越出绘图区、数据为空）
 * 都不是「看一眼就知道对不对」的，写成纯函数才能在 node 里钉住。
 */

/** 鼠标在绘图区里的相对位置（0~1）换算成最近的数据点下标。 */
export function hoverIndexAt(ratio: number, count: number): number | null {
  if (count <= 0) return null
  if (!Number.isFinite(ratio)) return null
  if (count === 1) return 0
  const clamped = Math.min(1, Math.max(0, ratio))
  /*
   * 四舍五入而不是向下取整：指针落在两点正中间时，取更近的那一个。用 floor 会让
   * 右半边整体错位一格，而错位一格在趋势图上是「读到了隔壁那天的数」，不会报错。
   */
  return Math.round(clamped * (count - 1))
}

/** 数据点下标换算回绘图区相对位置（0~1），用于摆放竖线与提示框。 */
export function hoverRatioAt(index: number, count: number): number {
  if (count <= 1) return 0.5
  const clamped = Math.min(count - 1, Math.max(0, index))
  return clamped / (count - 1)
}

export type HoverRow = {
  key: OpsScreenSeriesKey
  label: string
  color: string
  text: string
}

/**
 * 提示框里要显示的行：只列当前启用的曲线，顺序与图例一致。
 *
 * 未启用的曲线不显示，否则提示框会与图上的线对不上 —— 用户会去找一条看不见的线。
 */
export function hoverRows(
  point: OpsDailyPoint,
  enabled: readonly OpsScreenSeriesKey[],
): HoverRow[] {
  return OPS_SCREEN_SERIES.filter((item) => enabled.includes(item.key)).map((item) => ({
    key: item.key,
    label: item.label,
    color: item.color,
    text: item.format(seriesValue(point, item.key)),
  }))
}
