/**
 * 取「可执行文件的真实图标」（§2.9）。
 *
 * ## 为什么需要它
 *
 * 首页一键启动的实例卡此前用 `lib/launch-icons.ts` 里一套通用 lucide 图标（`MessagesSquare`
 * 代表 QQ、`MessageCircle` 代表微信……）。那套取舍当年写的是「不引品牌图标：商标有额外
 * 约束」，代价是**每一枚图标都认不出是哪个软件** —— 用户配了 7 条，卡片上 7 枚形状各异的
 * 通用图标，只有下面那行小字能区分。用户已拍板改为取程序自己的图标：与桌面快捷方式同源，
 * 图形元素与配色天然一致，且自定义程序也有图可出（不依赖我们预先认识它）。
 *
 * ## 为什么是 `app.getFileIcon` 而不是解析 exe 资源
 *
 * 它是 Electron 内置的、与系统「图标来源」同一套实现 —— 用户桌面上那个快捷方式显示的
 * 就是它。自己解析 PE 资源段要引入依赖、还要处理图标组里挑哪一帧，收益为零。
 *
 * ## 实测到的三条形态（决定下面这些写法）
 *
 * 1. **必须传 exe 路径，不能传 `.lnk`。** 实测 9 个不同的 `.lnk`（GitHub / Docker Desktop
 *    / Cloudflare…）返回的 PNG **逐字节相同**（md5 一致）—— 那是系统的「快捷方式」通用
 *    图标，不是目标的图标。我们手上有的也正好是 exe 路径（`profile.executablePath`）。
 * 2. **`size: 'large'` 出 48×48**（`normal` 32、`small` 16）。界面按 24 CSS px 渲染，
 *    在 2 倍屏上要 48 设备像素，所以取 `large`；用 `normal` 会在大屏上被放大发虚。
 * 3. **路径不存在时它返回的仍是「非空」图标**（系统的通用文件图标），`isEmpty()` 区分
 *    不出来。因此本模块**不用 `isEmpty()` 判「取没取到」**：路径失效时卡片上会显示系统
 *    的通用图标，而「这条路径不可用」由卡片右上角那个红点表达（两者是不同的事实，
 *    不该由同一个信号承担）。
 *
 * ## 边界
 *
 * - **只读、best-effort**：路径非法、取图标抛错，一律归成 `dataUrl: null`，绝不抛异常。
 *   图标是锦上添花，不能因为它失败而让界面渲染不出来。
 * - **只收绝对路径**：这条通道对渲染进程里的任何脚本开放，虽然读图标本身无害，但没有
 *   理由接受相对路径 —— 相对路径的解析基准是外壳进程的 cwd，结果不可预期。
 * - **成功才进缓存**：`null`（抛错）不缓存，否则一次瞬时失败会被钉死到进程退出。
 */

import { isAbsolute } from 'node:path'

/** 单条取图结果。`dataUrl` 为 null 表示这次没取到，调用方回落内置图标。 */
export type LaunchIconEntry = {
  path: string
  dataUrl: string | null
}

/**
 * 一次请求的路径条数上限。
 *
 * 首页托盘一排 6 枚、极端也就几十条；给个上限是为了不让渲染进程用一条 IPC 把主进程
 * 拖住（每条都是一次磁盘/系统调用）。超出部分直接丢弃 —— 丢的是「多出来的那些图标」，
 * 它们本来也回落内置图标，不影响可用性。
 */
export const MAX_ICON_PATHS = 64

/** 缓存条数上限。按最近使用淘汰，见 `createLaunchIconReader`。 */
export const ICON_CACHE_LIMIT = 256

/**
 * 归一化一条待取图标的路径（纯函数）。
 *
 * 非字符串、空白串、非绝对路径一律返回 null。返回的是**去掉首尾空白后的原样大小写**：
 * Windows 路径大小写不敏感，但回传时保持用户填的样子，便于界面把结果与请求对上。
 */
export function normalizeIconPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (text === '') return null
  return isAbsolute(text) ? text : null
}

/**
 * 归一化一批路径（纯函数）：逐条过 `normalizeIconPath`，去重（大小写不敏感），限长。
 *
 * 去重按小写比较 —— 同一条 exe 被两条配置指向（QQ 与 QQ2 同一份安装）时，只取一次图标。
 * 保留首次出现顺序，便于调用方按序把结果配回去。
 */
export function normalizeIconPaths(input: unknown, limit = MAX_ICON_PATHS): string[] {
  if (!Array.isArray(input)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of input) {
    const path = normalizeIconPath(item)
    if (path === null) continue
    const key = path.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
    if (out.length >= limit) break
  }
  return out
}

/** 取一枚图标。注入点：真实实现走 `app.getFileIcon`，单测给假实现。 */
export type IconFetcher = (path: string) => Promise<string | null>

export type LaunchIconReader = {
  /** 批量取图。入参**须已归一化**（见 `normalizeIconPaths`）。 */
  read(paths: readonly string[]): Promise<LaunchIconEntry[]>
}

/**
 * 造一个带缓存的取图器。
 *
 * 缓存按小写路径键、**只缓存取到的那次结果**：`null` 不写进去，因为「这次没取到」可能
 * 是瞬时的（文件正被占用、盘刚拔），钉住它会让用户重插盘之后图标永远不出来。
 *
 * 淘汰用「最近使用」：命中时先删再塞，让 Map 的插入顺序等价于使用顺序；超限时从头部
 * （最久未用）删。条数上限给得很宽松，正常规模（几十条配置）根本走不到淘汰。
 *
 * 并发不做合并：同一次 `read` 里路径已去重，而两次并发 `read` 撞上同一路径只是多取一次
 * 图标 —— 换来的是不必维护一张「进行中的 Promise」表，那点重复不值得。
 */
export function createLaunchIconReader(options: {
  fetchIcon: IconFetcher
  cacheLimit?: number
}): LaunchIconReader {
  const { fetchIcon } = options
  const cacheLimit = options.cacheLimit ?? ICON_CACHE_LIMIT
  const cache = new Map<string, string>()

  function remember(key: string, dataUrl: string): void {
    cache.delete(key)
    cache.set(key, dataUrl)
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next()
      if (oldest.done === true) break
      cache.delete(oldest.value)
    }
  }

  async function fetchOne(path: string): Promise<LaunchIconEntry> {
    const key = path.toLowerCase()
    const hit = cache.get(key)
    if (hit !== undefined) {
      remember(key, hit)
      return { path, dataUrl: hit }
    }
    try {
      const dataUrl = await fetchIcon(path)
      if (typeof dataUrl === 'string' && dataUrl !== '') {
        remember(key, dataUrl)
        return { path, dataUrl }
      }
      return { path, dataUrl: null }
    } catch {
      // 取图标失败不是错误状态：回落内置图标即可。不写缓存，下次还试。
      return { path, dataUrl: null }
    }
  }

  return {
    read: (paths) => Promise.all(paths.map((path) => fetchOne(path))),
  }
}
