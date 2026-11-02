import { ROLE_CODES } from '@fanhe/shared'
import { KeyRound, LoaderCircle, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'

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
import { ApiError } from '../../lib/api'
import { saveQuoteSecret, unlockQuote } from '../../lib/quote'
import { describeUnlockSituation, resolveUnlockSituation } from '../../lib/quote-display'

/**
 * 价格维护的口令门。
 *
 * ## 三种形态，由服务端的 `access-state` 决定，不由界面猜
 *
 * - **直接可改**（owner）：不给输入框，只显示「超级管理员可直接维护」，另给一个
 *   「设置 / 修改口令」的入口 —— 那是这个角色唯一需要做的事。
 * - **还没设过口令**：owner 提示先设一个；其他人提示去找超管。**不能让人在这里自己
 *   设**，否则任何登录用户都能把这把锁换成自己的。
 * - **有口令**：输入框 + 剩余次数。
 *
 * ## 为什么失败后要重新拉一次 access-state
 *
 * 服务端的失败响应里带 `failCount` / `lockedUntil`，但 `ApiError` 只保留错误码与
 * 文案（那是所有接口共用的形状，为一处特例改它不值当）。而「还剩几次」「锁到几点」
 * 恰恰是用户此刻最需要的信息 —— 所以失败后补一次 `access-state`，用权威数据渲染，
 * 而不是在本地猜「刚才那次算第几次」。
 *
 * ## 口令框的显隐
 *
 * 默认 `type="password"`，但给一个「显示」的切换。这是**在录入一个可能很长、且
 * 输错五次就锁 15 分钟**的口令，看不清会显著提高输错率 —— 而输错三次之后用户就
 * 开始怀疑是不是自己记错了。
 *
 * ## 为什么拆成外壳 + 表单两层
 *
 * 表单里的口令框、错误文案、当前形态，**每次打开都该是干净的**。直觉写法是「组件
 * 常驻，`useEffect([open])` 里清一遍」，但那会撞 `react-hooks/set-state-in-effect`，
 * 而且那一版有真的问题：effect 在提交之后才跑，重新打开的那一帧会先闪一次上一次的
 * 错误文案。
 *
 * 拆开之后，重置由**挂载**完成 —— `DialogContent` 关闭即卸载，下次打开是全新的
 * state。剩下的「打开时该显示哪种形态」不再靠 effect 写入，而是渲染时推导：
 * `modeOverride ?? 由 state 推出来的默认形态`。用户点过「改口令」之后停在那个形态，
 * 靠的是 `override` 非空，而不是再写一个 effect 去盖。
 */
type PriceGateDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 服务端的准入状态。null 表示还没取到（面板在加载）。 */
  state: {
    role: string
    direct: boolean
    hasSecret: boolean
    unlockedUntil: string | null
    lockedUntil: string | null
    failCount: number
    failLimit: number
    passwordMin: number
  } | null
  /** 解锁成功、或一次尝试失败（需要刷新剩余次数）。调用方据此重拉状态。 */
  onStateChanged: () => void
}

type Mode = 'unlock' | 'create' | 'rotate'

export function PriceGateDialog({
  open,
  onOpenChange,
  state,
  onStateChanged,
}: PriceGateDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <PriceGateForm state={state} onOpenChange={onOpenChange} onStateChanged={onStateChanged} />
      </DialogContent>
    </Dialog>
  )
}

/** 当前该显示哪种形态。owner 才有「设置 / 修改口令」这两档。 */
function resolveDefaultMode(state: PriceGateDialogProps['state']): Mode {
  if (state === null || !state.direct) return 'unlock'
  return state.hasSecret ? 'rotate' : 'create'
}

