import type { OpsDashboardResponse, OpsHealthResponse } from '@fanhe/shared'

import { ApiError, opsDashboardRequest, opsHealthRequest } from './api'
import { withAccessToken } from './session'

/**
 * 运营看板的前端数据层。
 *
 * 三层分工与 `lib/notes.ts` 完全一致，这里只说本模块特有的两条：
 *
 * **区间由调用方给明确的两端，不在这里算「近 30 天」。** 界面上的时间条已经把
 * 六个预设翻译成具体日期并写进地址栏，数据层只管照着取。若这一层也做一次换算，
 * 地址栏里的区间与请求的区间就可能不是同一个 —— 分享链接时最容易暴露。
 *
 * **健康接口的 403 不算失败。** 它需要额外的 `ops.collect.read`，没有这个权限的
 * 账号看板照常可用，只是看不到采集批次。把 403 当错误会让整页进入错误态，而这
 * 正是「一个可选面板拖垮整页」的经典形态。
 */

/**
 * 区间有两种写法，界面按当前预设选一种：
 *
 *   `days`        近 N 天。服务端以**库里最新一天**为锚，不看今天。
 *   `from` + `to` 自定义，原样使用。
 *
 * 不让前端把「近 30 天」翻译成两个日期，是因为前端不知道数据到哪天为止 —— 若它
 * 按今天算，首屏就会带上两三天没有数据的空白，而整段口径的窗口仍然停在数据末日，
 * 于是 KPI 与商品榜单取自两个不同的窗口。
 */
export function loadOpsDashboard(input: {
  shop: string | null
  days?: number
  from?: string
  to?: string
}): Promise<OpsDashboardResponse> {
  return withAccessToken(
    async (token) =>
      await opsDashboardRequest(token, {
        ...(input.days === undefined ? {} : { days: input.days }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.shop === null ? {} : { shop: input.shop }),
      }),
  )
}

export function loadOpsHealth(input: {
  shop: string | null
  limit?: number
}): Promise<OpsHealthResponse | null> {
  return withAccessToken(async (token) => {
    try {
      return await opsHealthRequest(token, {
        ...(input.shop === null ? {} : { shop: input.shop }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      })
    } catch (error) {
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return null
      throw error
    }
  })
}

/**
 * 加载失败时给哪个出口。判据是「改什么才能成功」：
 *
 *   `forbidden`  403。账号没有 `ops.shop.read`。重试没有意义，该去找管理员。
 *   `missing`    404。还没配置任何店铺（没采集过）。该去配采集器，不是刷新。
 *   `retry`      其余情况。网络抖动、服务未就绪、区间参数写错后重进。
 */
export type OpsFailureExit = 'forbidden' | 'missing' | 'retry'

export function opsFailureExit(error: ApiError): OpsFailureExit {
  if (error.status === 403) return 'forbidden'
  if (error.status === 404) return 'missing'
  return 'retry'
}
