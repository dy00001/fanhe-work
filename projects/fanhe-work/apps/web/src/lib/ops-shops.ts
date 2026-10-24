import type { OpsShopBindInput, OpsShopSummary } from '@fanhe/shared'

import {
  ApiError,
  bindOpsShopRequest,
  opsShopsRequest,
  syncOpsShopRequest,
  unbindOpsShopRequest,
  updateOpsShopRequest,
  type OpsShopListResponse,
  type OpsShopMutationResponse,
} from './api'
import { withAccessToken } from './session'

/**
 * 店铺绑定的前端数据层。
 *
 * 与 `lib/ops.ts` 同一条分层：这里只做「会话感知 + 拆信封 + 按错误码分流」，
 * 展示规则（状态怎么配色、时间怎么算新鲜度）放在 `lib/ops-shops-display.ts`
 * 的纯函数里 —— 写在组件里就只能开浏览器才能验。
 */

export type OpsSlotResult = NonNullable<OpsShopMutationResponse['slot']>

export function loadOpsShops(): Promise<OpsShopListResponse> {
  return withAccessToken(async (token) => await opsShopsRequest(token))
}

export function bindOpsShop(input: OpsShopBindInput): Promise<OpsShopMutationResponse> {
  return withAccessToken(async (token) => await bindOpsShopRequest(token, input))
}

export function updateOpsShop(
  code: string,
  patch: {
    name?: string
    sellerNick?: string | null
    collectPort?: number
    enabled?: boolean
    ownerId?: string | null
  },
): Promise<OpsShopMutationResponse> {
  return withAccessToken(async (token) => await updateOpsShopRequest(token, code, patch))
}

export function unbindOpsShop(code: string): Promise<OpsShopMutationResponse> {
  return withAccessToken(async (token) => await unbindOpsShopRequest(token, code))
}

export function requestOpsShopSync(code: string): Promise<OpsShopSummary> {
  return withAccessToken(async (token) => (await syncOpsShopRequest(token, code)).shop)
}

/**
 * 写操作失败时给哪句话。
 *
 * 三种错误必须分开说，否则用户会做错动作：
 *
 *   - 409 `duplicate` / `port_conflict`：改输入就能成功，指出冲突对象；
 *   - 403：没有 `ops.shop.bind`，改输入没有意义，去找管理员；
 *   - 其余：可重试，提示「稍后重试」并保留已填内容。
 */
export function describeShopMutationError(error: unknown): string {
  if (!(error instanceof ApiError)) return '操作失败，请稍后重试'
  if (error.status === 403) return '当前账号没有绑定店铺的权限，请联系管理员'
  if (error.status === 409) return error.message
  if (error.status === 400) return error.message
  if (error.status === 404) return '这家店铺已不存在，刷新页面后重试'
  return `操作失败：${error.message}`
}
