/**
 * 桌面更新通道的 React 侧接线（T7-02b）。
 *
 * ## 为什么 hook 与判定逻辑分两个文件
 *
 * 与 `use-version-check.ts` / `version-check.ts` 的分工完全同款，理由也是那两条：
 * 纯判定要在 Node 里直接跑（`test/desktop-update.test.mjs`），而这个文件依赖
 * `react` 与 `window`；以及 react-refresh 无法在一个同时导出组件与 hook 的文件里
 * 确定该保留哪一部分的状态。
 *
 * ## 它比版本检查多出来的两件事
 *
 * 1. **轮询。** `GET /api/version` 是一次请求一个答案，而更新通道是**有过程的**：
 *    检查 → 下载（带进度）→ 就绪。主进程那边状态在变，而 IPC 没有推送通道，
 *    只能按 `updatePollIntervalMs` 给的节奏去问。间隔是自适应的，理由见那个函数。
 *
 * 2. **动作。** 版本检查那一行点下去只是刷新页面；这里点下去会**让应用退出并装上新版**。
 *    所以这一层要能分辨「按了有没有用」，并在没用的时候说出来（见 `install`）。
 *
 * ## 「正在检查」只在用户主动触发时显示
 *
 * 主进程在启动时就会查一次，那一刻状态是 `checking`。如果照实渲染，每次开应用都会
 * 在顶栏闪一下「正在检查更新…」—— 那是一条几十毫秒的、用户没有要求过的信息，
 * 闪一下比不显示更让人分心。而用户点了「重试」之后，同一个 `checking` 就是**必需的
 * 反馈**：没有它，点下去那一秒界面上什么都不会发生。
 *
 * 所以判据不是「状态是不是 checking」，而是「这一轮是不是用户主动发起的」——
 * 即下面那个 `busy`。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  UPDATE_RECHECK_MS,
  type DesktopUpdateStatus,
  type DesktopUpdateView,
  buildDesktopUpdateView,
  isSameUpdateStatus,
  parseDesktopUpdateStatus,
  updatePollIntervalMs,
} from './desktop-update'
import { currentHost } from './host'

/**
 * 宿主，模块加载时取一次。
 *
 * 预加载脚本在页面脚本之前执行，所以到这一行时桥已经在了；而宿主在一次会话里不会变
 * （外壳不会在某次刷新后变成浏览器），每次渲染重读只会多一次全局访问。
 */
const HOST = currentHost()

/**
 * 「点了重启更新，但应用没有退出」的兜底时限。
 *
 * `installUpdate()` 成功之后进程就会开始退出流程，正常情况下这个定时器永远跑不到。
 * 留着它是因为**一个永远停在「正在重启」上的按钮比一个还能再按一次的按钮糟得多**：
 * 前者让人只能去任务管理器，后者最多是白点一下。
 */
const INSTALL_WATCHDOG_MS = 20_000

/** 取桥。拿不到（浏览器、或预加载没跑起来）时返回 `undefined`。 */
function desktopBridge(): Window['fanheDesktop'] | undefined {
  if (typeof window === 'undefined') return undefined
  return window.fanheDesktop
}

export type DesktopUpdateControls = {
  /** 顶栏那一块该显示什么。`hidden` 表示不渲染。 */
  view: DesktopUpdateView
  /**
   * 主动查一次（只检查，不下载）。
   *
   * 单独暴露出来是给账号菜单里的「检查更新」用的：用户想手动确认时，
   * 不该逼他重启应用 —— 而重启是 0.3.4 之前唯一能触发检查的办法。
   */
  check: () => Promise<void>
  /**
   * 执行视图对应的动作：`available` 时开始下载，`ready` 时装并重启，
   * `failed` 时重查。其余视图下是空操作。
   */
  act: () => void
  /** 有动作正在进行中（下载请求已发出但进度还没回来、或正在安装）。 */
  busy: boolean
}

/**
 * 更新通道的状态与动作，供顶栏消费。
 *
 * 浏览器宿主下**一次请求都不发**：那里没有更新通道（页面来自服务端，刷新即最新），
 * 而 `view` 也恒为 `hidden`（判据在 `buildDesktopUpdateView`）。
 */
