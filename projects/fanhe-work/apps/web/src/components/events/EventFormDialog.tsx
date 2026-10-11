import {
  EVENT_LIMITS,
  EVENT_PRIORITIES,
  isValidNoteTag,
  type Event,
  type EventPriority,
  type EventTagCount,
} from '@fanhe/shared'
import { useState, type FormEvent, type ReactNode } from 'react'

import { ApiError } from '../../lib/api'
import {
  EVENT_PRIORITY_LABELS,
  fromDateTimeLocalValue,
  toDateTimeLocalValue,
} from '../../lib/event-display'
import { TagInput } from '../notes/TagInput'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

/**
 * 表单的值。截止时间已经由 `datetime-local` 的本地时间串转成了 ISO 时刻，
 * 空串则归一成 `null`（表示「没有截止时间」，而不是「没填这一项」）。
 *
 * 这个结构与 `CreateEventRequest` / `UpdateEventRequest` 在字段上是一致的，因此
 * 提交时不必再转换一次；两者的差别只在要求的必填项，由表单校验负责。
 */
export type EventFormValues = {
  title: string
  description: string
  priority: EventPriority
  tags: string[]
  dueAt: string | null
}

type FieldProps = {
  label: string
  htmlFor: string
  error?: string | undefined
  hint?: string | undefined
  children: ReactNode
}

/** 标签 + 控件 + 提示 + 错误的固定结构。抽出来只为统一间距，与启动配置对话框同款。 */
function Field({ label, htmlFor, error, hint, children }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {/* 提示与错误互斥：出错时再说「可选」只是噪音。 */}
      {error !== undefined ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : hint !== undefined ? (
        <p className="text-xs text-muted-foreground-weak">{hint}</p>
      ) : null}
    </div>
  )
}

/**
 * 新增与编辑事件。
 *
 * 与启动配置对话框同一套结构：外层只负责对话框外壳，表单主体在 `EventForm`，
 * 两者分开是因为表单必须**随对话框一起挂载** —— Radix 在退场动画结束后会卸载内容，
 * 于是每次打开都是全新挂载，各字段的初值直接由 props 算出来即可。把表单状态留在外层
 * 的话它会跨多次打开存活，就需要一个「打开时重置」的 effect，而那种 effect 很容易
 * 漏掉某个字段 —— 漏掉的那一个会带着上一次的值被提交出去。
 */
