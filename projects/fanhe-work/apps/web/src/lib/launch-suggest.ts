import type { LaunchProfile, LaunchProfileStatus } from '@fanhe/shared'

/**
 * 每个软件「最近有效路径」的反查表，供新增配置时预填（§2.5 的持久化与复用）。
 *
 * 检测通道（2.5）只落地了「扫本机、回填候选」；「新增同类软件从库带出最近有效路径」
 * 是表单侧的对接 —— 用户给微信配过一次路径、之后再加一条微信，路径框直接带出上一条
 * （状态可用则优先可用那条），不必每次重新检测。
 *
 * **选取规则**：同 `software` 下，优先取 `pathState==='ok'` 的那条；同状态取
 * `updatedAt` 最新。一条 ok 都没有时退回最近一条的路径（best-effort 复用，不强制要求
 * 当前仍可用 —— 那条路径可能已失效，但预填后界面立刻给出可改的起点，比一片空白好）。
 *
 * 纯函数：与 React 解耦，可直接被 Node 单测加载，也不必等列表请求回来就能在调用方
 * 用 `useMemo` 现算。
 */
export function buildSuggestedPaths(
  profiles: readonly LaunchProfile[] | null,
  statuses: Record<string, LaunchProfileStatus>,
): Record<string, string> {
  const result: Record<string, string> = {}
  if (profiles === null) return result

  const best = new Map<string, { path: string; updatedAt: string; ok: boolean }>()
  for (const profile of profiles) {
    const status = statuses[profile.id]
    const ok = status?.pathState === 'ok'
    const current = best.get(profile.software)
    if (current === undefined) {
      best.set(profile.software, {
        path: profile.executablePath,
        updatedAt: profile.updatedAt,
        ok,
      })
      continue
    }
    // 优先 ok；同状态取更新。两条都用比较而不是 `||` 串，避免「更旧但 ok」被
    // 「更新但失效」覆盖 —— ok 优先于一切。
    const prefer =
      (ok && !current.ok) || (ok === current.ok && profile.updatedAt > current.updatedAt)
    if (prefer) {
      best.set(profile.software, {
        path: profile.executablePath,
        updatedAt: profile.updatedAt,
        ok,
      })
    }
  }

  for (const [software, value] of best) result[software] = value.path
  return result
}
