import { X, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import {
  LIGHTBOX_IDENTITY,
  constrainLightboxView,
  formatLightboxZoom,
  wheelLightboxScale,
  zoomLightbox,
  type LightboxSize,
  type LightboxView,
} from '../../lib/case-lightbox-view'

/**
 * 商品图灯箱。
 *
 * ## 为什么不重写缩放几何
 *
 * 以指针为锚点缩放、「图片边缘不离开舞台」、滚轮与捏合落在同一条曲线上 —— 这三条
 * 规则已经在 `case-lightbox-view.ts` 里被断言过。抄一份新的就等于把那些断言一起
 * 复制一遍，而复制品不会跟着修。
 *
 * ## 初始尺寸为什么不是「适配窗口」
 *
 * 台账里的图本来就小：中位宽 339px，15 张不到 150px（最小 69×38）。纯「适配窗口」
 * 意味着这些小图按 1:1 显示 —— 用户报的「点开放大还是很小」正是这个。所以初始倍率
 * 取 `min(适配倍率, 4)`：大图按窗口装下，小图上采样到 4 倍（208×166 的图会显示成
 * 832×664）。
 *
 * **4 倍是「看得清结构」与「别糊成一团」的折中。** 再往上，69px 的图会被摊成几个
 * 巨大色块，看起来比小图更糟。要真正的高清只有一条路：在维护面板里重新上传。
 *
 * ## 为什么走 portal
 *
 * 首页那张卡是 `.mod-card`，它有 `overflow: hidden`。灯箱渲染在卡片内部时，超出的
 * 部分会被裁掉 —— 表现为「点开图只看到上半截」。这在这套界面上是第二次踩（上一次
 * 是案例库的弹窗），所以这里从一开始就挂到 `document.body`。
 */

/** 小图的上采样上限。见文件头。 */
const BASE_UPSCALE_MAX = 4

type QuoteLightboxProps = {
  open: boolean
  onClose: () => void
  /** 原图的 object URL。还没取到时传 null，灯箱显示一个「正在加载」。 */
  src: string | null
  /** 加载失败时的说明。 */
  failed?: boolean
  alt: string
  /** 原图像素尺寸。有了它才能在图片解码完成前算出正确的占位与初始倍率。 */
  natural: { width: number; height: number } | null
}

/**
 * 灯箱的对外入口。
 *
 * **它是一个只有一行分支的空壳，缩放与拖动全在 {@link QuoteLightboxView} 里。**
 * 这样写是为了让「每次打开都回到初始倍率」这件事由**挂载**完成，而不是由 effect 完成：
 * 关闭时内层卸载，下次打开是全新的 state。写成「组件常驻 + effect 里 `setView(初始)`」
 * 会撞 `react-hooks/set-state-in-effect`，而且那一版还有一个真的问题 —— effect 在
 * 提交之后才跑，打开的那一帧会先按上一次的缩放画一下再跳回去。
 *
 * 外层不调用任何 hook，所以这里的提前返回是安全的（hook 顺序不受影响）。
 */
export function QuoteLightbox(props: QuoteLightboxProps) {
  if (!props.open) return null
  return <QuoteLightboxView {...props} />
}

function QuoteLightboxView({
  onClose,
  src,
  failed,
  alt,
  natural,
}: Omit<QuoteLightboxProps, 'open'>) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [view, setView] = useState<LightboxView>(LIGHTBOX_IDENTITY)
  const [stage, setStage] = useState<LightboxSize>({ width: 0, height: 0 })
  const [loaded, setLoaded] = useState(false)

  // 舞台尺寸。用 ResizeObserver 而不是只监听 window：灯箱出现时浏览器窗口未必变，
  // 但侧栏折叠、滚动条消失都会改变可用宽度。
  useEffect(() => {
    const element = stageRef.current
    if (element === null) return
    const measure = (): void => {
      setStage({ width: element.clientWidth, height: element.clientHeight })
    }
    // 首次测量放在回调里（`ResizeObserver` 挂上会立刻回调一次），而不是在这里同步
    // 调一次 `measure()`：后者是 effect 体里直接 setState。
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  /** 适配倍率：把原图装进舞台，同时给小图一个上采样上限。 */
  const naturalWidth = natural?.width ?? 0
  const naturalHeight = natural?.height ?? 0
  const baseScale = ((): number => {
    if (naturalWidth <= 0 || naturalHeight <= 0 || stage.width <= 0 || stage.height <= 0) return 1
    const fit = Math.min(stage.width / naturalWidth, stage.height / naturalHeight)
    return Math.min(fit, BASE_UPSCALE_MAX)
  })()

  /**
   * 图片在舞台上的显示尺寸。
   *
   * **必须 `useMemo`。** 每次渲染新建一个对象会让下面 `applyScale` 的依赖每帧都变，
   * 而 `applyScale` 又是键盘监听那个 effect 的依赖 —— 结果就是每次渲染都摘挂一次
   * 全局 keydown 监听。行为上看不出来，但它是 `react-hooks/exhaustive-deps` 报的
   * 那一条，而那条报得对。
   */
  const content = useMemo<LightboxSize>(
    () => ({ width: naturalWidth * baseScale, height: naturalHeight * baseScale }),
    [naturalWidth, naturalHeight, baseScale],
  )

  const applyScale = useCallback(
    (nextScale: number, anchor?: { x: number; y: number }) => {
      setView((current) =>
        zoomLightbox(current, nextScale, anchor ?? { x: 0, y: 0 }, content, stage),
      )
    },
    [content, stage],
  )

  /**
   * 滚轮缩放。
   *
   * **不能写成 React 的 `onWheel`。** React 17 起把 `wheel` 注册成**被动**监听器
   * （`passive: true`），在回调里调 `preventDefault()` 只会得到一条控制台警告、
   * 阻止不了默认行为 —— 结果是「图没放大，底下的页面滚走了」，也就是用户说的
   * 「滚轮被底层接管」。必须自己用 `addEventListener(..., { passive: false })`。
   *
   * 用函数式 `setView` 读当前倍率，而不是把 `view.scale` 放进依赖：后者每缩放一次
   * 就要摘挂一次监听器。
   */
  const wheelZoom = useCallback(
    (deltaY: number, anchor: { x: number; y: number }) => {
      setView((current) =>
        zoomLightbox(current, wheelLightboxScale(current.scale, deltaY), anchor, content, stage),
      )
    },
    [content, stage],
  )

  useEffect(() => {
    const element = stageRef.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      // 非被动监听里这一句才真的生效：舞台不滚、页面也不滚。
      event.preventDefault()
      const rect = element.getBoundingClientRect()
      wheelZoom(event.deltaY, {
        x: event.clientX - rect.left - rect.width / 2,
        y: event.clientY - rect.top - rect.height / 2,
      })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
    }
  }, [wheelZoom])

  /**
   * 键盘。
   *
   * **挂在 `window` 的捕获阶段**，不是冒泡：灯箱是 portal 到 `body` 的，Radix 的
   * `Dialog` 在 `document` 上监听 Esc，冒泡阶段它先跑 —— 按一下 Esc 会连查价面板
   * 一起收掉。捕获阶段先于 document 冒泡，`stopPropagation()` 才拦得住。
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
        return
      }
      if (event.key === '+' || event.key === '=') applyScale(view.scale * 1.25)
      if (event.key === '-') applyScale(view.scale / 1.25)
      if (event.key === '0') setView(LIGHTBOX_IDENTITY)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onClose, applyScale, view.scale])

  // 拖动（鼠标 + 单指）。位移超过阈值才算拖动，否则当成点击背景关闭。
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)

  const scalePercent = Math.round(baseScale * view.scale * 100)
  const isActualSize = Math.abs(baseScale * view.scale - 1) < 0.01

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-black/88 backdrop-blur-sm"
      /* 这个标记是给外层 Dialog 看的：灯箱 portal 到 body，DOM 上在对话框**外面**，
         Radix 会把「点灯箱」判成「点了对话框外面」→ 连查价面板一起关掉（用户报的
         「点图片任意位置就回到首页」就是这个）。DialogContent 的 `onInteractOutside`
         靠它把这一片排除掉。 */
      data-quote-lightbox=""
      role="dialog"
      aria-modal="true"
      aria-label={`查看 ${alt}`}
    >
      <div className="flex items-center gap-2 px-4 py-3 text-sm text-white/80">
        <span className="min-w-0 flex-1 truncate">{alt}</span>
        <span className="tabular-nums">{formatLightboxZoom(baseScale * view.scale)}</span>
        <button
          type="button"
          onClick={() => applyScale(view.scale / 1.25)}
          aria-label="缩小"
          className="rounded-md p-1.5 hover:bg-white/15"
        >
          <ZoomOut className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => applyScale(view.scale * 1.25)}
          aria-label="放大"
          className="rounded-md p-1.5 hover:bg-white/15"
        >
          <ZoomIn className="size-4" />
        </button>
        {/* 「1:1」按**原像素**算，不是按适配尺寸。用户要的是「这张图到底多大」。 */}
        <button
          type="button"
          onClick={() => applyScale(1 / baseScale)}
          className={[
            'flex items-center gap-1 rounded-md px-2 py-1.5',
            isActualSize ? 'bg-white/20 text-white' : 'hover:bg-white/15',
          ].join(' ')}
          title="按原像素显示"
        >
          <Maximize2 className="size-4" />
          1:1
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="rounded-md p-1.5 hover:bg-white/15"
        >
          <X className="size-4" />
        </button>
      </div>

      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 touch-none overflow-hidden"
        onPointerDown={(event) => {
          dragRef.current = { x: event.clientX, y: event.clientY, moved: false }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current
          if (drag === null) return
          const dx = event.clientX - drag.x
          const dy = event.clientY - drag.y
          if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 3) return
          drag.moved = true
          drag.x = event.clientX
          drag.y = event.clientY
          setView((current) =>
            constrainLightboxView(
              { scale: current.scale, x: current.x + dx, y: current.y + dy },
              content,
              stage,
            ),
          )
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current
          dragRef.current = null
          event.currentTarget.releasePointerCapture(event.pointerId)
          // 没拖动 = 点在了背景上 = 关闭。图本身不关闭（用户可能只是点了一下想看清）。
          if (drag !== null && !drag.moved && event.target === event.currentTarget) onClose()
        }}
        onDoubleClick={() => setView(LIGHTBOX_IDENTITY)}
      >
        {src === null ? (
          <div className="grid h-full place-items-center text-sm text-white/60">
            {failed === true ? '这张图取不到，可能已被替换' : '正在加载原图…'}
          </div>
        ) : (
          <img
            src={src}
            alt={alt}
            draggable={false}
            onLoad={() => setLoaded(true)}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: natural?.width ?? undefined,
              height: natural?.height ?? undefined,
              // 位移与缩放一起走 transform：`left/top` 定中心，`translate` 做平移，
              // `scale` 做缩放。**不能用 max-width/max-height** —— 那只能缩小不能放大，
              // 而这张图要的正是放大。
              transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px)) scale(${baseScale * view.scale})`,
              transformOrigin: 'center center',
              imageRendering: 'auto',
              // 解码完成前先淡出，避免看到一张被拉伸的模糊帧。
              opacity: loaded ? 1 : 0,
              transition: 'opacity 120ms linear',
            }}
          />
        )}
      </div>

      <p className="px-4 py-2 text-center text-xs text-white/50">
        滚轮或双指缩放 · 拖动平移 · 双击复位
        {natural === null ? '' : ` · 原图 ${natural.width}×${natural.height}`}
        {scalePercent > 100 && natural !== null && baseScale * view.scale > BASE_UPSCALE_MAX
          ? ' · 已超过原像素'
          : ''}
      </p>
    </div>,
    document.body,
  )
}
