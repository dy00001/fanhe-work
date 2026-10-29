import {
  CUSTOMER_LIMITS,
  CUSTOMER_STAGES,
  buildInitialSteps,
  customerDisplayName,
  customerShortName,
  isStageRegression,
  maskContractTotal,
  maskOrderAmounts,
  normalizeRegion,
  regionScopeOf,
  type CreateCustomerOrderRequest,
  type CreateCustomerRequest,
  type CustomerAmounts,
  type CustomerDetailDto,
  type CustomerListItemDto,
  type CustomerListResponse,
  type CustomerOrderDto,
  type CustomerStage,
  type SetCustomerStageRequest,
  type UpdateCustomerRequest,
  type UpdateCustomerStepRequest,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
/* 值导入，不是 `import type`：下面用 `Prisma.DbNull` 表示「这一列显式写 NULL」，
   那是运行时常量。用 type-only 导入时 tsc 报 TS1361，而这条路径只在
   `legacyBlocks` 缺省时才会走到，单测与冒烟都碰不到。 */
import { Prisma } from '../generated/prisma/client.js'

/**
 * 客户档案与订单的读写。
 *
 * **与个人工作台那几个模块最根本的差别：这里的数据不属于某个人。** 纪要与启动
 * 配置按 `userId` 隔离，谁写的谁看；客户档案是公司资产，五个账号看的是同一份。
 * 因此这里没有「所有权」参数，隔离由权限点承担，而不是由 where 条件承担 ——
 * 把 userId 塞进 where 反而会让「换个账号就看同一客户」变成一句谎话。
 *
 * **金额裁剪在这里做，不在路由里。** 路由只负责算出一个布尔值（有没有
 * `customer.finance.read`），裁剪本身与其余字段的映射写在同一处。分开写的话，
 * 新增一条返回订单的接口时很容易漏掉裁剪，而漏掉的表现是「金额原样出现在
 * 界面上」—— 它不会报错，只会有人某天发现自己看到了不该看的数字。
 *
 * **不写审计。** 与纪要同一判断：改一个客户的电话，影响范围不超出这个客户本身。
 * 真正需要审计的是「谁把合同额从 16.8 万改成 0」，而那类改动属于金额字段，
 * 等金额编辑接口做出来时再单独加审计，不在这里预先铺一层。
 */

export type CustomerFailureReason =
  | 'not_found'
  | 'invalid_name'
  | 'invalid_region'
  | 'invalid_phone'
  | 'invalid_stage'
  | 'invalid_amount'
  | 'missing_reason'
  | 'duplicate_chatroom'
  | 'duplicate_code'

export type CustomerResult<T> = { ok: true; data: T } | { ok: false; reason: CustomerFailureReason }

/** 列表筛选条件。全部可选，缺省即不加条件。 */
export type CustomerListFilter = {
  // 每个字段都显式带上 `| undefined`：tsconfig 开了
  // `exactOptionalPropertyTypes`，不带的话「传一个可能为 undefined 的值」
  // 与「不传这个字段」在类型上不等价，调用方得先拼一个对象再展开才能通过。
  region?: string | undefined
  scope?: string | undefined
  stage?: string | undefined
  /** 只看待复核。`true` 时限定 `reviewStatus = pending`。 */
  pendingReview?: boolean | undefined
  q?: string | undefined
  limit?: number | undefined
}

/**
 * 列出的列。与 `notes.ts` 同理显式列出，理由不重复。
 *
 * 列表刻意不查 `legacyBlocks` 与订单明细：列表一屏二十行，把每个客户的 JSON 块
 * 都拖出来，单次响应会到几 MB，而界面上一个字都用不到。
 */
const LIST_SELECT = {
  id: true,
  displayName: true,
  shortName: true,
  region: true,
  regionScope: true,
  stage: true,
  stageSource: true,
  reviewStatus: true,
  confidence: true,
  msgRows: true,
  lastMessageAt: true,
  contractTotalFen: true,
  repeatOfId: true,
  _count: { select: { orders: true, repeats: true } },
} as const

const DETAIL_SELECT = {
  ...LIST_SELECT,
  realName: true,
  phone: true,
  primaryNickname: true,
  nameSource: true,
  groupFile: true,
  firstMessageAt: true,
  skipImg: true,
  skipVoice: true,
  orders: {
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      code: true,
      seq: true,
      isRepeat: true,
      stage: true,
      stageSource: true,
      contractFen: true,
      receivedFen: true,
      unpaidFen: true,
      amountSource: true,
      amountEvidenceDate: true,
      amountEvidenceNote: true,
      steps: {
        orderBy: { idx: 'asc' },
        select: {
          idx: true,
          name: true,
          reached: true,
          done: true,
          startedAt: true,
          finishedAt: true,
          dateImprecise: true,
          note: true,
        },
      },
    },
  },
} as const

