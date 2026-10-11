import type { Event } from '@fanhe/shared'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

import { EVENT_STATUS_LABELS, groupEvents } from '../../lib/event-display'
import { cn } from '../../lib/utils'
import { EventRow } from './EventRow'

/**
 * 事件列表：未完成与已完成两组。
 *
 * **分组在这里做，排序不在这里做。** 「哪一组」是展示层的判断（`groupEvents` 是纯
 * 函数，有单测），而组内顺序由服务端定（按截止时间升序、没有截止时间的落在组尾）。
 * 界面再排一遍就有了第二份顺序定义，两份迟早分叉。
 *
 * **已完成的默认折叠。** 一份待办清单上，用户此刻要做的事都在未完成那一组，而它通常
 * 短得多；已完成的会一直长下去，展开着会把未完成的那几条挤到需要滚动才能看见的位置。
 * 折叠状态是本机的、局部的（组件状态），**不写进偏好**：它是「当前这一次浏览想怎么看」，
 * 与侧栏折叠那种「这台机器上一直怎么显示」不是一回事。
 *
 * **勾选切换由 `onToggle` 上抛。** 这一层只知道「哪一条被点了」，改状态、乐观更新与
 * 失败回滚都在 `EventsPanel` —— 那些要碰网络，而一个负责分组的组件不该持有请求。
 * `locked` / `switchingId` 两个量原样透给行：前者说「现在能不能点」（另一条正在切换
 * 时不能），后者说「正在切的是哪一条」。
 *
 * 组与组之间用标题分隔而不是合成一个列表加分隔线：两组的含义不同（一组要做、一组做完了），
 * 而分隔线只表达「这里断了」，说不出断开的理由。
 */
export function EventList({
  events,
  canWrite,
  switchingId,
  onToggle,
  onEdit,
  onDelete,
}: {
  events: readonly Event[]
  canWrite: boolean
  /** 正在切换的那一条；`null` 表示没有。非 `null` 时所有勾选框都点不动（切换是串行的）。 */
  switchingId: string | null
  onToggle: (event: Event) => void
  onEdit: (event: Event) => void
  onDelete: (event: Event) => void
}) {
  const [showDone, setShowDone] = useState(false)
  const groups = groupEvents(events)

  /** 抽出来传给每一行，免得在两处 `map` 里各写一遍同样的判断。 */
  const renderRow = (event: Event) => (
    <EventRow
      key={event.id}
      event={event}
      canWrite={canWrite}
      locked={switchingId !== null}
      switching={switchingId === event.id}
      onToggle={() => onToggle(event)}
      onEdit={() => onEdit(event)}
      onDelete={() => onDelete(event)}
    />
  )

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-foreground">{EVENT_STATUS_LABELS.todo}</h3>
          <span className="text-xs text-muted-foreground-weak">{groups.open.length}</span>
        </div>

        {groups.open.length === 0 ? (
          // 用一句说明而不是复用 `EmptyState`：空态是页面级的呈现，而这里只是两组里的
          // 一组为空，另一组可能还有内容。摆一张居中大卡片会把视线从下面那组拽走。
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground-weak">
            没有未完成的事件。
          </p>
        ) : (
          <ul className="flex flex-col gap-1">{groups.open.map(renderRow)}</ul>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          {/* 计数放在按钮**外面**：放进去之后按钮的文本就不再是「已完成」这一个词，
              而 e2e 按精确文本定位按钮（`clickMainButton`）。 */}
          <button
            type="button"
            aria-expanded={showDone}
            className="flex items-center gap-1 rounded-md text-sm font-medium text-foreground transition-colors hover:text-muted-foreground"
            onClick={() => setShowDone((current) => !current)}
          >
            <ChevronRight
              aria-hidden="true"
              className={cn('size-4 transition-transform', showDone && 'rotate-90')}
            />
            {EVENT_STATUS_LABELS.done}
          </button>
          <span className="text-xs text-muted-foreground-weak">{groups.done.length}</span>
        </div>

        {/* 折叠时**不渲染**列表，而不是渲染一个 `hidden` 的列表：后者会让页面里躺着
            一组看不见但可被读屏与自动化读到的行，而「折叠」的含义就是它此刻不在页面上。 */}
        {showDone &&
          (groups.done.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground-weak">
              还没有已完成的事件。
            </p>
          ) : (
            <ul className="flex flex-col gap-1">{groups.done.map(renderRow)}</ul>
          ))}
      </section>
    </div>
  )
}
