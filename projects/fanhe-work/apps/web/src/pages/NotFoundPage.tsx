import { navPath } from '@fanhe/shared'
import { FileQuestion } from 'lucide-react'
import { Link } from 'react-router'

import { useVisibleNavItems } from '../auth/useVisibleNavItems'
import { EmptyState } from '../components/StateView'
import { Button } from '../components/ui/button'

/**
 * 404 页。
 *
 * 承接路由表里那条 catch-all。T2-03 时未匹配的路径是重定向回落地页，代价是地址栏
 * 被改写成 `/workbench`，用户看不出自己输错了地址，只会觉得「点了之后莫名其妙到了
 * 别处」。这里保留原路径、把原因写清楚，并给一个明确的出口。
 *
 * **保留原地址而不是重定向**，与模块守卫的做法一致（见 `routes.tsx`）：地址栏与内容
 * 始终一一对应，用户复制这个地址给别人，对方看到的也是同一个 404。
 *
 * 出口指向落地模块而不是浏览器历史：直接输入地址进来时没有历史可回，`navigate(-1)`
 * 会把人留在原地或弹回站外。
 */
export function NotFoundPage() {
  const visibleItems = useVisibleNavItems()
  const landing = visibleItems[0] ?? null

  return (
    <EmptyState
      icon={FileQuestion}
      title="页面不存在"
      description="这个地址没有对应的页面，可能是输入有误，或者该页面已被移除。"
      action={
        landing === null ? undefined : (
          <Button asChild variant="outline" size="sm">
            <Link to={navPath(landing.code)}>返回{landing.label}</Link>
          </Button>
        )
      }
    />
  )
}
