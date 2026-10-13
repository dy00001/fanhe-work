import { ALL_PERMISSIONS } from '@fanhe/shared'
import Fastify, { type FastifyInstance } from 'fastify'

import { registerAuthSupport } from './auth/guard.js'
import { initPermissionCatalog } from './auth/user-admin.js'
import { registerAuthRoutes } from './routes/auth.js'
import { registerEventRoutes } from './routes/events.js'
import { registerLaunchRoutes } from './routes/launch.js'
import { registerNoteRoutes } from './routes/notes.js'
import { registerSetupRoutes } from './routes/setup.js'
import { registerSystemUserRoutes } from './routes/system-users.js'
import { registerVersionRoutes } from './version/manifest.js'

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

  // 认证结果的容器必须在注册任何使用守卫的路由之前挂上。
  registerAuthSupport(app)

  // 账号管理服务需要知道「有哪些权限点」才能校验提交上来的权限码。把权限清单
  // 从模块加载期移到显式初始化，是因为它依赖 @fanhe/shared 的导出，而 app.ts
  // 是这个包的所有者 —— 让它决定注入什么，而不是让服务层自己去 import。
  initPermissionCatalog(ALL_PERMISSIONS)

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'fanhe-api',
    time: new Date().toISOString(),
  }))

  registerAuthRoutes(app)
  registerSetupRoutes(app)
  registerLaunchRoutes(app)
  registerNoteRoutes(app)
  registerEventRoutes(app)
  registerSystemUserRoutes(app)
  // 版本清单不设门禁（T6-02 需要它在登录之前可用，理由见 version/manifest.ts）。
  registerVersionRoutes(app)

  return app
}
