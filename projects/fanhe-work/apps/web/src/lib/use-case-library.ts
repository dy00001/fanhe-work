import type { CaseLibrarySnapshot, CreateCaseUploadItem } from '@fanhe/shared'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from './api'
import {
  caseSaveExit,
  createCaseFolder,
  deleteCaseFolder,
  deleteCaseUpload,
  describeCaseSaveError,
  loadCaseLibrary,
  moveCaseItems,
  renameCaseFolder,
  uploadCaseImage,
} from './case-library'
import { applyMoveToSnapshot } from './case-library-display'

/**
 * 案例库的读写状态。
 *
 * **一条数据，四个拉取时机：** 打开图集、窗口重新获得焦点、图集开着时每 20 秒、以及
 * 写完一次之后。四个入口都收敛到同一个 effect（靠 `reloadToken` 触发），因此「另一台
 * 设备刚改过」在界面上表现为**自动刷新**，而不是「用户得手动点一下同步」。
 *
 * **不做离线队列。** 写失败时回滚到上一次成功的快照，把原因交给界面显示。理由：案例库
 * 的全部内容是「哪张图在哪个文件夹」，离线期间攒下的操作一旦与服务端冲突，正确的合并
 * 结果只有用户自己知道；与其猜，不如让他看到那句「保存失败」再重做一次 —— 重做一次
 * 整理的成本，远低于回来发现归属被默默改错。
 */

/**
 * 轮询间隔。
 *
 * 20 秒是「同一账号另一台设备改了，这一台肉眼能察觉」与「一个开着不动的弹窗不要太吵」
 * 之间的折中。它不是同步的唯一依据（窗口获得焦点时也会拉），只是兜底 —— 用户可能把
 * 两个窗口并排摆着，那种情形下没有焦点变化可依赖。
 */
const POLL_INTERVAL_MS = 20_000

export type CaseLibraryHandle = {
  /** 服务端最近一次给的快照。`null` 表示还没拉到。 */
  snapshot: CaseLibrarySnapshot | null
  /** 首屏是否还在等第一次响应。 */
  loading: boolean
  /** 是否有写操作在飞。界面据此显示「保存中…」并禁用会打架的按钮。 */
  saving: boolean
  /** 最近一次失败的原因，成功后自动清空。 */
  message: string | null
  dismissMessage: () => void
  /** 重拉一次。冲突（409）之后用它把状态对齐到服务端。 */
  refresh: () => void
  createFolder: (name: string) => Promise<boolean>
  renameFolder: (id: string, name: string) => Promise<boolean>
  deleteFolder: (id: string) => Promise<boolean>
  moveItems: (itemIds: readonly string[], folderId: string | null) => Promise<boolean>
  /**
   * 上传一张已经压好的图。`folderId` 是「当前筛选的文件夹」，新图直接落进去。
   *
   * 失败时**不抛异常**，只把原因写进 `message` —— 调用方是一个循环（一次选五张），
   * 抛出去会中断整批，而其中一张因为格式不对失败时，另外四张完全应该继续传。
   */
  uploadOne: (item: CreateCaseUploadItem, folderId: string | null) => Promise<boolean>
  /** 删除一张自己上传的图。静态清单里的图删不掉（服务端 404）。 */
  deleteUpload: (itemId: string) => Promise<boolean>
}

/**
 * @param categoryId 当前打开的品类。写操作都要带上它，服务端据此校验图片归属。
 * @param enabled 弹窗是否打开。关着的时候不轮询、不拉取 —— 否则首页一直挂着一条定时器。
 */
