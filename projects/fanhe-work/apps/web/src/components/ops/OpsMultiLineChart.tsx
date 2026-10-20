import type { OpsDailyPoint } from '@fanhe/shared'

import { shortDate } from '../../lib/ops-display'
import { OPS_SCREEN_SERIES, type OpsScreenSeriesKey } from '../../lib/ops-series'
import { cn } from '../../lib/utils'

/**
 * 数据大屏的四指标趋势（折线）。结构与原型 `lineChartSVG()` 一致。
 *
 * **四条曲线各自按自己的峰值归一**，只比趋势不比高低。这不是偷懒：支付金额与转化率
 * 差六个数量级，同一纵轴下转化率会贴成一条直线。原型为此在图上写明「只比趋势」，
 * 这里沿用同一句话 —— 让读者知道纵轴不是同一个刻度，比给四个刻度轴更好读。
 *
 * 为什么是折线而不是柱：大屏要同时看四个量的**走向是否同步**（成交涨、访客跌，
 * 说明转化在改善）。柱状图在四条并列时互相遮挡，折线不会。
 */
export type OpsSeriesKey = OpsScreenSeriesKey

function valueOf(point: OpsDailyPoint, key: OpsSeriesKey): number | null {
  if (key === 'payRate') {
    if (point.payBuyers === null || point.visitors === null || point.visitors === 0) return null
    return point.payBuyers / point.visitors
  }
  return point[key]
}

export function OpsMultiLineChart(props: {
  series: readonly OpsDailyPoint[]
  enabled: readonly OpsSeriesKey[]
  onToggle: (key: OpsSeriesKey) => void
}) {
  const points = props.series
  const usable = points.filter((point) => point.payAmountFen !== null || point.visitors !== null)
  const first = usable[0]
  const last = usable[usable.length - 1]

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {OPS_SCREEN_SERIES.map((item) => {
          const on = props.enabled.includes(item.key)
          return (
            <button
              key={item.key}
              type="button"
              aria-pressed={on}
              onClick={() => {
                props.onToggle(item.key)
              }}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[11px] transition-colors',
                on
                  ? 'border-border text-foreground'
                  : 'border-dashed border-border text-muted-foreground-weak',
              )}
              title={on ? `点击隐藏${item.label}` : `点击显示${item.label}`}
            >
              <i
                className="inline-block size-2 rounded-full"
                style={{
                  background: on ? item.color : 'transparent',
                  boxShadow: `inset 0 0 0 1px ${item.color}`,
                }}
              />
              {item.label}
            </button>
          )
        })}
      </div>

      {usable.length < 2 ? (
        <p className="py-8 text-center text-sm text-muted-foreground-weak">
          这段时间没有可画的逐日数据
        </p>
      ) : (
        <>
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            className="h-40 w-full overflow-visible"
            role="img"
            aria-label="四指标趋势，各曲线按自身峰值归一"
          >
            {/* 两条参考线：顶部与中线。只做视觉锚点，不标数值。 */}
            {[0, 50].map((y) => (
              <line
                key={y}
                x1="0"
                y1={y}
                x2="100"
                y2={y}
                stroke="var(--border)"
                strokeWidth="0.5"
                strokeDasharray="2 3"
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {OPS_SCREEN_SERIES.filter((item) => props.enabled.includes(item.key)).map((item) => {
              const values = usable.map((point) => valueOf(point, item.key))
              const peak = Math.max(1, ...values.map((value) => value ?? 0))
              const path = values
                .map((value, index) => {
                  const x = usable.length === 1 ? 50 : (index / (usable.length - 1)) * 100
                  const y = 100 - ((value ?? 0) / peak) * 96 - 2
                  return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`
                })
                .join(' ')
              return (
                <path
                  key={item.key}
                  d={path}
                  fill="none"
                  stroke={item.color}
                  strokeWidth="1.5"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              )
            })}
          </svg>

          <div className="flex justify-between text-[10px] text-muted-foreground-weak tabular-nums">
            <span>{first === undefined ? '' : shortDate(first.date)}</span>
            <span>各曲线按自身峰值归一，只比趋势不比高低</span>
            <span>{last === undefined ? '' : shortDate(last.date)}</span>
          </div>
        </>
      )}
    </div>
  )
}
