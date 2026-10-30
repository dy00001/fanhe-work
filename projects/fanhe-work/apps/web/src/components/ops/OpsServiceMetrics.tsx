import type { OpsDimensionGroup } from '@fanhe/shared'

import { OPS_MODULE_PENDING, buildServiceMetrics } from '../../lib/ops-service-metrics'
import { cn } from '../../lib/utils'
import { OpsSection } from './OpsSection'

/**
 * 服务体验的真实指标格。
 *
 * 这个页面前身只有一张「尚未接入」的清单 —— 数据已经在库里，页面却一个数字都不显示，
 * 使用者自然会认为整块没接。取值与口径判断都在 `lib/ops-service-metrics.ts`，
 * 这里只负责摆版式（那一层能被 Node 直接断言，这一层不能）。
 */
export function OpsServiceMetrics(props: { group: OpsDimensionGroup }) {
  const { note, cells } = buildServiceMetrics(props.group)

  return (
    <OpsSection title="响应与接待" note={note}>
      <dl className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cells.map((cell) => (
          <div
            key={cell.key}
            className="rounded-lg border border-border px-3.5 py-3"
            title={cell.hint}
          >
            <dt className="text-xs text-muted-foreground">{cell.label}</dt>
            <dd
              className={cn(
                'mt-1.5 tabular-nums',
                cell.value === null
                  ? 'text-base text-muted-foreground-weak'
                  : 'text-xl font-medium text-foreground',
              )}
            >
              {cell.value ?? OPS_MODULE_PENDING}
            </dd>
          </div>
        ))}
      </dl>

      <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground-weak">
        前四项响应与接待指标取自千牛客服绩效的本店行（base_avg），同行的平均与优秀行不入库 ——
        取错行不会报错，只会把别人的数字当成自己的。「待回复」与「问大家待答」是采集那一刻
        的待办快照，平台没有按日的历史口径，所以区间视图里显示的是最近一次采集的值并标注
        数据日期，不随区间累加。
      </p>
    </OpsSection>
  )
}