function PriceGateForm({
  state,
  onOpenChange,
  onStateChanged,
}: Omit<PriceGateDialogProps, 'open'>) {
  const [modeOverride, setModeOverride] = useState<Mode | null>(null)
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const mode = modeOverride ?? resolveDefaultMode(state)
  const situation = state === null ? null : resolveUnlockSituation(state)
  const isOwner = state?.role === ROLE_CODES.OWNER
  const lockedUntil = state?.lockedUntil ?? null
  const locked = lockedUntil !== null && new Date(lockedUntil).getTime() > now

  // 锁定倒计时。只在锁定时跳，没锁就不占一个定时器。
  useEffect(() => {
    if (!locked) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [locked])

  const remainingSeconds =
    locked && lockedUntil !== null
      ? Math.max(0, Math.ceil((new Date(lockedUntil).getTime() - now) / 1000))
      : 0
  const remainingMinutes = Math.floor(remainingSeconds / 60)
  const remainingRest = remainingSeconds % 60

  const title =
    mode === 'unlock' ? '输入维护口令' : mode === 'create' ? '设置维护口令' : '修改维护口令'
  const description =
    mode === 'unlock'
      ? '价格维护受口令保护。输入一次后，返回的这段时间内都可以直接改价。'
      : mode === 'create'
        ? '设置一个只有你知道的口令。之后其他人要改价，都必须先输入它。'
        : '改完之后，其他设备上已经打开的维护权限会立即失效。'

  async function handleSubmit(): Promise<void> {
    if (state === null) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      if (mode === 'unlock') {
        await unlockQuote(password)
        onStateChanged()
        onOpenChange(false)
        return
      }
      await saveQuoteSecret(password, mode === 'create' ? 'create' : 'rotate')
      setNotice(mode === 'create' ? '口令已设置' : '口令已更新')
      onStateChanged()
      // 设完口令不关窗：owner 通常接着去看维护区，而「口令设好了但窗口还在」比
      // 「窗口突然消失、不确定成没成功」更容易理解。改成切到「已设置」形态。
      setModeOverride('rotate')
      setPassword('')
    } catch (caught) {
      const message = caught instanceof ApiError ? caught.message : '操作失败，请稍后重试'
      setError(message)
      if (mode === 'unlock') {
        // 失败后让服务端说「还剩几次 / 锁到几点」，见文件头。
        onStateChanged()
      }
    } finally {
      setBusy(false)
    }
  }

  const submitDisabled =
    busy ||
    password.length === 0 ||
    (mode !== 'unlock' && password.length < (state?.passwordMin ?? 8))

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="size-4" />
          {title}
        </DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3">
        {/* 当前状态一句话。**不写成「无权限」** —— owner 看到那句会以为自己被降权了。 */}
        {situation !== null && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            {describeUnlockSituation(situation)}
            {state !== null && state.failCount > 0 && !locked
              ? ` · 已错 ${state.failCount}/${state.failLimit} 次`
              : ''}
          </p>
        )}

        {!isOwner && state !== null && !state.hasSecret ? (
          <p className="rounded-lg border border-border bg-muted/50 p-3 text-sm text-muted-foreground">
            还没有设置过维护口令。请让超级管理员先设置一个，再来这里解锁。
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label htmlFor="quote-gate-password" className="text-sm font-medium">
              口令
            </label>
            <div className="flex gap-2">
              <Input
                id="quote-gate-password"
                type={reveal ? 'text' : 'password'}
                value={password}
                autoComplete="off"
                disabled={locked || busy}
                minLength={mode === 'unlock' ? 1 : (state?.passwordMin ?? 8)}
                placeholder={
                  mode === 'unlock'
                    ? '输入维护口令'
                    : `至少 ${state?.passwordMin ?? 8} 位，建议记在只有你知道的地方`
                }
                onChange={(event) => setPassword(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !submitDisabled) void handleSubmit()
                }}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setReveal((value) => !value)}
                disabled={locked}
              >
                {reveal ? '隐藏' : '显示'}
              </Button>
            </div>
          </div>
        )}

        {locked && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            口令已锁定，请 {remainingMinutes > 0 ? `${remainingMinutes} 分 ` : ''}
            {remainingRest} 秒后再试。
          </p>
        )}

        {error !== null && !locked && <p className="text-sm text-destructive">{error}</p>}
        {notice !== null && <p className="text-sm text-muted-foreground">{notice}</p>}

        {/* owner 已有口令时，给一条「改口令」的路；同样给一条回去解锁的路。 */}
        {isOwner && state !== null && state.hasSecret && (
          <button
            type="button"
            className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              setModeOverride((current) =>
                (current ?? resolveDefaultMode(state)) === 'rotate' ? 'unlock' : 'rotate',
              )
              setPassword('')
              setError(null)
            }}
          >
            {mode === 'rotate' ? '只是要用一下，不改口令' : '我要改口令'}
          </button>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button
          type="button"
          onClick={() => void handleSubmit()}
          disabled={submitDisabled || locked || (state !== null && !isOwner && !state.hasSecret)}
        >
          {busy ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {mode === 'unlock' ? '解锁' : mode === 'create' ? '设置口令' : '更新口令'}
        </Button>
      </DialogFooter>
    </>
  )
}
