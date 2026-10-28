import type { OpsDimensionGroup } from '@fanhe/shared'

import { formatCount, formatPercent, maxMetric, metricOf, shortDate } from '../../lib/ops-display'
import { OpsSection } from './OpsSection'

/**
 * 通用排行列表：地域、搜索词、内容来源共用。
 *
 * 三者的结构完全一样（名称 + 一个主指标 + 可选占比），分成三个组件只会让「条宽
 * 怎么算」出现三个版本。差异通过 props 传，不通过复制代码实现。
 */
export function OpsRankList(props: {
  title: string
  group: OpsDimensionGroup
  valueKey: string
  valueLabel: string
  shareKey?: string
  /**
   * 该维度确定取不到时的说明。传了就忽略 group 里的行，窗口标签也改成「未接入」。
   *
   * 为什么需要这个而不是让它显示空态：内容来源在库里还留着 09-19 至 10-18 的
   * 30 天基线，读起来像有数据，但跟旁边三块当日的渠道、地域、搜索词不是一回事。
   * 显示旧数字比显示「未接入」更容易误读。
   */
  unavailable?: string
}) {
  const rows = props.group.rows
  const max = maxMetric(rows, props.valueKey)
  const windowLabel =
    props.unavailable !== undefined
      ? '未接入'
      : props.group.window === null
        ? '无数据'
        : `${shortDate(props.group.window.from)} ~ ${shortDate(props.group.window.to)} 整段`

  return (
    <OpsSection title={props.title} note={windowLabel}>
      {props.unavailable !== undefined ? (
        <p className="py-6 text-center text-xs leading-relaxed text-muted-foreground-weak">
          {props.unavailable}
        </p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground-weak">还没有这项数据</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((row) => {
            const value = metricOf(row, props.valueKey)
            const share = props.shareKey === undefined ? null : metricOf(row, props.shareKey)
            const width = value === null || max === 0 ? 0 : (value / max) * 100
            return (
              <li key={row.key} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="truncate text-foreground" title={row.label}>
                    {row.label}
                  </span>
                  {share === null ? null : (
                    <span className="shrink-0 text-[11px] text-muted-foreground-weak">
                      {formatPercent(share, 1)}
                    </span>
                  )}
                  <span className="ml-auto shrink-0 text-foreground tabular-nums">
                    {formatCount(value)}
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground-weak">
                    {props.valueLabel}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-m-neutral/50"
                    style={{ width: `${width}%` }}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </OpsSection>
  )
}
