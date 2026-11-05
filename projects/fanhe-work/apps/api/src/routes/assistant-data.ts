/**
 * AI 数据桥的两条只读接口。
 *
 *   1. `GET  /api/assistant/brief`    — 三个模块的结构化摘要，前端直接展示。
 *   2. `POST /api/assistant/report`   — 摘要 + 模型叙述，返回 markdown。
 *
 * **鉴权为什么用 `requireAuth` 而不是 `requirePermission`。**
 *
 * 这条接口的准入条件是「角色属于 owner / admin」，而权限点是动作维度的，没有、也
 * 不该有「你是不是管理员」这个点。硬造一个 `assistant.data.read` 的话，代价是
 * 迁移与两个镜像都要重建、种子要重跑，换来的只是把同一个判断挪个位置；而它还会
 * 引出另一个问题：这个点授给谁？授给 owner 与 admin 之外的任何角色，汇报的可用性
 * 就超过需求；只授给这两个，它不过是一条冗余的角色判据。
 *
 * 所以：**准入按角色（`viewerForAssistant`），字段裁剪按权限点**。后者才是与现有
 * 体系真正的对接处 —— 管理员被收回 `ops.finance.read`，汇报里的金额当场消失。
 *
 * **失败返回什么。**
 *
 * `POST /report` 在模型不可用时仍然返回 **200**：响应体里有完整的纯数据版汇报，
 * 调用方拿到的东西是可用的，只是少了叙述。用 5xx 表达「AI 没写成」会逼前端把一份
 * 有内容的响应当错误处理，那才是真的丢数据。只有「三个模块全都取不到」才在正文里
 * 标注 `no_data`，状态码仍是 200 —— 那也是一份有效结论，只是结论是「没数据」。
 */

import type { FastifyInstance } from 'fastify'
import type {
  AssistantBriefResponse,
  AssistantDataModule,
  AssistantReportRequest,
  AssistantReportResponse,
} from '@fanhe/shared'
import { ASSISTANT_DATA_MODULES } from '@fanhe/shared'

import {
  ASSISTANT_DAYS_DEFAULT,
  ASSISTANT_DAYS_MAX,
  ASSISTANT_DAYS_MIN,
  rangeOfDays,
} from '../assistant/collect.js'
import { buildBrief, generateReport } from '../assistant/report.js'
import { viewerForAssistant } from '../assistant/scope.js'
import { requireAuth } from '../auth/guard.js'

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' }

/** 角色不符统一一句，不透露「差哪个角色」—— 那等于告诉对方怎么提权。 */
const FORBIDDEN_BODY = {
  error: 'assistant_forbidden',
  message: '数据汇报仅对超级管理员与管理员开放',
}

const BRIEF_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    days: { type: 'integer', minimum: ASSISTANT_DAYS_MIN, maximum: ASSISTANT_DAYS_MAX },
    /** 逗号分隔的模块名，例如 `ops,customer`。省略表示三项全要。 */
    modules: { type: 'string', maxLength: 64 },
  },
} as const

const REPORT_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['days'],
  properties: {
    days: { type: 'integer', minimum: ASSISTANT_DAYS_MIN, maximum: ASSISTANT_DAYS_MAX },
    modules: {
      type: 'array',
      maxItems: 3,
      items: { type: 'string', enum: [...ASSISTANT_DATA_MODULES] },
    },
  },
} as const

/** 把 `ops,customer` 解成数组。未知项直接丢掉 —— 它等价于「不要这个模块」。 */
function parseModules(raw: string | undefined): AssistantDataModule[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const picked = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is AssistantDataModule =>
      (ASSISTANT_DATA_MODULES as readonly string[]).includes(item),
    )
  return picked.length === 0 ? undefined : picked
}

function clampDays(raw: number | undefined): number {
  if (raw === undefined) return ASSISTANT_DAYS_DEFAULT
  return Math.min(ASSISTANT_DAYS_MAX, Math.max(ASSISTANT_DAYS_MIN, Math.trunc(raw)))
}

export function registerAssistantDataRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { days?: number; modules?: string } }>(
    '/api/assistant/brief',
    { preHandler: requireAuth, schema: { querystring: BRIEF_QUERY_SCHEMA } },
    async (request, reply) => {
      const context = request.authContext
      if (context === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const viewer = viewerForAssistant(context)
      if (viewer === null) return reply.code(403).send(FORBIDDEN_BODY)

      const days = clampDays(request.query.days)
      const brief = await buildBrief({
        request,
        viewer,
        days,
        range: rangeOfDays(days),
        modules: parseModules(request.query.modules),
      })

      reply.header('cache-control', 'no-store')
      const body: AssistantBriefResponse = { brief }
      return reply.code(200).send(body)
    },
  )

  app.post<{ Body: AssistantReportRequest }>(
    '/api/assistant/report',
    { preHandler: requireAuth, schema: { body: REPORT_BODY_SCHEMA } },
    async (request, reply) => {
      const context = request.authContext
      if (context === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const viewer = viewerForAssistant(context)
      if (viewer === null) return reply.code(403).send(FORBIDDEN_BODY)

      const days = clampDays(request.body.days)
      const brief = await buildBrief({
        request,
        viewer,
        days,
        range: rangeOfDays(days),
        modules: request.body.modules,
      })

      const outcome = await generateReport(brief)

      reply.header('cache-control', 'no-store')
      const body: AssistantReportResponse = {
        brief,
        markdown: outcome.markdown,
        fallbackMarkdown: outcome.fallbackMarkdown,
        source: outcome.source,
        reason: outcome.reason,
        model: outcome.model,
      }
      return reply.code(200).send(body)
    },
  )
}
