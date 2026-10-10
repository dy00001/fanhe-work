import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * 合并 class 名，供组件源码统一调用。
 *
 * 两件事必须按这个顺序做。`clsx` 负责把条件写法（对象、数组、假值）摊平成字符串，
 * `twMerge` 负责解决 Tailwind 的「同类后写覆盖先写」。反过来先 merge 再 flatten 是
 * 无效的：`clsx` 产出的字符串里条件项还没展开，`twMerge` 看不到它们。
 *
 * 后一步不是可选的。组件源码把默认样式写在前面、调用方传入的 `className` 写在后面，
 * 两边很可能都带 `px-4` 与 `px-6` 这类冲突项。少了 `twMerge`，最终生效的是 CSS 里
 * 声明顺序更靠后的那个，而不是调用方后写的那个，覆盖就变成碰运气。
 *
 * 这个文件是 shadcn/ui 组件源码的约定入口（`@/lib/utils`）。名字与路径都要与官方
 * 保持一致，否则后续按官方文档追加组件时需要逐个改 import。
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
