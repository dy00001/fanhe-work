import {
  LAUNCH_PROFILE_LIMITS,
  PERMISSIONS,
  type CreateLaunchProfileRequest,
  type DeleteLaunchProfileResponse,
  type LaunchProfileListResponse,
  type LaunchProfileResponse,
  type ReorderLaunchProfilesRequest,
  type RunLaunchProfileResponse,
  type UpdateLaunchProfileRequest,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requirePermission } from '../auth/guard.js'
import { runLaunchProfile, type LaunchRunFailureReason } from '../launch/agent.js'
import { isLoopbackAddress } from '../launch/loopback.js'
import {
  createProfile,
  getProfile,
  listProfiles,
  removeProfile,
  reorderProfiles,
  updateProfile,
  type LaunchFailureReason,
} from '../launch/profiles.js'

/**
 * 一键登录启动配置的接口。
 *
 * 读写分成两个权限点：`personal.launch.read` 与 `personal.launch.write`。只读访客
 * 这一档（`personal.*.read`）因此能看到列表但改不了任何一条，而这条限制由服务端
 * 强制 —— 前端的按钮禁用只承担体验职责。
 *
 * **不写审计。** 审计面向的是「谁动了权限、谁删了账号」这类需要追责的动作，而启动
 * 配置是用户自己的私有数据，增删改的影响范围不超出他本人。给它记审计只会让
 * `audit_logs` 里混进大量噪音，把真正需要看的事件淹掉。这条边界与「登录失败不写
 * actor」是同一类判断：审计的取舍标准是「出事时这条记录有没有用」。
 */

/**
 * 失败原因到 HTTP 状态码。
 *
 * 键的类型是配置读写与进程启动两个联合的并集：两边的失败原因各自定义在自己那一层
 * （profiles.ts 管配置，agent.ts 管进程），而**对外只有一套响应形状**，所以合并
 * 发生在路由层。用 `Record<并集, ...>` 而不是散在分支里的字面量：任一层新增一种
 * 失败原因时，这两张表会先在编译期报缺项，而不是让那条路径默默落进某个 `default`
 * 分支里返回一个不准确的状态码。
 *
 * 400 / 409 / 500 的分界：
 *   400  请求本身的内容不合法，改请求就能解决（格式、取值域）
 *   409  请求合法，但与当前状态冲突，改请求解决不了（重名、列表已变、文件不在了）
 *   500  服务端遇到了没预料到的情况（进程创建失败）
 *
 * `executable_missing` 落在 409 而不是 404：404 的含义是「这个 id 对应的配置没有」，
 * 而这里配置好好地在库里，只是它指向的文件不在了 —— 那是配置与外部世界之间的冲突。
 * 界面据此给出的是「重新指定路径」而不是「这条配置没了」，两者对应完全不同的操作。
 */
const FAILURE_STATUS: Record<LaunchFailureReason | LaunchRunFailureReason, number> = {
  not_found: 404,
  duplicate_name: 409,
  invalid_software: 400,
  invalid_name: 400,
  invalid_path: 400,
  invalid_args: 400,
  invalid_icon: 400,
  stale_order: 409,
  executable_missing: 409,
  spawn_failed: 500,
}

const FAILURE_MESSAGE: Record<LaunchFailureReason | LaunchRunFailureReason, string> = {
  not_found: '启动配置不存在',
  duplicate_name: '已有同名的启动配置',
  invalid_software: '不支持的软件',
  invalid_name: '显示名不能为空',
  invalid_path: '可执行文件路径必须是绝对路径',
  invalid_args: '启动参数格式不正确',
  invalid_icon: '图标标识过长',
  stale_order: '启动配置列表已变化，请刷新后重试',
  executable_missing: '可执行文件不存在或不是一个文件，请检查路径',
  spawn_failed: '无法启动该程序，请检查路径与文件权限',
}

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

/**
 * 取当前用户 id。
 *
 * preHandler 已经保证认证通过，判空只是为了收窄类型。真出现 null 说明守卫没挂上，
 * 那时返回 401 比抛一个 500 更贴近事实 —— 与 `/api/auth/me` 的处理一致。
 */
