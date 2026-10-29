import { useCallback, useEffect, useRef, useState } from 'react'

import { CASE_ASSET_VERSION, caseAssetFiles, type CaseAssetFile } from './case-catalog'
import {
  adoptDirectory,
  clearCachedFiles,
  isCacheSupported,
  pickDirectory,
  planSync,
  readThumb,
  requestPermission,
  restoreCache,
  saveHandle,
  saveMeta,
  summarize,
  writeThumb,
  type CaseCacheMeta,
  type CaseCacheState,
  type DirectoryHandle,
} from './case-asset-cache'

/**
 * 案例图片的本地缓存状态与缩略图解析。
 *
 * **两条地址，两个时机：**
 *   - 缩略图（320px）在打开品类图集时同步到用户选的本地文件夹，之后从本地读，
 *     `indexedDB` 里只存「哪个文件是哪张图」。断网也能看图集。
 *   - 原图（1000px）不预同步，用户点开放大时才从那一条 `<img>` 请求一次。它由浏览器的
 *     HTTP 缓存兜底，页面不再自己管一份。
 *
 * **缓存不是必需条件。** 没选目录、浏览器不支持、授权过期、网断了 —— 每种情况都有一条
 * 明确的回落路径，最差也就是退回「直接加载内置图」，与加这个功能之前的体验一样。
 * 一条会让人「什么都看不见」的缓存还不如没有。
 */

/**
 * 恢复缓存的入口只跑一次。
 *
 * 图集弹窗与设置页可能同时挂载，各自 restore 一次会读两遍 IndexedDB、并且可能拿到
 * 两份不同的 meta。用模块级的 promise 归并：谁先来谁发起，后来者等同一个结果。
 */
let restorePromise: ReturnType<typeof restoreCache> | null = null

function restoreOnce(): ReturnType<typeof restoreCache> {
  restorePromise ??= restoreCache()
  return restorePromise
}

/** 重新授权或换了目录之后要让下一次挂载重新读，因此提供一个失效入口。 */
function invalidateRestore(): void {
  restorePromise = null
}

export type CaseCacheHandle = {
  state: CaseCacheState
  /** 首屏是否还在读 IndexedDB。 */
  preparing: boolean
  /** 选择目录。返回 true 表示已认下来（写探针成功）。 */
  chooseDirectory: () => Promise<boolean>
  /** 重新要一次授权。**必须在用户手势里调用**。 */
  grant: () => Promise<boolean>
  /** 清空当前目录里我们自己写过的文件。 */
  clear: () => Promise<boolean>
  /** 把当前品类的缩略图同步到本地。`saving` 为真时它会自己排队不做。 */
  syncCategory: (categoryId: string) => Promise<void>
  /** 同步进度：已完成 / 总数。没有在同步时为 null。 */
  progress: { done: number; total: number } | null
  /** 本品的缩略图对象地址表。没有的条目走网络。 */
  thumbs: ReadonlyMap<string, string>
  /** 最近一次失败的原因。 */
  message: string | null
  dismissMessage: () => void
}

/**
 * @param categoryId 当前要解析缩略图的品类。`null` 表示只关心缓存状态（设置页用）。
 * @param enabled 是否处于「需要缩略图」的界面（图集开着）。关掉时不读盘、不同步。
 */
