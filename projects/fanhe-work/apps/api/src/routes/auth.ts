import type { FastifyInstance } from 'fastify'

import { requireAuth } from '../auth/guard.js'
import { login } from '../auth/login.js'
import { logout, rotateRefreshToken, type LogoutScope } from '../auth/session.js'
import { env } from '../config/env.js'

/**
 * 认证路由。
 *
 * 三条路径共用一种失败语义：**不区分失败原因**。登录失败不说是账号不存在还是
 * 密码错误，刷新失败不说是令牌不存在、已过期还是已被撤销。原因分开看起来更
 * 友好，但每一条差异都是一个可用的探测接口。原因只进日志。
 *
 * 唯一的例外是 IP 维度限速，它返回 429。它不涉及任何账号信息，只说明这个来源
 * 短时间内失败太多次。让客户端知道要等多久是必要的，伪装成 401 只会让正常用户
 * 以为密码错了而反复重试。
 */

type LoginBody = {
  username: string
  password: string
  deviceId?: string
  deviceName?: string
}

type RefreshBody = {
  refreshToken: string
}

type LogoutBody = {
  refreshToken: string
  scope?: LogoutScope
}

/**
 * 刷新令牌的长度上限。
 *
 * 实际值固定为 43 个字符（32 字节 base64url），这里给到 512 只是留出余地，
 * 让将来换算法时不必同步改 schema。下限设为 1，是为了让空串走 schema 校验
 * 而不是进到数据库查询里。
 */
const REFRESH_TOKEN_SCHEMA = { type: 'string', minLength: 1, maxLength: 512 } as const

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          // 多余字段直接拒绝。放过去的话，调用方会以为某个字段生效了，而它其实
          // 从未被读取。这类「以为生效了」的配置最容易在排查时浪费时间。
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            // 上限设在这里而不是靠密码策略：没有上限时，一个几百 MB 的请求体
            // 会先被完整读进来，再交给 Argon2 处理。
            password: { type: 'string', minLength: 1, maxLength: 512 },
            deviceId: { type: 'string', maxLength: 128 },
            deviceName: { type: 'string', maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, password, deviceId, deviceName } = request.body

      const result = await login({
        username,
        password,
        deviceId,
        deviceName,
        userAgent: request.headers['user-agent'],
        ip: request.ip,
      })

      if (!result.ok) {
        request.log.info({ reason: result.reason, username }, 'login failed')

        // 限速单独返回 429，并在 Retry-After 里给出窗口长度。这是唯一一种对外
        // 可见的失败原因，它不泄露任何账号信息，而让客户端知道「要等一会儿」
        // 而不是「密码错了」，可以避免用户在窗口内反复重试，把窗口越拖越长。
        if (result.reason === 'ip_rate_limited') {
          return reply
            .code(429)
            .header('retry-after', String(env.login.ipWindowMinutes * 60))
            .send({
              error: 'too_many_requests',
              message: '登录尝试过于频繁，请稍后再试',
            })
        }

        // 其余原因共用同一个响应，调用方无从区分账号是否存在、是否被停用或锁定。
        return reply.code(401).send({
          error: 'invalid_credentials',
          message: '用户名或密码不正确',
        })
      }

      return reply.code(200).send(result.data)
    },
  )

  app.post<{ Body: RefreshBody }>(
    '/api/auth/refresh',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          additionalProperties: false,
          properties: { refreshToken: REFRESH_TOKEN_SCHEMA },
        },
      },
    },
    async (request, reply) => {
      // 带上来源与客户端标识。重放检测命中时要把这两项写进审计 —— 那正是最需要
      // 知道「从哪儿来的」的时刻。
      const result = await rotateRefreshToken(request.body.refreshToken, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      })

      if (!result.ok) {
        request.log.info({ reason: result.reason }, 'refresh failed')
        return reply.code(401).send({
          error: 'invalid_token',
          message: '登录状态已失效，请重新登录',
        })
      }

      return reply.code(200).send(result.data)
    },
  )

  app.post<{ Body: LogoutBody }>(
    '/api/auth/logout',
    {
      schema: {
        body: {
          type: 'object',
          required: ['refreshToken'],
          additionalProperties: false,
          properties: {
            refreshToken: REFRESH_TOKEN_SCHEMA,
            scope: { type: 'string', enum: ['session', 'device', 'all'] },
          },
        },
      },
    },
    async (request, reply) => {
      // 默认只撤当前会话。撤销范围越大影响面越大，不能靠「省略参数」意外得到，
      // 必须由调用方显式指定。
      const scope: LogoutScope = request.body.scope ?? 'session'
      const result = await logout(request.body.refreshToken, scope, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      })
      return reply.code(200).send(result)
    },
  )

  app.get('/api/auth/me', { preHandler: requireAuth }, async (request, reply) => {
    const auth = request.authContext

    // requireAuth 已经保证这里不为 null，判断只是为了收窄类型。真出现 null 说明
    // 守卫没有挂上，那时返回 401 比抛一个 500 更贴近事实。
    if (auth === null) {
      return reply.code(401).send({ error: 'unauthorized', message: '请先登录' })
    }

    // 权限点一并返回。前端据此渲染菜单与按钮的可见性，服务端仍然独立校验，
    // 两边引用的是同一份常量。前端拿到的是「可以展示什么」，不是「可以做什么」。
    return reply.code(200).send({
      user: {
        id: auth.userId,
        username: auth.username,
        displayName: auth.displayName,
        role: auth.roleCode,
      },
      permissions: auth.permissions,
    })
  })
}