/** `@db.Date` 列取出来是 Date，接口一律传 `YYYY-MM-DD` 字符串。 */
function toDateString(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10)
}

type ListRow = {
  id: string
  displayName: string
  shortName: string
  region: string
  regionScope: string
  stage: string
  stageSource: string
  reviewStatus: string
  confidence: string
  msgRows: number
  lastMessageAt: Date | null
  contractTotalFen: number | null
  repeatOfId: string | null
  _count: { orders: number; repeats: number }
}

function toListItem(row: ListRow, canReadFinance: boolean): CustomerListItemDto {
  return {
    id: row.id,
    displayName: row.displayName,
    shortName: row.shortName,
    region: row.region,
    // 库里存的是字符串（理由见 schema 注释：层级标准会变，region 不能变）。
    // 收窄成契约里的联合类型，越界值说明写入路径漏了校验，让它显式落成 domestic
    // 而不是把非法字符串透给前端。
    regionScope:
      row.regionScope === 'overseas' || row.regionScope === 'special-region'
        ? row.regionScope
        : 'domestic',
    stage: row.stage as CustomerStage,
    stageSource: row.stageSource,
    reviewStatus: row.reviewStatus,
    confidence: row.confidence,
    msgRows: row.msgRows,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    orderCount: row._count.orders,
    contractTotalFen: maskContractTotal(row.contractTotalFen, canReadFinance),
    // 复购有三种形态，三种都要算：
    //   1. 一个客户开了多单（`_count.orders > 1`）—— 最常见，看板上蔣文增一人三单；
    //   2. 复购时另建了群，于是多了第二个客户行，用 `repeatOfId` 指向首单；
    //   3. 首单那一行本身（有别的行指向我）。
    // 只看第 2、3 种会漏掉第 1 种 —— 而第 1 种恰恰是当前数据里的主流形态，
    // 漏掉的表现是「一人三单在列表上看不出是复购」，被当成三个客户。
    hasRepeat: row._count.orders > 1 || row.repeatOfId !== null || row._count.repeats > 0,
  }
}

function toOrder(
  row: {
    id: string
    code: string
    seq: number
    isRepeat: boolean
    stage: string
    stageSource: string
    contractFen: number | null
    receivedFen: number | null
    unpaidFen: number | null
    amountSource: string | null
    amountEvidenceDate: Date | null
    amountEvidenceNote: string | null
    steps: {
      idx: number
      name: string
      reached: boolean
      done: boolean
      startedAt: Date | null
      finishedAt: Date | null
      dateImprecise: boolean
      note: string | null
    }[]
  },
  canReadFinance: boolean,
): CustomerOrderDto {
  const amounts: CustomerAmounts = {
    contractFen: row.contractFen,
    receivedFen: row.receivedFen,
    unpaidFen: row.unpaidFen,
  }
  return {
    id: row.id,
    code: row.code,
    seq: row.seq,
    isRepeat: row.isRepeat,
    stage: row.stage as CustomerStage,
    stageSource: row.stageSource,
    amounts: maskOrderAmounts(amounts, canReadFinance),
    // 金额来源也一起裁掉。它本身不是金额，但「这单金额来自看板核对」与
    // 「来自模型抽取」这层信息只在能看到金额时才有意义 —— 看不到金额却看到
    // 「低置信度」的标注，只会让人以为界面坏了。
    amountSource: canReadFinance ? row.amountSource : null,
    amountEvidenceDate: canReadFinance ? toDateString(row.amountEvidenceDate) : null,
    amountEvidenceNote: canReadFinance ? row.amountEvidenceNote : null,
    steps: row.steps.map((step) => ({
      idx: step.idx,
      name: step.name,
      reached: step.reached,
      done: step.done,
      startedAt: toDateString(step.startedAt),
      finishedAt: toDateString(step.finishedAt),
      dateImprecise: step.dateImprecise,
      note: step.note,
    })),
  }
}

