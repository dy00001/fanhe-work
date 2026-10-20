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
}) {
  const rows = props.group.rows
  const max = maxMetric(rows, props.valueKey)
  const windowLabel =
    props.group.window === null
      ? '无数据'
      : `${shortDate(props.group.window.from)} ~ ${shortDate(props.group.window.to)} 整段`

  return (
    <OpsSection title={props.title} note={windowLabel}>
      {rows.length === 0 ? (
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
