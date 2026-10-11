import { NOTE_LIMITS, isValidNoteTag, type Note, type NoteTagCount } from '@fanhe/shared'
import { Archive, ArchiveRestore, Pin, PinOff, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ApiError } from '../../lib/api'
import {
  clearNoteDraft,
  isSameDraftValues,
  readNoteDraft,
  writeNoteDraft,
  type NoteDraft,
} from '../../lib/note-draft'
import { formatRelativeTime } from '../../lib/relative-time'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'
import { MarkdownPreview } from './MarkdownPreview'
import { TagInput } from './TagInput'

/**
 * 纪要编辑器。
 *
 * **预览吃的是草稿，不是已保存的那一条。** 这是本任务验收要点「编辑与预览内容一致」
 * 的落点：预览若读 `note.content`，用户打完字要等保存后才看得见渲染结果，而那时
 * 他已经失去「一边写一边核对」的机会 —— 纪要里写表格、写代码块时，这个差别很明显。
 * 因此这里维护一份草稿，左右两栏是同一份值的两种投影。
 *
 * **草稿的初始值在这里算，并按「正在编辑哪一条」的身份变化补一次同步。** 父组件用
 * `key` 区分「新建」与「某一条」，换一条就重挂一次；但只靠重挂不够，因为「新建成功」
 * 那次换 key 早于数据到达（详见下方 `syncedNoteId` 的注释）。同步的判据是 note 的
 * **id**，不是整个 note 对象：同一条纪因列表重拉而换了引用时不能重置草稿，否则会
 * 把用户正在输入的内容冲掉 —— 那正是不能用 `useEffect` 无条件同步 `note` 的原因。
 *
 * **只读访客走另一条分支**：直接渲染 Markdown 预览，不给输入框。把输入框置灰也行，
 * 但一个全是灰输入框的页面看起来像是坏了，而这里想传达的是「你有权看这条」。
 *
 * **未提交的内容会落到本机（T3-08）。** 按「编辑器的身份」写进 localStorage，误关、
 * 切板块、被检索筛掉之后再回来都能接着写。槽名与读写规则在 `lib/note-draft.ts`，
 * 这里只负责「什么时候写、什么时候清、什么时候恢复」。**三个写入触发点（防抖 /
 * 页面隐藏 / 卸载）与三个清除触发点（提交成功 / 明确丢弃 / 与库里一致）缺一不可** ——
 * 少任何一条都会留下一类「看起来偶发」的丢内容现象，理由写在各自实现处。
 */

/** 表单值。与 `CreateNoteRequest` 的字段一致，但标题在提交前才 trim。 */
export type NoteFormValues = {
  title: string
  content: string
  tags: string[]
}

function valuesFrom(note: Note | null): NoteFormValues {
  if (note === null) return { title: '', content: '', tags: [] }
  return { title: note.title, content: note.content, tags: [...note.tags] }
}

/** 从恢复的草稿取表单值。同样拷贝一份标签：之后编辑标签时不该改到那份草稿对象。 */
function valuesFromDraft(draft: NoteDraft): NoteFormValues {
  return { title: draft.title, content: draft.content, tags: [...draft.tags] }
}

/**
 * 草稿写入的防抖窗口。
 *
 * 比检索的 250ms（`NotesPanel`）长一倍是有意的：检索是一次网络请求，晚发一点只是
 * 结果晚到；草稿写是**同步阻塞主线程**的 I/O，一篇 10 万字符的正文若每次按键都写，
 * 打字会肉眼可见地发涩。500ms 落在「停顿时就已经落盘」与「一次连续输入只写一次」
 * 之间，而真正怕丢的那一刻由 `pagehide` 兜底，不靠这个值。
 */
const DRAFT_DEBOUNCE_MS = 500

/**
 * 判断草稿与已保存的那一条是否真的不同。
 *
 * 比较规则**只剩一处定义**，在 `lib/note-draft.ts` 的 `isSameDraftValues`：标题按
 * trim 后比较（服务端保存标题时会 trim，正文不会，Markdown 里的前导空白有意义）。
 * 「草稿要不要留」与「保存按钮要不要亮」必须用同一条判据 —— 各写一份的结果是出现
 * 「按钮是灰的、草稿却一直在」这类没人能一眼解释的现象。
 *
 * `null`（新建）恒为「有改动」：还没有落库的那一条，写什么都算新内容。
 */
function hasChanges(note: Note | null, values: NoteFormValues): boolean {
  if (note === null) return true
  return !isSameDraftValues(note, values)
}

