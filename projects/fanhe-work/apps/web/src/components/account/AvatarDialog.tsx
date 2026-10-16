import { ImageUp, RotateCcw, Trash2 } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'

import {
  MAX_ZOOM,
  createCropState,
  displaySize,
  drawAvatar,
  exportAvatarDataUrl,
  panBy,
  setZoom,
  type CropState,
  type Size,
} from '../../lib/avatar-crop'
import { type AvatarWriteResult } from '../../lib/avatar'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'

/**
 * 头像裁剪对话框。
 *
 * ## 它做什么
 *
 * 选一张本机图片 → 拖动 / 缩放把想要的部分对进圆形裁剪框 → 保存。预览用的几何与
 * 最终导出的几何是**同一份**（`lib/avatar-crop.ts` 的 `sourceRect`），所以「预览里
 * 什么样、存下来就是什么样」是结构性成立的，不是靠两边调参调到一致。
 *
 * ## 四个刻意的取舍
 *
 * - **预览画两个尺寸：96px 与 32px。** 32px 是头像在顶栏里的真实尺寸。只给一个大
 *   预览会让人把构图做得很细，存完之后在 32px 下糊成一团 —— 让人在保存前就看到它
 *   最终的样子，比事后解释「小图看不清是正常的」有用。
 * - **裁剪框是圆的，导出是方的。** 界面上头像容器是 `rounded-full`，圆的形状由容器
 *   裁；数据保持方形，将来换个展示形状不必重裁。圆框回答「你会看到什么」，方数据
 *   回答「我们存了什么」，两者不冲突。
 * - **重新打开时拿当前头像当底图**，而不是每次都要求重新选文件。用户最常见的诉求是
 *   「刚才那张再往上挪一点」，逼他重新找一遍文件是没必要的一步。
 * - **滚轮缩放挂的是原生非被动监听**（见下面的 effect），不用 `onWheel`。React 17 起
 *   `onWheel` 在根容器上是**被动**监听，里面调 `preventDefault()` 会被忽略并在控制台
 *   报警告 —— 症状是「缩放的同时页面跟着滚」。自己挂一个 `{ passive: false }` 的才是
 *   真的能拦住。
 *
 * ## 为什么把状态放进 `AvatarDialogBody` 而不是外层
 *
 * 外层 `AvatarDialog` 在 `open` 为假时不渲染 `Body`，于是**每次打开都是一次全新挂载**：
 * 所有 `useState` 初值重新跑一遍，等于「打开即复位」，不需要再在 effect 里 `setState`
 * 清状态（那种写法会撞 `react-hooks/set-state-in-effect`）。挂载时只跑一个装载底图的
 * 副作用（`load(current)`），`load` 内部的 `setState` 不在 effect 体里，规则不拦。
 *
 * ## 为什么不用 `inputKey` 那套
 *
 * 之前靠「每次打开换一个 file input 的 key」来让「选同一张图两次」能重新触发 `change`。
 * 现在直接在 `onFileChange` 末尾把 `fileRef.current.value` 清空：选完即重置，跨次、跨文件
 * 都能重新选，且对「同一文件选两次」也成立，比 key 那套更直白。
 */

/** 裁剪视口的边长（CSS px）。写死而不是量 DOM：几何与布局解耦，单测才能直接钉。 */
const VIEW_SIZE = 264

/** 大预览与真实尺寸预览的边长。32 与顶栏头像（`size-8`）一致。 */
const PREVIEW_LARGE = 96
const PREVIEW_ACTUAL = 32

/** 单张原图的大小上限（字节）。挡的是「选了一张 60 MB 的相机原图」把页面卡住。 */
const MAX_FILE_BYTES = 16 * 1024 * 1024

type AvatarDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 当前已保存的头像 data URL；null 表示还没设过。 */
  current: string | null
  /** 保存。失败时返回原因，对话框据此给出一句对应的话并保持打开。 */
  onSave: (dataUrl: string) => AvatarWriteResult
  /** 移除自定义头像，回到首字。 */
  onRemove: () => void
}

/** 保存失败时按原因给的话。三种原因对应三种「用户接下来该做什么」。 */
const SAVE_FAILURE_TEXT: Record<'invalid' | 'too_large' | 'unavailable', string> = {
  invalid: '导出的图片格式不对，换一张图片再试。',
  too_large: '这张头像太大了，换一张更小的图片。',
  unavailable: '本机存储不可用，头像没能保存下来。',
}

/**
 * 外层受控壳：只负责 `Dialog` 的开合与「打开即全新挂载」。所有状态/逻辑在 `Body`。
 */
export function AvatarDialog(props: AvatarDialogProps) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      {props.open && (
        <AvatarDialogBody
          current={props.current}
          onSave={props.onSave}
          onRemove={props.onRemove}
          onOpenChange={props.onOpenChange}
        />
      )}
    </Dialog>
  )
}

