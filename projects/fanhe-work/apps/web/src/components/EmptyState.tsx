import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '../lib/utils'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './ui/empty'

type EmptyStateProps = {
  icon: LucideIcon
  title: ReactNode
  description?: ReactNode
  /** 操作入口。各状态都应给出一个，避免用户停在一个没有出路的界面上。 */
  action?: ReactNode
  /**
   * 形态。`card` 用于页面级状态（404、500、占位、无权限），自带卡片边框与内边距；
   * `plain` 用于卡片内部的空列表，去掉边框与内边距，只保留居中排版。
   *
   * 之所以做成一个组件而不是各页面各写一份：这几处状态的排版完全一致，差别只在
   * 文案与图标。分开写的话，改一次间距要改四五处，而这类偏差只在来回切换时才看得出来。
   */
  variant?: 'card' | 'plain'
  /** 追加到外层容器的类名，用于个别页面的位置微调（例如卡片内的上边距）。 */
  className?: string
}

/**
 * 统一的状态呈现：图标、标题、说明、操作入口。
 *
 * 建立在官方 `components/ui/empty.tsx` 之上，不另写一套排版。官方原语负责结构
 * （`EmptyHeader` / `EmptyMedia` / `EmptyTitle` / `EmptyDescription` / `EmptyContent`），
 * 这里只补两件事：把图标渲染出来，以及按形态套上或去掉卡片外观。
 *
 * **标题外面套一层语义标签。** 官方的 `EmptyTitle` 渲染成 `div`，而页面级状态需要
 * 一个一级标题：既为读屏软件，也为「当前在哪一页」这件事有个稳定的落点。卡片形态
 * 套 `h1`，内联形态套 `div`（所在的卡片已经有自己的标题，再出一个 `h1` 会破坏层级）。
 * 字号与字重由 `EmptyTitle` 提供，只有内联形态收小一档 —— 它嵌在正文尺寸的卡片里，
 * 沿用页面级的 `text-lg` 会盖过卡片自己的标题。
 *
 * **卡片形态用 12px 圆角**，与 `ModuleHeader` 及工作台的内容卡一致。官方 `Empty`
 * 自带的是 8px，直接沿用会让状态卡与内容卡并排时圆角差一档。
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = 'card',
  className,
}: EmptyStateProps) {
  const TitleTag = variant === 'card' ? 'h1' : 'div'

  return (
    <Empty
      className={cn(
        variant === 'card'
          ? 'rounded-xl border border-solid border-border bg-card'
          : 'border-0 bg-transparent p-0 md:p-0',
        className,
      )}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle className={variant === 'plain' ? 'text-sm' : undefined}>
          <TitleTag>{title}</TitleTag>
        </EmptyTitle>
        {description !== undefined && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action !== undefined && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  )
}
