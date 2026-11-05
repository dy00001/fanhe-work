/**
 * 数据汇报的展示规则（纯函数）。
 *
 * 放在 `lib/` 而不是组件里，是为了能在 node 里直接测：这个文件里每一条判断错了都不会
 * 报错，只会表现为「入口该出现时没出现」「降级提示写错原因」这类只能靠肉眼发现的问题。
 */

import type { AssistantReportFailureReason } from '@fanhe/shared'

/**
 * 能用数据汇报的角色。
 *
 * 与接口里的 `ASSISTANT_DATA_ROLES` 是同一份名单，但**这里只决定要不要渲染入口**。
 * 真正的准入在服务端：把这段删掉、或者改前端产物，接口仍然返回 403。
 * 前端判断的唯一价值是「不让人点一个必然失败的按钮」。
 */
export const ASSISTANT_REPORT_ROLES: readonly string[] = ['owner', 'admin']

export function canUseAssistantReport(role: string | null | undefined): boolean {
  if (typeof role !== 'string') return false
  return ASSISTANT_REPORT_ROLES.includes(role)
}

/** 可选的回看天数。三档而不是滑杆：汇报是给人看的结论，不是自选区间报表。 */
export const REPORT_DAY_OPTIONS: readonly { days: number; label: string }[] = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' },
]

/**
 * 降级原因 → 一句人话。
 *
 * 分开写而不是统一「生成失败」：`model_timeout` 要让人再试一次，`model_not_configured`
 * 再试一百次也一样，`no_data` 根本不该重试。三种情况给同一句话，用户只会反复点。
 */
export function reportFailureText(reason: AssistantReportFailureReason | null): string {
  switch (reason) {
    case 'model_not_configured':
      return '未配置模型端点，这是纯数据版。配置 ASSISTANT_MODEL_BASE_URL 后会有 AI 叙述。'
    case 'model_timeout':
      return '模型响应超时，这是纯数据版。可以点「重新生成」重试。'
    case 'model_failed':
      return '模型返回异常，这是纯数据版。稍后重试，或检查模型服务是否正常。'
    case 'no_data':
      return '所选区间三个模块都没有取到数据，这里只有口径说明。'
    default:
      return '这是纯数据版。'
  }
}

/** 下载文件名。带日期区间，免得下载十份之后分不清哪份是哪份。 */
export function reportFileName(range: { from: string; to: string }): string {
  return `经营数据简报-${range.from}-至-${range.to}.md`
}
