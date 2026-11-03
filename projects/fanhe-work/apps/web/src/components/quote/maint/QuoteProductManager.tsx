import {
  QUOTE_LIMITS,
  type QuoteAccessStateResponse,
  type QuoteCategoryDto,
  type QuoteItemDto,
  type QuoteSource,
  type QuoteSourceDto,
  type UploadQuoteImageRequest,
} from '@fanhe/shared'
import { ImagePlus, LoaderCircle, Plus, Search, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../../../lib/api'
import {
  createQuoteItem,
  loadQuoteCategories,
  loadQuoteImageUrl,
  loadQuoteSources,
  saveQuotePrice,
  saveQuoteStatus,
  searchQuotes,
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
                <Th className="w-16">条目号</Th>
                <Th className="w-12">图</Th>
                <Th>名称 / 型号</Th>
                <Th className="w-[132px]">分类</Th>
                <Th className="w-[148px]">价格</Th>
                <Th className="w-14">状态</Th>
                <Th className="w-[136px]">操作</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => {
                const price = describePrice(item)
                const status = describeStatus(item.status)
                const editing = editingCode === item.code
                return (
                  <Fragment key={item.code}>
                    <tr className="align-middle">
                      <Td className="font-mono text-[11.5px] text-muted-foreground-weak">
                        {item.ledgerNo === '' ? '—' : item.ledgerNo}
                      </Td>
                      <Td>
                        <ProductThumb item={item} />
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
                        </div>
                      </Td>
                    </tr>
                    {editing && (
                      <tr>
                        <td
                          colSpan={7}
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
        aria-label="无图"
        className="flex size-8 items-center justify-center rounded-[6px] border border-dashed border-border-soft text-[10px] text-muted-foreground-weak"
      >
        —
      </span>
    )
  }

  if (url === null) {
    return <span className="block size-8 animate-pulse rounded-[6px] bg-accent" aria-hidden />
  }

  return (
    <img
      src={url}
      alt={`「${item.name}」的产品图`}
      className="size-8 rounded-[6px] border border-border-soft object-cover"
    />
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

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`border-b border-border-soft bg-background px-3 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak ${className ?? ''}`}
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
