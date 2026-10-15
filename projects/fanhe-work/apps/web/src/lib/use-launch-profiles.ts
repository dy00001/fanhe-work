import { useCallback, useEffect, useState } from 'react'

import { ApiError } from './api'
import {
  createLaunchProfile,
  loadLaunchProfiles,
  loadLaunchStatuses,
  removeLaunchProfile,
  reorderLaunchProfiles,
  updateLaunchProfile,
} from './launch'
import type {
  CreateLaunchProfileRequest,
  LaunchProfile,
  LaunchProfileStatus,
  UpdateLaunchProfileRequest,
} from '@fanhe/shared'

/**
 * 启动配置列表与增删改的共享数据源（2.3 / 2.7）。
 *
 * 首页区块与工作台面板都要加载同一份配置、改同一份配置 —— 把这套逻辑抽成一个 hook，
 * 两处各持一份引用而不是各写一遍：否则「新增后要不要重拉状态」「删除怎么从本地列表
 * 摘掉」这类细节迟早会两处不一致，而那种不一致平时看不出来、只在某条路径上才暴露。
 *
 * **只管数据，不管 UI 状态。** 对话框开关、提示条、行内 busy 标记都是各组件的局部状态，
 * 这里不碰 —— 它们与渲染强相关，硬塞进来只会让这个 hook 变重、还逼着两个消费方接受
 * 同一套提示文案。这里返回的是「数据 + 会顺手更新本地缓存的增删改」，组件自己决定
 * 怎么把结果呈现出来。
 *
 * **状态（路径可用性 + 启动摘要）与列表分两条请求、两个计数。** 这条取舍沿用
 * `lib/launch.ts`：状态是附加信息，一次失败不该把列表换成错误页。列表只在首次与
 * `reload` 时拉；增删改与 `recheckStatuses` 走状态那条独立重查。
 */

export type UseLaunchProfiles = {
  /** 配置列表。`null` 表示还没拿到过，与「拿到了但是空的」区分开。 */
  profiles: readonly LaunchProfile[] | null
  /** 每条配置的状态，以 id 为键；未拿到时为空对象。 */
  statuses: Record<string, LaunchProfileStatus>
  /** 列表还在首次加载中（没有数据也没有错误）。 */
  loading: boolean
  /** 列表加载失败的原因；没有则 null。 */
  loadError: string | null
  /** 重新加载列表（清掉错误再拉）。 */
  reload: () => void
  /** 独立重查路径状态与启动摘要。 */
  recheckStatuses: () => void
  /** 新增一条，返回落库后的完整配置；本地列表追加。 */
  createProfile: (input: CreateLaunchProfileRequest) => Promise<LaunchProfile>
  /** 修改一条，返回落库后的完整配置；本地列表替换。 */
  updateProfile: (id: string, input: UpdateLaunchProfileRequest) => Promise<LaunchProfile>
  /** 删除一条；本地列表移除。 */
  removeProfile: (id: string) => Promise<void>
  /** 按给定 id 顺序重排；返回落库后的完整顺序。 */
  reorder: (ids: readonly string[]) => Promise<readonly LaunchProfile[]>
}

export function useLaunchProfiles(): UseLaunchProfiles {
  const [profiles, setProfiles] = useState<readonly LaunchProfile[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, LaunchProfileStatus>>({})
  const [reloadToken, setReloadToken] = useState(0)
  const [statusToken, setStatusToken] = useState(0)

  /** 从「还没有数据」与「还没有错误」推加载态，避免多维护一个布尔量（见 LaunchPanel 注释）。 */
  const loading = profiles === null && loadError === null

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await loadLaunchProfiles()
        if (cancelled) return
        setProfiles(list)
        setLoadError(null)
      } catch (error) {
        if (cancelled) return
        setLoadError(error instanceof ApiError ? error.message : '加载启动配置失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadToken])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const list = await loadLaunchStatuses()
        if (cancelled) return
        setStatuses(Object.fromEntries(list.map((item) => [item.profileId, item])))
      } catch {
        // 状态是附加信息，拿不到时列表照常可用（只不显示失效标记与启动摘要）。
      }
    })()
    return () => {
      cancelled = true
    }
  }, [statusToken])

  const reload = useCallback(() => {
    setLoadError(null)
    setReloadToken((token) => token + 1)
  }, [])

  const recheckStatuses = useCallback(() => {
    setStatusToken((token) => token + 1)
  }, [])

  const createProfile = useCallback(async (input: CreateLaunchProfileRequest) => {
    const created = await createLaunchProfile(input)
    setProfiles((current) => [...(current ?? []), created])
    // 新条目还没有状态，重拉一次让它立刻显示出来，而不是空着一行。
    setStatusToken((token) => token + 1)
    return created
  }, [])

  const updateProfile = useCallback(async (id: string, input: UpdateLaunchProfileRequest) => {
    const updated = await updateLaunchProfile(id, input)
    setProfiles((current) => (current ?? []).map((profile) => (profile.id === updated.id ? updated : profile)))
    // 改的可能正是路径，而路径状态只有服务端查得到 —— 不重拉会带着旧标记。
    setStatusToken((token) => token + 1)
    return updated
  }, [])

  const removeProfile = useCallback(async (id: string) => {
    await removeLaunchProfile(id)
    setProfiles((current) => (current ?? []).filter((profile) => profile.id !== id))
    // 状态按 id 组织，删掉的那一条不会自己消失；重拉一次让状态与列表对齐。
    setStatusToken((token) => token + 1)
  }, [])

  const reorder = useCallback(async (ids: readonly string[]) => {
    const next = await reorderLaunchProfiles(ids)
    setProfiles(next)
    return next
  }, [])

  return {
    profiles,
    statuses,
    loading,
    loadError,
    reload,
    recheckStatuses,
    createProfile,
    updateProfile,
    removeProfile,
    reorder,
  }
}
