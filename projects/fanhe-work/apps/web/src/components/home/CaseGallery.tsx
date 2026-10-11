import { ArrowLeft, ArrowRight, Image as ImageIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 案例展示的品类清单。顺序即界面顺序。
 *
 * 与原型逐条一致，九个品类一个不多一个不少。**它们是文案不是数据**：这一版没有
 * 「案例」这张表，卡面是占位（`封面待补`），因此清单写在前端。等案例落库之后，
 * 这张表应当换成一次查询，而卡片结构与横滑逻辑都不用动 —— 那正是把清单单独拎出来
 * 的原因。
 */
const CATEGORIES = [
  '橱柜',
  '衣柜',
  '书柜',
  '鞋柜',
  '酒柜',
  '套装门',
  '电视柜',
  '餐边柜',
  '护墙板',
] as const

/**
 * 案例展示（原型编号 9）。
 *
 * 一排放四张、可横滑的品类条。四等分的算法是 `(100% - 3 × 16) / 4`，与下方 Bento 的
 * 列宽落在同一条栅格上，也与区块头的「全部品类」右对齐。
 *
 * **横滑要照顾四种输入方式，缺一种就有一批人滑不动。**
 *   - 圆形按钮：原型的做法。滑到两端时对应那个按钮**整个不渲染**（原型用「存在 /
 *     不存在」而不是「可见 / 不可见」来表达，与它自绘滚动条时直接摘节点同一思路）。
 *   - 滚轮：竖向 `deltaY` 在条内转成横向位移。**这一条必须用原生监听器**：
 *     React 的 `onWheel` 是被动监听，拿不到 `preventDefault`，而这里必须阻止默认
 *     行为 —— 否则滚轮会同时横移卡片条与纵向滚动整页，用户看到的是「页面乱跳」。
 *   - 拖拽：按住左键拖动。系统滚动条已被隐藏，鼠标用户没有别的办法拖。
 *   - 键盘：容器可聚焦，← → 翻一页。
 */
export function CaseGallery() {
  const stripRef = useRef<HTMLDivElement>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)
  const [dragging, setDragging] = useState(false)

  /**
   * 两端状态。
   *
   * 不引入 `IntersectionObserver` 或滚动比例计算：`scrollLeft` 与两个边界的关系就是
   * 定义本身，写成别的形式只会多一层需要同步的中间量。容差取 1px —— 分数像素的
   * `scrollLeft` 会停在 0.5 之类的位置，严格等于 0 判不出来。
   */
  const syncEdges = useCallback(() => {
    const el = stripRef.current
    if (el === null) return
    setAtStart(el.scrollLeft <= 1)
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 1)
  }, [])

  useEffect(() => {
    const el = stripRef.current
    if (el === null) return

    syncEdges()
    el.addEventListener('scroll', syncEdges, { passive: true })

    // 滚轮转横向。`passive: false` 是关键：被动监听里调 `preventDefault` 会被忽略，
    // 而忽略的后果是滚轮同时横移与纵向滚页。
    const onWheel = (event: WheelEvent) => {
      // 横向滚轮（触控板左右划）与纵向滚轮要分开：前者的 deltaX 已经由浏览器处理，
      // 再叠加一次会走两倍距离。
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      event.preventDefault()
      el.scrollLeft += event.deltaY
    }
    el.addEventListener('wheel', onWheel, { passive: false })

    // 窗口变宽后四等分的卡变宽，条可能不再溢出 —— 此时两个按钮都该消失。
    const observer = new ResizeObserver(syncEdges)
    observer.observe(el)

    return () => {
      el.removeEventListener('scroll', syncEdges)
      el.removeEventListener('wheel', onWheel)
      observer.disconnect()
    }
  }, [syncEdges])

  const page = useCallback((direction: 1 | -1) => {
    const el = stripRef.current
    if (el === null) return
    el.scrollBy({ left: direction * el.clientWidth, behavior: 'smooth' })
  }, [])

  /**
   * 拖拽。用指针事件而不是鼠标事件：指针事件一套代码同时覆盖鼠标、触控笔与触屏，
   * 而鼠标事件在触屏上要靠浏览器合成的兼容事件，那条路径在拖动时容易被滚动抢走。
   *
   * 位移记在 ref 而不是 state：`pointermove` 每帧都会触发，走 state 会让整条列表
   * 每帧重渲染一次，而它只是用来算滚动量的一个临时值。
   */
  const dragRef = useRef<{ startX: number; startScroll: number } | null>(null)

  return (
    <section>
      <div className="mb-5 flex items-baseline gap-2.5">
        <h2 className="text-xl leading-7 font-medium">案例展示</h2>
        <span className="text-sm text-muted-foreground">按品类查看已交付方案</span>
        {/* 「全部品类」在原型里是一个 `href="#"` 的静态入口，本项目尚无对应页面，
            因此保持渲染、不接跳转 —— 与头像菜单里的「收藏 / 帮助中心」同一条处理。 */}
        <span className="ml-auto flex items-center gap-1 text-sm text-muted-foreground">
          全部品类
          <ArrowRight className="size-3.5" />
        </span>
      </div>

      <div className="relative">
        {!atStart && (
          <button
            type="button"
            onClick={() => page(-1)}
            aria-label="上一页"
            className="absolute left-[13px] z-[2] grid size-10 place-items-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_62%,transparent)] text-background transition-colors hover:bg-foreground"
            style={{ top: 'calc((100% - 32px) / 2 - 20px)' }}
          >
            <ArrowLeft className="size-5" />
          </button>
        )}
        {!atEnd && (
          <button
            type="button"
            onClick={() => page(1)}
            aria-label="下一页"
            className="absolute right-[13px] z-[2] grid size-10 place-items-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_62%,transparent)] text-background transition-colors hover:bg-foreground"
            style={{ top: 'calc((100% - 32px) / 2 - 20px)' }}
          >
            <ArrowRight className="size-5" />
          </button>
        )}

        <div
          ref={stripRef}
          role="region"
          aria-label="案例展示，横向滚动，可用左右方向键翻页"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft') {
              event.preventDefault()
              page(-1)
            }
            if (event.key === 'ArrowRight') {
              event.preventDefault()
              page(1)
            }
          }}
          onPointerDown={(event) => {
            // 只认主键：右键与中键按下时不该进入拖拽态。
            if (event.button !== 0) return
            const el = stripRef.current
            if (el === null) return
            dragRef.current = { startX: event.clientX, startScroll: el.scrollLeft }
            setDragging(true)
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            const el = stripRef.current
            if (drag === null || el === null) return
            el.scrollLeft = drag.startScroll - (event.clientX - drag.startX)
          }}
          onPointerUp={() => {
            dragRef.current = null
            setDragging(false)
          }}
          onPointerCancel={() => {
            dragRef.current = null
            setDragging(false)
          }}
          className={[
            'flex gap-4 overflow-x-auto overflow-y-hidden outline-none',
            '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
            dragging ? 'cursor-grabbing select-none' : 'cursor-grab',
            'focus-visible:rounded-2xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring',
          ].join(' ')}
        >
          {CATEGORIES.map((name) => (
            <div
              key={name}
              className="flex min-w-0 shrink-0 basis-[calc((100%_-_48px)/4)] flex-col"
            >
              <div className="flex aspect-[400/234] w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-border bg-[color-mix(in_srgb,var(--m-neutral)_4%,var(--card))]">
                <span className="grid size-10 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--m-neutral)_var(--wash),var(--card))] text-m-neutral">
                  <ImageIcon className="size-5" />
                </span>
                <span className="text-sm text-muted-foreground-weak">封面待补</span>
              </div>
              <div className="mt-2 h-6 text-center text-base leading-6 font-medium">{name}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