/**
 * 列表 + 汇总。
 *
 * **汇总不受筛选条件影响的部分要分开看**：`byStage` 与 `byScope` 都按**当前筛选**
 * 统计，因为综合看板的用途是「筛完地区后看这批人的阶段分布」。若按全库统计，筛选
 * 之后图表不变，用起来会以为筛选没生效。
 */
export async function listCustomers(
  filter: CustomerListFilter,
  canReadFinance: boolean,
): Promise<CustomerListResponse> {
  const where: Prisma.CustomerWhereInput = {}
  if (filter.region) where.region = filter.region
  if (filter.scope) where.regionScope = filter.scope
  if (filter.stage) where.stage = filter.stage
  if (filter.pendingReview) where.reviewStatus = 'pending'
  if (filter.q) {
    // 检索三项：显示名、短名、真名。用 `mode: 'insensitive'` 是因为英文昵称
    // 大小写不固定（JoJo / jojo 都有人写），而中文不受影响。
    where.OR = [
      { displayName: { contains: filter.q, mode: 'insensitive' } },
      { shortName: { contains: filter.q, mode: 'insensitive' } },
      { realName: { contains: filter.q, mode: 'insensitive' } },
    ]
  }

  const limit = Math.min(filter.limit ?? CUSTOMER_LIMITS.PAGE_MAX, CUSTOMER_LIMITS.PAGE_MAX)

  const [rows, total, stageGroups, scopeGroups] = await Promise.all([
    prisma.customer.findMany({
      where,
      select: LIST_SELECT,
      // 「最近有动静的排前面」。一直按 id 排会让列表看起来随机 ——
      // 而这张表的日常用途是找刚才聊过的那个人。
      orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
      take: limit,
    }),
    prisma.customer.count({ where }),
    prisma.customer.groupBy({ by: ['stage'], where, _count: { _all: true } }),
    prisma.customer.groupBy({ by: ['regionScope'], where, _count: { _all: true } }),
  ])

  const byScope = { 'special-region': 0, overseas: 0, domestic: 0 }
  for (const group of scopeGroups) {
    const key =
      group.regionScope === 'overseas' || group.regionScope === 'special-region'
        ? group.regionScope
        : 'domestic'
    byScope[key] += group._count._all
  }

  return {
    items: rows.map((row) => toListItem(row as ListRow, canReadFinance)),
    total,
    summary: {
      byScope,
      byStage: stageGroups
        .map((group) => ({ stage: group.stage as CustomerStage, count: group._count._all }))
        // 非法档位直接丢掉：它说明库里有一行来自旧契约，让它出现在图表里比丢掉更糟。
        .filter((bucket) => (CUSTOMER_STAGES as readonly string[]).includes(bucket.stage)),
    },
    financeReadable: canReadFinance,
  }
}

export async function getCustomer(
  id: string,
  canReadFinance: boolean,
): Promise<CustomerResult<CustomerDetailDto>> {
  const row = await prisma.customer.findUnique({ where: { id }, select: DETAIL_SELECT })
  if (row === null) return { ok: false, reason: 'not_found' }

  const base = toListItem(row as unknown as ListRow, canReadFinance)
  return {
    ok: true,
    data: {
      ...base,
      realName: row.realName,
      phone: row.phone,
      primaryNickname: row.primaryNickname,
      nameSource: row.nameSource,
      groupFile: row.groupFile,
      firstMessageAt: row.firstMessageAt?.toISOString() ?? null,
      skipImg: row.skipImg,
      skipVoice: row.skipVoice,
      repeatOfId: row.repeatOfId,
      orders: row.orders.map((order) => toOrder(order, canReadFinance)),
    },
  }
}

