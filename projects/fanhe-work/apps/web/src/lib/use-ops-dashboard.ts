import type { OpsDashboardResponse, OpsHealthResponse } from '@fanhe/shared'
import { useEffect, useState } from 'react'

import { ApiError } from './api'
import { loadOpsDashboard, loadOpsHealth } from './ops'

/**
 * 运营看板的数据加载。
 *
 * 三种状态（加载中 / 失败 / 有数据）由一个联合类型表达，不用三个独立变量拼 ——
 * 与 `LaunchPanel` 顶部那条理由相同：两个同时为真的布尔会让界面同时显示错误与列表。
 *
 * ## 为什么把结果与「请求指纹」绑在一起
 *
 * 直觉写法是在 effect 开头 `setState({status:'loading'})`，但那样会在渲染提交之后
 * 再触发一次渲染，形成级联更新（`react-hooks/set-state-in-effect` 会拦下它）。
 * 这里改成：只保存「带指纹的结果」，**渲染时判断指纹是否匹配当前请求** ——
 * 不匹配就是加载中，匹配就用那份结果。加载态因此是推导出来的，不是写进去的。
 *
 * 指纹里带上 `ticket`，`reload()` 递增它即可让「重试」回到加载态。
 *
 * 空态不在这里判：接口返回 200 且 `dailyDays === 0` 也是一种「成功」，而空态该
 * 说什么（还没采集、还是这段时间没数据）取决于页头选中的区间 —— 那是界面的判断。
 */

export type OpsLoadState =
  | { status: 'loading' }
  | { status: 'error'; error: ApiError }
  | { status: 'ready'; data: OpsDashboardResponse }

type DashboardEntry = { key: string; state: Exclude<OpsLoadState, { status: 'loading' }> }

function dashboardKey(
  input: { days?: number; from?: string; to?: string; shop: string | null },
  ticket: number,
): string {
  return [input.days ?? '', input.from ?? '', input.to ?? '', input.shop ?? '', ticket].join('|')
}

export function useOpsDashboard(input: {
  days?: number
  from?: string
  to?: string
  shop: string | null
  enabled: boolean
}): { state: OpsLoadState; reload: () => void } {
  const [ticket, setTicket] = useState(0)
  const [entry, setEntry] = useState<DashboardEntry | null>(null)

  const key = dashboardKey(input, ticket)
  const state: OpsLoadState =
    entry !== null && entry.key === key ? entry.state : { status: 'loading' }

  useEffect(() => {
    if (!input.enabled) return
    // 卸载后回来的响应不该写状态。取消标记比 AbortController 简单，而这里没有
    // 需要真正中断的副作用。
    let active = true

    loadOpsDashboard({
      ...(input.days === undefined ? {} : { days: input.days }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
      shop: input.shop,
    })
      .then((data) => {
        if (active) setEntry({ key, state: { status: 'ready', data } })
      })
      .catch((error: unknown) => {
        if (!active) return
        setEntry({
          key,
          state: {
            status: 'error',
            error: error instanceof ApiError ? error : new ApiError(0, 'unknown', '加载失败', null),
          },
        })
      })

    return () => {
      active = false
    }
  }, [input.days, input.from, input.to, input.shop, input.enabled, key])

  return {
    state,
    reload: () => {
      setTicket((value) => value + 1)
    },
  }
}

/**
 * 采集批次。**按需加载**：健康面板默认收起，展开时才请求。
 *
 * 收益是「没有 `ops.collect.read` 的账号」不会在进页面时吃一个 403，也不会产生
 * 一次没人看的请求。
 *
 * 状态推导方式与上面相同：未启用即 `idle`，指纹不匹配即 `loading`。
 * 加载失败按「拿不到」处理（`data: null`），不把整页拖进错误态 —— 健康面板是
 * 可选信息，它失败不该挡住数据本身。
 */
export type OpsHealthState =
  { status: 'idle' } | { status: 'loading' } | { status: 'ready'; data: OpsHealthResponse | null }

type HealthEntry = { key: string; data: OpsHealthResponse | null }

export function useOpsHealth(input: { shop: string | null; enabled: boolean }): {
  state: OpsHealthState
  reload: () => void
} {
  const [ticket, setTicket] = useState(0)
  const [entry, setEntry] = useState<HealthEntry | null>(null)

  const key = [input.shop ?? '', ticket].join('|')
  const state: OpsHealthState = !input.enabled
    ? { status: 'idle' }
    : entry !== null && entry.key === key
      ? { status: 'ready', data: entry.data }
      : { status: 'loading' }

  useEffect(() => {
    if (!input.enabled) return
    let active = true

    loadOpsHealth({ shop: input.shop, limit: 20 })
      .then((data) => {
        if (active) setEntry({ key, data })
      })
      .catch(() => {
        if (active) setEntry({ key, data: null })
      })

    return () => {
      active = false
    }
  }, [input.shop, input.enabled, key])

  return {
    state,
    reload: () => {
      setTicket((value) => value + 1)
    },
  }
}
