import type { LaunchPathState, LaunchProfile } from '@fanhe/shared'

/**
 * 桌面态「路径状态」的本地来源（修 §2.5 状态误判）。
 *
 * ## 解决的是哪个真实问题
 *
 * 路径可用性是**客户端本地事实**：`D:\软件安装目录\QQ\QQ.exe` 只在用户这台机器上存在。
 * 但 `LaunchProfileStatus.pathState` 一直由**服务端**算（`apps/api` 的
 * `listProfileStatuses` → `inspectExecutablePath`），而服务端跑在 Docker 容器里 ——
 * 容器里既没有 D 盘、也没有中文安装目录，于是任何一条本地绝对路径都被判成 `missing`，
 * 首页卡片上恒显示「路径失效」。
 *
 * 症状最能说明问题：**同一条配置点「启动」成功（启动走 `launch:run` IPC、在本机 spawn），
 * 状态却显示「路径失效」** —— 这正是设计文档 §2.5 反复强调要避免的「检测说在、点启动
 * 说不在」的镜像：**点启动成功、状态说失效**，同样会让用户不再信任状态标记。
 *
 * ## 做法：宿主分流，桌面态用本机自检覆盖服务端的 pathState
 *
 * 与 `lib/launch.ts` 的 `runLaunchProfile` 同一套思路（桌面走 IPC、浏览器走 HTTP）。
 * 桌面态改用外壳的 `launch:diagnostics`（`checkLaunchProfiles`）—— 它用的正是**启动时
 * 那一个** `inspectExecutablePath`，「自检与启动同一份实现」这条约束在这里依然成立。
 * 服务端仍提供 `lastRun` / `lastSuccessAt`（那是它记的启动历史，本就该由它给），
 * 只有 `pathState` 这一项被本机结果覆盖。
 *
 * ## 为什么不新增一个「批量查路径」的 IPC
 *
 * 外壳的 `launch:diagnostics` 已经是「按启动同款实现、批量、并发查路径」的能力，
 * 只是此前 web 侧没用过。复用它、在这里做一次纯翻译，比再开一条几乎同义的 IPC 划算：
 * 少一份要维护的通道、也少一处可能与启动判断分叉的实现。翻译逻辑抽成纯函数便于单测。
 */

/** 自检报告里一条问题的最小形状（只取本模块用得到的字段）。 */
export type DesktopDiagnostic = {
  profileId: string
  reason: 'agent_unavailable' | 'invalid_profile' | 'path_unavailable'
}

/** 自检报告的最小形状。 */
export type DesktopDiagnosticsReport = {
  agentAvailable: boolean
  diagnostics: readonly DesktopDiagnostic[]
}

/**
 * 把桌面自检报告翻译成「每条配置的路径状态」（纯函数）。
 *
 * - **代理不可用**（`agentAvailable === false`）：返回**空对象**，表示「这次没判断成」。
 *   调用方据此保留服务端原值，而不是把每一条都标成失效 —— 代理没加载出来是环境问题，
 *   不是路径问题，标失效会让用户去改本来好好的路径（与 `diagnostics.ts` 里
 *   `agent_unavailable` 与 `path_unavailable` 必须分开是同一条判断）。
 * - **其余情况**：先默认每条 `ok`，再把自检里 `path_unavailable` 的那些改成 `missing`。
 *   自检只报「不 ok」的条目，所以「不在诊断列表里」就等于可用 —— 这正是它 `okCount`
 *   的口径。
 * - `invalid_profile` 的条目 `profileId` 是空串（那条对象压根不像一条配置，id 不可信），
 *   无法按 id 归位，跳过；它是否可用不由路径状态表达。
 */
export function pathStatesFromDiagnostics(
  profiles: readonly LaunchProfile[],
  report: DesktopDiagnosticsReport,
): Record<string, LaunchPathState> {
  const states: Record<string, LaunchPathState> = {}
  if (!report.agentAvailable) return states

  for (const profile of profiles) {
    states[profile.id] = 'ok'
  }
  for (const item of report.diagnostics) {
    if (item.reason !== 'path_unavailable') continue
    // 只覆盖本次列表里确实存在的 id：诊断来自外壳、理论上与列表同源，但若两者错位
    // （并发刷新、诊断基于旧列表），凭空造一个键会污染状态表。
    if (!Object.prototype.hasOwnProperty.call(states, item.profileId)) continue
    states[item.profileId] = 'missing'
  }
  return states
}
