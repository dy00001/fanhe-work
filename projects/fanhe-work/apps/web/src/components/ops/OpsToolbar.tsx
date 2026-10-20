import { ChevronDown } from 'lucide-react'

import type { Freshness } from '../../lib/ops-display'
import { formatCollectedAt } from '../../lib/ops-display'
import { OPS_PRESETS, OPS_VIEWS, type OpsPreset, type OpsView } from '../../lib/ops-view'
import { cn } from '../../lib/utils'

/**
 * 看板工具条：视图切换、时间区间、数据新鲜度。
 *
 * **所有状态都写进地址栏**（由外层页面负责），这里只负责渲染与回调。这样做的收益
 * 是三条：刷新不丢当前视图、链接能直接发给同事、浏览器后退符合直觉。代价是每次
 * 点击都要重建 URL，但这里只有七个视图与五个区间档，成本可以忽略。
 *
 * 视图与预设的取值域在 `lib/ops-view.ts`，不在这里 —— 组件文件同时导出常量会让
 * 热更新退化成整页刷新，理由见那个文件顶部。
 */

const FRESH_DOT = {
  fresh: 'bg-m-teal',
  stale: 'bg-m-amber',
  old: 'bg-destructive',
  none: 'bg-border',
} as const

export function OpsToolbar(props: {
  view: OpsView
  onView: (view: OpsView) => void
  preset: OpsPreset
  onPreset: (preset: OpsPreset) => void
  customFrom: string
  customTo: string
  onCustomRange: (from: string, to: string) => void
  /** 实际生效的区间（来自响应）。与用户点的预设可能不同 —— 数据只到某一天。 */
  rangeLabel: string
  rangeNote: string
  freshness: Freshness
  lastCollectedAt: string | null
  healthOpen: boolean
  onToggleHealth: () => void
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {OPS_VIEWS.map((view) => (
            <button
              key={view.key}
              type="button"
              onClick={() => {
                props.onView(view.key)
              }}
              aria-current={props.view === view.key ? 'page' : undefined}
              className={cn(
                'rounded-lg px-2.5 py-1 text-sm transition-colors',
                props.view === view.key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {view.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className={cn('size-1.5 rounded-full', FRESH_DOT[props.freshness.level])} />
            {props.freshness.label}
            <span className="text-muted-foreground-weak">
              {props.lastCollectedAt === null
                ? '从未采集'
                : `上次 ${formatCollectedAt(props.lastCollectedAt)}`}
            </span>
          </span>
          <button
            type="button"
            onClick={props.onToggleHealth}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
            aria-expanded={props.healthOpen}
          >
            采集记录
            <ChevronDown
              className={cn('size-3 transition-transform', props.healthOpen && 'rotate-180')}
            />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border-soft pt-3">
        <span className="text-xs text-muted-foreground-weak">区间</span>
        <div className="flex flex-wrap gap-1">
          {OPS_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => {
                props.onPreset(preset.key)
              }}
              className={cn(
                'rounded-lg border px-2 py-0.5 text-xs transition-colors',
                props.preset === preset.key
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              props.onPreset('custom')
            }}
            className={cn(
              'rounded-lg border px-2 py-0.5 text-xs transition-colors',
              props.preset === 'custom'
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            自定义
          </button>
        </div>

        {props.preset === 'custom' ? (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={props.customFrom}
              onChange={(event) => {
                props.onCustomRange(event.target.value, props.customTo)
              }}
              className="rounded-md border border-border bg-card px-1.5 py-0.5 text-xs text-foreground tabular-nums"
            />
            <span className="text-xs text-muted-foreground-weak">至</span>
            <input
              type="date"
              value={props.customTo}
              onChange={(event) => {
                props.onCustomRange(props.customFrom, event.target.value)
              }}
              className="rounded-md border border-border bg-card px-1.5 py-0.5 text-xs text-foreground tabular-nums"
            />
          </div>
        ) : null}

        <span className="ml-auto text-[11px] text-muted-foreground-weak">
          <span className="text-muted-foreground tabular-nums">{props.rangeLabel}</span>
          <span className="ml-2">{props.rangeNote}</span>
        </span>
      </div>
    </div>
  )
}
