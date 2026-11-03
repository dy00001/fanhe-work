import {
  QUOTE_LIMITS,
  type QuoteAccessStateResponse,
  type QuoteCategoryDto,
  type QuoteItemDto,
  type QuoteSource,
  type QuoteSourceDto,
  type UploadQuoteImageRequest,
} from '@fanhe/shared'
import { ImagePlus, LoaderCircle, Plus, Search, Trash2, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../../../lib/api'
import {
  createQuoteItem,
  deleteQuoteItem,
  loadQuoteCategories,
  loadQuoteImageUrl,
  loadQuoteSources,
  removeQuoteImage,
  reorderQuoteItems,
  saveQuotePrice,
  saveQuoteStatus,
  searchQuotes,
  uploadQuoteImage,
} from '../../../lib/quote'
import {
  describeQuoteImageFailure,
  formatKilobytes,
  formatMegabytes,
  prepareQuoteImage,
  QUOTE_IMAGE_ACCEPT,
  QUOTE_IMAGE_FILE_BYTES_MAX,
  type PreparedQuoteImage,
} from '../../../lib/quote-image'
import { describePrice, describeStatus, formatYuan } from '../../../lib/quote-display'
import { applyDrop, sameOrder, type DropTarget } from '../../../lib/quote-sort'

import { RowDragHandle } from './RowDragHandle'
import { useRowDrag } from './use-row-drag'

/**
 * 产品维护：新增、改价、下架 / 上架。
 *
 * ## 为什么列表要带「已下架」
 *
 * 下架之后如果列表里看不到它，就没法再上架 —— 而「上个月那条现在多少钱」正是
 * 下架这个设计存在的理由。所以查询固定带 `includeArchived`，用状态列区分。
 *
 * ## 改价走的是原来右栏那条接口
 *
 * `PATCH /api/quote/items/:code` 一行没动。这次只是把入口从「查价面板右栏」搬到
 * 这里 —— 接口、判权、审计、版本号全部沿用，业务逻辑没有第二套。
 *
 * ## 新增产品与改价是两个动作
 *
 * 新产品没有 code（它由服务端按业务键算），所以不能复用改价接口。混在一起会让
 * 客户端先得知道 code，而那个值本来只有服务端算得出来。
 */
export function QuoteProductManager({
  access,
  onChanged,
}: {
  access: QuoteAccessStateResponse | null
  onChanged: () => void
}) {
  const [source, setSource] = useState<QuoteSource>('sale')
  const [keyword, setKeyword] = useState('')
  const [debounced, setDebounced] = useState('')
  const [rows, setRows] = useState<QuoteItemDto[] | null>(null)
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [categories, setCategories] = useState<QuoteCategoryDto[]>([])
  /**
   * 主类清单。**不能再用 `QUOTE_SOURCES` 硬编码** —— 新建的主类不会出现在那里，
   * 于是「新建了石材外协，却没法往里加产品」。
   */
  const [sources, setSources] = useState<readonly QuoteSourceDto[]>([])
  const [editingCode, setEditingCode] = useState<string | null>(null)
  const [priceDraft, setPriceDraft] = useState('')
  const [reason, setReason] = useState('')
  const [creating, setCreating] = useState(false)
  /** 哪一条正处于「确认删除」。删除是物理删除，所以要两次点击。 */
  const [deletingCode, setDeletingCode] = useState<string | null>(null)
  /**
   * 哪一条的「商品图」面板展开着。
   *
   * 与 `editingCode`（改价）互斥：两个面板都占一整行，同时展开会让人分不清哪个
   * 操作属于哪一条。所以打开一个就收起另一个。
   */
  const [imageCode, setImageCode] = useState<string | null>(null)

  const canWrite = access !== null && (access.direct || access.unlockedUntil !== null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(keyword.trim()), 120)
    return () => window.clearTimeout(timer)
  }, [keyword])

  /**
   * async 版给写操作用（要 await），`reload` 是给 effect 的 void 包装。
   * **写成 `.then` 链而不是 `async` 函数**：理由见分类区的同名注释。
   */
  const refresh = useCallback(
    (): Promise<void> =>
      searchQuotes({
        q: debounced,
        source,
        includeArchived: true,
        limit: QUOTE_LIMITS.PAGE_SIZE_MAX,
        offset: 0,
      })
        .then((result) => {
          setRows([...result.items])
          setTotal(result.total)
          setError(null)
        })
        .catch((cause: unknown) => {
          setRows(null)
          setError(cause instanceof ApiError ? cause.message : '产品读取失败')
        }),
    [debounced, source],
  )

  const reload = useCallback(() => {
    void refresh()
  }, [refresh])

  useEffect(reload, [reload])

  useEffect(() => {
    void loadQuoteCategories()
      .then((result) => setCategories([...result.items]))
      .catch(() => setCategories([]))
    void loadQuoteSources()
      .then((result) => setSources(result.items))
      .catch(() => setSources([]))
  }, [])

  /**
   * 执行一次写操作，返回是否成功。
   *
   * **要返回成功与否，不能只吞掉异常。** 新增产品那张表单在失败时必须留着已经
   * 填好的字段（尤其是压缩好、等着一起提交的那张图）—— 无条件收起来等于让操作员
   * 从头再填一遍，而他刚刚才选过图。
   */
  async function run(task: () => Promise<string>): Promise<boolean> {
    setBusy(true)
    setNotice(null)
    try {
      const text = await task()
      setNotice({ kind: 'ok', text })
      await refresh()
      onChanged()
      return true
    } catch (cause) {
      setNotice({
        kind: 'error',
        text: cause instanceof ApiError ? cause.message : '操作失败，请重试',
      })
      return false
    } finally {
      setBusy(false)
    }
  }

  async function submitPrice(item: QuoteItemDto): Promise<void> {
    const text = priceDraft.trim()
    if (text === '') return
    setEditingCode(null)
    await run(async () => {
      await saveQuotePrice(item.code, {
        priceText: text,
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      })
      return `「${item.name}」价格已保存`
    })
    setReason('')
  }

  /**
   * 物理删除。与「下架」只差一个动词，后果差很多：
   *
   * - 下架：历史报价单上的条目号还查得到，随时能上架回来；
   * - 删除：这一行没了，条目号查不到任何东西，不可撤销（审计里留整行快照）。
   *
   * 所以按钮两次点击、文案写成「确认删除」，成功后连分页与统计一起重取。
   */
  async function removeItem(item: QuoteItemDto): Promise<void> {
    setDeletingCode(null)
    await run(async () => {
      const result = await deleteQuoteItem({ source, code: item.code })
      return `已删除「${result.name}」${result.imageRemoved ? '，连同它的商品图' : ''}（不可撤销）`
    })
    setReason('')
  }

  async function toggleStatus(item: QuoteItemDto): Promise<void> {
    await run(async () => {
      await saveQuoteStatus(
        item.code,
        item.status === 'active' ? 'archived' : 'active',
        reason.trim(),
      )
      return item.status === 'active' ? `「${item.name}」已下架` : `「${item.name}」已上架`
    })
    setReason('')
  }

  /**
   * 换图 / 新增图。**选完就传，没有第二步确认。**
   *
   * 图已经在客户端压好（`prepareQuoteImage`），而这一屏是维护台 —— 每一处点了就生效。
   * 再套一个「确认保存」会让「我把图换错了」变成两件事：图传上去了，但界面说不清
   * 到底存没存。传完就地刷新，缩略图立刻变。
   */
  async function replaceImage(item: QuoteItemDto, prepared: PreparedQuoteImage): Promise<boolean> {
    return run(async () => {
      await uploadQuoteImage(item.code, prepared.request)
      return item.imageKey === null
        ? `「${item.name}」的商品图已新增`
        : `「${item.name}」的商品图已更换`
    })
  }

  /**
   * 删图。
   *
   * 服务端只清「指向」，不物理删字节（历史报价要能回看当时那张图），所以这条是
   * **可恢复**的 —— 再传一张就是了。但仍然要两次点击：删完之后列表里那一格变成
   * 占位，"刚才那张是什么样" 已经没法从界面上看到了。
   */
  async function clearImage(item: QuoteItemDto): Promise<boolean> {
    return run(async () => {
      await removeQuoteImage(item.code)
      return `已移除「${item.name}」的商品图`
    })
  }

  /**
   * 保存产品顺序。
   *
   * 与分类区同一套：本端先动，再发请求；失败时重取，别让界面停在没落库的顺序上。
   * 发的只是**这一屏**的条目键（五金 596 条、一屏 200 条），服务端把剩下的接在后面。
   */
  async function saveOrder(order: readonly string[]): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      await reorderQuoteItems({ source, order })
      setNotice({ kind: 'ok', text: '顺序已保存' })
      onChanged()
    } catch (cause) {
      setNotice({
        kind: 'error',
        text: cause instanceof ApiError ? cause.message : '顺序没保存上，请重试',
      })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  /**
   * **搜索时不能拖。** 拖的是「命中结果」这一小撮，而顺序是整份写下去的 —— 把筛选出来
   * 的几条提到最前，等于把没显示的几百条整体挪了位，而那正是用户没打算动的东西。
   */
  const canDrag = canWrite && !busy && debounced === '' && rows !== null && rows.length > 1
  const drag = useRowDrag({
    enabled: canDrag,
    onReorder: (target: DropTarget) => {
      const codes = (rows ?? []).map((row) => row.code)
      const order = applyDrop(codes, target)
      if (sameOrder(codes, order)) return
      // 乐观更新：本地先按新顺序摆好，请求回来之后不再重排（重取会让列表闪一下）。
      const current = rows ?? []
      const byCode = new Map(current.map((row) => [row.code, row]))
      const next = order
        .map((code) => byCode.get(code))
        .filter((row): row is QuoteItemDto => row !== undefined)
      setRows(next)
      void saveOrder(order)
    },
  })

  const sourceCategories = categories.filter((row) => row.source === source)
  // 当前选中的主类被删掉时退回第一个 —— 与分类区同一条兜底，不另写一套。
  const sourceName =
    sources.find((row) => row.code === source)?.name ?? sources[0]?.name ?? '当前主类'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {sources.map((row) => (
          <button
            key={row.code}
            type="button"
            aria-pressed={source === row.code}
            onClick={() => {
              setSource(row.code)
              setEditingCode(null)
            }}
            className={
              source === row.code
                ? 'inline-flex h-8 items-center rounded-[9px] bg-secondary px-3 text-[13px] font-medium'
                : 'inline-flex h-8 items-center rounded-[9px] px-3 text-[13px] text-muted-foreground hover:bg-accent'
            }
          >
            {row.name}
          </button>
        ))}

        <div className="ml-2 flex h-8 w-[220px] items-center gap-1.5 rounded-[9px] border border-border bg-background px-2.5 focus-within:border-ring focus-within:bg-card">
          <Search className="size-3.5 shrink-0 text-muted-foreground-weak" />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索名称 / 型号 / 分类"
            maxLength={QUOTE_LIMITS.QUERY_MAX}
            className="min-w-0 flex-1 border-0 bg-transparent text-[12.5px] outline-none"
            aria-label="搜索产品"
          />
        </div>

        <button
          type="button"
          disabled={!canWrite || busy}
          onClick={() => setCreating((value) => !value)}
          className="ml-auto inline-flex h-8 items-center gap-1 rounded-[9px] bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          新增产品
        </button>
      </div>

      {creating && (
        <NewProductForm
          source={source}
          sourceName={sourceName}
          categories={sourceCategories.map((row) => row.name)}
          busy={busy}
          onCancel={() => setCreating(false)}
          onSubmit={async (input, image) => {
            const ok = await run(async () => {
              // 图和产品走同一个请求：新产品没有 code，图键又要用 code，分两步就会
              // 出现「产品建好了、图没上去」的中间态（见 shared 里的注释）。
              await createQuoteItem(image === undefined ? input : { ...input, image })
              return image === undefined
                ? `已新增「${input.name}」`
                : `已新增「${input.name}」，商品图一并保存`
            })
            if (ok) setCreating(false)
          }}
        />
      )}

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">
        {error !== null ? (
          <p className="p-4 text-[12.5px] text-destructive">{error}</p>
        ) : rows === null ? (
          <p className="p-4 text-[12.5px] text-muted-foreground">读取中…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-[12.5px] text-muted-foreground">没有匹配的产品</p>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                <Th className="w-7" />
                <Th className="w-16">条目号</Th>
                <Th className="w-14">图</Th>
                <Th>名称 / 型号</Th>
                <Th className="w-[132px]">分类</Th>
                <Th className="w-[148px]">价格</Th>
                <Th className="w-14">状态</Th>
                <Th className="w-[196px]">操作</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item, index) => {
                const price = describePrice(item)
                const status = describeStatus(item.status)
                const editing = editingCode === item.code
                return (
                  <Fragment key={item.code}>
                    <tr
                      className={`align-middle ${drag.rowClass(index)}`}
                      {...drag.rowProps(index)}
                    >
                      <Td>
                        <RowDragHandle
                          label={`拖动「${item.name}」调整顺序`}
                          enabled={canDrag}
                          {...drag.handleProps(index)}
                        />
                      </Td>
                      <Td className="font-mono text-[11.5px] text-muted-foreground-weak">
                        {item.ledgerNo === '' ? '—' : item.ledgerNo}
                      </Td>
                      <Td>
                        {/* 图片格本身是入口：有图点开是「更换 / 删除」，没图点开是「新增」。
                            做成按钮而不是在格子里放一个小图标，是因为 32px 的格子里再塞
                            一个按钮就只剩十几像素可点。 */}
                        <button
                          type="button"
                          onClick={() => {
                            setEditingCode(null)
                            setDeletingCode(null)
                            setImageCode(imageCode === item.code ? null : item.code)
                          }}
                          aria-expanded={imageCode === item.code}
                          aria-label={
                            item.imageKey === null
                              ? `为「${item.name}」新增商品图`
                              : `管理「${item.name}」的商品图（更换 / 删除）`
                          }
                          className="group relative grid size-8 place-items-center overflow-hidden rounded-[6px] border border-border-soft hover:border-ring"
                        >
                          <ProductThumb item={item} />
                          <span className="pointer-events-none absolute inset-0 grid place-items-center bg-[color-mix(in_srgb,var(--foreground)_46%,transparent)] opacity-0 transition-opacity group-hover:opacity-100">
                            <ImagePlus className="size-3.5 text-background" />
                          </span>
                        </button>
                      </Td>
                      <Td>
                        <div className="truncate font-medium">{item.name}</div>
                        <div className="truncate text-[11px] text-muted-foreground-weak">
                          {[item.model, item.spec].filter((part) => part !== '').join(' · ') || '—'}
                        </div>
                      </Td>
                      <Td className="truncate text-muted-foreground">{item.category}</Td>
                      <Td className="tabular-nums">
                        {price.tone === 'amount' ? (
                          <span>
                            {price.primary}
                            <span className="text-[11px] text-muted-foreground-weak">
                              {item.unit === '' ? '' : `/${item.unit}`}
                            </span>
                          </span>
                        ) : (
                          <span className="text-m-amber">{price.primary}</span>
                        )}
                      </Td>
                      <Td>
                        <span
                          className={
                            item.status === 'active'
                              ? 'rounded-full border border-border px-1.5 text-[11px] leading-[18px] text-muted-foreground'
                              : 'rounded-full border border-[color-mix(in_srgb,var(--m-amber)_30%,var(--border))] px-1.5 text-[11px] leading-[18px] text-m-amber'
                          }
                        >
                          {status ?? '在售'}
                        </span>
                      </Td>
                      <Td>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={!canWrite || busy}
                            onClick={() => {
                              setEditingCode(editing ? null : item.code)
                              setPriceDraft(initialDraft(item))
                            }}
                            className="inline-flex h-7 items-center rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40"
                          >
                            {editing ? '收起' : '改价'}
                          </button>
                          <button
                            type="button"
                            disabled={!canWrite || busy}
                            onClick={() => void toggleStatus(item)}
                            className="inline-flex h-7 items-center rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40"
                          >
                            {item.status === 'active' ? '下架' : '上架'}
                          </button>
                          {/* 与「下架」并排但后果不同：这个是物理删除，不可撤销。
                              两次点击，第一次只把按钮换成「确认删除」。 */}
                          <button
                            type="button"
                            disabled={!canWrite || busy}
                            onClick={() => {
                              if (deletingCode !== item.code) {
                                setEditingCode(null)
                                setDeletingCode(item.code)
                                return
                              }
                              void removeItem(item)
                            }}
                            className={
                              deletingCode === item.code
                                ? 'inline-flex h-7 items-center gap-1 rounded-[7px] bg-destructive px-2 text-[11.5px] text-destructive-foreground disabled:opacity-40'
                                : 'inline-flex h-7 items-center gap-1 rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40'
                            }
                            aria-label={
                              deletingCode === item.code
                                ? `确认删除「${item.name}」`
                                : `删除「${item.name}」`
                            }
                          >
                            <Trash2 className="size-3" />
                            {deletingCode === item.code ? '确认删除' : '删除'}
                          </button>
                        </div>
                      </Td>
                    </tr>
                    {editing && (
                      <tr>
                        {/* colSpan 跟着列数：拖动列是这次新加的，漏改会让展开区只铺到
                            一半，右边留一条白。 */}
                        <td
                          colSpan={8}
                          className="border-b border-border-soft bg-background px-3 py-2"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <input
                              autoFocus
                              value={priceDraft}
                              onChange={(event) => setPriceDraft(event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') void submitPrice(item)
                                if (event.key === 'Escape') setEditingCode(null)
                              }}
                              maxLength={200}
                              placeholder="例如 668，或「1.5 倍」「120 元/米」"
                              className="h-8 w-[240px] rounded-[8px] border border-ring bg-card px-2.5 text-[12.5px] outline-none"
                              aria-label={`「${item.name}」的新价格`}
                            />
                            <input
                              value={reason}
                              onChange={(event) => setReason(event.target.value)}
                              maxLength={QUOTE_LIMITS.REASON_MAX}
                              placeholder="改动说明（可选，写进审计）"
                              className="h-8 w-[220px] rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none"
                              aria-label="改动说明"
                            />
                            <button
                              type="button"
                              disabled={busy || priceDraft.trim() === ''}
                              onClick={() => void submitPrice(item)}
                              className="inline-flex h-8 items-center gap-1 rounded-[9px] bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-50"
                            >
                              {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
                              保存价格
                            </button>
                            <span className="text-[11px] text-muted-foreground-weak">
                              可以写「668」，也可以写「1.5 倍」「120 元/米」—— 形态由服务端判
                            </span>
                          </div>
                        </td>
                      </tr>
                    )}
                    {imageCode === item.code && (
                      <tr>
                        <td
                          colSpan={8}
                          className="border-b border-border-soft bg-background px-3 py-2.5"
                        >
                          <ProductImageEditor
                            item={item}
                            canWrite={canWrite}
                            busy={busy}
                            onUpload={(prepared) => replaceImage(item, prepared)}
                            onRemove={() => clearImage(item)}
                            onClose={() => setImageCode(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="mt-2 flex items-center gap-2 text-[11.5px] text-muted-foreground-weak">
        <span>
          共 {total} 条{rows !== null && total > rows.length ? `，显示前 ${rows.length} 条` : ''}
        </span>
        {/* 拖拽的门槛要说出来：搜索框里有词时手柄是按不动的，不解释就只是「不好使」。 */}
        <span className="text-muted-foreground-weak">
          {debounced === '' ? '按住左侧手柄可拖动排序' : '搜索状态下不能拖动排序，清空搜索后可用'}
        </span>
        {!canWrite && <span className="text-m-amber">维护口令已失效，请重新打开维护台</span>}
        {notice !== null && (
          <span
            role={notice.kind === 'error' ? 'alert' : 'status'}
            className={notice.kind === 'error' ? 'text-destructive' : 'text-m-teal'}
          >
            {notice.text}
          </span>
        )}
      </div>
    </div>
  )
}

/** 行 + 展开行必须包在同一个 key 下，否则 React 会把展开行算到下一行头上。 */

/**
 * 新增产品表单。
 *
 * ## 图片是**可选的一张**
 *
 * 一条产品一张主图，这是底层决定的：`quote_items.image_key` 是**一个**字段，取图
 * 接口按「键 + 版本」缓存，换图 = 让旧图 `is_active = false` 再指向新的那张。多图
 * 要另起关联表，还要改查价面板的展示、取图接口的批量形态、以及族图继承的规则 ——
 * 那是另一件事。所以这里没有排序，只有「换一张」和「移除」。
 *
 * ## 选完图不发请求
 *
 * 选中文件后当场解码 + 压缩（`prepareQuoteImage`），拿到的字节既是预览图、也是待
 * 提交的内容。**「上传中」只发生在点保存之后**，界面上因此分成两段：压缩时写
 * 「正在处理图片」，保存时按钮变成「上传中」。
 *
 * ## 失败要留着已填的内容
 *
 * 提交失败时表单不收起（父层按 `run` 的返回值决定）。重新选图、重新填七个字段的
 * 代价远大于重试一次，而这个人可能刚才是从供应商 PDF 上抄下来的。
 */
function NewProductForm({
  source,
  sourceName,
  categories,
  busy,
  onCancel,
  onSubmit,
}: {
  source: QuoteSource
  /** 主类显示名。从主类表来，不能查 `QUOTE_SOURCE_NAMES` —— 自定义主类在那里是空的。 */
  sourceName: string
  categories: readonly string[]
  busy: boolean
  onCancel: () => void
  onSubmit: (
    input: {
      source: QuoteSource
      category: string
      name: string
      model: string
      spec: string
      unit: string
      priceText: string
      note: string
      pricingMode: string
    },
    image: UploadQuoteImageRequest | undefined,
  ) => Promise<void>
}) {
  const [category, setCategory] = useState(categories[0] ?? '')
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [spec, setSpec] = useState('')
  const [unit, setUnit] = useState('')
  const [priceText, setPriceText] = useState('')
  const [note, setNote] = useState('')

  const [image, setImage] = useState<PreparedQuoteImage | null>(null)
  const [imageName, setImageName] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [imageNote, setImageNote] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  const [dropping, setDropping] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const ready = category.trim() !== '' && name.trim() !== ''

  /**
   * 接收一个文件。
   *
   * **每换一张都先把旧图清掉**：留着旧图的话，压缩失败时界面仍然显示一张成功的
   * 缩略图，而它已经不对应任何待提交的字节 —— 点保存要么没图、要么报一个看不懂的
   * invalid_image。
   */
  async function accept(file: File, multiple: boolean): Promise<void> {
    setPreparing(true)
    setImage(null)
    setImageName(file.name)
    setImageNote(multiple ? { tone: 'info', text: '一次只能传一张，已取第一张' } : null)

    const result = await prepareQuoteImage(file)
    setPreparing(false)
    if (!result.ok) {
      setImageName('')
      setImageNote({ tone: 'error', text: describeQuoteImageFailure(result.reason) })
      return
    }
    setImage(result.value)
  }

  function clearImage(): void {
    setImage(null)
    setImageName('')
    setImageNote(null)
    // 重置 input：不清空的话，选同一张图再来一次不会触发 change。
    if (fileRef.current !== null) fileRef.current.value = ''
  }

  function handleDrop(event: React.DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    setDropping(false)
    const files = event.dataTransfer.files
    const file = files[0]
    if (file === undefined) return
    void accept(file, files.length > 1)
  }

  return (
    <div className="mb-3 rounded-xl border border-border bg-background p-3">
      <div className="mb-2 text-[12.5px] font-medium">新增产品 · {sourceName}</div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="分类（必填）">
          <input
            list="quote-maint-categories"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
            maxLength={QUOTE_LIMITS.CATEGORY_NAME_MAX}
            placeholder="选已有，或直接输入新名字"
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
          <datalist id="quote-maint-categories">
            {categories.map((value) => (
              <option key={value} value={value} />
            ))}
          </datalist>
        </Field>
        <Field label="名称（必填）">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={QUOTE_LIMITS.ITEM_NAME_MAX}
            placeholder="例如 E0 级实木颗粒板"
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <Field label="价格">
          <input
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
            maxLength={QUOTE_LIMITS.ITEM_PRICE_TEXT_MAX}
            placeholder="668 / 1.5 倍 / 120 元/米"
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <Field label="型号">
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            maxLength={QUOTE_LIMITS.ITEM_MODEL_MAX}
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <Field label="规格">
          <input
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
            maxLength={QUOTE_LIMITS.ITEM_SPEC_MAX}
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <Field label="单位">
          <input
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            maxLength={QUOTE_LIMITS.ITEM_UNIT_MAX}
            placeholder="㎡ / 米 / 个"
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <div className="col-span-3">
          <Field label="备注">
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={QUOTE_LIMITS.ITEM_NOTE_MAX}
              className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
            />
          </Field>
        </div>

        <div className="col-span-3">
          <span className="mb-1 block text-[11px] text-muted-foreground-weak">
            产品图片（可选 · 单张）
          </span>
          <div className="flex items-start gap-2.5">
            <div
              onDragEnter={(event) => {
                event.preventDefault()
                setDropping(true)
              }}
              onDragOver={(event) => {
                // 不 preventDefault 的话 drop 事件根本不会触发，浏览器会用这张图
                // 导航离开当前页 —— 表现是「拖进去整个工作台没了」。
                event.preventDefault()
                setDropping(true)
              }}
              onDragLeave={() => setDropping(false)}
              onDrop={handleDrop}
              className={[
                'flex size-[72px] shrink-0 items-center justify-center overflow-hidden rounded-[10px] border border-dashed transition-colors',
                dropping ? 'border-ring bg-accent' : 'border-border bg-card',
              ].join(' ')}
            >
              {preparing ? (
                <LoaderCircle className="size-4 animate-spin text-muted-foreground-weak" />
              ) : image !== null ? (
                <img src={image.previewUrl} alt="产品图预览" className="size-full object-cover" />
              ) : (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="flex size-full flex-col items-center justify-center gap-1 text-[10.5px] text-muted-foreground-weak hover:bg-accent"
                >
                  <ImagePlus className="size-4" />
                  拖此 / 点选
                </button>
              )}
            </div>

            <div className="min-w-0 flex-1 pt-0.5">
              {image !== null ? (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="max-w-[240px] truncate text-[11.5px]">{imageName}</span>
                  <span className="text-[11px] text-muted-foreground-weak">
                    · {image.request.width}×{image.request.height} ·{' '}
                    {formatKilobytes(image.byteSize)}
                  </span>
                  <button
                    type="button"
                    onClick={() => fileRef.current?.click()}
                    className="inline-flex h-6 items-center rounded-[6px] border border-border px-1.5 text-[11px] hover:bg-accent"
                  >
                    换一张
                  </button>
                  <button
                    type="button"
                    onClick={clearImage}
                    className="inline-flex h-6 items-center gap-0.5 rounded-[6px] border border-border px-1.5 text-[11px] text-muted-foreground hover:bg-accent"
                  >
                    <X className="size-3" />
                    移除
                  </button>
                </div>
              ) : (
                <p className="text-[11px] leading-[18px] text-muted-foreground-weak">
                  支持 JPG / PNG / WebP，原图 ≤ {formatMegabytes(QUOTE_IMAGE_FILE_BYTES_MAX)}。
                  可拖拽或点击选择，选完立即在左侧预览；图片在保存产品时一起提交。
                </p>
              )}

              {preparing && (
                <p className="mt-1 text-[11px] text-muted-foreground-weak">正在处理图片（压缩）…</p>
              )}
              {imageNote !== null && (
                <p
                  role={imageNote.tone === 'error' ? 'alert' : undefined}
                  className={
                    imageNote.tone === 'error'
                      ? 'mt-1 text-[11px] text-destructive'
                      : 'mt-1 text-[11px] text-m-amber'
                  }
                >
                  {imageNote.text}
                </p>
              )}
              {image !== null && (
                <p className="mt-1 text-[11px] text-muted-foreground-weak">
                  一条产品一张主图：换图请再选一张，不需要时点「移除」。不支持多图与排序。
                </p>
              )}
            </div>
          </div>

          <input
            ref={fileRef}
            type="file"
            accept={QUOTE_IMAGE_ACCEPT}
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              const multiple = (event.target.files?.length ?? 0) > 1
              event.target.value = ''
              if (file !== undefined) void accept(file, multiple)
            }}
          />
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !ready || preparing}
          onClick={() =>
            void onSubmit(
              {
                source,
                category: category.trim(),
                name: name.trim(),
                model: model.trim(),
                spec: spec.trim(),
                unit: unit.trim(),
                priceText: priceText.trim(),
                note: note.trim(),
                pricingMode: '',
              },
              image?.request,
            )
          }
          className="inline-flex h-8 items-center gap-1 rounded-[9px] bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {busy ? (image !== null ? '上传中…' : '保存中…') : '保存产品'}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-[9px] border border-border px-3 text-[12.5px] disabled:opacity-50"
        >
          取消
        </button>
        <span className="text-[11px] text-muted-foreground-weak">
          条目号由系统按 M 开头续号；分类名不存在时会自动建一个
        </span>
      </div>
    </div>
  )
}

/**
 * 列表里的小缩略图。
 *
 * **没有图时不同步 setState**：`react-hooks/set-state-in-effect` 会拦「effect 里
 * 直接写 state」，而这里完全不需要 —— 没图就直接渲染占位，有图才发请求。
 *
 * 占位不再是一个「—」：这一格现在是入口（点开可以新增图），而一个横杠看起来像
 * 「这里什么都没有、也不会有」。虚线框 + 加号是「可以往里放东西」的通用说法。
 */
function ProductThumb({ item }: { item: QuoteItemDto }) {
  const [url, setUrl] = useState<string | null>(null)
  const key = item.imageKey
  const version = item.imageVersion

  useEffect(() => {
    if (key === null) return
    let alive = true
    void loadQuoteImageUrl(key, 'thumb', version).then((value) => {
      if (alive) setUrl(value)
    })
    return () => {
      alive = false
    }
  }, [key, version])

  if (key === null) {
    return (
      <span
        aria-hidden
        className="grid size-full place-items-center rounded-[5px] border border-dashed border-border text-muted-foreground-weak"
      >
        <ImagePlus className="size-3.5" />
      </span>
    )
  }

  if (url === null) {
    return <span className="block size-full animate-pulse rounded-[5px] bg-accent" aria-hidden />
  }

  return <img src={url} alt={`「${item.name}」的产品图`} className="size-full object-cover" />
}

/**
 * 商品图面板：新增 / 更换 / 删除。
 *
 * ## 为什么是行内展开，不是浮层
 *
 * 这一格在表格里、表格又在滚动容器里，浮层会被裁掉或者跟着滚动错位；而 Radix 的
 * Popover 会多一层 portal，11-03 那次「点图片把整个面板关了」正是层级问题。行内
 * 展开只多一行 DOM，没有这些边界 —— 与「改价」用的是同一个形状。
 *
 * ## 为什么选完就传，没有「保存」按钮
 *
 * 一条产品只有一张主图（`quote_items.image_key` 是一个字段），所以换图不是「编辑
 * 一个列表」，而是一次替换。多一个保存步骤就会有人选完图直接关掉面板，然后以为
 * 传上去了 —— 而界面上什么都没发生，也不报错。
 *
 * ## 删除要两次点击
 *
 * 服务端只清指向（历史报价还要能回看当时那张图），所以技术上可恢复；但界面上那一格
 * 变空之后，"刚才那张是什么样" 就没法从列表里看出来了。两次点击的成本很低。
 */
function ProductImageEditor({
  item,
  canWrite,
  busy,
  onUpload,
  onRemove,
  onClose,
}: {
  item: QuoteItemDto
  canWrite: boolean
  busy: boolean
  onUpload: (prepared: PreparedQuoteImage) => Promise<boolean>
  onRemove: () => Promise<boolean>
  onClose: () => void
}) {
  const [preparing, setPreparing] = useState(false)
  const [fileName, setFileName] = useState('')
  const [note, setNote] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
  /** 已选好、正在上传的那一张（压缩后的字节数，用来显示「已压到 xxKB」）。 */
  const [sending, setSending] = useState<number | null>(null)
  const [confirming, setConfirming] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const hasImage = item.imageKey !== null
  const working = preparing || sending !== null || busy

  /**
   * 选文件 → 压缩 → 直接上传。
   *
   * **先清掉上一次的错误提示**：`prepareQuoteImage` 的四种失败（格式 / 解不开 / 太大 /
   * 编码）用户要做的事完全不同，留着上一条会让人对着旧提示去改新图。
   */
  async function accept(file: File): Promise<void> {
    setNote(null)
    setFileName(file.name)
    setPreparing(true)
    const prepared = await prepareQuoteImage(file)
    setPreparing(false)
    if (!prepared.ok) {
      setNote({ tone: 'error', text: describeQuoteImageFailure(prepared.reason) })
      return
    }
    setSending(prepared.value.byteSize)
    const ok = await onUpload(prepared.value)
    setSending(null)
    if (!ok) setNote({ tone: 'error', text: '上传没有成功，图还是原来那张。可以直接再选一次' })
  }

  return (
    <div className="flex items-start gap-3">
      <div className="grid size-[72px] shrink-0 place-items-center overflow-hidden rounded-[10px] border border-dashed border-border bg-card">
        {item.imageKey === null ? (
          <span className="flex flex-col items-center gap-1 text-[10.5px] text-muted-foreground-weak">
            <ImagePlus className="size-4" />
            暂无图
          </span>
        ) : (
          <ProductThumb item={item} />
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12.5px] font-medium">{item.name}</span>
          <span className="rounded border border-border px-1 text-[10.5px] leading-4 text-muted-foreground-weak">
            {hasImage ? '已绑图' : '无图'}
          </span>
          <span className="text-[11px] text-muted-foreground-weak">
            一条产品一张主图 · 选完立刻保存
          </span>
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            disabled={!canWrite || working}
            onClick={() => fileRef.current?.click()}
            className="inline-flex h-7 items-center gap-1 rounded-[7px] bg-primary px-2 text-[11.5px] text-primary-foreground disabled:opacity-50"
          >
            {preparing || sending !== null ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <ImagePlus className="size-3" />
            )}
            {hasImage ? '更换图片' : '新增图片'}
          </button>
          {/* 没有图时给一个明确「不可用」的按钮，而不是把它藏起来：藏起来之后，人
              不知道自己是不是漏点了什么。 */}
          <button
            type="button"
            disabled={!canWrite || working || !hasImage}
            onClick={() => {
              if (!confirming) {
                setConfirming(true)
                return
              }
              setConfirming(false)
              void onRemove()
            }}
            className={
              confirming
                ? 'inline-flex h-7 items-center gap-1 rounded-[7px] bg-destructive px-2 text-[11.5px] text-destructive-foreground disabled:opacity-50'
                : 'inline-flex h-7 items-center gap-1 rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40'
            }
          >
            <Trash2 className="size-3" />
            {confirming ? '确认删除图片' : '删除图片'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-7 items-center gap-1 rounded-[7px] px-2 text-[11.5px] text-muted-foreground hover:bg-accent"
          >
            <X className="size-3" />
            收起
          </button>
        </div>

        <p className="mt-1.5 text-[11px] leading-[18px] text-muted-foreground-weak">
          支持 JPG / PNG / WebP，原图 ≤ {formatMegabytes(QUOTE_IMAGE_FILE_BYTES_MAX)}。
          {hasImage
            ? '换图会覆盖当前这张，旧图留在历史里（历史报价仍能看到当时那张）。'
            : '这张图会绑定在条目号上，查价面板与报价单都会显示它。'}
        </p>
        {preparing && (
          <p className="mt-1 text-[11px] text-muted-foreground-weak">正在处理图片（压缩）…</p>
        )}
        {sending !== null && (
          <p className="mt-1 text-[11px] text-muted-foreground-weak">
            上传中…（{fileName}，已压到 {formatKilobytes(sending)}）
          </p>
        )}
        {note !== null && (
          <p
            role={note.tone === 'error' ? 'alert' : undefined}
            className={
              note.tone === 'error'
                ? 'mt-1 text-[11px] text-destructive'
                : 'mt-1 text-[11px] text-m-amber'
            }
          >
            {note.text}
          </p>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept={QUOTE_IMAGE_ACCEPT}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // 清空 value：不清的话，连着选同一张图不会再触发 change。
          event.target.value = ''
          if (file !== undefined) void accept(file)
        }}
      />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] text-muted-foreground-weak">{label}</span>
      {children}
    </label>
  )
}

/**
 * 表头。**粘在滚动容器顶端**：五金 596 条一屏装不下，滚下去之后「价格 / 状态 / 操作」
 * 三列是哪一列就分不出来了 —— 而这三列里两个能动数据、一个是只读状态。
 *
 * 底边用 inset 阴影而不是 `border-b`：`border-collapse` 的表格里，粘性表头的边框会
 * 跟着内容一起滚走，滚到中间时表头与第一行之间就没有分隔线了。
 */
function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`sticky top-0 z-10 bg-background px-3 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak [box-shadow:inset_0_-1px_0_0_var(--border-soft)] ${className ?? ''}`}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`border-b border-border-soft px-3 py-1.5 ${className ?? ''}`}>{children}</td>
  )
}

function initialDraft(item: QuoteItemDto): string {
  return item.priceKind === 'amount' && item.priceFen !== null
    ? formatYuan(item.priceFen)
    : item.priceText
}
