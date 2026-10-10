/**
 * 带标签的文本输入。
 *
 * 标签用 `htmlFor` 与输入框关联，而不是靠位置相邻。点标签聚焦输入框、屏幕
 * 阅读器读出字段名这两件事都依赖这层关联，而它们在视觉上完全看不出来。
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
      <label htmlFor={id} className="text-sm text-ink-soft">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        disabled={disabled}
        className="rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink transition-colors outline-none focus:border-accent disabled:cursor-not-allowed disabled:opacity-60"
      />
      {hint !== undefined && <p className="text-xs text-ink-faint">{hint}</p>}
    </div>
  )
}
