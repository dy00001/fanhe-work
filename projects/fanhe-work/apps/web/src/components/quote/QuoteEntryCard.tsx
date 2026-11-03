import type { QuoteItemDto } from '@fanhe/shared'
import { CornerDownLeft, Search } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { loadQuoteImageUrl, loadQuoteMeta, searchQuotes } from '../../lib/quote'
import { describePrice, quoteSourceColor, splitHighlight } from '../../lib/quote-display'

import { QuoteLightbox } from './QuoteLightbox'
import { QuoteThumb } from './QuoteThumb'

/**
 * 首页「一键启动」格里的报价查价卡。**照静态稿 `.quote-card` + `.pop` 还原。**
 *
 * 卡里常驻一个输入框，键入即出结果浮层（最多 7 行），回车进全屏面板。
 * **不做「点一下展开再输入」**：多一次点击就多一次让人放弃的机会。
 *
 * ## 浮层必须 portal 到 body
 *
 * `.mod-card` 带 `overflow: hidden`（卡面的辉光层要靠它裁边）。浮层写在卡内会被
 * 裁掉下半截 —— 这是静态稿实现时就踩到的坑，注释里写着「必然踩到」。
 *
 * ## 浮层位置按实测高度算
 *
 * 按 `max-height` 估会在明明有下方空间时也翻到上面去，浮层与输入框之间隔着一整个
 * 段落的距离。所以先上屏、再量 `getBoundingClientRect().height`、再决定上下。
 */
const POP_WIDTH = 560
const POP_MAX_ROWS = 7

