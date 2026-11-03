import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  Maximize2,
  Minimize2,
  RotateCcw,
  RotateCcwSquare,
  RotateCwSquare,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from 'react'

import {
  constrainLightboxView,
  distanceBetween,
  formatLightboxZoom,
  isLightboxReset,
  isQuarterTurned,
  LIGHTBOX_DRAG_THRESHOLD,
  LIGHTBOX_IDENTITY,
  LIGHTBOX_SCALE_MIN,
  lightboxFitLimit,
  lightboxVisualSize,
  pinchLightboxScale,
  rotateLightbox,
  wheelLightboxScale,
  zoomLightbox,
  type LightboxRotation,
  type LightboxSize,
  type LightboxView,
} from '../../lib/case-lightbox-view'
import { cn } from '../../lib/utils'
import type { CaseAlbumItem } from '../../lib/case-library-display'

type Phase = 'loading' | 'ready' | 'failed'

type DragState = {
  pointerId: number
  startX: number
  startY: number
  /** 按下时的偏移。拖动过程以它为基准加位移，避免逐帧累加产生漂移。 */
  originX: number
  originY: number
  moved: boolean
}

/**
 * 放大查看。**两级视图，共用同一套缩放状态。**
 *
 *   1. 层内（默认）：覆盖在品类弹窗内容层之上。滚轮缩放、拖动平移、点图片进全屏。
 *   2. 全屏：铺满视口，并在浏览器允许时收起它自己的地址栏。
 *
 * **全屏不另起组件、也不换 portal 容器。** 换容器等于换 React 树的挂载点，子树会被
 * 卸载重挂，图片要重新解码、重新布局，用户看到的就是一次白闪。这里全屏只改两条
 * className 加一层内联样式，`<img>` 始终是同一个节点，切换因此没有中间帧。代价是
 * 撑满要靠父层把 `DialogContent` 一起放大（`immersive` 由父层持有，见调用处）。
 *
 * **Esc 必须被这里截住。** Radix 在内容层上听 Escape 来关闭弹窗，而用户此刻的意图是
 * 「退一级」：全屏 → 层内 → 关掉。因此在 window 的捕获阶段拦下来并 `stopPropagation`
 * —— 捕获阶段在 document 的冒泡监听之前跑，事件走不到 Radix 那里。用 React 的
 * `onKeyDown` 做不到这一点：那需要焦点正好在放大层里面，而刚点开时焦点还在被点的
 * 缩略图上。
 */
