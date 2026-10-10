import type { LaunchProfile, LaunchProfileStatus } from '@fanhe/shared'
import { ArrowDown, ArrowUp, Ellipsis, Pencil, Trash2 } from 'lucide-react'

import { LAUNCH_ICONS, launchSoftwareLabel, resolveLaunchIconKey } from '../../lib/launch-icons'
import { formatRelativeTime } from '../../lib/relative-time'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'

type LaunchProfileRowProps = {
  profile: LaunchProfile
  /**
   * 这条配置在这台机器上的当前状态。
   *
   * `undefined` 表示**还没拿到**（状态是另一次请求，可能比列表慢），与「拿到了、一切
   * 正常」不同：前者不显示任何标记，后者显示上次启动的摘要。
   */
  status: LaunchProfileStatus | undefined
  /** 只读访客不能触发行操作，整块收起比保留不可点的入口更清楚。 */
  canWrite: boolean
  /** 本条正在启动。按钮改为「启动中…」并禁用，避免连点。 */
  launching: boolean
  /** 列表级忙碌（重排或删除在飞）。此时所有行都不可操作。 */
  busy: boolean
  /** 能否上移/下移。首尾两项各有一个方向不可用。 */
  canMoveUp: boolean
  canMoveDown: boolean
  onLaunch: () => void
  onEdit: () => void
  /** 打开编辑对话框并把光标落在路径字段上。路径失效时的主入口。 */
  onRelocate: () => void
  onMove: (offset: -1 | 1) => void
  onDelete: () => void
}

/**
 * 把启动记录说成一句话。
 *
 * 最近一次失败时把「上次成功」也带出来，因为那正是用户想知道的事 —— 一条配置连续
 * 失败时，「上次启动 2 分钟前 · 未成功」只说明它刚失败过，而「上次成功 3 天前」才是
 * 「它从什么时候开始不行的」。
 *
 * 状态还没拿到时返回 null，那一行就不显示 —— 显示「尚未启动过」是错的，它与「还没
 * 查出来」是两回事。
 */
function describeRunHistory(status: LaunchProfileStatus | undefined): string | null {
  if (status === undefined) return null
  if (status.lastRun === null) return '暂无近期启动记录'

  const when = formatRelativeTime(status.lastRun.startedAt)
  if (status.lastRun.outcome === 'success') return `上次启动 ${when}`

  const failed = `上次启动 ${when} · 未成功`
  return status.lastSuccessAt === null
    ? failed
    : `${failed}（上次成功 ${formatRelativeTime(status.lastSuccessAt)}）`
}

/**
 * 启动配置列表的一行。
 *
 * **排序用上移/下移按钮，不做拖拽。** 拖拽要引入一套手势依赖（`@dnd-kit` 之类），
 * 还要处理重排动画与「拖到哪一格」的判定；而上移下移只需交换两个相邻元素，零依赖、
 * 无动画歧义，键盘与读屏软件也能直接操作。重排接口收的是**整个列表的 id 顺序**
 * （见共享包），与这个交互天然对得上：点一次，本地交换，整份顺序提交。
 *
 * 上移/下移平铺在行内而不是收进「更多」菜单：它们是这个板块唯一的排序手段，
 * 收进菜单意味着每次调整都要点两次，而排序恰恰是需要反复微调的操作。
 */
export function LaunchProfileRow({
  profile,
  status,
  canWrite,
  launching,
  busy,
  canMoveUp,
  canMoveDown,
  onLaunch,
  onEdit,
  onRelocate,
  onMove,
  onDelete,
}: LaunchProfileRowProps) {
  const Icon = LAUNCH_ICONS[resolveLaunchIconKey(profile)]
  const disabled = busy || launching
  const argsCount = profile.args.length
  const pathMissing = status?.pathState === 'missing'
  const runSummary = describeRunHistory(status)

  return (
    <li className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        <Icon className="size-4" />
      </span>

      {/* `min-w-0` 不能省：flex 子项的默认最小宽度是内容宽度，长路径会把这一行撑破，
          表现为右侧按钮被挤出可视区。 */}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-foreground">{profile.name}</span>
          <Badge variant="secondary" className="shrink-0">
            {launchSoftwareLabel(profile.software)}
          </Badge>
          {/* 失效标记放在名字这一行而不是路径旁边：路径那一行是等宽字体且会被截断，
              夹一个徽标进去会让它在长路径上忽隐忽现。 */}
          {pathMissing && (
            <Badge
              variant="outline"
              className="shrink-0 border-destructive/30 bg-destructive/10 text-destructive"
            >
              路径失效
            </Badge>
          )}
          {argsCount > 0 && (
            <span className="shrink-0 text-xs text-muted-foreground-weak">{argsCount} 个参数</span>
          )}
        </div>
        {/* 路径可能很长且中间才有差异，用 `truncate` 截尾加 `title` 给全文：
            换行会让每行高度不一致，列表看起来参差不齐。 */}
        <span
          className="truncate font-mono text-xs text-muted-foreground-weak"
          title={profile.executablePath}
        >
          {profile.executablePath}
        </span>
        {runSummary !== null && (
          <span className="truncate text-xs text-muted-foreground-weak">{runSummary}</span>
        )}
      </div>

      {canWrite && (
        <div className="flex shrink-0 items-center gap-1">
          {/* 路径失效时把「启动」换成「重新指定路径」。
              留着一个必然失败的启动按钮只会让用户点一次、收到同一条错误，而它本来就
              指向唯一有意义的动作。文件又回来了（U 盘重新插上、共享恢复）这种情况由
              表头的「重新检查路径」处理 —— 那是一次显式动作，比让用户去点一个我们
              刚说过不能用的按钮更清楚。 */}
          {pathMissing ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={onRelocate}
            >
              重新指定路径
            </Button>
          ) : (
            <Button type="button" size="sm" disabled={disabled} onClick={onLaunch}>
              {launching ? '启动中…' : '启动'}
            </Button>
          )}

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`上移 ${profile.name}`}
                disabled={disabled || !canMoveUp}
                onClick={() => onMove(-1)}
              >
                <ArrowUp />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">上移</TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`下移 ${profile.name}`}
                disabled={disabled || !canMoveDown}
                onClick={() => onMove(1)}
              >
                <ArrowDown />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">下移</TooltipContent>
          </Tooltip>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`更多操作：${profile.name}`}
                disabled={disabled}
              >
                <Ellipsis />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-36">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                编辑
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              {/* 删除用 destructive 样式，且与上面的编辑之间加分隔线：它不可撤销，
                  不该和「编辑」并排挨着。 */}
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </li>
  )
}
