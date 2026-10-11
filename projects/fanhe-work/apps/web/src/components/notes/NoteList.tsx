import type { Note } from '@fanhe/shared'
import { Pin } from 'lucide-react'

import { formatRelativeTime } from '../../lib/relative-time'
import { cn } from '../../lib/utils'

/**
 * 纪要列表。
 *
 * **只按服务端给的顺序渲染，不在这里排序。** 排序规则（置顶 → 更新时间 → 创建时间）
 * 写在服务端的 `listNotes` 里，界面再排一遍就有两份顺序定义，而它们会在某次改动后
 * 悄悄分叉 —— 那时的表现是「刚置顶的那条没到最前面」，很像是接口没生效。
 *
 * 一行里放四样东西：置顶标记、标题、标签、更新时间。摘要不放：正文是 Markdown，
 * 截出来的一段会带着 `#` `*` 这类记号，去掉它们又是一次渲染，而列表的作用是找到
 * 那一条，不是读它。
 */
export function NoteList({
  notes,
  selectedId,
  onSelect,
}: {
  notes: readonly Note[]
  selectedId: string | null
  onSelect: (note: Note) => void
}) {
  return (
    <ul className="flex flex-col gap-1">
      {notes.map((note) => {
        const selected = note.id === selectedId
        return (
          <li key={note.id}>
            <button
              type="button"
              // `aria-current` 而不是只靠底色：选中态在视觉上是一块浅灰，而
              // 读屏用户拿不到这个信息。
              aria-current={selected ? 'true' : undefined}
              className={cn(
                'flex w-full flex-col gap-1.5 rounded-lg border border-solid px-3 py-2.5 text-left transition-colors',
                selected ? 'border-border bg-accent' : 'border-transparent hover:bg-accent/60',
              )}
              onClick={() => onSelect(note)}
            >
              <div className="flex items-start gap-2">
                {note.pinned && (
                  // 置顶标记不带文字：它在列表里的含义由位置（排在最前）已经表达，
                  // 补一个「已置顶」的字样反而会挤掉标题。
                  <Pin
                    className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                    aria-label="已置顶"
                  />
                )}
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {note.title}
                </span>
              </div>

              {note.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {/* 最多显示三个。标签多的时候列表行会被撑高，而这一行的作用是
                      辨认是哪一条，翻完整列标签不是。 */}
                  {note.tags.slice(0, 3).map((tag) => (
                    <span
                      key={tag}
                      className="max-w-24 truncate rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
                    >
                      {tag}
                    </span>
                  ))}
                  {note.tags.length > 3 && (
                    <span className="text-xs text-muted-foreground-weak">
                      +{note.tags.length - 3}
                    </span>
                  )}
                </div>
              )}

              <span className="text-xs text-muted-foreground-weak">
                {formatRelativeTime(note.updatedAt)}
                {note.archivedAt !== null && ' · 已归档'}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