/**
 * 人工录入用的入参。
 *
 * 直接复用共享包的 `CreateCustomerRequest`，不在这里另写一份：导入脚本、路由 schema、
 * 前端表单三处的字段名必须一致，各自定义一遍的结果是「前端填得进去、后端 400」，
 * 而 400 的文案不会告诉你哪个字段名写错了。
 */
export type CreateCustomerInput = CreateCustomerRequest

/**
 * 一条客户记录「从哪来」。
 *
 * 人工录入与批量导入算出来的显示名、短名、地区层级必须完全一致（都是契约函数算的），
 * 但**来源类字段不能一致**：导入进来的是从聊天记录里抽的，51 条本来就该是「待复核」；
 * 人工录的是人签过字的，直接算确认。若让导入走 `createCustomer`，全库会变成
 * `reviewStatus: confirmed` + `confidence: high`，复核队列直接空掉 —— 而界面上
 * 看不出任何异常。
 */
export type CustomerOrigin = {
  nameSource: string
  confidence: string
  reviewStatus: string
  stageSource: string
}

/** 人工录入的来源标记。录进来这件事本身就是人签过字的动作。 */
const MANUAL_ORIGIN: CustomerOrigin = {
  nameSource: 'manual',
  confidence: 'high',
  reviewStatus: 'confirmed',
  stageSource: 'manual',
}

/**
 * 只有导入才会填的档案字段。
 *
 * 单独一组而不是塞进 `CreateCustomerRequest`：这些值前端填不了，也不该让前端能填
 * —— 「消息行数」与「被跳过的图片张数」是采集结果，不是人可以声明的属性。
 */
export type CustomerArchiveExtras = {
  msgRows?: number | undefined
  firstMessageAt?: Date | null | undefined
  lastMessageAt?: Date | null | undefined
  skipImg?: number | undefined
  skipVoice?: number | undefined
  groupFile?: string | null | undefined
  legacyBlocks?: Prisma.InputJsonValue | undefined
  repeatOfId?: string | null | undefined
}

function normalizeRegionOrNull(region: string): string | null {
  const trimmed = region.trim()
  if (trimmed === '') return null
  return normalizeRegion(trimmed)
}

/**
 * 把入参收敛成可以落库的三个字段，并给出拒绝理由。
 *
 * 单独抽出来是因为**干跑要能复用**：导入脚本的 `--dry-run` 需要回答「这 53 条会不会
 * 被拒」，而一个真的去写库的校验算不上校验。写成两套判断则必然分叉 —— 干跑说没问题、
 * 真跑报 `invalid_region`，那是最难解释的一类不一致。
 */
export function normalizeCustomerInput(
  input: CreateCustomerInput,
):
  | { ok: true; value: { realName: string; region: string; phone: string } }
  | { ok: false; reason: CustomerFailureReason } {
  const realName = input.realName.trim()
  if (realName === '' || realName.length > CUSTOMER_LIMITS.REAL_NAME_MAX) {
    return { ok: false, reason: 'invalid_name' }
  }
  const region = normalizeRegionOrNull(input.region)
  if (region === null || region.length > CUSTOMER_LIMITS.REGION_MAX) {
    return { ok: false, reason: 'invalid_region' }
  }
  const phone = input.phone?.trim() ?? ''
  if (phone.length > CUSTOMER_LIMITS.PHONE_MAX) return { ok: false, reason: 'invalid_phone' }
  if (input.stage !== undefined && !(CUSTOMER_STAGES as readonly string[]).includes(input.stage)) {
    return { ok: false, reason: 'invalid_stage' }
  }
  return { ok: true, value: { realName, region, phone } }
}

/**
 * 写入一条客户。人工录入与批量导入共用这一处校验与派生。
 *
 * 显示名与短名不接受调用方传入，一律由这里算：规则改了以后重算一遍即可，库里那两列
 * 始终是可再生字段。两个入口各写一遍校验的结果是「导入进来 80 字的真名」这类越界
 * 数据，而它只在列表里显示成挤成一行的文本，不会报错。
 */
