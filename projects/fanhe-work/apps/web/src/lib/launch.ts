import type {
  CreateLaunchProfileRequest,
  LaunchProfile,
  LaunchProfileStatus,
  RunLaunchProfileResponse,
  UpdateLaunchProfileRequest,
} from '@fanhe/shared'

import {
  createLaunchProfileRequest,
  deleteLaunchProfileRequest,
  launchProfileStatusRequest,
  launchProfilesRequest,
  reorderLaunchProfilesRequest,
  runLaunchProfileRequest,
  updateLaunchProfileRequest,
} from './api'
import { currentHost } from './host'
import { pathStatesFromDiagnostics } from './launch-status-desktop'
import { withAccessToken } from './session'

/**
 * 启动通道的前端数据层。
 *
 * 夹在 `api.ts` 与界面之间，只做一件事：把「需要访问令牌」这件事从界面里拿掉。
 * 界面调用这里的函数时不必知道令牌存在哪、过期了要不要先续期 —— 那是 `session.ts`
 * 的职责，而 `api.ts` 刻意不认识会话（续期流程自己要用它，反过来依赖会成环）。
 *
 * **返回值一律剥掉外层信封。** 服务端把配置包在 `{ profile }` / `{ profiles }` 里，
 * 是为了留出将来加同级字段的余地；但界面只关心那一条数据，把拆信封的动作放在这里，
 * 四五处调用点就不必各写一遍 `result.profiles`。
 *
 * 不在这里做乐观更新或本地缓存。列表的权威副本只有服务端一份：重排接口会把落库后的
 * 完整顺序回给界面（见 `api.ts` 该函数的注释），界面照着重绘即可。前端再维护一份
 * 「我猜的顺序」只会多出一个可能与服务端不一致的真相。
 */

/** 返回值是只读数组 —— 与共享包里该字段的声明一致，界面不该就地改这份列表。 */
export function loadLaunchProfiles(): Promise<readonly LaunchProfile[]> {
  return withAccessToken(async (token) => (await launchProfilesRequest(token)).profiles)
}

/**
 * 每条配置的路径状态与最近一次启动。
 *
 * 与 `loadLaunchProfiles` 分开调用，且**它的失败不算加载失败**：路径状态是附加信息，
 * 拿不到时列表照常可用（只是不显示失效标记与启动摘要）。把它并进列表那一次请求，
 * 会让一条不可达的网络共享把整个板块拖成「加载失败」。
 *
 * ## 宿主分流（与 `runLaunchProfile` 同一套）
 *
 * `pathState` 是**客户端本地事实**，而服务端（Docker 容器）看不见本机的绝对路径，
 * 恒判 `missing` —— 症状是「点启动成功、状态却说路径失效」。因此桌面态**覆盖**这一项：
 * 拿外壳 `launch:diagnostics`（启动同款的 `inspectExecutablePath`）的本机结果盖掉服务端
 * 的 `pathState`；`lastRun` / `lastSuccessAt` 仍取服务端（那是它记的启动历史）。
 *
 * 服务端请求与本地自检各失败一半时都不该整体崩：服务端失败由调用方兜底（状态是附加
 * 信息），本地自检失败则**退回服务端原值**（宁可显示一个可能不准的标记，也好过整块
 * 状态消失）。代理不可用时本机翻译返回空对象，同样退回原值。
 */
export async function loadLaunchStatuses(
  profiles: readonly LaunchProfile[],
): Promise<readonly LaunchProfileStatus[]> {
  const serverStatuses = await withAccessToken(
    async (token) => (await launchProfileStatusRequest(token)).statuses,
  )

  if (currentHost() !== 'desktop') return serverStatuses
  const bridge = window.fanheDesktop
  if (!bridge?.checkLaunchProfiles) return serverStatuses

  let localStates: Record<string, LaunchProfileStatus['pathState']>
  try {
    const report = await bridge.checkLaunchProfiles(profiles)
    localStates = pathStatesFromDiagnostics(profiles, report)
  } catch {
    // 自检本身出错不该把状态整块拖没：退回服务端原值。
    return serverStatuses
  }
  if (Object.keys(localStates).length === 0) return serverStatuses

  return serverStatuses.map((status) => {
    const local = localStates[status.profileId]
    return local === undefined ? status : { ...status, pathState: local }
  })
}

export function createLaunchProfile(input: CreateLaunchProfileRequest): Promise<LaunchProfile> {
  return withAccessToken(async (token) => (await createLaunchProfileRequest(token, input)).profile)
}

export function updateLaunchProfile(
  id: string,
  input: UpdateLaunchProfileRequest,
): Promise<LaunchProfile> {
  return withAccessToken(
    async (token) => (await updateLaunchProfileRequest(token, id, input)).profile,
  )
}

