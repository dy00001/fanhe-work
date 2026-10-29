import { ArrowLeft, ArrowRight } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { CASE_CATEGORIES, type CaseCategory } from '../../lib/case-catalog'
import { Dialog, DialogTrigger } from '../ui/dialog'
import { CaseCover } from './CaseCover'
import { CaseGalleryDialogContent } from './CaseGalleryDialog'
import { CaseLibraryDialog } from './CaseLibraryDialog'

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
 *
 * **「全部品类」是一个按钮。** 原型里它写的是 `href="#"`，落地时保持成静态文字，于是
 * 首页最像入口的元素反而点不动。现在它打开 {@link CaseGalleryDialogContent}：把十三个
 * 品类一次性铺开，与主页横滑条共用同一份封面组件与同一份数据；首页这条横滑条仍然只负责
 * 「先看四个」。
 *
 * **卡片本身也是按钮，点开 {@link CaseLibraryDialog} 看该品类的图集。** 上一条只解决了
 * 「有封面」，界面因此从「一看就知道没内容」变成「看起来能用但点不动」——后者更糟。
 */
export function CaseGallery() {
  const stripRef = useRef<HTMLDivElement>(null)
  const [atStart, setAtStart] = useState(true)
  const [atEnd, setAtEnd] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [allCategoriesOpen, setAllCategoriesOpen] = useState(false)
  /**
   * 图集窗口的状态：既是「哪张图集」，也是「开没开」。
   *
   * 两者放在同一个对象里，是为了关闭时能留住品类 —— 关掉之后 Radix 还要播 200ms 的
   * 退场动画，这期间内容层仍然挂着；若此刻把品类清空，退场那一帧会闪成品类 1 的图。
   * 单独存 `id` 再配一个 `open` 布尔，就会出现「id 已清空但还在播动画」的中间态。
   *
   * 存的是 `CaseCategory` 对象本身而不是 id：`CASE_CATEGORIES` 是模块级常量，引用稳定，
   * 不像每次渲染新建的对象那样会让弹窗跟着重挂。
   */
  const [album, setAlbum] = useState<{ category: CaseCategory; open: boolean } | null>(null)

  const openAlbum = useCallback((categoryId: string) => {
    const category = CASE_CATEGORIES.find((item) => item.id === categoryId)
    if (category === undefined) return
    setAlbum({ category, open: true })
  }, [])

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
  /**
   * 这一次按下有没有真的拖动过。
   *
   * 卡片现在是按钮，而整条又是可拖拽的。若不区分，用户按住拖动松手时浏览器照样会补一个
   * `click`，表现成「我只是想滑一下，结果弹出了图集」。阈值取 4px：小于这个数的手抖
   * 仍算点击。在 `pointerdown` 时复位，所以拖到卡片外松手也不会让下一次点击失效。
   */
  const draggedRef = useRef(false)

  return (
    // `Dialog.Root` 不产出 DOM，包住整个区块不会改变任何布局；把根放在这一层是为了
    // 让头部的入口按钮能作为 `DialogTrigger`，与窗口内容共享同一个上下文。
    <Dialog open={allCategoriesOpen} onOpenChange={setAllCategoriesOpen}>
      <section>
        <div className="mb-5 flex items-baseline gap-2.5">
          <h2 className="text-xl leading-7 font-medium">案例展示</h2>
          <span className="text-sm text-muted-foreground">按品类查看已交付方案</span>
          {/* 入口本身。用 `DialogTrigger` 而不是自己写 `aria-haspopup`：它同时负责
              打开时把 `aria-expanded` / `aria-controls` 挂到按钮上，以及关闭时把焦点
              还给按钮 —— 后者手写不出来，Radix 是在关闭动画结束后自己调的。 */}
          <DialogTrigger asChild>
            <button
              type="button"
              className="group -mx-1.5 ml-auto flex items-center gap-1 rounded-md px-1.5 text-sm text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              全部品类
              {/* 箭头在悬停时右移 2px：这一条是本区块唯一的「点得动」暗示，静态文字没有
                  下划线也没有背景，只靠颜色变化在小字号上不够明显。 */}
              <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
          </DialogTrigger>
        </div>

        <CaseGalleryDialogContent onOpenCategory={openAlbum} />

        <div className="relative">
          {!atStart && (
            <button
              type="button"
              onClick={() => page(-1)}
              aria-label="上一页"
              className="absolute left-[13px] z-[2] grid size-10 place-items-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_62%,transparent)] text-background hover:bg-foreground"
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
              className="absolute right-[13px] z-[2] grid size-10 place-items-center rounded-full bg-[color-mix(in_srgb,var(--foreground)_62%,transparent)] text-background hover:bg-foreground"
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
              draggedRef.current = false
              setDragging(true)
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current
              const el = stripRef.current
              if (drag === null || el === null) return
              if (Math.abs(event.clientX - drag.startX) > 4) draggedRef.current = true
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
            {CASE_CATEGORIES.map((category) => (
              <button
                key={category.id}
                type="button"
                onClick={() => {
                  if (draggedRef.current) {
                    draggedRef.current = false
                    return
                  }
                  openAlbum(category.id)
                }}
                aria-label={`查看${category.name}案例`}
                className={[
                  'group flex min-w-0 shrink-0 basis-[calc((100%_-_48px)/4)] flex-col rounded-2xl text-left outline-none',
                  'focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring',
                  // 悬停时图片微放大。这是「这张卡点得动」的唯一视觉暗示：静态图没有
                  // 下划线可加，只靠光标变化在小屏上完全看不出来。
                  '[&_img]:transition-transform [&_img]:duration-300 hover:[&_img]:scale-[1.03]',
                ].join(' ')}
              >
                <CaseCover category={category} />
                <div className="mt-2 h-6 text-center text-base leading-6 font-medium">
                  {category.name}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 图集窗口与「全部品类」是两个独立的根，两者可以叠着开：从全部品类里点一张卡，
            图集压在上面，关掉图集回到全部品类。Radix 的滚动锁是计数式的，两层叠开不会
            互相把对方的锁放掉。 */}
        {album !== null && (
          <CaseLibraryDialog
            category={album.category}
            open={album.open}
            onOpenChange={(next) => {
              if (next) return
              // 只关不放：品类留着，等退场动画播完。下一轮打开会整体覆盖这个对象。
              setAlbum((previous) => (previous === null ? null : { ...previous, open: false }))
            }}
          />
        )}
      </section>
    </Dialog>
  )
}