export async function insertCustomer(
  input: CreateCustomerInput,
  origin: CustomerOrigin,
  extras: CustomerArchiveExtras = {},
): Promise<CustomerResult<CustomerDetailDto>> {
  const normalized = normalizeCustomerInput(input)
  if (!normalized.ok) return { ok: false, reason: normalized.reason }
  const { realName, region, phone } = normalized.value

  const chatroom = input.chatroom?.trim() ?? ''
  const finalChatroom = chatroom === '' ? `manual:${crypto.randomUUID()}` : chatroom

  const exists = await prisma.customer.findUnique({
    where: { chatroom: finalChatroom },
    select: { id: true },
  })
  if (exists !== null) return { ok: false, reason: 'duplicate_chatroom' }

  const project = input.project?.trim() ?? ''
  const created = await prisma.customer.create({
    data: {
      chatroom: finalChatroom,
      displayName: customerDisplayName(region, realName, project === '' ? undefined : project),
      shortName: customerShortName(realName, region),
      region,
      regionScope: regionScopeOf(region),
      realName,
      phone: phone === '' ? null : phone,
      primaryNickname: input.primaryNickname?.trim() || null,
      nameSource: origin.nameSource,
      confidence: origin.confidence,
      reviewStatus: origin.reviewStatus,
      stage: input.stage ?? 'consulting',
      stageSource: origin.stageSource,
      groupFile: extras.groupFile ?? null,
      msgRows: extras.msgRows ?? 0,
      firstMessageAt: extras.firstMessageAt ?? null,
      lastMessageAt: extras.lastMessageAt ?? null,
      skipImg: extras.skipImg ?? 0,
      skipVoice: extras.skipVoice ?? 0,
      /* 没有 `ai_schema` 原始块时写 `DbNull` 而不是 `null`：Prisma 的 JSON 列里
         「JSON null」与「SQL NULL」是两件事，用 `null` 会在库里存成 `"null"` 这个
         合法的 JSON 值，于是「这个客户没有原始块」变成「有一个值为 null 的块」。 */
      legacyBlocks: extras.legacyBlocks ?? Prisma.DbNull,
      repeatOfId: extras.repeatOfId ?? null,
    },
    select: { id: true },
  })

  return getCustomer(created.id, true)
}

export async function createCustomer(
  input: CreateCustomerInput,
): Promise<CustomerResult<CustomerDetailDto>> {
  return insertCustomer(input, MANUAL_ORIGIN)
}

export type UpdateCustomerInput = UpdateCustomerRequest

export async function updateCustomer(
  id: string,
  input: UpdateCustomerInput,
  canReadFinance: boolean,
): Promise<CustomerResult<CustomerDetailDto>> {
  const current = await prisma.customer.findUnique({
    where: { id },
    select: { id: true, realName: true, region: true },
  })
  if (current === null) return { ok: false, reason: 'not_found' }

  const data: Prisma.CustomerUpdateInput = {}

  if (input.realName !== undefined) {
    const realName = input.realName.trim()
    if (realName === '' || realName.length > CUSTOMER_LIMITS.REAL_NAME_MAX) {
      return { ok: false, reason: 'invalid_name' }
    }
    data.realName = realName
  }
  if (input.region !== undefined) {
    const region = normalizeRegionOrNull(input.region)
    if (region === null || region.length > CUSTOMER_LIMITS.REGION_MAX) {
      return { ok: false, reason: 'invalid_region' }
    }
    data.region = region
    data.regionScope = regionScopeOf(region)
  }
  if (input.phone !== undefined) {
    const phone = input.phone?.trim() ?? ''
    if (phone.length > CUSTOMER_LIMITS.PHONE_MAX) return { ok: false, reason: 'invalid_phone' }
    data.phone = phone === '' ? null : phone
  }
  if (input.primaryNickname !== undefined) {
    data.primaryNickname = input.primaryNickname?.trim() || null
  }
  if (input.reviewStatus !== undefined) data.reviewStatus = input.reviewStatus

  // 改名或改地区都要重算显示名与短名。**两列同时重算**：只改一个会让
  // 「显示名是地区+短名」这条不变式失效，而失效的表现是同一个客户在两个页面上
  // 名字不同 —— 这种偏差不会报错。
  const nextRegion = (data.region as string | undefined) ?? current.region
  const nextName = (data.realName as string | undefined) ?? current.realName ?? ''
  if (input.realName !== undefined || input.region !== undefined) {
    data.displayName = customerDisplayName(nextRegion, nextName)
    data.shortName = customerShortName(nextName, nextRegion)
  }

  if (Object.keys(data).length === 0) return getCustomer(id, canReadFinance)

  await prisma.customer.update({ where: { id }, data })
  return getCustomer(id, canReadFinance)
}

