import type { OpsKpi } from '@fanhe/shared'

import {
  deltaTone,
  formatCount,
  formatDelta,
  formatDuration,
  formatFen,
  formatPercent,
} from '../../lib/ops-display'
import { cn } from '../../lib/utils'
import { OpsMaskedChip, OpsSourceChip } from './OpsChip'

/**
 * 指标卡组。
 *
 * 每张卡四行：标签 + 口径徽标、数值、环比、口径说明。排版固定，是为了让六个数字
 * 竖着扫的时候能对齐 —— 卡内换行会让「支付金额」那行比分店那行高一像素，整排
 * 就歪了。
 *
 * **金额被裁掉时显示「无权限」而不是 0 或 —**。三者含义不同：0 是当天没成交，
 * `—` 是没数据，无权限是「你看不到」。把前两者用在第三种上，会让使用者以为店铺
 * 那天没开张。
 *
 * 数值按单位分派格式化，`unit` 是接口给的，不在组件里猜。加一种单位意味着
 * `ops-display.ts` 加一个分支，而不是在六个地方各改一次。
 */
function kpiValue(item: OpsKpi): string {
  switch (item.unit) {
    case 'fen':
      return formatFen(item.value, { compact: true })
    case 'count':
      return formatCount(item.value)
    case 'percent':
      return formatPercent(item.value)
    case 'minute':
      return formatDuration(item.value)
  }
}

const DELTA_CLASS = {
  up: 'text-up',
  down: 'text-down',
  flat: 'text-muted-foreground-weak',
} as const

export function OpsKpiGrid(props: { items: readonly OpsKpi[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
      {props.items.map((item) => {
        const tone = deltaTone(item.deltaPct)
        return (
          <div
            key={item.key}
            className="rounded-xl border border-border bg-card px-4 py-3.5"
            title={item.hint ?? undefined}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{item.label}</span>
              <span className="ml-auto">
                {item.masked ? <OpsMaskedChip /> : <OpsSourceChip source={item.source} />}
              </span>
            </div>

            <div className="mt-2 text-2xl font-medium tracking-tight text-foreground tabular-nums">
              {item.masked ? (
                <span className="text-base text-muted-foreground-weak">无权限</span>
              ) : (
                kpiValue(item)
              )}
            </div>

            <div
              className={cn(
                'mt-1.5 flex items-center gap-1.5 text-xs tabular-nums',
                DELTA_CLASS[tone],
              )}
            >
              <span>{item.masked ? '—' : formatDelta(item.deltaPct)}</span>
              <span className="text-muted-foreground-weak">
                {item.masked ? '' : item.deltaPct === null ? '' : '较上一周期'}
              </span>
            </div>

            {item.hint === null ? null : (
              <p className="mt-2 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground-weak">
                {item.hint}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
