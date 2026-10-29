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
 */
export function buildCaseLibraryView(
  category: CaseCategory,
  snapshot: CaseLibrarySnapshot,
): CaseLibraryView {
  const folders = snapshot.folders.filter((folder) => folder.categoryId === category.id)
  const knownFolders = new Set(folders.map((folder) => folder.id))

  const folderOf = new Map<string, string>()
  for (const placement of snapshot.placements) {
    if (!knownFolders.has(placement.folderId ?? '')) continue
    folderOf.set(placement.itemId, placement.folderId as string)
  }

  const items: CaseAlbumItem[] = []
  if (category.cover !== null) {
    const coverId = caseCoverItemId(category.id)
    items.push({
      id: coverId,
      src: category.cover,
      thumb: category.cover,
      alt: `${category.name}封面`,
      folderId: folderOf.get(coverId) ?? null,
    })
  }
  category.cases.forEach((slot, index) => {
    if (slot.cover === null || slot.thumb === null) return
    items.push({
      id: slot.id,
      src: slot.cover,
      thumb: slot.thumb,
      // 案例标题当前一律为空串（数据层不编名），回落到序号。
      alt: slot.title === '' ? `${category.name}案例 ${index + 1}` : slot.title,
      folderId: folderOf.get(slot.id) ?? null,
    })
  })

  const groups: CaseFolderGroup[] = folders.map((folder) => ({
    folder,
    items: items.filter((item) => item.folderId === folder.id),
  }))

  return {
    all: items,
    unassigned: items.filter((item) => item.folderId === null),
    folders: groups,
  }
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
