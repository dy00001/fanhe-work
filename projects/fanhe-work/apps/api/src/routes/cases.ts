import {
  CASE_LIBRARY_LIMITS,
  type CaseLibraryResponse,
  type CreateCaseFolderRequest,
  type MoveCaseItemsRequest,
  type RenameCaseFolderRequest,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requireAuth } from '../auth/guard.js'
import {
  createFolder,
  deleteFolder,
  getCaseLibrary,
  moveItems,
  renameFolder,
  type CaseLibraryFailureReason,
} from '../case-library/library.js'

/**
 * 案例库的接口。
 *
 * **挂在 `requireAuth` 上，不挂权限点。** 每一条数据都按 `userId` 隔离，任何账号都只能
 * 读写自己的案例库，所以「能登录」已经是完整的准入条件；再加一个权限点，唯一的效果是
 * 让某个角色能看到首页案例区却整理不了自己的文件夹。判断依据写在 `case-library/library.ts`
 * 顶部。
 *
 * **所有写接口都回传整个快照。** 客户端不推算「改完之后应该是什么样」，直接用服务端给
 * 的这份替换本地状态 —— 多设备并发时这是唯一不会算错的写法。四张表加起来最多十几 KB，
 * 不值得为省这点带宽引入一套「部分更新」的合并逻辑。
 *
 * **两种 409 是有意义的。** `duplicate_name`（另一台设备刚建了同名文件夹）与
 * `folder_unavailable`（目标文件夹在别处被删了）都不是「请求写错了」，而是与当前状态
 * 冲突；界面收到 409 的正确反应是重取快照、让用户重选，而不是报一个看起来像 bug 的错。
 */

/**
 * 失败原因到状态码。
 *
 * 用 `Record<CaseLibraryFailureReason, ...>` 而不是散在分支里的字面量：新增一种失败
 * 原因时这两张表会先在编译期报缺项，而不是让那条路径默默落进 `default` 返回一个
 * 不准确的状态码。
 */
const FAILURE_STATUS: Record<CaseLibraryFailureReason, number> = {
  not_found: 404,
  invalid_category: 400,
  invalid_name: 400,
  invalid_items: 400,
  duplicate_name: 409,
  folder_limit: 409,
  folder_unavailable: 409,
}

const FAILURE_MESSAGE: Record<CaseLibraryFailureReason, string> = {
  not_found: '文件夹不存在',
  invalid_category: '品类不存在',
  invalid_name: `文件夹名不能为空，且不超过 ${CASE_LIBRARY_LIMITS.FOLDER_NAME_MAX} 字`,
  invalid_items: '图片清单不合法',
  duplicate_name: '这个品类下已有同名文件夹',
  folder_limit: `每个品类最多 ${CASE_LIBRARY_LIMITS.FOLDERS_PER_CATEGORY_MAX} 个文件夹`,
  folder_unavailable: '目标文件夹已不存在，请刷新后重试',
}

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

/**
 * 取当前用户 id。preHandler 已经保证认证通过，判空只是为了收窄类型 —— 真出现 null
 * 说明守卫没挂上，那时 401 比抛一个 500 更贴近事实。
 */
function currentUserId(request: FastifyRequest): string | null {
  return request.authContext?.userId ?? null
}

function sendFailure(reply: FastifyReply, reason: CaseLibraryFailureReason): FastifyReply {
  return reply.code(FAILURE_STATUS[reason]).send({
    error: reason,
    message: FAILURE_MESSAGE[reason],
  })
}

const ID_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

const CREATE_FOLDER_BODY_SCHEMA = {
  type: 'object',
  required: ['categoryId', 'name'],
  additionalProperties: false,
  properties: {
    categoryId: { type: 'string', minLength: 1, maxLength: 64 },
    name: { type: 'string', minLength: 1, maxLength: CASE_LIBRARY_LIMITS.FOLDER_NAME_MAX },
  },
} as const

const RENAME_FOLDER_BODY_SCHEMA = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: CASE_LIBRARY_LIMITS.FOLDER_NAME_MAX },
  },
} as const

/**
 * 批量移动的请求体。
 *
 * `folderId` 显式允许 `null`：那是「移出文件夹」。用 `type: ['string', 'null']` 而不是
 * `nullable: true` —— 后者是 OpenAPI 的写法，AJV 在 draft-07 下认的是前一种。
 *
 * `minItems: 1` 交给 schema 挡：空数组是「什么都没做」，却会走完一次事务并自增修订号，
 * 让另一台设备白拉一次。
 */
const MOVE_BODY_SCHEMA = {
  type: 'object',
  required: ['categoryId', 'itemIds', 'folderId'],
  additionalProperties: false,
  properties: {
    categoryId: { type: 'string', minLength: 1, maxLength: 64 },
    itemIds: {
      type: 'array',
      minItems: 1,
      maxItems: CASE_LIBRARY_LIMITS.BATCH_MAX,
      items: {
        type: 'string',
        minLength: 1,
        maxLength: CASE_LIBRARY_LIMITS.ITEM_ID_MAX,
      },
    },
    folderId: { type: ['string', 'null'], maxLength: 64 },
  },
} as const

export function registerCaseRoutes(app: FastifyInstance): void {
  /**
   * 读快照。界面打开品类图集时调用，也是多设备同步的拉取入口 —— 窗口重新获得焦点、
   * 以及图集开着时每 20 秒，客户端都会再打一次这条接口，靠 `revision` 判断要不要重绘。
   */
  app.get('/api/cases/library', { preHandler: requireAuth }, async (request, reply) => {
    const userId = currentUserId(request)
    if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

    const body: CaseLibraryResponse = { library: await getCaseLibrary(userId) }
    return reply.code(200).send(body)
  })

  app.post<{ Body: CreateCaseFolderRequest }>(
    '/api/cases/folders',
    { preHandler: requireAuth, schema: { body: CREATE_FOLDER_BODY_SCHEMA } },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await createFolder(userId, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CaseLibraryResponse = { library: result.data }
      return reply.code(201).send(body)
    },
  )

  app.patch<{ Params: { id: string }; Body: RenameCaseFolderRequest }>(
    '/api/cases/folders/:id',
    {
      preHandler: requireAuth,
      schema: { params: ID_PARAMS_SCHEMA, body: RENAME_FOLDER_BODY_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await renameFolder(userId, request.params.id, request.body.name)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CaseLibraryResponse = { library: result.data }
      return reply.code(200).send(body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/cases/folders/:id',
    { preHandler: requireAuth, schema: { params: ID_PARAMS_SCHEMA } },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await deleteFolder(userId, request.params.id)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CaseLibraryResponse = { library: result.data }
      return reply.code(200).send(body)
    },
  )

  /**
   * 批量移动。`PUT` 而不是 `POST`：它替换的是「这批图片分别归谁」这个整体，服务端
   * 因此天然幂等 —— 重复提交同一个请求不会写出第二条归属，界面就敢在失败后直接重试。
   */
  app.put<{ Body: MoveCaseItemsRequest }>(
    '/api/cases/placements',
    { preHandler: requireAuth, schema: { body: MOVE_BODY_SCHEMA } },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await moveItems(userId, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CaseLibraryResponse = { library: result.data }
      return reply.code(200).send(body)
    },
  )
}