export function reorderLaunchProfiles(ids: readonly string[]): Promise<readonly LaunchProfile[]> {
  return withAccessToken(async (token) => (await reorderLaunchProfilesRequest(token, ids)).profiles)
}

/**
 * 删除。返回「本次是否真的改动了一行」。
 *
 * 软删除是幂等的，重复删除返回 `false` 而不是 404。界面不区分这两种情况（都是
 * 「这条已经不在列表里了」），返回布尔值是为了排查时能分辨「点了删除」与「点了
 * 删除但那条早就没了」。
 */
export function removeLaunchProfile(id: string): Promise<boolean> {
  return withAccessToken(async (token) => (await deleteLaunchProfileRequest(token, id)).removed)
}

/**
 * 启动一条配置。
 *
 * **宿主分流**是 2.1 的核心：桌面外壳里走 `launch:run` IPC（主进程在本机 spawn，与
 * shell 前端服务端口、api 服务端口都无关），浏览器里走 HTTP
 * `POST /api/launch/profiles/:id/run`。两者返回同一份 `RunLaunchProfileResponse`
 * 形状，界面不感知差异。
 *
 * 桌面态为什么要传整条 profile：IPC 端点不连数据库，路径与参数由各端取全了送进去、
 * 主进程经 `agent.ts` 的 `normalizeProfile` 重新校验（见 preload.ts 注释）。这正比
 * HTTP 端点安全 —— 后者只认 id（路径取库），前者不认库、只信主进程复核过的整条对象。
 */
export function runLaunchProfile(profile: LaunchProfile): Promise<RunLaunchProfileResponse> {
  if (currentHost() === 'desktop') {
    const bridge = window.fanheDesktop
    if (bridge?.runLaunchProfile) {
      return runLaunchProfileViaShell(bridge, profile)
    }
  }
  return withAccessToken((token) => runLaunchProfileRequest(token, profile.id))
}

/**
 * 桌面态走 IPC 启动。
 *
 * 成功时把 `LaunchRunResult` 的 `data` 直接当 `RunLaunchProfileResponse` 返回（两者
 * 字段完全一致）；失败时把 `reason` 翻译成 `LaunchRunError`，让上层用与 HTTP 失败
 * 同一套 `launchRunRecovery` 分流。`detail` 当作可展示文案 —— 它是主进程给的中文引导，
 * 比「启动失败」更有用。桥上若没有 `runLaunchProfile`（例如旧版外壳），回落到 HTTP，
 * 不会因版本错位而整体失效。
 */
async function runLaunchProfileViaShell(
  bridge: NonNullable<Window['fanheDesktop']>,
  profile: LaunchProfile,
): Promise<RunLaunchProfileResponse> {
  const result = await bridge.runLaunchProfile(profile)
  if (result.ok) {
    return result.data
  }
  throw new LaunchRunError(result.reason, result.detail || '启动失败，请稍后重试')
}

import { LaunchRunError, summarizeLaunchMany, type LaunchRunManyResult } from './launch-recovery'
export * from './launch-recovery'
export { detectLaunchPath, type LaunchPathDetectResult } from './launch-detect'

/**
 * 批量启动一组配置。
 *
 * 与单条 `runLaunchProfile` 同一条宿主分流：桌面态走 `launch:runMany` IPC（主进程并发
 * 拉起、每条独立），浏览器态逐条走现有单条 HTTP 端点再用 `summarizeLaunchMany` 聚合成
 * 同一份形状。两者都返回 `LaunchRunManyResult`，界面不感知差异。
 *
 * 浏览器态为何不复用一条「批量 HTTP 端点」：本项目桌面是主场景，且 `launch:runMany`
 * IPC 已覆盖；浏览器态用逐条 allSettled 既复用既有单条端点（含其历史记录与权限），
 * 又不必为服务端新增一条路由。界面拿到的聚合结构一致。
 */
export function runLaunchProfiles(profiles: LaunchProfile[]): Promise<LaunchRunManyResult> {
  if (currentHost() === 'desktop' && window.fanheDesktop?.runLaunchProfiles) {
    return window.fanheDesktop.runLaunchProfiles(profiles)
  }
  // 浏览器态（或桌面态桥缺失时回落）：逐条走单条端点，聚合结果。
  return runLaunchProfilesViaHttp(profiles)
}

/** 浏览器态（或桌面态桥缺失时回落）：逐条走单条端点，聚合结果。 */
async function runLaunchProfilesViaHttp(profiles: LaunchProfile[]): Promise<LaunchRunManyResult> {
  const settled = await Promise.allSettled(profiles.map((profile) => runLaunchProfile(profile)))
  return summarizeLaunchMany(profiles, settled)
}
