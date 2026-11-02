/**
 * 公共池归类：把「还没人认领的客户」分给销售或设计师，并支持人工复核。
 *
 * 三件事放在同一个文件里，因为它们共享同一条判据链：
 *
 *   1. **取证据**：读群文件原文，统计销售类与设计类关键词；读不到时退化到库里字段。
 *   2. **判定**：调 `@fanhe/shared` 的纯函数 `classifyPoolCustomer`，规则可单测。
 *   3. **落结果**：一位客户一条记录，未复核的可被重跑覆盖，已复核的保留。
 *
 * ## 触发时机
 *
 * 三条入口，全部走 `classifyPool`，不各写一套：
 *
 *   - 每日同步之后（`tools/customer-sync`）—— 新客户进来当天就能看到建议；
 *   - 手工批量（`pnpm db:pool-classify`）—— 规则改了以后重算全池；
 *   - 接口（`POST /api/customers/pool/classify`）—— 复核页上的「重新判定」。
 *
 * **不挂在客户详情打开时。** 打开详情是只读动作，让它产生写库会带来两个问题：
 * 并发打开同一位客户时互相覆盖；以及「看一眼」也会被记成一次归类，审计里分不清
 * 是机器定期跑的还是人点出来的。
 *
 * ## 为什么读群文件而不是只读库
 *
 * 库里的 `customers` 行只存汇总（消息条数、起止时间、阶段），没有任何一句原文。
 * 而归类要回答的正是「他们在聊钱还是聊尺寸」，这件事只存在于聊天记录里。
 * 读不到时（容器内没有挂载 D 盘）仍然给出结论，但置信度封顶 45 并在依据里写明
 * 「没有读到群文件」—— 让复核的人知道这条几乎等于按阶段猜的。
 */

import {
  AUDIT_ACTIONS,
  DESIGNER_TERMS,
  SALES_TERMS,
  classifyPoolCustomer,
  collectKeywordHits,
  type AssignCustomerRequest,
  type AssignableUsersResponse,
  type ClassifyPoolResponse,
  type CustomerRole,
  type CustomerStage,
  type PoolCustomerDto,
  type PoolListResponse,
  type PoolReason,
  type PoolSuggestionDto,
  type ReviewPoolSuggestionRequest,
} from '@fanhe/shared'

import { recordAudit } from '../audit/audit.js'
import { prisma } from '../db/prisma.js'
import type { Prisma } from '../generated/prisma/client.js'
import { readArchiveMessageIndex, type ArchiveMessage } from './archive.js'
import { assignCustomer, type CustomerResult } from './customers.js'
import { actorOf, scopeWhere, type CustomerViewer } from './scope.js'
import { DEFAULT_CHAT_DIR } from './sync-args.js'

/** 归类用的「最近」窗口。与 `customer-filters` 的默认观察期一致。 */
const RECENT_DAYS = 90

export type ClassifyPoolOptions = {
  viewer: CustomerViewer
  /** 聊天库目录。缺省取 `FANHE_CHAT_DIR`，再缺省取阿阳机器上的默认路径。 */
  chatDir?: string | undefined
  /** 只算这几位。复核页「重新判定」会带上当前行的 id。 */
  customerIds?: string[] | undefined
  /** 已复核的条目也重算。默认 false。 */
  force?: boolean | undefined
  /** 测试注入的「现在」。 */
  now?: Date | undefined
  /** 只算不写。命令行 `--dry-run` 用，便于在正式落库前先看一遍分布。 */
  dryRun?: boolean | undefined
}

/** 候选账号。`load` 是名下已有的客户数，用于「分给最闲的那个人」。 */
type Candidate = { id: string; displayName: string; load: number }

