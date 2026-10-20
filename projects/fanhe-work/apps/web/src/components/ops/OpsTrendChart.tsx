import type { OpsDailyPoint } from '@fanhe/shared'

import { useState } from 'react'

import {
  OPS_METRIC_META,
  chineseDate,
  peakIndex,
  seriesCeiling,
  shortDate,
  type OpsMetricKey,
} from '../../lib/ops-display'
import { cn } from '../../lib/utils'
import { OpsSection } from './OpsSection'

/**
 * 逐日趋势。手写柱状图，不引图表库。
 *
 * 三个理由：**一**，目前只需要「一天一根柱 + 悬停读数」，而任何图表库都会为这点
 * 需求带进 100KB 与第二套主题系统（与「令牌唯一来源」冲突）。**二**，柱状图的
 * 纵轴语义是「柱高等于数值」，压缩过的纵轴会破坏它 —— 手写时能明确选择不压缩，
 * 并在页面上标出峰值。**三**，`<title>` 提供的原生悬停读数在 Electron 壳里可用，
 * 不必再处理浮层的定位与点击穿透。
 *
 * **不压缩纵轴**是这一版的有意取舍。原型的做法是长尾指标用 √ 压缩（10-08 单日
 * 4.9 万占 45%，线性轴下其余 29 根被压成 2px）。代价是「柱高看着像 1/3，实际只占
 * 5%」。这里改成：线性 + 峰值日染成蓝色 + 图下方写清峰值金额与日期 —— 读数靠
 * 文字补，形状保持诚实。
 */

/** 横轴标签的抽稀步长。30 根柱全标会挤成一团，7 根则全标。 */
function labelStep(count: number): number {
  if (count <= 8) return 1
  if (count <= 16) return 2
  if (count <= 31) return 5
  return 10
}

/** 可切换的三个指标。商品访客与访客高度相关，放进来会挤，留在参数里备用。 */
const SWITCHABLE: readonly OpsMetricKey[] = ['payAmountFen', 'visitors', 'payBuyers']

export function OpsTrendChart(props: {
  series: readonly OpsDailyPoint[]
  metric: OpsMetricKey
  note?: string
  /** 是否显示指标切换按钮。默认显示。 */
  switchable?: boolean
}) {
  /*
   * 切换的指标存组件内 state，**不进地址栏**。
   *
   * 与页面的视图/区间不同：那是「我在看哪一段时间」，需要能分享、能刷新保持；
   * 而「这一根图看金额还是看访客」是一次观看动作，刷新回到默认反而合适。
   * 把它塞进 URL 会让链接变得又长又脆。
   */
  const [picked, setPicked] = useState<OpsMetricKey>(props.metric)
  const metric = picked
  const meta = OPS_METRIC_META[metric]
  const values = props.series.map((point) => point[metric])
  const ceiling = seriesCeiling(values)
  const peak = peakIndex(values)
  const step = labelStep(props.series.length)

  const peakPoint = peak >= 0 ? props.series[peak] : undefined
  const peakValue = peakPoint === undefined ? null : peakPoint[metric]

  return (
    <OpsSection
      title={`${meta.label}趋势`}
      note={props.note ?? meta.hint}
      action={
        props.switchable === false ? undefined : (
          <div className="flex gap-1">
            {SWITCHABLE.map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setPicked(key)
                }}
                className={cn(
                  'rounded-md border px-1.5 py-0.5 text-[11px] transition-colors',
                  metric === key
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border text-muted-foreground hover:text-foreground',
                )}
              >
                {OPS_METRIC_META[key].label}
              </button>
            ))}
          </div>
        )
      }
    >
      {props.series.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground-weak">这段时间没有逐日数据</p>
      ) : (
        <>
          <div className="flex gap-3">
            {/* 纵轴只标顶与底。中间刻度在这类柱状图上是装饰，读数靠悬停更准。 */}
            <div className="flex w-14 shrink-0 flex-col justify-between py-0.5 text-right text-[11px] text-muted-foreground-weak tabular-nums">
              <span>{meta.format(ceiling)}</span>
              <span>0</span>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex h-44 items-end gap-[3px] border-b border-border-soft">
                {props.series.map((point, index) => {
                  const value = point[metric]
                  const heightPct = value === null ? 0 : Math.max((value / ceiling) * 100, 1.5)
                  const isPeak = index === peak && value !== null && value > 0
                  return (
                    <div
                      key={point.date}
                      className="group relative flex h-full flex-1 items-end justify-center"
                      title={`${chineseDate(point.date)}  ${meta.format(value)}`}
                    >
                      <div
                        className={cn(
                          'w-full max-w-[28px] rounded-t-[3px] transition-colors',
                          value === null || value === 0
                            ? 'h-[2px] rounded-sm bg-border'
                            : isPeak
                              ? 'bg-m-blue'
                              : 'bg-m-neutral/45 group-hover:bg-primary',
                        )}
                        style={
                          value === null || value === 0 ? undefined : { height: `${heightPct}%` }
                        }
                      />
                    </div>
                  )
                })}
              </div>

              <div className="mt-2 flex gap-[3px]">
                {props.series.map((point, index) => (
                  <span
                    key={point.date}
                    className="flex-1 text-center text-[10px] text-muted-foreground-weak tabular-nums"
                  >
                    {index % step === 0 || index === props.series.length - 1
                      ? shortDate(point.date)
                      : ''}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground-weak">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-2 rounded-sm bg-m-blue" />
              峰值日
            </span>
            {peakPoint === undefined ? null : (
              <span>
                {chineseDate(peakPoint.date)} 为 {meta.format(peakValue)}
              </span>
            )}
            <span>纵轴为线性刻度，未做压缩</span>
          </div>
        </>
      )}
    </OpsSection>
  )
}
