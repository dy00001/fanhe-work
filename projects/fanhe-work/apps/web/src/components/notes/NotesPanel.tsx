import { PERMISSIONS, type Note, type NoteTagCount } from '@fanhe/shared'
import { NotebookPen, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useAuth } from '../../auth/useAuth'
import { ApiError } from '../../lib/api'
import {
  createNote,
  loadNoteTags,
  loadNotes,
  noteFailureExit,
  removeNote,
  setNoteArchived,
  setNotePinned,
  updateNote,
} from '../../lib/notes'
import { cn } from '../../lib/utils'
import { EmptyState, ErrorState, LoadingState } from '../StateView'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { NoteEditor, type NoteFormValues } from './NoteEditor'
import { NoteList } from './NoteList'

/**
 * 工作纪要板块。
 *
 * 结构照 `LaunchPanel`：四个状态（加载中、加载失败、空、列表）互斥且穷尽，不靠几个
 * 布尔量拼出来；操作结果用板块顶部一条提示呈现，不引入 toast。
 *
 * **列表是权威副本，界面不自己排序。** 置顶、归档、删除三条动作之后一律重拉列表，
 * 而不是就地改一份本地数组 —— 排序规则（置顶 → 更新时间 → 创建时间）在服务端，
 * 本地改完还得自己重排一遍才与下一次拉取的结果一致，而这两份顺序迟早会分叉。
 * 本机回环请求的延迟是毫秒级，重拉的代价远小于维护第二份顺序。
 *
 * **标签清单失败不算整页失败。** 它只是候选提示，拿不到时标签照样能手输，这一点与
 * 启动配置那边「路径状态失败不影响列表」同构。
 *
 * **不缓存草稿。** 切走再回来会丢掉没保存的编辑。草稿恢复是 T3-08 的范围（定时保存
 * 与误关恢复），本轮不做 —— 现在假装做了反而会让人以为切换板块是安全的。
 */

/**
 * 拉取列表的结果。
 *
 * 用判别联合而不是抛出去让调用方接：失败在这里是**正常分支**（后端没起来、会话刚
 * 失效），编码进返回值，调用方就不必用 try 包住整段加载逻辑。
 *
 * 不碰组件状态、放在模块级 —— 与 `LaunchPanel` 的 `fetchLaunchProfiles` 同一条理由：
 * 它要在首次加载与重试两条路径上共用，而把 setState 塞进来会触发
 * `react-hooks/set-state-in-effect`（该规则做的是保守的跨函数分析）。
 */
type FetchNotesResult = { ok: true; notes: readonly Note[] } | { ok: false; message: string }

async function fetchNotes(archived: boolean): Promise<FetchNotesResult> {
  try {
    return { ok: true, notes: await loadNotes({ archived }) }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ApiError ? error.message : '加载失败，请稍后重试',
    }
  }
}

type Notice = { kind: 'ok' | 'error'; text: string }