async function candidatesFor(role: CustomerRole): Promise<Candidate[]> {
  const users = await prisma.user.findMany({
    where: { deletedAt: null, status: 'active', role: { code: role } },
    select: {
      id: true,
      displayName: true,
      _count: { select: { designerCustomers: true, salesCustomers: true } },
    },
  })
  return (
    users
      .map((user) => ({
        id: user.id,
        displayName: user.displayName,
        load: role === 'designer' ? user._count.designerCustomers : user._count.salesCustomers,
      }))
      // 同名时按 id 排，保证两次跑出来的建议是同一个人 —— 否则复核人刷新一次
      // 就看到另一个名字，会以为规则不稳定。
      .sort((left, right) => left.load - right.load || left.id.localeCompare(right.id))
  )
}

/**
 * 一位客户的判定证据。
 *
 * 有原文时用词频；没有原文时用库里的汇总（消息条数 + 阶段）。两者的差别会写进
 * `hasTranscript`，最终体现为置信度上限不同。
 */
function buildEvidence(
  customer: {
    stage: string
    msgRows: number
    contractTotalFen: number | null
    lastMessageAt: Date | null
  },
  messages: readonly ArchiveMessage[] | undefined,
  now: Date,
) {
  const recentSince = new Date(now.getTime() - RECENT_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const hasTranscript = messages !== undefined && messages.length > 0
  const stage = customer.stage as CustomerStage

  if (!hasTranscript) {
    return {
      stage,
      messageCount: customer.msgRows,
      recentMessageCount: 0,
      salesHits: [],
      designerHits: [],
      hasContractAmount: (customer.contractTotalFen ?? 0) > 0,
      hasTranscript: false,
    }
  }

  const since = new Date(recentSince).getTime()
  return {
    stage,
    messageCount: messages.length,
    recentMessageCount: messages.filter((message) => new Date(message.at).getTime() >= since)
      .length,
    salesHits: collectKeywordHits(messages, SALES_TERMS, recentSince),
    designerHits: collectKeywordHits(messages, DESIGNER_TERMS, recentSince),
    hasContractAmount: (customer.contractTotalFen ?? 0) > 0,
    hasTranscript: true,
  }
}

/**
 * 跑一次归类。
 *
 * `skipped` 计的是「已复核且没有 force」的条目。**它们不会被覆盖**：复核是人签过的
 * 字，机器重算不该把它改掉，否则每天早上同步一次，人工判断就被悄悄推翻。
 */
export async function classifyPool(options: ClassifyPoolOptions): Promise<ClassifyPoolResponse> {
  const now = options.now ?? new Date()
  const chatDir = options.chatDir ?? process.env.FANHE_CHAT_DIR ?? DEFAULT_CHAT_DIR

  const index = readArchiveMessageIndex(chatDir)
  const source: ClassifyPoolResponse['source'] = index.size > 0 ? 'archive' : 'stored'

  const where: Prisma.CustomerWhereInput = {
    designerId: null,
    salesId: null,
    ...scopeWhere(options.viewer.scope),
    ...(options.customerIds === undefined ? {} : { id: { in: options.customerIds } }),
  }

  const customers = await prisma.customer.findMany({
    where,
    select: {
      id: true,
      chatroom: true,
      stage: true,
      msgRows: true,
      contractTotalFen: true,
      lastMessageAt: true,
    },
  })

  const designers = await candidatesFor('designer')
  const sales = await candidatesFor('sales')

  let analyzed = 0
  let skipped = 0
  let failed = 0
  const byRole = { designer: 0, sales: 0 }

  for (const customer of customers) {
    try {
      const existing = await prisma.customerPoolSuggestion.findUnique({
        where: { customerId: customer.id },
        select: { status: true },
      })
      if (existing !== null && existing.status !== 'pending' && options.force !== true) {
        skipped += 1
        continue
      }

      const evidence = buildEvidence(customer, index.get(customer.chatroom), now)
      const verdict = classifyPoolCustomer(evidence)
      const candidates = verdict.role === 'designer' ? designers : sales

      const reasons = verdict.reasons as unknown as Prisma.InputJsonValue
      const signals = {
        stage: evidence.stage,
        messageCount: evidence.messageCount,
        recentMessageCount: evidence.recentMessageCount,
        hasTranscript: evidence.hasTranscript,
        hasContractAmount: evidence.hasContractAmount,
        salesHits: evidence.salesHits,
        designerHits: evidence.designerHits,
        engine: 'rules-v1',
        analyzedAt: now.toISOString(),
      } as unknown as Prisma.InputJsonValue

      if (options.dryRun === true) {
        analyzed += 1
        byRole[verdict.role] += 1
        continue
      }

      await prisma.customerPoolSuggestion.upsert({
        where: { customerId: customer.id },
        create: {
          customerId: customer.id,
          role: verdict.role,
          suggestedUserId: candidates[0]?.id ?? null,
          confidence: verdict.confidence,
          salesScore: verdict.salesScore,
          designerScore: verdict.designerScore,
          reasons,
          signals,
        },
        update: {
          role: verdict.role,
          suggestedUserId: candidates[0]?.id ?? null,
          confidence: verdict.confidence,
          salesScore: verdict.salesScore,
          designerScore: verdict.designerScore,
          reasons,
          signals,
          engine: 'rules-v1',
          // 走到 update 只有两种情况：未复核，或显式 force。两种都要重置为待复核，
          // 否则一条「调整过」的旧结论会带着旧的复核人出现在队列里。
          status: 'pending',
          reviewedBy: null,
          reviewedAt: null,
          reviewNote: null,
        },
      })

      analyzed += 1
      byRole[verdict.role] += 1
    } catch {
      // 单条失败不中断整批：58 位客户里任何一条的字段异常都不该让其余 57 条
      // 停止归类。失败的条数进报告，由调用方决定要不要重跑。
      failed += 1
    }
  }

  return { analyzed, skipped, failed, byRole, source }
}

/**
 * 可被指派为负责人的账号。按角色分组，供界面渲染两个下拉。
 *
 * 只查两类角色。用角色 code 而不是「持有客户读写权限的人」：后者会把被单独授予
 * 权限的成员也算进来，而「成员」并不是一个业务身份，指派之后归属列会显示一个
 * 没有岗位标签的名字。
 */
export async function listAssignableUsers(): Promise<AssignableUsersResponse> {
  const users = await prisma.user.findMany({
    where: { deletedAt: null, status: 'active', role: { code: { in: ['designer', 'sales'] } } },
    select: { id: true, displayName: true, role: { select: { code: true } } },
    orderBy: [{ role: { code: 'asc' } }, { displayName: 'asc' }],
  })

  return {
    users: users.map((user) => ({
      id: user.id,
      displayName: user.displayName,
      role: user.role.code === 'designer' ? 'designer' : 'sales',
    })),
  }
}

/** 归类结果行的选择项。数据库行 → DTO 的映射集中在这里。 */
const SUGGESTION_SELECT = {
  id: true,
  role: true,
  suggestedUserId: true,
  confidence: true,
  salesScore: true,
  designerScore: true,
  reasons: true,
  status: true,
  engine: true,
  reviewedAt: true,
  reviewNote: true,
  updatedAt: true,
  suggestedUser: { select: { displayName: true } },
  reviewer: { select: { displayName: true } },
} as const

type SuggestionRow = {
  id: string
  role: string
  suggestedUserId: string | null
  confidence: number
  salesScore: number
  designerScore: number
  reasons: unknown
  status: string
  engine: string
  reviewedAt: Date | null
  reviewNote: string | null
  updatedAt: Date
  suggestedUser: { displayName: string } | null
  reviewer: { displayName: string } | null
}

function toSuggestionDto(row: SuggestionRow): PoolSuggestionDto {
  return {
    id: row.id,
    // 库里是字符串。越界值落成 sales：它是「新客户默认归销售」这一条流程起点，
    // 比落成 designer 更接近真实。这类值只可能来自手工改库。
    role: row.role === 'designer' ? 'designer' : 'sales',
    suggestedUserId: row.suggestedUserId,
    suggestedUserName: row.suggestedUser?.displayName ?? null,
    confidence: row.confidence,
    salesScore: row.salesScore,
    designerScore: row.designerScore,
    // 理由整块从 Json 读回来，不做字段级校验：它只被展示，写坏的表现是依据空着，
    // 而不是判定错误。逐字段校验会让一条坏数据拖垮整个列表。
    reasons: Array.isArray(row.reasons) ? (row.reasons as PoolReason[]) : [],
    status: (['pending', 'accepted', 'adjusted', 'rejected'] as const).includes(
      row.status as 'pending',
    )
      ? (row.status as PoolSuggestionDto['status'])
      : 'pending',
    engine: row.engine,
    reviewedByName: row.reviewer?.displayName ?? null,
    reviewedAt: row.reviewedAt?.toISOString() ?? null,
    reviewNote: row.reviewNote,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 公共池列表。按「最久没消息的排前面」排序：它们最需要被处理。
 *
 * 只返回两项归属都为空的客户。**注意区分「公共池」与「只有一个负责人」**：
 * 后者已经有人认领，剩下的那一栏由复核页或详情页去补，不混进公共池队列。
 */
export async function listPool(viewer: CustomerViewer): Promise<PoolListResponse> {
  const where: Prisma.CustomerWhereInput = {
    designerId: null,
    salesId: null,
    ...scopeWhere(viewer.scope),
  }

  const rows = await prisma.customer.findMany({
    where,
    select: {
      id: true,
      displayName: true,
      region: true,
      stage: true,
      msgRows: true,
      lastMessageAt: true,
      poolSuggestion: { select: SUGGESTION_SELECT },
    },
    orderBy: [{ lastMessageAt: 'asc' }, { createdAt: 'asc' }],
    take: 200,
  })

  const items: PoolCustomerDto[] = rows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    region: row.region,
    stage: row.stage as PoolCustomerDto['stage'],
    msgRows: row.msgRows,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    suggestion:
      row.poolSuggestion === null ? null : toSuggestionDto(row.poolSuggestion as SuggestionRow),
  }))

  return {
    items,
    total: items.length,
    pending: items.filter((item) => item.suggestion?.status === 'pending').length,
  }
}

