import type {
  CaseLibrarySnapshot,
  CreateCaseFolderRequest,
  MoveCaseItemsRequest,
} from '@fanhe/shared'

import { ApiError } from './api'
import {
  caseLibraryRequest,
  createCaseFolderRequest,
  deleteCaseFolderRequest,
  moveCaseItemsRequest,
  renameCaseFolderRequest,
} from './api'
import { withAccessToken } from './session'

/**
 * 案例库的前端数据层。
 *
 * 与 `lib/notes.ts` 同一套三层分工，这里只说案例库特有的那部分：
 *
 *   `api.ts`      拼地址、发请求、把失败拉平成 `ApiError`。不认识令牌。
 *   `session.ts`  `withAccessToken`：令牌从哪来、过期了怎么续。
 *   本文件        把上面两件事拼起来，并把返回值的信封拆掉。
 *
 * **每条写接口都返回整个快照，这里原样交出去。** 不在这一层做「只有这一条变了」的
 * 增量合并：多设备并发时合并会算错，而算错的表现是界面与库不一致、刷新一次就好 ——
 * 属于最难复现的一类问题。快照十几 KB，不值得为省这点流量引入一类这样的 bug。
 */

export function loadCaseLibrary(): Promise<CaseLibrarySnapshot> {
  return withAccessToken(async (token) => (await caseLibraryRequest(token)).library)
}

export function createCaseFolder(input: CreateCaseFolderRequest): Promise<CaseLibrarySnapshot> {
  return withAccessToken(async (token) => (await createCaseFolderRequest(token, input)).library)
}

export function renameCaseFolder(id: string, name: string): Promise<CaseLibrarySnapshot> {
  return withAccessToken(
    async (token) => (await renameCaseFolderRequest(token, id, { name })).library,
  )
}

export function deleteCaseFolder(id: string): Promise<CaseLibrarySnapshot> {
  return withAccessToken(async (token) => (await deleteCaseFolderRequest(token, id)).library)
}

export function moveCaseItems(input: MoveCaseItemsRequest): Promise<CaseLibrarySnapshot> {
  return withAccessToken(async (token) => (await moveCaseItemsRequest(token, input)).library)
}

/**
 * 写操作失败时，界面该做什么。
 *
 * 分界依据是「用户下一步能做什么」，不是状态码本身：
 *
 *   `conflict` 409。两种冲突都在这里：文件夹重名（另一台设备刚建了同名的）、目标文件夹
 *              已被删除。正确的反应是**重取快照再让用户重选**，因为本机这份已经不是
 *              最新的了；报一句「保存失败，请重试」会让他重试同一个注定失败的请求。
 *   `gone`     404。文件夹真的不在了（或不属于本账号，服务端对这一者不区分）。同样要
 *              重取快照 —— 界面继续拿着一个已删除的文件夹当筛选条件只会显示空列表。
 *   `retry`    其余。网络、服务端暂时不可用、名字太长之类，改一改再提交即可。
 */
export type CaseSaveExit = 'gone' | 'conflict' | 'retry'

export function caseSaveExit(error: ApiError): CaseSaveExit {
  if (error.status === 409) return 'conflict'
  if (error.status === 404) return 'gone'
  return 'retry'
}

/**
 * 给用户看的一句话。
 *
 * 直接用服务端的 message：那几句是按「用户能看懂」写的（「这个品类下已有同名文件夹」），
 * 而本地再包一层只会变成「保存失败：保存失败」。非 ApiError（纯前端异常）才回落成通用文案，
 * 那种情况用户做什么都没用，能给的只有「重试」。
 */
export function describeCaseSaveError(error: unknown): string {
  if (error instanceof ApiError) return error.message
  return '保存失败，请稍后重试'
}
