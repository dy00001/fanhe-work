import { formatCount, formatFen, formatPercent } from './ops-display'

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
