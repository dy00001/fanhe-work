import { MoreHorizontal, Plus } from 'lucide-react'
import { useRef, useState } from 'react'

import {
  filterKey,
  type CaseFolderFilter,
  type CaseFolderGroup,
} from '../../lib/case-library-display'
import { cn } from '../../lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Input } from '../ui/input'

/**
 * 筛选条：全部 / 未归档 / 各文件夹 / 新建。
 *
 * **新建就在这一条上完成，不弹第二个窗。** 建文件夹是一个「起个名字」的动作，用一层
 * 弹窗把它包起来，用户要经历「点新建 → 等弹窗 → 输入 → 确定 → 弹窗关闭」五次状态变化，
 * 而其中只有一次是他真正做的事。原地变成一个输入框，回车即建好，是这类动作的正常写法。
 *
 * **删除不加确认框。** 代价是「里面的图回到未归档」，不是丢数据，而且界面上立刻可见
 * （它们出现在未归档里，也能重新选回去）。用一个确认框去拦一个可逆操作，只会训练用户
 * 闭眼点确定。为了让后果更明确，菜单项的文案直接写出张数。
 *
 * 重命名与新建共用 {@link InlineNameInput}：回车提交、Esc 取消、失焦提交。三条规则写
 * 在两处会分叉，而这个输入框本来就只有十几行。
 */
export function CaseFolderBar({
  groups,
  unassignedCount,
  totalCount,
  filter,
  onChange,
  onCreate,
  onRename,
  onDelete,
  folderLimitReached,
}: {
  groups: readonly CaseFolderGroup[]
  unassignedCount: number
  totalCount: number
  filter: CaseFolderFilter
  onChange: (filter: CaseFolderFilter) => void
  onCreate: (name: string) => Promise<boolean>
  onRename: (id: string, name: string) => Promise<boolean>
  onDelete: (group: CaseFolderGroup) => Promise<boolean>
  folderLimitReached: boolean
}) {
  const [creating, setCreating] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const activeKey = filterKey(filter)

  return (
    <div
      // 横滑而不是换行：筛选条占到两行时，图片区会被顶下去一截，而文件夹数量是会长的。
      // 与首页那条品类横滑条同一处理，滚动条隐藏。
      className="flex [scrollbar-width:none] items-center gap-2 overflow-x-auto border-b border-border px-6 py-3 [&::-webkit-scrollbar]:hidden"
      role="group"
      aria-label="按文件夹筛选"
    >
      <Chip
        label="全部"
        count={totalCount}
        active={activeKey === 'all'}
        onClick={() => onChange({ kind: 'all' })}
      />
      <Chip
        label="未归档"
        count={unassignedCount}
        active={activeKey === 'unassigned'}
        onClick={() => onChange({ kind: 'unassigned' })}
      />

      {groups.map((group) =>
        renamingId === group.folder.id ? (
          <div key={group.folder.id} className="shrink-0">
            <InlineNameInput
              initial={group.folder.name}
              placeholder="文件夹名"
              onCommit={async (name) => {
                const ok = await onRename(group.folder.id, name)
                if (ok) setRenamingId(null)
                return ok
              }}
              onCancel={() => setRenamingId(null)}
              className="h-8 w-40"
            />
          </div>
        ) : (
          <div
            key={group.folder.id}
            className={cn(
              'flex shrink-0 items-center rounded-full border text-sm transition-colors',
              activeKey === `folder:${group.folder.id}`
                ? 'border-transparent bg-foreground text-background'
                : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground',
            )}
          >
            <button
              type="button"
              onClick={() => onChange({ kind: 'folder', folderId: group.folder.id })}
              className="rounded-l-full py-1.5 pr-1 pl-3 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {group.folder.name}
              <span className="ml-1.5 text-xs tabular-nums opacity-60">{group.items.length}</span>
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`${group.folder.name} 的更多操作`}
                  className="mr-1 grid size-6 place-items-center rounded-full opacity-60 outline-none hover:bg-foreground/10 hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  <MoreHorizontal className="size-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuItem onSelect={() => setRenamingId(group.folder.id)}>
                  重命名
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => {
                    void onDelete(group)
                  }}
                >
                  {group.items.length === 0
                    ? '删除文件夹'
                    : `删除文件夹（${group.items.length} 张回到未归档）`}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ),
      )}

      {creating ? (
        <div className="shrink-0">
          <InlineNameInput
            initial=""
            placeholder="文件夹名，回车创建"
            onCommit={async (name) => {
              const ok = await onCreate(name)
              if (ok) setCreating(false)
              return ok
            }}
            onCancel={() => setCreating(false)}
            className="h-8 w-44"
          />
        </div>
      ) : (
        <button
          type="button"
          disabled={folderLimitReached}
          onClick={() => setCreating(true)}
          className="flex shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground outline-none hover:border-foreground/40 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          新建文件夹
        </button>
      )}
    </div>
  )
}

function Chip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex shrink-0 items-center rounded-full border px-3 py-1.5 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active
          ? 'border-transparent bg-foreground text-background'
          : 'border-border text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {label}
      <span className="ml-1.5 text-xs tabular-nums opacity-60">{count}</span>
    </button>
  )
}

/**
 * 原地输入框。回车提交、Esc 取消、失焦提交。
 *
 * 三个 ref 各管一件事，都是「同一动作被触发两次」造成的：
 *   - `settledRef`：回车提交后组件会卸载，卸载前浏览器还会补一次 `blur`，不挡住就会
 *     拿同一个名字再提交一遍（重名判断在服务端，第二次会 409，用户看到一句莫名其妙的
 *     「已有同名文件夹」）。
 *   - `cancelledRef`：Esc 之后同样会 `blur`，不挡住就会把刚放弃的名字提交上去。
 *   - `pendingRef`：连按两次回车。
 */
function InlineNameInput({
  initial,
  placeholder,
  onCommit,
  onCancel,
  className,
}: {
  initial: string
  placeholder: string
  onCommit: (name: string) => Promise<boolean>
  onCancel: () => void
  className?: string
}) {
  const [value, setValue] = useState(initial)
  const settledRef = useRef(false)
  const cancelledRef = useRef(false)
  const pendingRef = useRef(false)

  const commit = async () => {
    if (settledRef.current || cancelledRef.current || pendingRef.current) return
    // 空名字不提交：失焦时用户往往什么都没输，此时提交会拿到一句「不能为空」，
    // 而他的意图其实是「算了」。直接当作取消，少一次报错。
    if (value.trim() === '') {
      settledRef.current = true
      onCancel()
      return
    }
    pendingRef.current = true
    const ok = await onCommit(value)
    pendingRef.current = false
    if (ok) settledRef.current = true
  }

  return (
    <Input
      autoFocus
      value={value}
      placeholder={placeholder}
      maxLength={24}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => {
        void commit()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          void commit()
          return
        }
        if (event.key === 'Escape') {
          // 别让 Esc 冒到 Radix 的内容层上——那会连同整个图集一起关掉。
          event.stopPropagation()
          cancelledRef.current = true
          onCancel()
        }
      }}
      className={className}
    />
  )
}
