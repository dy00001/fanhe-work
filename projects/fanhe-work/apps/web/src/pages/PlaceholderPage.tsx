import { navPath, type NavItem } from '@fanhe/shared'
import { Link } from 'react-router'

import { useVisibleNavItems } from '../auth/useVisibleNavItems'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { NAV_ICONS } from '../lib/nav-icons'

/**
 * 统一占位页。
 *
 * 四个 `planned` 为真的模块（客户信息平台、运营信息平台、数据看板、系统设置）共用
 * 这一个页面。T2-03 时占位标注是 `ModulePage` 里内联的一行小字，看不出「这个模块
 * 打算做什么」，本页把它换成独立页面，并把规划范围与一个明确的操作入口摆出来。
 *
 * **判据是 `planned` 而不是 `module === null`。** 两者正交：系统设置已绑 `system`
 * 段权限，可见性条件不是 `null`，但它仍是占位项。用 `module === null` 判断会让系统
 * 设置在将来定义权限点的那一刻漏掉占位页，直接渲染出一个空模块。
 *
 * **操作入口指向落地模块，不指向浏览器历史。** `navigate(-1)` 在直接输入地址进来时
 * 无历史可回，会把人留在原地或弹回站外。指向第一个可见模块（即登录后的落地页）与
 * 历史无关，刷新或深链接进来都能用。落地项恰好是本模块时（某角色只可见一个占位模块）
 * 不渲染按钮，避免出现一个点了不动的链接。
 *
 * 这一页只承担体验职责，与权限无关：能否进入某个模块由路由守卫与服务端判定。
 */
export function PlaceholderPage({ item }: { item: NavItem }) {
  const visibleItems = useVisibleNavItems()
  const landing = visibleItems[0] ?? null
  const Icon = NAV_ICONS[item.code]

  return (
    <section className="rounded-xl border border-border bg-card px-8 py-14">
      <div className="mx-auto flex max-w-sm flex-col items-center text-center">
        <div className="flex size-14 items-center justify-center rounded-xl bg-accent">
          <Icon className="size-6 text-muted-foreground" />
        </div>

        <div className="mt-5 flex items-center gap-2">
          <h1 className="text-base font-medium text-foreground">{item.label}</h1>
          <Badge variant="secondary">功能开发中</Badge>
        </div>

        <p className="mt-4 text-xs text-muted-foreground-weak">规划范围</p>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{item.summary}</p>

        {landing !== null && landing.code !== item.code && (
          <Button asChild variant="outline" size="sm" className="mt-7">
            <Link to={navPath(landing.code)}>返回{landing.label}</Link>
          </Button>
        )}
      </div>
    </section>
  )
}