export function EventFormDialog({
  open,
  onOpenChange,
  event,
  tagCandidates,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 传 null 表示新增，传一条事件表示编辑。两种模式共用同一个表单。 */
  event: Event | null
  tagCandidates: readonly EventTagCount[]
  /**
   * 提交。由外层负责真正发请求 —— 新增与编辑走不同的接口，而失败之后要不要刷新列表
   * 也只有外层知道。这里只把校验通过的值交出去，并等它一个结果。
   *
   * 抛出时按失败处理：异常消息显示在表单里，对话框保持打开，用户可以直接改。
   */
  onSubmit: (values: EventFormValues) => Promise<void>
}) {
  const editing = event !== null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑事件' : '新增事件'}</DialogTitle>
          <DialogDescription>
            记下要做的事与它的截止时间。勾选完成与撤销在下一步开放。
          </DialogDescription>
        </DialogHeader>
        <EventForm
          event={event}
          tagCandidates={tagCandidates}
          onSubmit={onSubmit}
          onCancel={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function EventForm({
  event,
  tagCandidates,
  onSubmit,
  onCancel,
}: {
  event: Event | null
  tagCandidates: readonly EventTagCount[]
  onSubmit: (values: EventFormValues) => Promise<void>
  onCancel: () => void
}) {
  const [title, setTitle] = useState(event?.title ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [priority, setPriority] = useState<EventPriority>(event?.priority ?? 'normal')
  const [tags, setTags] = useState<string[]>(event === null ? [] : [...event.tags])
  /**
   * 截止时间在界面上是 `datetime-local` 的本地时间串。
   *
   * 存成本地串而不是 ISO：输入框的 `value` 就是那个形态，中间再转一次只会多出一个
   * 「显示与编辑的形态不一致」的分支。转换只发生在两侧 —— 初值进来时转一次，提交时
   * 转回去（见 `event-display.ts` 里那两个函数）。
   */
  const [dueText, setDueText] = useState(toDateTimeLocalValue(event?.dueAt ?? null))

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  /**
   * 校验。
   *
   * **规则全部来自共享包。** 长度上限、标签的合法形态都是服务端强制的那一份，界面只是
   * 把同样的判断提前做一次，好让用户当场看到问题而不是提交后收一个 400。各写一份的结果
   * 是两边迟早不一致，而那种不一致的表现是「表单说可以，保存失败」。
   *
   * 标题按 **trim 后**判断并 trim 后提交，与服务端的归一一致；描述**不动**（Markdown 的
   * 前导空白有意义，首尾空行是用户看得见的东西）。
   */
  function validate(): EventFormValues | null {
    const errors: Record<string, string> = {}
    const trimmedTitle = title.trim()

    if (trimmedTitle === '') {
      errors.title = '标题不能为空'
    } else if (trimmedTitle.length > EVENT_LIMITS.TITLE_MAX) {
      errors.title = `标题不能超过 ${EVENT_LIMITS.TITLE_MAX} 个字符`
    }

    if (description.length > EVENT_LIMITS.DESCRIPTION_MAX) {
      errors.description = `描述不能超过 ${EVENT_LIMITS.DESCRIPTION_MAX} 个字符`
    }

    if (tags.length > EVENT_LIMITS.TAGS_MAX_COUNT) {
      errors.tags = `最多 ${EVENT_LIMITS.TAGS_MAX_COUNT} 个标签，当前 ${tags.length} 个`
    } else if (tags.some((tag) => !isValidNoteTag(tag))) {
      // 超长标签在 `TagInput` 里是标红保留的，这里负责拦住提交：留着它是为了让用户
      // 看见是哪一个要改，而不是为了让一个必然被拒的请求发出去。
      errors.tags = `单个标签不能超过 ${EVENT_LIMITS.TAG_MAX} 个字符，请改短或删掉标红的那一个`
    }

    // 空串表示不设截止时间，是合法的。非空却解析不出来说明值是被构造出来的 ——
    // 浏览器对这个输入框有取值约束，正常操作走不到这里。
    if (dueText !== '' && Number.isNaN(new Date(dueText).getTime())) {
      errors.due = '截止时间不是合法的日期'
    }

    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) return null

    return {
      title: trimmedTitle,
      description,
      priority,
      tags,
      dueAt: fromDateTimeLocalValue(dueText),
    }
  }

  async function handleSubmit(formEvent: FormEvent<HTMLFormElement>): Promise<void> {
    formEvent.preventDefault()
    if (submitting) return

    const values = validate()
    if (values === null) return

    setSubmitting(true)
    setFormError(null)
    try {
      await onSubmit(values)
      onCancel()
    } catch (error) {
      // 只显示可展示的文案。`ApiError` 的 message 由服务端给出（例如「标题不能为空」），
      // 对使用者有意义；其余异常一律给一句概括，不把原文摊出来。
      setFormError(error instanceof ApiError ? error.message : '保存失败，请稍后重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Field label="标题" htmlFor="event-title" error={fieldErrors.title}>
        <Input
          id="event-title"
          value={title}
          maxLength={EVENT_LIMITS.TITLE_MAX}
          placeholder="要做什么"
          autoComplete="off"
          aria-invalid={fieldErrors.title !== undefined}
          onChange={(changeEvent) => setTitle(changeEvent.target.value)}
        />
      </Field>

      <Field
        label="描述（可选）"
        htmlFor="event-description"
        error={fieldErrors.description}
        hint="支持 Markdown，详情面板会原样渲染"
      >
        <Textarea
          id="event-description"
          value={description}
          rows={4}
          maxLength={EVENT_LIMITS.DESCRIPTION_MAX}
          placeholder="补充细节、验收标准、关联的人…"
          aria-invalid={fieldErrors.description !== undefined}
          onChange={(changeEvent) => setDescription(changeEvent.target.value)}
        />
      </Field>

      {/* 优先级用三个按钮而不是下拉：只有三档，全部摆出来比「点开才知道有什么」快，
          也与启动配置对话框里选软件那组保持同一种形态。 */}
      <Field label="优先级" htmlFor="event-priority">
        <div id="event-priority" className="flex flex-wrap gap-2">
          {EVENT_PRIORITIES.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={priority === option ? 'default' : 'outline'}
              aria-pressed={priority === option}
              onClick={() => setPriority(option)}
            >
              {EVENT_PRIORITY_LABELS[option]}
            </Button>
          ))}
        </div>
      </Field>

      {/* 标签输入复用纪要那个控件（见 `event.ts` 顶部关于标签的说明）。上限显式传入 ——
          两个板块的上限取值相同但各自定义，控件里写死哪一份都会让另一边的改动失效。 */}
      <TagInput
        id="event-tags"
        value={tags}
        candidates={tagCandidates}
        maxTags={EVENT_LIMITS.TAGS_MAX_COUNT}
        onChange={setTags}
      />
      {fieldErrors.tags !== undefined && (
        <p role="alert" className="text-xs text-destructive">
          {fieldErrors.tags}
        </p>
      )}

      <Field
        label="截止时间（可选）"
        htmlFor="event-due"
        error={fieldErrors.due}
        hint="留空表示不设截止时间"
      >
        <div className="flex items-center gap-2">
          <Input
            id="event-due"
            type="datetime-local"
            value={dueText}
            className="w-fit"
            aria-invalid={fieldErrors.due !== undefined}
            onChange={(changeEvent) => setDueText(changeEvent.target.value)}
          />
          {/* `datetime-local` 没有自带的清空入口，而「把已经设过的截止时间取消掉」
              是一个真实动作（服务端也用显式的 null 表达它）。只在有值时才出现，
              省掉一个常驻的空按钮。 */}
          {dueText !== '' && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setDueText('')}>
              清除
            </Button>
          )}
        </div>
      </Field>

      {formError !== null && (
        <p role="alert" className="text-sm text-destructive">
          {formError}
        </p>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" disabled={submitting} onClick={onCancel}>
          取消
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting ? '保存中…' : '保存'}
        </Button>
      </DialogFooter>
    </form>
  )
}
