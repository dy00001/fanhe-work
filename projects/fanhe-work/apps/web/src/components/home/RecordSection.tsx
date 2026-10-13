import { PERMISSIONS, navPath, NAV_CODES, type Event, type Note } from '@fanhe/shared'
import { Activity, ArrowRight, NotebookText, Plus } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'

import { useAuth } from '../../auth/useAuth'
import { ApiError } from '../../lib/api'
import { loadEvents } from '../../lib/events'
import { loadNotes } from '../../lib/notes'
import { formatRelativeTime } from '../../lib/relative-time'

/** 每张卡最多列几条。原型是四条，这个数字决定两张卡的高度能否对齐。 */
const PREVIEW_COUNT = 4

/** 新建 / 查看全部这类入口的样式。原型 `.card-head .more`。悬停瞬时变色，不带过渡。 */
const MORE_CLASS =
  'ml-auto flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground'

/**
 * 工作纪要及事件记录（原型编号 11）。
 *
 * 同一套四列栅格：纪要卡跨三列、事件卡占一列，两边的列宽因此都落在原型 Bento 的
 * 栅格上。**两张卡各自按自己的权限判定是否渲染** —— 权限点是分开的（`personal.note.read`
 * 与 `personal.event.read`），一个只有事件权限的角色不该看到一张空的纪要卡。
 * 只剩一张卡时它铺满整行：跨三列在一张卡独占时会让右侧空出一列。
 *
 * 数据接的是真接口（`lib/notes.ts` / `lib/events.ts`），只取前几条做摘要 —— 完整的
 * 增删改查仍在 `/workbench/notes` 与 `/workbench/events` 两块面板上。**接口没有 limit
 * 参数**，所以这里是「拉全量再截断」。个人工作台的量级下这个取舍是合适的；量级上去
 * 之后应当给列表接口加一个 `limit`，而不是让首页继续拉全量。
 *
 * 事件的时间线取服务端返回的前四条，不重排：服务端的顺序（未完成在前、组内按截止
 * 时间升序）是「先看该做什么」，而首页这一栏要回答的正是这个问题。自己再按创建时间
 * 倒序排一遍，会得到一份与面板不一致的顺序 —— 同一批数据两个顺序，用户会以为看错了。
 */