function currentUserId(request: FastifyRequest): string | null {
  return request.authContext?.userId ?? null
}

function sendFailure(
  reply: FastifyReply,
  reason: LaunchFailureReason | LaunchRunFailureReason,
): FastifyReply {
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
 * 字段属性。创建与修改共用，只是必填项不同。
 *
 * `software` 刻意**不写 enum**：软件清单在共享包里会演进，写在这里等于同一份规则
 * 出现两处，加一个软件时要记得改两个地方，而漏改的表现是「表单能选、提交被 schema
 * 挡下」—— 排查方向会先落到前端。清单的强制点在 service 层的 `isLaunchSoftware`。
 */
const PROFILE_PROPERTIES = {
  software: { type: 'string', minLength: 1, maxLength: 32 },
  name: { type: 'string', minLength: 1, maxLength: LAUNCH_PROFILE_LIMITS.NAME_MAX },
  executablePath: {
    type: 'string',
    minLength: 1,
    maxLength: LAUNCH_PROFILE_LIMITS.EXECUTABLE_PATH_MAX,
  },
  args: {
    type: 'array',
    maxItems: LAUNCH_PROFILE_LIMITS.ARGS_MAX_COUNT,
    items: { type: 'string', maxLength: LAUNCH_PROFILE_LIMITS.ARG_MAX },
  },
  icon: { type: ['string', 'null'], maxLength: LAUNCH_PROFILE_LIMITS.ICON_MAX },
} as const

const CREATE_BODY_SCHEMA = {
  type: 'object',
  required: ['software', 'name', 'executablePath'],
  additionalProperties: false,
  properties: PROFILE_PROPERTIES,
} as const

/**
 * 修改体。全部字段可选，但**至少要有一个**（`minProperties: 1`）。
 *
 * 空 body 等于什么都没改，却会走完一次查询与一次写入，`updatedAt` 随之变化 ——
 * 那会让「这一行什么时候被改过」这条信息失真。直接拒绝比默默接受更诚实。
 */
const UPDATE_BODY_SCHEMA = {
  type: 'object',
  minProperties: 1,
  additionalProperties: false,
  properties: PROFILE_PROPERTIES,
} as const

const REORDER_BODY_SCHEMA = {
  type: 'object',
  required: ['ids'],
  additionalProperties: false,
  properties: {
    // 上限 500 是防超大请求体，不是业务约束：个人工作台的启动配置不会有这个量级。
    ids: {
      type: 'array',
      maxItems: 500,
      items: { type: 'string', minLength: 1, maxLength: 64 },
    },
  },
} as const

export function registerLaunchRoutes(app: FastifyInstance): void {
  app.get(
    '/api/launch/profiles',
    { preHandler: requirePermission(PERMISSIONS.PERSONAL_LAUNCH_READ) },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const body: LaunchProfileListResponse = { profiles: await listProfiles(userId) }
      return reply.code(200).send(body)
    },
  )

  app.post<{ Body: CreateLaunchProfileRequest }>(
    '/api/launch/profiles',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_LAUNCH_WRITE),
      schema: { body: CREATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await createProfile(userId, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: LaunchProfileResponse = { profile: result.data }
      return reply.code(201).send(body)
    },
  )

  /**
   * 重排。路径段 `order` 与下面的 `:id` 不会冲突：Fastify 的路由树里静态段优先于
   * 参数段，所以 `/api/launch/profiles/order` 永远命中这一条。
   *
   * 用 PUT 而不是 PATCH：它替换的是「顺序」这个整体，且天然幂等 —— 重复提交同一个
   * 数组，结果一样。
   */
  app.put<{ Body: ReorderLaunchProfilesRequest }>(
    '/api/launch/profiles/order',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_LAUNCH_WRITE),
      schema: { body: REORDER_BODY_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await reorderProfiles(userId, request.body.ids)
      if (!result.ok) return sendFailure(reply, result.reason)

      // 返回重排后的完整列表：界面拖拽后本来就要显示新顺序，让服务端把「落库后的
      // 结果」直接给回来，比让前端按自己的推测重排一遍更可靠。
      const body: LaunchProfileListResponse = { profiles: result.data }
      return reply.code(200).send(body)
    },
  )

  app.patch<{ Params: { id: string }; Body: UpdateLaunchProfileRequest }>(
    '/api/launch/profiles/:id',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_LAUNCH_WRITE),
      schema: { params: ID_PARAMS_SCHEMA, body: UPDATE_BODY_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await updateProfile(userId, request.params.id, request.body)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: LaunchProfileResponse = { profile: result.data }
      return reply.code(200).send(body)
    },
  )

  app.delete<{ Params: { id: string } }>(
    '/api/launch/profiles/:id',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_LAUNCH_WRITE),
      schema: { params: ID_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await removeProfile(userId, request.params.id)
      if (!result.ok) return sendFailure(reply, result.reason)

      // 删除是软删除且幂等，重复删除返回 removed: false 而不是 404。返回这个布尔值
      // 是为了让「点了删除但什么都没发生」在排查时有据可查，与登出返回 revoked 同理。
      const body: DeleteLaunchProfileResponse = result.data
      return reply.code(200).send(body)
    },
  )

  /**
   * 启动一条配置。**这是整个项目唯一一处会创建进程的接口。**
   *
   * 请求体是空的：只认路径里的 id，路径与参数一律从库里那一行取。允许客户端提交
   * 路径与参数就等于对外提供一个本机任意命令执行入口 —— 见 agent.ts 顶部。
   *
   * 权限用 `write` 而不是 `read`。启动不修改任何数据，但它有副作用，而只读访客这
   * 一档的语义是「看得到、什么也做不了」。用 read 会让 viewer 能拉起别人的机器上
   * 的客户端，那显然不是这个角色该有的能力。
   *
   * 用 POST 而不是 GET：它有副作用，不能是幂等的语义（尽管去重窗口让它短时间内
   * 表现得像幂等）。浏览器与中间层对 GET 的预取与重试会让「打开一个链接」变成
   * 「启动一个程序」，那是必须避免的。
   */
  app.post<{ Params: { id: string } }>(
    '/api/launch/profiles/:id/run',
    {
      preHandler: requirePermission(PERMISSIONS.PERSONAL_LAUNCH_WRITE),
      schema: { params: ID_PARAMS_SCHEMA },
    },
    async (request, reply) => {
      const userId = currentUserId(request)
      if (userId === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      /**
       * 来源必须是本机回环，否则按「配置不存在」处理。
       *
       * 用 `request.socket.remoteAddress` 而不是 `request.ip`：后者在 Fastify 开启
       * `trustProxy` 时会取 `X-Forwarded-For` 的值，而那个头是客户端随手就能写的。
       * 本接口的动作是创建进程，用一个可伪造的值来判断来源，等于这道防线不存在。
       * socket 上的地址由内核给出，伪造不了。
       *
       * 返回 404 而不是 403：403 等于确认「这里有东西，只是不给你用」，而一个来自
       * 局域网或远程的探测者不该得到这个确认。它与「配置真的不存在」共用同一个响应。
       *
       * 阶段五容器化之后这条判定会真正开始起作用 —— 那时 API 不再绑在回环上，
       * 远程请求会走到这里并被挡下。**远程 API 不能启动任何人的电脑上的进程**，
       * 这条边界写在实施方案第三章。
       */
      if (!isLoopbackAddress(request.socket.remoteAddress)) {
        return sendFailure(reply, 'not_found')
      }

      const profile = await getProfile(userId, request.params.id)
      if (profile === null) return sendFailure(reply, 'not_found')

      const result = await runLaunchProfile(profile, request.log)
      if (!result.ok) return sendFailure(reply, result.reason)

      const body: RunLaunchProfileResponse = result.data
      return reply.code(200).send(body)
    },
  )
}
