import { useState, type DragEvent } from 'react'

import { isAfterMidpoint, type DropTarget } from '../../../lib/quote-sort'

/**
 * 表格行的拖动排序。
 *
 * ## 为什么 `draggable` 只挂在手柄上，不挂在整行
 *
 * 行里有 input（改价的输入框）、有 checkbox（勾选合并）、有按钮。整行可拖的话，
 * 想选中输入框里的文字会变成拖动整行，而用户完全不知道自己做错了什么 —— 表现为
 * 「输入框选不了字」。手柄是一个明确的、只有一种含义的东西。
 *
 * ## 为什么落点要分上下半
 *
 * 只按「拖到哪一行」算的话，把第 1 行拖到第 2 行永远是「换位」，用户想「插到第 2 行
 * 后面」就得再拖一次。分上下半之后，一次拖动能落在任意两个相邻行之间。
 *
 * ## 为什么 `dragstart` 里要 `setData`
 *
 * Firefox（以及部分基于 Gecko 的内核）不 `setData` 就不启动拖动 —— 表现为「按住手柄
 * 一点反应都没有」，而 Chrome 里一切正常。
 *
 * ## 键盘可达性
 *
 * HTML5 拖放本身没有键盘通道。分类那一列因此**保留**了上移 / 下移两个箭头按钮
 * （原生 button，读屏与键盘都能用）；产品和主类两个列表只有拖动，这是这次改动接受
 * 的取舍 —— 需要的话下一步给它们补同一对箭头。
 */
export function useRowDrag({
  enabled,
  onReorder,
}: {
  /** 没写权限、或正在搜索时关掉：带着关键词拖动会改到没显示的那几百条。 */
  enabled: boolean
  onReorder: (target: DropTarget) => void
}) {
  const [state, setState] = useState<{ from: number; over: number; after: boolean } | null>(null)

  function handleProps(index: number): React.HTMLAttributes<HTMLSpanElement> {
    if (!enabled) return { 'aria-disabled': true }
    return {
      draggable: true,
      onDragStart: (event: DragEvent<HTMLSpanElement>) => {
        event.dataTransfer.effectAllowed = 'move'
        // Firefox 不带 data 就不启动拖动。
        event.dataTransfer.setData('text/plain', String(index))
        // 让拖动时浮着的是整行而不是那个小图标 —— 图标太小，看不出自己拖的是哪一条。
        const row = event.currentTarget.closest('tr')
        if (row !== null) event.dataTransfer.setDragImage(row, 24, 12)
        setState({ from: index, over: index, after: false })
      },
      onDragEnd: () => setState(null),
    }
  }

  function rowProps(index: number): React.HTMLAttributes<HTMLTableRowElement> {
    if (!enabled) return {}
    return {
      onDragOver: (event: DragEvent<HTMLTableRowElement>) => {
        // 只接本列表发起的拖动。不判断的话，把一张图从桌面拖进面板时每一行都会亮，
        // 而且 `preventDefault` 会让浏览器不再执行「打开这个文件」—— 看起来像卡住。
        if (state === null) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        const rect = event.currentTarget.getBoundingClientRect()
        const after = isAfterMidpoint(rect.top, rect.height, event.clientY)
        setState((current) =>
          current === null || (current.over === index && current.after === after)
            ? current
            : { ...current, over: index, after },
        )
      },
      onDrop: (event: DragEvent<HTMLTableRowElement>) => {
        event.preventDefault()
        const from = state?.from
        // 落点用**松手那一刻**的鼠标位置重算，不信最后一次 dragover 存下的值：
        // 快速松手时那一次 dragover 可能还没派发。
        const rect = event.currentTarget.getBoundingClientRect()
        const after = isAfterMidpoint(rect.top, rect.height, event.clientY)
        setState(null)
        if (from === undefined || from === index) return
        onReorder({ from, over: index, after })
      },
    }
  }

  /**
   * 行的高亮。用 `td` 的 inset 阴影画线，不用行边框：
   *
   * - 行边框（`border-t-2`）会让悬停那一行突然高 2px，列表跟着抖；
   * - `<tr>` 上的 `box-shadow` 在表格布局里不可靠（部分浏览器直接不画）。
   *
   * `td` 的 inset 阴影不动布局，且无论表格是不是 `border-collapse` 都画得出来。
   */
  function rowClass(index: number): string {
    if (state === null) return ''
    if (state.from === index) return 'opacity-50'
    if (state.over !== index) return ''
    return state.after
      ? '[&>td]:[box-shadow:inset_0_-2px_0_0_var(--primary)]'
      : '[&>td]:[box-shadow:inset_0_2px_0_0_var(--primary)]'
  }

  return { draggingIndex: state?.from ?? null, handleProps, rowProps, rowClass }
}
