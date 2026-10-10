import { useContext } from 'react'

import { AuthContext, type AuthContextValue } from './context'

/**
 * 读取认证上下文。
 *
 * 在 Provider 之外调用时直接抛错，而不是返回一个「空值」。返回空值会让调用方
 * 到处写判空，而漏掉一处就变成运行期的 undefined 解引用；抛错则把这类问题在
 * 开发期就暴露出来。
 */
export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (value === null) {
    throw new Error('useAuth 只能在 AuthProvider 内部使用')
  }
  return value
}
