import type { Event } from '@fanhe/shared'
import { Ellipsis, Pencil, Trash2 } from 'lucide-react'

import {
  EVENT_PRIORITY_CLASSES,
  EVENT_PRIORITY_LABELS,
  formatDueAt,
  isOverdue,
} from '../../lib/event-display'
import { cn } from '../../lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

/**
 * 事件列表的一行。
 *
 * 行的四样东西按实施方案第六章的顺序排：左侧勾选框、中间标题与标签、右侧截止时间与
 * 优先级。**行本身不是按钮** —— 勾选框、标题、行内菜单都是可交互元素，把整行包成一个
 * `<button>` 会得到嵌套的可点击元素（无效的 HTML，读屏也会念出两个入口）。
 *
 * **标题是打开详情面板的入口**（T3-12）。挑标题而不是「给行加一个图标按钮」，是因为
 * 详情要展示的正是「这一条完整是什么样」，而标题就是这一条的名字 —— 想细看它的人
 * 自然会往它身上点。行内菜单里不再放一个「详情」项：同一件事有两个入口时，用户会开始
 * 猜它们是不是不一样。
 *
 * **勾选框可点，是「完成 / 撤销完成」的入口**（T3-11）。它是这一行上唯一改变状态的
 * 控件：勾上即完成（服务端记下完成时刻与完成人），取消勾选即撤销（服务端把三列完成
 * 信息一起清空）。点击的即时反馈由 `EventsPanel` 的乐观更新给出 —— 这一行只负责把
 * 「此刻是什么状态」如实画出来，不自己持有状态。
 *
 * **两种「点不动」分得很开。** 只读角色（`canWrite` 为假）永远点不动；有写权限的人
 * 在另一条正在切换时也点不动（切换是串行的，见 `EventsPanel`）。前者的勾选框保持
 * 正常透明度（`disabled:opacity-100`）—— 只读角色看到一整片半透明的勾选框，会以为
 * 是列表坏了，而实际只是他没这个权限；后者的压暗则留着，它正好表达「正在处理」。
 *
 * **已完成的标题加删除线并转灰**，与勾选框的状态是同一个信号的两处表达。
 */
export function EventRow({
  event,
  canWrite,
  locked,
  switching,
  onToggle,
  onOpenDetail,
  onEdit,
  onDelete,
}: {
  event: Event
  /** 只读访客不能触发任何改动，连同行菜单一起收起。 */
  canWrite: boolean
  /** 另一条正在切换（切换是串行的），此刻这一行的勾选框也点不动。 */
  locked: boolean
  /** 正在切换的是**这一条**。用来给这一行一点「处理中」的样子。 */
  switching: boolean
  onToggle: () => void
  onOpenDetail: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const done = event.status === 'done'
  const overdue = isOverdue(event)
  const toggleable = canWrite && !locked && !switching

  return (
    <li className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
      <Checkbox
        checked={done}
        disabled={!toggleable}
        onCheckedChange={() => onToggle()}
        // 名字说的是**点它会做什么**，而不是它现在是什么 —— 「现在是什么」由
        // `aria-checked` 表达，读屏会把两者一起念出来。
        aria-label={`${event.title}：${done ? '撤销完成' : '标记完成'}`}
        // `mt-0.5` 对齐标题的首行基线。
        className={cn(
          'mt-0.5',
          toggleable ? 'cursor-pointer' : 'cursor-default',
          // 见组件注释：只有「只读角色」这一种点不动需要抹掉半透明。
          !canWrite && 'disabled:opacity-100',
        )}
      />

      {/* `min-w-0` 不能省：flex 子项的默认最小宽度是内容宽度，长标题会把这一行撑破，
          表现为右侧的截止时间与优先级被挤出可视区。 */}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        {/* 用裸 `button` 而不是 `Button` 组件：这里要的是一个「长得不像按钮的按钮」，
            而 `Button` 自带的高度、内边距与底色都要一条条覆盖掉，覆盖清单还会随组件
            改版而失效。折叠按钮（`EventList`）也是这么写的。

            `truncate` 在 `button` 上需要 `text-left` 配合：按钮默认居中，而标题居中
            之后与「左对齐的列表」这一整体版式对不上。`focus-visible` 那几条是给键盘
            用的 —— 这是行上唯一能打开详情的入口，不给焦点样式等于键盘用户进不去。 */}
        <button
          type="button"
          className={cn(
            'truncate rounded-sm text-left text-sm font-medium transition-colors',
            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-hidden',
            done
              ? 'text-muted-foreground line-through hover:text-foreground'
              : 'text-foreground hover:text-muted-foreground',
          )}
          onClick={onOpenDetail}
        >
          {event.title}
        </button>

        {event.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {/* 最多三个：标签多的时候这一行会被撑高，而它的作用是辨认是哪一条。 */}
            {event.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="max-w-24 truncate rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
              >
                {tag}
              </span>
            ))}
            {event.tags.length > 3 && (
              <span className="text-xs text-muted-foreground-weak">+{event.tags.length - 3}</span>
            )}
          </div>
        )}
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {event.dueAt !== null && (
          // 逾期写成前缀而不是只把日期涂红：颜色是唯一的信号时，色觉差异与黑白打印
          // 都会让它消失，而「已逾期」这几个字不会。
          <span
            className={cn(
              'text-xs',
              overdue ? 'font-medium text-destructive' : 'text-muted-foreground-weak',
            )}
          >
            {overdue ? `已逾期 · ${formatDueAt(event.dueAt)}` : formatDueAt(event.dueAt)}
          </span>
        )}

        {/* 优先级用 `outline` 变体：它是这一行的背景信息，不该像状态那样抢眼。 */}
        <Badge variant="outline" className={cn('shrink-0', EVENT_PRIORITY_CLASSES[event.priority])}>
          {EVENT_PRIORITY_LABELS[event.priority]}
        </Badge>

        {canWrite && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              {/* `aria-label` 以「更多操作」开头，与另外两个板块一致 —— e2e 按这个前缀
                  定位行内菜单。 */}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`更多操作：${event.title}`}
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
              {/* 删除不可撤销，与编辑之间加一道分隔，且用 destructive 样式。 */}
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 />
                删除
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  )
}
