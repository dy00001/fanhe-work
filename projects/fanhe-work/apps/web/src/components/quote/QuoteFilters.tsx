import {
  QUOTE_SOURCES,
  QUOTE_SOURCE_NAMES,
  type QuoteMetaResponse,
  type QuoteSource,
} from '@fanhe/shared'
import { useMemo } from 'react'

import { cn } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'

/**
 * 左栏筛选：来源 + 分类，都带条数。
 *
 * ## 为什么条数要从 `meta.categories` 聚合，而不是再来一个「统计接口」
 *
 * `/quote/meta` 已经返回了 `{ source, name, count }` 的完整清单（1225 条全在这里），
 * 来源合计就是按 `source` 把 count 加起来。为三个数字再发一次请求，会多一个「两边
 * 对不上」的机会，而这类不一致只在筛选之后才看得出来。
 *
 * ## 为什么它不持有状态
 *
 * 这一栏只是「当前筛选条件」的另一种呈现。条件留在 `QuotePanel` 里，因为换条件要
 * 连带把分页归零、并触发一次检索 —— 那些是编排层的事。子组件自己存一份的话，两处
 * 状态会漂开，表现是「点了左栏但列表没动」。
 *
 * ## 选中态用 `aria-selected` 而不是「换一套颜色」
 *
 * 颜色由 `bg-accent` 表达，语义由 `role="option"` + `aria-selected` 表达。只给颜色
 * 的话，读屏念出来的是一串没有状态的按钮名。
 */

type FilterCounts = {
  total: number
  bySource: Record<QuoteSource, number>
}

const EMPTY_COUNTS: FilterCounts = {
  total: 0,
  bySource: { sale: 0, craft: 0, hardware: 0 },
}

export function QuoteFilters({
  meta,
  source,
  category,
  onSource,
  onCategory,
  className,
}: {
  meta: QuoteMetaResponse | null
  source: QuoteSource | null
  category: string
  onSource: (value: QuoteSource | null) => void
  onCategory: (value: string) => void
  className?: string
}) {
  const counts = useMemo<FilterCounts>(() => {
    if (meta === null) return EMPTY_COUNTS
    const bySource: Record<QuoteSource, number> = { sale: 0, craft: 0, hardware: 0 }
    for (const entry of meta.categories) bySource[entry.source] += entry.count
    return { total: meta.itemCount, bySource }
  }, [meta])

  /** 分类清单跟着来源走：选了「五金」再列出 45 个柜体分类，点进去必然是空的。 */
  const categories = useMemo(() => {
    if (meta === null) return []
    return meta.categories.filter((entry) => (source === null ? true : entry.source === source))
  }, [meta, source])

  const categoryTotal = useMemo(
    () => categories.reduce((sum, entry) => sum + entry.count, 0),
    [categories],
  )

  return (
    <aside
      aria-label="筛选"
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card',
        className,
      )}
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        <p className="px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground-weak">
          来源
        </p>
        {meta === null ? (
          <FilterSkeleton rows={4} />
        ) : (
          <>
            <FilterItem
              active={source === null}
              label="全部"
              count={counts.total}
              onClick={() => {
                onSource(null)
              }}
            />
            {QUOTE_SOURCES.map((value) => (
              <FilterItem
                key={value}
                active={source === value}
                label={QUOTE_SOURCE_NAMES[value]}
                count={counts.bySource[value]}
                onClick={() => {
                  onSource(value)
                }}
              />
            ))}

            <p className="mt-2 px-2 pt-1 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground-weak">
              分类 / 系列
            </p>
            <FilterItem
              active={category === ''}
              label="全部分类"
              count={categoryTotal}
              onClick={() => {
                onCategory('')
              }}
            />
            {categories.map((entry) => (
              <FilterItem
                key={`${entry.source}\u001f${entry.name}`}
                active={category === entry.name}
                label={entry.name}
                count={entry.count}
                title={`${QUOTE_SOURCE_NAMES[entry.source]} · ${entry.name}`}
                onClick={() => {
                  onCategory(entry.name)
                }}
              />
            ))}
          </>
        )}
      </div>
    </aside>
  )
}

/**
 * 一条筛选项。
 *
 * 条数用 `tabular-nums` 右对齐：1225 与 32 位数不同，不对齐的话这一列会参差。
 * 长分类名截断，全名放 `title` —— 「免漆类（爱格同步木纹柜）」这种名字在 212px 里
 * 放不下，而缩成「免漆类（爱格…」又分不清是哪一个。
 */
function FilterItem({
  active,
  label,
  count,
  title,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      title={oneLine(title ?? label)}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors',
        active
          ? 'bg-accent font-medium text-foreground'
          : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
      )}
    >
      {/* 台账里有几个分类名内部带换行（「门板工艺 + 换行 + 洞洞板配套五金」），
          原样输出会在这个 212px 的栏里断成两行、把整组撑歪。统一折成空格。
          `title` 也要折 —— 不折的话浏览器原生 tooltip 会在换行处断开。 */}
      <span className="min-w-0 flex-1 truncate">{oneLine(label)}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground-weak tabular-nums">{count}</span>
    </button>
  )
}

/**
 * 把任意空白（含台账里的换行）折成单个空格。
 *
 * 分类名里有「门板工艺 + 换行 + 洞洞板配套五金」这样的条目 —— 显示与 tooltip
 * 都要折，否则前者撑歪整组、后者在换行处断开。
 */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 清单还没回来时的占位。不给的话左栏会先塌成一条线，回来再撑开。 */
function FilterSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-1 px-2 py-1">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className="h-5 w-full rounded-md" />
      ))}
    </div>
  )
}
