import { hasPermission, type MeResponse, type PermissionCode } from '@fanhe/shared'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import { loginRequest, setupStatusRequest } from '../lib/api'
import {
  applyTokens,
  clearSession,
  endSession,
  hasStoredRefreshToken,
  loadCurrentUser,
  nextRefreshDelayMs,
  refreshSession,
} from '../lib/session'
import { AuthContext, type AuthContextValue, type AuthStatus } from './context'

/**
 * 认证状态的持有者。
 *
 * 负责三件事：启动时判断该显示哪个界面、登录与登出的编排、访问令牌的静默续期。
 * 令牌本身的存取在 lib/session，界面在 pages，这里只做状态机。
 */

const DEVICE_ID_STORAGE_KEY = 'fanhe-work.device-id'

/**
 * 取本机设备标识。
 *
 * 首次访问时生成并持久化。它的用途只有一个：登出时支持「只退出当前设备」。
 * 没有它时服务端会把 `device` 范围降级成 `session`，也就是只撤当前这条链，
 * 功能仍然可用，只是范围比用户要求的窄。
 *
 * 存储不可用时返回一个固定串而不是随机串：随机串每次登录都不同，会让同一台
 * 设备在服务端看起来是许多台，比「不区分设备」更糟。
 */
function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_STORAGE_KEY)
    if (existing !== null && existing !== '') return existing
    const generated = window.crypto.randomUUID()
    window.localStorage.setItem(DEVICE_ID_STORAGE_KEY, generated)
    return generated
  } catch {
    return 'unknown-device'
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<AuthContextValue['user']>(null)
  const [permissions, setPermissions] = useState<readonly PermissionCode[]>([])

  const applyMe = useCallback((me: MeResponse) => {
    setUser(me.user)
    setPermissions(me.permissions)
    setStatus('authenticated')
  }, [])

  const resetToUnauthenticated = useCallback(() => {
    clearSession()
    setUser(null)
    setPermissions([])
    setStatus('unauthenticated')
  }, [])

  /**
   * 启动引导。
   *
   * 顺序不能颠倒：先问初始化状态，再决定是否尝试续期。空库时既没有账号也没有
   * 刷新令牌，先尝试续期只会白跑一次请求并让界面多等一个往返。
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const setup = await setupStatusRequest()
        if (cancelled) return

        if (!setup.initialized) {
          setStatus('uninitialized')
          return
        }

        if (!hasStoredRefreshToken()) {
          setStatus('unauthenticated')
          return
        }

        // 有刷新令牌，尝试静默恢复会话。这一步失败是正常的：令牌可能已过期、
        // 已被撤销，或账号已被停用。三种情况都回到登录页。
        const me = await loadCurrentUser()
        if (cancelled) return
        applyMe(me)
      } catch {
        if (cancelled) return
        resetToUnauthenticated()
      }
    })()

    return () => {
      cancelled = true
    }
  }, [applyMe, resetToUnauthenticated])

  const login = useCallback(
    async (username: string, password: string) => {
      // 登录响应里有用户信息，但没有展开后的权限点。权限由服务端按角色实时算，
      // 因此紧接着取一次 /me。把权限塞进登录响应会让「改了角色授权」要等下次
      // 登录才生效，而这正是服务端刻意避免的。
      const tokens = await loginRequest({
        username,
        password,
        deviceId: getDeviceId(),
      })
      applyTokens(tokens)
      try {
        applyMe(await loadCurrentUser())
      } catch (error) {
        // 拿到令牌却取不到用户，说明会话不可用（例如账号刚被停用）。清干净再
        // 把错误抛给登录页，避免留下一个「有令牌但没身份」的中间状态。
        clearSession()
        throw error
      }
    },
    [applyMe],
  )

  const logout = useCallback(async () => {
    await endSession('session')
    setUser(null)
    setPermissions([])
    setStatus('unauthenticated')
  }, [])

  const markInitialized = useCallback(() => {
    setStatus('unauthenticated')
  }, [])

  const can = useCallback(
    (permission: PermissionCode) => hasPermission(permissions, permission),
    [permissions],
  )

  /**
   * 静默续期。
   *
   * 在访问令牌过期之前主动换一个新的，而不是等某个请求拿到 401 再补救。被动
   * 续期会让每个到期点都先产生一次失败请求，而那次失败会短暂地影响界面上正在
   * 进行的操作。
   *
   * 续期失败即回到登录页。失败的原因通常是刷新令牌已过期或被撤销，此时继续
   * 留在主界面只会让后续每个请求都失败。
   */
  useEffect(() => {
    if (status !== 'authenticated') return

    let cancelled = false
    let timer: number | undefined

    const schedule = (): void => {
      const delay = nextRefreshDelayMs()
      if (delay === null) return
      timer = window.setTimeout(() => {
        void (async () => {
          try {
            await refreshSession()
            if (!cancelled) schedule()
          } catch {
            if (!cancelled) resetToUnauthenticated()
          }
        })()
      }, delay)
    }

    schedule()

    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [status, resetToUnauthenticated])

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, permissions, login, logout, markInitialized, can }),
    [status, user, permissions, login, logout, markInitialized, can],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
