import type { OpsHealthResponse, OpsShopBoardsResponse } from '@fanhe/shared'
import { useEffect, useState } from 'react'

import { ApiError } from './api'
import {
  dashboardKey,
  dashboardRangeKey,
  resolveDashboardState,
  type DashboardEntry,
  type OpsLoadState,
} from './ops-load-state'
import { loadOpsDashboard, loadOpsHealth, loadOpsShopBoards } from './ops'

export type { OpsLoadState }

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
 * **店铺不进「区间指纹」**：换店只是同一页换一个人看，让内容区整块卸载会塌陷页面
 * 高度、把滚动位置顶到最上面。规则与理由见 `ops-load-state.ts`。
 *
 * 空态不在这里判：接口返回 200 且 `dailyDays === 0` 也是一种「成功」，而空态该
 * 说什么（还没采集、还是这段时间没数据）取决于页头选中的区间 —— 那是界面的判断。
 */

export function useOpsDashboard(input: {
  days?: number
  from?: string
  to?: string
  shop: string | null
  enabled: boolean
}): { state: OpsLoadState; reload: () => void } {
  const [ticket, setTicket] = useState(0)
  /*
   * 静默重取的计数器。它**不进指纹** —— 指纹一变界面就回到加载态，而静默重取的
   * 全部意义就是「不打断已经显示出来的内容」。取到新数据后指纹不变，界面原地替换
   * 数值；取不到就保留旧数据，靠新鲜度标签表达「这份数据是几点的」。
   */
  const [refreshToken, setRefreshToken] = useState(0)
  const [entry, setEntry] = useState<DashboardEntry | null>(null)

  const key = dashboardKey(input, ticket)
  const rangeKey = dashboardRangeKey(input, ticket)
  /*
   * 推导而非写入。规则本身在 `ops-load-state.ts`：**只有店铺变了不进加载态**，
   * 否则点一下店铺卡，内容区整块卸载、页面高度塌陷，滚动位置会被浏览器钳到 0。
   */
  const state: OpsLoadState = resolveDashboardState(entry, key, rangeKey)

  /*
   * 切回这个标签页时静默重取一次。
   *
   * 运维数据一天变一次，但它「什么时候变的」没人能预知 —— 计划任务可能在凌晨跑，
   * 也可能因为登录态失效被推迟到上午。原来页面只在挂载与参数变化时取一次，挂着
   * 一整个上午的窗口会一直显示昨天的数，而界面没有任何提示说它是旧的。
   *
   * 只在 `visible` 时触发：后台标签页重取没有意义，还会在用户切回来的一瞬间
   * 抢带宽。不上 SSE / WebSocket —— 一天一次的数据不值得三套长连接逻辑。
   */
  useEffect(() => {
    if (!input.enabled) return
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') setRefreshToken((value) => value + 1)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [input.enabled])

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
        if (active) setEntry({ key, rangeKey, state: { status: 'ready', data } })
      })
      .catch((error: unknown) => {
        if (!active) return
        setEntry((prev) => {
          /*
           * 静默重取失败时保留已有数据。用户看到的是「上一次成功的数据 + 采集时间」，
           * 这比整页翻成错误态更接近事实：数据还在，只是这次没取到。真正的失败
           * （首次加载、换区间）仍然走错误态 —— 那时 prev 的指纹对不上。
           */
          if (prev !== null && prev.key === key && prev.state.status === 'ready') return prev
          return {
            key,
            rangeKey,
            state: {
              status: 'error',
              error:
                error instanceof ApiError ? error : new ApiError(0, 'unknown', '加载失败', null),
            },
          }
        })
      })

    return () => {
      active = false
    }
  }, [input.days, input.from, input.to, input.shop, input.enabled, key, rangeKey, refreshToken])

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
  /* 静默重取的计数器，不进指纹。理由同 `useOpsDashboard`：切回来时要换数，但不要
     把面板打回「加载中」。健康面板尤其需要这个 —— 它显示的就是「最近一次采集」。 */
  const [refreshToken, setRefreshToken] = useState(0)
  const [entry, setEntry] = useState<HealthEntry | null>(null)

  const key = [input.shop ?? '', ticket].join('|')
  const state: OpsHealthState = !input.enabled
    ? { status: 'idle' }
    : entry !== null && entry.key === key
      ? { status: 'ready', data: entry.data }
      : { status: 'loading' }

  useEffect(() => {
    if (!input.enabled) return
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') setRefreshToken((value) => value + 1)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [input.enabled])

  useEffect(() => {
    if (!input.enabled) return
    let active = true

    loadOpsHealth({ shop: input.shop, limit: 20 })
      .then((data) => {
        if (active) setEntry({ key, data })
      })
      .catch(() => {
        /* 静默重取失败时保留上一次的批次列表：它虽然旧，但仍然是真实发生过的记录，
           换成 null 会让面板显示「无记录」，那是在说一件没发生的事。 */
        if (active)
          setEntry((prev) => (prev !== null && prev.key === key ? prev : { key, data: null }))
      })

    return () => {
      active = false
    }
  }, [input.shop, input.enabled, key, refreshToken])

  return {
    state,
    reload: () => {
      setTicket((value) => value + 1)
    },
  }
}

/**
 * 五店并列指标带。
 *
 * 与看板读模型分开一次请求，是因为它的适用范围更大：七个入口都要显示店铺段控件
 * （切店是全局状态），而它的失败**不该影响主内容** —— 拿不到店铺清单时隐藏切换器，
 * 页面其余部分照常。失败按「没有」处理，与采集批次面板同一条取舍。
 */
export type OpsBoardsState =
  { status: 'loading' } | { status: 'ready'; data: OpsShopBoardsResponse | null }

type BoardsEntry = { key: string; data: OpsShopBoardsResponse | null }

export function useOpsShopBoards(input: {
  days?: number
  from?: string
  to?: string
  enabled: boolean
}): { state: OpsBoardsState; reload: () => void } {
  const [ticket, setTicket] = useState(0)
  const [entry, setEntry] = useState<BoardsEntry | null>(null)

  const key = [input.days ?? '', input.from ?? '', input.to ?? '', ticket].join('|')
  const state: OpsBoardsState =
    entry !== null && entry.key === key
      ? { status: 'ready', data: entry.data }
      : { status: 'loading' }

  useEffect(() => {
    if (!input.enabled) return
    let active = true

    loadOpsShopBoards({
      ...(input.days === undefined ? {} : { days: input.days }),
      ...(input.from === undefined ? {} : { from: input.from }),
      ...(input.to === undefined ? {} : { to: input.to }),
    })
      .then((data) => {
        if (active) setEntry({ key, data })
      })
      .catch(() => {
        if (active) setEntry({ key, data: null })
      })

    return () => {
      active = false
    }
  }, [input.days, input.from, input.to, input.enabled, key])

  return {
    state,
    reload: () => {
      setTicket((value) => value + 1)
    },
  }
}
