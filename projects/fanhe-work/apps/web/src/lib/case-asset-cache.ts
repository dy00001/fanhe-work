/**
 * 案例图片的本地缓存。
 *
 * **缓存落在用户自己选的文件夹里，不用浏览器存储。** 理由有三个：
 *   1. 用户能看见它 —— 「图片缓存在哪」这件事在资源管理器里能回答，不必翻 DevTools；
 *   2. 他能自己删、自己备份、必要时直接拷给别人；
 *   3. 清理浏览器数据不会把它一起清掉，而清掉之后下一次进图集要重新下载 1.6MB。
 *
 * 实现走 File System Access API（`showDirectoryPicker`）。选它而不是「输入一个路径字符串
 * 交给主进程去写」，是因为**这个能力在浏览器里与桌面外壳里是同一套代码**：外壳是
 * Chromium 44，两者都支持；而路径字符串方案只有外壳能用，浏览器里那条路要么不存在，
 * 要么得再写一套 IndexedDB 缓存。同一份缓存逻辑有两个实现，最终一定会分叉。
 *
 * 代价要说清楚：浏览器出于隐私不告诉页面绝对路径，只给文件夹名。因此界面上显示的是
 * 「文件夹名」，不是 `D:\梵禾\案例图`。这是这个 API 的固有限制，不是省事。
 *
 * **只缓存缩略图。** 高清原图按需从网络取（见 `use-case-assets.ts`）：一张原图 40KB
 * 左右、43 张就是 1.6MB，全cache 下来对看图体验没有帮助（用户一次只看一张），而它会让
 * 「同步」变成一次明显可感的批量下载。
 */

/** 缓存目录里的文件命名：`<itemId>.webp`。itemId 本身只含小写字母、数字与连字符。 */
const FILE_SUFFIX = '.webp'

/**
 * 探测文件归属用的标记文件。
 *
 * 用户可能把这个目录指到「桌面」或者某个已经放着资料的文件夹上。**清理缓存只删我们自己
 * 写进去的文件**，而「哪些是我们的」不能靠扩展名猜（那个目录里本来就可能有一堆 webp）。
 * 因此在目录里放一个标记文件，写入了它才认为这个目录是「我们的缓存目录」，清理时也只删
 * 标记里记录过、且名字符合规则的项。
 */
const MARKER_FILE = '.fanhe-case-cache.json'

export type CaseCachePermission = 'granted' | 'denied' | 'prompt'

/**
 * File System Access 的两个权限方法不在 `lib.dom` 里（它们还没进标准）。
 *
 * 只声明用到的那两个，并用可选方法的形式合进来：在还没有这个 API 的浏览器上，整个
 * 对象根本拿不到，`status` 会是 `unsupported`，这里的类型不会被真的调用。
 */
export type DirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'readwrite' }) => Promise<CaseCachePermission>
  requestPermission?: (descriptor: { mode: 'readwrite' }) => Promise<CaseCachePermission>
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string
      mode?: 'readwrite'
    }) => Promise<FileSystemDirectoryHandle>
  }
}

export type CaseCacheStatus =
  /** 还没选过目录。此时缩略图直接走网络，功能不受影响。 */
  | 'unset'
  /** 目录可用，读写均正常。 */
  | 'ready'
  /** 目录还在，但授权过期了（浏览器重启后很常见）。需要一次用户手势重新授权。 */
  | 'permission'
  /** 浏览器不支持这个 API（Safari / Firefox）。 */
  | 'unsupported'
  /** 目录被删、被改名、或没权限写。 */
  | 'unavailable'

export type CaseCacheState = {
  status: CaseCacheStatus
  /** 目录名。浏览器只给名字，不给绝对路径。 */
  directoryName: string | null
  /** 已经缓存了多少张缩略图。 */
  fileCount: number
  /** 缓存占用字节数。 */
  bytes: number
  /** 上次同步完成的时间，ISO 8601；从没同步过为 null。 */
  lastSyncedAt: string | null
  /** 一句可显示的原因，`ready` 与 `unset` 时为 null。 */
  detail: string | null
}

