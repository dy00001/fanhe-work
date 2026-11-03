import { QUOTE_LIMITS } from '@fanhe/shared'
import { KeyRound, LoaderCircle } from 'lucide-react'
import { useState } from 'react'

import { ApiError } from '../../../lib/api'
import { saveQuoteSecret } from '../../../lib/quote'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'

/**
 * 维护台里的「后台编辑口令」设置条。**只有超级管理员能看到这个组件。**
 *
 * ## 为什么放在维护台里，而不只留在价格门上
 *
 * 口令原本只能从 `PriceGateDialog` 里设 —— 而那个弹窗对 owner 根本不会出现：
 * `QuotePanel` 的判断是「`access.direct` 就直接开维护台」，超管走的是直入路径，
 * 于是设 / 改口令这件事在界面上**没有入口**，只能靠调接口。用户报的就是这个缺口。
 *
 * ## 为什么是行内展开，不是再套一层 Dialog
 *
 * 维护台自己已经是一个满屏 Dialog。在里面再开一个 Dialog，焦点陷阱、Esc 的归属、
 * 两层遮罩的层叠都要额外处理，而这一条只有三个控件 —— 摊开比叠起来更省事，也不会
 * 出现「关错层」这种让人以为没保存的错觉。
 *
 * ## 状态为什么能靠挂载清空
 *
 * 父组件写成 `{secretOpen && <QuoteSecretPanel … />}`。收起即卸载，下次打开是两个空
 * 输入框、没有上一次的错误文案。换成常驻 + `useEffect` 清 state 的写法，会撞
 * `react-hooks/set-state-in-effect`，而且那一版在重新打开的第一帧会先闪一次旧内容。
 *
 * ## 两次输入为什么必须一致
 *
 * 这是**唯一**能改这把锁的地方，改完所有设备都要用新口令。打成自己都记不住的串，
 * 就只能再改一次 —— 而改它需要先证明自己是超管，容错很低。所以确认框是硬条件，
 * 不是「建议」。
 */
export function QuoteSecretPanel({
  hasSecret,
  onSaved,
  onClose,
}: {
  /** 之前设过没有。决定按钮写「设置」还是「更新」，以及提交走 create 还是 rotate。 */
  hasSecret: boolean
  /** 保存成功。父级据此重拉 access-state（版本变了、hasSecret 可能变了）。 */
  onSaved: () => void
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const min = QUOTE_LIMITS.PASSWORD_MIN
  const max = QUOTE_LIMITS.PASSWORD_MAX

  // 首尾空格一律不算：粘贴一长串时尾随一个空格肉眼看不见，而设口令时带着、解锁时
  // 不带，就会得到「我明明输对了却进不去」。中部空格保留 —— 口令可以是词组。
  const normalized = password.trim()
  const normalizedConfirm = confirm.trim()

  // 三条都是**渲染时算出来的**，不用 state 记。用 state 记的话，清空输入框之后
  // 「太短」的红字会留着，看着像输入框还没被清掉。
  const tooShort = password.length > 0 && normalized.length < min
  const tooLong = normalized.length > max
  // 确认框还在打的时候（比口令短）不报红：逐字符跳「两次不一致」只会制造噪声，
  // 等长度追平了再判。
  const mismatched =
    confirm.length > 0 && normalizedConfirm !== normalized && confirm.length >= normalized.length
  const canSubmit =
    !busy &&
    normalized.length >= min &&
    normalized.length <= max &&
    normalizedConfirm === normalized

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await saveQuoteSecret(normalized, hasSecret ? 'rotate' : 'create')
      setPassword('')
      setConfirm('')
      setNotice(
        hasSecret
          ? `口令已更新（第 ${String(result.version)} 版）。其他设备上已打开的维护权限立刻失效，需要用新口令重新解锁；你这台因为超管直入不受影响。`
          : '口令已设置。之后其他账号要改价，都必须先输入它。',
      )
      onSaved()
    } catch (caught) {
      if (caught instanceof ApiError) {
        // 403 单独给一句：这句要回答「我为什么不能改」，而不是复述「需要维护权限」。
        setError(
          caught.status === 403
            ? '只有超级管理员能修改后台编辑口令。当前账号没有这个权限。'
            : caught.status === 409
              ? `${caught.message}（界面上的状态可能已经过期，收起后重开一次再试）`
              : caught.message,
        )
      } else {
        setError('保存失败，请稍后重试')
      }
    } finally {
      setBusy(false)
    }
  }

  const title = hasSecret ? '更新后台编辑口令' : '设置后台编辑口令'

  return (
    <div className="bg-[color-mix(in_srgb,var(--m-amber)_5%,transparent)] px-5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-foreground">
          <KeyRound className="size-3.5 text-m-amber" />
          {title}
        </span>

        <Input
          type={reveal ? 'text' : 'password'}
          value={password}
          autoComplete="new-password"
          aria-label="新口令"
          disabled={busy}
          placeholder={`新口令（至少 ${String(min)} 位）`}
          onChange={(event) => setPassword(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSubmit) void handleSubmit()
          }}
          className="h-8 w-[190px] text-[12.5px]"
        />
        <Input
          type={reveal ? 'text' : 'password'}
          value={confirm}
          autoComplete="new-password"
          aria-label="确认新口令"
          disabled={busy}
          placeholder="再输一次"
          onChange={(event) => setConfirm(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSubmit) void handleSubmit()
          }}
          className="h-8 w-[150px] text-[12.5px]"
        />

        <button
          type="button"
          onClick={() => setReveal((value) => !value)}
          className="inline-flex h-8 items-center rounded-[7px] border border-border bg-card px-2 text-[12px] text-muted-foreground hover:bg-accent"
        >
          {reveal ? '隐藏' : '显示'}
        </button>

        <Button
          type="button"
          size="sm"
          className="h-8"
          disabled={!canSubmit}
          onClick={() => void handleSubmit()}
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {hasSecret ? '更新口令' : '设置口令'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-8 items-center rounded-[7px] px-2 text-[12px] text-muted-foreground hover:bg-accent"
        >
          收起
        </button>

        {/* 校验提示跟在控件后面，不占一整行：这一条本来就矮，多一行会把分区挤下去。 */}
        <span className="text-[11.5px] text-muted-foreground-weak">
          {mismatched
            ? '两次输入不一致'
            : tooShort
              ? `至少 ${String(min)} 位`
              : tooLong
                ? `最多 ${String(max)} 位`
                : ''}
        </span>
      </div>

      <p className="mt-1.5 text-[11.5px] leading-[1.6] text-muted-foreground-weak">
        {hasSecret
          ? '改完之后，其他设备上已经打开的维护权限会立刻失效，需要用新口令重新解锁。你这台是超管直入，不受影响。'
          : '设置之后，其他账号进入这一屏改价都必须先输入这个口令。它不能用于登录，只保护价格维护。'}
      </p>

      {error !== null && <p className="mt-1 text-[11.5px] text-destructive">{error}</p>}
      {notice !== null && <p className="mt-1 text-[11.5px] text-m-teal">{notice}</p>}
    </div>
  )
}
