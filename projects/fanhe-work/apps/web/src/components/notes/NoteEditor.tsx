import { NOTE_LIMITS, isValidNoteTag, type Note, type NoteTagCount } from '@fanhe/shared'
import { Archive, ArchiveRestore, Pin, PinOff, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { ApiError } from '../../lib/api'
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
 * **草稿的初始值只在这里算一次。** 父组件用 `key` 区分「新建」与「某一条」，
 * 换一条就重挂一次，不需要用 effect 去同步 `note` —— `useEffect` + `setState`
 * 的同步写法会在父组件重渲染时把用户正在输入的内容冲掉，而那个 bug 只在「加载完
 * 数据的同时用户已经打字」时出现，极难复现。
 *
 * **只读访客走另一条分支**：直接渲染 Markdown 预览，不给输入框。把输入框置灰也行，
 * 但一个全是灰输入框的页面看起来像是坏了，而这里想传达的是「你有权看这条」。
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

/**
 * 判断草稿与已保存的那一条是否真的不同。
 *
 * 标题按 **trim 后**比较，正文原样比较。这个不对称是有意的：服务端保存标题时会 trim，
 * 正文不会（Markdown 里的前导空白有意义）。若标题也原样比较，那么在末尾多打一个空格
 * 就会被判为「有改动」，提交后服务端 trim 掉、返回的标题与原文相同，而 `updatedAt`
 * 已经变了 —— 「这条什么时候被改过」这条信息就此失真。
 */
function hasChanges(note: Note | null, values: NoteFormValues): boolean {
  if (note === null) return true
  return (
    note.title !== values.title.trim() ||
    note.content !== values.content ||
    note.tags.length !== values.tags.length ||
    note.tags.some((tag, index) => tag !== values.tags[index])
  )
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
  const [values, setValues] = useState<NoteFormValues>(() => valuesFrom(note))
  const [problem, setProblem] = useState<string | null>(null)

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
      // 保存成功后把草稿对齐到服务端返回的那份：正文与标签都可能被服务端归一
      // （例如标签去重），不对齐的话界面显示的仍是本地的猜测。
      setValues(valuesFrom(saved))
    } catch (error) {
      // 只显示可展示的文案。`ApiError` 的 message 由服务端给出（例如「标题不能为空，
      // 且不超过 200 字」），对使用者有意义；其余异常一律给一句概括，不把原文摊出来 ——
      // 堆栈与内部错误码对使用者没有意义，还可能带出内部路径。
      setProblem(error instanceof ApiError ? error.message : '保存失败，请稍后重试')
    }
  }

  const titleLength = values.title.trim().length

  return (
    <div className="flex flex-col gap-4">
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
          onChange={(event) => setValues((current) => ({ ...current, title: event.target.value }))}
        />
      </div>

      <TagInput
        id="note-tags"
        value={values.tags}
        candidates={tagCandidates}
        disabled={busy}
        onChange={(tags) => setValues((current) => ({ ...current, tags }))}
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
              setValues((current) => ({ ...current, content: event.target.value }))
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
