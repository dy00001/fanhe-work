import { createContext } from 'react'

import type { AuthenticatedUser, PermissionCode } from '@fanhe/shared'

/**
 * 认证状态。
 *
 * 四种状态各自对应一个界面，互斥且穷尽，不用额外的布尔量表达。
 *
 * - `loading`：正在判断该显示哪一个界面。启动时先问一次初始化状态，再决定是否
 *   尝试静默续期，这段时间界面不能先闪一下登录页。
 * - `uninitialized`：系统里还没有任何 owner 账号，显示初始化引导。
 * - `unauthenticated`：已初始化但没有有效会话，显示登录页。
 * - `authenticated`：有有效会话，显示主界面。
 */
export type AuthStatus = 'loading' | 'uninitialized' | 'unauthenticated' | 'authenticated'

export type AuthContextValue = {
  status: AuthStatus
  user: AuthenticatedUser | null
  /** 展开后的权限点，用于前端可见性判断。服务端仍会独立校验。 */
  permissions: readonly PermissionCode[]
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  /** 首次初始化成功后调用，把状态从 `uninitialized` 切到 `unauthenticated`。 */
  markInitialized: () => void
  /** 判断是否持有某个权限点。只用于决定「要不要展示」，不构成访问控制。 */
  can: (permission: PermissionCode) => boolean
}

/**
 * 认证上下文。
 *
 * 与 Provider 分文件，是为了满足 react-refresh 的约束：一个文件同时导出组件与
 * 非组件时，热更新无法确定该保留哪一部分的状态。把上下文与类型单独放，Provider
 * 文件就只剩一个组件导出。
 */
export const AuthContext = createContext<AuthContextValue | null>(null)
