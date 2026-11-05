/**
 * 模型调用。只做一件事：给一段提示词，拿回一段文字，或者一个**分类过的**失败原因。
 *
 * 不用 SDK、不引依赖，直接用 `fetch` 打 OpenAI 兼容的 `/chat/completions`：这里只需要
 * 一次非流式的补全，SDK 带来的重试与流式处理在这条路径上都用不到，而多一个依赖就多
 * 一份要跟着升级的东西。
 *
 * **失败一律不抛错。** 调用方要的是「有没有正文可以展示」，不是异常栈。抛错的写法
 * 会让每条调用路径都要包一层 try，而任何一处漏包就是把 500 丢给界面 —— 那时用户
 * 看到的是「生成失败」，连兜底的数据版都拿不到。
 */

import type { AssistantReportFailureReason } from '@fanhe/shared'

import { env } from '../config/env.js'

export type LlmOutcome =
  { ok: true; text: string; model: string } | { ok: false; reason: AssistantReportFailureReason }

export type LlmRequest = {
  system: string
  user: string
  /** 覆盖超时，测试用。 */
  timeoutMs?: number
}

type ChatCompletionBody = {
  choices?: Array<{ message?: { content?: unknown } }>
}

/**
 * 端点必须显式配置才调用。
 *
 * 不给默认地址是刻意的：默认值会让「配错了但看起来在跑」成为可能 —— 请求打到某个
 * 恰好也在跑的服务上，返回一段不相干的话，没人会发现。宁可第一次就明确告诉用户
 * 「没配模型」，那时汇报仍然给出完整的数据版。
 */
export async function complete(request: LlmRequest): Promise<LlmOutcome> {
  const baseUrl = env.assistant.modelBaseUrl
  const model = env.assistant.modelName
  if (baseUrl === '' || model === null) {
    return { ok: false, reason: 'model_not_configured' }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => {
    controller.abort()
  }, request.timeoutMs ?? env.assistant.modelTimeoutMs)

  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    const apiKey = env.assistant.modelApiKey
    if (apiKey !== null) headers.authorization = `Bearer ${apiKey}`

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
    })

    if (!response.ok) return { ok: false, reason: 'model_failed' }

    const body = (await response.json()) as ChatCompletionBody
    const content = body.choices?.[0]?.message?.content
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, reason: 'model_failed' }
    }

    return { ok: true, text: content.trim(), model }
  } catch (error) {
    /* `AbortError` 是超时；其余（DNS、拒连、TLS）都归到 model_failed。
       两者在界面上文案不同：超时要提示「稍后重试」，拒连要提示「检查模型地址」。 */
    const aborted = error instanceof Error && error.name === 'AbortError'
    return { ok: false, reason: aborted ? 'model_timeout' : 'model_failed' }
  } finally {
    clearTimeout(timeout)
  }
}
