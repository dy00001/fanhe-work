import type {
  CustomerStage,
  CreateCustomerOrderRequest,
  CreateCustomerRequest,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import {
  createOrder,
  insertCustomer,
  normalizeCustomerInput,
  normalizeOrderAmounts,
  type CustomerOrigin,
  type OrderImportDetail,
  type OrderStepSeed,
} from './customers.js'
import { parseLogTime } from './log-time.js'

/**
 * 批量导入：把 `tools/crm/dryrun.mjs` 干跑出来的预览 JSON 写进三张表。
 *
 * ## 为什么直接调服务层，不走 HTTP
 *
 * 与 `tools/ops-import.ts` 同一条理由：导入是一次性动作（新机部署、库被重建、规则
 * 改了要重灌），为它先起服务、再配一套密钥没有收益。**但校验与派生必须复用
 * `customers.ts`** —— 显示名、短名、地区层级、订单编号、十四环模板这些一旦写成
 * 两份，导入进来的行与人工录入的行就会在最不起眼的地方分叉（显示名少一段地区、
 * 进度条分母少一环），而分叉出来的差异不会被任何测试发现。
 *
 * ## 导入与人工录入的差别只有「来源类字段」
 *
 * 预览里的 53 条有 51 条是 `reviewStatus: pending`、置信度 medium/low —— 那是
 * 事实，不是缺陷。让它走 `createCustomer` 会把这些全部改写成 confirmed/high，
 * 复核队列直接空掉。所以这里用 `insertCustomer` 带一份来自数据的 `CustomerOrigin`。
 *
 * ## 幂等
 *
 * 客户的业务主键是 `chatroom`，订单的编号全局唯一。两者已存在就跳过并计数，
 * 因此重复跑同一份文件是安全的 —— 导入中断后不必先清库再重来。
 */

/** 预览 JSON 里的一条客户。只声明用得到的字段，其余原样忽略。 */
export type PreviewCustomer = {
  chatroom: string
  customerName: string
  region: string
  phone: string | null
  nameSource: string
  primaryNickname: string | null
  confidence: string
  reviewStatus: string
  /** 复购时指向首单的 chatroom。解析成 id 要等首单先入库，故分两遍。 */
  repeatOf: string | null
  project: string | null
  groupFile: string | null
  msgRows: number
  firstMessageAt: string | null
  lastMessageAt: string | null
  skipImg: number
  skipVoice: number
  stage: string
  stageSource: string
  aiSchema?: string | null
  aiStageRaw?: string | null
  aiStageConf?: number | null
  stageConflict?: string | null
  stageCorrectionReason?: string | null
}

/** 预览 JSON 里的一条订单。金额单位是**元**，落库要换算成分。 */
export type PreviewOrder = {
  code: string
  chatroom: string
  displayName: string
  seq: number
  isRepeat: boolean
  stage: string
  stageSource: string
  steps: readonly {
    index: number
    name: string
    reached: boolean
    done: boolean
    start: string | null
    end: string | null
    imprecise: boolean
    note: string | null
  }[]
  amount: {
    contract: number | null
    received: number | null
    unpaid: number | null
    source: string
    confidence: string
    evidenceDate: string | null
    evidenceNote: string | null
  }
}

export type PreviewFile = {
  generatedAt: string
  customers: readonly PreviewCustomer[]
  orders: readonly PreviewOrder[]
}

export type ImportIssue = { key: string; reason: string }

export type ImportReport = {
  customers: { created: number; skipped: number; linked: number; failed: number }
  orders: { created: number; skipped: number; failed: number; steps: number }
  issues: readonly ImportIssue[]
}

/**
 * 时间解析已移到 `log-time.ts`，因为每日同步也要用同一份。
 *
 * 这里保留 re-export：既有测试与调用方都从这个模块拿它，改导入路径是纯粹的
 * 打扰。**不要在本文件里再写一份实现** —— 那样同步路径与导入路径会按不同时区
 * 落库，而界面上只表现为「最近消息时间差 8 小时」。
 */
export { parseLogTime } from './log-time.js'

/** 元 → 分。预览里的金额是整数元，`null` 保持 `null`（未录入，不是 0）。 */
export function yuanToFen(yuan: number | null): number | undefined {
  if (yuan === null) return undefined
  return Math.round(yuan * 100)
}

/**
 * 客户的来源标记，全部取自预览数据。
 *
 * 三个阶段字段分开的理由：`stageSource` 决定界面上那句「这个状态是谁定的」，
 * 而 53 条里 43 条是模型推断、6 条是人工台账、4 条是看板环节明细 —— 合并成
 * 一个值等于把「模型猜的」和「人核对过的」写成一回事。
 */
function originOf(customer: PreviewCustomer): CustomerOrigin {
  return {
    nameSource: customer.nameSource,
    confidence: customer.confidence,
    reviewStatus: customer.reviewStatus,
    stageSource: customer.stageSource,
  }
}

/**
 * `legacy_blocks` 里放什么。
 *
 * 用具体形状而不是 `Record<string, unknown>`：`unknown` 不是 `Prisma.InputJsonValue`，
 * 传进去要么报错、要么逼出一个 `as` 断言 —— 而断言会让「随手塞进一个 Date」这类
 * 错误一路静默到写库时才炸。
 */
type LegacyBlocks = {
  aiSchema?: string
  aiStageRaw?: string
  aiStageConf?: number
  stageConflict?: string
  stageCorrectionReason?: string
}

function legacyBlocksOf(customer: PreviewCustomer): LegacyBlocks {
  const blocks: LegacyBlocks = {}
  if (customer.aiSchema != null) blocks.aiSchema = customer.aiSchema
  if (customer.aiStageRaw != null) blocks.aiStageRaw = customer.aiStageRaw
  if (customer.aiStageConf != null) blocks.aiStageConf = customer.aiStageConf
  if (customer.stageConflict != null) blocks.stageConflict = customer.stageConflict
  if (customer.stageCorrectionReason != null) {
    blocks.stageCorrectionReason = customer.stageCorrectionReason
  }
  return blocks
}

/** 地区必须是前三段式显示名的一部分，空地区会让显示名少一段 —— 那是错误信息。 */
function customerRequestOf(customer: PreviewCustomer): CreateCustomerRequest {
  return {
    chatroom: customer.chatroom,
    realName: customer.customerName,
    region: customer.region,
    phone: customer.phone ?? undefined,
    primaryNickname: customer.primaryNickname ?? undefined,
    project: customer.project ?? undefined,
    stage: customer.stage as CustomerStage,
  }
}

function orderDetailOf(order: PreviewOrder): OrderImportDetail {
  const steps: OrderStepSeed[] = order.steps.map((step) => ({
    idx: step.index,
    reached: step.reached,
    done: step.done,
    startedAt: step.start,
    finishedAt: step.end,
    dateImprecise: step.imprecise,
    note: step.note,
  }))
  return {
    code: order.code,
    seq: order.seq,
    stage: order.stage,
    stageSource: order.stageSource,
    amountSource: order.amount.source,
    amountConfidence: order.amount.confidence,
    amountEvidenceDate: order.amount.evidenceDate,
    amountEvidenceNote: order.amount.evidenceNote,
    steps,
  }
}

function orderRequestOf(order: PreviewOrder): CreateCustomerOrderRequest {
  return {
    contractFen: yuanToFen(order.amount.contract),
    /* `received: 0` 是**真实值**（问过价、没打款），必须原样落成分 0。
       写成 `?? undefined` 会把它当「未录入」，而这两种情况在界面上一个是
       「已收 0 元」、一个是「未录入」，含义完全不同。`yuanToFen` 只对 null 返回 undefined。 */
    receivedFen: yuanToFen(order.amount.received),
    unpaidFen: yuanToFen(order.amount.unpaid),
  }
}

export type ImportOptions = {
  /** 只校验不写库。用于「这份文件能不能进」的最后一道确认。 */
  dryRun?: boolean | undefined
}

/**
 * 导入一份预览。
 *
 * **单条失败不中断整批。** 53 条客户里坏一条，让另外 52 条进不去没有收益；失败项
 * 连同原因汇总在报告里，修完数据重跑即可（幂等键让已成功的那些保持跳过）。
 */
export async function importPreview(
  preview: PreviewFile,
  options: ImportOptions = {},
): Promise<ImportReport> {
  const dryRun = options.dryRun === true
  const issues: ImportIssue[] = []
  const customerIdByChatroom = new Map<string, string>()

  let customerCreated = 0
  let customerSkipped = 0
  let customerFailed = 0

  // ── 第一遍：客户本身。复购指向留空，第二遍再连。
  for (const customer of preview.customers) {
    const existing = await prisma.customer.findUnique({
      where: { chatroom: customer.chatroom },
      select: { id: true },
    })
    if (existing !== null) {
      customerSkipped += 1
      customerIdByChatroom.set(customer.chatroom, existing.id)
      continue
    }

    if (dryRun) {
      /* 干跑只做校验，**一次写都不发生**。这里必须调用 `normalizeCustomerInput`
         而不是 `insertCustomer`：后者会真的建行，那样「干跑」就成了一句空话。 */
      const normalized = normalizeCustomerInput(customerRequestOf(customer))
      if (!normalized.ok) {
        customerFailed += 1
        issues.push({ key: `customer:${customer.chatroom}`, reason: normalized.reason })
        continue
      }
      customerCreated += 1
      customerIdByChatroom.set(customer.chatroom, `dry-run:${customer.chatroom}`)
      continue
    }

    const result = await insertCustomer(customerRequestOf(customer), originOf(customer), {
      msgRows: customer.msgRows,
      firstMessageAt: parseLogTime(customer.firstMessageAt),
      lastMessageAt: parseLogTime(customer.lastMessageAt),
      skipImg: customer.skipImg,
      skipVoice: customer.skipVoice,
      groupFile: customer.groupFile,
      legacyBlocks: legacyBlocksOf(customer),
    })
    if (!result.ok) {
      customerFailed += 1
      issues.push({ key: `customer:${customer.chatroom}`, reason: result.reason })
      continue
    }
    customerCreated += 1
    customerIdByChatroom.set(customer.chatroom, result.data.id)
  }

  // ── 第二遍：复购指向。要等首单客户有了 id 才连得起来。
  let customerLinked = 0
  const repeatPairs = preview.customers.filter((customer) => customer.repeatOf !== null)
  for (const customer of repeatPairs) {
    const selfId = customerIdByChatroom.get(customer.chatroom)
    const firstId = customerIdByChatroom.get(customer.repeatOf ?? '')
    if (selfId === undefined || firstId === undefined || selfId === firstId) {
      issues.push({ key: `repeat:${customer.chatroom}`, reason: 'repeat_target_missing' })
      continue
    }
    if (dryRun) {
      customerLinked += 1
      continue
    }
    await prisma.customer.update({ where: { id: selfId }, data: { repeatOfId: firstId } })
    customerLinked += 1
  }

  // ── 第三遍：订单。按 chatroom 找客户，编号已存在则跳过。
  let orderCreated = 0
  let orderSkipped = 0
  let orderFailed = 0
  let stepRows = 0

  for (const order of preview.orders) {
    const customerId = customerIdByChatroom.get(order.chatroom)
    if (customerId === undefined) {
      orderFailed += 1
      issues.push({ key: `order:${order.code}`, reason: 'customer_missing' })
      continue
    }
    if (dryRun) {
      const invalid = normalizeOrderAmounts(orderRequestOf(order))
      if (invalid !== null) {
        orderFailed += 1
        issues.push({ key: `order:${order.code}`, reason: invalid.reason })
        continue
      }
      orderCreated += 1
      stepRows += order.steps.length
      continue
    }

    const existing = await prisma.customerOrder.findUnique({
      where: { code: order.code },
      select: { id: true },
    })
    if (existing !== null) {
      orderSkipped += 1
      continue
    }

    const result = await createOrder(customerId, orderRequestOf(order), true, orderDetailOf(order))
    if (!result.ok) {
      orderFailed += 1
      issues.push({ key: `order:${order.code}`, reason: result.reason })
      continue
    }
    orderCreated += 1
    stepRows += order.steps.length
  }

  return {
    customers: {
      created: customerCreated,
      skipped: customerSkipped,
      linked: customerLinked,
      failed: customerFailed,
    },
    orders: { created: orderCreated, skipped: orderSkipped, failed: orderFailed, steps: stepRows },
    issues,
  }
}
