import {
  EVENT_LIMITS,
  PERMISSIONS,
  normalizeSearchQuery,
  type Event,
  type EventTagCount,
} from '@fanhe/shared'
import { CalendarCheck, Search, X } from 'lucide-react'
import { useEffect, useState } from 'react'

import { useAuth } from '../../auth/useAuth'
import { ApiError } from '../../lib/api'
import {
  createEvent,
  eventFailureExit,
  loadEventTags,
  loadEvents,
  removeEvent,
  updateEvent,
} from '../../lib/events'
import { cn } from '../../lib/utils'
import { EmptyState, ErrorState, LoadingState } from '../StateView'
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
import { EventFormDialog, type EventFormValues } from './EventFormDialog'
import { EventList } from './EventList'

/**
 * 事件记录板块。
 *
 * 结构照 `LaunchPanel` / `NotesPanel`：四个状态（加载中、加载失败、空、列表）互斥且
 * 穷尽，不靠几个布尔量拼出来；操作结果用板块顶部一条提示呈现，不引入 toast。
 *
 * **列表是权威副本，界面不自己排序。** 新增、修改、删除三条动作之后一律重拉列表，
 * 而不是就地改一份本地数组 —— 排序规则（未完成在前、组内按截止时间升序）在服务端，
 * 本地改完还得自己重排一遍才与下一次拉取的结果一致，而这两份顺序迟早分叉。本机回环
 * 请求的延迟是毫秒级，重拉的代价远小于维护第二份顺序。
 *
 * **「已完成」的折叠状态在 `EventList` 里**，是本机、局部的组件状态，不进偏好存储 ——
 * 它表达的是「这一次浏览想怎么看」，与侧栏折叠那种「这台机器上一直怎么显示」不同。
 *
 * **勾选切换不在这里。** 行上的勾选框本轮是只读的，切换与撤销属 T3-11；详情面板属
 * T3-12。本板块这一轮要做的是把列表、分组与行内四要素摆对。
 *
 * **标签清单失败不算整页失败。** 它只是候选提示，拿不到时标签照样能手输 —— 与另外
 * 两个板块同构。
 */

/**
 * 拉取列表的结果。
 *
 * 用判别联合而不是抛出去让调用方接：失败在这里是**正常分支**（后端没起来、会话刚失效），
 * 编码进返回值，调用方就不必用 try 包住整段加载逻辑。
 *
 * 不碰组件状态、放在模块级 —— 与 `LaunchPanel` 的 `fetchLaunchProfiles`、`NotesPanel`
 * 的 `fetchNotes` 同一条理由：它要在首次加载与重试两条路径上共用，而把 setState 塞进来
 * 会触发 `react-hooks/set-state-in-effect`（该规则做的是保守的跨函数分析）。
 */
type FetchEventsResult = { ok: true; events: readonly Event[] } | { ok: false; message: string }

/** 检索输入的防抖窗口。取值理由见 `NotesPanel` 里同一处。 */
const SEARCH_DEBOUNCE_MS = 250

async function fetchEvents(query: string): Promise<FetchEventsResult> {
  try {
    // 检索词为空时干脆不带这一项。服务端对空串也按「不检索」处理，但少发一个参数能让
    // 「界面认为没在搜」与「服务端收到的是没在搜」这两件事永远一致。
    return { ok: true, events: await loadEvents(query === '' ? {} : { q: query }) }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof ApiError ? error.message : '加载失败，请稍后重试',
    }
  }
}

type Notice = { kind: 'ok' | 'error'; text: string }

