import {
  ALL_PERMISSIONS,
  DISPLAY_NAME_MAX_LENGTH,
  PERMISSIONS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  PERMISSION_CATALOG,
  type CreateManagedUserRequest,
  type CreateManagedUserResponse,
  type ManagedUser,
  type ManagedUserDetailResponse,
  type ManagedUserListResponse,
  type PermissionCatalogResponse,
  type ResetManagedUserPasswordRequest,
  type RoleListResponse,
  type SetManagedUserPermissionsRequest,
  type UpdateManagedUserRequest,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requireAuth, requirePermission } from '../auth/guard.js'
import { prisma } from '../db/prisma.js'
import {
  createManagedUser,
  deleteManagedUser,
  getManagedUser,
  listManagedUsers,
  resetManagedUserPassword,
  setManagedUserPermissions,
  updateManagedUser,
  type Actor,
  type UserAdminFailureReason,
} from '../auth/user-admin.js'

/**
 * 账号与权限管理的接口。
 *
 * 全部要求认证，其中写操作还要求 `system.user.manage`（删除另加
 * `system.user.delete`）。**层级判定在服务层做**，路由只负责把请求体校验好、
 * 把失败原因映射成状态码。
 *
 * 为什么把删除拆成独立的权限点：软删除会让账号立刻无法登录，比改个姓名严重得多。
 * 混在 manage 里的话，能改名的账号就能删人。分开之后，将来界面上要单独要求二次
 * 确认时，判据已经就位。
 */

/**
 * 失败原因到状态码与文案。
 *
 * 用两张 `Record` 而不是散在分支里的字面量：新增一种失败原因时这两张表会先在
 * 编译期报缺项，而不是让那条路径落进某个不准确的兜底分支。
 *
 * **越权一律返回 404，不返回 403。** 403 等于告诉调用者「这个账号存在，只是你管不了」，
 * 而账号列表与详情不该成为枚举接口 —— 能看到 id 就能试探它的存在性。404 对不可见的
 * 目标更合适：调用方无从区分「不存在」与「看不见」。
 *
 * 只有 `forbidden` 这个原因不同：它表示「你能看到这个账号，但这件事你不能做」
 * （例如对同级账号执行删除）。这类操作的失败必须出声 —— 静默成 404 会让管理员
 * 以为自己操作的账号已被删除，而它还在。
 */
const FAILURE_STATUS: Record<UserAdminFailureReason, number> = {
  user_not_found: 404,
  username_taken: 409,
  invalid_username: 400,
  invalid_password: 400,
  invalid_role: 400,
  invalid_status: 400,
  invalid_permissions: 400,
  role_not_assignable: 400,
  cannot_manage_self: 400,
  cannot_manage_peer_or_above: 404,
  cannot_modify_owner: 403,
  last_owner_protected: 403,
  forbidden: 403,
}

const FAILURE_MESSAGE: Record<UserAdminFailureReason, string> = {
  user_not_found: '账号不存在',
  username_taken: '登录账号已被占用',
  invalid_username: '登录账号格式不合法',
  invalid_password: `密码长度需在 ${PASSWORD_MIN_LENGTH} 到 ${PASSWORD_MAX_LENGTH} 之间`,
  invalid_role: '角色不存在',
  invalid_status: '账号状态不合法，或不允许手工解除登录锁定',
  invalid_permissions: '权限清单包含未知权限点',
  role_not_assignable: '不能分配该角色：不允许分配 owner，也不能分配同级或更高级角色',
  cannot_manage_self: '不能对自己执行该操作',
  cannot_manage_peer_or_above: '只能管理层级低于自己的账号',
  cannot_modify_owner: '超级管理员账号不可修改或删除',
  last_owner_protected: '不能停用或删除最后一个超级管理员',
  forbidden: '没有执行该操作的权限',
}