/** 合同额变化后重算客户级汇总。派生列，任何地方都不直接写。 */
async function recomputeContractTotal(customerId: string): Promise<void> {
  const aggregate = await prisma.customerOrder.aggregate({
    where: { customerId },
    _sum: { contractFen: true },
  })
  await prisma.customer.update({
    where: { id: customerId },
    data: { contractTotalFen: aggregate._sum.contractFen ?? null },
  })
}

export type CreateOrderInput = CreateCustomerOrderRequest

/**
 * 一个环节的历史明细。导入专用，人工录入时十四个环一律从「未到达」起步。
 *
 * 日期写成 `YYYY-MM-DD` 字符串而不是 `Date`：这份结构直接对应预览 JSON 里的形状，
 * 在调用边界转换一次比让日期对象穿过两层函数更容易看出哪一步在解析。
 */
export type OrderStepSeed = {
  idx: number
  reached: boolean
  done: boolean
  startedAt?: string | null | undefined
  finishedAt?: string | null | undefined
  dateImprecise?: boolean | undefined
  note?: string | null | undefined
}

/**
 * 导入时随订单一起落库的历史细节。
 *
 * 每一项都对应一个「自动生成的值是错的」的场景：编号要保留看板编号（`TW-01`）、
 * 序号要按原顺序、阶段是订单自己的而不是客户的当前阶段、金额来源要写清是看板
 * 证据还是净化后的 ai_schema。不给这些覆盖位，导入就只能先把订单建出来再逐条改，
 * 中间那一段是错的数据，且出错时找不到是哪一步写坏的。
 */
export type OrderImportDetail = {
  code?: string | undefined
  seq?: number | undefined
  stage?: string | undefined
  stageSource?: string | undefined
  amountSource?: string | undefined
  amountConfidence?: string | null | undefined
  amountEvidenceDate?: string | null | undefined
  amountEvidenceNote?: string | null | undefined
  steps?: readonly OrderStepSeed[] | undefined
}

/** 金额只认「非负整数分」。与客户入参同一个理由抽出来给干跑用。 */
export function normalizeOrderAmounts(
  input: CreateOrderInput,
): { ok: false; reason: CustomerFailureReason } | null {
  for (const value of [input.contractFen, input.receivedFen, input.unpaidFen]) {
    if (value === undefined || value === null) continue
    if (!Number.isInteger(value) || value < 0) return { ok: false, reason: 'invalid_amount' }
  }
  return null
}

/**
 * 新建订单，同时铺好十四个环节。
 *
 * **序号与编号在这里生成，不接受调用方指定。** 序号是「同一客户内的第几单」，
 * 由数据库的唯一约束 `(customerId, seq)` 兜底；编号全局唯一，取当前最大编号加一。
 * 让前端传这两个值，等于把「两个人同时新建订单」变成一个必然撞号的操作。
 * 唯一的例外是 `detail`（导入专用），它带的正是历史事实，不是并发写入的猜测。
 */