export function useDesktopUpdate(): DesktopUpdateControls {
  const [status, setStatus] = useState<DesktopUpdateStatus | null>(null)
  /**
   * 用户主动发起的动作正在进行中。
   *
   * 兼作两个用途：让「正在检查」可见（见文件头），以及让按钮在动作期间不可重复点。
   */
  const [busy, setBusy] = useState(false)

  /**
   * 最新状态的一份引用。
   *
   * 给「半小时重查一次」那个定时器读，**避免把 `status` 写进它的依赖数组** ——
   * 写了的话每次状态变化都会重建定时器，那个半小时的计时会被无限推后，于是它
   * 永远不会真的触发。这是一个不会报错、只会静默失效的写法。
   *
   * **在 effect 里写而不是在渲染期写**：渲染期改 ref 是 React 明令禁止的
   * （并发渲染下同一次渲染可能被丢弃或重放，ref 会留下一个从未真正提交过的值）。
   * effect 在提交之后跑，读到的是已经落地的状态。
   */
  const latest = useRef<DesktopUpdateStatus | null>(null)
  useEffect(() => {
    latest.current = status
  }, [status])

  /**
   * 每秒走一格的本地时钟。
   *
   * 下载中界面上有三样东西**不随状态变化而变化**：已用时间、剩余时间、以及「停住
   * 多久了」。它们只随真实时间推进，而轮询在内容没变时会保留同一个状态引用（见
   * `isSameUpdateStatus`），于是不会触发重渲染 —— 没有这个时钟，一次卡顿会让
   * 「已用 00:18」停在 00:18，看起来像界面死了。
   *
   * 只在「有东西在动」时开：`available` 是等用户点、`downloading` 是正在下，两者
   * 都可能停在原地等一会儿；空闲时每秒重渲染一次顶栏是白烧 CPU。
   */
  const [now, setNow] = useState(() => Date.now())
  const downloading =
    status !== null && (status.phase === 'downloading' || status.phase === 'available')
  useEffect(() => {
    if (HOST !== 'desktop' || !downloading) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [downloading])

  /**
   * 只读一次当前状态，不触发检查。
   *
   * **写成 `.then` 而不是 `async`/`await`**，与 `use-version-check.ts` 的 `refresh`
   * 同款：`setStatus` 落在回调里而不是 effect 体里。`react-hooks/set-state-in-effect`
   * 会把「effect 里调一个可能直接 setState 的函数」报成级联渲染，而 `await` 之后
   * 的 `setStatus` 对那条规则来说与「直接调用」看不出区别。
   */
  const refresh = useCallback((): void => {
    const bridge = desktopBridge()
    if (bridge === undefined) return
    void bridge
      .getUpdateStatus()
      .then((payload) => {
        const next = parseDesktopUpdateStatus(payload)
        setStatus((current) => (isSameUpdateStatus(current, next) ? current : next))
      })
      .catch(() => {
        // 拿不到就保持原样。更新提示是非关键路径，它不该让顶栏崩掉，也不该把
        // 已经显示出来的「已就绪」抹掉 —— 那会让用户错过一次真正的更新。
      })
  }, [])

  /** 主动查一次（只检查，不下载、不安装）。 */
  const runCheck = useCallback(async (): Promise<void> => {
    const bridge = desktopBridge()
    if (bridge === undefined) return
    setBusy(true)
    try {
      const next = parseDesktopUpdateStatus(await bridge.checkForUpdates())
      setStatus((current) => (isSameUpdateStatus(current, next) ? current : next))
    } catch {
      // 同上：失败的表现是「没有提示」，不是崩掉。
    } finally {
      setBusy(false)
    }
  }, [])

  /**
   * 开始下载已发现的新版（0.1.6）。
   *
   * 主进程**不等下载完就返回**，所以这里拿到的仍是 `available`；真正的 `downloading`
   * 要等第一次进度事件。中间这一小段靠 `busy` 兜住：按钮置灰、文案换成「正在开始…」，
   * 否则用户会以为没点上而连点几次。
   */
  const download = useCallback(async (): Promise<void> => {
    const bridge = desktopBridge()
    if (bridge === undefined) return
    setBusy(true)
    try {
      const next = parseDesktopUpdateStatus(await bridge.downloadUpdate())
      setStatus((current) => (isSameUpdateStatus(current, next) ? current : next))
    } catch {
      // 同 `runCheck`：失败的表现交给轮询到的 `error` 态，不在这里弹东西。
    } finally {
      setBusy(false)
    }
  }, [])

  /** 装已下载的新版并退出应用。 */
  const install = useCallback(async (): Promise<void> => {
    const bridge = desktopBridge()
    if (bridge === undefined) return
    setBusy(true)
    try {
      const result = await bridge.installUpdate()
      if (result.ok) {
        // 进程正在退出，**不要**把 busy 放掉：那一瞬间按钮上写「正在重启」是对的。
        // 兜底定时器负责「其实没退出」的情况。
        window.setTimeout(() => {
          setBusy(false)
          void refresh()
        }, INSTALL_WATCHDOG_MS)
        return
      }

      // 最常见的失败是开发态外壳：那里没有 `app-update.yml`，通道不可用，
      // 点下去什么都不会发生。不静默 —— 打一行说明并重读状态，让人至少知道
      // 刚才那一下没生效。一个点了没反应、也没有任何痕迹的按钮，会让人以为
      // 整个更新功能坏了。
      console.warn(`[update] 未执行安装（${result.reason}）：${result.detail}`)
      setBusy(false)
      refresh()
    } catch (error) {
      console.warn(
        `[update] 安装通道调用失败：${error instanceof Error ? error.message : String(error)}`,
      )
      setBusy(false)
    }
  }, [refresh])

  // 挂载时读一次当前状态（主进程启动时已经查过一轮，这里只是把它取回来）。
  useEffect(() => {
    if (HOST !== 'desktop') return
    refresh()
  }, [refresh])

  // 自适应轮询：间隔由当前阶段决定，`0` 表示停止。
  useEffect(() => {
    if (HOST !== 'desktop') return
    const interval = updatePollIntervalMs(status)
    if (interval === 0) return
    const timer = window.setTimeout(refresh, interval)
    return () => window.clearTimeout(timer)
  }, [status, refresh])

  // 长时间开着时自己重查一次（主进程只在启动时查）。
  useEffect(() => {
    if (HOST !== 'desktop') return
    const timer = window.setInterval(() => {
      const current = latest.current
      // 已经在一条路上（正在查、正在下、已下好）就不要插一脚：那些阶段重查换不来
      // 新信息，只会多一次到 GitHub 的请求。
      if (
        current !== null &&
        (current.phase === 'checking' ||
          current.phase === 'available' ||
          current.phase === 'downloading' ||
          current.phase === 'downloaded')
      ) {
        return
      }
      void runCheck()
    }, UPDATE_RECHECK_MS)
    return () => window.clearInterval(timer)
  }, [runCheck])

  // `status` 在内容没变时是同一个引用（`isSameUpdateStatus` 保证），所以这两个
  // `useMemo` 在空闲时不会每轮都重算 —— 否则 `view` 每渲染换一个新对象，
  // 下面 `act` 的依赖也就每渲染都变，白让消费它的按钮失效一次 memo。
  const mapped = useMemo(() => buildDesktopUpdateView(status, HOST, now), [status, now])
  const view = useMemo<DesktopUpdateView>(
    // 「正在检查」只在用户主动触发时显示，理由见文件头。
    () => (mapped.kind === 'checking' && !busy ? { kind: 'hidden' } : mapped),
    [mapped, busy],
  )

  const act = useCallback((): void => {
    if (view.kind === 'available') {
      void download()
      return
    }
    if (view.kind === 'ready') {
      void install()
      return
    }
    if (view.kind === 'failed') void runCheck()
  }, [view, download, install, runCheck])

  return { view, act, busy, check: runCheck }
}
