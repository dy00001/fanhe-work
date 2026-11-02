import type { QuoteItemDto } from '@fanhe/shared'
import { ImageOff, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import { loadQuoteImageUrl } from '../../lib/quote'
import { cn } from '../../lib/utils'

/**
 * 列表行首的商品图（静态稿 `.thumb` / `.thumb-ph`）。
 *
 * 尺寸 38px、白底、`object-contain`：列表里的图只承担「认得出是哪件东西」，
 * 看清结构要点开灯箱。
 *
 * 取字节要令牌，`<img>` 带不了请求头，所以先 fetch 成 Blob 再转 object URL。缓存键
 * 里带版本号，换图之后自动取到新的那张。
 *
 * 结果与「这一张的键」绑在一起（指纹），换行/换图时旧结果自动失效，不需要在 effect
 * 里先清一遍 —— 与 `lib/use-ops-dashboard.ts` 同一条做法。
 *
 * ## 没有图时按来源分两档
 *
 * 静态稿的做法：非五金来源画一块**透明占位**（列宽不塌、但不出现虚线框），五金来源
 * 画斜纹虚线 + 「无图」。五金台账本来就没有贴图列，那里需要一句说明；柜体类不需要，
 * 满屏虚线只会让人以为图全挂了。
 */
export function QuoteThumb({
  item,
  onOpen,
  variant = 'table',
  className,
}: {
  item: QuoteItemDto
  /** 点图放大。行本身也可以选中，这里要 `stopPropagation`。 */
  onOpen: () => void
  /**
   * 两处尺寸，都照静态稿：表格里 38px（`.thumb`），浮层里 30px（`.prow .thumb`）。
   * 浮层一行只给一眼确认，所以更小；无图时的文案也跟着换 —— 38px 装得下「无图」，
   * 30px 装不下，静态稿那里是一个「—」。
   */
  variant?: 'table' | 'pop'
  className?: string
}) {
  const pop = variant === 'pop'
  const box = pop ? 'size-[30px] rounded-[4px]' : 'size-[38px] rounded-[5px]'
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
    if (item.source !== 'hardware') {
      return <span aria-hidden="true" className={cn('block shrink-0', box, className)} />
    }
    return (
      <span
        title="台账该行没有贴图"
        className={cn(
          'grid shrink-0 place-items-center border border-dashed border-border',
          box,
          'bg-[repeating-linear-gradient(45deg,#fbfbfc,#fbfbfc_4px,#f5f5f7_4px,#f5f5f7_8px)]',
          'text-[10px] leading-none text-muted-foreground-weak',
          className,
        )}
      >
        {pop ? '—' : '无图'}
      </span>
    )
  }

  const current = loaded !== null && loaded.key === key ? loaded : null
  const url = current?.url ?? null
  const failed = current !== null && current.url === null
  const body =
    url !== null ? (
      <img src={url} alt="" draggable={false} className="size-full object-contain" />
    ) : (
      <span className="grid size-full place-items-center text-muted-foreground-weak">
        {failed ? (
          <ImageOff className="size-3.5" />
        ) : (
          <LoaderCircle className="size-3.5 animate-spin" />
        )}
      </span>
    )
  const boxClass = cn(
    'block shrink-0 cursor-zoom-in overflow-hidden border border-border bg-white',
    box,
    'hover:border-ring hover:shadow-[0_0_0_2px_color-mix(in_srgb,var(--m-blue)_14%,transparent)]',
    className,
  )

  // 浮层那一行整行本身就是 `<button>` —— 里面再放一个 `<button>` 是非法嵌套，
  // 浏览器会把内层挪到外面、布局当场散掉。静态稿那里也只是一张 `<img>` 加一个
  // 全局的点击代理，所以这里退化成 `<span>` + `mousedown`：
  // `preventDefault` 挡住外层按钮的失焦，`stopPropagation` 挡住「顺带打开面板」。
  if (pop) {
    return (
      <span
        role="presentation"
        onMouseDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onOpen()
        }}
        className={boxClass}
      >
        {body}
      </span>
    )
  }

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
      aria-label={`查看 ${item.name} 的大图`}
      className={boxClass}
    >
      {body}
    </button>
  )
}
