import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

import { TriangleAlert } from 'lucide-react'

import { cn } from '../lib/utils'
import { Button } from './ui/button'
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from './ui/empty'
import { Skeleton } from './ui/skeleton'

/**
 * 三种页面级状态的统一呈现：空、加载中、加载失败。
 *
 * 之所以放在同一个文件里：它们的排版完全一致，差别只在图标与文案。分开写的话，
 * 改一次间距要改四五处，而这类偏差只在状态来回切换时才看得出来 —— 单看哪一屏都正常。
 *
 * 标题外面套一层语义标签。官方的 `EmptyTitle` 渲染成 `div`，而页面级状态需要一个
 * 一级标题：既为读屏软件，也为「当前在哪一页」这件事有个稳定的落点。卡片形态套
 * `h1`，内联形态套 `div`（所在的卡片已经有自己的标题，再出一个 `h1` 会破坏层级）。
 *
 * 卡片形态用 12px 圆角，与 `ModuleHeader` 及工作台的内容卡一致。官方 `Empty` 自带的
 * 是 8px，直接沿用会让状态卡与内容卡并排时圆角差一档。
 */
type StateVariant = 'card' | 'plain'

function stateClassName(variant: StateVariant, className?: string): string {
  return cn(
    variant === 'card'
      ? 'rounded-xl border border-solid border-border bg-card'
      : 'border-0 bg-transparent p-0 md:p-0',
    className,
  )
}

type EmptyStateProps = {
  icon: LucideIcon
  title: ReactNode
  description?: ReactNode
  /** 操作入口。各状态都应给出一个，避免用户停在一个没有出路的界面上。 */
  action?: ReactNode
  /**
   * 形态。`card` 用于页面级状态（404、500、占位、无权限），自带卡片边框与内边距；
   * `plain` 用于卡片内部的空列表，去掉边框与内边距，只保留居中排版。
   */
  variant?: StateVariant
  /**
   * 追加到外层容器的类名，用于个别页面的位置微调（例如卡片内的上边距）。
   *
   * 写成 `string | undefined` 而不是 `string`：项目开了 `exactOptionalPropertyTypes`，
   * 它把「没有这个属性」与「显式传 undefined」当成两回事。而 `ErrorState` 要原样
   * 转发自己收到的 className，转发方自己也可能没收到 —— 那时就是一个显式的 undefined。
   */
  className?: string | undefined
}

/**
 * 空状态。建立在官方 `components/ui/empty.tsx` 之上，不另写一套排版。
 *
 * 字号与字重由 `EmptyTitle` 提供，只有内联形态收小一档 —— 它嵌在正文尺寸的卡片里，
 * 沿用页面级的 `text-lg` 会盖过卡片自己的标题。
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
    <Empty className={stateClassName(variant, className)}>
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

type ErrorStateProps = {
  /**
   * 面向使用者的失败说明。**不传异常原文。** 堆栈与内部错误码对使用者没有意义，
   * 还可能带出内部路径。这里只放调用方消化过的说法（接口给的中文提示，或一句概括）。
   */
  description?: ReactNode
  title?: ReactNode
  /**
   * 重试动作。给了才渲染按钮。
   *
   * 加载失败几乎总是暂时性的（网络抖动、服务未就绪），不给重试入口的话，用户唯一
   * 的出路是刷新整页 —— 那会把地址栏之外的所有界面状态一起丢掉。
   *
   * **不做「重试中」的按钮禁用。** 调用方按下重试后会把状态切回加载中，这个错误态
   * 连同按钮一起被替换掉，连点的机会不存在。为此多存一份状态只会让调用方多维护
   * 一个与加载态重复的布尔量。
   */
  onRetry?: () => void
  variant?: StateVariant
  className?: string
}

/**
 * 加载失败。是 `EmptyState` 的一层语义包装，只补一件事：把图标统一成警示样式，
 * 免得每个调用点各挑一个，摆在一起看才发现不重样。
 */
export function ErrorState({
  title = '加载失败',
  description,
  onRetry,
  variant = 'card',
  className,
}: ErrorStateProps) {
  return (
    <EmptyState
      icon={TriangleAlert}
      title={title}
      description={description}
      variant={variant}
      className={className}
      action={
        onRetry === undefined ? undefined : (
          <Button type="button" size="sm" onClick={onRetry}>
            重试
          </Button>
        )
      }
    />
  )
}

type LoadingStateProps = {
  /**
   * 读屏播报用的说明。
   *
   * 加载态在界面上只有骨架、没有文字，不给这句话的话，读屏软件遇到的是一个空容器。
   */
  label?: string
  variant?: StateVariant
  className?: string
}

/**
 * 加载中。用骨架而不是转圈图标：骨架的形状与 `EmptyState` 的排版对齐（图标位、
 * 标题行、说明行），数据回来时从加载态切到结果态不会跳一下。
 *
 * 骨架**不逐条模拟列表行**。列表行数与内容在加载完成前是未知的，画出来的条数只是
 * 猜的；猜多了数据回来会缩，猜少了会撑。只占住标题区这一块，长度变化落在外层。
 */
export function LoadingState({
  label = '正在加载…',
  variant = 'card',
  className,
}: LoadingStateProps) {
  return (
    <Empty className={stateClassName(variant, className)}>
      <EmptyHeader>
        <EmptyMedia>
          <Skeleton className="size-10 rounded-lg" />
        </EmptyMedia>
        <EmptyTitle className={variant === 'plain' ? 'text-sm' : undefined}>
          <Skeleton className="mx-auto h-5 w-28" />
        </EmptyTitle>
        <EmptyDescription>
          <Skeleton className="mx-auto h-4 w-44" />
        </EmptyDescription>
      </EmptyHeader>
      {/* `role="status"` 让读屏在状态变化时播报一次；没有它，加载完成与否对读屏用户
          是不可感知的 —— 骨架本身不会说话。 */}
      <span role="status" aria-live="polite" className="sr-only">
        {label}
      </span>
    </Empty>
  )
}
