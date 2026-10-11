import { isEventLogAction, type Event, type EventLog, type EventLogAction } from '@fanhe/shared'
import { Circle, CircleCheck, FilePlus, RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useState } from 'react'

import { ApiError } from '../../lib/api'
import {
  EVENT_PRIORITY_CLASSES,
  EVENT_PRIORITY_LABELS,
  EVENT_STATUS_LABELS,
  eventLogActionText,
  eventLogTransitionText,
  formatDuration,
  formatDueAt,
  formatMoment,
  isOverdue,
} from '../../lib/event-display'
import { loadEventLogs } from '../../lib/events'
import { cn } from '../../lib/utils'
import { MarkdownPreview } from '../notes/MarkdownPreview'
import { ErrorState, LoadingState } from '../StateView'
import { Badge } from '../ui/badge'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

/**
 * 一条事件的详情面板。
 *
 * **头部用列表那一份数据，只有时间线在等接口。** 标题、描述、标签、创建与截止时间在
 * 列表返回的那条事件里就有，打开面板时不该让用户先看一眼转圈。日志只贡献最下面那段
 * 变更历史，所以它单独三态、单独失败 —— 历史拉不到时，上面的内容照样是对的，把整块
 * 换成「加载失败」等于用一个次要部分的失败否掉已经拿到手的主要部分。这一点与标签候选
 * 「失败静默降级」是同一条判断：**能分开失败的就分开**。
 *
 * **时间线的数据来源是 `event_logs`，不是界面拼出来的。** 每一次 `todo ↔ done` 的流转
 * 都由服务端在同一事务里追加一行，界面只是把它读出来按时间升序画一遍。「有据可查」指的
 * 是这件事：面板上的每一行都能在库里找到对应的那一行记录，而不是界面根据当前状态反推的。
 *
 * **未完成的事件也能打开。** 规格里写的是「已完成详情」，但描述在列表上根本不显示
 * （那一行只有标题、标签、截止时间、优先级），若只有完成之后才看得到完整描述，一件
 * 写着上下文的待办在完成之前就完全无处可看。所以入口对所有条目开，只是「完成时间 /
 * 完成人 / 完成用时」这三项在未完成时不出现 —— 它们此刻没有值，编一个「已进行 3 天」
 * 出来是替数据说话。
 */

/**
 * 动作码对应的图标。
 *
 * 与 `EVENT_LOG_ACTION_LABELS` 一样写成完备的 `Record`：将来多出第四种动作时这里会在
 * 编译期报缺项，而不是静默用一个通用圆点顶上。图标只是装饰，**认不出的动作码用兜底
 * 圆点**（`Circle`），文字仍然是动作码原文 —— 那才是真正带着信息的那一半。
 */
const ACTION_ICONS: Record<EventLogAction, typeof Circle> = {
  created: FilePlus,
  completed: CircleCheck,
  reopened: RotateCcw,
}

/**
 * 时间线的状态。
 *
 * `key` 是「哪条事件 + 第几次尝试」：**用 key 而不是在 effect 里重置**，一是避免在
 * effect 里同步 setState（`react-hooks/set-state-in-effect` 会拦），二是「这份历史属于
 * 当前这条吗」这件事由数据自己说，不需要另加一个「正在换事件」的开关来配合。
 */
type LogState = { key: string; logs: readonly EventLog[] } | { key: string; error: string }

/** 失败时的一句话。与其它板块同构：不把异常原文摆到界面上。 */
function describeFailure(error: unknown): string {
  return error instanceof ApiError ? error.message : '加载失败，请稍后重试'
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground-weak">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  )
}

/**
 * 时间线上的一条。
 *
 * **认得出的动作码不再重复画一遍状态流转。** 「完成」「撤销完成」本身已经说清了流向，
 * 后面再跟一句「未完成 → 已完成」是同一件事说两遍。而动作码认不出时，状态流转往往是
 * 唯一能看懂的线索 —— 那时候它不是冗余，是全部。见 `eventLogTransitionText`。
 */
function LogItem({ log }: { log: EventLog }) {
  const Icon = isEventLogAction(log.action) ? ACTION_ICONS[log.action] : Circle
  const transition = isEventLogAction(log.action)
    ? null
    : eventLogTransitionText(log.fromStatus, log.toStatus)

  return (
    <li className="flex gap-2.5">
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground-weak" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{eventLogActionText(log.action)}</span>
          {transition !== null && (
            <span className="text-xs text-muted-foreground-weak">{transition}</span>
          )}
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground-weak">
          <span>{formatMoment(log.createdAt)}</span>
          {/* 操作人显示名快照。账号被物理清理后为 null，而这条历史仍然在 —— 那时
              少一个人名，比显示「未知」更贴近事实：这行记录里确实没有这个人了。 */}
          {log.actor !== null && <span>{log.actor}</span>}
        </div>

        {/* 备注。服务端支持写，界面目前没有可填的位置（见 `setEventStatusRequest` 的说明），
            但库里可能已经有 —— 有就显示出来。 */}
        {log.comment !== null && log.comment !== '' && (
          <p className="text-xs break-words text-muted-foreground">{log.comment}</p>
        )}
      </div>
    </li>
  )
}

