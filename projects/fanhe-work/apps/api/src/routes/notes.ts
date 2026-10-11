import {
  NOTE_LIMITS,
  PERMISSIONS,
  type CreateNoteRequest,
  type DeleteNoteResponse,
  type NoteListResponse,
  type NoteResponse,
  type NoteTagListResponse,
  type SetNoteArchivedRequest,
  type SetNotePinnedRequest,
  type UpdateNoteRequest,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requirePermission } from '../auth/guard.js'
import {
  createNote,
  getNote,
  listNotes,
  listNoteTags,
  removeNote,
  setNoteArchived,
  setNotePinned,
  updateNote,
  type NoteFailureReason,
} from '../note/notes.js'

/**
 * 工作纪要的接口。
 *
 * 读写分成两个权限点：`personal.note.read` 与 `personal.note.write`。只读访客这
 * 一档（`personal.*.read`）因此能看到纪要但改不了任何一条，而这条限制由服务端
 * 强制 —— 前端的按钮隐藏只承担体验职责，任何人改一个请求就能绕过它。
 *
 * **不写审计。** 与启动配置同一条判断，理由见 `note/notes.ts` 顶部。
 */

/**
 * 失败原因到 HTTP 状态码。
 *
 * 四种 `invalid_*` 全部落在 400：请求本身的内容不合法，改请求就能解决。**这张表
 * 里没有 409**，因为纪要允许重名，不存在「请求合法但与当前状态冲突」这一类失败 ——
 * 启动配置有 409 是因为那里有重名与列表过期两种冲突，纪要两样都没有。
 *
 * 用 `Record<NoteFailureReason, ...>` 而不是散在分支里的字面量：新增一种失败原因时
 * 这两张表会先在编译期报缺项，而不是让那条路径默默落进某个 `default` 分支里返回
 * 一个不准确的状态码。
 */
const FAILURE_STATUS: Record<NoteFailureReason, number> = {
  not_found: 404,
  invalid_title: 400,
  invalid_content: 400,
  invalid_tags: 400,
  invalid_range: 400,
}

const FAILURE_MESSAGE: Record<NoteFailureReason, string> = {
  not_found: '纪要不存在',
  invalid_title: `标题不能为空，且不超过 ${NOTE_LIMITS.TITLE_MAX} 字`,
  invalid_content: '正文长度超出上限',
  invalid_tags: `标签格式不正确，或数量超过 ${NOTE_LIMITS.TAGS_MAX_COUNT} 个`,
  invalid_range: '时间范围不是合法的日期',
}

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

/**
 * 取当前用户 id。
 *
 * preHandler 已经保证认证通过，判空只是为了收窄类型。真出现 null 说明守卫没挂上，
 * 那时返回 401 比抛一个 500 更贴近事实，与其余模块的处理一致。
 */
function currentUserId(request: FastifyRequest): string | null {
  return request.authContext?.userId ?? null
}

function sendFailure(reply: FastifyReply, reason: NoteFailureReason): FastifyReply {
  return reply
    .code(FAILURE_STATUS[reason])
    .send({ error: reason, message: FAILURE_MESSAGE[reason] })
}

/** 路径参数。id 是 UUID，长度上限给到 64 只是留余地，真正的作用是挡住超长字符串。 */
const ID_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', minLength: 1, maxLength: 64 } },
} as const

/**
 * 标签数组属性。创建与修改共用。
 *
 * 单项 `minLength: 1` 只是挡住空串这一类明显非法值，真正去重与判重的是 service 层
 * 的 `normalizeNoteTags`：schema 管的是「形状」，不归它管「哪些算是同一个标签」。
 */
const TAGS_PROPERTY = {
  type: 'array',
  maxItems: NOTE_LIMITS.TAGS_MAX_COUNT,
  items: { type: 'string', minLength: 1, maxLength: NOTE_LIMITS.TAG_MAX },
} as const

/**
 * 请求体属性。创建与修改共用，只是必填项不同。
 *
 * `content` 允许空串而 `title` 不允许：正文回头再补是记纪要时最常见的动作，而一条
 * 没有标题的纪要，在列表上看起来就像一行渲染错误。
 */
const NOTE_PROPERTIES = {
  title: { type: 'string', minLength: 1, maxLength: NOTE_LIMITS.TITLE_MAX },
  content: { type: 'string', maxLength: NOTE_LIMITS.CONTENT_MAX },
  tags: TAGS_PROPERTY,
} as const

const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['title', 'content'],
  additionalProperties: false,
  properties: NOTE_PROPERTIES,
} as const

/**
 * 修改体。全部字段可选，但**至少要有一个**（`minProperties: 1`）。
 *
 * 空 body 等于什么都没改，却会走完一次查询与一次写入，`updatedAt` 随之变化 ——
 * 那会让「这条纪要什么时候被改过」失真。直接拒绝比默默接受更诚实。
 */
const UPDATE_BODY_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: NOTE_PROPERTIES,
} as const

const PIN_BODY_SCHEMA = {
  type: 'object',
  required: ['pinned'],
  additionalProperties: false,
  properties: { pinned: { type: 'boolean' } },
} as const