export function CaseLightbox({
  items,
  index,
  immersive,
  onImmersiveChange,
  onClose,
  onStep,
}: {
  items: readonly CaseAlbumItem[]
  index: number
  /** 是否全屏。由父层持有，因为要一起放大的是弹窗，不是这一层。 */
  immersive: boolean
  onImmersiveChange: (immersive: boolean) => void
  onClose: () => void
  onStep: (delta: 1 | -1) => void
}) {
  const many = items.length > 1
  const current = items[index]
  const currentId = current?.id ?? null

  const stageRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  /**
   * 旋转角度，**按图片记账**。
   *
   * 与下面 `scene` 同一种写法：存的是「哪一张图转了多少度」，切到别的图时读出来的自然
   * 是 0（新图没有这条账）。改用 effect 复位的话，会在画完一帧之后再渲染一次，正好
   * 是一次可见的闪动；而这里不需要任何复位动作。
   *
   * 角度归一在 `[0, 360)`，只留四个方向。旋转是纯视图状态 —— 不写回任何数据、不重新
   * 上传，所以「原图」永远是原图。
   */
  const [rotationScene, setRotationScene] = useState<{ id: string | null; deg: LightboxRotation }>({
    id: null,
    deg: 0,
  })
  const rotation = rotationScene.id === currentId ? rotationScene.deg : 0
  /** 旋转 90°/270° 时宽高互换，下面几处计算都要用这个判断。 */
  const quarterTurned = isQuarterTurned(rotation)

  /**
   * 「哪一次的缩放」。换图、进出全屏、**旋转**都要回到适配尺寸，但**不能用 effect 去
   * setState** 复位 —— 那会在画完一帧之后再来一次渲染，正好是「闪一下」的来源。改成把
   * 场景 key 与视图一起存：key 对不上时读出来的就是初始值，等下一次真正缩放时一并写正。
   *
   * 旋转要进这个 key：转 90° 之后适配基准的宽高互换，沿用旧的倍率会让刚转过来的图立刻
   * 溢出舞台（视觉上像被裁了一半）。回到适配是唯一确定的构图。
   */
  const sceneKey = `${currentId ?? ''}:${immersive ? 'fullscreen' : 'inline'}:${rotation}`
  const [scene, setScene] = useState<{ key: string; view: LightboxView }>(() => ({
    key: sceneKey,
    view: LIGHTBOX_IDENTITY,
  }))
  /** 与 `scene` 同源。挂在 window 上的原生监听读不到最新的 state，只能读 ref。 */
  const sceneRef = useRef(scene)
  const view = scene.key === sceneKey ? scene.view : LIGHTBOX_IDENTITY

  const [dragging, setDragging] = useState(false)

  /** 原生全屏是不是我们自己请求的。只有自己请求的才由自己退出，别去动别人的全屏。 */
  const requestedFullscreenRef = useRef(false)

  const dragRef = useRef<DragState | null>(null)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ distance: number; scale: number } | null>(null)
  /**
   * 「拖动结束后那一次 click 不算点击」的截止时间。
   *
   * 用时间窗而不是布尔标记：`pointerup` 与随后的 `click` 谁先谁后没有可依赖的保证，
   * 标记若被 `pointerup` 立刻清掉，`click` 就可能漏网 —— 表现为「拖完手一松，图突然
   * 进了全屏」。
   */
  const suppressClickUntilRef = useRef(0)

  /**
   * 舞台的布局尺寸。
   *
   * 平时它是 `100%`（图片自己不超出舞台）。**旋转 90° 时必须知道具体数字**：转过来
   * 之后图片的视觉宽高互换，若仍按「不超过舞台的宽 / 不超过舞台的高」限制未旋转的盒子，
   * 一张 4:3 的横图会变得比舞台还高，下缘被 `overflow-hidden` 裁掉。
   *
   * 由下面那个 `ResizeObserver` 维护（它本来就在观察舞台）。只在数字真的变了时换引用，
   * 否则每次 reflow 都会多一次重渲染。
   */
  const [stageBox, setStageBox] = useState<LightboxSize>({ width: 0, height: 0 })

  /**
   * 量一次当前几何。**图片用 `offsetWidth/offsetHeight`**：它们是布局尺寸，不受
   * `transform: scale()` 影响，正好是「适配尺寸」，与 `scale = 1` 的定义对齐。
   * `getBoundingClientRect()` 会把缩放算进去，用它就成了自己缩自己的死循环。
   *
   * **旋转 90° 时把宽高换过来**：`offsetWidth/Height` 量的是未旋转的盒子，而夹取偏移、
   * 计算适配比例都只关心「屏幕上占多大」。换过来之后，`scale = 1` 仍然等于「刚好装进
   * 舞台」，滚轮缩放的手感与不旋转时一致。
   */
  const measure = useCallback((): { content: LightboxSize; stage: LightboxSize } => {
    const stage = stageRef.current
    const image = imgRef.current
    return {
      stage: { width: stage?.clientWidth ?? 0, height: stage?.clientHeight ?? 0 },
      // 视觉尺寸：转 90° 时宽高互换。见 `lightboxVisualSize` 的注释。
      content: lightboxVisualSize(
        { width: image?.offsetWidth ?? 0, height: image?.offsetHeight ?? 0 },
        rotation,
      ),
    }
  }, [rotation])

  /** 读当前视图。场景已经换了的时候，正确答案是初始值而不是上一个场景的残留。 */
  const readView = useCallback(
    () => (sceneRef.current.key === sceneKey ? sceneRef.current.view : LIGHTBOX_IDENTITY),
    [sceneKey],
  )

  const applyView = useCallback(
    (next: LightboxView) => {
      const { content, stage } = measure()
      const constrained = constrainLightboxView(next, content, stage)
      const previous = readView()
      // 值没变就不 setState。滚轮滚到上下限、拖动被夹在边缘时都会走到这里，
      // 那些帧本来就不该触发重渲染。
      if (
        previous.scale === constrained.scale &&
        previous.x === constrained.x &&
        previous.y === constrained.y
      ) {
        return
      }
      const nextScene = { key: sceneKey, view: constrained }
      sceneRef.current = nextScene
      setScene(nextScene)
    },
    [measure, readView, sceneKey],
  )

  /** 把当前的偏移重新夹一次。图片尺寸到位、或舞台尺寸变了之后都要走一遍。 */
  const reflow = useCallback(() => {
    const { content, stage } = measure()
    applyView(constrainLightboxView(readView(), content, stage))
  }, [applyView, measure, readView])

  const resetView = useCallback(() => {
    const { content, stage } = measure()
    applyView(constrainLightboxView(LIGHTBOX_IDENTITY, content, stage))
  }, [applyView, measure])

  /** 指针位置 → 相对舞台中心的偏移。缩放锚点与捏合锚点都用它。 */
  const anchorOf = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current
    if (stage === null) return { x: 0, y: 0 }
    const rect = stage.getBoundingClientRect()
    return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) }
  }, [])

  const enterImmersive = useCallback(() => {
    if (immersive) return
    onImmersiveChange(true)
    /**
     * 原生全屏只负责「把浏览器地址栏也收起来」这一件事，是锦上添花。
     *
     * 它可能失败：iOS 的 Safari 不支持元素全屏、请求不满足用户手势要求、被策略禁用。
     * 失败时父层那套「弹窗撑满视口」依然成立，所以这里静默忽略，不做任何提示 ——
     * 用户看到的画面是满的，没有需要他处理的问题。
     */
    const root = document.documentElement
    if (typeof root.requestFullscreen !== 'function' || document.fullscreenElement !== null) return
    requestedFullscreenRef.current = true
    void root.requestFullscreen().catch(() => {
      requestedFullscreenRef.current = false
    })
  }, [immersive, onImmersiveChange])

  const exitImmersive = useCallback(() => {
    if (!immersive) return
    onImmersiveChange(false)
    if (requestedFullscreenRef.current && document.fullscreenElement !== null) {
      requestedFullscreenRef.current = false
      void document.exitFullscreen().catch(() => {})
    }
  }, [immersive, onImmersiveChange])

  const toggleImmersive = useCallback(() => {
    if (immersive) exitImmersive()
    else enterImmersive()
  }, [enterImmersive, exitImmersive, immersive])

  /**
   * 旋转。左旋 -90、右旋 +90。
   *
   * **只改视图，不动图片本身。** `<img>` 的字节、`src`、以及上传时入库的那一份都不受
   * 影响 —— 旋转后关掉弹窗再打开、或把它移到别的文件夹，看到的仍是原来那张图。
   *
   * 角度归一在 `[0, 360)`：它要进 `sceneKey`，点多了之后让一个四位数一路带着没有意义。
   * 读 `previous` 时先看 id 对不对得上 —— 切到新图之后紧接着点旋转，基线必须是 0 而
   * 不是上一张图的角度。
   */
  const rotate = useCallback(
    (delta: -90 | 90) => {
      setRotationScene((previous) => {
        const base = previous.id === currentId ? previous.deg : 0
        return { id: currentId, deg: rotateLightbox(base, delta) }
      })
    },
    [currentId],
  )

  /**
   * 旋转 90° 时的适配约束。
   *
   * 未旋转的盒子要按「宽 ≤ 舞台的高、高 ≤ 舞台的宽」来限，转过来才刚好装下 —— 两者
   * 正好是默认 `max-w-full / max-h-full` 的反向。0° 与 180° 的宽高关系不变，用回默认值。
   *
   * 舞台还没量出来时（首帧）回落成 `100%`：那一个瞬间的构图可能略大，但 `overflow-hidden`
   * 兜住，下一帧就正了。
   */
  const fitLimit = lightboxFitLimit(stageBox, rotation)
  const rotateFit: CSSProperties = quarterTurned
    ? {
        maxWidth: fitLimit.width > 0 ? `${fitLimit.width}px` : '100%',
        maxHeight: fitLimit.height > 0 ? `${fitLimit.height}px` : '100%',
      }
    : {}

  /**
   * 浏览器那头退全屏（Esc、F11、手势）时把我们的状态跟上，否则界面与事实不一致。
   *
   * 只退到「层内查看」，不直接关掉整个放大层：一次 Esc 退一级，与系统看图工具一致。
   */
  useEffect(() => {
    const onChange = () => {
      if (document.fullscreenElement !== null || !immersive) return
      requestedFullscreenRef.current = false
      onImmersiveChange(false)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
    }
  }, [immersive, onImmersiveChange])

  /** 卸载时若还寄在原生全屏里，必须退出 —— 否则整个应用留在全屏，用户找不到出口。 */
  useLayoutEffect(() => {
    return () => {
      if (requestedFullscreenRef.current && document.fullscreenElement !== null) {
        void document.exitFullscreen().catch(() => {})
      }
    }
  }, [])

  /**
   * 滚轮缩放。**必须用原生监听 + `passive: false`。**
   *
   * React 的 `onWheel` 走的是根节点上的被动监听，`preventDefault()` 不生效并且只会打一条
   * 警告。不拦住默认行为时，滚动会沿着可滚动祖先一路传上去，表现为「图片在放大，下面的
   * 网格同时也在滚」，关掉放大层后会发现列表已经换了位置。
   */
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const { content, stage: stageSize } = measure()
      applyView(
        zoomLightbox(
          readView(),
          wheelLightboxScale(readView().scale, event.deltaY),
          anchorOf(event.clientX, event.clientY),
          content,
          stageSize,
        ),
      )
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      stage.removeEventListener('wheel', onWheel)
    }
  }, [anchorOf, applyView, currentId, measure, readView])

  /**
   * 指针移动到 window 上而不是舞台上。
   *
   * `setPointerCapture` 能少挂两个监听，但它会把后续鼠标事件的 target 改成捕获元素，
   * 点击图片再也命中不到 `<img>`，而「点图片进全屏」正是靠这个命中的。挂在 window 上
   * 一样能跟手（指针移出舞台时也收得到），且不改变命中的目标。
   */
  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const pointers = pointersRef.current
      if (pointers.size === 0) return
      if (pointers.has(event.pointerId)) {
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      }

      // 双指优先：两指都按着的时候没有「拖动」这回事，否则手指稍微不同步就会让图乱窜。
      const pinch = pinchRef.current
      if (pinch !== null && pointers.size >= 2) {
        const [first, second] = Array.from(pointers.values())
        if (first === undefined || second === undefined) return
        const { content, stage } = measure()
        applyView(
          zoomLightbox(
            readView(),
            pinchLightboxScale(pinch.scale, pinch.distance, distanceBetween(first, second)),
            anchorOf((first.x + second.x) / 2, (first.y + second.y) / 2),
            content,
            stage,
          ),
        )
        return
      }

      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      const dx = event.clientX - drag.startX
      const dy = event.clientY - drag.startY
      if (!drag.moved) {
        if (Math.hypot(dx, dy) < LIGHTBOX_DRAG_THRESHOLD) return
        drag.moved = true
        setDragging(true)
      }
      applyView({ scale: readView().scale, x: drag.originX + dx, y: drag.originY + dy })
    }

    const onUp = (event: PointerEvent) => {
      pointersRef.current.delete(event.pointerId)
      if (pointersRef.current.size < 2) pinchRef.current = null
      const drag = dragRef.current
      if (drag === null || drag.pointerId !== event.pointerId) return
      dragRef.current = null
      setDragging(false)
      // 拖动结束的那次 click 不该被当成点击。见 `suppressClickUntilRef` 上方的说明。
      if (drag.moved) suppressClickUntilRef.current = performance.now() + 300
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [anchorOf, applyView, measure, readView])

  /**
   * 舞台尺寸变了（拖窗口、进出全屏、旋转屏幕）要把偏移重新夹一次。
   * 不夹的话放大后的图片会有一半留在可视区之外，而且拖不回来。
   *
   * 顺手把尺寸记进 `stageBox`：旋转 90° 时那张图的 `max-width/max-height` 要按它来
   * 算。只在数字真的变了时更新，否则每一帧 resize 都会多一次重渲染。
   */
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const observer = new ResizeObserver(() => {
      const next = { width: stage.clientWidth, height: stage.clientHeight }
      setStageBox((previous) =>
        previous.width === next.width && previous.height === next.height ? previous : next,
      )
      reflow()
    })
    observer.observe(stage)
    return () => {
      observer.disconnect()
    }
  }, [reflow])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        // 一次退一级：先进全屏的人按 Esc 想退的是全屏，不是整张图。
        if (immersive) {
          exitImmersive()
          return
        }
        onClose()
        return
      }
      if (!many) return
      if (event.key === 'ArrowLeft') {
        event.stopPropagation()
        onStep(-1)
      }
      if (event.key === 'ArrowRight') {
        event.stopPropagation()
        onStep(1)
      }
    }
    // 捕获阶段：见上面那段注释，晚一步就抢不过 Radix 的关闭逻辑。
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
    }
  }, [exitImmersive, immersive, many, onClose, onStep])

  if (current === undefined) return null

  /** 拖动刚结束的那一次 click 直接吃掉：既不进全屏，也不退出放大层。 */
  function consumeSuppressedClick(): boolean {
    if (performance.now() >= suppressClickUntilRef.current) return false
    suppressClickUntilRef.current = 0
    return true
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    // 只认主键。右键要留给系统菜单，中键留给「新标签打开」，都不该启动拖动。
    if (event.button !== 0) return
    const pointers = pointersRef.current
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.size === 2) {
      const [first, second] = Array.from(pointers.values())
      if (first !== undefined && second !== undefined) {
        pinchRef.current = {
          distance: distanceBetween(first, second),
          scale: readView().scale,
        }
      }
      // 第二根手指落下，先前那次单指拖动作废：否则捏合的同时还会带着一段平移。
      dragRef.current = null
      setDragging(false)
      return
    }
    if (pointers.size > 2) return

    const base = readView()
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: base.x,
      originY: base.y,
      moved: false,
    }
  }

  /** 点击绘图区（非图片）。层内退到网格，全屏退到层内。 */
  function handleSurfaceClick(event: ReactMouseEvent<HTMLDivElement>): void {
    if (consumeSuppressedClick()) return
    // 图片有它自己的点击语义，交给 `handleImageClick`，别在这里重复处理。
    if (event.target === imgRef.current) return
    if (immersive) {
      exitImmersive()
      return
    }
    onClose()
  }

  function handleImageClick(): void {
    if (consumeSuppressedClick()) return
    // 全屏里点图片不做任何事：那里最大的命中区就是图片本身，点一下就把视图退掉
    // 会让「放大看细节」变成一件危险的事。
    if (immersive) return
    enterImmersive()
  }

  return (
    <div
      onClick={handleSurfaceClick}
      // `overflow-hidden` 是兜底：放大后的图片会超出舞台，这里再裁一刀，保证任何没预料到
      // 的子元素都不会顶出弹窗被视口切掉（那正是之前的故障形态）。
      className={cn(
        'absolute inset-0 z-20 flex flex-col overflow-hidden select-none',
        'bg-[color-mix(in_srgb,var(--foreground)_82%,transparent)] backdrop-blur-sm',
        immersive ? 'p-2' : 'p-4',
      )}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-2 pb-2 text-xs text-background/80">
        <span className="tabular-nums">{many ? `${index + 1} / ${items.length}` : '共 1 张'}</span>
        {/* 提示文案随视图切换：进了全屏还写「点击图片全屏」就是错的。 */}
        <span className="hidden truncate sm:inline">
          {immersive ? '滚轮缩放 · 拖动平移 · Esc 退出全屏' : '滚轮缩放 · 拖动平移 · 点击图片全屏'}
        </span>
        <div className="flex items-center gap-1">
          {/* 旋转。放在最左边、与缩放百分比分开：它改的是「图的朝向」，不是「看多大」，
              两者挨在一起会让人以为它们是一组。 */}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              rotate(-90)
            }}
            aria-label="向左旋转 90 度"
            title="向左旋转"
            className="grid size-8 place-items-center rounded-full hover:bg-background/15 hover:text-background"
          >
            <RotateCcwSquare className="size-4" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              rotate(90)
            }}
            aria-label="向右旋转 90 度"
            title="向右旋转"
            className="grid size-8 place-items-center rounded-full hover:bg-background/15 hover:text-background"
          >
            <RotateCwSquare className="size-4" />
          </button>
          <button
            type="button"
            disabled={isLightboxReset(view)}
            onClick={(event) => {
              event.stopPropagation()
              resetView()
            }}
            aria-label="还原为适配大小"
            title="还原为适配大小"
            className="flex h-8 items-center gap-1 rounded-full px-2 tabular-nums hover:bg-background/15 hover:text-background disabled:opacity-50"
          >
            <RotateCcw className="size-3.5" />
            {formatLightboxZoom(view.scale)}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              toggleImmersive()
            }}
            aria-label={immersive ? '退出全屏' : '全屏查看'}
            title={immersive ? '退出全屏（Esc）' : '全屏查看'}
            className="grid size-8 place-items-center rounded-full hover:bg-background/15 hover:text-background"
          >
            {immersive ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onClose()
            }}
            aria-label="返回图集"
            title="返回图集（Esc）"
            className="grid size-8 place-items-center rounded-full hover:bg-background/15 hover:text-background"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        onPointerDown={handlePointerDown}
        // `touch-action: none` 必须给：不给的话移动端会把双指捏合解释成「缩放整个页面」，
        // 图片自己收不到这组手势，用户只会看到浏览器在缩放界面。
        style={{ touchAction: 'none' }}
        className={cn(
          'relative flex min-h-0 flex-1 items-center justify-center overflow-hidden',
          view.scale > LIGHTBOX_SCALE_MIN
            ? dragging
              ? 'cursor-grabbing'
              : 'cursor-grab'
            : 'cursor-zoom-in',
        )}
      >
        {/* `key` 按图片 id 换：加载态记在子组件里，不 key 的话切到下一张时上一张的
            「已加载」会留在状态里，新图没到也显示成加载完成。 */}
        <LightboxImage
          key={currentId ?? 'lightbox'}
          imgRef={imgRef}
          src={current.src}
          alt={current.alt}
          view={view}
          rotation={rotation}
          rotateFit={rotateFit}
          dragging={dragging}
          onClick={handleImageClick}
          onReady={reflow}
        />
      </div>

      {many && (
        <>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onStep(-1)
            }}
            aria-label="上一张"
            className="absolute top-1/2 left-4 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-background/20 text-background hover:bg-background/35"
          >
            <ChevronLeft className="size-5" />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation()
              onStep(1)
            }}
            aria-label="下一张"
            className="absolute top-1/2 right-4 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-background/20 text-background hover:bg-background/35"
          >
            <ChevronRight className="size-5" />
          </button>
        </>
      )}
    </div>
  )
}

