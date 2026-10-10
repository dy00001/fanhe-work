import { AuthProvider } from './auth/AuthProvider'
import { useAuth } from './auth/useAuth'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { SetupPage } from './pages/SetupPage'

/**
 * 按认证状态选择界面。
 *
 * 用状态机而不是路由：阶段一只有「初始化 / 登录 / 已登录」三个界面，且它们
 * 互斥，一个 status 就够表达。真正的路由体系（一级导航与嵌套路由）属阶段二
 * 的 T2-03，那时这里会换成路由表加守卫，但守卫的判断依据仍然是这一份 status。
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
  return <HomePage />
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  )
}