export function QuoteEntryCard({ onOpen }: { onOpen: (keyword: string) => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const popRef = useRef<HTMLDivElement | null>(null)

  const [total, setTotal] = useState<number | null>(null)
  /** 主类短名。底部那行「柜体 · 工艺 · 五金」，来源是 meta.sources。 */
  const [sourceShorts, setSourceShorts] = useState<readonly string[]>([])
  const [keyword, setKeyword] = useState('')
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<readonly QuoteItemDto[]>([])
  const [hitCount, setHitCount] = useState(0)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  /**
   * 浮层里那张小图的灯箱。**点图只看大图，不跳面板** —— 与静态稿一致：
   * `spec` 都还没确认的时候，人想要的是一张更大的图，不是另一个页面。
   */
  const [lightbox, setLightbox] = useState<{
    src: string | null
    failed: boolean
    name: string
  } | null>(null)

  function openLightbox(item: QuoteItemDto): void {
    const imageKey = item.imageKey
    if (imageKey === null) return
    setLightbox({ src: null, failed: false, name: item.name })
    void loadQuoteImageUrl(imageKey, 'full', item.imageVersion).then((url) => {
      setLightbox({ src: url, failed: url === null, name: item.name })
    })
  }

  useEffect(() => {
    let alive = true
    loadQuoteMeta()
      .then((meta) => {
        if (!alive) return
        setTotal(meta.itemCount)
        // 底部那行「柜体 · 工艺 · 五金」也来自主类表：新增一类之后这里跟着多一个词，
        // 而不是永远念着内置那三个。
        setSourceShorts((meta.sources ?? []).map((entry) => entry.short))
      })
      .catch(() => {
        if (alive) setTotal(0)
      })
    return () => {
      alive = false
    }
  }, [])

  const position = useCallback(() => {
    const input = inputRef.current
    const pop = popRef.current
    if (input === null) return
    const rect = input.getBoundingClientRect()
    const width = Math.min(POP_WIDTH, window.innerWidth - 24)
    const height = pop?.getBoundingClientRect().height ?? 320
    const left = Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12)
    const below = rect.bottom + 10
    const above = rect.top - height - 10
    let top: number
    if (below + height <= window.innerHeight - 12) top = below
    else if (above >= 12) top = above
    else top = Math.max(12, Math.min(below, window.innerHeight - height - 12))
    setPos({ left, top })
  }, [])

  // 键入 → 120ms 防抖 → 取 7 条。空关键词不发请求。
  //
  // 「清空输入就把浮层收掉」写在 `onChange` 里而不是这里：在 effect 体内同步
  // `setOpen` 会撞 `react-hooks/set-state-in-effect`（级联渲染），而且清空这件事
  // 本身就是一次用户事件，不是需要跟外部系统同步的状态。
  useEffect(() => {
    const needle = keyword.trim()
    if (needle === '') return
    let alive = true
    const timer = window.setTimeout(() => {
      void searchQuotes({ q: needle, limit: POP_MAX_ROWS }).then((result) => {
        if (!alive) return
        setRows(result.items.slice(0, POP_MAX_ROWS))
        setHitCount(result.total)
        setActive(0)
        setOpen(true)
      })
    }, 120)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [keyword])

  // 先上屏再量高度。
  useEffect(() => {
    if (!open) return
    position()
    const onResize = (): void => {
      position()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('scroll', onResize, true)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('scroll', onResize, true)
    }
  }, [open, rows, position])

  // 点空白处收起。
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target
      if (target instanceof Node && popRef.current?.contains(target)) return
      if (target === inputRef.current) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('mousedown', onDown)
    }
  }, [open])

  function openPanel(needle: string): void {
    setOpen(false)
    onOpen(needle)
  }

  return (
    <>
      <div
        style={{ '--hue': 'var(--m-teal)' } as React.CSSProperties}
        className="mod-card w-full cursor-pointer justify-start gap-2 text-left"
        onClick={() => {
          openPanel('')
        }}
      >
        <span className="absolute top-3 right-3 z-[1] rounded-full border border-[color-mix(in_srgb,var(--m-teal)_32%,var(--border))] bg-[color-mix(in_srgb,var(--m-teal)_6%,var(--card))] px-2 py-px text-xs leading-[1.6] text-m-teal">
          可用
        </span>
        <span className="mod-icon grid size-9 shrink-0 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--hue)_var(--wash),var(--card))] text-[var(--hue)]">
          <Search className="size-[18px]" />
        </span>
        <div className="mod-body flex w-full min-w-0 flex-col gap-1.5">
          <h4 className="mb-0.5 text-lg leading-7 font-medium">报价查价</h4>

          {/* 输入区自己吃掉点击：点它只该聚焦，不该跳面板。 */}
          <div
            className="relative flex h-[34px] w-full items-center gap-1.5 rounded-[10px] border border-border bg-background px-2 focus-within:border-ring focus-within:bg-card focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--m-teal)_12%,transparent)]"
            onClick={(event) => {
              event.stopPropagation()
              inputRef.current?.focus()
            }}
          >
            <Search className="size-3.5 shrink-0 text-muted-foreground-weak" />
            <input
              ref={inputRef}
              value={keyword}
              onChange={(event) => {
                const next = event.target.value
                setKeyword(next)
                // 清空即收浮层。留着一个空浮层会挡住下面那张卡。
                if (next.trim() === '') {
                  setOpen(false)
                  setRows([])
                  setHitCount(0)
                }
              }}
              onFocus={() => {
                if (keyword.trim() !== '' && rows.length > 0) setOpen(true)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setOpen(false)
                  inputRef.current?.blur()
                  return
                }
                if (event.key === 'Enter') {
                  event.preventDefault()
                  openPanel(keyword)
                  return
                }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault()
                  if (rows.length === 0) return
                  setActive(
                    (current) =>
                      (current + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length,
                  )
                }
              }}
              placeholder="材质 / 型号 / 工艺"
              aria-label="按关键字查价"
              autoComplete="off"
              className="min-w-0 flex-1 border-0 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground-weak"
            />
            {/* `.quote-field .kbd`：一枚描边小方块装着回车箭头，提示「按回车进面板」。 */}
            <span
              aria-hidden="true"
              className="ml-auto inline-flex shrink-0 items-center rounded-[4px] border border-border bg-card px-1 py-px text-muted-foreground-weak"
            >
              <CornerDownLeft className="size-2.5" />
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-muted-foreground-weak">
            <span>
              <b className="font-medium text-muted-foreground">{total ?? '…'}</b> 条
            </span>
            <span className="size-1 rounded-full bg-muted-foreground-weak opacity-60" />
            <span>{sourceShorts.length === 0 ? '—' : sourceShorts.join(' · ')}</span>
          </div>
        </div>
      </div>

      {open &&
        pos !== null &&
        createPortal(
          <div
            ref={popRef}
            role="dialog"
            aria-label="查价结果"
            style={{
              left: pos.left,
              top: pos.top,
              width: Math.min(POP_WIDTH, window.innerWidth - 24),
            }}
            className="fixed z-[70] flex max-h-[420px] flex-col overflow-hidden rounded-[14px] border border-border bg-popover shadow-[0_18px_48px_rgb(0_0_0_/_0.16),0_0_0_0.5px_rgb(0_0_0_/_0.04)]"
          >
            <div className="flex items-center gap-2 border-b border-border-soft bg-card px-3.5 py-2.5 text-xs text-muted-foreground">
              <span>{keyword.trim() === '' ? '全部来源' : `关键词「${keyword.trim()}」`}</span>
              <span className="flex-1" />
              <span className="text-muted-foreground-weak tabular-nums">{hitCount} 条</span>
            </div>

            <div className="overflow-auto p-1">
              {rows.length === 0 ? (
                <div className="px-4 py-6 text-center text-[13px] text-muted-foreground-weak">
                  没有匹配{' '}
                  <code className="rounded bg-muted px-1.5 py-px font-mono text-xs">
                    {keyword.trim()}
                  </code>{' '}
                  的价格条目
                  <br />
                  <span className="text-xs">可试：爱格 / 欧松 / 拉直器 / 2010001 / 洞洞板</span>
                </div>
              ) : (
                rows.map((item, index) => {
                  const price = describePrice(item)
                  return (
                    <button
                      key={item.code}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault()
                        openPanel(item.name.split(/[+（(]/)[0]?.trim() ?? item.name)
                      }}
                      className={[
                        'flex w-full items-start gap-3 rounded-[10px] px-2.5 py-[9px] text-left',
                        index === active ? 'bg-accent' : 'hover:bg-accent',
                      ].join(' ')}
                    >
                      <span
                        aria-hidden="true"
                        style={{ background: quoteSourceColor(item.source) }}
                        className="mt-0.5 size-1.5 shrink-0 rounded-full"
                      />
                      {item.hasImage && (
                        <QuoteThumb
                          variant="pop"
                          item={item}
                          onOpen={() => {
                            openLightbox(item)
                          }}
                        />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] leading-5 font-medium">
                          {splitHighlight(item.name, keyword.trim()).map((segment, segmentIndex) =>
                            segment.hit ? (
                              <mark key={segmentIndex} className="bg-transparent text-inherit">
                                {segment.text}
                              </mark>
                            ) : (
                              <span key={segmentIndex}>{segment.text}</span>
                            ),
                          )}
                        </span>
                        <span className="mt-px flex flex-wrap gap-1.5 text-[11.5px] text-muted-foreground-weak">
                          {item.category}
                          {item.model !== '' && (
                            <>
                              <i className="text-border not-italic">·</i>
                              {item.model}
                            </>
                          )}
                          {item.spec !== '' && (
                            <>
                              <i className="text-border not-italic">·</i>
                              {item.spec}
                            </>
                          )}
                          <i className="text-border not-italic">·</i>
                          {item.sourceShort}
                        </span>
                      </span>
                      <span className="shrink-0 text-right whitespace-nowrap tabular-nums">
                        {price.tone === 'amount' ? (
                          <>
                            <span className="text-sm font-medium">{price.primary}</span>
                            {price.suffix !== '' && (
                              <span className="ml-0.5 text-[11px] text-muted-foreground-weak">
                                {price.suffix}
                              </span>
                            )}
                          </>
                        ) : price.tone === 'empty' ? (
                          <span className="text-[11.5px] text-muted-foreground-weak">待补价</span>
                        ) : (
                          <span className="block max-w-[132px] text-right text-[11.5px] leading-[15px] text-m-amber">
                            {price.primary}
                          </span>
                        )}
                      </span>
                    </button>
                  )
                })
              )}
            </div>

            <div className="flex items-center gap-2.5 border-t border-border-soft bg-card px-3 py-2 text-xs text-muted-foreground">
              <span>↑↓ 选择 · ↵ 打开面板 · Esc 关闭</span>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault()
                  openPanel(keyword)
                }}
                className="ml-auto inline-flex items-center gap-1 font-medium text-foreground"
              >
                查看全部结果 ›
              </button>
            </div>
          </div>,
          document.body,
        )}

      <QuoteLightbox
        open={lightbox !== null}
        onClose={() => setLightbox(null)}
        src={lightbox?.src ?? null}
        failed={lightbox?.failed ?? false}
        alt={lightbox?.name ?? '商品图'}
        natural={null}
      />
    </>
  )
}
