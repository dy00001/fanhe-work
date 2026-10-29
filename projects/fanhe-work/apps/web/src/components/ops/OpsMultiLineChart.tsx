import type { OpsDailyPoint } from '@fanhe/shared'
import { useState, type MouseEvent } from 'react'

import { shortDate } from '../../lib/ops-display'
import { hoverIndexAt, hoverRatioAt, hoverRows } from '../../lib/ops-hover'
import { OPS_SCREEN_SERIES, seriesValue, type OpsScreenSeriesKey } from '../../lib/ops-series'
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

      {usable.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground-weak">
          这段时间没有可画的逐日数据
        </p>
      ) : usable.length === 1 ? (
        /*
         * 只有一天时不画线，改为把四个指标直接列出来。
         *
         * 原实现是 `usable.length < 2` 一律显示「没有可画的逐日数据」，于是查单日
         * 时页面会声称「没数据」—— 那一天明明有 67 个访客。空态与「只有一格」
         * 是两件事：前者该说没数据，后者该给数、并说明为什么没有图。
         */
        <div className="py-4">
          <p className="text-center text-sm text-muted-foreground-weak">
            只有一天的数据，画不出趋势；四个指标的读数如下。
          </p>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {OPS_SCREEN_SERIES.map((item) => (
              <div key={item.key} className="rounded-md border border-border-soft px-2.5 py-2">
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: item.color }} />
                  {item.label}
                </div>
                <div className="mt-1 text-sm text-foreground tabular-nums">
                  {item.format(first === undefined ? null : seriesValue(first, item.key))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          <TrendPlot usable={usable} enabled={props.enabled} />

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

/**
 * 折线本体 + 悬停读数层。
 *
 * ## 为什么提示框是 HTML 而不是 SVG 里的 `<text>`
 *
 * `viewBox` 是 100×100，容器却是「宽几百像素、高 160 像素」，配
 * `preserveAspectRatio="none"` 意味着 X 与 Y 的缩放比不同。SVG 内的文字会被横向
 * 拉伸成畸形字 —— 这也是参考线要用 `vectorEffect` 保持 1px 的原因。所以只有竖线
 * 留在 SVG 里（细线不怕拉伸），提示框用 HTML 绝对定位叠在图上。
 *
 * ## 为什么按「最近的点」取读数而不是插值
 *
 * 这是逐日数据，日与日之间没有观测值。插值会凭空造出一个「10-23 12:00 支付金额
 * 多少」，读者没法分辨哪些数是采到的、哪些是算出来的。取最近点最多偏半格，但每个
 * 读数都对应真实的一天。
 */
function TrendPlot(props: {
  usable: readonly OpsDailyPoint[]
  enabled: readonly OpsScreenSeriesKey[]
}) {
  const [hover, setHover] = useState<number | null>(null)
  const usable = props.usable
  const active = hover === null ? null : (usable[hover] ?? null)
  const ratio = hover === null ? 0 : hoverRatioAt(hover, usable.length)

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    if (rect.width <= 0) return
    setHover(hoverIndexAt((event.clientX - rect.left) / rect.width, usable.length))
  }

  return (
    <div className="relative">
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-40 w-full overflow-visible"
        role="img"
        aria-label="四指标趋势，各曲线按自身峰值归一；鼠标移入可按日读数"
        onMouseMove={onMove}
        onMouseLeave={() => {
          setHover(null)
        }}
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
          const values = usable.map((point) => seriesValue(point, item.key))
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

        {/* 悬停竖线：告诉用户读数取的是哪一天，否则只有数字没有位置。 */}
        {hover === null ? null : (
          <line
            x1={ratio * 100}
            y1="0"
            x2={ratio * 100}
            y2="100"
            stroke="var(--foreground)"
            strokeWidth="1"
            strokeOpacity="0.25"
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>

      {active === null ? null : (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[8.5rem] rounded-lg border border-border bg-card px-2.5 py-2 shadow-md"
          style={{
            left: `${ratio * 100}%`,
            /*
             * 靠边时改锚点而不是让提示框溢出容器：`-translate-x-1/2` 在两端会把
             * 半个框推到可视区外，看起来像被裁掉了。
             */
            transform:
              ratio <= 0.2
                ? 'translateX(0)'
                : ratio >= 0.8
                  ? 'translateX(-100%)'
                  : 'translateX(-50%)',
          }}
        >
          <div className="text-[11px] text-muted-foreground">{active.date}</div>
          <ul className="mt-1 flex flex-col gap-0.5">
            {hoverRows(active, props.enabled).map((row) => (
              <li key={row.key} className="flex items-center gap-1.5 text-[11px]">
                <i
                  className="inline-block size-1.5 shrink-0 rounded-full"
                  style={{ background: row.color }}
                />
                <span className="text-muted-foreground">{row.label}</span>
                <b className="ml-auto pl-2 font-normal text-foreground tabular-nums">{row.text}</b>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
