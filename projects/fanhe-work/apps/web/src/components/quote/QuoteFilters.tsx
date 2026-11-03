import type { QuoteMetaResponse, QuoteSource } from '@fanhe/shared'
import { useMemo } from 'react'

import { quoteSourceColor } from '../../lib/quote-display'
import { cn } from '../../lib/utils'
import { Skeleton } from '../ui/skeleton'

/**
 * 左栏筛选：来源 + 分类，都带条数。**逐项对齐静态稿 `.filters` / `.fopt`。**
 *
 * 尺寸与排版照抄：宽 212、右侧一条分隔线、内边距 12/10；分组标题 11px、字距 .04em；
 * 每条 13px、内边距 6/8、圆角 8，条数右对齐并用等宽数字。
 *
 * ## 来源与颜色都从 `meta.sources` 来，不写死三值表
 *
 * 主类可以自建之后，两张写死的表各有各的坏法：
 * `SOURCE_COLOR: Record<QuoteSource, string>` 对新来源是 `undefined` —— 圆点变透明，
 * 看着像少画一个，不报错；而 `QUOTE_SOURCES` 只含内置三类，自建主类**根本不会出现
 * 在筛选栏里**，人只会以为「新建的主类没生效」。
 *
 * 颜色统一走 `quoteSourceColor()` —— 结果表的来源标签、详情浮层的圆点都调它。谁在这里
 * 另写一份表，同一个主类就会在两个位置显示成两种颜色（2026-11-03 出过一次，见
 * `docs/QUOTE-SOURCES-MERGE-2026-11-03.md` 第七节）。
 *
 * ## 条数从 `meta.categories` 聚合，不另开统计接口
 *
 * 为几个数字再发一次请求，只会多一个「两边对不上」的机会，而这类不一致只在筛选
 * 之后才看得出来。
 *
 * ## 它不持有状态
 *
 * 这一栏只是「当前筛选条件」的另一种呈现。条件留在 `QuotePanel` 里，因为换条件要
 * 连带把分页归零并触发一次检索。子组件自己存一份，两处会漂开，表现是「点了左栏
 * 但列表没动」。
 */
type FilterCounts = {
  total: number
  bySource: Map<string, number>
}

const EMPTY_COUNTS: FilterCounts = {
  total: 0,
  bySource: new Map(),
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
    const bySource = new Map<string, number>()
    for (const entry of meta.categories) {
      bySource.set(entry.source, (bySource.get(entry.source) ?? 0) + entry.count)
    }
    return { total: meta.itemCount, bySource }
  }, [meta])

  /** 分类清单跟着来源走：选了「五金」再列出 45 个柜体分类，点进去必然是空的。 */
  const categories = useMemo(() => {
    if (meta === null) return []
    return meta.categories.filter((entry) => (source === null ? true : entry.source === source))
  }, [meta, source])

  /** 分类行上的 `title` 要写「哪个来源 · 哪个分类」，名字同样只能来自 meta。 */
  const sourceNames = useMemo(
    () => new Map((meta?.sources ?? []).map((entry) => [entry.code, entry.name])),
    [meta],
  )

  const categoryTotal = useMemo(
    () => categories.reduce((sum, entry) => sum + entry.count, 0),
    [categories],
  )

  return (
    <aside
      aria-label="筛选"
      className={cn('shrink-0 overflow-auto border-r border-border-soft px-2.5 py-3', className)}
    >
      <h5 className="mx-1.5 mt-2.5 mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted-foreground-weak">
        来源
      </h5>
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
          {(meta.sources ?? []).map((entry) => (
            <FilterItem
              key={entry.code}
              active={source === entry.code}
              label={entry.name}
              count={counts.bySource.get(entry.code) ?? 0}
              dot={quoteSourceColor(entry.code)}
              onClick={() => {
                onSource(entry.code)
              }}
            />
          ))}

          <h5 className="mx-1.5 mt-2.5 mb-1.5 text-[11px] font-medium tracking-[0.04em] text-muted-foreground-weak">
            分类 / 系列
          </h5>
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
              title={`${sourceNames.get(entry.source) ?? entry.source} · ${entry.name}`}
              onClick={() => {
                onCategory(entry.name)
              }}
            />
          ))}
        </>
      )}
    </aside>
  )
}

/**
 * 一条筛选项。
 *
 * 选中态照静态稿：`background:secondary` + 字重 500，**不是**主色块 —— 这一栏有
 * 四十多条，主色块会让整列看起来像一串按钮。
 *
 * 条数用 `tabular-nums`：1225 与 32 位数不同，不对齐这一列会参差。长分类名截断，
 * 全名放 `title`。
 */
function FilterItem({
  active,
  label,
  count,
  title,
  dot,
  onClick,
}: {
  active: boolean
  label: string
  count: number
  title?: string
  /** 来源色点。分类项没有。 */
  dot?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={oneLine(title ?? label)}
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[13px]',
        active
          ? 'bg-secondary font-medium text-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground',
      )}
    >
      {dot !== undefined && (
        <span
          aria-hidden="true"
          style={{ background: dot }}
          className="size-1.5 shrink-0 rounded-full"
        />
      )}
      {/* 台账里有几个分类名内部带换行（「门板工艺 + 换行 + 洞洞板配套五金」），
          原样输出会在这个 212px 的栏里断成两行、把整组撑歪。统一折成空格。
          `title` 也要折 —— 不折的话浏览器原生 tooltip 会在换行处断开。 */}
      <span className="min-w-0 flex-1 truncate">{oneLine(label)}</span>
      <span className="ml-auto shrink-0 text-[11px] text-muted-foreground-weak tabular-nums">
        {count}
      </span>
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