export type CaseCacheMeta = {
  /** 缓存对应的图片集指纹。与当前清单不一致时全量重同步。 */
  version: string
  files: Record<string, { bytes: number; at: string }>
  lastSyncedAt: string | null
}

const EMPTY_META: CaseCacheMeta = { version: '', files: {}, lastSyncedAt: null }

// ---------------------------------------------------------------------------
// IndexedDB：只存两样东西 —— 目录句柄，和上面那份 meta
// ---------------------------------------------------------------------------
//
// 不引 idb 之类的库：这里只用到一个键值仓库、四次调用，一个四十行的封装够了，而多一个
// 依赖会让「这一层到底存了什么」需要去读别人的源码才知道。
//
// **句柄本身是可以被结构化克隆的。** 这是把目录选择持久化的唯一办法 —— 存路径字符串
// 再重新解析在浏览器里做不到（拿不到绝对路径）。

const DB_NAME = 'fanhe-case-assets'
const DB_VERSION = 1
const STORE = 'kv'
const HANDLE_KEY = 'directory'
const META_KEY = 'meta'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error('无法打开本地缓存数据库'))
    }
  })
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb()
  try {
    return await new Promise<T | null>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      request.onsuccess = () => {
        resolve((request.result as T | undefined) ?? null)
      }
      request.onerror = () => {
        reject(request.error ?? new Error('读取本地缓存失败'))
      }
    })
  } finally {
    db.close()
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, key)
      tx.oncomplete = () => {
        resolve()
      }
      tx.onerror = () => {
        reject(tx.error ?? new Error('写入本地缓存失败'))
      }
    })
  } finally {
    db.close()
  }
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).delete(key)
      tx.oncomplete = () => {
        resolve()
      }
      tx.onerror = () => {
        reject(tx.error ?? new Error('清理本地缓存失败'))
      }
    })
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// 对外：状态、选择目录、读写、迁移
// ---------------------------------------------------------------------------

export function isCacheSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'
}

/** 读回上次选的目录。顺带查一次权限 —— 句柄在、权限过期是最常见的一种「看起来有缓存」。 */
export async function restoreCache(): Promise<{
  handle: DirectoryHandle | null
  meta: CaseCacheMeta
  permission: CaseCachePermission
}> {
  if (!isCacheSupported()) {
    return { handle: null, meta: EMPTY_META, permission: 'denied' }
  }
  const handle = await idbGet<DirectoryHandle>(HANDLE_KEY).catch(() => null)
  const meta = (await idbGet<CaseCacheMeta>(META_KEY).catch(() => null)) ?? EMPTY_META
  if (handle === null) return { handle: null, meta, permission: 'prompt' }
  const permission = await queryPermission(handle)
  return { handle, meta, permission }
}

export async function queryPermission(handle: DirectoryHandle): Promise<CaseCachePermission> {
  if (handle.queryPermission === undefined) return 'granted'
  try {
    return await handle.queryPermission({ mode: 'readwrite' })
  } catch {
    return 'denied'
  }
}

/**
 * 要一次授权。**必须在用户手势里调用** —— 浏览器的规则如此，放在 effect 里调只会拿到
 * `denied`，而那个 `denied` 看起来像「用户拒绝了」，实际是「调用方式不对」。
 */
export async function requestPermission(handle: DirectoryHandle): Promise<CaseCachePermission> {
  if (handle.requestPermission === undefined) return 'granted'
  try {
    return await handle.requestPermission({ mode: 'readwrite' })
  } catch {
    return 'denied'
  }
}

/** 弹目录选择器。取消时返回 null（用户按了取消不是错误）。 */
export async function pickDirectory(): Promise<DirectoryHandle | null> {
  if (!isCacheSupported() || window.showDirectoryPicker === undefined) return null
  try {
    const handle = (await window.showDirectoryPicker({
      id: 'fanhe-case-assets',
      mode: 'readwrite',
    })) as DirectoryHandle
    return handle
  } catch {
    // `AbortError`：用户点了取消。DOMException 的 name 在跨浏览器时写法不一，这里
    // 统一当作「没选」，不区分取消与失败 —— 对界面来说两者都是「目录没变」。
    return null
  }
}

