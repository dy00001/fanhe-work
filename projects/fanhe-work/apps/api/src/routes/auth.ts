import type { FastifyInstance } from 'fastify'

import { login } from '../auth/login.js'
import { logout, rotateRefreshToken, type LogoutScope } from '../auth/session.js'

/**
 * 认证路由。
 *
 * 三条路径共用一种失败语义：**不区分失败原因**。登录失败不说是账号不存在还是
 * 密码错误，刷新失败不说是令牌不存在、已过期还是已被撤销。原因分开看起来更
 * 友好，但每一条差异都是一个可用的探测接口。原因只进日志。
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
        // 原因只进日志。响应体对四种失败完全一致，调用方无从区分。
        request.log.info({ reason: result.reason, username }, 'login failed')
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
      const result = await rotateRefreshToken(request.body.refreshToken)

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
      const result = await logout(request.body.refreshToken, scope)
      return reply.code(200).send(result)
    },
  )
}