export function NoteEditor({
  note,
  tagCandidates,
  canWrite,
  busy,
  onSubmit,
  onTogglePin,
  onToggleArchive,
  onDelete,
}: {
  note: Note | null
  tagCandidates: readonly NoteTagCount[]
  canWrite: boolean
  busy: boolean
  onSubmit: (values: NoteFormValues) => Promise<Note>
  onTogglePin: (pinned: boolean) => void
  onToggleArchive: (archived: boolean) => void
  onDelete: () => void
}) {
  /** 编辑器的身份。`null` 表示新建 —— 与父组件传给 `key` 的值是同一个。 */
  const noteId = note?.id ?? null

  /**
   * 挂载时读一次本机草稿。
   *
   * 用 `useState` 的惰性初始化器而不是 effect：它只跑一次、不参与重渲染，因此不存在
   * 并发渲染下读到两份不同值的可能，也不会像 effect 那样在「数据后到」时把用户的
   * 输入冲掉。**父组件用 `key` 表达「换了一条」，所以「换一条」必然伴随重挂，这里
   * 读到的必然就是那一条的草稿。**
   */
  const [restored] = useState(() => readNoteDraft(noteId))

  const [values, setValues] = useState<NoteFormValues>(() =>
    restored === null ? valuesFrom(note) : valuesFromDraft(restored),
  )
  const [problem, setProblem] = useState<string | null>(null)
  /** 恢复提示条上那个时刻。`null` 表示当前这份内容不是从草稿恢复来的。 */
  const [restoredAt, setRestoredAt] = useState<string | null>(restored?.savedAt ?? null)
  /** 本机存储写不进去（配额满、存储被禁）。只置一次，不反复提示。 */
  const [draftUnavailable, setDraftUnavailable] = useState(false)
  const [syncedNoteId, setSyncedNoteId] = useState<string | null>(noteId)

  /**
   * 最新的一份输入。
   *
   * 三个写入触发点里有两条（页面隐藏、组件卸载）不在渲染期执行，拿不到当次渲染的
   * `values`，只能从 ref 读；而它们若把 `values` 放进依赖数组，每敲一个字都会重新
   * 增删一遍监听。因此在 effect 里更新 ref，而不是在渲染期写。
   */
  const latestRef = useRef({ note, noteId, values, canWrite })
  useEffect(() => {
    latestRef.current = { note, noteId, values, canWrite }
  })

  /**
   * 提交成功后置真：此后不再往草稿槽里写，直到用户再次动手。
   *
   * 它挡的是本任务最隐蔽的那个坑。提交成功时父组件先换 `selectedId`、编辑器随之
   * 重挂，而**旧实例的卸载 flush 是在重挂之后才执行的**；那一刻旧实例手上的 `note`
   * 还是 `null`（列表尚未重拉完），`hasChanges` 恒为真，于是刚提交的内容被写回
   * `'new'` 槽 —— 下次点「新建」就会恢复出这条已经存过的纪要。单测与类型检查都拦
   * 不住它，只有浏览器 e2e 能复现。
   *
   * 重置放在输入回调里而不是 effect 里：提交成功后紧跟的 `setValues(valuesFrom(saved))`
   * 也是一次 values 变化，若在 effect 里重置，标记会被它立刻清掉，等于没挡。
   */
  const committedRef = useRef(false)

  /**
   * 落一次草稿。三个触发点最后都走到这里。
   *
   * 依赖数组为空是刻意的：它只读 `latestRef` 与两个 ref，不需要跟着任何值重建 ——
   * 否则下面三个 effect 的依赖会跟着变，监听被反复增删。
   */
  const persistDraft = useCallback((): void => {
    const current = latestRef.current
    // 只读访客没有可写的东西，也就没有草稿可言。
    if (!current.canWrite) return
    // 见 `committedRef` 的说明。
    if (committedRef.current) return
    // 改了又改回原样：清掉草稿。留一条与库里一致的「未保存内容」，只会在重进时
    // 凭空弹一次恢复提示，而恢复出来的东西与库里一模一样 —— 纯噪音。
    if (!hasChanges(current.note, current.values)) {
      clearNoteDraft(current.noteId)
      return
    }
    writeNoteDraft(current.noteId, current.values, {
      // 只在彻底写不进去时响一次。每次输入都提示的结果是用户学会忽略它。
      onWriteError: () => setDraftUnavailable(true),
    })
  }, [])

  // ① 输入防抖。**清理函数只清定时器、不落盘**：若在清理里也写一次，那么每敲一个字
  //    都会触发上一轮的清理，等于变成「每次输入都立即写」，防抖整个失效。
  useEffect(() => {
    const timer = window.setTimeout(persistDraft, DRAFT_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [values, persistDraft])

  // ② 页面隐藏时立即落盘。**这才是「误关恢复」真正依赖的那一条**：用户打完最后一个字、
  //    不到 500ms 就关掉标签页时，防抖还没到期。用 `pagehide` 而不是 `beforeunload`——
  //    后者在移动端与部分浏览器上不可靠；`visibilitychange` 再补上「切到别的应用」
  //    「手机切后台」这类不触发 `pagehide` 的场景。
  useEffect(() => {
    const flush = () => persistDraft()
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [persistDraft])

  // ③ 卸载时立即落盘。切板块、被检索筛掉、归档之后编辑器重挂，都走这一条。
  //    （注册一次即可：`persistDraft` 是稳定的，依赖数组不会变。）
  useEffect(() => () => persistDraft(), [persistDraft])

  // 只在「正在编辑哪一条」的身份变化时补一次同步。
  //
  // 为什么单靠父组件的 `key` 不够：新建成功那一刻，父组件先 `setSelectedId(created.id)`
  // 再重拉列表，key 由 `'new'` 变成新 id、组件重挂，而重挂时列表里还没有这一条，
  // `note` 仍是 null，草稿于是初始化成空白，且此后再无同步时机 —— 表现是「刚创建的
  // 纪要，右侧编辑器一片空白、标题计数 0/200、预览显示空态提示」，而左侧列表里它好好
  // 地躺着。保存按钮还因为 `hasChanges(null, 空白)` 为真而亮着，点下去只会收到
  // 「标题不能为空」。
  //
  // 判据用 id 而不是整个 note：同一条纪要因列表重拉而换了对象引用时不重置草稿，
  // 否则用户正在输入的内容会被冲掉。
  if (noteId !== syncedNoteId) {
    setSyncedNoteId(noteId)
    setValues(valuesFrom(note))
    // 身份换了，之前那条的恢复提示也就失效了。
    setRestoredAt(null)
  }

  const isNew = note === null

  if (!canWrite) {
    return (
      <article className="flex flex-col gap-3">
        <h3 className="text-base font-medium text-foreground">{note?.title ?? '未命名纪要'}</h3>
        {note !== null && note.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {note.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-md bg-secondary px-1.5 py-0.5 text-xs text-secondary-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
        <MarkdownPreview content={note?.content ?? ''} />
        <p className="text-xs text-muted-foreground-weak">
          当前角色只能查看纪要。需要撰写或修改时，请联系管理员调整权限。
        </p>
      </article>
    )
  }

  async function handleSave(): Promise<void> {
    const title = values.title.trim()
    if (title === '') {
      setProblem('标题不能为空。')
      return
    }
    if (title.length > NOTE_LIMITS.TITLE_MAX) {
      setProblem(`标题不超过 ${NOTE_LIMITS.TITLE_MAX} 字。`)
      return
    }
    if (values.content.length > NOTE_LIMITS.CONTENT_MAX) {
      setProblem(`正文不超过 ${NOTE_LIMITS.CONTENT_MAX} 字。`)
      return
    }
    if (values.tags.some((tag) => !isValidNoteTag(tag))) {
      setProblem(`每个标签不超过 ${NOTE_LIMITS.TAG_MAX} 字，请删掉标红的那一个。`)
      return
    }
    if (values.tags.length > NOTE_LIMITS.TAGS_MAX_COUNT) {
      setProblem(`最多 ${NOTE_LIMITS.TAGS_MAX_COUNT} 个标签。`)
      return
    }
    if (!hasChanges(note, values)) return

    setProblem(null)
    try {
      // 标题在这里就 trim 掉，与上面 `hasChanges` 的比较口径保持一致。发给服务端一份
      // 带尾随空格的标题，返回来的却是不带的，两次之后草稿与库里的值就会开始漂移。
      const saved = await onSubmit({ ...values, title })
      // 这份内容已经落库，草稿槽不该再留着它 —— 尤其新建时：留着会让下次点「新建」
      // 恢复出这一条已经提交过的纪要。同时置标记挡住紧随其后的卸载 flush（见
      // `committedRef`）。两件事必须都做，只做其中一件都挡不住。
      committedRef.current = true
      clearNoteDraft(noteId)
      // 保存成功后把草稿对齐到服务端返回的那份：正文与标签都可能被服务端归一
      // （例如标签去重），不对齐的话界面显示的仍是本地的猜测。
      setValues(valuesFrom(saved))
      setRestoredAt(null)
    } catch (error) {
      // 只显示可展示的文案。`ApiError` 的 message 由服务端给出（例如「标题不能为空，
      // 且不超过 200 字」），对使用者有意义；其余异常一律给一句概括，不把原文摊出来 ——
      // 堆栈与内部错误码对使用者没有意义，还可能带出内部路径。
      setProblem(error instanceof ApiError ? error.message : '保存失败，请稍后重试')
    }
  }

  /**
   * 输入变更。
   *
   * 顺带解除「提交成功后暂停写草稿」的标记：用户又动手了，这份内容重新变成「未提交」，
   * 草稿该重新记录。（放在输入回调里而不是某个 effect 里，理由见 `committedRef`。）
   */
  function editValues(update: (current: NoteFormValues) => NoteFormValues): void {
    committedRef.current = false
    setValues(update)
  }

  /**
   * 丢弃恢复来的草稿，回到库里的那一份。
   *
   * 同样置 `committedRef`：丢弃之后这份内容不该再被写回草稿槽。否则用户点了丢弃、
   * 一个字没改就切走，卸载 flush 会把它原样存回来 —— 界面表现为「丢弃了，但下次还在」。
   * 用户之后一旦重新输入，`editValues` 会把这个标记放开。
   */
  function handleDiscardDraft(): void {
    committedRef.current = true
    clearNoteDraft(noteId)
    setValues(valuesFrom(note))
    setRestoredAt(null)
    setProblem(null)
  }

  const titleLength = values.title.trim().length

  return (
    <div className="flex flex-col gap-4">
      {/* 恢复提示条。只在本次挂载真的从草稿恢复过时出现 —— 它是「你上次没保存完」的
          告知，不是常驻状态。用户读完就知道该接着写还是该丢掉。 */}
      {restoredAt !== null && (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border bg-accent px-3 py-2"
        >
          <span className="text-xs text-muted-foreground">
            已恢复上次未保存的内容 · 自动保存于 {formatRelativeTime(restoredAt)}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={handleDiscardDraft}>
            丢弃草稿
          </Button>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="note-title" className="text-sm font-normal text-muted-foreground">
            标题
          </Label>
          <span className="text-xs text-muted-foreground-weak">
            {titleLength} / {NOTE_LIMITS.TITLE_MAX}
          </span>
        </div>
        <Input
          id="note-title"
          value={values.title}
          disabled={busy}
          autoComplete="off"
          placeholder="这条纪要关于什么"
          onChange={(event) => editValues((current) => ({ ...current, title: event.target.value }))}
        />
      </div>

      <TagInput
        id="note-tags"
        value={values.tags}
        candidates={tagCandidates}
        disabled={busy}
        onChange={(tags) => editValues((current) => ({ ...current, tags }))}
      />

      {/* 左右两栏。`md` 以下堆叠：窄屏并排会把两栏都压到不可读的宽度，而预览恰恰
          是需要宽度才看得出效果的部分。 */}
      <div className="grid gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="note-content" className="text-sm font-normal text-muted-foreground">
            正文（Markdown）
          </Label>
          <Textarea
            id="note-content"
            value={values.content}
            disabled={busy}
            // 内容多行，用等宽字体：表格与列表在等宽下对齐，写的时候就能看出结构。
            className="min-h-72 resize-y font-mono text-sm"
            placeholder="支持标题、列表、引用、代码块、表格与任务列表。"
            onChange={(event) =>
              editValues((current) => ({ ...current, content: event.target.value }))
            }
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-normal text-muted-foreground">预览</span>
          <div className="min-h-72 rounded-md border border-border bg-card px-3 py-2">
            <MarkdownPreview content={values.content} />
          </div>
        </div>
      </div>

      {problem !== null && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}

      {/* 草稿写不进去时的告知。**只出现一次、不重复弹**：它是「别以为存住了」的
          提醒，每次输入都弹会变成噪音，而噪音的结果是用户学会忽略它。 */}
      {draftUnavailable && (
        <p className="text-xs text-muted-foreground-weak">
          自动保存暂不可用（本机存储写入失败），请手动点「{isNew ? '创建' : '保存'}」。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          disabled={busy || !hasChanges(note, values)}
          onClick={() => void handleSave()}
        >
          {busy ? '保存中…' : isNew ? '创建' : '保存'}
        </Button>

        {/* 置顶与归档各是独立的一条幂等 PUT，不并进保存。理由见
            `apps/api/src/routes/notes.ts` 该路由的注释：它们失败时该弹回去的东西
            与「保存失败」完全不同 —— 前者只要把星标弹回去，后者要把内容留在编辑器里。
            新建状态下两者都不显示：还没落库的那一条谈不上置顶或归档。 */}
        {!isNew && note !== null && (
          <>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onTogglePin(!note.pinned)}
            >
              {note.pinned ? <PinOff /> : <Pin />}
              {note.pinned ? '取消置顶' : '置顶'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onToggleArchive(note.archivedAt === null)}
            >
              {note.archivedAt === null ? <Archive /> : <ArchiveRestore />}
              {note.archivedAt === null ? '归档' : '取消归档'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="ml-auto text-destructive hover:text-destructive"
              disabled={busy}
              onClick={onDelete}
            >
              <Trash2 />
              删除
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
