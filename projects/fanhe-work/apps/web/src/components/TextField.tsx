import { Input } from './ui/input'
import { Label } from './ui/label'

/**
 * 带标签的文本输入。
 *
 * 标签用 `htmlFor` 与输入框关联，而不是靠位置相邻。点标签聚焦输入框、屏幕
 * 阅读器读出字段名这两件事都依赖这层关联，而它们在视觉上完全看不出来。
 *
 * 内部改用 shadcn/ui 的 `Input` 与 `Label`，对外接口一字未动。保留这一层封装
 * 而不是让调用方直接用 `Input`，是因为「标签 + 输入框 + 提示文字」这套间距与
 * 层级在登录页和初始化页里是同一份规格，摊到五个调用点各写一遍，改一次间距就
 * 要改五处。封装的作用是把规格收在一处，不是把组件再包一层。
 *
 * 标签的字重与颜色显式覆盖了 `Label` 的默认值。shadcn 的默认标签是 `font-medium`
 * 配正文色，而方案 B 的层级靠颜色而非字重区分，标签取次要色、不加粗。这是设计
 * 取向的差异，不是遗漏。
 */
export function TextField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  autoComplete,
  autoFocus = false,
  hint,
  disabled = false,
}: {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  type?: 'text' | 'password'
  autoComplete?: string
  autoFocus?: boolean
  hint?: string
  disabled?: boolean
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm font-normal text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
      />
      {hint !== undefined && <p className="text-xs text-muted-foreground-weak">{hint}</p>}
    </div>
  )
}