/** 账号 id 的参数 schema。用 format uuid 让 Fastify 在进业务层之前就挡掉明显非法的值。 */
const USER_PARAMS = {
  type: 'object',
  required: ['userId'],
  properties: { userId: { type: 'string', format: 'uuid' } },
} as const

/** 权限码数组的 schema。 */
const PERMISSION_ARRAY = {
  type: 'array',
  items: { type: 'string' },
  maxItems: 64,
} as const

/**
 * 取当前请求的操作者。
 *
 * requireAuth 已经保证 authContext 非空，但 TypeScript 收不了窄，这里再判一次。
 * 返回 null 时让路由回 401 —— 真出现这个组合说明守卫没挂上，返回 401 比抛 500
 * 更贴近事实。
 *
 * 走 request 上的 authContext 而不是 requireAuth 的返回值：Fastify 的 preHandler
 * 不能改变 `reply` 的类型，各路由都要自己判空，而这里的判空对「忘记挂守卫」与
 * 「令牌失效」是同一种处理。
 */
function requireActor(reply: FastifyReply, request: FastifyRequest): Actor | null {
  const auth = request.authContext
  if (auth === null) {
    reply.code(401).send({ error: 'unauthorized', message: '请先登录' })
    return null
  }
  return {
    userId: auth.userId,
    displayName: auth.displayName,
    roleCode: auth.roleCode,
    roleRank: auth.roleRank,
  }
}

/** 服务层一行结果映射成 HTTP 响应。 */
function sendFailure(reply: FastifyReply, reason: UserAdminFailureReason): FastifyReply {
  return reply
    .code(FAILURE_STATUS[reason])
    .send({ error: reason, message: FAILURE_MESSAGE[reason] })
}

/** 服务层的行结构转成传输层类型，并把 Date 转成 ISO 串。 */
function toManagedUser(row: {
  id: string
  username: string
  displayName: string
  department: string | null
  status: 'active' | 'locked' | 'disabled'
  roleId: string
  roleCode: string
  roleName: string
  roleRank: number
  permissions: readonly (typeof ALL_PERMISSIONS)[number][]
  isOwner: boolean
  canBeManaged: boolean
  lastLoginAt: Date | null
  createdAt: Date
}): ManagedUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    department: row.department,
    status: row.status,
    role: { id: row.roleId, code: row.roleCode, name: row.roleName, rank: row.roleRank },
    permissions: row.permissions,
    isOwner: row.isOwner,
    canBeManaged: row.canBeManaged,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}

/**
 * 取当前请求的操作者。
 *
 * requireAuth 已经保证 authContext 非空，但 TypeScript 收不了窄，这里再判一次。
 * 返回 null 时让路由回 401 —— 真出现这个组合说明守卫没挂上，返回 401 比抛 500
 * 更贴近事实。
 */