export function EventsPanel() {
  const { can } = useAuth()
  const canWrite = can(PERMISSIONS.PERSONAL_EVENT_WRITE)

  /** `null` 表示还没拿到过数据，与「拿到了但是空的」区分开。 */
  const [events, setEvents] = useState<readonly Event[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  /** 新增/编辑对话框。`open` 与 `editing` 分开：`editing === null` 时是新增。 */
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Event | null>(null)

  /**
   * 检索。分两个量：`searchInput` 是输入框里的原文，`query` 是**防抖之后**真正拿去
   * 请求的那个词。理由与 `NotesPanel` 相同（一次列表请求就是一次数据库查询，而
   * 「衣柜门板」四个字会打出四次按键）。
   */
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')

  const [tagCandidates, setTagCandidates] = useState<readonly EventTagCount[]>([])
  /** 标签的重拉计数。新增或改名之后候选要跟着变，而它不影响列表。 */
  const [tagsToken, setTagsToken] = useState(0)

  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [deleting, setDeleting] = useState<Event | null>(null)

  /** 重载计数。重试与写操作之后都走「把它加一」，不把加载逻辑写第二遍。 */
  const [reloadToken, setReloadToken] = useState(0)

  /** 「正在加载」由「没有数据且没有错误」推出来，不另存一个布尔量。 */
  const loading = events === null && loadError === null

  /**
   * 界面是否处在「检索中」。
   *
   * 判据取防抖之后的 `query` 而不是输入框里的 `searchInput` —— 列表反映的是 `query`。
   * 若按输入框判断，用户刚打完第一个字、请求还没发出去的那 250ms 里，零结果的空态
   * 文案会先切成「没有匹配」，而屏幕上此刻还挂着全部结果。
   */
  const searching = query !== ''

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(normalizeSearchQuery(searchInput) ?? '')
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [searchInput])

  /**
   * 首次加载、重试、改检索词、以及每次写操作之后的重新拉取，共用这一段。
   *
   * 状态更新写在 effect 内、`await` 之后。**用 `cancelled` 丢弃过期响应**：连续改词
   * 时会有多个请求同时在飞，先发的后到就会把新结果覆盖成旧的（表现为「搜到一半，
   * 结果显示的是上一个关键词」）。
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      const result = await fetchEvents(query)
      if (cancelled) return
      if (result.ok) {
        setEvents(result.events)
        setLoadError(null)
      } else {
        setLoadError(result.message)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [reloadToken, query])

  /**
   * 标签候选。
   *
   * 与列表分开成一次请求，失败也不算加载失败：候选拿不到时标签照样能手动输入，只是
   * 少了「你以前用过这些」。因此失败就保持上一次的结果，不清空 —— 清空会让已经显示
   * 出来的候选在一次偶发失败后一起消失，而它们刚才还是对的。
   */
  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const list = await loadEventTags()
        if (!cancelled) setTagCandidates(list)
      } catch {
        // 见上。候选是附加信息，静默降级。
      }
    })()

    return () => {
      cancelled = true
    }
  }, [tagsToken])

  /**
   * 写操作失败时的统一说法。
   *
   * `gone` 与 `retry` 的区分来自数据层（见 `lib/events.ts` 的 `eventFailureExit`）：
   * 404 意味着这条已经不在这个账号名下了，此时把列表重拉一次比让用户反复点重试更有用。
   */
  function reportFailure(error: unknown, fallback: string): void {
    const message = error instanceof ApiError ? error.message : fallback
    const exit = error instanceof ApiError ? eventFailureExit(error) : 'retry'
    if (exit === 'gone') {
      setNotice({ kind: 'error', text: '这条事件已不在，列表已刷新。' })
      setReloadToken((token) => token + 1)
      return
    }
    setNotice({ kind: 'error', text: message })
  }

  function handleRetry(): void {
    // 先清错误 —— `loading` 是从「没有数据且没有错误」推出来的，清掉它界面立刻回到
    // 加载态，不需要另设一个「重试中」的开关。
    setLoadError(null)
    setReloadToken((token) => token + 1)
  }

  /**
   * 清空检索。
   *
   * 两个状态一起清，**不等防抖** —— 防抖是为「连续输入」省请求的，而点「清空」是一次
   * 明确的意图，再等 250ms 才恢复列表会像是点空了。随后那个被重置的定时器醒来时会把
   * `query` 再置一次空串，是同一个值，React 直接跳过，不会多发一次请求。
   */
  function handleClearSearch(): void {
    setSearchInput('')
    setQuery('')
  }

  function openCreate(): void {
    setEditing(null)
    setFormOpen(true)
  }

  function openEdit(event: Event): void {
    setEditing(event)
    setFormOpen(true)
  }

  /**
   * 保存（新增或修改）。
   *
   * **失败不在这里报，直接抛给对话框。** 与 `LaunchPanel` / `NotesPanel` 同一条约定：
   * 提交失败时用户该看的是「哪个字段有问题」，而那条信息只能显示在表单旁边。这里若再
   * 报一次，同一件事会出现两条文案，用户不知道该信哪一条。删除不是表单提交，没有可
   * 承载内联错误的位置，才走 `reportFailure`。
   */
  async function handleSubmit(values: EventFormValues): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      if (editing === null) {
        const created = await createEvent(values)
        setNotice({ kind: 'ok', text: `已创建「${created.title}」` })
      } else {
        const updated = await updateEvent(editing.id, values)
        setNotice({ kind: 'ok', text: `已保存「${updated.title}」` })
      }
      // 排序由服务端定，因此不在这里插入本地数组，直接重拉。
      setReloadToken((token) => token + 1)
      setTagsToken((token) => token + 1)
    } finally {
      setBusy(false)
    }
  }

  async function handleDelete(): Promise<void> {
    if (deleting === null) return
    const target = deleting

    setBusy(true)
    setNotice(null)
    try {
      await removeEvent(target.id)
      setDeleting(null)
      setReloadToken((token) => token + 1)
      setTagsToken((token) => token + 1)
      setNotice({ kind: 'ok', text: `已删除「${target.title}」` })
    } catch (error) {
      reportFailure(error, '删除失败，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  function renderBody(): React.ReactNode {
    if (loading) return <LoadingState variant="plain" label="正在加载事件记录" />

    if (loadError !== null) {
      return <ErrorState variant="plain" description={loadError} onRetry={handleRetry} />
    }

    // 上面两条已经把「加载中」与「加载失败」排除掉，到这里 `events` 必然有值。取一个
    // 别名而不是到处写 `events!`：类型收窄在这个函数里跨分支并不可靠，而一处 `!`
    // 会在将来某次重构后从「多余」变成「真的在掩盖空值」。
    const list = events ?? []

    if (list.length === 0) {
      // **「没有」有两种含义，先分检索这一支。** 列表为空既可能是库里真的没有，也可能
      // 是检索没命中。只读角色在「搜不到」时若看到「当前角色只能查看」，会跑去要一个
      // 他已经有的权限，而真正该改的只是关键词。
      if (!canWrite) {
        return (
          <EmptyState
            variant="plain"
            icon={CalendarCheck}
            title={searching ? '没有匹配的事件' : '还没有事件'}
            description={
              searching
                ? '换个关键词，或清空搜索框看全部。'
                : '当前角色只能查看。需要记录时，请联系管理员调整权限。'
            }
          />
        )
      }

      return (
        <EmptyState
          variant="plain"
          icon={CalendarCheck}
          title={searching ? '没有匹配的事件' : '还没有事件'}
          description={
            searching
              ? '换个关键词，或清空搜索框看全部。'
              : '把要做的事记下来，设个截止时间与优先级。'
          }
          // 检索没命中时不给「新增」入口：此刻列表是空的是因为关键词，而不是因为
          // 库里没有，而那个关键词很可能是一次误输入 —— 摆一个新增按钮会让人以为
          // 「搜不到就新建一条」。
          action={searching ? undefined : <Button onClick={openCreate}>新增事件</Button>}
        />
      )
    }

    return (
      <EventList
        events={list}
        canWrite={canWrite}
        onEdit={openEdit}
        onDelete={(event) => setDeleting(event)}
      />
    )
  }

  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-base font-medium text-foreground">
            事件记录
            {/* 检索时即便 0 条也要显示 —— 那正是此刻最需要知道的一个数，藏起来反而像是
                列表还没加载完。 */}
            {events !== null && (events.length > 0 || searching) && (
              <span className="ml-2 text-xs font-normal text-muted-foreground-weak">
                {searching ? `匹配 ${events.length} 条` : `${events.length} 条`}
              </span>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            未完成与已完成分组展示，已完成默认收起。勾选切换在下一步开放。
          </p>
        </div>

        {canWrite && events !== null && (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" onClick={openCreate}>
              新增事件
            </Button>
          </div>
        )}
      </div>

      {/* 检索。放在面板标题之下、内容之上，而不是塞进右边那排按钮里：那一排是「新增」，
          点一下立刻生效且状态由按钮自身显示，而检索是一个持续存在的输入框。

          这一行**不随列表状态出现或消失**（加载中、加载失败、搜不到，它都在）。否则会
          开出一个死角：一次请求失败之后，输入框连同里面那个关键词一起被卸载，用户没法
          把它清掉再重试。 */}
      <div className="mt-4 flex items-center gap-2">
        <div className="relative w-full sm:max-w-xs">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground-weak"
          />
          <Input
            id="event-search"
            aria-label="搜索事件"
            placeholder="搜索标题或描述…"
            // 与服务端用同一条上限。前端先拦住，用户就永远撞不到那个 400。
            maxLength={EVENT_LIMITS.SEARCH_MAX}
            // `pl-*` 生成的是 `padding-inline-start`，是 `padding-inline` 的长属性，
            // 按 CSS 规则必然胜出，与类名先后无关 —— 这里需要的就是它胜过 `Input` 自带的
            // `px-3`。
            className={cn('pl-9', searchInput !== '' && 'pr-9')}
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
          />
          {searchInput !== '' && (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="清空搜索"
              className="absolute top-1/2 right-1.5 -translate-y-1/2"
              onClick={handleClearSearch}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
      </div>

      {notice !== null && (
        <div
          role={notice.kind === 'ok' ? 'status' : 'alert'}
          className={cn(
            'mt-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm',
            notice.kind === 'ok'
              ? 'border-border bg-accent text-foreground'
              : 'border-destructive/30 bg-destructive/10 text-destructive',
          )}
        >
          <span className="min-w-0 break-words">{notice.text}</span>
          <button
            type="button"
            aria-label="关闭提示"
            className="-mr-1 shrink-0 rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
            onClick={() => setNotice(null)}
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="mt-4">{renderBody()}</div>

      {/* 新增/编辑共用一个对话框。`event` 为 null 即新增 —— 表单的初值直接由 props
          算出来，因此每次打开都是干净的一份。 */}
      <EventFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        event={editing}
        tagCandidates={tagCandidates}
        onSubmit={handleSubmit}
      />

      {/* 删除确认。用 `deleting !== null` 同时表达「对话框开着」与「删的是哪一条」。 */}
      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>删除事件</DialogTitle>
            <DialogDescription>
              确定要删除「{deleting?.title}」吗？删除后它不再出现在列表里。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void handleDelete()}
            >
              {busy ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
