import type { OpsDimensionGroup } from '@fanhe/shared'

import {
  formatCount,
  formatFen,
  formatPercent,
  maxMetric,
  metricOf,
  shortDate,
} from '../../lib/ops-display'
import { OpsSection } from './OpsSection'

/**
 * 渠道结构。
 *
 * 用横向条而不是饼图：饼图在 3 个渠道、占比 80/12/8 这种极端分布下几乎读不出
 * 差异，而横条的长度差一眼可见，还能顺着排序列出指标。
 *
 * `window`（数据自己的统计窗口）与页面区间可能不同 —— 整段口径的维度不随区间重算。
 * 两者不同时**必须把窗口写出来**，否则「切了区间但数字没动」会被当成缺陷。
 */
export function OpsChannelList(props: { group: OpsDimensionGroup }) {
  const rows = props.group.rows
  const maxVisitors = maxMetric(rows, 'visitors')
  const windowLabel =
    props.group.window === null
      ? '无数据'
      : `${shortDate(props.group.window.from)} ~ ${shortDate(props.group.window.to)} 整段`

  return (
    <OpsSection title="渠道结构" note={`按访客倒序 · ${windowLabel}`}>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground-weak">还没有渠道数据</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => {
            const visitors = metricOf(row, 'visitors')
            const share = metricOf(row, 'ratio')
            const width =
              visitors === null || maxVisitors === 0 ? 0 : (visitors / maxVisitors) * 100
            return (
              <li key={row.key} className="flex flex-col gap-1.5">
                <div className="flex items-baseline gap-2 text-sm">
                  <span className="truncate text-foreground">{row.label}</span>
                  {share === null ? null : (
                    <span className="text-xs text-muted-foreground-weak">
                      占 {formatPercent(share, 1)}
                    </span>
                  )}
                  <span className="ml-auto text-foreground tabular-nums">
                    {formatCount(visitors)}
                  </span>
                  <span className="text-xs text-muted-foreground-weak">访客</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-m-neutral/60"
                    style={{ width: `${width}%` }}
                  />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-muted-foreground-weak tabular-nums">
                  <span>买家 {formatCount(metricOf(row, 'payBuyers'))}</span>
                  <span>转化 {formatPercent(metricOf(row, 'payRate'))}</span>
                  <span>金额 {formatFen(metricOf(row, 'payAmountFen'), { compact: true })}</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </OpsSection>
  )
}