export function RecordSection() {
  const { can } = useAuth()
  const canReadNotes = can(PERMISSIONS.PERSONAL_NOTE_READ)
  const canReadEvents = can(PERMISSIONS.PERSONAL_EVENT_READ)

  const [notes, setNotes] = useState<readonly Note[] | null>(null)
  const [noteError, setNoteError] = useState<string | null>(null)
  const [events, setEvents] = useState<readonly Event[] | null>(null)
  const [eventError, setEventError] = useState<string | null>(null)

  useEffect(() => {
    if (!canReadNotes) return
    let cancelled = false
    void (async () => {
      try {
        const list = await loadNotes()
        if (!cancelled) setNotes(list)
      } catch (error) {
        if (!cancelled) setNoteError(error instanceof ApiError ? error.message : '加载工作纪要失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [canReadNotes])

  useEffect(() => {
    if (!canReadEvents) return
    let cancelled = false
    void (async () => {
      try {
        const list = await loadEvents()
        if (!cancelled) setEvents(list)
      } catch (error) {
        if (!cancelled)
          setEventError(error instanceof ApiError ? error.message : '加载事件记录失败')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [canReadEvents])

  if (!canReadNotes && !canReadEvents) return null

  const bothCards = canReadNotes && canReadEvents

  return (
    <section>
      <div className="mb-5 flex items-baseline gap-2.5">
        <h2 className="text-xl leading-7 font-medium">工作纪要及事件记录</h2>
        <span className="text-sm text-muted-foreground">纪要留档，事件留痕</span>
      </div>

      <div className="grid grid-cols-4 gap-4">
        {canReadNotes && (
          <div
            className={`overflow-hidden rounded-2xl border border-border bg-card ${bothCards ? 'col-span-3' : 'col-span-4'}`}
          >
            <div className="flex items-center gap-2 border-b border-border-soft px-4 pt-4 pb-3">
              <NotebookText className="size-[18px] text-muted-foreground" />
              <h3 className="text-base leading-6 font-medium">工作纪要</h3>
              <Link to={`${navPath(NAV_CODES.WORKBENCH)}/notes`} className={MORE_CLASS}>
                新建
                <Plus className="size-3.5" />
              </Link>
            </div>

            <PreviewBody
              items={notes}
              error={noteError}
              empty="还没有工作纪要。"
              render={(note) => (
                <Link
                  key={note.id}
                  to={`${navPath(NAV_CODES.WORKBENCH)}/notes`}
                  className="flex items-center gap-3 border-t border-border-soft px-4 py-3 first:border-t-0 hover:bg-accent"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base leading-6 font-medium">
                      {note.title}
                    </span>
                    <span className="block truncate text-sm leading-5 text-muted-foreground">
                      {note.tags.length > 0 ? `标签：${note.tags.join(' / ')}` : '未加标签'}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground-weak tabular-nums">
                    {formatRelativeTime(note.updatedAt)}
                  </span>
                </Link>
              )}
            />
          </div>
        )}

        {canReadEvents && (
          <div
            className={`overflow-hidden rounded-2xl border border-border bg-card ${bothCards ? 'col-span-1' : 'col-span-4'}`}
          >
            <div className="flex items-center gap-2 border-b border-border-soft px-4 pt-4 pb-3">
              <Activity className="size-[18px] text-muted-foreground" />
              <h3 className="text-base leading-6 font-medium">事件记录</h3>
              {/* 原型的事件卡头上没有入口，这里补一个：事件列表为空时卡里没有任何
                  可点的行，没有这个链接就等于整块事件面板从界面上消失了。纪要卡那
                  一侧不存在这个问题 —— 它的「新建」在原型里本来就有。 */}
              <Link to={`${navPath(NAV_CODES.WORKBENCH)}/events`} className={MORE_CLASS}>
                查看全部
                <ArrowRight className="size-3.5" />
              </Link>
            </div>

            <PreviewBody
              items={events}
              error={eventError}
              empty="还没有事件记录。"
              bodyClassName="px-4 pt-2 pb-4"
              render={(event, index) => (
                <Link
                  key={event.id}
                  to={`${navPath(NAV_CODES.WORKBENCH)}/events`}
                  className="relative block py-2.5 pl-[18px] hover:text-foreground"
                >
                  {/* 时间线的点与连线。用绝对定位的伪元素在原型里实现；这里用两个
                      真实元素，因为连线要连到「下一项」，而 CSS 无法在最后一项上
                      自动去掉它 —— 交给组件按 index 判断更直接。 */}
                  <span
                    aria-hidden
                    className={[
                      'absolute top-4 left-0.5 size-[7px] rounded-full border-[1.5px]',
                      index === 0 && isRecent(event)
                        ? 'border-m-amber bg-m-amber'
                        : 'border-border bg-card',
                    ].join(' ')}
                  />
                  {index < PREVIEW_COUNT - 1 && (
                    <span
                      aria-hidden
                      className="absolute top-[25px] bottom-[-3px] left-[5px] w-px bg-border"
                    />
                  )}
                  <span className="block text-sm leading-5">{event.title}</span>
                  <span className="block text-xs text-muted-foreground-weak">
                    {formatRelativeTime(event.createdAt)}
                  </span>
                </Link>
              )}
            />
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * 24 小时内创建的事件在时间线上标成「新」。
 *
 * 判据用「相对当下」而不是「列表第一条」：只有一条新事件时把它标亮是有意义的提示，
 * 而最后一条事件是三个月前创建的时候，把第一条标成「新」就是在说假话。
 */
function isRecent(event: Event, now: number = Date.now()): boolean {
  const created = Date.parse(event.createdAt)
  if (Number.isNaN(created)) return false
  return now - created <= 24 * 60 * 60 * 1000
}

/**
 * 三态渲染：加载中 / 失败 / 空 / 有数据。
 *
 * 抽出来是因为两张卡要走同一套分支，而「加载中」与「空」在这里**必须分开**：
 * 合并成一个「没有数据」会让加载的那一瞬间显示「还没有工作纪要」，而用户刚写过纪要
 * —— 那是一条会让人以为数据丢了的错误结论。
 */
function PreviewBody<T>({
  items,
  error,
  empty,
  render,
  bodyClassName,
}: {
  items: readonly T[] | null
  error: string | null
  empty: string
  render: (item: T, index: number) => ReactNode
  bodyClassName?: string
}) {
  if (error !== null) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{error}</p>
  }
  if (items === null) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">正在加载…</p>
  }
  if (items.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted-foreground">{empty}</p>
  }
  const preview = items.slice(0, PREVIEW_COUNT)
  return (
    <div className={bodyClassName ?? ''}>{preview.map((item, index) => render(item, index))}</div>
  )
}
