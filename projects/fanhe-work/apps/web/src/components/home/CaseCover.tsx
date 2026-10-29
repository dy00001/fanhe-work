import { Image as ImageIcon } from 'lucide-react'

import type { CaseCategory } from '../../lib/case-catalog'

/**
 * 品类封面位。首页横滑条与「全部品类」弹窗共用这一个组件。
 *
 * **抽成一个组件是为了让「同款」由代码保证。** 之前两处各写一份占位样式，靠注释互相
 * 指向、靠人工逐项对齐；现在只改一处，两边必然一致，不会再出现「主页一个样式、弹窗
 * 另一个样式」的双轨。
 *
 * 比例取 `400/234`：这是原型里九宫格卡片的比例，也是封面素材的出图比例（1344×784，
 * 差 0.3%）。容器铺满、图片 `object-cover` 居中裁切，因此素材换成长宽比不同的图也不会
 * 破版，只是裁掉边缘。
 *
 * **有封面时不再叠占位层。** 占位图标与文案是为了让「空位」看起来是刻意的空位；有图
 * 之后再叠上去只会遮住素材。
 */
export function CaseCover({ category }: { category: CaseCategory }) {
  return (
    <div className="relative flex aspect-[400/234] w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-2xl border border-border bg-[color-mix(in_srgb,var(--m-neutral)_4%,var(--card))]">
      {category.cover === null ? (
        <>
          <span className="grid size-10 place-items-center rounded-xl bg-[color-mix(in_srgb,var(--m-neutral)_var(--wash),var(--card))] text-m-neutral">
            <ImageIcon className="size-5" />
          </span>
          <span className="text-sm text-muted-foreground-weak">封面待补</span>
        </>
      ) : (
        // `h-full w-full` 与 `absolute inset-0` 二选一都可以撑满；用绝对定位是为了让图片
        // 不参与父级的 flex 居中计算，避免某些浏览器上出现 1px 的基线留白。
        <img
          src={category.cover}
          alt={`${category.name}案例封面`}
          decoding="async"
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
    </div>
  )
}
