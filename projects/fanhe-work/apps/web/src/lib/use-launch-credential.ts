import { useCallback, useEffect, useState } from 'react'

import { fetchCredentialStatus, type CredentialSnapshot } from './launch-credentials'

/**
 * 一条启动配置的本机凭据状态（P1）。
 *
 * ## 为什么单独一个 hook
 *
 * 对话框每次打开都是一次全新挂载（Radix 退场动画结束后卸载内容），于是「打开时查一次」
 * 这件事必须挂在挂载上。两处对话框（首页区块、管理面板）都要它，抽出来各持一份引用的
 * 结果迟早是某一份忘了处理「解不开」。
 *
 * ## 它只做一件事：查
 *
 * 保存与删除由调用方在提交时经 `applyCredentialIntent` 做，这里不碰。分开的理由是**两者
 * 的失败处理完全不同**：查询失败只是不显示状态，保存失败要在提示条上说明「配置已保存但
 * 密码没保存」。混在一个 hook 里会让调用方拿到一个分不清这两种失败的结果。
 */
export type UseProfileCredential = {
  /** 当前凭据状态；还没查到、或这是新增模式（没有 id）时为 null。 */
  snapshot: CredentialSnapshot | null
  /** 本机系统加密是否可用。false 时界面应禁用账号密码输入区。 */
  encryptionAvailable: boolean
  /** 查询进行中。 */
  loading: boolean
  /** 重新查一次。保存成功后调用它，让掩码账号立刻变成新的。 */
  reload: () => void
}

export function useProfileCredential(profileId: string | null): UseProfileCredential {
  const [snapshot, setSnapshot] = useState<CredentialSnapshot | null>(null)
  const [encryptionAvailable, setEncryptionAvailable] = useState(false)
  const [loading, setLoading] = useState(false)
  const [token, setToken] = useState(0)

  /**
   * 上一次查的是哪条配置。
   *
   * **换配置时在渲染阶段就把旧结果清掉，不等 effect**：React 对「props 变化时调整 state」
   * 的推荐做法就是这样写在渲染里（它会立刻用新 state 重渲染一次，不提交旧值）。写进
   * effect 反而会被 `react-hooks/set-state-in-effect` 拦下，且那一帧会先显示上一条配置的
   * 账号 —— 在「连着编辑两条 QQ 配置」时是个看得见的错值。
   */
  const [queriedId, setQueriedId] = useState(profileId)
  if (queriedId !== profileId) {
    setQueriedId(profileId)
    setSnapshot(null)
    setEncryptionAvailable(false)
    setLoading(false)
  }

  const reload = useCallback(() => {
    setToken((value) => value + 1)
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        setLoading(true)
        // 新增模式没有凭据条目，但仍需向桌面主进程查询系统加密能力，否则输入区会
        // 因为默认 false 一直禁用。空 profileIds 只查能力状态，不读取凭据文件。
        const reply = await fetchCredentialStatus(profileId === null ? [] : [profileId])
        if (cancelled) return
        setSnapshot(
          profileId === null
            ? null
            : (reply.items.find((item) => item.profileId === profileId) ?? null),
        )
        setEncryptionAvailable(reply.encryptionAvailable)
      } catch {
        // 查询失败按「没有凭据」处理，`encryptionAvailable` 保持 false：输入区被禁用，
        // 用户此时看不到一个能填却存不上的表单。失败原因不进提示条 —— 它不影响配置
        // 本身的保存，为一个附赠信息弹错误只会让人以为配置没存上。
        if (cancelled) return
        setSnapshot(null)
        setEncryptionAvailable(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [profileId, token])

  return { snapshot, encryptionAvailable, loading, reload }
}
