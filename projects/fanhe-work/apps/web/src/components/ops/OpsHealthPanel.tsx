import { RefreshCw } from 'lucide-react'

import { formatCollectedAt, freshnessOf, shortDate } from '../../lib/ops-display'
import type { OpsHealthState } from '../../lib/use-ops-dashboard'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { OpsCollectStatusChip } from './OpsChip'
import { OpsSection } from './OpsSection'

/**
 * 采集批次与新鲜度。
 *
 * 这张表回答的是「这个数字是哪天几点抓的、那次有没有失败」。它在信任崩塌时的
 * 价值高于任何一页报表：数字对不上后台时，人第一件事是问「这是什么时候的数据」。
 *
 * **按需加载**：面板展开时才请求（见 `useOpsHealth`）。展开前只显示页头徽标里的
 * 新鲜度（那份数据来自看板响应，不需要额外权限）。
 *
 * 失败的批次显示错误摘要而不是完整堆栈 —— 堆栈在这里既不完整也没人读，真要看
 * 应该去采集器的日志。
 */
const FRESHNESS_CLASS = {
  fresh: 'text-m-teal',
  stale: 'text-m-amber',
  old: 'text-destructive',
  none: 'text-muted-foreground-weak',
} as const

export function OpsHealthPanel(props: {
  state: OpsHealthState
  onReload: () => void
  now: Date
  /** 当前账号是否持有 `ops.collect.read`。没有时不发请求，直接给说明。 */
  allowed: boolean
}) {
  const { state } = props

  /*
   * 没有权限时**不发那次注定 403 的请求**，直接渲染说明。
   *
   * 两个理由。一是体验：一个 403 只会让浏览器在控制台打一条「Failed to load
   * resource」，这条红字会被当成页面出错，实际是设计行为。二是让「为什么看不到」
   * 就近可读 —— 面板本身比一次静默的拒绝更能回答问题。
   */
  if (!props.allowed) {
    return (
      <OpsSection title="采集批次" note="当前账号没有查看采集记录的权限">
        <p className="py-4 text-sm text-muted-foreground-weak">
          采集批次与数据新鲜度需要 ops.collect.read 权限。看板其余部分不受影响。
        </p>
      </OpsSection>
    )
  }

  if (state.status === 'idle' || state.status === 'loading') {
    return (
      <OpsSection title="采集批次" note="正在读取…">
        <p className="py-4 text-sm text-muted-foreground-weak">正在加载采集记录</p>
      </OpsSection>
    )
  }

  const data = state.data
  if (data === null) {
    return (
      <OpsSection
        title="采集批次"
        note="当前账号没有查看采集记录的权限"
        action={
          <Button type="button" size="sm" variant="ghost" onClick={props.onReload}>
            <RefreshCw className="size-3.5" />
            重试
          </Button>
        }
      >
        <p className="py-4 text-sm text-muted-foreground-weak">
          采集批次需要 ops.collect.read 权限。看板其余部分不受影响。
        </p>
      </OpsSection>
    )
  }

  const freshness = freshnessOf(data.lastCollectedAt, props.now)
  const hours = freshness.hours

  return (
    <OpsSection
      title="采集批次"
      note={`最近 ${data.runs.length} 次`}
      action={
        <Button type="button" size="sm" variant="ghost" onClick={props.onReload}>
          <RefreshCw className="size-3.5" />
          刷新
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        上次成功采集{' '}
        <span className="text-foreground tabular-nums">
          {formatCollectedAt(data.lastCollectedAt)}
        </span>
        {' · '}
        <span className={cn('font-medium', FRESHNESS_CLASS[freshness.level])}>
          {freshness.label}
          {hours === null ? '' : `（${hours.toFixed(0)} 小时前）`}
        </span>
      </p>

      {data.runs.length === 0 ? (
        <p className="py-4 text-sm text-muted-foreground-weak">还没有任何采集记录</p>
      ) : (
        <Table className="mt-3">
          <TableHeader>
            <TableRow>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">
                开始时间
              </TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">窗口</TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">方式</TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">状态</TableHead>
              <TableHead className="text-right text-xs font-normal text-muted-foreground-weak">
                逐日
              </TableHead>
              <TableHead className="text-right text-xs font-normal text-muted-foreground-weak">
                维度
              </TableHead>
              <TableHead className="text-right text-xs font-normal text-muted-foreground-weak">
                耗时
              </TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">错误</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.runs.map((run) => (
              <TableRow key={run.id}>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {formatCollectedAt(run.startedAt)}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {shortDate(run.window.from)} ~ {shortDate(run.window.to)}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{run.trigger}</TableCell>
                <TableCell>
                  <OpsCollectStatusChip status={run.status} />
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums">{run.dailyRows}</TableCell>
                <TableCell className="text-right text-xs tabular-nums">
                  {run.dimensionRows}
                </TableCell>
                <TableCell className="text-right text-xs text-muted-foreground-weak tabular-nums">
                  {run.durationMs === null ? '—' : `${run.durationMs} ms`}
                </TableCell>
                <TableCell
                  className="max-w-[220px] truncate text-xs text-destructive"
                  title={run.errorMessage ?? ''}
                >
                  {run.errorMessage ?? ''}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </OpsSection>
  )
}
