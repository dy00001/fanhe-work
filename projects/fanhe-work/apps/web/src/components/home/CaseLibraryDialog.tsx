import { CASE_LIBRARY_LIMITS, NAV_CODES, navPath } from '@fanhe/shared'
import { AlertCircle, ChevronDown, Image as ImageIcon, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router'

import type { CaseCategory } from '../../lib/case-catalog'
import {
  buildCaseLibraryView,
  filterCaseItems,
  type CaseAlbumItem,
  type CaseFolderFilter,
  type CaseFolderGroup,
} from '../../lib/case-library-display'
import { useCaseAssets } from '../../lib/use-case-assets'
import { useCaseLibrary } from '../../lib/use-case-library'
import { cn } from '../../lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'
import { Skeleton } from '../ui/skeleton'
import { CaseFolderBar } from './CaseFolderBar'
import { CaseImageGrid } from './CaseImageGrid'
import { CaseLightbox } from './CaseLightbox'

/**
 * 品类图集窗口：看图 + 整理。
 *
 * **一个窗口承担两件事，因为它们本来就是一件事。** 用户点开某个品类，看到的是「这个
 * 品类下我有哪些图」；想把它整理成「主卧灰玻」「儿童房原木」几组，也正是在这个视角里
 * 产生的念头。分成两个入口（看图的窗口 + 整理的页面）会让「整完之后回来看」变成两次
 * 跳转。
 *
 * 三层结构，每层职责单一：
 *   - 筛选条（{@link CaseFolderBar}）：我在看哪一组。它同时是文件夹的增删改入口。
 *   - 网格（{@link CaseImageGrid}）：这一组里有哪些图。浏览态点开放大，选择态点击勾选。
 *   - 放大层（{@link CaseLightbox}）：看清一张。点图片或空白处退回网格。
 *
 * **数据来自服务端，且每次写操作都整份替换。** `useCaseLibrary` 负责拉取、轮询、乐观
 * 更新与回滚，这一层只管把 view 画出来。多设备同步因此不需要在这里写任何代码 ——
 * 另一台设备改完，这一台最迟 20 秒（或一次窗口聚焦）就会自己变。
 *
 * **界面上的每个动作都立刻落库**，没有「保存」按钮。归属关系这种数据的正确版本只有
 * 一份，攒着批量提交换来的只是「关掉窗口就丢」的风险。
 */
export function CaseLibraryDialog({
  category,
  open,
  onOpenChange,
}: {
  category: CaseCategory
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const library = useCaseLibrary(category.id, open)
  /**
   * 缩略图缓存。它与 `library` 是两条独立的链路：前者管「图从哪来」，后者管「图归哪个
   * 文件夹」。缓存不可用时这里没有任何副作用，网格回落到内置缩略图地址。
   */
  const assets = useCaseAssets(category.id, open)
  const navigate = useNavigate()
  const [filter, setFilter] = useState<CaseFolderFilter>({ kind: 'all' })
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [lightboxId, setLightboxId] = useState<string | null>(null)

  /**
   * 静态清单 + 服务端归属 → 可直接渲染的视图。
   *
   * `useMemo` 的依赖是 `library.snapshot` 本身而不是它的字段：服务端每次回传一个新对象，
   * 引用变了就重算，引用没变（轮询到同一个修订号时上层根本没 set）就不重算。这比逐个
   * 比对 folders / placements 更省事，也不会漏。
   */
  const view = useMemo(
    () => (library.snapshot === null ? null : buildCaseLibraryView(category, library.snapshot)),
    [category, library.snapshot],
  )

  const visible = useMemo(
    () => (view === null ? [] : filterCaseItems(view, filter)),
    [view, filter],
  )
  /**
   * 把本地缓存的缩略图地址贴到条目上。**没有缓存的条目保持原地址**（内置图 / 网络），
   * 因此「部分缓存」这种中间态不需要单独处理 —— 缓存了几张就快几张。
   */
  const shown = useMemo(() => {
    if (assets.thumbs.size === 0) return visible
    return visible.map((item) => {
      const url = assets.thumbs.get(item.id)
      return url === undefined ? item : { ...item, thumb: url }
    })
  }, [visible, assets.thumbs])
  const selectedItems = view === null ? [] : view.all.filter((item) => selected.has(item.id))
  const allSelectedUnassigned =
    selectedItems.length > 0 && selectedItems.every((item) => item.folderId === null)
  const folderLimitReached =
    view !== null && view.folders.length >= CASE_LIBRARY_LIMITS.FOLDERS_PER_CATEGORY_MAX

  function toggle(itemId: string): void {
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(itemId)) next.delete(itemId)
      else next.add(itemId)
      return next
    })
  }

  function activate(item: CaseAlbumItem): void {
    if (selectMode) {
      toggle(item.id)
      return
    }
    setLightboxId(item.id)
  }

  function exitSelectMode(): void {
    setSelectMode(false)
    setSelected(new Set())
  }

  async function moveTo(folderId: string | null): Promise<void> {
    const itemIds = Array.from(selected)
    if (itemIds.length === 0) return
    const ok = await library.moveItems(itemIds, folderId)
    // 成功才清空勾选。失败时保留，用户可以改选目标重试 —— 清空会让他重新勾一遍，
    // 而刚才那次失败很可能只是「目标文件夹被另一台设备删掉了」。
    if (ok) setSelected(new Set())
  }

  async function removeFolder(group: CaseFolderGroup): Promise<boolean> {
    // 正在用这个文件夹筛选时先退到「全部」：否则删完之后筛选条件指向一个不存在的
    // 文件夹，视图会落进「该文件夹是空的」那种空态，看起来像删除失败了。
    const activeId = filter.kind === 'folder' ? filter.folderId : null
    const ok = await library.deleteFolder(group.folder.id)
    if (ok && activeId === group.folder.id) setFilter({ kind: 'all' })
    if (ok) setSelected(new Set())
    return ok
  }

  const lightboxIndex = lightboxId === null ? -1 : shown.findIndex((item) => item.id === lightboxId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'flex max-h-[92vh] flex-col gap-0 p-0',
          // 宽度按「四列缩略图」反推，只受视口限制。
          'sm:max-w-[min(1120px,94vw)]',
        )}
      >
        <DialogHeader className="px-6 pt-6 pb-3">
          <div className="flex items-start gap-3 pr-8">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-left">{category.name}</DialogTitle>
              <DialogDescription className="text-left">
                {describeStatus(library.loading, library.saving, view, assets.progress)}
              </DialogDescription>
            </div>
            {/* 本地缓存的入口。它不是这个弹窗的功能，而是「这台机器怎么配」，因此
                点它去设置页，而不是在这里再摆一套选择目录的控件。 */}
            <button
              type="button"
              onClick={() => {
                navigate(`${navPath(NAV_CODES.SYSTEM_SETTINGS)}/preferences`)
              }}
              title="本机设置：案例图片缓存"
              className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              {assets.state.status === 'ready'
                ? `本地缓存 ${assets.state.fileCount}`
                : '缓存未启用'}
            </button>
            <button
              type="button"
              disabled={view === null || view.all.length === 0}
              onClick={() => {
                if (selectMode) exitSelectMode()
                else setSelectMode(true)
              }}
              className="shrink-0 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors outline-none hover:border-foreground/40 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
            >
              {selectMode ? '完成' : '选择'}
            </button>
          </div>
        </DialogHeader>

        {/* 失败提示。用一条带色的横幅而不是弹窗：整理失败时用户正对着网格，弹窗会
            挡住他刚操作的那几张图。文案来自服务端（「这个品类下已有同名文件夹」）。 */}
        {library.message !== null && (
          <div
            role="alert"
            className="flex items-center gap-2 border-y border-destructive/30 bg-destructive/5 px-6 py-2 text-sm text-destructive"
          >
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{library.message}</span>
            <button
              type="button"
              onClick={library.dismissMessage}
              aria-label="关闭提示"
              className="rounded p-0.5 hover:bg-destructive/10"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}

        {view === null ? (
          // 首屏骨架。给的是和真实网格同尺寸的方块，加载完不会跳版。
          <div className="grid grid-cols-2 gap-3 px-6 pt-4 pb-6 sm:grid-cols-3 lg:grid-cols-4">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton key={index} className="aspect-[4/3] rounded-xl" />
            ))}
          </div>
        ) : (
          <>
            <CaseFolderBar
              groups={view.folders}
              unassignedCount={view.unassigned.length}
              totalCount={view.all.length}
              filter={filter}
              onChange={(next) => {
                // 换筛选就清空勾选：留着会得到「已选 3 张」但其中两张已经看不见了，
                // 而下一步的移动会把它们一起带走 —— 那正是最容易误操作的情形。
                setFilter(next)
                setSelected(new Set())
              }}
              onCreate={(name) => library.createFolder(name)}
              onRename={(id, name) => library.renameFolder(id, name)}
              onDelete={removeFolder}
              folderLimitReached={folderLimitReached}
            />

            <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-4 pb-6">
              {visible.length === 0 ? (
                <EmptyState
                  filter={filter}
                  hasAny={view.all.length > 0}
                  onPickFromAll={() => {
                    setFilter({ kind: 'all' })
                    setSelected(new Set())
                  }}
                />
              ) : (
                <CaseImageGrid
                  items={shown}
                  selectMode={selectMode}
                  selected={selected}
                  onActivate={activate}
                />
              )}
            </div>
          </>
        )}

        {selectMode && view !== null && (
          <div className="flex flex-wrap items-center gap-3 border-t border-border px-6 py-3 text-sm">
            <span className="text-muted-foreground">
              已选 <span className="font-medium text-foreground tabular-nums">{selected.size}</span>{' '}
              张
            </span>
            <button
              type="button"
              onClick={() => {
                const allVisibleSelected =
                  visible.length > 0 && visible.every((item) => selected.has(item.id))
                setSelected(
                  allVisibleSelected ? new Set() : new Set(visible.map((item) => item.id)),
                )
              }}
              className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              {visible.length > 0 && visible.every((item) => selected.has(item.id))
                ? '取消全选'
                : '全选本组'}
            </button>

            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={exitSelectMode}
                className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
              >
                退出整理
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    disabled={selected.size === 0 || library.saving}
                    className="flex items-center gap-1 rounded-md bg-foreground px-3 py-1.5 text-background transition-opacity outline-none hover:opacity-90 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
                  >
                    移动到
                    <ChevronDown className="size-3.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
                  <DropdownMenuLabel>放到</DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={allSelectedUnassigned}
                    onSelect={() => {
                      void moveTo(null)
                    }}
                  >
                    移出文件夹（未归档）
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {view.folders.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      还没有文件夹，先在筛选条上新建一个
                    </div>
                  ) : (
                    view.folders.map((group) => (
                      <DropdownMenuItem
                        key={group.folder.id}
                        onSelect={() => {
                          void moveTo(group.folder.id)
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{group.folder.name}</span>
                        <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                          {group.items.length}
                        </span>
                      </DropdownMenuItem>
                    ))
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        )}

        {lightboxIndex >= 0 && (
          <CaseLightbox
            items={shown}
            index={lightboxIndex}
            onClose={() => setLightboxId(null)}
            onStep={(delta) => {
              const next = (lightboxIndex + delta + shown.length) % shown.length
              const item = shown[next]
              if (item !== undefined) setLightboxId(item.id)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/**
 * 状态行。三种状态按「用户此刻最需要知道什么」排序：
 *
 *   1. 还没拉到数据 → 正在加载。此时说「共 0 张」是错的。
 *   2. 有写操作在飞 → 保存中。用户刚点完，需要知道「点了有用」。
 *   3. 其余 → 已同步 + 数量。**「已同步」这四个字是这一版新增的功能字面量**：
 *      跨设备一致是这个功能的卖点，用户得能看到它现在是同步状态，而不是靠猜。
 */
function describeStatus(
  loading: boolean,
  saving: boolean,
  view: { all: readonly unknown[]; folders: readonly unknown[] } | null,
  progress: { done: number; total: number } | null,
): string {
  // 同步缩略图优先显示：它是这一版新增的、用户看得见在动的进度，而「共 5 张」在
  // 那几秒里并不重要。
  if (progress !== null) return `正在同步缩略图 ${progress.done}/${progress.total}`
  if (view === null) return loading ? '正在加载案例库…' : '案例库暂时不可用'
  if (saving) return '保存中…'
  const parts = [`共 ${view.all.length} 张`]
  if (view.folders.length > 0) parts.push(`${view.folders.length} 个文件夹`)
  return `已同步 · ${parts.join(' · ')}`
}

/**
 * 空态。
 *
 * 三种空各有各的说法，不能合成一句「暂无图片」：
 *   - 文件夹空：是「你还没往里放」，下一步是去全部挑。所以给一个直接跳过去的按钮。
 *   - 未归档空：是「全都整理好了」，这是好消息，不该提示用户做什么。
 *   - 品类本身没有图：与数据层「案例整理中」一致，说明的是另一件事。
 */
function EmptyState({
  filter,
  hasAny,
  onPickFromAll,
}: {
  filter: CaseFolderFilter
  hasAny: boolean
  onPickFromAll: () => void
}) {
  if (!hasAny) {
    return (
      <div className="grid h-48 place-items-center text-muted-foreground-weak">
        <div className="flex flex-col items-center gap-2">
          <ImageIcon className="size-6" />
          <span className="text-sm">案例整理中</span>
        </div>
      </div>
    )
  }

  if (filter.kind === 'folder') {
    return (
      <div className="grid h-48 place-items-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <span className="text-sm">这个文件夹还是空的</span>
          <button
            type="button"
            onClick={onPickFromAll}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-foreground/40 hover:text-foreground"
          >
            去「全部」里挑
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="grid h-48 place-items-center text-muted-foreground">
      <span className="text-sm">
        {filter.kind === 'unassigned' ? '所有图片都归好类了' : '这里还没有图片'}
      </span>
    </div>
  )
}
