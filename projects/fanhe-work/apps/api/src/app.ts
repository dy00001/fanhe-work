import Fastify, { type FastifyInstance } from 'fastify'

import { registerAuthRoutes } from './routes/auth.js'

/**
 * Build the API instance without starting it. Keeping construction separate
 * from listening lets tests drive the server in process later on.
 *
 * 日志默认开启。测试里用 inject 驱动时传 `{ logger: false }`，否则每个用例
 * 都会把请求日志刷到测试输出里，真正的失败信息被淹没。
 */
export function buildApp(options: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? true,
    ajv: {
      customOptions: {
        // Fastify 默认把 removeAdditional 设为 true，即静默丢掉 schema 未声明的
        // 字段。那样调用方会以为某个字段生效了，而它从未被读取 —— 这类「以为
        // 生效了」在排查时最浪费时间。改成拒绝，让各路由 schema 里的
        // additionalProperties: false 真正起作用，而不是变成一次静默删除。
        removeAdditional: false,
      },
    },
  })

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'fanhe-api',
    time: new Date().toISOString(),
  }))

  registerAuthRoutes(app)

  return app
}