export function NotesPanel() {
  const { can } = useAuth()
  const canWrite = can(PERMISSIONS.PERSONAL_NOTE_WRITE)

  /** `null` 表示还没拿到过数据，与「拿到了但是空的」区分开。 */
  const [notes, setNotes] = useState<readonly Note[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  /**
   * 当前打开的纪要。
   *
   * `null` 表示**新建**，不是「什么都没选」。把这两种含义分开存就会出现「选了新建、
   * 但列表也没选中任何一条」的中间态，而那时编辑器该显示哪种形态无从判断。
   */
  const [selectedId, setSelectedId] = useState<string | null>(null)

  /** 只看已归档。归档项退出默认列表（见 `archivedAt` 的语义），因此这是两个视图。 */
  const [showArchived, setShowArchived] = useState(false)

  const [tagCandidates, setTagCandidates] = useState<readonly NoteTagCount[]>([])
  /** 标签的重拉计数。新增或改名之后候选要跟着变，而它不影响列表。 */
  const [tagsToken, setTagsToken] = useState(0)

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [deleting, setDeleting] = useState<Note | null>(null)

  /** 重载计数。重试走「把它加一」，不把加载逻辑写第二遍。 */
  const [reloadToken, setReloadToken] = useState(0)

  /** 「正在加载」由「没有数据且没有错误」推出来，不另存一个布尔量。 */
  const loading = notes === null && loadError === null

  const selected = notes?.find((item) => item.id === selectedId) ?? null

  /**
   * 首次加载、重试、切换视图、以及每次写操作之后的重新拉取，共用这一段。
   *
   * 状态更新写在 effect 内、`await` 之后（见 `LaunchPanel` 的说明）。**顺带补一次
   * 选中**：只在这一轮拉完之后仍然没选中任何一条时才自动选第一条，这样既不会覆盖
   * 用户的选择，也不会在重拉之后把他正在看的那条换掉。
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const result = await fetchNotes(showArchived)
      if (cancelled) return
      if (result.ok) {
        setNotes(result.notes)
        setLoadError(null)
        setSelectedId((current) => {
          if (current !== null && result.notes.some((item) => item.id === current)) return current
          return result.notes[0]?.id ?? null
        })
      } else {
        setLoadError(result.message)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [reloadToken, showArchived])

  /**
   * 标签候选。
   *
   * 与列表分开成一次请求，失败也不算加载失败：候选拿不到时标签照样能手动输入，只是
   * 少了「你以前用过这些」。因此这里失败就保持上一次的结果，不清空 —— 清空会让已经
   * 显示出来的候选在一次偶发失败后一起消失，而它们刚才还是对的。
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const list = await loadNoteTags()
        if (!cancelled) setTagCandidates(list)
      } catch {
        // 见上。候选是附加信息，静默降级。
      }
    })()

    return () => {
      cancelled = true
    }
  }, [tagsToken])

  function describeError(error: unknown, fallback: string): string {
    return error instanceof ApiError ? error.message : fallback
  }

  /**
   * 写操作失败时的统一说法。
   *
   * `gone` 与 `retry` 的区分来自数据层（见 `lib/notes.ts` 的 `noteFailureExit`）：
   * 404 意味着这条已经不在这个账号名下了，此时把列表重拉一次比让用户反复点重试更有用。
   */
  function reportFailure(error: unknown, fallback: string): void {
    const message = describeError(error, fallback)
    const exit = error instanceof ApiError ? noteFailureExit(error) : 'retry'
    if (exit === 'gone') {
      setNotice({ kind: 'error', text: '这条纪要已不在，列表已刷新。' })
      setReloadToken((token) => token + 1)
      return
    }
    setNotice({ kind: 'error', text: message })
  }

  function handleRetry(): void {
    // 先清错误 —— `loading` 是从「没有数据且没有错误」推出来的，清掉它界面立刻回到
    // 加载态，不需要另设一个「重试中」的开关。
    setLoadError(null)
    setReloadToken((token) => token + 1)
  }

  /**
   * 保存（新建或修改）。
   *
   * 返回落库后的那一条，交给编辑器把草稿对齐过去 —— 正文与标签都可能被服务端归一，
   * 不对齐的话界面显示的仍是本地的猜测。
   *
   * **失败不在这里报，直接抛给编辑器。** 与 `LaunchPanel` 的 `handleSubmit` 同一条
   * 约定：提交失败时用户该看的是「哪个字段有问题」，而那条信息只能显示在表单旁边。
   * 这里若再报一次，同一件事会出现两条文案，而它们的内容还可能不一致（一条是服务端
   * 原文，一条是这里加工过的），用户不知道该信哪一条。其余三个动作（置顶、归档、
   * 删除）不是表单提交，没有可承载内联错误的位置，才走 `reportFailure`。
   */
  async function handleSubmit(values: NoteFormValues): Promise<Note> {
    setBusy(true)
    setNotice(null)
    try {
      if (selectedId === null) {
        const created = await createNote(values)
        setSelectedId(created.id)
        // 排序由服务端定，因此不在这里插入本地数组，直接重拉。
        setReloadToken((token) => token + 1)
        setTagsToken((token) => token + 1)
        setNotice({ kind: 'ok', text: `已创建「${created.title}」` })
        return created
      }

      const updated = await updateNote(selectedId, values)
      setReloadToken((token) => token + 1)
      // 标签可能新增也可能删光，候选要跟着变。
      setTagsToken((token) => token + 1)
      setNotice({ kind: 'ok', text: `已保存「${updated.title}」` })
      return updated
    } finally {
      setBusy(false)
    }
  }

  async function handleTogglePin(pinned: boolean): Promise<void> {
    if (selectedId === null) return
    setBusy(true)
    setNotice(null)
    try {
      const updated = await setNotePinned(selectedId, pinned)
      setReloadToken((token) => token + 1)
      setNotice({ kind: 'ok', text: updated.pinned ? '已置顶' : '已取消置顶' })
    } catch (error) {
      reportFailure(error, pinned ? '置顶失败，请稍后重试' : '取消置顶失败，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  async function handleToggleArchive(archived: boolean): Promise<void> {
    if (selectedId === null) return
    setBusy(true)
    setNotice(null)
    try {
      await setNoteArchived(selectedId, archived)
      // 归档后这条会退出当前视图，因此清掉选中并把列表交给服务端重算 —— 在「未归档」
      // 视图里它本来就是不该出现的那一条，本地留着它只会让人以为归档没生效。
      setSelectedId(null)
      setReloadToken((token) => token + 1)
      setNotice({
        kind: 'ok',
        text: archived ? '已归档，可在「已归档」里找到' : '已取消归档',
      })
    } catch (error) {
      reportFailure(error, archived ? '归档失败，请稍后重试' : '取消归档失败，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (deleting === null) return
    const target = deleting

    setBusy(true)
    setNotice(null)
    try {
      await removeNote(target.id)
      setDeleting(null)
      setSelectedId(null)
      setReloadToken((token) => token + 1)
      setTagsToken((token) => token + 1)
      setNotice({ kind: 'ok', text: `已删除「${target.title}」` })
    } catch (error) {
      reportFailure(error, '删除失败，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  function renderBody(): React.ReactNode {
    if (loading) return <LoadingState variant="plain" label="正在加载工作纪要" />

    if (loadError !== null) {
      return <ErrorState variant="plain" description={loadError} onRetry={handleRetry} />
    }

    // 上面两条已经把「加载中」与「加载失败」排除掉，到这里 `notes` 必然有值。取一个
    // 别名而不是到处写 `notes!`：类型收窄在这个函数里跨分支并不可靠，而一处 `!`
    // 会在将来某次重构后从「多余」变成「真的在掩盖空值」。
    const list = notes ?? []

    // 只读访客没有「新建」这件事，空库时给空态而不是一个空编辑器。可写角色不能这样
    // 处理 —— 那会开出一个死角：编辑器只画在「列表非空」的分支里，于是第一条纪要
    // 永远建不出来，而界面上那个「新建」按钮点下去毫无反应。
    if (!canWrite && list.length === 0) {
      return (
        <EmptyState
          variant="plain"
          icon={NotebookPen}
          title={showArchived ? '还没有归档的纪要' : '还没有纪要'}
          description={
            showArchived
              ? '归档会把不再活跃的纪要移出默认列表，但它们仍然可读、可恢复。'
              : '当前角色只能查看。需要撰写时，请联系管理员调整权限。'
          }
        />
      )
    }

    return (
      // 左列表右编辑器。窄屏堆叠成上下两段 —— 并排会把两栏都压到不可读的宽度，
      // 而预览恰恰是需要宽度才看得出效果的那一栏。
      <div className="grid gap-4 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          {list.length === 0 ? (
            // 列表为空但编辑器可用（即上面那个死角已被打开）。这里给一句说明而不是
            // 复用 `EmptyState`：空态是页面级的呈现，而此刻页面的主体是右边那个
            // 待填的编辑器，再摆一张居中大卡片会把视线从它上面拽走。
            <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground-weak">
              {showArchived ? '还没有归档的纪要' : '还没有纪要，右侧可以直接写第一条。'}
            </p>
          ) : (
            <NoteList
              notes={list}
              selectedId={selectedId}
              onSelect={(note) => setSelectedId(note.id)}
            />
          )}
        </div>

        <div className="rounded-lg border border-border bg-background p-4">
          <NoteEditor
            // 用 key 表达「换了一条」。换 id 就重挂，草稿随之重新初始化 —— 这比用
            // effect 同步 `note` 安全：那种写法会在父组件重渲染时把用户正在输入的内容
            // 冲掉，而那个 bug 只在「数据到达的同时用户已经在打字」时出现。
            key={selectedId ?? 'new'}
            note={selected}
            tagCandidates={tagCandidates}
            canWrite={canWrite}
            busy={busy}
            onSubmit={handleSubmit}
            onTogglePin={(pinned) => void handleTogglePin(pinned)}
            onToggleArchive={(archived) => void handleToggleArchive(archived)}
            onDelete={() => setDeleting(selected)}
          />
        </div>
      </div>
    )
  }

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-foreground">
            工作纪要
            {notes !== null && notes.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground-weak">
                {notes.length} 条
              </span>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            用 Markdown 记过程与结论，打上标签以便日后按标签找回来。
          </p>
        </div>

        {notes !== null && (
          <div className="flex shrink-0 items-center gap-1">
            {/* 视图切换。用两个按钮而不是开关：两个视图各自是完整的一屏内容，
                而开关的形态会让人以为它是个筛选条件，可以叠加在别的条件之上。 */}
            <Button
              type="button"
              variant={showArchived ? 'ghost' : 'secondary'}
              size="sm"
              onClick={() => setShowArchived(false)}
            >
              未归档
            </Button>
            <Button
              type="button"
              variant={showArchived ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setShowArchived(true)}
            >
              已归档
            </Button>
            {/* 新建在「已归档」视图里不出现：新纪要一律不归档（见 `CreateNoteRequest`
                的注释，服务端也不接受 `archivedAt`），因此在这里新建得到的是一条
                当前视图看不见的纪要。 */}
            {canWrite && !showArchived && (
              <Button type="button" size="sm" className="ml-1" onClick={() => setSelectedId(null)}>
                新建
              </Button>
            )}
          </div>
        )}
      </div>

      {notice !== null && (
        <div
          role={notice.kind === 'ok' ? 'status' : 'alert'}
          className={cn(
            'mt-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm',
            notice.kind === 'ok'
              ? 'border-border bg-accent text-foreground'
              : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          <span className="min-w-0 break-words">{notice.text}</span>
          <button
            type="button"
            aria-label="关闭提示"
            className="-mr-1 shrink-0 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
            onClick={() => setNotice(null)}
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="mt-4">{renderBody()}</div>

      {/* 删除确认。用 `deleting !== null` 同时表达「对话框开着」与「删的是哪一条」。 */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除纪要</DialogTitle>
            <DialogDescription>
              确定要删除「{deleting?.title}」吗？删除后它不再出现在任何列表里。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {busy ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
