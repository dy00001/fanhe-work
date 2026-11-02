import type {
  AssignableUserDto,
  CustomerRole,
  PoolCustomerDto,
  PoolListResponse,
} from '@fanhe/shared'
import { useCallback, useEffect, useState } from 'react'

import { ApiError } from '../../lib/api'
import {
  confidenceHint,
  formatDateTime,
  poolRoleLabel,
  stageLabel,
  stageTone,
  toneClass,
} from '../../lib/customer-display'
import {
  classifyCustomerPool,
  loadAssignableUsers,
  loadCustomerPool,
  reviewPoolSuggestion,
} from '../../lib/customers'
import { LoadingState } from '../StateView'
import { Badge } from '../ui/badge'
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

/**
 * 公共池归类复核。
 *
 * 一屏回答三个问题：**这批客户有谁、机器建议给谁、凭什么**。三个问题对应三块内容，
 * 缺任何一块复核都做不成：
 *
 *   - 只有名单，复核人得逐个打开群聊天记录才知道该怎么分；
 *   - 只有建议，等于让人签字认可一个黑箱；
 *   - 只有依据，没有一键采用，58 位客户就要点 58 次。
 *
 * ## 为什么备注是整屏共用一个输入框
 *
 * 复核接口要求每条都带一句备注（审计要能回答「为什么划给他」）。给每行配一个输入框
 * 会让一屏出现二十个相同的空框，而绝大多数时候同一批的判断理由是同一个（「这批都是
 * 老客户复购，跟设计师」）。做成顶部一个输入框、作用于本次每一次点击，既满足审计，
 * 又不逼人重复打字。
 *
 * ## 为什么每次动作后整份重拉
 *
 * 采用或调整之后，那一行不再是公共池（有了归属），继续留在列表里会让人以为没生效。
 * 本地删一行也能做到，但「重新判定」会同时改变其余行的建议，两种更新混在一起迟早
 * 出现「界面与库不一致」。公共池最多几十条，重拉一次的代价可以忽略。
 */
