/**
 * 汇报的组装：取数 → 结构化摘要 → （可选）模型叙述。
 *
 * 这里是整个数据桥唯一的「拼装点」。三个模块的取数都走 `collect.ts`，本文件只负责
 * 把它们排成一份可读的东西，以及在没有模型时也能交出一份**信息完整**的数据版。
 *
 * **为什么一定要有数据版。** 模型不可用、超时、返回空串都会发生，而汇报这件事的
 * 价值有八成在数据本身，叙述只占两成。让用户因为「AI 挂了」而拿不到数字，是把
 * 一个可用功能绑死在一个不可用依赖上。
 */

import type {
  AssistantBrief,
  AssistantCustomerSnapshot,
  AssistantDataModule,
  AssistantModuleBlock,
  AssistantModuleReason,
  AssistantOpsSnapshot,
  AssistantQuoteSnapshot,
  AssistantReportFailureReason,
} from '@fanhe/shared'

import type { FastifyRequest } from 'fastify'

import { collectCustomer, collectOps, collectQuote } from './collect.js'
import { complete } from './llm.js'
import { MODULE_LABEL, scopeNoteOf, type AssistantDataViewer } from './scope.js'

const ALL_MODULES: readonly AssistantDataModule[] = ['ops', 'customer', 'quote']

function unavailable<T>(reason: AssistantModuleReason): AssistantModuleBlock<T> {
  return { status: 'unavailable', reason, data: null }
}

/**
 * 取一个模块，任何异常都收成 `unavailable`。
 *
 * 单个模块失败不能拖垮整份汇报：客户表锁表时，运营与报价的数字仍然有价值。
 * 但失败必须在正文里说明是哪个模块、为什么，不能悄悄少一块 —— 少一块的汇报
 * 比明确说「客户模块本次取数失败」更危险，因为读者会默认它包含全部。
 */
async function collectModule<T>(
  fetcher: () => Promise<T>,
  isEmpty: (data: T) => boolean,
): Promise<AssistantModuleBlock<T>> {
  try {
    const data = await fetcher()
    return isEmpty(data)
      ? { status: 'empty', reason: 'no_data', data }
      : { status: 'ok', reason: null, data }
  } catch {
    return unavailable<T>('fetch_failed')
  }
}

export async function buildBrief(input: {
  request: FastifyRequest
  viewer: AssistantDataViewer
  days: number
  range: { from: string; to: string }
  modules?: readonly AssistantDataModule[] | undefined
}): Promise<AssistantBrief> {
  const wanted = new Set<AssistantDataModule>(input.modules ?? ALL_MODULES)

  const opsBlock = wanted.has('ops')
    ? input.viewer.modules.ops.allowed
      ? await collectModule<AssistantOpsSnapshot>(
          () => collectOps(input.viewer, input.range, input.days),
          (data) => data.shops.length === 0 || data.shops.every((shop) => !shop.hasData),
        )
      : unavailable<AssistantOpsSnapshot>('no_permission')
    : unavailable<AssistantOpsSnapshot>('no_permission')

  const customerBlock = wanted.has('customer')
    ? input.viewer.modules.customer.allowed
      ? await collectModule<AssistantCustomerSnapshot>(
          () => collectCustomer(input.request, input.range),
          (data) => data.total === 0,
        )
      : unavailable<AssistantCustomerSnapshot>('no_permission')
    : unavailable<AssistantCustomerSnapshot>('no_permission')

  const quoteBlock = wanted.has('quote')
    ? input.viewer.modules.quote.allowed
      ? await collectModule<AssistantQuoteSnapshot>(
          () => collectQuote(),
          (data) => data.exact + data.family + data.manual === 0,
        )
      : unavailable<AssistantQuoteSnapshot>('no_permission')
    : unavailable<AssistantQuoteSnapshot>('no_permission')

  return {
    generatedAt: new Date().toISOString(),
    range: input.range,
    viewer: {
      roleCode: input.viewer.roleCode,
      roleName: input.viewer.roleName,
      scopeNote: scopeNoteOf(input.viewer),
    },
    ops: opsBlock,
    customer: customerBlock,
    quote: quoteBlock,
  }
}

