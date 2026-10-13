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
 */

import { Download, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react'

import { useDesktopUpdate } from '../lib/use-desktop-update'
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
    // `percent` 为 `null` 是「拿不到进度」，此时**不画进度条** —— 画一条宽度未知的
    // 进度条（0% 或 100%）比不画更容易被误读成「卡住了」或「快好了」。
    const percent = view.percent === null ? null : Math.round(view.percent * 100)
    return (
      <div role="status" title={view.title} className={STATUS_SHELL}>
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
    <Button size="sm" variant="outline" title={view.title} onClick={act}>
      <TriangleAlert />
      {view.actionLabel}
    </Button>
  )
}
