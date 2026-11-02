import {
  PERMISSIONS,
  QUOTE_LIMITS,
  QUOTE_SOURCE_NAMES,
  QUOTE_SOURCES,
  type QuoteAccessStateResponse,
  type QuoteItemDto,
  type QuoteItemResponse,
  type QuoteMetaResponse,
  type QuoteSource,
} from '@fanhe/shared'
import {
  ChevronLeft,
  ChevronRight,
  ImageOff,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useAuth } from '../../auth/useAuth'
import { ApiError } from '../../lib/api'
import {
  loadQuoteAccessState,
  loadQuoteImageUrl,
  loadQuoteItem,
  loadQuoteMeta,
  prepareQuoteImage,
  quoteWriteExit,
  releaseQuoteImages,
  removeQuoteImage,
  saveQuotePrice,
  saveQuoteStatus,
  searchQuotes,
  uploadQuoteImage,
} from '../../lib/quote'
import {
  describeBindType,
  describeDataset,
  describePrice,
  describeStatus,
  formatYuan,
  itemQualifier,
  splitHighlight,
} from '../../lib/quote-display'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

import { PriceGateDialog } from './PriceGateDialog'
import { QuoteLightbox } from './QuoteLightbox'

/**
 * 报价查价面板。
 *
 * 首页那张模块卡与 `/workbench/quote` 共用这一个组件：卡里是弹窗、页面里是整页。
 * 分两套实现的话，「搜索结果的高亮」「同名多行怎么区分」「改价之后哪一块要刷新」
 * 这些规则会各写一遍，然后在某次改动里漂开。
 *
 * ## 布局：左结果、右详情
 *
 * 台账里的图是 339px 的中位宽，放进一列 56px 的行里只是「认得出是什么」；真要看清
 * 结构要点开灯箱。右栏承担的是「这条到底多少钱、有没有图、能不能改」，所以它跟着
 * 选中的行变，而不是再开一层弹窗 —— 一层弹窗里再套一层，关的时候很容易把人送错地方。
 *
 * ## 价格永远按形态显示
 *
 * `describePrice` 是唯一入口（在 `lib/quote-display.ts`，纯函数、有单测）。这里不写
 * 任何 `¥${fen/100}` —— 那正是把「1.5 倍」渲染成 `¥1.5` 的写法。
 *
 * ## 改价之后刷新什么
 *
 * 服务端返回新的 `version` 与**落库后的整条记录**，界面照着替换那一行即可；列表
 * 用 `reloadToken` 重查一次。**不做本地推算**：多设备并发时「我改完之后应该是什么
 * 样」猜不准，而猜错的后果是界面上显示一个库里不存在的价格。
 *
 * ## 加载态是推导出来的，不是写进去的
 *
 * 列表与详情都只保存「带请求指纹的结果」，渲染时判断指纹是否等于当前请求：不相等
 * 就是加载中。这是本仓库既有的做法（见 `lib/use-ops-dashboard.ts` 顶部）。在 effect
 * 开头 `setLoading(true)` 会撞 `react-hooks/set-state-in-effect`，而且那版有真的
 * 问题 —— effect 在提交之后才跑，会多一次级联渲染，列表在切换筛选时闪一下。
 *
 * 筛选变化时回到第一页这条也**不在 effect 里写**：它写在三个筛选控件的回调里
 * （{@link applySource} 等）。写在 effect 里的话，`offset` 会先按旧值发一次请求，
 * 再被清零发第二次。
 */
const PAGE_SIZE = QUOTE_LIMITS.PAGE_SIZE_DEFAULT

/** 空结果的稳定引用。每次渲染新建 `[]` 会让下游的 memo 全部失效。 */
const NO_ROWS: readonly QuoteItemDto[] = []

type QuotePanelProps = {
  /** 弹窗形态下限制高度，整页形态下铺满。 */
  variant?: 'dialog' | 'page'
  /** 关掉整个面板（弹窗形态的右上角）。 */
  onRequestClose?: () => void
}

