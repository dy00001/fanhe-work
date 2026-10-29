import {
  caseCoverItemId,
  type CaseFolder,
  type CaseLibrarySnapshot,
  type CasePlacement,
} from '@fanhe/shared'

// 只取类型：这是一条会被类型擦除吞掉的导入。**不能有运行期的相对导入** ——
// 前端测试用 Node 直接跑 `.ts`，而 Node 的 ESM 要求相对路径带扩展名（仓库风格不写）。
import type { CaseCategory } from './case-catalog'

/**
 * 案例库的展示规则。
 *
 * 全是纯函数，不引 React、不读 DOM、不碰网络 —— 理由与 `ops-display.ts` 相同：把这些
 * 规则写在组件里，验证它的唯一办法是打开浏览器点一遍；写成纯函数，「未归档是哪些」
 * 「文件夹里的张数对不对」这类断言就能在门禁里跑。
 *
 * **这里只做「把库里的归属关系套到静态清单上」这一件事。** 图片地址、标题、品类名
 * 都来自 `case-catalog.ts`（随前端分发的静态清单），服务端只回「哪张图在哪个文件夹」。
 * 两边各管一件事的后果是：新增一张图不需要任何接口或数据改动，界面自动就多一张。
 */

/**
 * 封面在案例库里的 itemId 由 `case-catalog` 给出（{@link caseCoverItemId}）。
 *
 * 常量放在清单那边，是因为缓存层也要用它拼缓存文件名 —— 两处各写一个 `-cover`，
 * 迟早会有一处写成 `-cover-art`，而表现只是「封面永远不缓存」。
 */

export type CaseAlbumItem = {
  /** 稳定 id。封面是 `${categoryId}-cover`，案例是清单里的 `cabinet-1` 这种。 */
  id: string
  /** 原图地址。放大时才加载它。 */
  src: string
  /** 缩略图地址。网格用它。 */
  thumb: string
  alt: string
  /** 所在文件夹 id。`null` = 未归档。 */
  folderId: string | null
}

export type CaseFolderGroup = {
  folder: CaseFolder
  items: readonly CaseAlbumItem[]
}

/**
 * 一张图在全量清单里的那一行。
 *
 * 之所以需要这份索引：跨品类移动之后，**目标品类的图集里会出现一张它自己的静态清单
 * 里没有的图**（`主卧-3` 被挪进「次卧 / 榻榻米」）。地址、标题只能从全局清单里取，
 * 而 `buildCaseLibraryView` 又不能直接 import `case-catalog` —— 前端测试用 Node 跑
 * 这些 `.ts`，运行期的相对导入会因为缺扩展名解析失败。
 *
 * 于是索引由调用方建好传进来（{@link buildCaseIndex}），本文件只认这个形状。
 */
export type CaseIndexEntry = {
  src: string
  thumb: string
  alt: string
  /** 这张图原本属于哪个品类。界面上用它标「来自主卧」。 */
  categoryId: string
}

export type CaseIndex = ReadonlyMap<string, CaseIndexEntry>

/**
 * 全量清单 → 索引。
 *
 * 键序即品类顺序、品类内顺序，`buildCaseLibraryView` 用它给「外来图」排序，因此这里
 * 的插入顺序有语义，不要改成无序结构。
 */
export function buildCaseIndex(categories: readonly CaseCategory[]): CaseIndex {
  const index = new Map<string, CaseIndexEntry>()
  for (const category of categories) {
    if (category.cover !== null) {
      const id = caseCoverItemId(category.id)
      // 封面同时充当自己的缩略图（它本来就是 800px、20KB 出头的小图）。
      index.set(id, {
        src: category.cover,
        thumb: category.cover,
        alt: `${category.name}封面`,
        categoryId: category.id,
      })
    }
    category.cases.forEach((slot, index_) => {
      if (slot.cover === null || slot.thumb === null) return
      index.set(slot.id, {
        src: slot.cover,
        thumb: slot.thumb,
        // 案例标题当前一律为空串（数据层不编名），回落到序号。
        alt: slot.title === '' ? `${category.name}案例 ${index_ + 1}` : slot.title,
        categoryId: category.id,
      })
    })
  }
  return index
}

/** 移动菜单里的一项：某个品类下的一个文件夹，以及它现在有多少张图。 */
export type CaseFolderOption = {
  folder: CaseFolder
  count: number
}

export type CaseCategoryFolderOptions = {
  categoryId: string
  categoryName: string
  folders: readonly CaseFolderOption[]
}