export function CustomerPoolDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void
  /** 归属变化后通知外层刷新客户列表：那些行从此会出现在列表里。 */
  onChanged: () => void
}) {
  const [data, setData] = useState<PoolListResponse | null>(null)
  const [users, setUsers] = useState<AssignableUserDto[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [classifying, setClassifying] = useState(false)
  const [note, setNote] = useState('')
  /** 正在「调整」的那一行。一次只展开一行：同时展开多行会让人填错行。 */
  const [adjusting, setAdjusting] = useState<{
    customerId: string
    suggestionId: string
    role: CustomerRole
    userId: string
  } | null>(null)

  const reload = useCallback(async () => {
    const [pool, assignable] = await Promise.all([loadCustomerPool(), loadAssignableUsers()])
    setData(pool)
    setUsers(assignable)
  }, [])

  useEffect(() => {
    let cancelled = false
    Promise.all([loadCustomerPool(), loadAssignableUsers()])
      .then(([pool, assignable]) => {
        if (cancelled) return
        setData(pool)
        setUsers(assignable)
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(describeFailure(caught))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const runClassify = async () => {
    setClassifying(true)
    setError(null)
    try {
      const report = await classifyCustomerPool({})
      await reload()
      /*
       * 报告里最有价值的是 `source`：容器内跑读不到群文件，置信度会被封顶。
       * 这一条必须说出来，否则复核人会把「按阶段猜的」当成「看过聊天记录的」。
       */
      if (report.source === 'stored') {
        setError(
          '判定已完成，但没读到聊天记录（服务端看不到聊天库目录），结论只按阶段推算，置信度已封顶。建议在宿主机上跑一次 db:pool-classify。',
        )
      }
    } catch (caught) {
      setError(describeFailure(caught))
    } finally {
      setClassifying(false)
    }
  }

  const review = async (item: PoolCustomerDto, decision: 'accepted' | 'adjusted' | 'rejected') => {
    if (item.suggestion === null) return
    if (note.trim() === '') {
      setError('请先填写复核备注：三个月后回看「为什么这样分」，只有这句话能回答。')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const input =
        decision === 'adjusted' && adjusting !== null
          ? {
              decision,
              role: adjusting.role,
              userId: adjusting.userId === '' ? null : adjusting.userId,
              note: note.trim(),
            }
          : { decision, note: note.trim() }
      await reviewPoolSuggestion(item.id, item.suggestion.id, input)
      setAdjusting(null)
      await reload()
      onChanged()
    } catch (caught) {
      setError(describeFailure(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      {/* max-w-4xl 而不是 3xl：一行里同时有客户、建议、依据与三个按钮，
          窄一档就会把依据挤成三行，反而更难比较。 */}
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            公共池归类{data === null ? '' : `（${data.total} 位，待复核 ${data.pending} 位）`}
          </DialogTitle>
          <DialogDescription>
            系统按聊天记录里的关键词与当前阶段给出建议。采用即把客户划给建议的账号；
            调整可以改角色或改人；驳回只记状态、不动归属。
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
          <div className="flex-1">
            <label className="text-xs text-muted-foreground" htmlFor="pool-note">
              复核备注（本次每一次采用 / 调整 / 驳回都会记入审计）
            </label>
            <Input
              id="pool-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：复购客户，继续由原设计师跟进"
              className="mt-1"
            />
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void runClassify()}
            disabled={classifying}
          >
            {classifying ? '判定中…' : '重新判定'}
          </Button>
        </div>

        {error === null ? null : <p className="text-sm text-destructive">{error}</p>}

        {data === null ? (
          <LoadingState variant="plain" label="正在加载公共池…" />
        ) : data.items.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            公共池已清空：所有客户都有负责人了。
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {data.items.map((item) => (
              <PoolRow
                key={item.id}
                item={item}
                users={users}
                busy={busy}
                adjusting={adjusting?.customerId === item.id ? adjusting : null}
                onStartAdjust={() => {
                  if (item.suggestion === null) return
                  setAdjusting({
                    customerId: item.id,
                    suggestionId: item.suggestion.id,
                    role: item.suggestion.role,
                    // 缺省选中建议的那个人。改角色时由下面的 effect 逻辑不处理，
                    // 由用户自己选 —— 一个设计师的 id 塞进销售下拉里会校验失败。
                    userId: item.suggestion.suggestedUserId ?? '',
                  })
                }}
                onCancelAdjust={() => setAdjusting(null)}
                onChangeAdjust={setAdjusting}
                onAccept={() => void review(item, 'accepted')}
                onAdjust={() => void review(item, 'adjusted')}
                onReject={() => void review(item, 'rejected')}
              />
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PoolRow(props: {
  item: PoolCustomerDto
  users: readonly AssignableUserDto[]
  busy: boolean
  adjusting: { role: CustomerRole; userId: string } | null
  onStartAdjust: () => void
  onCancelAdjust: () => void
  onChangeAdjust: (next: {
    customerId: string
    suggestionId: string
    role: CustomerRole
    userId: string
  }) => void
  onAccept: () => void
  onAdjust: () => void
  onReject: () => void
}) {
  const { item, adjusting } = props
  const suggestion = item.suggestion

  /*
   * 这里刻意不写 `suggestion === null ? null : ...`。
   *
   * 那样写的话，下方 JSX 里 `suggestion === null ? A : (<>...</>)` 的三元虽然收窄了
   * `suggestion`，却不会连带收窄 `hint`，于是每一处引用都要 `hint!` 或可选链，
   * 而真正「没有建议」的情况根本走不到那些分支。给一个用不到的缺省值更干净 ——
   * 它唯一的作用是让类型变成非空。
   */
  const hint = confidenceHint(suggestion?.confidence ?? 0, suggestion?.reasons ?? [])

  return (
    <li className="rounded-xl border border-border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{item.displayName}</span>
        <span className="text-xs text-muted-foreground">{item.region}</span>
        <Badge
          variant="outline"
          className={`${toneClass(stageTone(item.stage))} border-0 text-[10px]`}
        >
          {stageLabel(item.stage)}
        </Badge>
        <span className="text-xs text-muted-foreground-weak">
          {item.msgRows} 条消息 · 最近 {formatDateTime(item.lastMessageAt)}
        </span>
      </div>

      {suggestion === null ? (
        <p className="mt-2 text-xs text-muted-foreground">
          还没有判定结果。点右上角「重新判定」跑一次。
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="text-[10px]">
              {hint.tone === 'none' ? '倾向' : '建议'}归 {poolRoleLabel(suggestion.role)}
              {suggestion.suggestedUserName === null ? '' : ` · ${suggestion.suggestedUserName}`}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {hint.showScore ? `置信度 ${suggestion.confidence}%` : '置信度'}（{hint.label}）
            </span>
            {suggestion.status === 'pending' ? null : (
              <Badge variant="outline" className="text-[10px]">
                已{suggestion.status === 'rejected' ? '驳回' : '复核'}
              </Badge>
            )}
          </div>

          {/*
            证据不足时把话说死：「倾向」而不是「建议」，并单独一行说明为什么。
            没有这一行，0 分会被读成「引擎给了个很弱的判断」，而实际是「没判出来」。
            用 muted 而不是另找警示色：`--m-*` 只在亮色主题里定义了一份，暗色下
            那行会几乎看不见；这里靠位置（紧跟置信度）而不是颜色来突出。
          */}
          {hint.note === null ? null : (
            <p className="mt-1 text-xs text-muted-foreground">{hint.note}</p>
          )}

          {/*
            依据按分值降序展示。`weight` 为 0 的是「说明性依据」（缺原文、证据接近），
            排在最后：它们解释的是「为什么这条不太确定」，与「为什么判成这个角色」
            是两种信息，混排会让人以为系统在自我辩解。
          */}
          <ul className="mt-1 flex flex-col gap-0.5">
            {[...suggestion.reasons]
              .sort((left, right) => right.weight - left.weight)
              .map((reason, index) => (
                <li key={`${reason.code}-${index}`} className="text-xs text-muted-foreground">
                  <span className="text-foreground">{reason.label}</span>
                  <span className="mx-1 text-muted-foreground-weak">·</span>
                  {reason.detail}
                  {reason.weight > 0 ? (
                    <span className="ml-1 text-muted-foreground-weak">+{reason.weight}</span>
                  ) : null}
                </li>
              ))}
          </ul>

          {adjusting === null ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                disabled={props.busy || suggestion.status !== 'pending'}
                onClick={props.onAccept}
              >
                采用
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={props.busy || suggestion.status !== 'pending'}
                onClick={props.onStartAdjust}
              >
                调整
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={props.busy || suggestion.status !== 'pending'}
                onClick={props.onReject}
              >
                驳回
              </Button>
            </div>
          ) : (
            <div className="mt-2 flex flex-wrap items-end gap-2 rounded-lg bg-muted/40 p-2">
              <label className="text-xs text-muted-foreground">
                归给
                <select
                  value={adjusting.role}
                  onChange={(event) =>
                    props.onChangeAdjust({
                      customerId: item.id,
                      suggestionId: suggestion.id,
                      role: event.target.value as CustomerRole,
                      // 换角色时清空已选账号：设计师的 id 在销售下拉里不存在，
                      // 留在 state 里会提交一个必然被服务端拒绝的值。
                      userId: '',
                    })
                  }
                  className="mt-1 block h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
                >
                  <option value="designer">设计师</option>
                  <option value="sales">销售</option>
                </select>
              </label>
              <label className="text-xs text-muted-foreground">
                负责人
                <select
                  value={adjusting.userId}
                  onChange={(event) =>
                    props.onChangeAdjust({
                      customerId: item.id,
                      suggestionId: suggestion.id,
                      role: adjusting.role,
                      userId: event.target.value,
                    })
                  }
                  className="mt-1 block h-8 min-w-40 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
                >
                  {/* 留空表示「按角色自动选最闲的人」，由服务端兜底。 */}
                  <option value="">自动选择（该角色名下最少）</option>
                  {props.users
                    .filter((user) => user.role === adjusting.role)
                    .map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName}
                      </option>
                    ))}
                </select>
              </label>
              <Button type="button" size="sm" disabled={props.busy} onClick={props.onAdjust}>
                确认调整
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={props.busy}
                onClick={props.onCancelAdjust}
              >
                取消
              </Button>
            </div>
          )}
        </>
      )}
    </li>
  )
}

function describeFailure(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return '请求失败，请稍后重试'
}
