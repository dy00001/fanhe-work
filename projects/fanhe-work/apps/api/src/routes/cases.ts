import {
  CASE_LIBRARY_LIMITS,
  type CaseLibraryResponse,
  type CreateCaseFolderRequest,
  type CreateCaseUploadsRequest,
  type MoveCaseItemsRequest,
  type RenameCaseFolderRequest,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requireAuth } from '../auth/guard.js'
import {
  createFolder,
  createUploads,
  deleteFolder,
  deleteUpload,
  getCaseLibrary,
  moveItems,
  readUploadImage,
  renameFolder,
  type CaseLibraryFailureReason,
} from '../case-library/library.js'
import { resolveCaseLibraryOwnerId } from '../case-library/scope.js'

/**
 * 案例库的接口。
 *
 * **挂在 `requireAuth` 上，不挂权限点。** 案例库是**全账号共用一份**的素材库，归属固定
 * 为主账号（见 `case-library/scope.ts`）：任何登录用户看到的都是同一批图、同一批文件夹，
 * 也都能整理与删除。所以「能登录」就已经是完整的准入条件；再加一个权限点，唯一的效果是
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
  invalid_image: 400,
  upload_limit: 409,
}

const FAILURE_MESSAGE: Record<CaseLibraryFailureReason, string> = {
  not_found: '文件夹不存在',
  invalid_category: '品类不存在',
  invalid_name: `文件夹名不能为空，且不超过 ${CASE_LIBRARY_LIMITS.FOLDER_NAME_MAX} 字`,
  invalid_items: '图片清单不合法',
  duplicate_name: '这个品类下已有同名文件夹',
  folder_limit: `每个品类最多 ${CASE_LIBRARY_LIMITS.FOLDERS_PER_CATEGORY_MAX} 个文件夹`,
  folder_unavailable: '目标文件夹已不存在，请刷新后重试',
  invalid_image: '图片格式不支持，或单张超过了体积上限',
  upload_limit: `每个品类最多上传 ${CASE_LIBRARY_LIMITS.UPLOADS_PER_CATEGORY_MAX} 张图片`,
}

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

/**
 * 取当前用户 id。preHandler 已经保证认证通过，判空只是为了收窄类型 —— 真出现 null
 * 说明守卫没挂上，那时 401 比抛一个 500 更贴近事实。
 */
function currentUserId(request: FastifyRequest): string | null {
  return request.authContext?.userId ?? null
}

/**
 * 取案例库的归属账号。
 *
 * **不是「当前用户」**：案例库全账号共用一份，归属固定是主账号（见
 * `case-library/scope.ts` 的理由）。这里保留「先判 401」这一步 —— 未登录仍然要被挡在
 * 门外，而归属解析是登录之后才该发生的事。
 */
async function scopedUserId(request: FastifyRequest): Promise<string | null> {
  if (currentUserId(request) === null) return null
  return resolveCaseLibraryOwnerId()
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

/**
 * 上传请求体。
 *
 * `maxLength` 是按 base64 的长度给的（≈ 字节数 × 4/3），比共享包里的字节上限略宽一点点：
 * 这里挡的是「一个明显不是图片的巨型字符串」，真正的闸门是解码之后按字节数判断 ——
 * 两处都紧到同一个数字，只会让「刚好卡在边界」的请求得到两种不同的错误。
 */
const UPLOAD_BODY_SCHEMA = {
  type: 'object',
  required: ['categoryId', 'folderId', 'items'],
  additionalProperties: false,
  properties: {
    categoryId: { type: 'string', minLength: 1, maxLength: 64 },
    folderId: { type: ['string', 'null'], maxLength: 64 },
    items: {
      type: 'array',
      minItems: 1,
      maxItems: CASE_LIBRARY_LIMITS.UPLOAD_BATCH_MAX,
      items: {
        type: 'object',
        required: ['data', 'thumb', 'width', 'height'],
        additionalProperties: false,
        properties: {
          data: { type: 'string', minLength: 16, maxLength: 3_600_000 },
          thumb: { type: 'string', minLength: 16, maxLength: 720_000 },
          width: { type: 'integer', minimum: 1, maximum: 10000 },
          height: { type: 'integer', minimum: 1, maximum: 10000 },
        },
      },
    },
  },
} as const

const UPLOAD_IMAGE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['itemId', 'variant'],
  additionalProperties: false,
  properties: {
    itemId: { type: 'string', minLength: 1, maxLength: 64 },
    variant: { type: 'string', enum: ['thumb', 'full'] },
  },
} as const

