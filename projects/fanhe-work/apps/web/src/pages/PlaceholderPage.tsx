import { navPath, type NavItem } from '@fanhe/shared'
import { Link } from 'react-router'

import { useVisibleNavItems } from '../auth/useVisibleNavItems'
import { EmptyState } from '../components/StateView'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { NAV_ICONS } from '../lib/nav-icons'

/**
 * 统一占位页。
 *
 * 清单里 `planned` 为真的模块（资产、搜索、客户与运维的具名子项、十一个预留槽位、
 * 系统设置）共用这一个页面。T2-03 时占位标注是 `ModulePage` 里内联的一行小字，
 * 看不出「这个模块打算做什么」，本页把它换成独立页面，并把规划范围与一个明确的
 * 操作入口摆出来。预留槽位的名称本身就是「功能开发中 N」，它们的规划范围统一写作
 * 「该子项尚未定义。」—— 名称与说明各说一遍，而不是让标题承担状态标注。
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
 * **「功能开发中」的标记不进标题。** 放进 `h1` 会让读屏软件念出「系统设置功能开发中」，
 * 而它只是状态标注。因此标题只放模块名，标记与规划范围一起进说明区。
 *
 * 这一页只承担体验职责，与权限无关：能否进入某个模块由路由守卫与服务端判定。
 */
export function PlaceholderPage({ item }: { item: NavItem }) {
  const visibleItems = useVisibleNavItems()
  const landing = visibleItems[0] ?? null
  const Icon = NAV_ICONS[item.code]

  return (
    <EmptyState
      icon={Icon}
      title={item.label}
      description={
        <span className="flex flex-col items-center gap-1.5">
          <Badge variant="secondary">功能开发中</Badge>
          <span className="text-xs text-muted-foreground-weak">规划范围</span>
          <span>{item.summary}</span>
        </span>
      }
      action={
        landing === null || landing.code === item.code ? undefined : (
          <Button asChild variant="outline" size="sm">
            <Link to={navPath(landing.code)}>返回{landing.label}</Link>
          </Button>
        )
      }
    />
  )
}