/**
 * 把目录认下来：写一次探针文件。
 *
 * **这是路径校验里唯一真正有效的一步。** 权限状态 `granted` 只说明「你被允许访问」，
 * 不说明「这个目录现在可写」：只读挂载、被别的程序占用、磁盘满，都在写入那一刻才暴露。
 * 因此选完目录先写一个几十字节的探针，写不进去就当场判为不可用，并把可能残留的半个
 * 文件删掉。
 */
export async function adoptDirectory(
  handle: DirectoryHandle,
): Promise<{ ok: boolean; detail: string | null }> {
  try {
    const file = await handle.getFileHandle(MARKER_FILE, { create: true })
    const writable = await file.createWritable()
    await writable.write(
      JSON.stringify({
        app: 'fanhe-work',
        purpose: 'case-asset-cache',
        createdAt: new Date().toISOString(),
      }),
    )
    await writable.close()
    return { ok: true, detail: null }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : '目录不可写' }
  }
}

export async function saveHandle(handle: DirectoryHandle | null): Promise<void> {
  if (handle === null) {
    await idbDelete(HANDLE_KEY)
    return
  }
  await idbSet(HANDLE_KEY, handle)
}

export async function saveMeta(meta: CaseCacheMeta): Promise<void> {
  await idbSet(META_KEY, meta)
}

export function summarize(
  status: CaseCacheStatus,
  handle: DirectoryHandle | null,
  meta: CaseCacheMeta,
  detail: string | null,
): CaseCacheState {
  let bytes = 0
  for (const entry of Object.values(meta.files)) bytes += entry.bytes
  return {
    status,
    directoryName: handle?.name ?? null,
    fileCount: Object.keys(meta.files).length,
    bytes,
    lastSyncedAt: meta.lastSyncedAt,
    detail,
  }
}

/** 读一张缩略图。文件不在就返回 null —— 调用方据此回落到网络。 */
export async function readThumb(handle: DirectoryHandle, itemId: string): Promise<Blob | null> {
  try {
    const file = await handle.getFileHandle(`${itemId}${FILE_SUFFIX}`)
    return await file.getFile()
  } catch {
    return null
  }
}

export async function writeThumb(
  handle: DirectoryHandle,
  itemId: string,
  blob: Blob,
): Promise<number> {
  const file = await handle.getFileHandle(`${itemId}${FILE_SUFFIX}`, { create: true })
  const writable = await file.createWritable()
  await writable.write(blob)
  await writable.close()
  return blob.size
}

/**
 * 清缓存：**只删我们自己写过的文件**（按 meta 里的清单），删完把 meta 清空。
 *
 * 不遍历目录按扩展名删：用户完全可能把这个目录指到一个已有资料的文件夹上，
 * 一个「清理缓存」把别人的图删掉是灾难性的。meta 是唯一的删除依据。
 */
export async function clearCachedFiles(
  handle: DirectoryHandle,
  meta: CaseCacheMeta,
): Promise<{ removed: number; failed: number }> {
  let removed = 0
  let failed = 0
  for (const itemId of Object.keys(meta.files)) {
    try {
      await handle.removeEntry(`${itemId}${FILE_SUFFIX}`)
      removed += 1
    } catch {
      failed += 1
    }
  }
  return { removed, failed }
}

/**
 * 幂等的同步计划。
 *
 * 判断依据是「文件在不在 + 版本一致」，**不看单张文件的内容哈希**：缩略图只有几 KB，
 * 而一次重算哈希要读全部文件；版本号（图片集指纹）变了就整批重写，没变就只补缺失的。
 * 这是「够用且不会错」的那一档 —— 出错的方向只会是「多写了几个文件」。
 */
export function planSync<T extends { id: string }>(
  items: readonly T[],
  meta: CaseCacheMeta,
  version: string,
): { toWrite: T[]; toSkip: number; reset: boolean } {
  if (meta.version !== version) {
    return { toWrite: [...items], toSkip: 0, reset: true }
  }
  const toWrite: T[] = []
  let toSkip = 0
  for (const item of items) {
    if (meta.files[item.id] === undefined) toWrite.push(item)
    else toSkip += 1
  }
  return { toWrite, toSkip, reset: false }
}
