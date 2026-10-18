import { Image as ImageIcon } from 'lucide-react'
import { useRef, useState } from 'react'

import {
  ALL_CASE_CATEGORIES,
  CASE_CATEGORIES,
  countCaseSlots,
  filterCaseCategories,
  type CaseCategory,
} from '../../lib/case-catalog'
import { cn } from '../../lib/utils'
import { DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

/**
 * 「全部品类」窗口。
 *
 * **为什么是一个窗口而不是一个新页面。** 首页的案例条只是入口，用户点「全部品类」要
 * 看的是「九个品类各自有哪些案例」这一张全景，看完多半还要回到首页继续看启动与纪要。
 * 跳到 `/workbench/cases` 会把他带走，回来还得再点一次导航；而这个窗口关掉就落回原位，
 * 滚动位置与横滑位置都还在。首页三段是纵向排列的，多一个可路由的子页面也会让侧栏
 * 「首页」的高亮语义变得含糊。
 *
 * **筛选放在窗口内，而不是拆成九个页面。** 九个品类两屏就能排完，让用户在窗口里切
 * 比让他关掉窗口再点下一张卡少两步。默认「全部」——「全部品类」这个入口名本身承诺的
 * 就是全量，一进来就筛掉八个品类，与按钮上写的话相反。
 *
 * **筛选状态不随关闭重置。** 关掉再打开时回到用户上次看的位置，比重置成「全部」更
 * 省事；而「关闭动画期间把内容换回全部」会让窗口在消失前闪一下，那是实打实的视觉
 * 缺陷。宁可记住，也不闪。
 *
 * **本组件只画窗口内容，不画根与触发器。** 入口按钮在区块头部，而 Radix 的
 * `DialogTrigger` 必须与 `Dialog` 处在同一个上下文里才能完成两件事：打开时把
 * `aria-expanded` / `aria-controls` 挂到按钮上，关闭时把焦点还给它。把根与触发器
 * 留在 `CaseGallery` 里、这里只导出内容，是让这两件事各归其位的最短路径。
 */
export function CaseGalleryDialogContent() {
  const [activeCategory, setActiveCategory] = useState<string>(ALL_CASE_CATEGORIES)
  const listRef = useRef<HTMLDivElement>(null)

  const visible = filterCaseCategories(CASE_CATEGORIES, activeCategory)
  const visibleSlots = countCaseSlots(visible)

  /**
   * 切品类时把内容区滚回顶部。
   *
   * 不滚的话，从「全部」底部切到某个只有一行的品类，用户会落在空白里，第一反应是
   * 「这个品类没有案例」。这里直接改 `scrollTop` 而不是 `scrollTo` 平滑滚动：内容刚
   * 换成更短的一组，平滑滚动在换内容的那一帧上会算错终点。
   */
  const selectCategory = (categoryId: string) => {
    setActiveCategory(categoryId)
    if (listRef.current !== null) listRef.current.scrollTop = 0
  }

  return (
    <DialogContent
      className={[
        // 默认是 `sm:max-w-lg` 的小对话框。这里要放下三列卡片，宽度跟着内容走，
        // 但两边各留 4vw，窄屏（例如 1024 宽的外壳窗口）下才不至于顶到屏幕边缘。
        'max-h-[88vh] gap-0 p-0 sm:max-w-[min(1120px,92vw)]',
        // 三行式：头部固定、筛选行固定、只有内容区滚。整块一起滚会把筛选行和关闭
        // 按钮一起带走，用户滚到第 7 个品类就再也切不了品类。
        'grid-rows-[auto_auto_minmax(0,1fr)]',
      ].join(' ')}
    >
      <DialogHeader className="px-6 pt-6 pb-4">
        {/* `pr-8` 给右上角的关闭按钮让位。 */}
        <DialogTitle className="pr-8 text-left">全部品类</DialogTitle>
        <DialogDescription className="text-left">
          共 {visible.length} 个品类、{visibleSlots} 个案例位。案例封面与内容尚未接入，
          先按品类占位。
        </DialogDescription>
      </DialogHeader>

      <CategoryFilter active={activeCategory} onSelect={selectCategory} />

      <div ref={listRef} className="min-h-0 overflow-y-auto px-6 pt-5 pb-6">
        {visible.map((category) => (
          <CategoryGroup key={category.id} category={category} />
        ))}
      </div>
    </DialogContent>
  )
}

/**
 * 品类筛选行。
 *
 * 用 `aria-pressed` 的普通按钮而不是 `role="tab"`：这里切换的是同一份列表的筛选条件，
 * 没有九个各自独立的面板要对应，标签页语义会把读屏用户引到一堆并不存在的面板上。
 *
 * 横向溢出时保留滚动能力（窄窗口下十个选项排不下），但隐藏滚动条 —— 这一行只有 32px
 * 高，一条系统滚动条会把它压掉一半。
 */
function CategoryFilter({
  active,
  onSelect,
}: {
  active: string
  onSelect: (categoryId: string) => void
}) {
  return (
    <div
      role="group"
      aria-label="按品类筛选"
      className={[
        'flex gap-2 overflow-x-auto border-y border-border-soft px-6 py-3',
        '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
      ].join(' ')}
    >
      <FilterChip
        active={active === ALL_CASE_CATEGORIES}
        onClick={() => onSelect(ALL_CASE_CATEGORIES)}
      >
        全部
      </FilterChip>
      {CASE_CATEGORIES.map((category) => (
        <FilterChip
          key={category.id}
          active={active === category.id}
          onClick={() => onSelect(category.id)}
        >
          {category.name}
        </FilterChip>
      ))}
    </div>
  )
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: string
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full border px-3 py-1 text-sm whitespace-nowrap transition-colors outline-none',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
        active
          ? 'border-transparent bg-foreground font-medium text-background'
          : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {children}
    </button>
  )
}

/**
 * 一个品类的案例分组。
 *
 * 组头带案例数：窗口顶部那句「共 N 个案例位」是总量，落到每个品类上还得有各自的数，
 * 否则「这个品类有几个」只能靠数卡片。
 */
function CategoryGroup({ category }: { category: CaseCategory }) {
  return (
    <section className="[&+section]:mt-8">
      <div className="mb-3 flex items-baseline gap-2">
        <h3 className="text-base leading-6 font-medium">{category.name}</h3>
        <span className="text-xs text-muted-foreground-weak">{category.cases.length} 个案例</span>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        {category.cases.map((slot, index) => (
          <article key={slot.id} className="flex min-w-0 flex-col">
            {/* 封面位沿用首页卡片的比例与配色，两处看起来才是同一套案例卡。 */}
            <div className="flex aspect-[400/234] w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-border bg-[color-mix(in_srgb,var(--m-neutral)_4%,var(--card))]">
              <span className="grid size-10 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--m-neutral)_var(--wash),var(--card))] text-m-neutral">
                <ImageIcon className="size-5" />
              </span>
              <span className="text-sm text-muted-foreground-weak">封面待补</span>
            </div>

            <div className="mt-2 flex items-baseline justify-between gap-2">
              {/* 标题为空时不编名字，只报序号 —— 序号是位子的真实属性，名字不是。 */}
              <span className="min-w-0 truncate text-sm font-medium">
                {slot.title === ''
                  ? `${category.name}案例 ${String(index + 1).padStart(2, '0')}`
                  : slot.title}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground-weak">待补</span>
            </div>
          </article>
        ))}
      </div>
    </section>
  )
}