/**
 * 复核一条归类结果。
 *
 * 三种决定的共同点是「都要把结论落成归属」，差别只在落成什么：
 *
 *   - `accepted`：按建议的角色与建议的账号；
 *   - `adjusted`：用请求里的角色与账号，缺省仍取建议值；
 *   - `rejected`：不动归属，只标状态。下次重跑会重新给出建议（除非 force）。
 *
 * **先落归属再改状态。** 反过来的话，归属校验失败会留下一条「已接受但没生效」的
 * 记录，而队列里它已经消失 —— 这种状态没有任何界面能表达。
 */
export async function reviewPoolSuggestion(
  customerId: string,
  suggestionId: string,
  input: ReviewPoolSuggestionRequest,
  viewer: CustomerViewer,
): Promise<CustomerResult<{ suggestion: PoolSuggestionDto }>> {
  const suggestion = await prisma.customerPoolSuggestion.findFirst({
    where: { id: suggestionId, customerId },
    select: SUGGESTION_SELECT,
  })
  if (suggestion === null) return { ok: false, reason: 'not_found' }

  /*
   * 复核必须留一句话。三个月后回看「为什么把他划给设计师」，只有这条注释能回答 ——
   * 判定依据（`reasons`）说明的是机器怎么想，注释说明的是人怎么想，两者不能互相替代。
   */
  const note = (input.note ?? '').trim()
  if (note === '') return { ok: false, reason: 'missing_reason' }

  if (input.decision === 'rejected') {
    await prisma.customerPoolSuggestion.update({
      where: { id: suggestion.id },
      data: {
        status: 'rejected',
        reviewedBy: actorOf(viewer).id,
        reviewedAt: new Date(),
        reviewNote: note,
      },
    })
    await recordAudit({
      action: AUDIT_ACTIONS.CUSTOMER_POOL_REVIEW,
      actor: actorOf(viewer),
      target: { type: 'customer', id: customerId },
      detail: { decision: 'rejected', suggestedRole: suggestion.role, note },
    })
    return { ok: true, data: { suggestion: await readSuggestion(suggestion.id) } }
  }

  const suggestedRole: CustomerRole = suggestion.role === 'designer' ? 'designer' : 'sales'
  const role: CustomerRole =
    input.decision === 'adjusted' && input.role !== undefined ? input.role : suggestedRole

  /*
   * 账号的决定顺序：显式指定 → 建议值 → 该角色下最闲的人。
   *
   * 兜底只在「跑归类时库里还没有这个角色的账号」时生效。那种情况下系统塞一个人
   * 也说得过去，但仍然是兜底而不是默认 —— 复核人的选择永远优先。
   */
  let userId: string | null =
    input.userId !== undefined ? input.userId : (suggestion.suggestedUserId ?? null)
  if (userId === null) {
    const candidates = await candidatesFor(role)
    userId = candidates[0]?.id ?? null
  }
  if (userId === null) return { ok: false, reason: 'invalid_assignee' }

  /*
   * 账号的角色必须与归类一致。把一位销售记进 `designer_id` 不会报错，但需求第 1 条
   * 「设计师端看到对应的销售」会显示成同一个人 —— 看起来像数据错乱，实际是归类时
   * 选错了栏。在校验这里挡掉，比让它在界面上呈现更容易排查。
   */
  const account = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null, status: 'active' },
    select: { id: true, role: { select: { code: true } } },
  })
  if (account === null || account.role.code !== role) {
    return { ok: false, reason: 'invalid_assignee' }
  }

  const assignment: AssignCustomerRequest =
    role === 'designer' ? { designerId: userId, reason: note } : { salesId: userId, reason: note }

  /*
   * **先落归属，再改状态。** 反过来的话，归属校验失败会留下一条「已接受但没生效」
   * 的记录，而它已经从待办队列里消失 —— 这种状态没有任何界面能表达。
   *
   * `keepSuggestionId` 是必须的：`assignCustomer` 会清掉未复核的建议（归属变了，
   * 旧建议就过期了），而正在复核的这一条还没改成 accepted，不排除就会被一起删掉。
   */
  const assigned = await assignCustomer(customerId, assignment, viewer, {
    keepSuggestionId: suggestion.id,
  })
  if (!assigned.ok) return { ok: false, reason: assigned.reason }

  await prisma.customerPoolSuggestion.update({
    where: { id: suggestion.id },
    data: {
      status: input.decision === 'adjusted' ? 'adjusted' : 'accepted',
      role,
      suggestedUserId: userId,
      reviewedBy: actorOf(viewer).id,
      reviewedAt: new Date(),
      reviewNote: note,
    },
  })

  await recordAudit({
    action: AUDIT_ACTIONS.CUSTOMER_POOL_REVIEW,
    actor: actorOf(viewer),
    target: { type: 'customer', id: customerId },
    detail: {
      decision: input.decision,
      suggestedRole,
      assignedRole: role,
      assignedUserId: userId,
      note,
    },
  })

  return { ok: true, data: { suggestion: await readSuggestion(suggestion.id) } }
}

/** 复核完成后回读一次，保证返回给界面的就是库里的状态，不拼接内存里的猜测。 */
async function readSuggestion(id: string): Promise<PoolSuggestionDto> {
  const row = await prisma.customerPoolSuggestion.findUniqueOrThrow({
    where: { id },
    select: SUGGESTION_SELECT,
  })
  return toSuggestionDto(row as SuggestionRow)
}
