import {
  QUOTE_LIMITS,
  type QuoteAccessStateResponse,
  type QuoteBindType,
  type QuoteItemResponse,
} from '@fanhe/shared'
import { Check, Copy, ImagePlus, KeyRound, LoaderCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { ApiError } from '../../lib/api'
import {
  loadQuoteImageUrl,
  removeQuoteImage,
  saveQuotePrice,
  saveQuoteStatus,
  prepareQuoteImage,
  uploadQuoteImage,
} from '../../lib/quote'
import { describePrice, describeStatus, formatYuan } from '../../lib/quote-display'
import { Button } from '../ui/button'
import { Input } from '../ui/input'

/**
 * 右栏详情。**结构照静态稿 `.detail`**：图 → 名称 → 来源·分类 → 价格框 → 字段表 →
 * 可复制的报价文本 → 两个动作按钮。
 *
 * 三处刻意的顺序：
 *
 * 1. **图在最前。** 查五金时第一眼要确认的是「这是什么东西」，不是一串型号。
 * 2. **价格框独立成块。** 24px 的数字放在灰底框里，扫列表扫累了抬眼就能对上；
 *    规则价（「按所选花色36板的5倍单价计算」）在这个框里用 15px 琥珀色整句显示，
 *    列表里那行是截断的。
 * 3. **报价文本是一整块虚线框，不是一段普通文字。** 它是要被整块复制走的，
 *    等宽字体能让「¥1,220 /套」里的数字对齐，粘进微信不会串行。
 *
 * 维护区（改价 / 停用 / 换图 / 解绑）在静态稿的面板里没有画 —— 那块是「价格维护」
 * 视图的职责。此处保留是因为它是已有能力，入口在右侧同一栏里比藏进弹窗更好找；
 * 视觉按静态稿的按钮规格（32 高、圆角 9）统一。
 */

const BIND_TEXT: Record<QuoteBindType, string> = {
  exact: '精确',
  family: '同产品',
  manual: '手工',
}

const BIND_CLASS: Record<QuoteBindType, string> = {
  exact: 'bg-[color-mix(in_srgb,var(--m-teal)_12%,transparent)] text-m-teal',
  family: 'bg-[color-mix(in_srgb,var(--m-amber)_14%,transparent)] text-m-amber',
  manual: 'bg-[color-mix(in_srgb,var(--m-blue)_12%,transparent)] text-m-blue',
}

export function QuoteDetail({
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
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  /** 「已复制」的回落计时器。换条目时组件会重挂载，但计时器仍要在卸载时清掉。 */
  const copyTimer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
    },
    [],
  )

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

  /** 静态稿的报价文本：`名称（型号）` + U+3000 全角空格 + `¥668/㎡（投影面积）`。 */
  const quoteText =
    item.name +
    (item.model === '' ? '' : `（${item.model}）`) +
    '\u3000' +
    (price.tone === 'amount'
      ? `${price.primary}${price.suffix}`
      : price.tone === 'empty'
        ? '待补价'
        : price.primary) +
    (item.pricingMode === '' ? '' : `（${item.pricingMode}）`)

  /** 台账里的行号（`A001` / `C012` / `H345`）。条目号显示它，比 uuid 短一半且能回表里搜。 */
  const ledgerNo = item.ledgerNo === '' ? item.code : item.ledgerNo

  /**
   * 复制那一行。
   *
   * `navigator.clipboard` 需要安全上下文（https 或 localhost）。用局域网 IP 打开时
   * 它是 undefined —— 那时退回「复制失败」的提示，而不是装作成功。
   */
  async function handleCopyQuote(): Promise<void> {
    try {
      await navigator.clipboard.writeText(quoteText)
      setCopied(true)
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => {
        setCopied(false)
      }, 1400)
    } catch {
      setNotice({ kind: 'error', text: '复制失败：浏览器不允许写剪贴板，请手动选中文字' })
    }
  }

  /** 「在台账中定位」：把条目号复制出去，源表里搜它比翻名称可靠。 */
  async function handleLocate(): Promise<void> {
    try {
      await navigator.clipboard.writeText(ledgerNo)
      setNotice({ kind: 'ok', text: `条目号 ${ledgerNo} 已复制，可在台账里直接搜索` })
    } catch {
      setNotice({ kind: 'error', text: `条目号：${ledgerNo}` })
    }
  }

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
      {/* 图。有图给一块白底框（max-h 210，够看清结构），没有图给虚线说明。 */}
      {image === null ? (
        item.source === 'hardware' ? (
          <div className="mb-3 rounded-xl border border-dashed border-border bg-[repeating-linear-gradient(45deg,#fbfbfc,#fbfbfc_5px,#f5f5f7_5px,#f5f5f7_10px)] px-3 py-4 text-center text-xs leading-[1.7] text-muted-foreground-weak">
            台账该行没有贴图
            <br />
            <span className="text-[11px]">可在「价格维护 · 商品图」上传绑定</span>
          </div>
        ) : null
      ) : (
        <>
          <button
            type="button"
            onClick={onOpenImage}
            title="点击查看大图"
            className="group relative mb-3 flex min-h-[120px] w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-xl border border-border bg-white"
          >
            {heroUrl !== null ? (
              <img
                src={heroUrl}
                alt={item.name}
                draggable={false}
                className="block max-h-[210px] max-w-full object-contain"
              />
            ) : (
              <LoaderCircle className="size-4 animate-spin text-muted-foreground-weak" />
            )}
            <span className="absolute right-2 bottom-2 inline-flex items-center gap-1 rounded-full bg-[rgb(9_9_11_/_0.68)] px-1.5 py-0.5 text-[11px] text-white opacity-0 transition-opacity group-hover:opacity-100">
              放大
            </span>
          </button>
          <div className="-mt-1.5 mb-3 flex items-start gap-1.5 text-[11.5px] leading-[1.55] text-muted-foreground-weak">
            <span
              className={`flex-none rounded px-1.5 text-[10.5px] leading-4 ${BIND_CLASS[image.bindType]}`}
            >
              {BIND_TEXT[image.bindType]}
            </span>
            <span>
              {image.bindType === 'exact'
                ? `台账第 ${image.sourceRow ?? '—'} 行原图`
                : `同产品首行图（第 ${image.sourceRow ?? '—'} 行）`}
              {` · ${image.width} × ${image.height} px`}
            </span>
          </div>
        </>
      )}

      <div className="flex items-start justify-between gap-2">
        <h4 className="mb-1 text-[15px] leading-[22px] font-medium">{item.name}</h4>
        {status !== null && (
          <span className="shrink-0 rounded-full border border-border px-2 text-[11px] leading-[18px] text-muted-foreground-weak">
            {status}
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground-weak">
        {item.sourceName} · {item.category}
      </div>

      <div className="mt-2.5 mb-3.5 flex items-baseline gap-1.5 rounded-xl border border-border bg-card p-3">
        {price.tone === 'amount' ? (
          <>
            <span className="text-2xl leading-none font-medium tracking-[-0.01em] tabular-nums">
              {price.primary}
            </span>
            <span className="text-[12.5px] leading-[1.5] text-muted-foreground">
              {price.suffix === '' ? '' : `/ ${item.unit}`}
              {item.pricingMode === '' ? '' : ` · ${item.pricingMode}`}
            </span>
          </>
        ) : price.tone === 'empty' ? (
          <>
            <span className="text-[15px] font-medium text-m-amber">待补价</span>
            <span className="text-[12.5px] leading-[1.5] text-muted-foreground">
              台账该行收费栏为空
            </span>
          </>
        ) : (
          <>
            <span className="text-[15px] leading-[1.45] font-medium text-m-amber">
              {price.primary}
            </span>
            <span className="text-[12.5px] leading-[1.5] text-muted-foreground">{item.unit}</span>
          </>
        )}
      </div>

      <dl className="grid grid-cols-[64px_1fr] gap-x-2.5 gap-y-2 text-[12.5px]">
        <dt className="text-muted-foreground-weak">型号</dt>
        <dd className="m-0 leading-[1.55] break-words">{item.model === '' ? '—' : item.model}</dd>
        <dt className="text-muted-foreground-weak">规格</dt>
        <dd className="m-0 leading-[1.55] break-words">{item.spec === '' ? '—' : item.spec}</dd>
        {item.pricingMode !== '' && (
          <>
            <dt className="text-muted-foreground-weak">计价方式</dt>
            <dd className="m-0 leading-[1.55] break-words">{item.pricingMode}</dd>
          </>
        )}
        {price.tone !== 'amount' && (
          <>
            <dt className="text-muted-foreground-weak">单价原文</dt>
            <dd className="m-0 leading-[1.55] break-words">
              {item.priceText === '' ? '台账该行为空' : item.priceText}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground-weak">备注</dt>
        <dd className="m-0 leading-[1.55] break-words">{item.note === '' ? '—' : item.note}</dd>
        {/* 可选花色可能很长（多板材并列，最长 300 余字）。给一个 96px 的滚动窗口，
            否则右栏会被一条花色撑到看不见下面的按钮。 */}
        {item.materials !== '' && (
          <>
            <dt className="text-muted-foreground-weak">可选花色</dt>
            <dd className="m-0 max-h-24 overflow-auto leading-[1.55] break-words">
              {item.materials}
            </dd>
          </>
        )}
        <dt className="text-muted-foreground-weak">条目号</dt>
        <dd className="m-0 font-mono leading-[1.55] break-words">{ledgerNo}</dd>
      </dl>

      <div className="mt-4 rounded-[10px] border border-dashed border-border bg-card p-2.5 font-mono text-[11.5px] leading-[1.7] text-muted-foreground">
        {quoteText}
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          type="button"
          className="h-8 rounded-[9px] px-3 text-[13px]"
          onClick={() => void handleCopyQuote()}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? '已复制' : '复制报价文本'}
        </Button>
        <Button
          type="button"
          variant="outline"
          className="h-8 rounded-[9px] px-3 text-[13px]"
          onClick={() => void handleLocate()}
        >
          在台账中定位
        </Button>
      </div>

      {notice !== null && (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={[
            'mt-2 text-[11.5px] leading-[1.6]',
            notice.kind === 'error' ? 'text-destructive' : 'text-m-teal',
          ].join(' ')}
        >
          {notice.text}
        </p>
      )}

      {/* 维护区。没有权限时不隐藏整块，只把它变成一句说明 + 一个解锁入口 ——
          藏起来会让人以为「这个功能不存在」。 */}
      {!canWrite ? (
        <div className="mt-4 rounded-[10px] border border-dashed border-border p-3">
          <p className="text-xs text-muted-foreground">
            改价、换图需要维护口令。查价本身不受影响。
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2 h-8 rounded-[9px]"
            onClick={onRequestUnlock}
          >
            <KeyRound className="size-3.5" />
            输入维护口令
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-2 rounded-[10px] border border-border p-3">
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
            className="h-8"
          />
          <Input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={QUOTE_LIMITS.REASON_MAX}
            placeholder="改动说明（可选，会写进审计）"
            className="h-8"
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              className="h-8 rounded-[9px] px-3 text-[13px]"
              disabled={busy || draft.trim() === ''}
              onClick={() => void handleSavePrice()}
            >
              {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              保存价格
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-8 rounded-[9px] px-3 text-[13px]"
              disabled={busy}
              onClick={() => void handleToggleStatus()}
            >
              {item.status === 'active' ? '停用' : '恢复'}
            </Button>
            <Button
              type="button"
              variant="outline"
              className="h-8 rounded-[9px] px-3 text-[13px]"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
            >
              <ImagePlus className="size-3.5" />
              {image === null ? '上传图' : '换图'}
            </Button>
            {image !== null && (
              <Button
                type="button"
                variant="outline"
                className="h-8 rounded-[9px] px-3 text-[13px]"
                disabled={busy}
                onClick={() => void handleRemoveImage()}
              >
                解绑
              </Button>
            )}
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ''
              if (file !== undefined) void handlePickImage(file)
            }}
          />
        </div>
      )}
    </>
  )
}

/** 输入框里的初值：金额按「元」显示，其余形态用原文。 */
function initialPriceDraft(item: QuoteItemResponse['item']): string {
  return item.priceKind === 'amount' && item.priceFen !== null
    ? formatYuan(item.priceFen)
    : item.priceText
}

/** 写操作失败时的说法。403 单独一句：它意味着「口令没解开」，不是网络问题。 */
function describeWriteFailure(error: unknown, onRequestUnlock: () => void): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      onRequestUnlock()
      return '维护口令已失效，请重新输入'
    }
    return error.message
  }
  return '保存失败，请稍后重试'
}
