import { OPS_PRESETS, type OpsPreset } from '../../lib/ops-view'
import { cn } from '../../lib/utils'

/**
 * 时间条。结构与原型 `timeBar()` 一致：左侧六档区间、中间起止日期、右侧一句区间说明。
 *
 * 三处刻意的取舍：
 *
 * 1. **不提供「维度」与「对比模式」。** 原型有日/周/月/年分桶与 A/B 对比，但那需要
 *    后端按桶聚合、并维护两段区间的对齐规则；当前接口只返回逐日序列，前端自己分桶
 *    会与整段口径打架。等 `ops/query.ts` 支持分桶后再加，不在界面先摆一个不生效的开关。
 * 2. **`simple` 模式只显示说明，不显示任何可点控件。** 服务/推广/内容是整段快照，
 *    给一个点了数字不动的区间条，用户会以为刷新失效（原型为这个缺陷专门写了
 *    `snapshotBar`）。
 * 3. **日期范围夹在数据覆盖内。** `min`/`max` 只是原生控件的提示，真正的夹取在
 *    `presetRange`；这里放上是为了不给出明显越界的可选日期。
 */
export function OpsToolbar(props: {
  preset: OpsPreset
  onPreset: (preset: OpsPreset) => void
  from: string
  to: string
  onFrom: (value: string) => void
  onTo: (value: string) => void
  /** 数据覆盖范围，用于日期控件与说明。 */
  coverageFrom: string | null
  coverageTo: string | null
  /** 右侧说明。缺省为空。 */
  note?: string
  /** 整段快照页：只显示说明，不显示区间控件。 */
  simple?: boolean
}) {
  const dateInput = (value: string, onChange: (next: string) => void, label: string) => (
    <input
      type="date"
      aria-label={label}
      value={value}
      {...(props.coverageFrom === null ? {} : { min: props.coverageFrom })}
      {...(props.coverageTo === null ? {} : { max: props.coverageTo })}
      onChange={(event) => {
        onChange(event.target.value)
      }}
      className="rounded-lg border border-border bg-card px-1.5 py-0.5 text-xs text-foreground tabular-nums"
    />
  )

  if (props.simple === true) {
    return (
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-2.5">
        <span className="text-xs text-muted-foreground-weak">口径</span>
        <span className="text-xs text-foreground">30 天整段快照</span>
        <span className="text-xs text-muted-foreground-weak">覆盖</span>
        <span className="text-xs text-foreground tabular-nums">
          {props.coverageFrom ?? '—'} ~ {props.coverageTo ?? '—'}
        </span>
        <span className="ml-auto text-[11px] text-muted-foreground-weak">
          {props.note ?? '本页指标是「当前状态」类数据，不按区间聚合，因此不提供区间选择'}
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-border bg-card px-4 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground-weak">区间</span>
        <div className="inline-flex rounded-lg border border-border p-0.5">
          {OPS_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              role="tab"
              aria-selected={props.preset === preset.key}
              onClick={() => {
                props.onPreset(preset.key)
              }}
              className={cn(
                'rounded-md px-2 py-0.5 text-xs transition-colors',
                props.preset === preset.key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        {dateInput(props.from, props.onFrom, '起始日期')}
        <span className="text-xs text-muted-foreground-weak">至</span>
        {dateInput(props.to, props.onTo, '截止日期')}
      </div>

      <span className="ml-auto text-[11px] text-muted-foreground-weak">{props.note ?? ''}</span>
    </div>
  )
}