const ARCHIVE_BODY_SCHEMA = {
  type: 'object',
  required: ['archived'],
  additionalProperties: false,
  properties: { archived: { type: 'boolean' } },
} as const

/**
 * 列表查询参数。
 *
 * `archived` 在查询串里只能是字符串，因此声明为 `'true'` / `'false'` 的枚举，由
 * 服务端转换成布尔。写成 `type: 'boolean'` 会让 `?archived=false` 被 AJV 拒绝 ——
 * 它在字符串语境下读到的永远是 `'false'`，而 `'false'` 不是布尔真值。
 *
 * `from` / `to` 的 schema 只限长度，合法性交给服务端的 `new Date()` 判断。用正则
 * 校验时间字符串的合法边界（闰年、月份天数、时区偏移的写法）比直接用 `Date` 解析
 * 更容易出错，而解析失败的判定只需要一次 `Number.isNaN`。
 */
const LIST_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tag: { type: 'string', maxLength: NOTE_LIMITS.TAG_MAX },
    archived: { type: 'string', enum: ['true', 'false'] },
    from: { type: 'string', maxLength: 64 },
    to: { type: 'string', maxLength: 64 },
  },
} as const

type ListQuery = { tag?: string; archived?: string; from?: string; to?: string }

export function registerNoteRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ListQuery }>(
    '/api/notes',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_READ),
      schema: { querystring: LIST_QUERY_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await listNotes(userId, {
        tag: request.query.tag,
        archived: request.query.archived === 'true',
        from: request.query.from,
        to: request.query.to,
      })
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: NoteListResponse = { notes: result.data }
      return reply.code(200).send(body)
    },
  )

  /**
   * 标签清单。挂在 `read` 上：标签是「我有哪些分类」这一事实，不含任何改动。
   *
   * 路径段 `tags` 与下面的 `:id` 不会冲突：Fastify 的路由树里静态段优先于参数段，
   * 与 `/api/launch/profiles/status` 是同一条规则。
   */
  app.get(
    '/api/notes/tags',
    { preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_READ) },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const body: NoteTagListResponse = { tags: await listNoteTags(userId) }
      return reply.code(200).send(body)
    },
  )

  app.get<{ Params: { id: string } }>(
    '/api/notes/:id',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_READ),
      schema: { params: ID_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const note = await getNote(userId, request.params.id)
      if (note === null) return sendFailure(reply, 'not_found')

      const body: NoteResponse = { note }
      return reply.code(200).send(body)
    },
  )

  app.post<{ Body: CreateNoteRequest }>(
    '/api/notes',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_WRITE),
      schema: { body: CREATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await createNote(userId, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: NoteResponse = { note: result.data }
      return reply.code(201).send(body)
    },
  )

  app.patch<{ Params: { id: string }; Body: UpdateNoteRequest }>(
    '/api/notes/:id',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: UPDATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await updateNote(userId, request.params.id, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: NoteResponse = { note: result.data }
      return reply.code(200).send(body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/notes/:id',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_WRITE),
      schema: { params: ID_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await removeNote(userId, request.params.id)
      if (!result.ok) return sendFailure(reply, result.reason)

      // 删除是软删除且幂等，重复删除返回 removed: false 而不是 404。返回这个布尔值
      // 是为了让「点了删除但什么都没发生」在排查时有据可查，与启动配置的删除一致。
      const body: DeleteNoteResponse = result.data
      return reply.code(200).send(body)
    },
  )

  /**
   * 置顶开关。
   *
   * 用 PUT 而不是 POST：它替换的是「这条纪要是否置顶」这个状态整体，天然幂等 ——
   * 重复提交 `{ pinned: true }` 的结果一样。POST 的语义是「新增一次动作」，而这里
   * 没有可累积的东西。
   *
   * 单独一条接口而不并进 PATCH：置顶与「编辑标题正文」是两件事。混在一条路径上，
   * 失败处理与界面反馈都会变复杂 —— 改标题失败与置顶失败对用户是两回事，前者要
   * 把内容留在编辑器里，后者只需要把星标弹回去。
   */
  app.put<{ Params: { id: string }; Body: SetNotePinnedRequest }>(
    '/api/notes/:id/pin',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: PIN_BODY_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await setNotePinned(userId, request.params.id, request.body.pinned)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: NoteResponse = { note: result.data }
      return reply.code(200).send(body)
    },
  )

  /**
   * 归档开关。返回更新后的整条纪要，让界面不必再拉一次列表。
   *
   * 归档后这条纪要会退出当前视图，但它的数据完好，切到「已归档」就能看到。这与
   * 删除是两条不同的路径：归档可以在界面上原地撤销，删除只能靠服务端还留着那一行。
   */
  app.put<{ Params: { id: string }; Body: SetNoteArchivedRequest }>(
    '/api/notes/:id/archive',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_NOTE_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: ARCHIVE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await setNoteArchived(userId, request.params.id, request.body.archived)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: NoteResponse = { note: result.data }
      return reply.code(200).send(body)
    },
  )
}
