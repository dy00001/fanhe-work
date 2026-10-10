import type { FastifyInstance } from 'fastify'

import { login } from '../auth/login.js'

/**
 * 认证路由。
 */

type LoginBody = {
  username: string
  password: string
  deviceId?: string
  deviceName?: string
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.post<{ Body: LoginBody }>(
    '/api/auth/login',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          // 多余字段直接拒绝。放过去的话，调用方会以为某个字段生效了，而它其实
          // 从未被读取 —— 这类「以为生效了」的配置最容易在排查时浪费时间。
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
}