/**
 * 全部品类的文件夹，按品类分组 —— 移动菜单要能选到「任何品类的任何子文件夹」。
 *
 * 只列**有文件夹的品类**：13 个品类里大多数还没建过文件夹，全列出来会让菜单变成一长串
 * 空标题。顺序跟着 `categories`，与首页品类顺序一致，用户不用重新找。
 *
 * 张数按归属行统计，包含从别的品类挪进来的那些 —— 菜单上显示的数字必须与点进去看到的
 * 张数一致，否则用户会以为移动失败了。
 */
export function groupFoldersByCategory(
  snapshot: CaseLibrarySnapshot,
  categories: readonly CaseCategory[],
): readonly CaseCategoryFolderOptions[] {
  const counts = new Map<string, number>()
  for (const placement of snapshot.placements) {
    // 快照按约定不带 `folderId: null` 的行（「未归档」= 没有行），但类型允许。真遇到
    // 就跳过：把它计到某个不存在的文件夹上，只会让菜单里的数字对不上实际张数。
    if (placement.folderId === null) continue
    counts.set(placement.folderId, (counts.get(placement.folderId) ?? 0) + 1)
  }
  const groups: CaseCategoryFolderOptions[] = []
  for (const category of categories) {
    const folders = snapshot.folders.filter((folder) => folder.categoryId === category.id)
    if (folders.length === 0) continue
    groups.push({
      categoryId: category.id,
      categoryName: category.name,
      folders: folders.map((folder) => ({ folder, count: counts.get(folder.id) ?? 0 })),
    })
  }
  return groups
}

export type CaseLibraryView = {
  /** 该品类的全部图片，按静态清单顺序（封面在前）。 */
  all: readonly CaseAlbumItem[]
  /** 还没归到任何文件夹的。 */
  unassigned: readonly CaseAlbumItem[]
  /** 该品类的文件夹，按服务端给的顺序。 */
  folders: readonly CaseFolderGroup[]
}

/**
 * 筛选条的当前选中项。
 *
 * 用可辨识联合而不是「一个字符串 + 两个魔法值」：`folderId` 是 UUID，`all` 与
 * `unassigned` 只能是字面量，混在一个字符串类型里就没人拦得住「传了个文件夹 id 却
 * 期望它表示未归档」。三态写成三个 kind 之后，`switch` 能穷尽，新增一态会在编译期报错。
 */
export type CaseFolderFilter =
  { kind: 'all' } | { kind: 'unassigned' } | { kind: 'folder'; folderId: string }

export function filterKey(filter: CaseFolderFilter): string {
  if (filter.kind === 'folder') return `folder:${filter.folderId}`
  return filter.kind
}

/**
 * 把快照套到某个品类的静态清单上。
 *
 * **归属表里指向「本次没提供的文件夹」的条目一律当作未归档。** 那只可能来自两种情形：
 * 文件夹刚在另一台设备上被删掉（本机快照还没刷新），或者归属行是脏数据。两种情形下
 * 把图片藏起来都是错的 —— 用户看到的是「图还在，只是回到了未归档」，而这是可恢复的。
 *
 * **两条跨品类规则**（2026-10-29 放开跨品类移动之后才存在）：
 *
 *   - 本品类的图被挪进**别的品类**的文件夹 → 不在这个品类里显示了。移动就是移动；
 *     原地留一份「已移出」的残影，用户会以为自己刚才没点对，再点一次又不知道去哪了。
 *   - 别的品类的图被挪进**本品类**的文件夹 → 出现在那个文件夹里。地址与标题从 `index`
 *     取（见 {@link CaseIndex}），排在本品类自有图之后，按全局清单顺序。
 *
 * 第二条有一个副作用需要知道：这张图此时**同时属于两个品类**（它还在源品类的静态清单
 * 里，只是被规则一跳过了）。因此「把它移出文件夹」会让它回到源品类的未归档 —— 那是
 * 唯一说得通的归宿，因为没有「这张图不归任何品类」这个状态。
 */