export async function createOrder(
  customerId: string,
  input: CreateOrderInput,
  canReadFinance: boolean,
  detail?: OrderImportDetail,
): Promise<CustomerResult<CustomerDetailDto>> {
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, stage: true, stageSource: true },
  })
  if (customer === null) return { ok: false, reason: 'not_found' }

  const amountInvalid = normalizeOrderAmounts(input)
  if (amountInvalid !== null) return amountInvalid

  const lastSeq = await prisma.customerOrder.aggregate({
    where: { customerId },
    _max: { seq: true },
  })
  const seq = detail?.seq ?? (lastSeq._max.seq ?? 0) + 1

  // 编号取全局最大。用 `ORD-` 前缀与看板编号（BT-01）分开，两者不会互相顶号。
  const lastCode = await prisma.customerOrder.findFirst({
    where: { code: { startsWith: CUSTOMER_LIMITS.ORDER_CODE_PREFIX } },
    orderBy: { code: 'desc' },
    select: { code: true },
  })
  const lastNumber =
    lastCode === null
      ? 0
      : Number.parseInt(lastCode.code.slice(CUSTOMER_LIMITS.ORDER_CODE_PREFIX.length), 10) || 0
  const code =
    detail?.code ?? `${CUSTOMER_LIMITS.ORDER_CODE_PREFIX}${String(lastNumber + 1).padStart(3, '0')}`

  /* 环节先按模板铺满十四行，再用导入明细覆盖给出的那几个。**顺序不能反**：
     模板是分母，缺哪个环意味着「这个环没走到」，而不是「这个环不存在」——
     后者会让进度条的分母变小，看上去反而更接近完成。 */
  const seeded = new Map((detail?.steps ?? []).map((step) => [step.idx, step]))
  const steps = buildInitialSteps().map((template) => {
    const seed = seeded.get(template.idx)
    if (seed === undefined) {
      return {
        idx: template.idx,
        name: template.name,
        reached: template.reached,
        done: template.done,
        dateImprecise: template.dateImprecise,
        note: template.note,
      }
    }
    const startedAt = parseDateValue(seed.startedAt)
    const finishedAt = parseDateValue(seed.finishedAt)
    return {
      idx: template.idx,
      name: template.name,
      /* `done` 连带 `reached`，与 `updateStep` 同一条依赖：历史数据里出现过
         「完成日期有、到达标记没有」的行，照抄会在界面上显示成「未到达但已完成」，
         那种行看起来像渲染 bug。 */
      reached: seed.reached || seed.done,
      done: seed.done,
      startedAt: startedAt === 'invalid' ? null : startedAt,
      finishedAt: finishedAt === 'invalid' ? null : finishedAt,
      dateImprecise: seed.dateImprecise ?? false,
      note: seed.note?.trim() || null,
    }
  })

  await prisma.customerOrder.create({
    data: {
      code,
      customerId,
      seq,
      isRepeat: seq > 1,
      // 新单继承客户当前阶段。理由：客户级阶段是「这个客户走到哪」，新开一单
      // 通常意味着继续推进，而不是退回咨询中。退回由阶段推进接口显式去做。
      stage: detail?.stage ?? customer.stage,
      stageSource: detail?.stageSource ?? 'manual',
      contractFen: input.contractFen ?? null,
      receivedFen: input.receivedFen ?? null,
      unpaidFen: input.unpaidFen ?? null,
      amountSource:
        detail?.amountSource ??
        (input.contractFen === undefined || input.contractFen === null ? 'none' : 'manual'),
      amountConfidence:
        detail?.amountConfidence ??
        (input.contractFen === undefined || input.contractFen === null ? null : 'high'),
      amountEvidenceDate: parseDateValue(detail?.amountEvidenceDate) ?? null,
      amountEvidenceNote: detail?.amountEvidenceNote?.trim() || null,
      steps: { create: steps },
    },
    select: { id: true },
  })

  await recomputeContractTotal(customerId)
  return getCustomer(customerId, canReadFinance)
}

export type UpdateStepInput = UpdateCustomerStepRequest

/** 解析 `YYYY-MM-DD`。不合法返回 `null`，由调用方决定这是「清空」还是「报错」。 */
function parseDateValue(value: string | null | undefined): Date | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return 'invalid'
  // 再比对一次字符串，挡住 `2026-02-31` 这种被 Date 静默滚到下个月的写法。
  if (parsed.toISOString().slice(0, 10) !== value) return 'invalid'
  return parsed
}

