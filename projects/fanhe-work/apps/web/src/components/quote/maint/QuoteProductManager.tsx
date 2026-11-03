import {
  QUOTE_LIMITS,
  QUOTE_SOURCES,
  QUOTE_SOURCE_NAMES,
  type QuoteAccessStateResponse,
  type QuoteCategoryDto,
  type QuoteItemDto,
  type QuoteSource,
} from '@fanhe/shared'
import { LoaderCircle, Plus, Search } from 'lucide-react'
import { Fragment, useCallback, useEffect, useState } from 'react'

import { ApiError } from '../../../lib/api'
import {
  createQuoteItem,
  loadQuoteCategories,
  saveQuotePrice,
  saveQuoteStatus,
  searchQuotes,
} from '../../../lib/quote'
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
  }, [])

  async function run(task: () => Promise<string>): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const text = await task()
      setNotice({ kind: 'ok', text })
      await refresh()
      onChanged()
    } catch (cause) {
      setNotice({
        kind: 'error',
        text: cause instanceof ApiError ? cause.message : '操作失败，请重试',
      })
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {QUOTE_SOURCES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={source === value}
            onClick={() => {
              setSource(value)
              setEditingCode(null)
            }}
            className={
              source === value
                ? 'inline-flex h-8 items-center rounded-[9px] bg-secondary px-3 text-[13px] font-medium'
                : 'inline-flex h-8 items-center rounded-[9px] px-3 text-[13px] text-muted-foreground hover:bg-accent'
            }
          >
            {QUOTE_SOURCE_NAMES[value]}
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
          categories={sourceCategories.map((row) => row.name)}
          busy={busy}
          onCancel={() => setCreating(false)}
          onSubmit={async (input) => {
            await run(async () => {
              await createQuoteItem(input)
              return `已新增「${input.name}」`
            })
            setCreating(false)
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
                          colSpan={6}
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

function NewProductForm({
  source,
  categories,
  busy,
  onCancel,
  onSubmit,
}: {
  source: QuoteSource
  categories: readonly string[]
  busy: boolean
  onCancel: () => void
  onSubmit: (input: {
    source: QuoteSource
    category: string
    name: string
    model: string
    spec: string
    unit: string
    priceText: string
    note: string
    pricingMode: string
  }) => Promise<void>
}) {
  const [category, setCategory] = useState(categories[0] ?? '')
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const [spec, setSpec] = useState('')
  const [unit, setUnit] = useState('')
  const [priceText, setPriceText] = useState('')
  const [note, setNote] = useState('')

  const ready = category.trim() !== '' && name.trim() !== ''

  return (
    <div className="mb-3 rounded-xl border border-border bg-background p-3">
      <div className="mb-2 text-[12.5px] font-medium">新增产品 · {QUOTE_SOURCE_NAMES[source]}</div>
      <div className="grid grid-cols-3 gap-2">
        <Field label="分类（必填）">
          <input
            list="quote-maint-categories"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
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
            placeholder="例如 E0 级实木颗粒板"
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <Field label="价格">
          <input
            value={priceText}
            onChange={(event) => setPriceText(event.target.value)}
            placeholder="668 / 1.5 倍 / 120 元/米"
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <Field label="型号">
          <input
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <Field label="规格">
          <input
            value={spec}
            onChange={(event) => setSpec(event.target.value)}
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <Field label="单位">
          <input
            value={unit}
            onChange={(event) => setUnit(event.target.value)}
            placeholder="㎡ / 米 / 个"
            className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
          />
        </Field>
        <div className="col-span-3">
          <Field label="备注">
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              className="h-8 w-full rounded-[8px] border border-border bg-card px-2.5 text-[12.5px] outline-none focus:border-ring"
            />
          </Field>
        </div>
      </div>
      <div className="mt-2.5 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !ready}
          onClick={() =>
            void onSubmit({
              source,
              category: category.trim(),
              name: name.trim(),
              model: model.trim(),
              spec: spec.trim(),
              unit: unit.trim(),
              priceText: priceText.trim(),
              note: note.trim(),
              pricingMode: '',
            })
          }
          className="inline-flex h-8 items-center gap-1 rounded-[9px] bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          保存产品
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-[9px] border border-border px-3 text-[12.5px]"
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