/** 三块全都没有数据可取时，没有可汇报的内容。 */
export function hasAnything(brief: AssistantBrief): boolean {
  return [brief.ops, brief.customer, brief.quote].some(
    (block) => block.status === 'ok' || block.status === 'empty',
  )
}

// ---------------------------------------------------------------------------
// 纯数据版
// ---------------------------------------------------------------------------

/** 分转元，带千分位。金额一律在展示层转，结构体里保持「分」以免来回换算出误差。 */
export function fenToYuan(fen: number | null): string {
  if (fen === null) return '—'
  const yuan = fen / 100
  return `¥${yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function reasonText(reason: AssistantModuleReason | null): string {
  switch (reason) {
    case 'no_permission':
      return '当前账号没有该模块的读权限'
    case 'fetch_failed':
      return '取数失败'
    case 'no_data':
      return '区间内没有数据'
    default:
      return '未纳入'
  }
}

function blockLine(block: AssistantModuleBlock<unknown>): string {
  if (block.status === 'ok') return '正常'
  if (block.status === 'empty') return `无数据（${reasonText(block.reason)}）`
  return `不可用（${reasonText(block.reason)}）`
}

/**
 * 不依赖模型的数据版汇报。
 *
 * 它同时是**降级输出**和**校对基准**：模型写的正文里如果数字与这份对不上，就是模型
 * 编的。因此这份必须把关键数字写全，不能只写一句「见上方数据」。
 */
export function renderFallback(brief: AssistantBrief): string {
  const lines: string[] = []
  lines.push(`# 经营数据简报（${brief.range.from} 至 ${brief.range.to}）`)
  lines.push('')
  lines.push(`- 生成时间：${new Date(brief.generatedAt).toLocaleString('zh-CN')}`)
  lines.push(`- 查看角色：${brief.viewer.roleName}（${brief.viewer.roleCode}）`)
  lines.push(`- 覆盖范围：${brief.viewer.scopeNote}`)
  lines.push('')

  lines.push(`## 一、运营信息平台（${blockLine(brief.ops)}）`)
  if (brief.ops.data !== null) {
    const ops = brief.ops.data
    lines.push('')
    lines.push(`- 覆盖天数：${ops.days} 天`)
    lines.push(`- 全店支付金额：${fenToYuan(ops.totalPayAmountFen)}`)
    lines.push(`- 全店支付买家：${ops.totalPayBuyers ?? '—'}`)
    lines.push('')
    lines.push('| 店铺 | 有数据 | 覆盖天数 | 支付金额 | 支付买家 | 访客 | 支付率 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const shop of ops.shops) {
      lines.push(
        `| ${shop.name} | ${shop.hasData ? '是' : '否'} | ${shop.coveredDays} | ${
          shop.masked ? '无权限' : fenToYuan(shop.payAmountFen)
        } | ${shop.payBuyers ?? '—'} | ${shop.visitors ?? '—'} | ${
          shop.payRate === null ? '—' : `${(shop.payRate * 100).toFixed(2)}%`
        } |`,
      )
    }
    if (ops.collect !== null) {
      lines.push('')
      lines.push(
        `- 采集器：${ops.collect.online ? '在线' : '离线'}${
          ops.collect.lastSeenAt === null
            ? ''
            : `（最后心跳 ${new Date(ops.collect.lastSeenAt).toLocaleString('zh-CN')}）`
        }`,
      )
      if (ops.collect.emptyShops.length > 0) {
        lines.push(`- 本期无数店铺：${ops.collect.emptyShops.join('、')}`)
      }
    }
  }
  lines.push('')

  lines.push(`## 二、客户信息平台（${blockLine(brief.customer)}）`)
  if (brief.customer.data !== null) {
    const customer = brief.customer.data
    lines.push('')
    lines.push(
      `- 客户总数：${customer.total}（范围：${customer.scopeKind === 'all' ? '全库' : '本人负责'}）`,
    )
    lines.push(`- 进行中：${customer.inProgress}`)
    lines.push(`- 区间新增：${customer.newInWindow}`)
    lines.push(
      `- 合同额合计：${customer.financeReadable ? fenToYuan(customer.amountTotalFen) : '无金额权限'}`,
    )
    if (customer.pendingReview !== null) lines.push(`- 待复核：${customer.pendingReview}`)
    if (customer.byStage.length > 0) {
      lines.push('')
      lines.push(
        `- 阶段分布：${customer.byStage.map((item) => `${item.stage} ${item.count}`).join('，')}`,
      )
    }
    if (customer.byRegion.length > 0) {
      lines.push(
        `- 地区分布：${customer.byRegion.map((item) => `${item.region} ${item.count}`).join('，')}`,
      )
    }
  }
  lines.push('')

  lines.push(`## 三、报价体系（${blockLine(brief.quote)}）`)
  if (brief.quote.data !== null) {
    const quote = brief.quote.data
    lines.push('')
    lines.push(`- 精确绑定条目：${quote.exact}`)
    lines.push(`- 同产品继承：${quote.family}`)
    lines.push(`- 手工上传：${quote.manual}`)
    lines.push(`- 五金无图：${quote.noImage}`)
    lines.push(`- 图文件：${quote.imageFiles}（无引用 ${quote.unbound}）`)
    lines.push(`- 分类 / 主类：${quote.categories} / ${quote.sources}`)
    lines.push(`- 近 7 天变更：${quote.recentRevisions} 条`)
    if (quote.revisionActions.length > 0) {
      lines.push(
        `- 变更类型：${quote.revisionActions.map((item) => `${item.action} ${item.count}`).join('，')}`,
      )
    }
  }
  lines.push('')

  lines.push('## 数据边界')
  lines.push('')
  lines.push('- 不含客户手机号、真实姓名与聊天原文。')
  lines.push('- 不含报价单价与清单明细；金额口径以权限点为准，无权限时显示为「无权限」。')
  lines.push('- 客户数据按当前账号的可见范围统计，范围收窄时数字不可与全库直接比较。')

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 模型叙述
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  '你是「梵禾 Work」的经营数据分析助手，服务对象是全屋定制家具公司的管理者。',
  '',
  '规则，逐条遵守：',
  '1. 只使用用户消息里给出的数据。**不要引入任何外部知识、行业均值或估算**。',
  '2. 数据里没有的，就写「数据未覆盖」，不要推测。',
  '3. 字段名以 Fen 结尾的单位是「分」，正文里一律换算成元并保留两位小数。',
  '4. 金额为 null 表示「当前账号无金额权限」，不是 0；这种情况不要计算合计，直接说明不可得。',
  '5. 某个模块 status 不是 ok 时，在正文里明确写它不可用及原因，不要跳过。',
  '   但**不要把 status、financeReadable、masked 这类字段名写进正文**——读者要的是中文事实，不是结构体字段。',
  '6. 不要复述整张表。表格由系统另外展示，你写结论、关联与建议。',
  '',
  '输出格式（markdown，不要加代码块围栏）：',
  '## 结论',
  '两三句话，点出这段区间最重要的一件事。',
  '## 分模块观察',
  '每个有数据的模块一段，写「看到了什么 + 意味着什么」，不要只罗列数字。',
  '## 风险与建议',
  '最多三条，按影响排序。没有可说的就写「本区间无明显异常」。',
].join('\n')

