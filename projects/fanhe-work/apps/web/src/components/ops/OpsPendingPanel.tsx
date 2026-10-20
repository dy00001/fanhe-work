import { OPS_BATCH_TABLE, OPS_READY_SUMMARY, type OpsPendingItem } from '../../lib/ops-pending'
import { cn } from '../../lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { OpsChip } from './OpsChip'
import { OpsSection } from './OpsSection'

/**
 * 待接入指标的说明面板。
 *
 * 服务、推广、内容三个板块目前没有真实数据。这个面板替代了三种常见做法：
 *
 *   空页面 —— 使用者以为是接口坏了，去找人修一个没坏的东西。
 *   演示数字 —— 更糟，会有人拿去做决策。
 *   一句「开发中」—— 无法回答「差什么、卡在哪、要不要我配合」。
 *
 * 面板给出三样东西：**缺哪些指标**（含后台入口与字段名）、**卡在哪一批**、
 * **已经有什么**。最后一项容易被省掉，但它决定了使用者的判断：知道商品与流量
 * 是真实的，就不会因为服务板块空着而认为整个看板都不能信。
 */

const BATCH_STATE_LABEL = {
  done: '已完成',
  next: '可立刻开工',
  blocked: '需配合',
} as const

const BATCH_STATE_TONE = {
  done: 'teal',
  next: 'neutral',
  blocked: 'amber',
} as const

export function OpsPendingPanel(props: {
  title: string
  intro: string
  items: readonly OpsPendingItem[]
}) {
  return (
    <div className="flex flex-col gap-3">
      <OpsSection title={props.title} note="以下指标尚未接入，页面不显示替代数字">
        <p className="text-sm leading-relaxed text-muted-foreground">{props.intro}</p>

        <Table className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">指标</TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">
                后台入口
              </TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">字段</TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">批次</TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">卡点</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.items.map((item) => (
              <TableRow key={item.field}>
                <TableCell className="text-sm text-foreground">{item.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{item.backend}</TableCell>
                <TableCell className="font-mono text-[11px] text-muted-foreground-weak">
                  {item.field}
                </TableCell>
                <TableCell>
                  <OpsChip>{item.batch}</OpsChip>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground-weak">
                  {item.blockedBy === '' ? '只差跑一次采集' : item.blockedBy}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </OpsSection>

      <div className="grid gap-3 lg:grid-cols-2">
        <OpsSection title="采集批次进度" note="按依赖关系排序">
          <ul className="flex flex-col gap-2.5">
            {OPS_BATCH_TABLE.map((row) => (
              <li key={row.batch} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5">
                  <OpsChip tone={BATCH_STATE_TONE[row.state]}>
                    {BATCH_STATE_LABEL[row.state]}
                  </OpsChip>
                </span>
                <span className="min-w-0">
                  <span className="text-foreground">
                    {row.batch} 批 · {row.scope}
                  </span>
                  <span className="block text-[11px] text-muted-foreground-weak">{row.note}</span>
                </span>
              </li>
            ))}
          </ul>
        </OpsSection>

        <OpsSection title="已经接入的指标" note="这些是真实数据，可放心使用">
          <ul className="flex flex-col gap-2 text-sm">
            {OPS_READY_SUMMARY.map((row) => (
              <li key={`${row.view}-${row.metrics}`} className={cn('flex gap-2')}>
                <span className="w-20 shrink-0 text-xs text-muted-foreground-weak">{row.view}</span>
                <span className="min-w-0">
                  <span className="text-foreground">{row.metrics}</span>
                  <span className="block text-[11px] text-muted-foreground-weak">{row.note}</span>
                </span>
              </li>
            ))}
          </ul>
        </OpsSection>
      </div>
    </div>
  )
}