export function buildCaseLibraryView(
  category: CaseCategory,
  snapshot: CaseLibrarySnapshot,
  index: CaseIndex,
): CaseLibraryView {
  const folders = snapshot.folders.filter((folder) => folder.categoryId === category.id)
  const folderById = new Map(snapshot.folders.map((folder) => [folder.id, folder]))
  const placementOf = new Map<string, string | null>()
  for (const placement of snapshot.placements) {
    placementOf.set(placement.itemId, placement.folderId)
  }

  /** 本品类自有的 itemId，按声明顺序，封面在前。 */
  const nativeIds: string[] = []
  if (category.cover !== null) nativeIds.push(caseCoverItemId(category.id))
  for (const slot of category.cases) {
    if (slot.cover === null || slot.thumb === null) continue
    nativeIds.push(slot.id)
  }

  const items: CaseAlbumItem[] = []
  for (const itemId of nativeIds) {
    const entry = index.get(itemId)
    if (entry === undefined) continue
    const folderId = placementOf.get(itemId)
    if (folderId === undefined || folderId === null) {
      items.push(toItem(itemId, entry, null))
      continue
    }
    const folder = folderById.get(folderId)
    // 文件夹已删（本机快照还旧）或不存在：当作未归档，图不能凭空消失。
    if (folder === undefined) {
      items.push(toItem(itemId, entry, null))
      continue
    }
    if (folder.categoryId !== category.id) continue
    items.push(toItem(itemId, entry, folder.id))
  }

  const nativeSet = new Set(nativeIds)
  const foreign: CaseAlbumItem[] = []
  for (const placement of snapshot.placements) {
    if (nativeSet.has(placement.itemId)) continue
    if (placement.folderId === null) continue
    const folder = folderById.get(placement.folderId)
    if (folder === undefined) continue
    if (folder.categoryId !== category.id) continue
    const entry = index.get(placement.itemId)
    if (entry === undefined) continue
    foreign.push(toItem(placement.itemId, entry, folder.id))
  }
  // 排序键：全局清单里的位置。归属表的返回顺序由数据库决定，不排的话同一批外来图在两
  // 次刷新之间可能换位置，看着像「每次进来顺序都不一样」。
  foreign.sort((left, right) => orderOf(index, left.id) - orderOf(index, right.id))

  const all = [...items, ...foreign]
  const groups: CaseFolderGroup[] = folders.map((folder) => ({
    folder,
    items: all.filter((item) => item.folderId === folder.id),
  }))

  return {
    all,
    unassigned: all.filter((item) => item.folderId === null),
    folders: groups,
  }
}

function toItem(itemId: string, entry: CaseIndexEntry, folderId: string | null): CaseAlbumItem {
  return { id: itemId, src: entry.src, thumb: entry.thumb, alt: entry.alt, folderId }
}

const ORDER_CACHE = new WeakMap<CaseIndex, Map<string, number>>()

function orderOf(index: CaseIndex, itemId: string): number {
  let order = ORDER_CACHE.get(index)
  if (order === undefined) {
    order = new Map()
    let position = 0
    for (const key of index.keys()) order.set(key, position++)
    ORDER_CACHE.set(index, order)
  }
  return order.get(itemId) ?? Number.MAX_SAFE_INTEGER
}

/** 按筛选条当前项取图片。选中的文件夹刚被删掉时退回「全部」，不留一个空视图。 */
export function filterCaseItems(
  view: CaseLibraryView,
  filter: CaseFolderFilter,
): readonly CaseAlbumItem[] {
  if (filter.kind === 'unassigned') return view.unassigned
  if (filter.kind === 'folder') {
    const group = view.folders.find((item) => item.folder.id === filter.folderId)
    return group === undefined ? view.all : group.items
  }
  return view.all
}

/**
 * 把一个移动操作**先写进本地快照**，用于点击后立刻重绘。
 *
 * 服务端返回的才是权威值，这里只负责让界面在往返的几百毫秒里不显得卡住。因此它只需要
 * 「看起来对」：把被移动的条目从旧文件夹摘掉、放到新文件夹，别的什么都不动。
 *
 * 归一成「保留 / 覆盖」两种写法：
 *   - `folderId === null` 时**删除**归属行而不是写一条 null。这是服务端的存储约定
 *     （未归档 = 没有行），本地也照做，否则下一次比较快照时会多出一条服务端不会有的
 *     记录，而它一旦被回写就会变成脏数据。
 *   - 有文件夹时覆盖已有的同 itemId 行，避免同一个图片出现两条归属。
 */
export function applyMoveToSnapshot(
  snapshot: CaseLibrarySnapshot,
  itemIds: readonly string[],
  folderId: string | null,
): CaseLibrarySnapshot {
  const moving = new Set(itemIds)
  const rest: CasePlacement[] = snapshot.placements.filter(
    (placement) => !moving.has(placement.itemId),
  )
  const next: CasePlacement[] = [...rest]
  if (folderId !== null) {
    for (const itemId of moving) {
      next.push({ itemId, folderId })
    }
  }
  return { ...snapshot, placements: next }
}