export function useCaseLibrary(categoryId: string, enabled: boolean): CaseLibraryHandle {
  const [snapshot, setSnapshot] = useState<CaseLibrarySnapshot | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  /**
   * 拉取令牌。加一即触发下面那个 effect 重跑。
   *
   * 用它而不是直接调用一个 `load()` 函数，是因为「在 effect 里同步调用一个会 setState
   * 的函数」会被 `react-hooks/set-state-in-effect` 拦下 —— 而这条规则指向的写法确实是
   * 更清楚的：拉取是「外部状态变了，我去同步」，天生就该由 effect 负责，令牌只是告诉
   * 它「又该同步了」。`use-ops-dashboard` 用的是同一个形状。
   */
  const [reloadToken, setReloadToken] = useState(0)

  /**
   * 快照的镜像。
   *
   * 回调里要读「现在这份是什么」——`useState` 的值在闭包里是那一次渲染的旧值，而
   * `useCallback` 依赖它会让每个回调都跟着重建。用 ref 存一份镜像，回调就只需要空依赖。
   * 写入口只有 `applySnapshot` 一处，镜像与 state 不会分叉。
   */
  const snapshotRef = useRef<CaseLibrarySnapshot | null>(null)
  /** 在飞的写操作数。拉取时若不为 0 就跳过 —— 否则会把乐观结果盖回旧值。 */
  const busyRef = useRef(0)

  const applySnapshot = useCallback((next: CaseLibrarySnapshot | null) => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])

  useEffect(() => {
    if (!enabled) return
    // 写操作在飞时跳过这一次：此时本地的乐观结果还没被服务端确认，用它去覆盖等于
    // 把刚做的动作抹掉。下一轮（20 秒后或下次聚焦）会补上。
    if (busyRef.current > 0) return

    // 卸载后回来的响应不该写状态。取消标记比 AbortController 简单，而这里没有需要
    // 真正中断的东西。
    let active = true

    loadCaseLibrary()
      .then((next) => {
        if (!active) return
        const current = snapshotRef.current
        // **只有修订号变了才替换。** 这条判断同时解决两件事：轮询不必每次触发重绘
        // （否则开着弹窗每 20 秒闪一下），以及「刚做完一次写、服务端回传的修订号
        // 已经是最新的」时聚焦事件不会白跑一遍。
        if (current === null || current.revision !== next.revision) applySnapshot(next)
        setMessage(null)
      })
      .catch((error: unknown) => {
        if (!active) return
        setMessage(describeCaseSaveError(error))
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [enabled, reloadToken, applySnapshot])

  useEffect(() => {
    if (!enabled) return

    const timer = window.setInterval(() => {
      setReloadToken((value) => value + 1)
    }, POLL_INTERVAL_MS)

    const trigger = () => {
      setReloadToken((value) => value + 1)
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') trigger()
    }
    // `focus` 与 `visibilitychange` 都听：从别的标签页切回来时前者不一定触发（焦点
    // 可能一直在窗口内）。两个都触发也不会重复拉到什么 —— 第二个请求拿到的修订号
    // 与第一个相同，判定没变就什么都不做。
    window.addEventListener('focus', trigger)
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', trigger)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled])

  /**
   * 跑一次写操作。
   *
   * @param optimistic 可选的本地预演快照。只有「移动」给了它 —— 建/改名/删除都要等
   *   服务端分配 id 或确认新名字，猜不出来；而移动的目标是确定的，本地先画出来能让
   *   点击立刻有反馈。
   *
   * 失败一律回滚到 `previous`。不回滚的话界面会保留一个服务端并不认可的状态，而它
   * 在下一次轮询时又会被改回去 —— 用户看到的是「刚才明明放进去了，怎么又回来了」。
   */
  const runWrite = useCallback(
    async (
      work: () => Promise<CaseLibrarySnapshot>,
      optimistic?: CaseLibrarySnapshot,
    ): Promise<boolean> => {
      const previous = snapshotRef.current
      busyRef.current += 1
      setSaving(true)
      if (optimistic !== undefined) applySnapshot(optimistic)
      let stale = false
      try {
        applySnapshot(await work())
        setMessage(null)
        return true
      } catch (error) {
        applySnapshot(previous)
        setMessage(describeCaseSaveError(error))
        // 409 / 404 说明本机这份已经过期（目标文件夹在别处被删了，或同名文件夹是别处
        // 刚建的）。回滚只把界面退回「操作前」，还没退回「服务端现在」——补一次拉取，
        // 让用户看到真实的归属，再决定要不要换个文件夹。
        stale = error instanceof ApiError && caseSaveExit(error) !== 'retry'
        return false
      } finally {
        busyRef.current -= 1
        if (busyRef.current === 0) setSaving(false)
        // 放在 finally 而不是 catch 里：effect 那边的第一个判断是在飞的写操作，
        // 而 catch 执行时 busyRef 还没减回去 —— 那一次拉取会被自己挡掉。
        if (stale) setReloadToken((value) => value + 1)
      }
    },
    [applySnapshot],
  )

  const createFolder = useCallback(
    (name: string) => runWrite(() => createCaseFolder({ categoryId, name })),
    [categoryId, runWrite],
  )

  const renameFolder = useCallback(
    (id: string, name: string) => runWrite(() => renameCaseFolder(id, name)),
    [runWrite],
  )

  const deleteFolder = useCallback((id: string) => runWrite(() => deleteCaseFolder(id)), [runWrite])

  const moveItems = useCallback(
    (itemIds: readonly string[], folderId: string | null) => {
      const current = snapshotRef.current
      const optimistic =
        current === null ? undefined : applyMoveToSnapshot(current, itemIds, folderId)
      return runWrite(() => moveCaseItems({ categoryId, itemIds, folderId }), optimistic)
    },
    [categoryId, runWrite],
  )

  const dismissMessage = useCallback(() => {
    setMessage(null)
  }, [])

  /**
   * 上传一张。
   *
   * 不复用 `runWrite` 的乐观预演：新图的 itemId 由服务端生成（含随机后缀），本地猜
   * 不出来；而「猜一个再换掉」会在网络慢时露出一张最后又消失的图。这里等响应回来
   * 就够快 —— 一张 200KB 的图在局域网里是几十毫秒。
   *
   * 但它仍要经过 `busyRef` 的计数：上传期间若有轮询回来，那份快照里还没有这张新图，
   * 覆盖上去会让刚传好的图闪一下不见。
   */
  const uploadOne = useCallback(
    (item: CreateCaseUploadItem, folderId: string | null) =>
      runWrite(() => uploadCaseImage({ categoryId, folderId, items: [item] })),
    [categoryId, runWrite],
  )

  const deleteUpload = useCallback(
    (itemId: string) => runWrite(() => deleteCaseUpload(itemId)),
    [runWrite],
  )

  const refresh = useCallback(() => {
    setReloadToken((value) => value + 1)
  }, [])

  return {
    snapshot,
    loading,
    saving,
    message,
    dismissMessage,
    refresh,
    createFolder,
    renameFolder,
    deleteFolder,
    moveItems,
    uploadOne,
    deleteUpload,
  }
}