/**
 * 更新一个环节。
 *
 * **`done = true` 会连带把 `reached` 置为 true**，反过来不成立。已完成必然意味着
 * 到达过；而「到达未完成」是真实状态（看板里「预安装沟通，完成日期未提及」那一类），
 * 不能被自动补齐。这条依赖写在这里而不是交给前端维持 —— 前端忘了置 reached，
 * 界面上就会显示「未到达但已完成」，那种行看起来像渲染 bug，排查起来很费时。
 */
export async function updateStep(
  customerId: string,
  orderId: string,
  idx: number,
  input: UpdateStepInput,
  canReadFinance: boolean,
): Promise<CustomerResult<CustomerDetailDto>> {
  const order = await prisma.customerOrder.findUnique({
    where: { id: orderId },
    select: { customerId: true },
  })
  if (order === null || order.customerId !== customerId) return { ok: false, reason: 'not_found' }

  const step = await prisma.customerOrderStep.findUnique({
    where: { orderId_idx: { orderId, idx } },
    select: { id: true },
  })
  if (step === null) return { ok: false, reason: 'not_found' }

  const data: Prisma.CustomerOrderStepUpdateInput = {}
  if (input.reached !== undefined) data.reached = input.reached
  if (input.done !== undefined) {
    data.done = input.done
    if (input.done && input.reached === undefined) data.reached = true
  }
  if (input.dateImprecise !== undefined) data.dateImprecise = input.dateImprecise
  if (input.note !== undefined) data.note = input.note?.trim() || null

  for (const key of ['startedAt', 'finishedAt'] as const) {
    if (input[key] === undefined) continue
    const parsed = parseDateValue(input[key])
    if (parsed === 'invalid') return { ok: false, reason: 'invalid_stage' }
    data[key] = parsed
    // 填了日期就意味着到达过。这是同一件事的两种表达，不该要人填两遍。
    if (parsed !== null && input.reached === undefined) data.reached = true
  }

  if (Object.keys(data).length > 0) {
    await prisma.customerOrderStep.update({ where: { id: step.id }, data })
  }
  return getCustomer(customerId, canReadFinance)
}

export type SetStageInput = SetCustomerStageRequest

/**
 * 推进客户阶段。
 *
 * 回退（主线内倒退）**必须填原因**，否则 400。这条限制来自 `customer.ts` 里
 * `isStageRegression` 的设计意图：回退意味着之前记错了或客户反悔了，两种情况都
 * 需要一个可追溯的说法。跨到旁支（退款、流失）不算回退，它们是终止而非倒退。
 *
 * 订单级阶段跟着改：客户只有一个阶段，订单可以有好几张，但**只有最后一张**跟着动。
 * 前面那些单如果已经完结，改它们等于篡改历史。
 */
export async function setStage(
  customerId: string,
  input: SetStageInput,
  canReadFinance: boolean,
): Promise<CustomerResult<CustomerDetailDto>> {
  if (!(CUSTOMER_STAGES as readonly string[]).includes(input.stage)) {
    return { ok: false, reason: 'invalid_stage' }
  }
  const customer = await prisma.customer.findUnique({
    where: { id: customerId },
    select: { id: true, stage: true },
  })
  if (customer === null) return { ok: false, reason: 'not_found' }

  const from = customer.stage as CustomerStage
  if (isStageRegression(from, input.stage) && (input.reason ?? '').trim() === '') {
    return { ok: false, reason: 'missing_reason' }
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: { stage: input.stage, stageSource: 'manual' },
  })

  const latestOrder = await prisma.customerOrder.findFirst({
    where: { customerId },
    orderBy: { seq: 'desc' },
    select: { id: true },
  })
  if (latestOrder !== null) {
    await prisma.customerOrder.update({
      where: { id: latestOrder.id },
      data: { stage: input.stage, stageSource: 'manual' },
    })
  }

  return getCustomer(customerId, canReadFinance)
}
