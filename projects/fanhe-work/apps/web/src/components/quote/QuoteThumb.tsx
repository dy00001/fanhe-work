import type { QuoteItemDto } from '@fanhe/shared'
import { ImageOff, LoaderCircle } from 'lucide-react'
import { useEffect, useState } from 'react'

import { loadQuoteImageUrl } from '../../lib/quote'
import { cn } from '../../lib/utils'

/**
 * 列表行首的商品图。
 *
 * 取字节要令牌，`<img>` 带不了请求头，所以先 fetch 成 Blob 再转 object URL。缓存键
 * 里带版本号，换图之后自动取到新的那张。
 *
 * 结果与「这一张的键」绑在一起（指纹），换行/换图时旧结果自动失效，不需要在 effect
 * 里先清一遍 —— 与 `lib/use-ops-dashboard.ts` 同一条做法。
 *
 * ## 没有图时给一块看不见的占位
 *
 * 1225 条里只有 294 条有图。早先的实现给每一行都画一个虚线框 + 破图图标，滚起来
 * 满屏虚线，看起来像「图全挂了」而不是「这一条本来就没图」。现在：非五金来源留一块
 * 透明占位（列宽不塌），五金来源写一个「无图」小字 —— 五金台账本来就没有贴图列，
 * 那里需要说明，柜体类不需要。
 */
export function QuoteThumb({
  item,
  onOpen,
  className,
}: {
  item: QuoteItemDto
  /** 点图放大。行本身也可以选中，这里要 `stopPropagation`。 */
  onOpen: () => void
  className?: string
}) {
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
      return <span aria-hidden="true" className={cn('block size-10 shrink-0', className)} />
    }
    return (
      <span
        title="台账该行没有贴图"
        className={cn(
          'grid size-10 shrink-0 place-items-center rounded-md border border-dashed border-border',
          'text-[10px] leading-none text-muted-foreground-weak',
          className,
        )}
      >
        无图
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
      className={cn(
        'relative size-10 shrink-0 overflow-hidden rounded-md border border-border bg-muted/40',
        className,
      )}
    >
      {url !== null ? (
        <img src={url} alt="" draggable={false} className="size-full object-contain" />
      ) : (
        <span className="grid size-full place-items-center text-muted-foreground-weak">
          {failed ? (
            <ImageOff className="size-3.5" />
          ) : (
            <LoaderCircle className="size-3.5 animate-spin" />
          )}
        </span>
      )}
    </button>
  )
}