export type ReportOutcome = {
  markdown: string
  fallbackMarkdown: string
  source: 'model' | 'fallback'
  reason: AssistantReportFailureReason | null
  model: string | null
}

export async function generateReport(brief: AssistantBrief): Promise<ReportOutcome> {
  const fallbackMarkdown = renderFallback(brief)

  if (!hasAnything(brief)) {
    return {
      markdown: '',
      fallbackMarkdown,
      source: 'fallback',
      reason: 'no_data',
      model: null,
    }
  }

  const result = await complete({
    system: SYSTEM_PROMPT,
    user: [
      `统计区间：${brief.range.from} 至 ${brief.range.to}`,
      `查看角色：${brief.viewer.roleName}`,
      `覆盖范围：${brief.viewer.scopeNote}`,
      '',
      '以下是已按当前账号权限裁剪过的数据（JSON）：',
      '```json',
      JSON.stringify(brief, null, 2),
      '```',
    ].join('\n'),
  })

  if (!result.ok) {
    return {
      markdown: '',
      fallbackMarkdown,
      source: 'fallback',
      reason: result.reason,
      model: null,
    }
  }

  return {
    markdown: result.text,
    fallbackMarkdown,
    source: 'model',
    reason: null,
    model: result.model,
  }
}

export { MODULE_LABEL }
