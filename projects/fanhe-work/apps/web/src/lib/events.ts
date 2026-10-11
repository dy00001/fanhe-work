import type {
  CreateEventRequest,
  Event,
  EventStatus,
  EventTagCount,
  UpdateEventRequest,
} from '@fanhe/shared'

import { ApiError } from './api'
import {
  createEventRequest,
  deleteEventRequest,
  eventsRequest,
  eventTagsRequest,
  setEventStatusRequest,
  updateEventRequest,
} from './api'
import type { EventListQuery } from './api'
import { withAccessToken } from './session'

/**
 * 事件记录的前端数据层。
 *
 * 与 `lib/notes.ts` 完全同构的三层分工，这里只说事件特有的那部分：
 *
 *   `api.ts`      拼地址、发请求、把失败拉平成 `ApiError`。不认识令牌。
 *   `session.ts`  `withAccessToken`：令牌从哪来、过期了怎么续。
 *   本文件        把上面两件事拼起来，并把返回值的信封拆掉。
 *
 * **不在这里维护列表副本。** 列表的权威版本只有服务端一份，而事件的排序（未完成在前、
 * 组内按截止时间升序）也在服务端 —— 界面本地再排一遍就会多出一份会分叉的顺序定义。
 * 新增、修改、删除之后一律重拉列表，理由与纪要板块相同：本机回环请求的延迟是毫秒级，
 * 重拉的代价远小于维护第二份顺序。
 *
 * **变更历史不在本文件里**：它属 T3-12 的详情面板。**状态切换在**（T3-11），但它是
 * 这里唯一一个「调用方要接着做点什么」的写操作 —— 界面要先本地改一条、再拿服务端
 * 返回的那条对齐，见 `setEventStatus`。
 */

/** 列表。不带条件时两组都返回，由界面分组 —— 分组是展示层的事，见 `event-display.ts`。 */ export function loadEvents(
  query: EventListQuery = {},
): Promise<readonly Event[]> {
  return withAccessToken(async (token) => (await eventsRequest(token, query)).events)
}

/**
 * 标签清单，供输入框给候选。
 *
 * 失败不算整页失败：候选拿不到时标签照样能手动输入，只是少了「你以前用过这些」。
 * 这一点与纪要、启动配置两处同构。
 */
export function loadEventTags(): Promise<readonly EventTagCount[]> {
  return withAccessToken(async (token) => (await eventTagsRequest(token)).tags)
}

export function createEvent(input: CreateEventRequest): Promise<Event> {
  return withAccessToken(async (token) => (await createEventRequest(token, input)).event)
}

export function updateEvent(id: string, input: UpdateEventRequest): Promise<Event> {
  return withAccessToken(async (token) => (await updateEventRequest(token, id, input)).event)
}

/**
 * 状态切换：完成（`done`）与撤销（`todo`）共用这一条。
 *
 * 返回服务端更新后的**整条事件**，而不是一个布尔值。界面据此把本地那条换成权威版本，
 * 而不是自己拼一个 —— `completedAt` 与 `completedBy` 是服务端的时间与身份快照，界面
 * 猜不出来（本地时钟可能偏，显示名也要再问一次会话）。服务端在这条路径上**天然幂等**：
 * 提交一个与当前相同的状态，它直接返回现状、不写第二条日志，界面因此可以放心重发。
 *
 * **不做去抖、不做排队。** 同一时刻只允许一条切换在飞这件约束在界面层（`EventsPanel`
 * 用 `switching` 表达），因为「用户还能不能点」是界面的事，而这里只回答「怎么切」。
 */
export function setEventStatus(id: string, status: EventStatus): Promise<Event> {
  return withAccessToken(
    async (token) => (await setEventStatusRequest(token, id, { status })).event,
  )
}

/**
 * 删除。返回「本次是否真的改动了一行」。
 *
 * 软删除是幂等的，重复删除返回 `false` 而不是 404；界面不区分这两种（都是「这条已经
 * 不在了」），与另外两个板块一致。
 */
export function removeEvent(id: string): Promise<boolean> {
  return withAccessToken(async (token) => (await deleteEventRequest(token, id)).removed)
}

/**
 * 写操作失败时，界面该给哪个出口。
 *
 * 分界依据与 `noteFailureExit` / `launchRunRecovery` 相同 —— 「改什么才能成功」：
 *
 *   `gone`   404。**服务端对「归属不符」与「不存在」统一返回 404**（用 403 会让任何
 *            一种响应都变成「这个 UUID 存在」的探针）。因此界面这一侧也无从区分，
 *            文案统一成「找不到这条事件」，不要试图给出更细的说法 —— 给出「你没有
 *            权限」就等于把「它存在」泄露了出去。
 *   `retry`  其余情况。网络中断、服务端暂时不可用、校验失败后用户改一改再提交。
 *
 * 判断放在数据层而不是界面里，是因为它取决于服务端定义的错误码取值域；界面只消费
 * 结论，不必知道 `not_found` 这个字符串。
 */
export type EventFailureExit = 'gone' | 'retry'

export function eventFailureExit(error: ApiError): EventFailureExit {
  return error.status === 404 ? 'gone' : 'retry'
}
