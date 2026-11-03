import type { QuoteItemDto, QuoteSource } from '@fanhe/shared'
import { LoaderCircle, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { ApiError } from '../../../lib/api'
import { mergeQuoteItems, searchQuotes } from '../../../lib/quote'
import { describePrice } from '../../../lib/quote-display'

/**
 * 单个分类下的产品列表，用于「把多条产品合并成一条」。
 *
 * ## 为什么单独取一次产品，而不是从外层带进来
 *
 * 外层只拿到每个分类的条数（`groupBy` 的结果），拿不到行。合并要精确到 `code`，
 * 而 `code` 是业务键、只能由列表接口给。所以点开一个分类才拉它的产品 —— 1225 条
 * 一次全下下来，光 JSON 就有 400KB。
 *
 * ## 为什么「保留哪一条」是单选，而且必须由人点
 *
 * 默认取第一条看着省事，但同一个分类下的条往往只有一条带价格、一条带图。折叠时保留
 * 错的那条，结果是「价格和图都没了」，而列表上只剩一行，看不出少了什么。所以默认
 * 选第一条，但**明确画出来**，并且在合并前把「保留 / 下架」的条数写清楚。
 *
 * ## 为什么空选时要先禁用而不是点了报错
 *
 * 勾不满两条时按钮是灰的，旁边写一句「至少勾选两条」。点了才弹错误，等于让用户
 * 用一次失败去学一条规则。
 */
export function QuoteCategoryProducts({
  source,
  category,
  onResult,
  onChanged,
  onClose,
}: {
  source: QuoteSource
  category: string
  onResult: (kind: 'ok' | 'error', text: string) => void
  /** 合并成功后让父级刷新分类列表：这个分类的条数变了。 */
  onChanged: () => void
  onClose: () => void
}) {
  const [items, setItems] = useState<readonly QuoteItemDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [keep, setKeep] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(
    (): Promise<void> =>
      searchQuotes({ source, category, limit: 200 })
        .then((result) => {
          setItems([...result.items])
          setError(null)
          setSelected((current) =>
            current.filter((code) => result.items.some((i) => i.code === code)),
          )
          setKeep((current) =>
            current !== null && result.items.some((item) => item.code === current) ? current : null,
          )
        })
        .catch((cause: unknown) => {
          setItems(null)
          setError(cause instanceof ApiError ? cause.message : '产品读取失败')
        }),
    [source, category],
  )

  const reload = useCallback(() => {
    void refresh()
  }, [refresh])

  useEffect(reload, [reload])

  const rows = items ?? []
  const canMerge = selected.length >= 2 && keep !== null && selected.includes(keep)

  function toggle(code: string): void {
    setSelected((current) => {
      const next = current.includes(code)
        ? current.filter((value) => value !== code)
        : [...current, code]
      // 取消勾选「保留条」时把它一起清掉：留着一个不在候选里的 keep，
      // 合并按钮看着可用，点下去一定失败。
      if (keep !== null && !next.includes(keep)) setKeep(next[0] ?? null)
      return next
    })
  }

  async function submit(): Promise<void> {
    if (!canMerge || keep === null) return
    setBusy(true)
    try {
      const result = await mergeQuoteItems({ source, category, codes: selected, keep })
      const inherited =
        result.inherited.length === 0 ? '' : `，并继承了${result.inherited.join('、')}`
      onResult('ok', `已合并：保留 1 条，${result.archived} 条转为已下架${inherited}`)
      setSelected([])
      setKeep(null)
      onChanged()
      await refresh()
      onClose()
    } catch (cause) {
      onResult('error', cause instanceof ApiError ? cause.message : '合并失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-t border-border-soft bg-background px-3 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12px] font-medium">
          「{category}」下的产品
          <span className="ml-1.5 font-normal text-muted-foreground-weak">
            勾选两条以上，再点一行左侧的「保留」标记要留下的那条
          </span>
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex h-6 items-center gap-1 rounded-[6px] px-1.5 text-[11px] text-muted-foreground hover:bg-accent"
        >
          <X className="size-3" />
          收起
        </button>
      </div>

      {error !== null ? (
        <p className="py-2 text-[12px] text-destructive">{error}</p>
      ) : items === null ? (
        <p className="py-2 text-[12px] text-muted-foreground">读取中…</p>
      ) : rows.length === 0 ? (
        <p className="py-2 text-[12px] text-muted-foreground">这个分类下还没有在售产品。</p>
      ) : (
        <>
          <div className="max-h-[220px] overflow-auto rounded-lg border border-border-soft">
            <table className="w-full border-collapse text-[12px]">
              <tbody>
                {rows.map((item) => {
                  const picked = selected.includes(item.code)
                  return (
                    <tr key={item.code} className={picked ? 'bg-accent/40' : undefined}>
                      <td className="w-8 border-b border-border-soft px-2 py-1.5">
                        <input
                          type="checkbox"
                          checked={picked}
                          onChange={() => toggle(item.code)}
                          aria-label={`选择「${item.name}」`}
                          className="size-3.5 accent-[var(--primary)]"
                        />
                      </td>
                      <td className="w-24 border-b border-border-soft px-2 py-1.5">
                        <label className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <input
                            type="radio"
                            name="quote-merge-keep"
                            disabled={!picked}
                            checked={keep === item.code}
                            onChange={() => setKeep(item.code)}
                            aria-label={`保留「${item.name}」`}
                            className="size-3.5 accent-[var(--m-teal)]"
                          />
                          {keep === item.code ? (
                            <span className="text-m-teal">保留</span>
                          ) : (
                            <span className="text-muted-foreground-weak">保留…</span>
                          )}
                        </label>
                      </td>
                      <td className="border-b border-border-soft px-2 py-1.5">
                        <span className="text-[11px] text-muted-foreground-weak tabular-nums">
                          {item.ledgerNo === '' ? '—' : item.ledgerNo}
                        </span>
                        <span className="ml-2">{item.name}</span>
                        {item.model !== '' && (
                          <span className="ml-1.5 text-muted-foreground-weak">{item.model}</span>
                        )}
                        {item.spec !== '' && (
                          <span className="ml-1.5 text-muted-foreground-weak">{item.spec}</span>
                        )}
                      </td>
                      <td className="w-28 border-b border-border-soft px-2 py-1.5 text-right tabular-nums">
                        {/* `describePrice` 返回的是「主文 / 后缀 / 形态」三段，
                            不是字符串 —— 直接渲染对象会被 React 拒绝。 */}
                        <span>{describePrice(item).primary}</span>
                        <span className="text-muted-foreground-weak">
                          {describePrice(item).suffix}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11.5px] text-muted-foreground">
              {selected.length < 2 ? (
                <span className="text-muted-foreground-weak">至少勾选两条才能合并</span>
              ) : keep === null ? (
                <span className="text-destructive">还没有选「保留」哪一条</span>
              ) : (
                <>
                  保留 <b className="font-medium">1</b> 条，下架{' '}
                  <b className="font-medium">{selected.length - 1}</b> 条（不删除，可单独上架回来）
                </>
              )}
            </span>
            <button
              type="button"
              disabled={busy || !canMerge}
              onClick={() => void submit()}
              className="ml-auto inline-flex h-8 items-center rounded-[9px] bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-40"
            >
              {busy ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
              合并为一条
            </button>
          </div>
        </>
      )}
    </div>
  )
}
