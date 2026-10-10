import { TriangleAlert } from 'lucide-react'

import { EmptyState } from '../components/StateView'
import { Button } from '../components/ui/button'

type ErrorPageProps = {
  /**
   * 重试动作。错误边界传入「清空错误状态并重新渲染」，不传时回落到整页重载。
   *
   * 之所以让调用方注入而不是这里直接重载：整页重载会把地址栏里的位置一起丢掉，
   * 而多数渲染期异常是偶发的，清空边界状态原地重渲染的代价更小。
   */
  onRetry?: () => void
}

function reloadPage(): void {
  window.location.reload()
}

/**
 * 返回首页。
 *
 * 用 `location.assign` 而不是路由跳转，是为了让这一页不依赖 Router 与认证上下文。
 * 它可能因为路由层自身出错而被渲染出来，那时再调 `useNavigate` 只会抛出第二个异常。
 */
function goHome(): void {
  window.location.assign('/')
}

/**
 * 500 页。
 *
 * 承接渲染期的意外异常，由 `components/ErrorBoundary.tsx` 渲染。在这一层出现之前，
 * React 运行期抛错的表现是整页白屏 —— 构建能通过、接口也正常，只有界面没了，而
 * 这类故障前面几道门禁一个都拦不住。本页把白屏换成一句能看懂的话和两个出口。
 *
 * **不展示异常原文。** 堆栈与错误信息对使用者没有意义，还可能带出内部路径与变量。
 * 原文只写进控制台（见错误边界），供排查使用。
 */
export function ErrorPage({ onRetry }: ErrorPageProps) {
  return (
    <EmptyState
      icon={TriangleAlert}
      title="页面出错了"
      description="界面在渲染时遇到了意外情况。可以先重试一次，若反复出现，请把当前地址反馈给维护者。"
      action={
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" onClick={onRetry ?? reloadPage}>
            重试
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={goHome}>
            返回首页
          </Button>
        </div>
      }
    />
  )
}