/**
 * 原图。**按需加载**：只有用户点开这一张，才发出这一次请求。
 *
 * 三种状态都要有画面，缺一个就会出现「点了没反应」：
 *   - 加载中：转圈 + 一句「正在加载原图」。原图走网络，跨隧道时要几百毫秒。
 *   - 失败：一句话 + 重试按钮。这条路径一定会被遇到（地铁里、隧道掉线），
 *     而它现在的表现是空白一片 —— 用户会以为图坏了，实际只是没下下来。
 *   - 成功：图片本身。
 *
 * 只有图片本体吃点击（进全屏）。加载与失败两态下点击穿透到外层，也就是「点一下退出」，
 * 与旧交互一致。
 */
function LightboxImage({
  imgRef,
  src,
  alt,
  view,
  rotation,
  rotateFit,
  dragging,
  onClick,
  onReady,
}: {
  imgRef: RefObject<HTMLImageElement | null>
  src: string
  alt: string
  view: LightboxView
  /** 顺时针角度，只可能是 0 / 90 / 180 / 270。 */
  rotation: LightboxRotation
  /** 旋转 90°/270° 时的适配约束（宽高互换后的上限）。 */
  rotateFit: CSSProperties
  dragging: boolean
  onClick: () => void
  onReady: () => void
}) {
  const [phase, setPhase] = useState<Phase>('loading')
  /** 重试计数。它进 `key`，强制浏览器重新发起一次请求，绕开失败的缓存条目。 */
  const [attempt, setAttempt] = useState(0)

  return (
    <>
      <img
        key={attempt}
        ref={imgRef}
        src={src}
        alt={alt}
        draggable={false}
        decoding="async"
        onLoad={() => {
          setPhase('ready')
          // 尺寸在这一刻才成立，父层据此重新夹一次偏移。
          onReady()
        }}
        onError={() => {
          setPhase('failed')
        }}
        onClick={onClick}
        style={{
          // 旋转放在最右边：CSS 的变换函数从右往左应用，因此这里是「先把图转正、再按
          // 倍率缩放、最后平移」—— 偏移量的坐标系因此永远是「已旋转后的画面」，与
          // `measure()` 交换宽高的口径一致。反过来写会让放大后的拖动方向跟着转 90°。
          transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale}) rotate(${rotation}deg)`,
          // 旋转 90° 时用交换后的上限，否则转过来的图会比舞台高一截、下缘被裁掉。
          ...rotateFit,
          // 拖动时必须关掉过渡，否则图片会「追着」指针走，手感像在拉橡皮筋。
          // 淡入单列一条：图解码完成后是从 `opacity-0` 变过来的，不能硬切。
          transition: dragging
            ? 'none'
            : 'transform 140ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease-out',
          willChange: 'transform',
        }}
        // `max-h-full max-w-full` 让这张图在适配状态下刚好装进舞台，`object-contain`
        // 保证不被裁掉比例。放大后靠 transform 溢出，由舞台的 `overflow-hidden` 裁剪。
        className={cn(
          'max-h-full w-auto max-w-full rounded-lg object-contain shadow-2xl',
          // 加载完成前不显示半张图：铺在深色背景上比转圈更迷惑。
          phase === 'ready' ? 'opacity-100' : 'opacity-0',
        )}
      />

      {phase !== 'ready' && (
        <div className="absolute inset-0 grid place-items-center">
          {phase === 'loading' ? (
            <div className="flex flex-col items-center gap-2 text-xs text-background/70">
              <Loader2 className="size-5 animate-spin" />
              正在加载原图
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-sm text-background/85">
              <span>原图加载失败，可能是网络不通</span>
              <button
                type="button"
                // 只有这个按钮拦冒泡。整层拦掉的话，用户就没法「点一下空白退出」了。
                onClick={(event) => {
                  event.stopPropagation()
                  setPhase('loading')
                  setAttempt((value) => value + 1)
                }}
                className="rounded-md border border-background/40 px-3 py-1.5 text-xs hover:bg-background/15"
              >
                重试
              </button>
            </div>
          )}
        </div>
      )}
    </>
  )
}
