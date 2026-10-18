/**
 * 顶栏上的更新提示与更新按钮（T7-02b）。
 *
 * ## 为什么它不放在账号菜单里
 *
 * 更新提示原来只出现在账号菜单的底部（`TopBar` 里那一行）。那有个结构性问题：
 * **菜单得先被打开才看得见**，而「有新版本」是一件用户不会主动去找的事 —— 桌面工具
 * 会被开一整天，没人会为了看看有没有更新而去点自己的头像。
 *
 * 所以这一条挪到顶栏上，与头像同一行：只有真有可做的事时才出现，出现即意味着
 * 有事要办。菜单里那一行保留（它回答的是另一个问题：「本机该是什么版本」），
 * 两者不冲突 —— 但**动作**只有这里这一个。
 *
 * ## 四个形态，对应四种该做的事
 *
 * | 形态 | 用户该做的 | 为什么这样渲染 |
 * | --- | --- | --- |
 * | 下载中 | 什么也不用做 | 不可点。此时没有任何动作是成立的，给一个能按的按钮只会让人反复按 |
 * | 已就绪 | 点一下，退出并装上新版 | 唯一需要用户决策的一态，所以它是唯一的按钮（主色） |
 * | 检查中 | 等 | 只在用户点了「重试」之后才出现，理由见 `use-desktop-update.ts` 文件头 |
 * | 失败 | 可以重试 | 失败不显示等于「功能坏了但没人知道」，所以它也要占一行 |
 *
 * 「什么也不显示」是第五种形态（`hidden`），也是最常见的一种：没有更新、或者跑在
 * 浏览器里。**顶栏在绝大多数时候不应该多出任何东西。**
 *
 * ## 下载中为什么要有一个详情面板
 *
 * 顶栏那一行只有几十像素宽，够说「正在下载 v0.1.5 · 38%」，说不清「112 MB 的包
 * 下到 42 MB、现在 2.4 MB/s、还要 29 秒」。而这三件事恰恰是用户判断「要不要等」
 * 的全部依据 —— 少了它们，一个 5 分钟的大包与一个卡死的下载在界面上长得一样。
 *
 * 所以：**窄的那一条常驻，点开看详情**。详情面板用 `absolute` 挂在这一条下面，
 * 宽度取 `min(20rem, 100vw - 1.5rem)`，小屏上不会顶出视口。
 */

import { Download, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

import { useDesktopUpdate } from '../lib/use-desktop-update'
import { cn } from '../lib/utils'
import { Button } from './ui/button'

/**
 * 「等待中」那两个形态共用的外壳。
 *
 * 高度与账号头像一致（`h-8`）—— 同一行里两个高度不同的东西会让视线跳一下。
 * 用 `border` + `card` 而不是主色：它是一条状态，不是一个待办。
 */
const STATUS_SHELL =
  'inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground'

export function UpdateNotice() {
  const { view, act } = useDesktopUpdate()
  /**
   * 面板是为「哪个形态」打开的。
   *
   * 存形态而不是存一个布尔值，是为了让**状态一变面板自然失效**：下载完成时面板里
   * 那句「剩余 29 秒」已经过期，继续开着只会显示一条错误的信息。而用一个布尔值
   * 加 `useEffect` 去关它，会在渲染之后再触发一次 setState —— 那正是
   * `react-hooks/set-state-in-effect` 要拦的写法，且多一帧闪烁。
   */
  const [openFor, setOpenFor] = useState<string | null>(null)
  const panelId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const open = openFor === view.kind

  // 面板打开时点外面 / 按 Esc 关掉。用 pointerdown 而不是 click：后者在按下与抬起
  // 之间若发生布局变化（比如状态从「下载中」切到「已就绪」）就会丢事件。
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent): void => {
      if (rootRef.current !== null && event.target instanceof Node) {
        if (!rootRef.current.contains(event.target)) setOpenFor(null)
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpenFor(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // 不渲染。这是最常见的分支：没有更新、或跑在浏览器里。
  if (view.kind === 'hidden') return null

  if (view.kind === 'checking') {
    return (
      <div role="status" className={STATUS_SHELL}>
        <LoaderCircle className="size-3.5 animate-spin" />
        {view.text}
      </div>
    )
  }

  if (view.kind === 'downloading') {
    const percent = view.percent === null ? null : Math.round(view.percent * 100)
    return (
      <div ref={rootRef} className="relative">
        <button
          type="button"
          onClick={() => setOpenFor((current) => (current === view.kind ? null : view.kind))}
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={`${view.text}，查看下载详情`}
          title={view.title}
          className={cn(
            STATUS_SHELL,
            'transition-colors hover:bg-accent hover:text-foreground',
            open && 'bg-accent text-foreground',
          )}
        >
          <Download className="size-3.5" />
          <span className="tabular-nums">{view.text}</span>
          {percent !== null && (
            <span aria-hidden="true" className="h-1 w-14 overflow-hidden rounded-full bg-muted">
              <span
                className="block h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                style={{ width: `${percent}%` }}
              />
            </span>
          )}
        </button>
        {open && (
          <div
            id={panelId}
            role="dialog"
            aria-label="下载详情"
            className="absolute top-full right-0 z-50 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg"
          >
            <DownloadPanelBody view={view} />
          </div>
        )}
      </div>
    )
  }

  if (view.kind === 'ready') {
    return (
      <Button size="sm" title={view.title} onClick={act}>
        <RefreshCw />
        {view.actionLabel}
      </Button>
    )
  }

  // `failed`：可以重试。用 `outline` 而不是主色 —— 更新失败不是一件该被高亮的事，
  // 它只是需要有一个地方可以再试一次。
  return (
    <Button
      size="sm"
      variant="outline"
      title={view.progressText === null ? view.title : `已下载 ${view.progressText}。${view.title}`}
      onClick={act}
    >
      <TriangleAlert />
      {view.progressText === null ? view.actionLabel : `${view.text} · ${view.actionLabel}`}
    </Button>
  )
}

/** 面板正文。抽成子组件只是为了让上面那个 `if` 链读起来还是一屏。 */
function DownloadPanelBody({
  view,
}: {
  view: Extract<ReturnType<typeof useDesktopUpdate>['view'], { kind: 'downloading' }>
}) {
  const percent = view.percent === null ? null : Math.round(view.percent * 100)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-medium">{view.text}</span>
        {percent !== null && (
          <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{percent}%</span>
        )}
      </div>

      {/* 进度条：`role="progressbar"` 让读屏软件也能读到，而不只是画给眼睛看。 */}
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        aria-label="下载进度"
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-500 ease-out',
            view.stalled ? 'bg-amber-500' : 'bg-primary',
          )}
          style={{ width: `${percent ?? 0}%` }}
        />
      </div>

      <div className="flex items-center justify-between gap-2 text-xs tabular-nums">
        <span className="text-foreground">{view.sizeText}</span>
        {view.stalled && (
          <span className="flex items-center gap-1 text-amber-600">
            <TriangleAlert className="size-3" />
            已暂停
          </span>
        )}
      </div>

      <div className="text-xs text-muted-foreground tabular-nums">{view.metaText}</div>

      {view.stalled && (
        <p className="text-xs text-muted-foreground">
          进度已有几秒没有推进。网络恢复后会自动继续，不必重试。
        </p>
      )}
    </div>
  )
}
