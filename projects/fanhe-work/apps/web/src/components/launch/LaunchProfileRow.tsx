import type { LaunchProfile } from '@fanhe/shared'
import { ArrowDown, ArrowUp, Ellipsis, Pencil, Trash2 } from 'lucide-react'

import { LAUNCH_ICONS, launchSoftwareLabel, resolveLaunchIconKey } from '../../lib/launch-icons'
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
  /** 本条正在启动。按钮改为「启动中…」并禁用，避免连点。 */
  launching: boolean
  /** 列表级忙碌（重排或删除在飞）。此时所有行都不可操作。 */
  busy: boolean
  /** 能否上移/下移。首尾两项各有一个方向不可用。 */
  canMoveUp: boolean
  canMoveDown: boolean
  onLaunch: () => void
  onEdit: () => void
  onMove: (offset: -1 | 1) => void
  onDelete: () => void
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
  launching,
  busy,
  canMoveUp,
  canMoveDown,
  onLaunch,
  onEdit,
  onMove,
  onDelete,
}: LaunchProfileRowProps) {
  const Icon = LAUNCH_ICONS[resolveLaunchIconKey(profile)]
  const disabled = busy || launching
  const argsCount = profile.args.length

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
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <Button type="button" size="sm" disabled={disabled} onClick={onLaunch}>
          {launching ? '启动中…' : '启动'}
        </Button>

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
    </li>
  )
}
