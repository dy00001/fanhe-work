import {
  DISPLAY_NAME_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  USERNAME_MAX_LENGTH,
} from '@fanhe/shared'
import type { InitializeOwnerResponse, SetupStatusResponse } from '@fanhe/shared'
import type { FastifyInstance } from 'fastify'

import { initializeOwner, isInitialized } from '../auth/setup.js'

/**
 * 首次初始化路由。
 *
 * 两条路径都不需要认证，它们服务的对象就是「系统里还没有账号」这一状态。
 * 初始化完成后入口不会消失，但会拒绝执行，理由见 auth/setup.ts 的 isInitialized。
 *
 * 状态查询不设门禁。它只回答一个问题，且答案在攻击者试一次初始化时就知道了，
 * 藏起来没有意义。
 */

type InitializeBody = {
  username: string
  password: string
  displayName: string
}

export function registerSetupRoutes(app: FastifyInstance): void {
  app.get('/api/setup/status', async () => {
    const body: SetupStatusResponse = { initialized: await isInitialized() }
    return body
  })

  app.post<{ Body: InitializeBody }>(
    '/api/setup/initialize',
    {
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password', 'displayName'],
          additionalProperties: false,
          properties: {
            // 这里的长度只做粗筛。真正判断账号名格式的是 shared 里的
            // isValidUsername，它负责字符集与首字符这些 JSON Schema 表达不了的
            // 条件。两处都留着：schema 拦住明显超长的输入，不让它进到业务层。
            username: { type: 'string', minLength: 1, maxLength: USERNAME_MAX_LENGTH },
            password: {
              type: 'string',
              minLength: PASSWORD_MIN_LENGTH,
              maxLength: PASSWORD_MAX_LENGTH,
            },
            displayName: { type: 'string', minLength: 1, maxLength: DISPLAY_NAME_MAX_LENGTH },
          },
        },
      },
    },
    async (request, reply) => {
      // 来源与客户端标识只用于审计。创建 owner 是系统里最值得留痕的一件事。
      const result = await initializeOwner(request.body, {
        ip: request.ip,
        userAgent: request.headers['user-agent'],
      })

      if (!result.ok) {
        if (result.reason === 'invalid_username') {
          return reply.code(400).send({
            error: 'invalid_username',
            message: '账号名只能包含小写字母、数字与 . _ -，须以字母或数字开头，长度 3 到 64',
          })
        }

        // 已初始化与账号名被占用都返回 409：一个描述的是状态冲突，另一个是资源
        // 冲突，两者的处理方式相同，都是「换个思路，别重试」。
        return reply.code(409).send({
          error: result.reason,
          message:
            result.reason === 'already_initialized' ? '系统已完成初始化' : '该账号名已被占用',
        })
      }

      // 不自动签发令牌。初始化与登录是两件事，合成一条路径会多出一条需要单独验证
      // 的令牌签发入口，而客户端紧接着调用登录接口的成本几乎为零。
      const body: InitializeOwnerResponse = result.data
      return reply.code(201).send(body)
    },
  )
}
