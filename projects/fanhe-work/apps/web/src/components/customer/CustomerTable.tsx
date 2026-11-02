import type { CustomerListItemDto } from '@fanhe/shared'

import {
  activityClass,
  activityOf,
  assignmentParts,
  formatDateTime,
  formatFen,
  reviewLabel,
  scopeLabel,
  stageLabel,
  stageTone,
  toneClass,
} from '../../lib/customer-display'
import { Badge } from '../ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'

/**
 * 客户清单。
 *
 * 从综合看板搬到了客户进度：看板回答「这批客户什么结构」，清单回答「这一单做到哪」，
 * 两件事放在一屏里，图表会被一行行的表格挤到需要滚动才能看全，而表格又因为上面
 * 压着图而只剩半屏。
 *
 * 两栏仍然共用同一个数据源与同一套筛选，所以「从看板的阶段扇区跳进来，列表就是
 * 那个阶段的人」是构造上成立的。
 */
export function CustomerTable(props: {
  items: readonly CustomerListItemDto[]
  financeReadable: boolean
  /** 数据到达的时刻，由上游给一次。渲染里不许调 `Date.now()`。 */
  nowMs: number
  onSelect: (id: string) => void
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>客户</TableHead>
          <TableHead>地区</TableHead>
          <TableHead>归属</TableHead>
          <TableHead>阶段</TableHead>
          <TableHead>订单</TableHead>
          <TableHead>最近消息</TableHead>
          {props.financeReadable ? <TableHead className="text-right">合同额</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {props.items.map((item) => {
          const review = reviewLabel(item.reviewStatus, item.confidence)
          const activity = activityOf(item.lastMessageAt, props.nowMs)
          return (
            <TableRow
              key={item.id}
              className="cursor-pointer"
              onClick={() => props.onSelect(item.id)}
              // 键盘可达：只靠 onClick 的话，这张表用 Tab 走不到任何一行，
              // 而这类「鼠标能用、键盘不能用」的缺陷在视觉上完全看不出来。
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  props.onSelect(item.id)
                }
              }}
            >
              <TableCell>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground">{item.displayName}</span>
                  {item.hasRepeat ? (
                    <Badge variant="secondary" className="text-[10px]">
                      复购
                    </Badge>
                  ) : null}
                  {review === null ? null : (
                    <Badge variant="outline" className="text-[10px]">
                      {review}
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground-weak">
                  {item.shortName} · {item.msgRows} 条消息
                </p>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">
                {item.region}
                <span className="ml-1 text-xs text-muted-foreground-weak">
                  {scopeLabel(item.regionScope)}
                </span>
              </TableCell>
              {/*
                归属列两栏都渲染，不只渲染「自己那一栏」。需求要求双向可查：
                设计师要在这里看到销售是谁，销售要看到设计师是谁。只渲染对方那一栏
                也能满足双向，但管理员会看不到其中一栏，反而更别扭。
              */}
              <TableCell>
                <AssignmentCell assignment={item.assignment} />
              </TableCell>
              <TableCell>
                <Badge variant="outline" className={`${toneClass(stageTone(item.stage))} border-0`}>
                  {stageLabel(item.stage)}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-muted-foreground">{item.orderCount}</TableCell>
              <TableCell className="text-xs text-muted-foreground">
                <div>{formatDateTime(item.lastMessageAt)}</div>
                <div className={`mt-0.5 text-[11px] ${activityClass(activity.level)}`}>
                  {activity.label}
                </div>
              </TableCell>
              {props.financeReadable ? (
                <TableCell className="text-right text-sm text-foreground">
                  {formatFen(item.contractTotalFen)}
                </TableCell>
              ) : null}
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

/**
 * 归属单元格。
 *
 * 公共池显示为一句灰色文字而不是空单元格：空白会被读成「没数据」，而它其实是一个
 * 待处理状态 —— 有人需要去认领。
 */
function AssignmentCell({ assignment }: { assignment: CustomerListItemDto['assignment'] }) {
  const parts = assignmentParts(assignment)
  if (parts.length === 0) {
    return <span className="text-xs text-muted-foreground-weak">公共池</span>
  }
  return (
    <div className="flex flex-col gap-1">
      {parts.map((part) => (
        <Badge key={part.role} variant="outline" className="w-fit text-[10px] font-normal">
          {part.roleLabel} {part.name}
          {part.mine ? '（我）' : ''}
        </Badge>
      ))}
    </div>
  )
}
