import type {
  CreateLaunchProfileRequest,
  LaunchProfile,
  LaunchProfileStatus,
  RunLaunchProfileResponse,
  UpdateLaunchProfileRequest,
} from '@fanhe/shared'

import { ApiError } from './api'
import {
  createLaunchProfileRequest,
  deleteLaunchProfileRequest,
  launchProfileStatusRequest,
  launchProfilesRequest,
  reorderLaunchProfilesRequest,
  runLaunchProfileRequest,
  updateLaunchProfileRequest,
} from './api'
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
 */
export function loadLaunchStatuses(): Promise<readonly LaunchProfileStatus[]> {
  return withAccessToken(async (token) => (await launchProfileStatusRequest(token)).statuses)
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

export function runLaunchProfile(id: string): Promise<RunLaunchProfileResponse> {
  return withAccessToken((token) => runLaunchProfileRequest(token, id))
}

/**
 * 启动失败时，界面该给哪个出口。
 *
 * 分界的依据是「改什么才能成功」：
 *
 *   `relocate`  路径失效（`executable_missing`）。重试一万次也是同一个结果，
 *               唯一的出路是让用户重新指定可执行文件。
 *   `retry`     其余情况。进程创建失败、网络中断、服务端暂时不可用都属于这一类，
 *               再试一次有意义。
 *
 * 这两者的区分写在数据层而不是界面里，是因为它取决于**服务端给的错误码**，而错误码
 * 的取值域由服务端定义。界面只消费结论，不必知道 `executable_missing` 这个字符串。
 */
export type LaunchRunRecovery = 'relocate' | 'retry'

export function launchRunRecovery(error: ApiError): LaunchRunRecovery {
  return error.code === 'executable_missing' ? 'relocate' : 'retry'
}
