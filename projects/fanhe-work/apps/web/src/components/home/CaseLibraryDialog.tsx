import { CASE_LIBRARY_LIMITS, NAV_CODES, navPath } from '@fanhe/shared'
import { AlertCircle, ChevronDown, Image as ImageIcon, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'

import { CASE_CATEGORIES, type CaseCategory } from '../../lib/case-catalog'
import {
  buildCaseIndex,
  buildCaseLibraryView,
  filterCaseItems,
  groupFoldersByCategory,
  type CaseAlbumItem,
  type CaseFolderFilter,
  type CaseFolderGroup,
} from '../../lib/case-library-display'
import { describePrepareFailure, prepareUpload } from '../../lib/case-upload'
import { useCaseAssets } from '../../lib/use-case-assets'
import { useCaseLibrary } from '../../lib/use-case-library'
import { useCaseUploadImages } from '../../lib/use-case-upload-images'
import { cn } from '../../lib/utils'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
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
   * 上传进度。`null` 表示没有在传。**进度按张数而不是字节**：一张图从上传播到入库
   * 是几十毫秒，用户看到的是「第 2 张 / 共 5 张」这种能数的东西，字节数反而让人去
   * 算还剩多久。
   */
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null)
  /** 拖拽悬停。用计数而不是布尔：拖过子元素时会先 leave 再 enter，布尔会闪一下。 */
  const dragDepth = useRef(0)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  /** 上传相关的提示（未被接受的格式、某一张失败）。与 `library.message` 分开：那条是
   *  归属写失败，这一条是「你选的这张图没进来」，用户要采取的动作不一样。 */
  const [uploadNotice, setUploadNotice] = useState<string | null>(null)
  /** 删除上传图的二次确认。静态图删不掉，所以这个动作一旦触发就是真的删字节，值得一问。 */
  const [confirmDelete, setConfirmDelete] = useState(false)

  /**
   * 全量清单的索引。**跨品类移动之后必须用它**：目标品类的图集里会出现它自己的清单
   * 里没有的图（从别的品类挪进来的），那张图的地址与标题只能从全局索引取。
   * 清单是模块级常量，这份索引建一次就够。
   */
  const index = useMemo(() => buildCaseIndex(CASE_CATEGORIES), [])

  /**
   * 静态清单 + 服务端归属 → 可直接渲染的视图。
   *
   * `useMemo` 的依赖是 `library.snapshot` 本身而不是它的字段：服务端每次回传一个新对象，
   * 引用变了就重算，引用没变（轮询到同一个修订号时上层根本没 set）就不重算。这比逐个
   * 比对 folders / placements 更省事，也不会漏。
   */
  const view = useMemo(
    () =>
      library.snapshot === null ? null : buildCaseLibraryView(category, library.snapshot, index),
    [category, library.snapshot, index],
  )

  /**
   * 移动菜单的选项：**全部品类**的文件夹，按品类分组。整理时最常见的动作是把放错品类的
   * 图挪到隔壁品类去，只列当前品类等于让这件事做不到。
   */
  const folderOptions = useMemo(
    () =>
      library.snapshot === null ? [] : groupFoldersByCategory(library.snapshot, CASE_CATEGORIES),
    [library.snapshot],
  )

  const visible = useMemo(
    () => (view === null ? [] : filterCaseItems(view, filter)),
    [view, filter],
  )

  /**
   * 上传图的 id 集合。**判断依据是快照里的 `uploads`，不是 id 的写法** —— id 的命名
   * 约定服务端也在用，但界面不该去解析它：哪天约定变了，两处都要跟着改。
   */
  const uploadIds = useMemo(
    () => new Set((library.snapshot?.uploads ?? []).map((upload) => upload.itemId)),
    [library.snapshot],
  )
  /**
   * 上传图的地址解析。**只传本屏在显示的 id**：整库预取会让打开任何一页都变成几十次
   * 并发请求。`uploadIds` 是 Set，转成数组时顺序稳定（插入序即快照顺序），hook 内部
   * 用拼接字符串做依赖才不会每帧重跑。
   */
  const uploadIdList = useMemo(() => Array.from(uploadIds), [uploadIds])
  /**
   * 拆成单名字而不是留着整个对象：`entries` 表本身是唯一会换引用的那一项（每解析成功
   * 一批就换一个），把它直接放进依赖数组就够了，不必再自己维护一个版本号。
   */
  const { entries: uploadEntries, ensureFull: ensureUploadFull } = useCaseUploadImages(
    uploadIdList,
    open,
  )

  /**
   * 把本地缓存的缩略图地址贴到条目上。**没有缓存的条目保持原地址**（内置图 / 网络），
   * 因此「部分缓存」这种中间态不需要单独处理 —— 缓存了几张就快几张。
   *
   * 上传图走另一条链路：它的地址要带令牌，`<img>` 给不了，所以必须先换成 object URL。
   * 还没换好的那几张保持接口路径（渲染出来是裂图）—— 这一步的窗口只有几十毫秒，
   * 而换成「先显示占位」需要给网格加第三种状态，代价与收益不成比例。
   */
  const shown = useMemo(() => {
    const cached =
      assets.thumbs.size === 0
        ? visible
        : visible.map((item) => {
            const url = assets.thumbs.get(item.id)
            return url === undefined ? item : { ...item, thumb: url }
          })
    if (uploadIds.size === 0) return cached
    return cached.map((item) => {
      if (!uploadIds.has(item.id)) return item
      const resolved = uploadEntries[item.id]
      if (resolved === undefined) return item
      // 原图还没取回来时用缩略图顶上：放大层里看到的是一张糊一点的图，而不是空白。
      const nextThumb = resolved.thumb ?? resolved.full ?? item.thumb
      return { ...item, thumb: nextThumb, src: resolved.full ?? nextThumb }
    })
  }, [visible, assets.thumbs, uploadIds, uploadEntries])
  const selectedItems = view === null ? [] : view.all.filter((item) => selected.has(item.id))
  /** 勾选里能删的那几张（自己上传的）。静态清单里的图没有可删的行。 */
  const deletableCount = selectedItems.filter((item) => uploadIds.has(item.id)).length
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
    // 确认态跟着勾选一起清：留着的话下次进整理模式会直接看到「删除 3 张？」，
    // 而那 3 张已经不是刚才那 3 张了。
    setConfirmDelete(false)
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

  /**
   * 把选中的文件（或拖进来的文件）逐张压好、传上去。
   *
   * **串行而不是并发。** 十张图并发上传会同时占十条连接与十份解码后的位图内存
   * （一张 4000×3000 约 48MB），而这台机器同时还在跑采集与数据库；串行的代价只是
   * 总耗时变成它们的和，而进度条让这段时间可解释。
   *
   * **一张失败不中断整批。** 失败原因记下来，最后合并成一句提示 —— 一张 HEIC 混在
   * 九张 JPG 里时，用户要的是「那九张进去了，那张没进」，不是「整批失败」。
   *
   * 落点：正在看某个文件夹就进那个文件夹，否则进未归档。这与「移动」不同 —— 上传时
   * 没有「原来在哪」，放进用户此刻正在看的那个组里，是他按下按钮时的预期。
   */
  async function addFiles(files: FileList | readonly File[]): Promise<void> {
    if (uploadProgress !== null) return
    const all = Array.from(files)
    if (all.length === 0) return

    const batch = all.slice(0, CASE_LIBRARY_LIMITS.UPLOAD_BATCH_MAX)
    const skipped = all.length - batch.length
    const folderId = filter.kind === 'folder' ? filter.folderId : null

    const failures: string[] = []
    if (skipped > 0) {
      failures.push(
        `一次最多 ${CASE_LIBRARY_LIMITS.UPLOAD_BATCH_MAX} 张，本次只传了前 ${batch.length} 张`,
      )
    }

    setUploadNotice(null)
    setUploadProgress({ done: 0, total: batch.length })
    try {
      for (const [position, file] of batch.entries()) {
        const prepared = await prepareUpload(file)
        if (!prepared.ok) {
          failures.push(`${file.name}：${describePrepareFailure(prepared.reason)}`)
        } else {
          const ok = await library.uploadOne(prepared.data, folderId)
          if (!ok) failures.push(`${file.name}：上传失败`)
        }
        setUploadProgress({ done: position + 1, total: batch.length })
      }
    } finally {
      setUploadProgress(null)
    }
    if (failures.length > 0) setUploadNotice(failures.join('；'))
  }

  /** 删除勾选里**能删的那些**（自己上传的）。静态清单里的图删不掉，服务端会 404。 */
  async function removeUploads(): Promise<void> {
    const targets = Array.from(selected).filter((itemId) => uploadIds.has(itemId))
    if (targets.length === 0) return
    let allOk = true
    for (const itemId of targets) {
      // 串行同样是为了失败时能说清「删到第几张停的」。删除是低频动作，不值得并发。
      const ok = await library.deleteUpload(itemId)
      if (!ok) allOk = false
    }
    if (allOk) setSelected(new Set())
  }

  /**
   * 打开放大层时才去取原图。
   *
   * 放在 effect 里而不是渲染里：拉图是副作用，写在渲染中会在 StrictMode 下双发，
   * 也会让「渲染」这件事不再纯粹。
   */
  useEffect(() => {
    if (lightboxId !== null && uploadIds.has(lightboxId)) ensureUploadFull(lightboxId)
  }, [lightboxId, uploadIds, ensureUploadFull])

  const lightboxIndex = lightboxId === null ? -1 : shown.findIndex((item) => item.id === lightboxId)
  /**
   * 顶上那条横幅显示什么。
   *
   * `library.message`（归属写失败）优先于 `uploadNotice`（这张图没进来）：前者意味着
   * 刚才那次操作整体没生效，后者只是某一批里少了一张，前者更要紧。
   */
  const notice = library.message ?? uploadNotice

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          // **不要在这里加 `relative`。** 基类里的定位是 `fixed`，而 tailwind-merge 把
          // `relative` 与 `fixed` 视为同一组，后者胜出会把弹窗拽回文档流，再叠上基类残留的
          // `translate-[-50%,-50%]`，面板就被推到视口之外，只剩一层遮罩（2026-10-30 的真实故障）。
          // 拖拽遮罩与放大层用的 `absolute inset-0` 不需要 `relative` 祖先：`fixed` 本身就是
          // positioned，已经能当包含块。
          'flex flex-col gap-0 p-0',
          // 平时高度跟着内容走：一个品类只有五六张图时，弹窗就该是紧凑的，不该留一大片
          // 空白。但**打开放大层时必须撑满** —— 放大层是 `absolute inset-0` 贴在弹窗上的，
          // 弹窗矮，放大层就只有那么高，图片被压成一小块（之前的故障反过来：图片溢出被裁）。
          lightboxId === null ? 'max-h-[92vh]' : 'h-[92vh] max-h-[92vh]',
          // 宽度按「四列缩略图」反推，只受视口限制。
          'sm:max-w-[min(1120px,94vw)]',
        )}
        onDragEnter={(event) => {
          // 只认文件拖拽：从浏览器里拖一段文字或一个链接进来，不该弹出「正在上传」。
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(event) => {
          // **必须 preventDefault**：不拦的话浏览器把「打开这个文件」当成默认动作，
          // 松手时整个应用跳到那张图上，本地状态全丢。
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
        }}
        onDragLeave={() => {
          // 深度计数而不是布尔：dragenter / dragleave 会在每个子元素边界各触发一次，
          // 布尔值会在图片之间穿过时闪成「没在拖」。
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          if (event.dataTransfer.files.length > 0) void addFiles(event.dataTransfer.files)
        }}
      >
        {/* 投放提示。`pointer-events-none` 是必须的：它盖在网格上，若接管了鼠标事件，
            拖拽经过时 dragleave 会在它自己身上触发，遮罩开始闪。 */}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-50 grid place-items-center rounded-lg bg-background/85 backdrop-blur-sm">
            <div className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-foreground/25 px-10 py-8">
              <Upload className="size-6 text-muted-foreground" />
              <span className="text-sm text-foreground">松手就上传到「{category.name}」</span>
              <span className="text-xs text-muted-foreground">
                会自动压缩，原图不入库；一次最多 {CASE_LIBRARY_LIMITS.UPLOAD_BATCH_MAX} 张
              </span>
            </div>
          </div>
        )}

        <DialogHeader className="px-6 pt-6 pb-3">
          <div className="flex items-start gap-3 pr-8">
            <div className="min-w-0 flex-1">
              <DialogTitle className="text-left">{category.name}</DialogTitle>
              <DialogDescription className="text-left">
                {describeStatus(
                  library.loading,
                  library.saving,
                  view,
                  // 上传优先于缩略图同步：它是用户刚按下的动作，而同步是背景行为。
                  uploadProgress !== null
                    ? { label: '正在上传', ...uploadProgress }
                    : assets.progress !== null
                      ? { label: '正在同步缩略图', ...assets.progress }
                      : null,
                )}
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
            {/* 上传入口。**平时就在这儿，不藏在整理模式里** —— 传图是这个弹窗的日常动作，
                而整理（选择 / 移动）才是隔一阵才做一次的那件事。 */}
            <button
              type="button"
              disabled={view === null || uploadProgress !== null}
              onClick={() => fileInputRef.current?.click()}
              className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors outline-none hover:border-foreground/40 hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
            >
              <Upload className="size-3" />
              {uploadProgress === null
                ? '上传图片'
                : `${uploadProgress.done}/${uploadProgress.total}`}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = event.target.files
                // 先清空 value：不清的话「再选同一张」不会触发 change，用户会以为点击没反应。
                event.target.value = ''
                if (files !== null && files.length > 0) void addFiles(files)
              }}
            />
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
        {notice !== null && (
          <div
            role="alert"
            className="flex items-center gap-2 border-y border-destructive/30 bg-destructive/5 px-6 py-2 text-sm text-destructive"
          >
            <AlertCircle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1">{notice}</span>
            <button
              type="button"
              onClick={() => {
                library.dismissMessage()
                setUploadNotice(null)
              }}
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
                setConfirmDelete(false)
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
                  onUpload={() => fileInputRef.current?.click()}
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
              {/* 删除只对「自己上传的」有效，所以按钮上带张数：全选时它会显示 0 并禁用，
                  这比让用户点一下再收到「这些删不掉」的报错清楚。 */}
              {confirmDelete ? (
                <span className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    删除 {deletableCount} 张？删了找不回来
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void removeUploads().finally(() => setConfirmDelete(false))
                    }}
                    className="rounded-md bg-destructive px-2.5 py-1.5 text-destructive-foreground transition-opacity hover:opacity-90"
                  >
                    确认删除
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="rounded-md px-2.5 py-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                  >
                    取消
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  disabled={deletableCount === 0 || library.saving}
                  onClick={() => setConfirmDelete(true)}
                  className="rounded-md px-2.5 py-1.5 text-muted-foreground transition-colors outline-none hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40"
                >
                  删除{deletableCount > 0 ? `（${deletableCount}）` : ''}
                </button>
              )}

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
                <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-y-auto">
                  <DropdownMenuLabel>放到</DropdownMenuLabel>
                  <DropdownMenuItem
                    disabled={allSelectedUnassigned}
                    onSelect={() => {
                      void moveTo(null)
                    }}
                  >
                    移出文件夹（未归档）
                  </DropdownMenuItem>
                  {folderOptions.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      还没有文件夹，先在筛选条上新建一个
                    </div>
                  ) : (
                    // 按品类分组列出**全部**文件夹，不是只有当前品类：放错品类的图挪到
                    // 隔壁品类去，本来就是这个功能最常用的场景。组标题写品类名，当前
                    // 品类额外挂一个「当前」标签 —— 否则用户会以为自己已经不在这个品类里了。
                    folderOptions.map((group) => (
                      <DropdownMenuGroup key={group.categoryId}>
                        <DropdownMenuSeparator />
                        <DropdownMenuLabel className="flex items-center gap-1.5">
                          <span className="min-w-0 flex-1 truncate">{group.categoryName}</span>
                          {group.categoryId === category.id && (
                            <span className="rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground">
                              当前
                            </span>
                          )}
                        </DropdownMenuLabel>
                        {group.folders.map((option) => (
                          <DropdownMenuItem
                            key={option.folder.id}
                            onSelect={() => {
                              void moveTo(option.folder.id)
                            }}
                          >
                            <span className="min-w-0 flex-1 truncate">{option.folder.name}</span>
                            <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                              {option.count}
                            </span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
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
  progress: { label: string; done: number; total: number } | null,
): string {
  // 进行中的进度优先显示：它是这一版新增的、用户看得见在动的东西，而「共 5 张」在
  // 那几秒里并不重要。
  if (progress !== null) return `${progress.label} ${progress.done}/${progress.total}`
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
  onUpload,
  onPickFromAll,
}: {
  filter: CaseFolderFilter
  hasAny: boolean
  onUpload: () => void
  onPickFromAll: () => void
}) {
  if (!hasAny) {
    return (
      <div className="grid h-48 place-items-center text-muted-foreground">
        <div className="flex flex-col items-center gap-2">
          <ImageIcon className="size-6" />
          {/* 「案例整理中」曾经是这里的文案。现在这个品类可以是空的、而且用户自己能填，
              那就该直接给出下一步，而不是让他以为在等别人。 */}
          <span className="text-sm">这个品类还没有图片</span>
          <button
            type="button"
            onClick={onUpload}
            className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-foreground/40 hover:text-foreground"
          >
            上传图片
          </button>
          <span className="text-xs text-muted-foreground-weak">也可以把图片直接拖进这个窗口</span>
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