/**
 * 对话框本体。由外层在 `open` 时挂载、关闭时卸载 —— 挂载即复位，无需在 effect 里清状态。
 */
function AvatarDialogBody({
  onOpenChange,
  current,
  onSave,
  onRemove,
}: {
  onOpenChange: (open: boolean) => void
  current: string | null
  onSave: (dataUrl: string) => AvatarWriteResult
  onRemove: () => void
}) {
  /** 原图的 object URL（选文件时产生）或 data URL（沿用当前头像时）。 */
  const [source, setSource] = useState<string | null>(null)
  const [imageSize, setImageSize] = useState<Size | null>(null)
  const [crop, setCrop] = useState<CropState | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const imageRef = useRef<HTMLImageElement | null>(null)
  const previewRef = useRef<HTMLCanvasElement | null>(null)
  const actualRef = useRef<HTMLCanvasElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  /** 本次由「选文件」产生的 object URL，需要在替换或卸载时回收。 */
  const objectUrlRef = useRef<string | null>(null)
  /** 拖动时的上一帧指针位置。null 表示当前没有在拖。 */
  const dragRef = useRef<{ x: number; y: number } | null>(null)

  const releaseObjectUrl = useCallback(() => {
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
  }, [])

  /** 装载一张图（object URL 或 data URL），成功后把裁剪状态复位成「铺满居中」。 */
  const load = useCallback((url: string) => {
    setLoading(true)
    setMessage(null)
    const image = new Image()
    image.onload = () => {
      const size = { width: image.naturalWidth, height: image.naturalHeight }
      imageRef.current = image
      setSource(url)
      setImageSize(size)
      setCrop(createCropState(size, VIEW_SIZE))
      setLoading(false)
    }
    image.onerror = () => {
      setLoading(false)
      setMessage('这张图片读不出来，换一张试试。')
    }
    image.src = url
  }, [])

  // 挂载时拿当前头像当底图；没有就停在「还没有选择图片」。图片是异步加载，所有 setState
  // 都落在 `onload` / `onerror` 回调里（不是 effect 体内同步 setState），不撞
  // react-hooks/set-state-in-effect。用 `cancelled` 守卫卸载：对话框关闭 → body 卸载，
  // 还在途的加载不会把状态写进已经不显示的实例。
  useEffect(() => {
    if (current === null) return
    const image = new Image()
    let cancelled = false
    image.onload = () => {
      if (cancelled) return
      const size = { width: image.naturalWidth, height: image.naturalHeight }
      imageRef.current = image
      setSource(current)
      setImageSize(size)
      setCrop(createCropState(size, VIEW_SIZE))
    }
    image.onerror = () => {
      if (cancelled) return
      setMessage('这张图片读不出来，换一张试试。')
    }
    image.src = current
    return () => {
      cancelled = true
    }
  }, [current])

  // 卸载时回收最后一次的 object URL。
  useEffect(() => releaseObjectUrl, [releaseObjectUrl])

  // 预览重绘。两个画布共用 `drawAvatar`，只是目标尺寸不同。
  useEffect(() => {
    const image = imageRef.current
    if (image === null || imageSize === null || crop === null) return
    if (previewRef.current !== null) {
      drawAvatar(image, imageSize, VIEW_SIZE, crop, previewRef.current, PREVIEW_LARGE)
    }
    if (actualRef.current !== null) {
      drawAvatar(image, imageSize, VIEW_SIZE, crop, actualRef.current, PREVIEW_ACTUAL)
    }
  }, [crop, imageSize, source])

  // 滚轮缩放。见文件头：必须是非被动的原生监听，`onWheel` 里拦不住默认滚动。
  // 依赖里带上 crop / imageSize，等于每次状态变化重挂一次监听 —— 比用一个 ref 去追
  // 最新值更直白，代价只是一次 addEventListener。
  useEffect(() => {
    const element = viewportRef.current
    if (element === null || crop === null || imageSize === null) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const next = crop.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08)
      setCrop(setZoom(imageSize, VIEW_SIZE, crop, next))
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [crop, imageSize])

  const pickFile = () => fileRef.current?.click()

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // 选完即把 value 清空：这样「同一张图选两次」也能重新触发 change，且跨次都有效。
    event.target.value = ''
    if (file === undefined) return
    if (!file.type.startsWith('image/')) {
      setMessage('这里只能选图片文件（PNG / JPG / WebP 等）。')
      return
    }
    if (file.size > MAX_FILE_BYTES) {
      setMessage('这张图太大了（超过 16 MB），先压缩一下再选。')
      return
    }
    releaseObjectUrl()
    const url = URL.createObjectURL(file)
    objectUrlRef.current = url
    load(url)
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (crop === null) return
    dragRef.current = { x: event.clientX, y: event.clientY }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const from = dragRef.current
    if (from === null || crop === null || imageSize === null) return
    const dx = event.clientX - from.x
    const dy = event.clientY - from.y
    dragRef.current = { x: event.clientX, y: event.clientY }
    setCrop((current) =>
      current === null ? current : panBy(imageSize, VIEW_SIZE, current, dx, dy),
    )
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const save = () => {
    const image = imageRef.current
    if (image === null || imageSize === null || crop === null) return
    const dataUrl = exportAvatarDataUrl(image, imageSize, VIEW_SIZE, crop)
    if (dataUrl === null) {
      setMessage('导出图片失败，换一张试试。')
      return
    }
    const result = onSave(dataUrl)
    if (!result.ok) {
      setMessage(SAVE_FAILURE_TEXT[result.reason])
      return
    }
    onOpenChange(false)
  }

  const display =
    imageSize !== null && crop !== null ? displaySize(imageSize, VIEW_SIZE, crop.zoom) : null

  return (
    <DialogContent className="sm:max-w-[560px]">
      <DialogHeader>
        <DialogTitle>更换头像</DialogTitle>
        <DialogDescription>
          从本机选一张图片，拖动调整位置、滚轮或滑杆缩放，保存后立即生效。
        </DialogDescription>
      </DialogHeader>

      <div className="flex gap-5">
        {/* 裁剪视口。`touch-none` 让触屏上的拖动交给指针事件而不是页面滚动。 */}
        <div
          ref={viewportRef}
          role="presentation"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className="relative shrink-0 cursor-grab touch-none overflow-hidden rounded-xl border border-border bg-secondary select-none active:cursor-grabbing"
          style={{ width: VIEW_SIZE, height: VIEW_SIZE }}
        >
          {source !== null && display !== null && crop !== null && (
            // 位置用绝对像素写出来（而不是 `translate(-50%,-50%)`）：这几个数与
            // `sourceRect` 用的是同一套推导，摆在一起读能直接对上。
            <img
              src={source}
              alt=""
              draggable={false}
              className="pointer-events-none absolute max-w-none"
              style={{
                width: display.width,
                height: display.height,
                left: VIEW_SIZE / 2 + crop.offset.x - display.width / 2,
                top: VIEW_SIZE / 2 + crop.offset.y - display.height / 2,
              }}
            />
          )}

          {/* 圆形遮罩：把圆外的部分压暗，让「哪些内容会进头像」一眼可见。 */}
          <div
            aria-hidden
            className="pointer-events-none absolute top-0 left-0 rounded-full"
            style={{
              width: VIEW_SIZE,
              height: VIEW_SIZE,
              boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.45)',
            }}
          />

          {crop === null && (
            <div className="absolute inset-0 grid place-items-center px-6 text-center text-sm text-muted-foreground">
              {loading || current !== null ? '正在读取图片…' : '还没有选择图片'}
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div>
            <p className="mb-1.5 text-xs text-muted-foreground">预览</p>
            <div className="flex items-end gap-3">
              <canvas
                ref={previewRef}
                className="rounded-full border border-border-soft"
                style={{ width: PREVIEW_LARGE, height: PREVIEW_LARGE }}
              />
              <div className="flex flex-col items-center gap-1">
                <canvas
                  ref={actualRef}
                  className="rounded-full border border-border-soft"
                  style={{ width: PREVIEW_ACTUAL, height: PREVIEW_ACTUAL }}
                />
                <span className="text-[10px] text-muted-foreground-weak">实际大小</span>
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs text-muted-foreground" htmlFor="avatar-zoom">
              缩放
            </label>
            <input
              id="avatar-zoom"
              type="range"
              min={1}
              max={MAX_ZOOM}
              step={0.01}
              value={crop?.zoom ?? 1}
              disabled={crop === null}
              onChange={(event) => {
                if (crop === null || imageSize === null) return
                setCrop(setZoom(imageSize, VIEW_SIZE, crop, Number(event.target.value)))
              }}
              className="w-full accent-primary disabled:opacity-50"
            />
          </div>

          <div className="mt-auto flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={pickFile}>
              <ImageUp />
              选择图片
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={crop === null || imageSize === null}
              onClick={() => {
                if (imageSize === null) return
                setCrop(createCropState(imageSize, VIEW_SIZE))
              }}
            >
              <RotateCcw />
              复位
            </Button>
          </div>
        </div>
      </div>

      {message !== null && <p className="text-xs text-destructive">{message}</p>}

      <DialogFooter className="sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          disabled={current === null}
          onClick={() => {
            onRemove()
            onOpenChange(false)
          }}
        >
          <Trash2 />
          移除头像
        </Button>

        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button type="button" size="sm" disabled={crop === null} onClick={save}>
            保存
          </Button>
        </div>
      </DialogFooter>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onFileChange}
      />
    </DialogContent>
  )
}
