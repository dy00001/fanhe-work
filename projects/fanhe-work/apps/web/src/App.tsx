import { BrowserRouter } from 'react-router'

import { AuthProvider } from './auth/AuthProvider'
import { useAuth } from './auth/useAuth'
import { ErrorBoundary } from './components/ErrorBoundary'
import { LoginPage } from './pages/LoginPage'
import { SetupPage } from './pages/SetupPage'
import { AppRoutes } from './routes'

/**
 * 认证门禁与路由的分工。
 *
 * **门禁在路由之外，路由只管已登录的那一半。** 初始化页与登录页是状态驱动的：
 * 它们的出现与否取决于「库里有没有 owner」「本地有没有有效会话」，与地址无关。
 * 若把它们也做成路由（`/login`、`/setup`），就会出现「已登录状态下直接访问
 * `/login`」这类地址与状态互相矛盾的情形，而处理它又要再加一层重定向。把它们
 * 留在路由之外，`BrowserRouter` 只承接五个模块，地址与内容始终一一对应。
 *
 * 代价是登录页与初始化页的地址栏会显示进入前的路径。可以接受：那两个界面是
 * 全屏的，用户不会去复制地址。
 *
 * `BrowserRouter` 放在门禁之外而不是之内，是为了让路由实例在整个会话里保持
 * 稳定：登录成功时只是门禁换了一支，地址栏里原有的深链接（例如登录前打开的
 * `/system-settings`）会被原样保留并直接落到那个模块。
 */
function AuthGate() {
  const { status } = useAuth()

  if (status === 'loading') {
    // 启动时先问初始化状态、再决定是否静默续期，这中间有一个往返。不做这个
    // 过渡态的话，有会话的用户每次刷新都会先看到登录页闪一下。
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground-weak">正在检查登录状态…</p>
      </div>
    )
  }

  if (status === 'uninitialized') return <SetupPage />
  if (status === 'unauthenticated') return <LoginPage />
  return <AppRoutes />
}

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        {/*
          错误边界放在认证提供者之内、门禁之外。放在门禁之外是因为登录页与初始化页
          同样可能渲染期抛错，只包住已登录的部分会漏掉那两个界面；放在提供者之内是
          因为边界自身渲染的 500 页要能读到认证上下文，而提供者若抛错，它也无力接住。
        */}
        <ErrorBoundary>
          <AuthGate />
        </ErrorBoundary>
      </BrowserRouter>
    </AuthProvider>
  )
}