export function EventDetailDialog({
  open,
  onOpenChange,
  event,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * 要展示的那一条。
   *
   * **关闭时父组件不会立刻把它置空**（见 `EventsPanel` 里那段说明）：Radix 在关闭动画
   * 期间仍然渲染内容，那一刻拿到 `null` 会把标题与正文一起抽走，看起来像是内容闪没了。
   * 因此这里可以假定它在开着的时候非空，只在真没得画时返回 `null`。
   */
  event: Event | null
}) {
  const [retryToken, setRetryToken] = useState(0)
  const [logState, setLogState] = useState<LogState | null>(null)

  const eventId = event?.id ?? null
  const logKey = eventId === null ? null : `${eventId}#${retryToken}`

  /** 只认属于当前这条、当前这一次尝试的那份状态；其余一律当「还没有，正在读」。 */
  const current = logState !== null && logState.key === logKey ? logState : null

  useEffect(() => {
    if (!open || eventId === null || logKey === null) return

    let cancelled = false

    void (async () => {
      try {
        const logs = await loadEventLogs(eventId)
        if (!cancelled) setLogState({ key: logKey, logs })
      } catch (error) {
        if (!cancelled) setLogState({ key: logKey, error: describeFailure(error) })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, eventId, logKey])

  if (event === null) return null

  const done = event.status === 'done'
  const duration =
    done && event.completedAt !== null ? formatDuration(event.createdAt, event.completedAt) : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          {/* `pr-8` 让长标题在关闭按钮之前换行，而不是被它压住。 */}
          <DialogTitle className="pr-8 text-left leading-snug break-words">
            {event.title}
          </DialogTitle>
          {/* Radix 用 Description 给内容一个 `aria-describedby`。这里放一句能概括这份
              面板的话，而不是把标题重复一遍。 */}
          <DialogDescription className="text-left">
            {done ? '已完成的事件详情与变更历史。' : '未完成的事件详情与变更历史。'}
          </DialogDescription>
        </DialogHeader>

        {/*
          内容区自己滚，而不是让整个对话框滚：关闭按钮是绝对定位在 `DialogContent` 上的，
          整块一起滚会让它跟着跑出视野。高度用 vh 而不是固定像素，小窗口下才留得住头部。
        */}
        <div className="flex max-h-[60vh] flex-col gap-5 overflow-y-auto pr-1">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 text-sm sm:grid-cols-2">
            <Meta label="状态">
              {EVENT_STATUS_LABELS[event.status]}
              {/* 逾期只在未完成时有意义（见 `isOverdue`）；已完成的那条不再标红，
                  但「当初是晚了还是早了」这个判断在这里仍有位置。 */}
              {!done && isOverdue(event) && <span className="ml-2 text-destructive">已逾期</span>}
            </Meta>

            <Meta label="优先级">
              <Badge variant="outline" className={cn(EVENT_PRIORITY_CLASSES[event.priority])}>
                {EVENT_PRIORITY_LABELS[event.priority]}
              </Badge>
            </Meta>

            <Meta label="创建时间">{formatMoment(event.createdAt)}</Meta>

            <Meta label="截止时间">
              {event.dueAt === null ? (
                <span className="text-muted-foreground-weak">未设置</span>
              ) : (
                formatDueAt(event.dueAt)
              )}
            </Meta>

            {done && event.completedAt !== null && (
              <Meta label="完成时间">{formatMoment(event.completedAt)}</Meta>
            )}

            {done && (
              <Meta label="完成人">
                {/* 账号被物理清理后 `completedBy` 会是 null，而这条历史仍然在 —— 那时
                    说「未知」比留一个空白更诚实：空白看起来像界面漏画了一格。 */}
                {event.completedBy ?? <span className="text-muted-foreground-weak">未知</span>}
              </Meta>
            )}

            {done && (
              <Meta label="完成用时">
                {/* `null` 表示两个时刻解析不出来、或顺序反了（只可能来自手工改库）。
                    这时显示「—」，而不是替数据凑一个说得通的说法。 */}
                {duration ?? <span className="text-muted-foreground-weak">—</span>}
              </Meta>
            )}
          </dl>

          {!done && (
            <p className="text-xs text-muted-foreground-weak">
              尚未完成。标记完成之后，这里会记下完成时间、完成人与用时。
            </p>
          )}

          {event.tags.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground-weak">标签</h3>
              {/* 完整列出，不像列表行上那样截到三个：那一行的作用是辨认是哪一条，
                  而这里是看全貌的地方 —— 被截掉的那几个正是点进来的理由之一。 */}
              <div className="flex flex-wrap gap-1">
                {event.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-md bg-secondary px-2 py-0.5 text-xs text-secondary-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground-weak">描述</h3>
            {event.description.trim() === '' ? (
              <p className="text-sm text-muted-foreground-weak">没有描述。</p>
            ) : (
              // 复用纪要那一套渲染，不自己再写一遍 —— 支持哪些语法、任务列表要不要可点，
              // 那两个判断在那边已经定过了（例如任务列表一律渲染成禁用态）。
              <MarkdownPreview content={event.description} />
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium text-muted-foreground-weak">变更历史</h3>

            {current === null ? (
              <LoadingState variant="plain" label="正在读取变更历史" />
            ) : 'error' in current ? (
              <ErrorState
                variant="plain"
                description={current.error}
                onRetry={() => setRetryToken((token) => token + 1)}
              />
            ) : current.logs.length === 0 ? (
              // 创建时必写一条日志，所以这里正常不会出现。留着是为了手工改库之后
              // 面板不会渲染出一个空的 `<ol>` 而让人以为界面坏了。
              <p className="text-sm text-muted-foreground-weak">暂无记录。</p>
            ) : (
              <ol className="flex flex-col gap-3">
                {current.logs.map((log) => (
                  <LogItem key={log.id} log={log} />
                ))}
              </ol>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  )
}
