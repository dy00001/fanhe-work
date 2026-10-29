import type { OpsDailyPoint } from '@fanhe/shared'

import { formatCount, formatFen, formatPercent } from './ops-display.ts'

/**
 * 数据大屏的四条曲线。
 *
 * 放在 lib 而不是组件文件里：组件文件同时导出常量会让 Vite 的热更新退化成整页刷新
 * （与 `ops-view.ts` 同一条理由）。这里的 `format` 只用于图例与提示，不参与纵轴计算 ——
 * 四条曲线各自按自身峰值归一，只比趋势不比高低。
 */
export type OpsScreenSeriesKey = 'payAmountFen' | 'visitors' | 'payBuyers' | 'payRate'

export const OPS_SCREEN_SERIES: readonly {
  key: OpsScreenSeriesKey
  label: string
  color: string
  format: (value: number | null) => string
}[] = [
  {
    key: 'payAmountFen',
    label: '支付金额',
    color: 'var(--m-neutral)',
    format: (value) => formatFen(value, { compact: true }),
  },
  { key: 'visitors', label: '访客数', color: 'var(--m-blue)', format: formatCount },
  { key: 'payBuyers', label: '支付买家', color: 'var(--m-teal)', format: formatCount },
  {
    key: 'payRate',
    label: '支付转化率',
    color: 'var(--m-purple)',
    format: (value) => formatPercent(value),
  },
]

/**
 * 取某一天某一项指标的数值。
 *
 * 转化率是**算出来的**，库里没有这一列：它由买家数与访客数相除得到，访客为 0 时
 * 没有意义（不是 0%，是「算不出来」），所以返回 `null` 而不是 0 —— 折线遇到 null
 * 会画到基线，看起来像「那天转化率是零」，与「那天没人来」是两回事。
 *
 * 放在这里而不是组件内：折线绘制与悬停提示都要用它，两处各写一份迟早会漂。
 */
export function seriesValue(point: OpsDailyPoint, key: OpsScreenSeriesKey): number | null {
  if (key === 'payRate') {
    if (point.payBuyers === null || point.visitors === null || point.visitors === 0) return null
    return point.payBuyers / point.visitors
  }
  return point[key]
}
