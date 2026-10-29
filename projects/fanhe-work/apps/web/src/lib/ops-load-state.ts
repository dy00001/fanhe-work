import type { OpsDashboardResponse } from '@fanhe/shared'

import type { ApiError } from './api'

/**
 * 看板加载态的推导规则。
 *
 * 单独成文件而不是留在 `use-ops-dashboard.ts` 里，理由与 `ops-display.ts` 相同：
 * 这段规则决定「换一家店时整页会不会白掉」，而它写进 hook 就只能开浏览器才能验。
 * 这里不 import 任何 React 或浏览器 API，因此可以在 node 里直接单测。
 *
 * ## 为什么「只有店铺变了」不能进入加载态
 *
 * 最初的实现把 `shop` 也算进请求指纹，于是点一下店铺卡，指纹就不匹配、状态回到
 * `loading`、页面把 `data === null` 的那一大块内容（五店并列、合计、趋势图、模块卡）
 * **整块卸载**。内容高度从「两屏」骤降到「一个页头」，滚动容器 `main` 的
 * `scrollHeight` 小于 `clientHeight`，浏览器于是把 `scrollTop` 钳到 0 —— 而且数据
 * 回来、高度恢复之后，**滚动位置不会自己还原**。用户看到的就是「点店铺，页面跳到最顶端」。
 *
 * 区间变化（换天数、换起止日）仍然要进加载态：那时候整页的语义都变了，把旧区间的
 * 数字留在屏幕上比空白更容易误读。只有店铺是「同一页换一个人看」，沿用上一份数据
 * 顶着、拿到新数据原地替换，既不会塌陷也不会误导。
 *
 * 这里返回的 `switching` 就是给界面留的钩子：数据还是上一家的，卡片高亮已经是新家。
 */

export type OpsDashboardQuery = {
  days?: number
  from?: string
  to?: string
  shop: string | null
}

export type OpsLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | {
      status: 'ready'
      data: OpsDashboardResponse
      /** 正在换店：屏幕上是上一家店的数，新数据还在路上。 */
      switching?: boolean
    }

/** 已落地的一次结果。`switching` 是渲染时推导出来的，不存进这里。 */
export type DashboardEntry = {
  key: string
  rangeKey: string
  state: Exclude<OpsLoadState, { status: 'loading' }>
}

/** 完整指纹：店铺也算在内，决定 effect 要不要重取。 */
export function dashboardKey(input: OpsDashboardQuery, ticket: number): string {
  return [input.days ?? '', input.from ?? '', input.to ?? '', input.shop ?? '', ticket].join('|')
}

/** 区间指纹：去掉店铺，只回答「这一屏说的是不是同一段时间」。 */
export function dashboardRangeKey(input: OpsDashboardQuery, ticket: number): string {
  return [input.days ?? '', input.from ?? '', input.to ?? '', ticket].join('|')
}

export function resolveDashboardState(
  entry: DashboardEntry | null,
  key: string,
  rangeKey: string,
): OpsLoadState {
  if (entry === null) return { status: 'loading' }
  // 区间变了（或点了重试）：整页语义已变，必须回加载态。
  if (entry.rangeKey !== rangeKey) return { status: 'loading' }
  if (entry.key === key) return entry.state
  /*
   * 走到这里说明只有店铺变了。沿用上一份数据，让内容高度保持不变 —— 这正是
   * 「不跳顶」的实现方式，而不是事后去恢复滚动位置（那样仍会闪一下白）。
   */
  if (entry.state.status === 'ready') {
    return { status: 'ready', data: entry.state.data, switching: true }
  }
  // 上一份是错误态：换店应当重新请求，不该把上一家的错误钉在这一家头上。
  return { status: 'loading' }
}
