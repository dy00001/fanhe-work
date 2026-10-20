import type { ReactNode } from 'react'

import { cn } from '../../lib/utils'

/**
 * 看板里的区块容器。
 *
 * 统一承担三件事：标题、标题右侧的一行口径说明、以及「这块数据的窗口与页面区间
 * 不同」这类提示。三个板块各写一份的话，改一次间距要改三处，而这类偏差只在来回
 * 切换标签时看得出来。
 *
 * 内边距用 px-5/pb-5 而不是卡片常用的 p-6：看板一屏要放四到六个区块，p-6 会让
 * 内容区在 1440 宽的屏上显得松散，而设计稿的密度更接近 tailwind 的 20px。
 */
export function OpsSection(props: {
  title: ReactNode
  note?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn('rounded-xl border border-border bg-card', props.className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-4">
        <h2 className="text-sm font-medium text-foreground">{props.title}</h2>
        {props.note === undefined ? null : (
          <span className="text-xs text-muted-foreground-weak">{props.note}</span>
        )}
        {props.action === undefined ? null : <div className="ml-auto">{props.action}</div>}
      </header>
      <div className="px-5 pt-3 pb-5">{props.children}</div>
    </section>
  )
}
