import type { AssistantTokenResponse } from '@fanhe/shared'
import type { FastifyInstance } from 'fastify'

import { signAssistantToken } from '../auth/assistant-token.js'
import { requireAuth } from '../auth/guard.js'
import { env } from '../config/env.js'

/**
 * 内嵌 AI 助手的身份桥。
 *
 * 只有一条接口：把「当前登录的是谁」换成一个 EvoFlow 网关能验的令牌。助手页面拿到它
 * 之后塞进 localStorage，此后它自己发的每个请求都会带上这个身份，于是对话历史、技能、
 * 知识库都按人隔离。
 *
 * ## 为什么由 api 签，而不是让前端直接调网关
 *
 * 签名密钥不能进浏览器。前端能拿到的一切都在用户的调试器里，密钥一旦落在那一侧，任何
 * 登录用户都能给自己签一个「别人」的身份，隔离就成了摆设。
 *
 * ## 为什么只要求登录，不挂权限点
 *
 * 这条接口只回答「我是谁」，不暴露任何数据。挂一个权限点会变成「没有该权限的人连
 * 助手页面都进不去」，而实际上助手页面本身对所有账号开放（导航项 `module: null`）。
 * 真正需要限制的是助手内部能做什么，那件事不在这一层。
 */
export function registerAssistantRoutes(app: FastifyInstance): void {
  app.get('/api/assistant/token', { preHandler: requireAuth }, async (request, reply) => {
    const context = request.authContext
    // preHandler 已经保证认证通过，这里的判空只为收窄类型：真出现 null 说明守卫
    // 没挂上，那时 401 比抛一个 500 更贴近事实。
    if (context === null) {
      return reply.code(401).send({ error: 'unauthorized', message: '请先登录' })
    }

    const secret = env.assistant.jwtSecret
    if (secret === null) {
      // 503 而不是 500：这不是故障，是「这个部署没配这一项」。前端据此退回共享
      // 身份形态，页面照常可用。用 500 会让监控把它当成服务异常。
      return reply.code(503).send({
        error: 'assistant_not_configured',
        message: '未配置助手身份桥（缺少 ASSISTANT_JWT_SECRET），将以共享身份使用',
      })
    }

    const { token, expiresAt } = await signAssistantToken({
      userId: context.userId,
      username: context.username,
      roleCode: context.roleCode,
      secret,
    })

    const body: AssistantTokenResponse = { token, expiresAt }
    // 不缓存。令牌里有 exp，缓存一份过期的比不缓存更糟：浏览器会在不知情的情况下
    // 反复送出一个已经失效的身份，而失效的表现是「看到别人的对话」。
    return reply.header('cache-control', 'no-store').code(200).send(body)
  })
}
