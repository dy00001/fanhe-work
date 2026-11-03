import { GripVertical } from 'lucide-react'

/**
 * 拖动排序的手柄。
 *
 * 三个列表共用同一个外形与同一句提示 —— 同一个动作在三个地方长得不一样的话，用户
 * 会以为其中两个是别的东西（比如「这个能点」「这个只是装饰」）。
 *
 * 用 `<span>` 而不是 `<button>`：HTML5 的 `draggable` 挂在 button 上时，按下即触发
 * 焦点与点击语义，拖动结束浏览器还会补一次 click —— 在触屏与部分浏览器里那一下
 * 会把行选中或把展开区收起。这里没有点击行为，就不该长成按钮。
 *
 * `tabIndex={-1}`：拖放本身没有键盘通道，让它进 Tab 序只会多一个「按了没反应」的站。
 * 键盘用户走的是分类列表里那对上下箭头。
 */
export function RowDragHandle({
  label,
  enabled,
  ...rest
}: {
  label: string
  enabled: boolean
} & React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      {...rest}
      aria-label={label}
      title={enabled ? '按住拖动可调整顺序' : '当前不能拖动排序'}
      className={
        enabled
          ? 'inline-flex size-6 cursor-grab items-center justify-center rounded-[6px] text-muted-foreground-weak hover:bg-accent hover:text-muted-foreground active:cursor-grabbing'
          : 'inline-flex size-6 cursor-not-allowed items-center justify-center rounded-[6px] text-muted-foreground-weak opacity-40'
      }
    >
      <GripVertical className="size-3.5" />
    </span>
  )
}