export function useCaseAssets(categoryId: string | null, enabled: boolean): CaseCacheHandle {
  const [state, setState] = useState<CaseCacheState>({
    status: isCacheSupported() ? 'unset' : 'unsupported',
    directoryName: null,
    fileCount: 0,
    bytes: 0,
    lastSyncedAt: null,
    detail: null,
  })
  const [preparing, setPreparing] = useState(enabled)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [thumbs, setThumbs] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [message, setMessage] = useState<string | null>(null)

  const handleRef = useRef<DirectoryHandle | null>(null)
  const metaRef = useRef<CaseCacheMeta>({ version: '', files: {}, lastSyncedAt: null })
  /** 同步互斥。图集重开、换品类、设置页点重同步可能同时要求写盘，串行化的开销可以忽略。 */
  const syncingRef = useRef(false)
  /** 已创建的 object URL，替换或卸载时 revoke —— 不 revoke 就是一次内存泄漏。 */
  const urlsRef = useRef<string[]>([])

  const applyThumbs = useCallback((next: Map<string, string>) => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url)
    urlsRef.current = [...next.values()]
    setThumbs(next)
  }, [])

  /**
   * 写一次状态。`status` 允许传一个函数，取当前值来算下一个 —— 同步的收尾要把
   * 「unset 变成 ready」，而它在自己的回调里读不到最新的 state（闭包是旧的），
   * 用函数式更新才不必把 `state` 写进依赖、进而让同步函数每次渲染都重建。
   */
  const publish = useCallback(
    (
      status:
        | CaseCacheState['status']
        | ((current: CaseCacheState['status']) => CaseCacheState['status']),
      detail: string | null,
    ) => {
      setState((current) => {
        const nextStatus = typeof status === 'function' ? status(current.status) : status
        return summarize(nextStatus, handleRef.current, metaRef.current, detail)
      })
    },
    [],
  )

  /**
   * 从磁盘读本品的缩略图。
   *
   * 逐张 await 而不是 Promise.all：目录句柄的读取在 Chromium 里是串行的，并发发起并不
   * 更快，反而可能把一次读失败变成一批同时失败。一张几毫秒，一个品类最多五六张。
   */
  const loadThumbs = useCallback(
    async (itemIds: readonly string[]) => {
      const handle = handleRef.current
      if (handle === null) {
        applyThumbs(new Map())
        return
      }
      const next = new Map<string, string>()
      for (const itemId of itemIds) {
        const blob = await readThumb(handle, itemId)
        if (blob !== null) next.set(itemId, URL.createObjectURL(blob))
      }
      applyThumbs(next)
    },
    [applyThumbs],
  )

  const syncCategory = useCallback(
    async (targetCategoryId: string) => {
      const handle = handleRef.current
      if (handle === null || syncingRef.current) return
      syncingRef.current = true
      try {
        const files = caseAssetFiles().filter((file) => file.categoryId === targetCategoryId)
        const plan = planSync(files, metaRef.current, CASE_ASSET_VERSION)
        if (plan.toWrite.length === 0) {
          publish((current) => (current === 'unset' ? 'ready' : current), null)
          return
        }

        setProgress({ done: 0, total: plan.toWrite.length })
        // 版本变了就整批重来：旧条目的文件名与新内容可能已经对不上（同一张图被换过）。
        const nextFiles: CaseCacheMeta['files'] = plan.reset ? {} : { ...metaRef.current.files }
        for (let index = 0; index < plan.toWrite.length; index += 1) {
          const file = plan.toWrite[index]
          if (file === undefined) continue
          const blob = await fetchThumb(file)
          const bytes = await writeThumb(handle, file.id, blob)
          nextFiles[file.id] = { bytes, at: new Date().toISOString() }
          setProgress({ done: index + 1, total: plan.toWrite.length })
        }
        metaRef.current = {
          version: CASE_ASSET_VERSION,
          files: nextFiles,
          lastSyncedAt: new Date().toISOString(),
        }
        await saveMeta(metaRef.current)
        publish('ready', null)
        await loadThumbs(files.map((file) => file.id))
      } catch (error) {
        setMessage(describeCacheError(error, '同步缩略图失败'))
        // 失败不改 status：目录本身还是好的，只是这一轮没写完。下次打开会接着补。
      } finally {
        setProgress(null)
        syncingRef.current = false
      }
    },
    [loadThumbs, publish],
  )

  // 恢复缓存状态。只在需要的时候跑一次 —— 设置页与图集都会用到。
  useEffect(() => {
    let active = true
    restoreOnce()
      .then(async (restored) => {
        if (!active) return
        handleRef.current = restored.handle
        metaRef.current = restored.meta
        if (restored.handle === null) {
          publish(isCacheSupported() ? 'unset' : 'unsupported', null)
          return
        }
        if (restored.permission === 'granted') {
          publish('ready', null)
          return
        }
        // 授权过期。**不能在这里自动请求** —— 那需要用户手势，effect 里调用只会拿到
        // denied，而 denied 看起来像用户拒绝了他根本没见过的弹窗。
        publish('permission', '需要重新授权才能读写本地缓存')
      })
      .catch(() => {
        if (active) publish(isCacheSupported() ? 'unset' : 'unsupported', null)
      })
      .finally(() => {
        if (active) setPreparing(false)
      })
    return () => {
      active = false
    }
  }, [publish])

  // 图集打开时：先读盘（快），再检查要不要补同步。
  useEffect(() => {
    if (!enabled || categoryId === null) return
    const files = caseAssetFiles().filter((file) => file.categoryId === categoryId)

    let active = true
    ;(async () => {
      // 等状态就绪（最多一次 IndexedDB 读取的时间）。
      await restoreOnce().catch(() => null)
      if (!active) return
      await loadThumbs(files.map((file) => file.id))
      if (!active) return
      if (handleRef.current !== null) await syncCategory(categoryId)
    })().catch(() => {
      // 这里失败不影响看图：thumbs 为空时组件会回落到网络地址。
    })

    return () => {
      active = false
    }
    // 只依赖品类与开关：`loadThumbs` 与 `syncCategory` 都是稳定回调（依赖里没有会变的
    // state），读盘与同步本身也都是幂等的，重复跑一次不会写出第二份文件。
  }, [categoryId, enabled, loadThumbs, syncCategory])

  useEffect(() => {
    return () => {
      for (const url of urlsRef.current) URL.revokeObjectURL(url)
      urlsRef.current = []
    }
  }, [])

  const chooseDirectory = useCallback(async (): Promise<boolean> => {
    const handle = await pickDirectory()
    if (handle === null) return false
    const adopted = await adoptDirectory(handle)
    if (!adopted.ok) {
      setMessage(describeCacheError(adopted.detail, '这个文件夹不可写'))
      return false
    }
    handleRef.current = handle
    await saveHandle(handle)
    // **换目录等于重新同步，不是迁移。** 新目录里没有旧文件，把 meta 清空才能让
    // planSync 从头写一遍；不清空的话它会以为「已经缓存过了」而全部跳过，用户看到的
    // 是一个永远空着的文件夹。旧目录里的文件**不删** —— 那是用户自己的文件系统，
    // 我们只在被明确要求「清除缓存」时删自己写过的那些。
    metaRef.current = { version: '', files: {}, lastSyncedAt: null }
    await saveMeta(metaRef.current)
    invalidateRestore()
    publish('ready', null)
    applyThumbs(new Map())
    setMessage(null)
    if (categoryId !== null) await syncCategory(categoryId)
    return true
  }, [applyThumbs, categoryId, publish, syncCategory])

  const grant = useCallback(async (): Promise<boolean> => {
    const handle = handleRef.current
    if (handle === null) return false
    const permission = await requestPermission(handle)
    if (permission !== 'granted') {
      publish('permission', '浏览器没有授予读写权限')
      return false
    }
    publish('ready', null)
    if (categoryId !== null) await syncCategory(categoryId)
    return true
  }, [categoryId, publish, syncCategory])

  const clear = useCallback(async (): Promise<boolean> => {
    const handle = handleRef.current
    if (handle === null) return false
    const result = await clearCachedFiles(handle, metaRef.current)
    metaRef.current = { version: '', files: {}, lastSyncedAt: null }
    await saveMeta(metaRef.current)
    applyThumbs(new Map())
    publish('ready', `已清理 ${result.removed} 个文件`)
    return true
  }, [applyThumbs, publish])

  const dismissMessage = useCallback(() => {
    setMessage(null)
  }, [])

  return {
    state,
    preparing,
    chooseDirectory,
    grant,
    clear,
    syncCategory,
    progress,
    thumbs,
    message,
    dismissMessage,
  }
}

/** 取一张缩略图的字节。失败时抛错，由调用方统一处理。 */
async function fetchThumb(file: CaseAssetFile): Promise<Blob> {
  const response = await fetch(file.thumb, { cache: 'force-cache' })
  if (!response.ok) throw new Error(`缩略图下载失败（HTTP ${response.status}）`)
  return await response.blob()
}

function describeCacheError(error: unknown, fallback: string): string {
  if (typeof error === 'string') return `${fallback}：${error}`
  if (error instanceof Error && error.message !== '') return `${fallback}：${error.message}`
  return fallback
}
