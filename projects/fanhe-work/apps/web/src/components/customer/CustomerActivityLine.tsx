import type { CustomerActivityPoint } from '@fanhe/shared'

import { activityCeiling, hourText, peakHourIndex } from '../../lib/customer-display'
import { cn } from '../../lib/utils'

/**
 * 近 24 小时活跃度折线。
 *
 * **口径先说清楚**：库里有的是每个客户的 `lastMessageAt`（最近一条消息的时刻），
 * 没有逐条消息表（消息原文留在微信本地库，导入只落汇总）。所以这张图回答的是
 * 「这一小时里有几位客户的最后一条消息落在这里」，回答不了「这一小时聊了多少句」。
 * 图下方的说明按前者写，否则会被读成后者。
 *
 * 手写 SVG 的理由与环形图相同。纵轴不压缩：这类图的纵轴语义是「高度等于数量」，
 * 压缩过的轴会让 3 位客户看起来像 30 位。
 */

const W = 600
const H = 160
const PAD_L = 30
const PAD_R = 10
const PAD_T = 12
const PAD_B = 26

export function CustomerActivityLine(props: {
  points: readonly CustomerActivityPoint[]
  /** 与当前时间筛选无交集时的说明。有值就顶掉默认说明。 */
  conflictNote?: string | null
  onSelectHour?: ((hourStart: string) => void) | undefined
  onFocusToday?: (() => void) | undefined
}) {
  const points = props.points
  const ceiling = activityCeiling(points)
  const peak = peakHourIndex(points)
  const total = points.reduce((sum, point) => sum + point.count, 0)
  const innerW = W - PAD_L - PAD_R
  const innerH = H - PAD_T - PAD_B

  const x = (index: number): number =>
    points.length <= 1 ? PAD_L : PAD_L + (index / (points.length - 1)) * innerW
  const y = (value: number): number => PAD_T + (1 - value / ceiling) * innerH

  const line = points.map((point, index) => `${x(index)},${y(point.count)}`).join(' ')
  const peakPoint = peak >= 0 ? points[peak] : undefined

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-medium text-foreground">近 24 小时活跃度</h3>
        <p className="ml-auto text-[11px] text-muted-foreground-weak">
          按小时统计最近消息落点的客户数
        </p>
      </div>

      {total <= 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-10">
          <p className="text-sm text-muted-foreground-weak">
            {props.conflictNote ?? '最近 24 小时没有客户产生新消息'}
          </p>
          {props.conflictNote !== null &&
          props.conflictNote !== undefined &&
          props.onFocusToday !== undefined ? (
            <button
              type="button"
              onClick={props.onFocusToday}
              className="rounded-md border border-border px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              只看今天
            </button>
          ) : null}
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="mt-2 w-full"
            role="img"
            aria-label="近 24 小时活跃度折线"
          >
            {/* 两条参考线：底边与上界。中间刻度是装饰，读数靠悬停。 */}
            <line
              x1={PAD_L}
              y1={y(0)}
              x2={W - PAD_R}
              y2={y(0)}
              className="stroke-border"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
            <line
              x1={PAD_L}
              y1={y(ceiling)}
              x2={W - PAD_R}
              y2={y(ceiling)}
              className="stroke-border-soft"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={PAD_L - 6}
              y={y(ceiling) + 3}
              textAnchor="end"
              className="fill-muted-foreground-weak text-[10px]"
            >
              {ceiling}
            </text>
            <text
              x={PAD_L - 6}
              y={y(0) + 3}
              textAnchor="end"
              className="fill-muted-foreground-weak text-[10px]"
            >
              0
            </text>

            <polyline
              points={line}
              fill="none"
              className="stroke-m-blue"
              strokeWidth={1.5}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />

            {points.map((point, index) => (
              <circle
                key={`dot-${point.hourStart}`}
                cx={x(index)}
                cy={y(point.count)}
                r={point.count > 0 ? 2.4 : 1.2}
                className={cn(
                  index === peak && point.count > 0 ? 'fill-m-blue' : 'fill-card stroke-m-blue',
                )}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
              />
            ))}

            {/* 点击热区：每个小时一整条，比点中小圆点容易得多。
                可点的元素只有这一层，折线与圆点都不接事件，避免两层抢同一个点击。 */}
            {points.map((point, index) => {
              const step = points.length <= 1 ? innerW : innerW / (points.length - 1)
              const left = Math.max(x(index) - step / 2, PAD_L)
              const width = Math.min(step, W - PAD_R - left)
              const label = `${hourText(point.hourStart)} ${point.count} 位客户`
              return (
                <rect
                  key={`hit-${point.hourStart}`}
                  x={left}
                  y={PAD_T}
                  width={Math.max(width, 1)}
                  height={innerH}
                  role={props.onSelectHour === undefined ? undefined : 'button'}
                  aria-label={props.onSelectHour === undefined ? undefined : label}
                  tabIndex={props.onSelectHour === undefined ? undefined : 0}
                  className={cn(
                    'fill-transparent',
                    props.onSelectHour === undefined
                      ? undefined
                      : 'cursor-pointer hover:fill-accent/60',
                  )}
                  onClick={
                    props.onSelectHour === undefined
                      ? undefined
                      : () => {
                          props.onSelectHour?.(point.hourStart)
                        }
                  }
                  // 键盘可达：SVG 元素在现代浏览器里认 tabIndex，鼠标能点的地方
                  // 键盘也该能走。这条与客户表格的 Tab 处理是同一条规矩。
                  onKeyDown={
                    props.onSelectHour === undefined
                      ? undefined
                      : (event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault()
                            props.onSelectHour?.(point.hourStart)
                          }
                        }
                  }
                >
                  <title>{label}</title>
                </rect>
              )
            })}

            {points.map((point, index) =>
              index % 6 === 0 || index === points.length - 1 ? (
                <text
                  key={`tick-${point.hourStart}`}
                  x={x(index)}
                  y={H - 8}
                  textAnchor="middle"
                  className="fill-muted-foreground-weak text-[10px]"
                >
                  {hourText(point.hourStart)}
                </text>
              ) : null,
            )}
          </svg>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground-weak">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-sm bg-m-blue" />
              活跃客户
            </span>
            {peakPoint === undefined ? null : (
              <span>
                峰值 {hourText(peakPoint.hourStart)}，{peakPoint.count} 位客户
              </span>
            )}
            <span>口径：客户最近消息时间的小时落点，随微信同步刷新</span>
          </div>
        </>
      )}
    </section>
  )
}