const UPLOAD_DELETE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['itemId'],
  additionalProperties: false,
  properties: { itemId: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

export function registerCaseRoutes(app: FastifyInstance): void {
  /**
   * 读快照。界面打开品类图集时调用，也是多设备同步的拉取入口 —— 窗口重新获得焦点、
   * 以及图集开着时每 20 秒，客户端都会再打一次这条接口，靠 `revision` 判断要不要重绘。
   */
  app.get('/api/cases/library', { preHandler: requireAuth }, async (request, reply) => {
    const userId = await scopedUserId(request)
    if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

    const body: CaseLibraryResponse = { library: await getCaseLibrary(userId) }
    return reply.code(200).send(body)
  })

  app.post<{ Body: CreateCaseFolderRequest }>(
    '/api/cases/folders',
    { preHandler: requireAuth, schema: { body: CREATE_FOLDER_BODY_SCHEMA } },
    async (request, reply) => {
      const userId = await scopedUserId(request)
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
      const userId = await scopedUserId(request)
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
      const userId = await scopedUserId(request)
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
      const userId = await scopedUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await moveItems(userId, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CaseLibraryResponse = { library: result.data }
      return reply.code(200).send(body)
    },
  )

  /**
   * 上传图片。
   *
   * **`bodyLimit` 必须在这里单独给。** Fastify 的默认是 1MB，而一张压好的 webp 加上
   * base64 的 +33% 膨胀，稍大一点就会撞上它；撞上之后返回的是一个通用的 413，界面上
   * 看起来像「服务器坏了」，而事实只是「这张图太大了」。这里给 6MB，配的是共享包里
   * 单张 2.5MB / 缩略图 512KB 的上限。
   *
   * **客户端实际上是一张图一次请求。** 接口本身支持一批，但界面上按单张发：这样进度
   * 是「第 3 张 / 共 5 张」而不是一个不知进度的整体，且某一张失败时前面几张已经落地，
   * 不会因为最后一张有问题而整批回滚。
   */
  app.post<{ Body: CreateCaseUploadsRequest }>(
    '/api/cases/uploads',
    {
      preHandler: requireAuth,
      bodyLimit: 6 * 1024 * 1024,
      schema: { body: UPLOAD_BODY_SCHEMA },
    },
    async (request, reply) => {
      const userId = await scopedUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await createUploads(userId, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CaseLibraryResponse = { library: result.data }
      return reply.code(201).send(body)
    },
  )

  /**
   * 取一张上传图的字节。
   *
   * **这条接口没法直接给 `<img src>` 用** —— 它要 Bearer 令牌，而 `<img>` 不会带
   * 请求头。客户端因此用 `fetch` 拿到 blob 再转成 object URL（见
   * `use-case-upload-images.ts`）。这是有意的：图片是客户家的实景，不该靠「地址猜不到」
   * 来保护，而 `?token=` 那种把凭据放进 URL 的写法会漏进日志与 Referer。
   *
   * **`immutable` 是对的。** 同一个 itemId 的字节永不改变：改图等于删掉重传一张新的，
   * 而 id 是上传时生成的。因此浏览器可以永久缓存，不必回源。
   */
  app.get<{ Params: { itemId: string; variant: string } }>(
    '/api/cases/uploads/:itemId/:variant',
    { preHandler: requireAuth, schema: { params: UPLOAD_IMAGE_PARAMS_SCHEMA } },
    async (request, reply) => {
      const userId = await scopedUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const variant = request.params.variant === 'thumb' ? 'thumb' : 'full'
      const image = await readUploadImage(userId, request.params.itemId, variant)
      if (image === null) {
        return reply.code(404).send({ error: 'not_found', message: '图片不存在' })
      }

      return reply
        .header('cache-control', 'private, max-age=31536000, immutable')
        .header('etag', `"${variant}-${image.version}"`)
        .type(image.mime)
        .send(image.bytes)
    },
  )

  /** 删除一张上传图。静态清单里的图删不掉（库里没有对应行），进来就是 404。 */
  app.delete<{ Params: { itemId: string } }>(
    '/api/cases/uploads/:itemId',
    { preHandler: requireAuth, schema: { params: UPLOAD_DELETE_PARAMS_SCHEMA } },
    async (request, reply) => {
      const userId = await scopedUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await deleteUpload(userId, request.params.itemId)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: CaseLibraryResponse = { library: result.data }
      return reply.code(200).send(body)
    },
  )
}
