import { Check } from 'lucide-react'

import type { CaseAlbumItem } from '../../lib/case-library-display'
import { cn } from '../../lib/utils'

/**
 * 图片网格。
 *
 * **两种模式的唯一差别是「点一下之后发生什么」**：浏览态打开放大，选择态切换勾选。
 * 不做「浏览时也能勾选」——那要么让每张图都常驻一个复选框（视觉噪音），要么靠长按 /
 * 修饰键（没人在看图集时会去猜）。要整理就点「选择」，两种意图分开，各自都很直接。
 *
 * 缩略图用 `object-cover` 而不是 `object-contain`：网格要的是整齐，看清细节交给放大层。
 * 上一版正好相反（大图用 contain、没有网格），原因是它只有一张大图；现在两个诉求各有
 * 各的位置了。
 */
export function CaseImageGrid({
  items,
  selectMode,
  selected,
  onActivate,
}: {
  items: readonly CaseAlbumItem[]
  selectMode: boolean
  selected: ReadonlySet<string>
  onActivate: (item: CaseAlbumItem) => void
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((item) => {
        const isSelected = selected.has(item.id)
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onActivate(item)}
            // `aria-pressed` 只在选择态挂上：浏览态它不是开关，挂一个恒为 false 的
            // pressed 会让读屏用户以为「这张图没被选中」是个可操作的状态。
            aria-pressed={selectMode ? isSelected : undefined}
            aria-label={
              selectMode
                ? isSelected
                  ? `取消选择 ${item.alt}`
                  : `选择 ${item.alt}`
                : `放大查看 ${item.alt}`
            }
            className="group relative block overflow-hidden rounded-xl border border-border bg-muted text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <img
              // 网格里用缩略图（320px）。原图留给放大层 —— 一屏十几张都取 1000px，
              // 首次打开要下 1.6MB，而其中绝大多数用户根本不会放大看。
              src={item.thumb}
              alt={item.alt}
              loading="lazy"
              decoding="async"
              className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-[1.03]"
            />

            {selectMode && (
              <span
                className={cn(
                  'absolute top-2 left-2 grid size-5 place-items-center rounded-full border transition-colors',
                  isSelected
                    ? 'border-transparent bg-foreground text-background'
                    : 'border-white/70 bg-black/25 text-transparent',
                )}
              >
                <Check className="size-3" />
              </span>
            )}

            {isSelected && (
              <span className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-foreground/70 ring-inset" />
            )}
          </button>
        )
      })}
    </div>
  )
}
