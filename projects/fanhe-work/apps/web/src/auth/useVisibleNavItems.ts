import { filterNavigation, type NavItem } from '@fanhe/shared'
import { useMemo } from 'react'

import { useAuth } from './useAuth'

/**
 * 当前账号可见的一级导航项。
 *
 * 抽成 hook 是因为它有三个调用点（外壳、落地页重定向、路由守卫），而三处必须
 * 用同一份结果。若各自 `filterNavigation(permissions)` 一次，将来可见性规则一变，
 * 就有可能出现「侧栏画出来了、守卫却认为不可见」的错位，而这类错位只在特定角色
 * 下复现。
 *
 * `permissions` 是数组引用，只在 `/me` 回来时整体替换，因此 `useMemo` 的依赖
 * 是稳定的，不会每次渲染都重算。
 */
export function useVisibleNavItems(): readonly NavItem[] {
  const { permissions } = useAuth()
  return useMemo(() => filterNavigation(permissions), [permissions])
}