export function QuotePanel({ variant = 'dialog', onRequestClose }: QuotePanelProps) {
  const { can } = useAuth()
  const canRead = can(PERMISSIONS.PERSONAL_QUOTE_READ)

  const [meta, setMeta] = useState<QuoteMetaResponse | null>(null)
  const [metaError, setMetaError] = useState<string | null>(null)

  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [source, setSource] = useState<QuoteSource | null>(null)
  const [category, setCategory] = useState<string>('')
  const [offset, setOffset] = useState(0)
  const [reloadToken, setReloadToken] = useState(0)

  /**
   * 列表结果与它对应的请求指纹。
   *
   * 只保存一份「已完成的请求」，**不保存 loading**：指纹不等于当前请求就是加载中。
   * 因此失败与成功都能落在同一次比较里，不会出现「loading 忘了复位、界面永远转圈」。
   */
  const [listEntry, setListEntry] = useState<{
    key: string
    rows: readonly QuoteItemDto[]
    total: number
    error: string | null
  } | null>(null)

  const [selectedCode, setSelectedCode] = useState<string | null>(null)
  const [detailEntry, setDetailEntry] = useState<{
    key: string
    value: QuoteItemResponse | null
  } | null>(null)

  const [access, setAccess] = useState<QuoteAccessStateResponse | null>(null)
  const [gateOpen, setGateOpen] = useState(false)

  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [lightboxFailed, setLightboxFailed] = useState(false)

  // 面板关闭时释放 object URL。不释放的话每开一次面板就攒十几 MB，直到整页刷新。
  useEffect(() => releaseQuoteImages, [])

  useEffect(() => {
    let cancelled = false
    loadQuoteMeta()
      .then((value) => {
        if (!cancelled) setMeta(value)
      })
      .catch((error: unknown) => {
        if (!cancelled) setMetaError(error instanceof ApiError ? error.message : '加载失败')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const refreshAccess = useCallback(() => {
    loadQuoteAccessState()
      .then(setAccess)
      .catch(() => setAccess(null))
  }, [])

  useEffect(refreshAccess, [refreshAccess])

  // 输入防抖 250ms。查一次要过一遍 1225 行，逐字触发会让每次按键都排一个请求，
  // 而结果区的闪烁比「慢 250 毫秒」更烦人。
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(keyword.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [keyword])

  const listKey = `${debounced}\u001f${source ?? ''}\u001f${category}\u001f${offset}\u001f${reloadToken}`

  useEffect(() => {
    let cancelled = false
    searchQuotes({
      q: debounced,
      ...(source === null ? {} : { source }),
      ...(category === '' ? {} : { category }),
      limit: PAGE_SIZE,
      offset,
    })
      .then((result) => {
        if (cancelled) return
        setListEntry({ key: listKey, rows: result.items, total: result.total, error: null })
        // 选中态保持在当前行；那一行不在本页时清掉，避免右栏显示一条列表里没有的报价。
        setSelectedCode((current) =>
          current !== null && result.items.some((item) => item.code === current) ? current : null,
        )
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setListEntry({
          key: listKey,
          rows: NO_ROWS,
          total: 0,
          error: error instanceof ApiError ? error.message : '加载失败',
        })
      })
    return () => {
      cancelled = true
    }
  }, [listKey, debounced, source, category, offset])

  const listReady = listEntry !== null && listEntry.key === listKey
  const rows = listReady ? listEntry.rows : NO_ROWS
  const total = listReady ? listEntry.total : 0
  const loading = !listReady
  const listError = listReady ? listEntry.error : null

  // 选中项详情。列表里已经有价格了，但详情还要图与备注 —— 单独取一次，带缓存的是字节。
  const detailKey = selectedCode === null ? null : `${selectedCode}\u001f${reloadToken}`

  useEffect(() => {
    let cancelled = false
    if (detailKey !== null && selectedCode !== null) {
      loadQuoteItem(selectedCode)
        .then((value) => {
          if (!cancelled) setDetailEntry({ key: detailKey, value })
        })
        .catch(() => {
          if (!cancelled) setDetailEntry({ key: detailKey, value: null })
        })
    }
    return () => {
      cancelled = true
    }
  }, [detailKey, selectedCode])

  const detailReady = detailKey !== null && detailEntry !== null && detailEntry.key === detailKey
  const detail = detailReady ? detailEntry.value : null
  const detailLoading = detailKey !== null && !detailReady

  const categories = useMemo(() => {
    if (meta === null) return []
    return meta.categories.filter((item) => (source === null ? true : item.source === source))
  }, [meta, source])

  const openLightbox = useCallback((key: string | null, version: string | null) => {
    if (key === null) return
    setLightboxOpen(true)
    setLightboxSrc(null)
    setLightboxFailed(false)
    void loadQuoteImageUrl(key, 'full', version).then((url) => {
      if (url === null) setLightboxFailed(true)
      else setLightboxSrc(url)
    })
  }, [])

  /** 换筛选条件时回到第一页。写在回调里而不是 effect 里，理由见文件头。 */
  function applySource(next: QuoteSource | null): void {
    setSource(next)
    setOffset(0)
  }

  function applyCategory(next: string): void {
    setCategory(next)
    setOffset(0)
  }

  const maxOffset = Math.max(0, Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE)
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))

  if (!canRead) {
    return (
      <p className="p-6 text-sm text-muted-foreground">
        当前账号没有查看报价的权限（需要 `personal.quote.read`）。
      </p>
    )
  }

  return (
    <div
      className={[
        'flex min-h-0 flex-col gap-4',
        // 弹窗形态给一个**确定的**高度：`h-full` 在这里解不出来 —— 外层是
        // `grid-rows-[auto_minmax(0,1fr)]` + `max-h` 的自动高容器，百分比高会绕回自己。
        // 70vh 留出的余量是给弹窗头部与内边距的（约 104px），两者相加不超过外层的
        // `max-h-[94vh]`；不留余量的话超出部分会被外层的 `overflow-hidden` 从**底部**
        // 裁掉，而右栏的维护区正在底部。
        //
        // 整页形态反过来用 `flex-1`：外框（`WorkbenchPage`）是 `h-full` 的弹性列，
        // 头部占自然高、面板吃掉剩下的全部。**这里不能用 `h-full`** —— 100% 是按
        // 外框算的，会把头部那一段也算进来，面板底部被顶出可视区。
        variant === 'dialog' ? 'h-[min(70vh,680px)]' : 'min-h-0 flex-1',
      ].join(' ')}
    >
      {/* 顶部：搜索与筛选 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜产品名、型号或规格，例如「拉篮」「3177007」「爱格」"
            maxLength={QUOTE_LIMITS.QUERY_MAX}
            className="pl-8"
            aria-label="搜索报价"
          />
          {keyword !== '' && (
            <button
              type="button"
              onClick={() => setKeyword('')}
              aria-label="清除搜索"
              className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          <FilterChip active={source === null} onClick={() => applySource(null)}>
            全部
          </FilterChip>
          {QUOTE_SOURCES.map((value) => (
            <FilterChip key={value} active={source === value} onClick={() => applySource(value)}>
              {QUOTE_SOURCE_NAMES[value]}
            </FilterChip>
          ))}
        </div>

        <select
          value={category}
          onChange={(event) => applyCategory(event.target.value)}
          aria-label="按分类筛选"
          className="h-9 max-w-[220px] rounded-lg border border-border bg-card px-2 text-sm"
        >
          <option value="">全部分类</option>
          {categories.map((item) => (
            <option key={`${item.source}\u001f${item.name}`} value={item.name}>
              {item.name}（{item.count}）
            </option>
          ))}
        </select>

        {onRequestClose !== undefined && (
          <Button type="button" variant="ghost" size="sm" onClick={onRequestClose}>
            关闭
          </Button>
        )}
      </div>

      {/* 数据集版本。**放在这里而不是页脚**：它回答的是「我看到的价格是哪一版」，
          而这个问题在开始查之前就该有答案。 */}
      <p className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
        {meta === null ? (
          metaError === null ? (
            '正在读取台账版本…'
          ) : (
            <span className="text-destructive">{metaError}</span>
          )
        ) : (
          <>
            <span>{describeDataset(meta)}</span>
            <span className="text-border">|</span>
            <span>版本 {meta.version.slice(0, 12) || '未导入'}</span>
            <span className="text-border">|</span>
            <span>
              {access === null
                ? '维护权限读取中…'
                : access.direct
                  ? '超级管理员，可直接改价'
                  : access.unlockedUntil !== null
                    ? '维护已解锁'
                    : '改价需要维护口令'}
            </span>
            {access !== null && !access.direct && (
              <button
                type="button"
                onClick={() => setGateOpen(true)}
                className="flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
              >
                <KeyRound className="size-3" />
                {access.hasSecret ? '解锁维护' : '设置口令'}
              </button>
            )}
            {access !== null && access.direct && (
              <button
                type="button"
                onClick={() => setGateOpen(true)}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {access.hasSecret ? '修改维护口令' : '设置维护口令'}
              </button>
            )}
          </>
        )}
      </p>

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        {/* 左：结果列表 */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-3 py-2 text-xs text-muted-foreground">
            <span>
              {loading ? '正在检索…' : `命中 ${total} 条`}
              {total > 0 ? ` · 第 ${currentPage}/${pageCount} 页` : ''}
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                aria-label="上一页"
                disabled={offset === 0 || loading}
                onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
                className="rounded p-1 hover:bg-accent disabled:opacity-40"
              >
                <ChevronLeft className="size-4" />
              </button>
              <button
                type="button"
                aria-label="下一页"
                disabled={offset >= maxOffset || loading}
                onClick={() => setOffset((value) => Math.min(maxOffset, value + PAGE_SIZE))}
                className="rounded p-1 hover:bg-accent disabled:opacity-40"
              >
                <ChevronRight className="size-4" />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {listError !== null ? (
              <p className="p-6 text-sm text-destructive">{listError}</p>
            ) : rows.length === 0 && !loading ? (
              <p className="p-6 text-sm text-muted-foreground">
                没有匹配的条目。换个说法试试 —— 台账里柜体类只有名称，没有型号。
              </p>
            ) : (
              <ul className="divide-y divide-border-soft">
                {rows.map((item) => (
                  <QuoteRow
                    key={item.code}
                    item={item}
                    keyword={debounced}
                    selected={item.code === selectedCode}
                    onSelect={() => setSelectedCode(item.code)}
                    onOpenImage={() => openLightbox(item.imageKey, item.imageVersion)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* 右：详情与维护 */}
        <div className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-card p-4 lg:w-[340px]">
          {detailLoading && detail === null ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              正在读取…
            </p>
          ) : detail === null ? (
            <p className="text-sm text-muted-foreground">从左边选一条，这里显示详情与维护入口。</p>
          ) : (
            /* `key` 让「换一条选中项」等于重新挂载：价格输入框、改动说明、提示语
               全部回到初值。写成在 effect 里重置会撞 `react-hooks/set-state-in-effect`，
               而且第一帧会先显示上一条的价格。 */
            <QuoteDetail
              key={detail.item.code}
              detail={detail}
              access={access}
              onRequestUnlock={() => setGateOpen(true)}
              onOpenImage={() => openLightbox(detail.item.imageKey, detail.item.imageVersion)}
              onChanged={() => {
                setReloadToken((value) => value + 1)
                refreshAccess()
              }}
            />
          )}
        </div>
      </div>

      <QuoteLightbox
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
        src={lightboxSrc}
        failed={lightboxFailed}
        alt={detail?.item.name ?? '商品图'}
        natural={
          detail?.image === null || detail?.image === undefined
            ? null
            : { width: detail.image.width, height: detail.image.height }
        }
      />

      <PriceGateDialog
        open={gateOpen}
        onOpenChange={setGateOpen}
        state={access}
        onStateChanged={refreshAccess}
      />
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
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'rounded-md px-2 py-1 text-xs transition-colors',
        active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent',
      ].join(' ')}
    >
      {children}
    </button>
  )
}

/** 结果行。缩略图单独可点（进灯箱），点行的其他位置是选中。 */
function QuoteRow({
  item,
  keyword,
  selected,
  onSelect,
  onOpenImage,
}: {
  item: QuoteItemDto
  keyword: string
  selected: boolean
  onSelect: () => void
  onOpenImage: () => void
}) {
  const price = describePrice(item)
  const qualifier = itemQualifier(item)
  const status = describeStatus(item.status)

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        onClick={onSelect}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onSelect()
          }
        }}
        className={[
          'flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left transition-colors',
          selected ? 'bg-accent' : 'hover:bg-accent/60',
        ].join(' ')}
      >
        <Thumb item={item} onOpen={onOpenImage} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm leading-5">
              {splitHighlight(item.name, keyword).map((segment, index) =>
                segment.hit ? (
                  <mark
                    key={index}
                    className="rounded-sm bg-transparent font-semibold text-foreground underline decoration-1 underline-offset-2"
                  >
                    {segment.text}
                  </mark>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </span>
            {status !== null && (
              <span className="shrink-0 rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground-weak">
                {status}
              </span>
            )}
          </span>
          <span className="mt-0.5 block truncate text-xs leading-4 text-muted-foreground">
            {item.category}
            {qualifier === '' ? '' : ` · ${qualifier}`}
          </span>
        </span>
        <span className="shrink-0 text-right">
          <span
            className={[
              'block text-sm leading-5 tabular-nums',
              price.tone === 'amount' ? 'font-medium text-foreground' : '',
              price.tone === 'text' ? 'text-muted-foreground' : '',
              price.tone === 'empty' ? 'text-[var(--m-amber)]' : '',
            ].join(' ')}
          >
            {price.primary}
            <span className="text-xs text-muted-foreground">{price.suffix}</span>
          </span>
        </span>
      </div>
    </li>
  )
}

/**
 * 缩略图。
 *
 * 取字节要令牌，`<img>` 带不了请求头，所以先 fetch 成 Blob 再转 object URL。缓存键
 * 里带版本号，换图之后自动取到新的那张。
 *
 * 结果与「这一张的键」绑在一起（指纹），换行/换图时旧结果自动失效，不需要在 effect
 * 里先清一遍 —— 与 `lib/use-ops-dashboard.ts` 同一条做法。
 */
function Thumb({ item, onOpen }: { item: QuoteItemDto; onOpen: () => void }) {
  const key = item.imageKey === null ? '' : `${item.imageKey}\u001f${item.imageVersion ?? ''}`
  const [loaded, setLoaded] = useState<{ key: string; url: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    const imageKey = item.imageKey
    if (imageKey !== null) {
      void loadQuoteImageUrl(imageKey, 'thumb', item.imageVersion).then((value) => {
        if (alive) setLoaded({ key: `${imageKey}\u001f${item.imageVersion ?? ''}`, url: value })
      })
    }
    return () => {
      alive = false
    }
  }, [item.imageKey, item.imageVersion])

  if (!item.hasImage) {
    return (
      <span className="grid size-12 shrink-0 place-items-center rounded-lg border border-dashed border-border text-muted-foreground-weak">
        <ImageOff className="size-4" />
      </span>
    )
  }

  const current = loaded !== null && loaded.key === key ? loaded : null
  const url = current?.url ?? null
  const failed = current !== null && current.url === null

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
      aria-label={`查看 ${item.name} 的大图`}
      className="relative size-12 shrink-0 overflow-hidden rounded-lg border border-border bg-muted/40"
    >
      {url !== null ? (
        <img src={url} alt="" draggable={false} className="size-full object-contain" />
      ) : (
        <span className="grid size-full place-items-center text-muted-foreground-weak">
          {failed ? (
            <ImageOff className="size-4" />
          ) : (
            <LoaderCircle className="size-4 animate-spin" />
          )}
        </span>
      )}
    </button>
  )
}

/** 输入框里的初值：金额按「元」显示，其余形态用原文。 */
function initialPriceDraft(item: QuoteItemDto): string {
  return item.priceKind === 'amount' && item.priceFen !== null
    ? formatYuan(item.priceFen)
    : item.priceText
}

/** 详情与维护。改动成功后由父组件的 `onChanged` 触发列表与准入状态的刷新。 */
function QuoteDetail({
  detail,
  access,
  onRequestUnlock,
  onOpenImage,
  onChanged,
}: {
  detail: QuoteItemResponse
  access: QuoteAccessStateResponse | null
  onRequestUnlock: () => void
  onOpenImage: () => void
  onChanged: () => void
}) {
  const { item, image } = detail
  const price = describePrice(item)
  const status = describeStatus(item.status)

  /**
   * 能不能改。
   *
   * **不比对 `Date.now()`。** 服务端的 `access-state` 只返回**仍未过期**的解锁会话
   * （查询条件是 `expiresAt > now`），所以 `unlockedUntil !== null` 本身就已经是
   * 「现在有效」。在渲染里再拿 `Date.now()` 比一次是多余的，而且渲染期间读时钟是
   * 不纯的（`react-hooks` 的 purity 规则会拦）。
   */
  const canWrite = access !== null && (access.direct || access.unlockedUntil !== null)

  const [draft, setDraft] = useState(() => initialPriceDraft(item))
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const heroKey = item.imageKey === null ? null : `${item.imageKey}\u001f${item.imageVersion ?? ''}`
  const [hero, setHero] = useState<{ key: string; url: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    const imageKey = item.imageKey
    if (imageKey !== null) {
      void loadQuoteImageUrl(imageKey, 'full', item.imageVersion).then((value) => {
        if (alive) setHero({ key: heroKey ?? '', url: value })
      })
    }
    return () => {
      alive = false
    }
  }, [heroKey, item.imageKey, item.imageVersion])

  const heroUrl = hero !== null && hero.key === heroKey ? hero.url : null

  async function handleSavePrice(): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await saveQuotePrice(item.code, {
        priceText: draft.trim(),
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      })
      setNotice({ kind: 'ok', text: '已保存' })
      onChanged()
    } catch (error) {
      setNotice({ kind: 'error', text: describeWriteFailure(error, onRequestUnlock) })
    } finally {
      setBusy(false)
    }
  }

  async function handleToggleStatus(): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await saveQuoteStatus(
        item.code,
        item.status === 'active' ? 'archived' : 'active',
        reason.trim(),
      )
      setNotice({ kind: 'ok', text: item.status === 'active' ? '已停用' : '已恢复' })
      onChanged()
    } catch (error) {
      setNotice({ kind: 'error', text: describeWriteFailure(error, onRequestUnlock) })
    } finally {
      setBusy(false)
    }
  }

  async function handlePickImage(file: File): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const prepared = await prepareQuoteImage(file)
      if (!prepared.ok) {
        setNotice({ kind: 'error', text: prepared.message })
        return
      }
      await uploadQuoteImage(item.code, prepared.item)
      setNotice({ kind: 'ok', text: '图已更换' })
      onChanged()
    } catch (error) {
      setNotice({ kind: 'error', text: describeWriteFailure(error, onRequestUnlock) })
    } finally {
      setBusy(false)
    }
  }

  async function handleRemoveImage(): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await removeQuoteImage(item.code)
      setNotice({ kind: 'ok', text: '已解绑（图本身保留在历史里）' })
      onChanged()
    } catch (error) {
      setNotice({ kind: 'error', text: describeWriteFailure(error, onRequestUnlock) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 text-base leading-6 font-medium">{item.name}</h3>
        {status !== null && (
          <span className="shrink-0 rounded-full border border-border px-2 text-xs leading-5 text-muted-foreground">
            {status}
          </span>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {item.sourceName} · {item.category}
      </p>

      {/* 主图。点开是灯箱；没有图时给一句「可以上传」，而不是一块空白。 */}
      {image === null ? (
        <div className="grid h-32 place-items-center rounded-lg border border-dashed border-border text-xs text-muted-foreground">
          这一条还没有图
        </div>
      ) : (
        <button
          type="button"
          onClick={onOpenImage}
          className="relative h-40 overflow-hidden rounded-lg border border-border bg-muted/30"
        >
          {heroUrl !== null ? (
            <img
              src={heroUrl}
              alt={item.name}
              draggable={false}
              className="size-full object-contain"
            />
          ) : (
            <span className="grid size-full place-items-center text-xs text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
            </span>
          )}
          <span className="absolute top-1.5 left-1.5 rounded-full bg-black/60 px-2 text-[10px] leading-4 text-white">
            {describeBindType(image.bindType)}
            {image.sourceRow === null ? '' : ` · 第 ${image.sourceRow} 行`}
          </span>
        </button>
      )}

      <div className="rounded-lg border border-border bg-muted/30 p-3">
        <p className="text-xs text-muted-foreground">{price.caption}</p>
        <p
          className={[
            'mt-0.5 text-2xl leading-8 font-medium tabular-nums',
            price.tone === 'empty' ? 'text-[var(--m-amber)]' : 'text-foreground',
            price.tone === 'text' ? 'text-lg' : '',
          ].join(' ')}
        >
          {price.primary}
          <span className="text-sm text-muted-foreground">{price.suffix}</span>
        </p>
        {item.note !== '' && (
          <p className="mt-1 text-xs leading-4 text-muted-foreground">{item.note}</p>
        )}
        <p className="mt-1 text-[11px] text-muted-foreground-weak">
          {item.model === '' ? '无型号（柜体类台账如此）' : `型号 ${item.model}`}
          {item.spec === '' ? '' : ` · 规格 ${item.spec}`}
          {item.unitRaw === '' ? '' : ` · 单位 ${item.unitRaw}`}
        </p>
      </div>

      {/* 维护区。没有权限时不隐藏整块，只把它变成一句说明 + 一个解锁入口 ——
          藏起来会让人以为「这个功能不存在」。 */}
      {!canWrite ? (
        <div className="rounded-lg border border-dashed border-border p-3">
          <p className="text-xs text-muted-foreground">
            改价、换图需要维护口令。查价本身不受影响。
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            onClick={onRequestUnlock}
          >
            <KeyRound className="size-3.5" />
            输入维护口令
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground">维护</p>
          <label htmlFor="quote-price-input" className="text-xs text-muted-foreground">
            价格（可以写「668」，也可以写「1.5 倍」「120 元/米」）
          </label>
          <Input
            id="quote-price-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={200}
            placeholder="例如 668 或 1.5 倍"
          />
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={QUOTE_LIMITS.REASON_MAX}
            placeholder="改动说明（可选，会写进审计）"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              disabled={busy || draft.trim() === ''}
              onClick={() => void handleSavePrice()}
            >
              {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              保存价格
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void handleToggleStatus()}
            >
              {item.status === 'active' ? '停用' : '恢复'}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="size-3.5" />
              {image === null ? '上传图' : '换图'}
            </Button>
            {image !== null && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => void handleRemoveImage()}
              >
                <Trash2 className="size-3.5" />
                解绑
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              // 清空 value，否则选同一个文件第二次不会触发 change。
              event.target.value = ''
              if (file !== undefined) void handlePickImage(file)
            }}
          />
          {notice !== null && (
            <p
              className={[
                'text-xs',
                notice.kind === 'ok' ? 'text-muted-foreground' : 'text-destructive',
              ].join(' ')}
            >
              {notice.text}
            </p>
          )}
        </div>
      )}
    </>
  )
}

/**
 * 写操作失败的文案。
 *
 * 三种失败要有不同的处置，不能都写成「操作失败」：
 *   - `forbidden`：口令过期或身份不符 —— 直接把解锁窗口推给他；
 *   - `no_secret`：还没设过口令 —— 该找超管，再点一百次也没用；
 *   - 其余：网络或校验，改一改再试。
 */
function describeWriteFailure(error: unknown, onRequestUnlock: () => void): string {
  if (!(error instanceof ApiError)) return '操作失败，请稍后重试'
  const exit = quoteWriteExit(error)
  if (exit === 'unlock') {
    onRequestUnlock()
    return '维护权限已过期，请重新输入口令'
  }
  if (exit === 'secret') return '还没有设置维护口令，请让超级管理员先设置一个'
  return error.message
}
