import type { LaunchProfileStatus } from '@fanhe/shared'

import { inspectExecutablePath } from './agent.js'
import { loadLastRuns, loadLastSuccessAt } from './history.js'
import { listProfilePaths } from './profiles.js'

/**
 * 每条配置的当前状态：路径还能不能用、最近一次启动是什么结果。
 *
 * **它与配置列表分开取，不并进那个响应。** 路径状态要查文件系统（可能很慢，见
 * `PATH_INSPECT_TIMEOUT_MS`），启动记录要两次分组查询；而列表本身只是想显示用户
 * 存了什么。混在一起会让「刷新列表」这个动作凭空多出这些开销，而且任一条路径的
 * 文件系统卡住，整个列表就出不来。
 *
 * 归属由 `listProfilePaths` 的 where 条件保证，与配置读写同一条规则：查询里恒带
 * `userId`，归属不符与不存在在调用方看来是同一种结果。
 */
export async function listProfileStatuses(userId: string): Promise<LaunchProfileStatus[]> {
  const rows = await listProfilePaths(userId)
  if (rows.length === 0) return []

  const ids = rows.map((row) => row.id)

  // 三件事并发：文件系统检查最坏要等满超时，而两次分组查询是毫秒级，串起来等于白等
  // 那几秒。多条路径之间也是并发的，因此总时长与配置条数无关。
  const [pathStates, lastRuns, lastSuccessAt] = await Promise.all([
    Promise.all(rows.map((row) => inspectExecutablePath(row.executablePath))),
    loadLastRuns(userId, ids),
    loadLastSuccessAt(userId, ids),
  ])

  return rows.map((row, index) => ({
    profileId: row.id,
    // `pathStates` 与 `rows` 由同一份数据派生，长度一致。兜底取 `missing` 只是为了
    // 让 `noUncheckedIndexedAccess` 下的索引访问有个确定值，取不到时按「不可用」处理
    // 比按「可用」处理安全 —— 前者会让用户去确认路径，后者会让他在点击后收到失败。
    pathState: pathStates[index] ?? 'missing',
    lastRun: lastRuns.get(row.id) ?? null,
    lastSuccessAt: lastSuccessAt.get(row.id) ?? null,
  }))
}
