import {
  NOTE_LIMITS,
  isValidNoteTag,
  normalizeNoteTags,
  parseNoteTagInput,
  type NoteTagCount,
} from '@fanhe/shared'
import { X } from 'lucide-react'
import { useState } from 'react'

import { cn } from '../../lib/utils'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

/**
 * 标签输入。
 *
 * **拆分规则来自共享包，不在这里重写一遍。** `parseNoteTagInput` 认中英文逗号与换行，
 * 并在拆分后立刻归一。理由写在那个函数的注释里，这里只重复结论：界面上显示三个标签、
 * 库里存了四个，是这类控件最容易产生又最难解释的偏差。
 *
 * 三条交互约定：
 *
 *   1. **打完分隔符立刻成条。** 输入 `工作,` 之后逗号不该留在输入框里等下一次提交 ——
 *      它已经在语义上完成了「这一个标签到此为止」。因此只有在输入里出现分隔符时才
 *      拆分，末尾那一段（可能还没打完）留在输入框内。
 *   2. **超长标签照样进列表，标红而不是丢掉。** 丢掉的话用户会以为是自己没打进去，
 *      而界面又无法指出是哪一个被吃掉了。标出来之后，编辑器的保存按钮会连带被拦下，
 *      用户知道该删哪一个。
 *   3. **超出数量上限时拒绝新增并说明。** 服务端对超过上限的提交直接 400，与其等提交
 *      后失败，不如在加的那一下就说清楚。
 *
 * 候选来自标签清单接口（全量标签及其条数），不是从当前列表页聚合出来的 —— 列表将来
 * 分页之后就推不出全量了，而候选恰恰需要全量。
 *
 * **事件板块复用这个控件**（见 `event.ts` 顶部关于标签的说明：标签在两个板块里是同一个
 * 概念）。数量上限因此从 props 进来：`NOTE_LIMITS` 与 `EVENT_LIMITS` 的取值刻意保持
 * 一致，但它们是两份独立定义的常量，控件里写死哪一份都会让另一边的上限改动悄悄失效。
 */
export function TagInput({
  id,
  value,
  candidates,
  onChange,
  disabled = false,
  maxTags = NOTE_LIMITS.TAGS_MAX_COUNT,
}: {
  id: string
  value: readonly string[]
  candidates: readonly NoteTagCount[]
  onChange: (tags: string[]) => void
  disabled?: boolean
  /** 数量上限。缺省用纪要那一份，事件板块显式传入 `EVENT_LIMITS.TAGS_MAX_COUNT`。 */
  maxTags?: number
}) {
  const [draft, setDraft] = useState('')
  const [warning, setWarning] = useState<string | null>(null)

  /** 已选之外、且匹配当前输入的候选。空输入时给前几个，相当于「你以前用过这些」。 */
  const draftTrimmed = draft.trim()
  const suggestions = candidates
    .filter((item) => !value.includes(item.tag))
    .filter((item) => draftTrimmed === '' || item.tag.includes(draftTrimmed))
    .slice(0, 8)

  function commit(raw: string): void {
    const parsed = parseNoteTagInput(raw)
    if (parsed.length === 0) return

    const remaining = maxTags - value.length
    if (remaining <= 0) {
      setWarning(`最多 ${maxTags} 个标签，先删掉一个再加。`)
      return
    }

    const accepted = parsed.slice(0, remaining)
    if (accepted.length < parsed.length) {
      setWarning(`最多 ${maxTags} 个标签，本次只加进了前 ${accepted.length} 个。`)
    } else {
      setWarning(null)
    }
    // 归一放在这里再做一次而不是相信 `parsed`：`value` 是外部传进来的，与草稿合并后
    // 才构成完整的集合，去重必须对合并后的结果做。
    onChange(normalizeNoteTags([...value, ...accepted]))
  }

  /**
   * 输入变化。
   *
   * 只在真的出现分隔符时才走拆分路径 —— 否则每敲一个字符都要跑一次正则与数组构造，
   * 而这条路径在打字时每键都会走到。
   */
  function handleChange(text: string): void {
    if (!/[,，\r\n]/.test(text)) {
      setDraft(text)
      return
    }
    const parts = text.split(/[,，\r\n]+/)
    // `pop` 取走末尾那一段。它可能是「刚输完一个逗号」留下的空串，也可能是一个
    // 还没打完的标签，两种情况都该留在输入框里。
    const trailing = parts.pop() ?? ''
    commit(parts.join(','))
    setDraft(trailing)
  }

  function removeTag(tag: string): void {
    setWarning(null)
    onChange(value.filter((item) => item !== tag))
  }

  function addSuggestion(tag: string): void {
    commit(tag)
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal text-muted-foreground">
        标签
      </Label>

      {/* 已选的标签与输入框分开排，**不把它们塞进同一个带描边的容器**。

          那样做视觉上更紧凑，但要覆盖 `Input` 自带的 `h-9` 与 `border`，而这两条覆盖
          并不可靠：Tailwind 里同类工具类的胜负由生成顺序决定，不由类名字符串的先后
          决定，`h-7` 与 `h-9` 谁生效取决于两者的数值排序。写一组「看起来对、换个
          版本就变」的覆盖，不如让输入框保持它本来的样子。 */}
      {value.length > 0 && (
        <div className={cn('flex flex-wrap items-center gap-1.5', disabled && 'opacity-60')}>
          {value.map((tag) => {
            const valid = isValidNoteTag(tag)
            return (
              <span
                key={tag}
                className={cn(
                  'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs',
                  valid
                    ? 'bg-secondary text-secondary-foreground'
                    : 'bg-destructive/10 text-destructive',
                )}
                title={valid ? undefined : `标签最长 ${NOTE_LIMITS.TAG_MAX} 字，这一条需要改短`}
              >
                <span className="max-w-40 truncate">{tag}</span>
                <button
                  type="button"
                  disabled={disabled}
                  aria-label={`移除标签 ${tag}`}
                  className="-mr-0.5 rounded-sm opacity-60 transition-opacity hover:opacity-100 disabled:cursor-not-allowed"
                  onClick={() => removeTag(tag)}
                >
                  <X className="size-3" />
                </button>
              </span>
            )
          })}
        </div>
      )}

      <Input
        id={id}
        value={draft}
        disabled={disabled}
        placeholder={value.length === 0 ? '回车或逗号分隔，例如：客户A，报价' : '继续添加标签'}
        autoComplete="off"
        onChange={(event) => handleChange(event.target.value)}
        onBlur={() => {
          commit(draft)
          setDraft('')
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // 不加这一句，回车会触发表单提交 —— 而这里只是想「把当前这个标签收下」。
            event.preventDefault()
            commit(draft)
            setDraft('')
            return
          }
          if (event.key === 'Backspace' && draft === '') {
            const last = value[value.length - 1]
            if (last !== undefined) removeTag(last)
            return
          }
          if (event.key === 'Escape' && draft !== '') {
            event.preventDefault()
            setDraft('')
          }
        }}
      />

      {warning !== null && (
        <p role="alert" className="text-xs text-destructive">
          {warning}
        </p>
      )}

      {/* 候选。已用过的标签往往就是要再用的那一个，而「想起来原文是什么」比点一下贵得多。 */}
      {!disabled && suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-xs text-muted-foreground-weak">已有：</span>
          {suggestions.map((item) => (
            <button
              key={item.tag}
              type="button"
              className="rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              onClick={() => addSuggestion(item.tag)}
            >
              {item.tag}
              <span className="ml-0.5 text-muted-foreground-weak">{item.count}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
