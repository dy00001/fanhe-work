import type { OpsDimensionGroup } from '@fanhe/shared'

import { OPS_SUMMARY_META, formatSummary, metricOf, shortDate } from '../../lib/ops-display'
import { OpsSection } from './OpsSection'

/**
 * 整段指标格。
 *
 * 只展示「不可相加、不随区间重算」的那些指标（跳失率、停留时长、加购人数、新老
 * 买家）。它们与 KPI 卡长得像，但**必须分开摆** —— 混在一排里，使用者会自然
 * 认为它们随区间一起变，而实际上切到近 7 天时这些数字纹丝不动。
 *
 * 所以这一块有自己的标题说明，并写明窗口。这不是排版讲究，是口径的物理隔离。
 */
export function OpsSummaryGrid(props: {
  group: OpsDimensionGroup
  title?: string
  /**
   * 只显示这几项。不传就显示所有在 `OPS_SUMMARY_META` 里登记过的键 —— 流量页用的
   * 是这个默认行为。内容页要单独摆三项，所以得能筛，否则会把流量那一堆一起带出来。
   */
  keys?: readonly string[]
  /**
   * 覆盖标题下那行说明。默认写的是「整段快照，不随页面区间变」，这对跳失率那类
   * 指标是对的；但内容三项是区间累计（`source: 'period'`），照抄那句话就成了
   * 反着说 —— 所以调用方要能把说明换掉。
   */
  note?: string
}) {
  const wanted = props.keys === undefined ? null : new Set(props.keys)
  const rows = props.group.rows.filter(
    (row) => OPS_SUMMARY_META[row.key] !== undefined && (wanted === null || wanted.has(row.key)),
  )
  const windowLabel =
    props.group.window === null
      ? '无数据'
      : `${shortDate(props.group.window.from)} ~ ${shortDate(props.group.window.to)} 整段`

  return (
    <OpsSection
      title={props.title ?? '结构指标'}
      note={props.note ?? `${windowLabel} · 整段快照，不随页面区间变`}
    >
      {rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground-weak">还没有结构指标</p>
      ) : (
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => {
            const meta = OPS_SUMMARY_META[row.key]
            if (meta === undefined) return null
            const value = formatSummary(row.key, metricOf(row, 'value'))
            return (
              <div key={row.key} className="flex flex-col gap-0.5" title={meta.hint}>
                <dt className="text-xs text-muted-foreground">{meta.label}</dt>
                <dd className="text-lg font-medium text-foreground tabular-nums">{value ?? '—'}</dd>
              </div>
            )
          })}
        </dl>
      )}
    </OpsSection>
  )
}