export function registerSystemUserRoutes(app: FastifyInstance): void {
  // -------------------------------------------------------------------------
  // 权限点与角色清单。供界面渲染勾选树与角色下拉，不需要 manage 权限 ——
  // admin 也要能看到自己有哪些权限点。
  // -------------------------------------------------------------------------

  app.get(
    '/api/system/permissions',
    { preHandler: requireAuth },
    async (): Promise<PermissionCatalogResponse> => {
      return {
        permissions: PERMISSION_CATALOG.map((meta) => ({
          code: meta.code,
          module: meta.module,
          object: meta.object,
          action: meta.action,
          description: meta.description,
        })),
      }
    },
  )

  app.get('/api/system/roles', { preHandler: requireAuth }, async (): Promise<RoleListResponse> => {
    const roles = await prisma.role.findMany({
      where: { deletedAt: null },
      select: { id: true, code: true, name: true, description: true, rank: true, isSystem: true },
      orderBy: { rank: 'desc' },
    })
    return { roles }
  })

  // -------------------------------------------------------------------------
  // 账号列表与详情
  // -------------------------------------------------------------------------

  app.get(
    '/api/system/users',
    { preHandler: requirePermission(PERMISSIONS.SYSTEM_USER_READ) },
    async (request, reply): Promise<ManagedUserListResponse | FastifyReply> => {
      const actor = requireActor(reply, request)
      if (actor === null) return reply

      const result = await listManagedUsers(actor, ALL_PERMISSIONS)
      if (!result.ok) return sendFailure(reply, result.reason)

      return { users: result.data.map(toManagedUser) }
    },
  )

  app.get<{ Params: { userId: string } }>(
    '/api/system/users/:userId',
    {
      preHandler: requirePermission(PERMISSIONS.SYSTEM_USER_READ),
      schema: { params: USER_PARAMS },
    },
    async (request, reply): Promise<ManagedUserDetailResponse | FastifyReply> => {
      const actor = requireActor(reply, request)
      if (actor === null) return reply

      const result = await getManagedUser(actor, request.params.userId, ALL_PERMISSIONS)
      if (!result.ok) return sendFailure(reply, result.reason)

      return {
        user: toManagedUser(result.data.user),
        rolePermissions: result.data.rolePermissions,
        permissions: result.data.permissions,
      }
    },
  )

  // -------------------------------------------------------------------------
  // 创建
  // -------------------------------------------------------------------------

  app.post<{ Body: CreateManagedUserRequest }>(
    '/api/system/users',
    {
      preHandler: requirePermission(PERMISSIONS.SYSTEM_USER_MANAGE),
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password', 'displayName', 'roleCode'],
          // 多余字段直接拒绝。app.ts 已把 removeAdditional 设为 false，这条规则
          // 才真正起作用 —— 否则调用方会以为某个字段生效了，而它从未被读取。
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            password: {
              type: 'string',
              minLength: PASSWORD_MIN_LENGTH,
              maxLength: PASSWORD_MAX_LENGTH,
            },
            displayName: { type: 'string', minLength: 1, maxLength: DISPLAY_NAME_MAX_LENGTH },
            department: { type: 'string', maxLength: 64 },
            roleCode: { type: 'string', minLength: 1, maxLength: 32 },
            permissions: {
              type: 'object',
              additionalProperties: false,
              properties: {
                granted: PERMISSION_ARRAY,
                denied: PERMISSION_ARRAY,
              },
            },
          },
        },
      },
    },
    async (request, reply): Promise<CreateManagedUserResponse | FastifyReply> => {
      const actor = requireActor(reply, request)
      if (actor === null) return reply

      const body = request.body
      const result = await createManagedUser(
        actor,
        {
          username: body.username,
          password: body.password,
          displayName: body.displayName,
          department: body.department,
          roleCode: body.roleCode,
          permissions: body.permissions,
        },
        { ip: request.ip, userAgent: request.headers['user-agent'] },
      )
      if (!result.ok) return sendFailure(reply, result.reason)

      // 创建成功后把完整账号取回来返回，界面无需再发一次请求就能渲染列表。
      // 详情取不到时降级为「先返回 id，界面刷新列表」而不是报错 —— 账号已经建成，
      // 此时抛错会让调用方以为失败而重复提交，那才会真的建成两个账号。
      const detail = await getManagedUser(actor, result.data.id, ALL_PERMISSIONS)
      if (!detail.ok) {
        return reply.code(201).send({
          user: {
            ...result.data,
            department: body.department ?? null,
            status: 'active',
            role: { id: '', code: body.roleCode, name: '', rank: 0 },
            permissions: [],
            isOwner: false,
            canBeManaged: true,
            lastLoginAt: null,
            createdAt: new Date().toISOString(),
          },
          rolePermissions: [],
          effectivePermissions: [],
        })
      }

      return reply.code(201).send({
        user: toManagedUser(detail.data.user),
        rolePermissions: detail.data.rolePermissions,
        effectivePermissions: detail.data.user.permissions,
      })
    },
  )

  // -------------------------------------------------------------------------
  // 编辑、删除、重置密码
  // -------------------------------------------------------------------------

  app.patch<{ Params: { userId: string }; Body: UpdateManagedUserRequest }>(
    '/api/system/users/:userId',
    {
      preHandler: requirePermission(PERMISSIONS.SYSTEM_USER_MANAGE),
      schema: {
        params: USER_PARAMS,
        body: {
          type: 'object',
          // 全部可选：只更新传了的那些字段。仍要求至少传一个，否则这个请求什么
          // 都不做却返回 200，调用方会以为改成功了。
          minProperties: 1,
          additionalProperties: false,
          properties: {
            displayName: { type: 'string', minLength: 1, maxLength: DISPLAY_NAME_MAX_LENGTH },
            department: { type: ['string', 'null'], maxLength: 64 },
            roleCode: { type: 'string', minLength: 1, maxLength: 32 },
            status: { type: 'string', enum: ['active', 'locked', 'disabled'] },
          },
        },
      },
    },
    async (request, reply): Promise<{ affected: number } | FastifyReply> => {
      const actor = requireActor(reply, request)
      if (actor === null) return reply

      const result = await updateManagedUser(actor, request.params.userId, request.body, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      })
      if (!result.ok) return sendFailure(reply, result.reason)
      return reply.code(200).send(result.data)
    },
  )

  app.delete<{ Params: { userId: string } }>(
    '/api/system/users/:userId',
    {
      preHandler: requirePermission(PERMISSIONS.SYSTEM_USER_DELETE),
      schema: { params: USER_PARAMS },
    },
    async (request, reply): Promise<{ affected: number } | FastifyReply> => {
      const actor = requireActor(reply, request)
      if (actor === null) return reply

      const result = await deleteManagedUser(actor, request.params.userId, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      })
      if (!result.ok) return sendFailure(reply, result.reason)
      return reply.code(200).send(result.data)
    },
  )

  app.post<{ Params: { userId: string }; Body: ResetManagedUserPasswordRequest }>(
    '/api/system/users/:userId/reset-password',
    {
      preHandler: requirePermission(PERMISSIONS.SYSTEM_USER_MANAGE),
      schema: {
        params: USER_PARAMS,
        body: {
          type: 'object',
          required: ['newPassword'],
          additionalProperties: false,
          properties: {
            newPassword: {
              type: 'string',
              minLength: PASSWORD_MIN_LENGTH,
              maxLength: PASSWORD_MAX_LENGTH,
            },
          },
        },
      },
    },
    async (request, reply): Promise<{ affected: number } | FastifyReply> => {
      const actor = requireActor(reply, request)
      if (actor === null) return reply

      const result = await resetManagedUserPassword(
        actor,
        request.params.userId,
        request.body.newPassword,
        { ip: request.ip, userAgent: request.headers['user-agent'] },
      )
      if (!result.ok) return sendFailure(reply, result.reason)
      return reply.code(200).send(result.data)
    },
  )

  // -------------------------------------------------------------------------
  // 权限设置
  // -------------------------------------------------------------------------

  app.put<{ Params: { userId: string }; Body: SetManagedUserPermissionsRequest }>(
    '/api/system/users/:userId/permissions',
    {
      preHandler: requirePermission(PERMISSIONS.SYSTEM_USER_MANAGE),
      schema: {
        params: USER_PARAMS,
        body: {
          type: 'object',
          required: ['granted', 'denied'],
          additionalProperties: false,
          properties: { granted: PERMISSION_ARRAY, denied: PERMISSION_ARRAY },
        },
      },
    },
    async (request, reply): Promise<{ affected: number } | FastifyReply> => {
      const actor = requireActor(reply, request)
      if (actor === null) return reply

      const result = await setManagedUserPermissions(
        actor,
        request.params.userId,
        { granted: request.body.granted, denied: request.body.denied },
        { ip: request.ip, userAgent: request.headers['user-agent'] },
      )
      if (!result.ok) return sendFailure(reply, result.reason)
      return reply.code(200).send(result.data)
    },
  )
}
