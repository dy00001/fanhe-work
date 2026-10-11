import type { CreateNoteRequest, Note, NoteTagCount, UpdateNoteRequest } from '@fanhe/shared'

import { ApiError } from './api'
import {
  createNoteRequest,
  deleteNoteRequest,
  notesRequest,
  noteTagsRequest,
  setNoteArchivedRequest,
  setNotePinnedRequest,
  updateNoteRequest,
} from './api'
import type { NoteListQuery } from './api'
import { withAccessToken } from './session'

/**
 * 工作纪要的前端数据层。
 *
 * 与 `lib/launch.ts` 同一套三层分工，这里只说纪要特有的那部分：
 *
 *   `api.ts`      拼地址、发请求、把失败拉平成 `ApiError`。不认识令牌。
 *   `session.ts`  `withAccessToken`：令牌从哪来、过期了怎么续。
 *   本文件        把上面两件事拼起来，并把返回值的信封拆掉。
 *
 * **拆信封放在这里。** 服务端为了留出加同级字段的余地，把数据包在 `{ notes }` /
 * `{ note }` / `{ tags }` 里；界面只关心里面那一条。拆的动作集中在这一层，六个调用点
 * 就不必各写一遍 `result.notes`。
 *
 * **不在这里维护列表副本。** 列表的权威版本只有服务端一份。置顶、归档、修改三条接口
 * 都会把落库后的**整条纪要**回给界面，界面照着替换那一行即可 —— 前端再猜一份
 * 「我改完之后应该长什么样」，只会多出一个可能与服务端不一致的真相。这与启动配置那边
 * 「重排接口回传完整顺序」是同一条取舍。
 */

/** 列表。默认只看未归档，与 `GET /api/notes` 省略 `archived` 时的行为一致。 */
export function loadNotes(query: NoteListQuery = {}): Promise<readonly Note[]> {
  return withAccessToken(async (token) => (await notesRequest(token, query)).notes)
}

/**
 * 标签清单，供输入框给候选。
 *
 * 与列表分开调用，失败也不算整页失败：候选拿不到时标签照样能手动输入，只是少了
 * 「你以前用过这些」的提示。这一点与启动配置那边「路径状态失败不影响列表」同构。
 */
export function loadNoteTags(): Promise<readonly NoteTagCount[]> {
  return withAccessToken(async (token) => (await noteTagsRequest(token)).tags)
}

export function createNote(input: CreateNoteRequest): Promise<Note> {
  return withAccessToken(async (token) => (await createNoteRequest(token, input)).note)
}

export function updateNote(id: string, input: UpdateNoteRequest): Promise<Note> {
  return withAccessToken(async (token) => (await updateNoteRequest(token, id, input)).note)
}

/**
 * 删除。返回「本次是否真的改动了一行」。
 *
 * 软删除是幂等的，重复删除返回 `false` 而不是 404。界面不区分这两种（都是「这条已经
 * 不在了」），返回值留作排查用，与启动配置的删除一致。
 */
export function removeNote(id: string): Promise<boolean> {
  return withAccessToken(async (token) => (await deleteNoteRequest(token, id)).removed)
}

export function setNotePinned(id: string, pinned: boolean): Promise<Note> {
  return withAccessToken(async (token) => (await setNotePinnedRequest(token, id, { pinned })).note)
}

export function setNoteArchived(id: string, archived: boolean): Promise<Note> {
  return withAccessToken(
    async (token) => (await setNoteArchivedRequest(token, id, { archived })).note,
  )
}

/**
 * 写操作失败时，界面该给哪个出口。
 *
 * 分界依据与 `launchRunRecovery` 相同 —— 「改什么才能成功」：
 *
 *   `gone`   404。**服务端对「归属不符」与「不存在」统一返回 404**（用 403 会让
 *            任何一种响应都变成「这个 UUID 存在」的探针）。因此界面这一侧也无从
 *            区分，文案统一成「找不到这条纪要」，不要试图给出更细的说法 ——
 *            给出「你没有权限」就意味着把「它存在」泄露了出去。
 *   `retry`  其余情况。网络中断、服务端暂时不可用、校验失败后用户改一改再提交，
 *            都属于这一类。
 *
 * 判断放在数据层而不是界面里，是因为它取决于服务端定义的错误码取值域。界面只消费
 * 结论，不必知道 `not_found` 这个字符串。
 */
export type NoteFailureExit = 'gone' | 'retry'

export function noteFailureExit(error: ApiError): NoteFailureExit {
  return error.status === 404 ? 'gone' : 'retry'
}
