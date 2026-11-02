/**
 * 客户信息平台的接口契约。
 *
 * 与 `customer.ts` 的分工：那边是**领域规则**（有哪些状态、多少环节、显示名怎么拼），
 * 这边是**传输形状**（接口收发什么、金额被裁掉时长什么样）。放在同一层是因为
 * web 与 api 都要用它们，写两份的那天就会不一致。
 *
 * **金额裁剪为什么做成这里的纯函数。** 裁剪规则一旦写进路由处理器，验证方式就只剩
 * 「拿两个账号登录点一遍」，而这条规则一旦写错，后果是「所有人看不到金额」或者
 * 「所有人看得到金额」—— 前者在 KPI 正常时很难被注意到（运维看板首版就踩过：
 * 裁判断写在取数路径上，管理员也看不到金额，只测 KPI 的用例全绿）。做成纯函数，
 * 就能用反例测试钉住「该裁的裁、该留的留」。
 *
 * 注意裁剪的**位置**：必须在权限判断之后。传进来的是 `canReadFinance` 布尔值，
 * 由路由层用 `hasPermission` 算好 —— 这里不 import 权限模块，避免把「谁能看」
 * 与「怎么看」两件事搅在一起。
 */

import { ORDER_STAGE_DEFS, type CustomerStage, type RegionScope } from './customer.js'

/** 字段长度上限。路由的 JSON schema 与前端输入框共用，不在两边各写一个数字。 */
export const CUSTOMER_LIMITS = {
  NAME_MAX: 80,
  REGION_MAX: 40,
  PHONE_MAX: 30,
  NICKNAME_MAX: 80,
  REAL_NAME_MAX: 60,
  NOTE_MAX: 300,
  CODE_MAX: 20,
  /** 订单编号。人工录入用 `ORD-` 前缀，与看板编号（BT-01、TW-03）区分开。 */
  ORDER_CODE_PREFIX: 'ORD-',
  SEARCH_MAX: 60,
  PAGE_MAX: 200,
} as const

/** 金额三元组，单位一律为分。`null` 表示未录入，**不是** 0。 */
export type CustomerAmounts = {
  contractFen: number | null
  receivedFen: number | null
  unpaidFen: number | null
}

/** 一个环节的对外形状。 */ export type CustomerStepDto = {
  idx: number
  name: string
  reached: boolean
  done: boolean
  /** 日期一律按 `YYYY-MM-DD` 传字符串，不传 Date 对象 —— JSON 里没有 Date。 */
  startedAt: string | null
  finishedAt: string | null
  dateImprecise: boolean
  note: string | null
}

/** 一张订单的对外形状。`amounts` 为 `null` 表示当前账号看不到金额。 */
export type CustomerOrderDto = {
  id: string
  code: string
  seq: number
  isRepeat: boolean
  stage: CustomerStage
  stageSource: string
  amounts: CustomerAmounts | null
  amountSource: string | null
  amountEvidenceDate: string | null
  amountEvidenceNote: string | null
  steps: CustomerStepDto[]
}

/** 客户归属涉及的两个业务角色。取值同时用作 `customers.designer_id` / `sales_id` 列的语义。 */
export const CUSTOMER_ROLES = ['designer', 'sales'] as const
export type CustomerRole = (typeof CUSTOMER_ROLES)[number]

/**
 * 一位客户的双角色归属。
 *
 * **两个字段可以同时有值，也可以同时为空。** 「同时为空」即公共池：还没人认领，
 * 只有持 `customer.scope.read` 的账号看得到。这与「设计师与销售共同跟进同一位客户」
 * 是两种不同状态，不能合并成一个「负责人」字段 —— 合并之后就无法回答
 * 「这一单的销售是谁」，而这正是设计端要看的信息。
 *
 * `myRole` 由服务端算出：当前账号是以设计师还是销售的身份负责这位客户。
 * 前端要显示「我」这个标记时必须用它，不要拿当前账号 id 去和两个 id 比对 ——
 * 那会把归属规则复制到第二个地方，而两处不一致时的表现是标记不见了，不会报错。
 */
export type CustomerAssignmentDto = {
  designerId: string | null
  designerName: string | null
  salesId: string | null
  salesName: string | null
  /** `null` 表示当前账号不是这位客户的负责人（全局范围账号多数是这种）。 */
  myRole: CustomerRole | null
}

/** 列表行。刻意不含电话与聊天原文：列表只用来找人和看进度。 */
export type CustomerListItemDto = {
  id: string
  displayName: string
  shortName: string
  region: string
  regionScope: RegionScope
  stage: CustomerStage
  stageSource: string
  reviewStatus: string
  confidence: string
  msgRows: number
  lastMessageAt: string | null
  orderCount: number
  /** 客户级合同额汇总（各订单 contractFen 相加）。看不到金额时为 `null`。 */
  contractTotalFen: number | null
  /** 是否有复购。列表上要能把一人多单看出来，否则会以为是两个客户。 */
  hasRepeat: boolean
  /** 双角色归属。公共池为两项全 null。 */
  assignment: CustomerAssignmentDto
}

export type CustomerDetailDto = CustomerListItemDto & {
  realName: string | null
  phone: string | null
  primaryNickname: string | null
  nameSource: string | null
  groupFile: string | null
  firstMessageAt: string | null
  skipImg: number
  skipVoice: number
  repeatOfId: string | null
  orders: CustomerOrderDto[]
}

/** 阶段分布的一项。`count` 为 0 的档位不下发，由前端按 `CUSTOMER_STAGE_META` 补零。 */
export type CustomerStageBucket = { stage: CustomerStage; count: number }

/** 24 小时活跃度的一格。`hourStart` 是该小时的起点，ISO 时刻，时区由服务端本地时间决定。 */
export type CustomerActivityPoint = { hourStart: string; count: number }

/** 活跃度折线的格数：最近 24 小时，最后一格是正在进行中的那一小时。 */
export const CUSTOMER_ACTIVITY_HOURS = 24

/**
 * 最近 N 小时的对齐窗口。
 *
 * **末端对齐到整点，不对齐到「现在」。** 不对齐的话每一格都带着请求时刻的秒数，
 * 同一小时内刷新两次会得到两组起点不同的桶，图上那根折线看起来在左右抖动；
 * 对齐之后同一小时内无论刷新多少次，格子边界都一样。
 *
 * 返回半开区间 `[start, end)`，与列表的时间筛选同一套语义（`to` 不含）。
 */
export function activityWindow(
  now: Date,
  hours: number = CUSTOMER_ACTIVITY_HOURS,
): { start: Date; end: Date } {
  const hourMs = 60 * 60 * 1000
  const end = Math.floor(now.getTime() / hourMs) * hourMs + hourMs
  return { start: new Date(end - hours * hourMs), end: new Date(end) }
}

/**
 * 把一串「最近消息时间」按小时分桶。
 *
 * 数据源是 `Customer.lastMessageAt`，也就是每个客户最近一条消息的时刻。库里有这
 * 一列，没有逐条消息表（消息原文留在微信本地库，导入只落汇总），因此这里能回答的
 * 是「这一小时里有几位客户的最后一条消息落在这里」，回答不了「这一小时聊了多少句」。
 * 界面上的口径说明按前者写，不按后者写。
 *
 * 落在窗口外的时间直接丢弃，不并进首尾格：并进去会让边缘两格凭空变高，而看起来
 * 只是「那会儿特别热闹」。
 */
export function bucketHourlyActivity(
  times: readonly (string | null)[],
  now: Date,
  hours: number = CUSTOMER_ACTIVITY_HOURS,
): CustomerActivityPoint[] {
  const hourMs = 60 * 60 * 1000
  const { start, end } = activityWindow(now, hours)
  const startMs = start.getTime()
  const endMs = end.getTime()

  const buckets: CustomerActivityPoint[] = Array.from({ length: hours }, (_, index) => ({
    hourStart: new Date(startMs + index * hourMs).toISOString(),
    count: 0,
  }))

  for (const time of times) {
    if (time === null) continue
    const ms = new Date(time).getTime()
    if (Number.isNaN(ms) || ms < startMs || ms >= endMs) continue
    const index = Math.floor((ms - startMs) / hourMs)
    const bucket = buckets[index]
    if (bucket === undefined) continue
    bucket.count += 1
  }

  return buckets
}

/**
 * 综合看板需要的汇总。列表与图表共用这一份，两栏的筛选与口径因此不可能不一致。
 *
 * **金额三个字段同生同灭。** `amountByScope` 与 `amountTotalFen` 同时为 null 或同时
 * 有值：只裁一个会让「环形图空着但 KPI 有数字」这种自相矛盾的画面出现，而它不会报错。
 */
export type CustomerSummary = {
  byScope: Record<RegionScope, number>
  byStage: CustomerStageBucket[]
  /** 各地区层级的合同额合计（分）。`null` 表示当前账号看不到金额。 */
  amountByScope: Record<RegionScope, number> | null
  /** 合同额总计（分）。`null` 表示当前账号看不到金额。 */
  amountTotalFen: number | null
  kpi: {
    /** 进行中：未完结且未流失。 */
    inProgress: number
    /** 首次沟通时间落在当前时间筛选内的客户数。未限定时间时等于总数。 */
    newInWindow: number
  }
  /** 最近 24 小时按小时分桶的活跃客户数。窗口固定，不随时间筛选伸缩。 */
  activity: CustomerActivityPoint[]
}

export type CustomerListResponse = {
  items: CustomerListItemDto[]
  /** 命中筛选条件的总数，与 `items.length` 不同：列表分页时后者是当前页条数。 */
  total: number
  summary: CustomerSummary
  /**
   * 当前账号是否看得到金额。前端据此决定要不要渲染金额列，而不是靠值为 null 猜。
   *
   * 本期含义变了：它只表示「在可见行内金额有没有被打码」。行本身是否可见由
   * `scopeKind` 决定，两者是不同维度，都要下发给前端。
   */
  financeReadable: boolean
  /**
   * 当前账号的可见范围。`own` 时列表只含本人负责的客户，界面必须明说
   * 「当前显示你负责的 N 位客户」—— 列表被静默缩小后，用户的第一反应是数据丢了。
   */
  scopeKind: 'all' | 'own'
}

export type CustomerDetailResponse = { customer: CustomerDetailDto }

/**
 * 裁剪一张订单的金额。
 *
 * 看不到金额时**整个 `amounts` 置为 null**，而不是把三个字段各置 null：后者与
 * 「这单还没录金额」在形状上完全一样，前端无法区分「没权限」与「没数据」，
 * 于是会把「无权限」渲染成「未录入」，反过来也会把「未录入」当成 bug 去查权限。
 */
export function maskOrderAmounts<T extends CustomerAmounts>(
  amounts: T,
  canReadFinance: boolean,
): CustomerAmounts | null {
  if (!canReadFinance) return null
  return {
    contractFen: amounts.contractFen,
    receivedFen: amounts.receivedFen,
    unpaidFen: amounts.unpaidFen,
  }
}

/** 裁剪客户级汇总额。与订单同理，看不到就整体为 null。 */
export function maskContractTotal(total: number | null, canReadFinance: boolean): number | null {
  return canReadFinance ? total : null
}

// ---------------------------------------------------------------------------
// 请求体
// ---------------------------------------------------------------------------
// 放在共享包而不是各写一份：请求体的字段名与长度上限一旦在两边不同，表现是
// 「前端填得进去、后端 400」，而 400 的文案往往是「参数不合法」这种没法定位的话。
// 可选字段显式带 `| undefined`，因为两边都开了 exactOptionalPropertyTypes。

/**
 * 新建客户。
 *
 * 没有 `displayName` / `shortName`：这两列由契约函数从真名、地区、项目算出。
 * 前端能传它们，就等于允许两套派生规则并存。
 */
export type CreateCustomerRequest = {
  realName: string
  region: string
  phone?: string | undefined
  primaryNickname?: string | undefined
  /** 项目名，用于同一客户多项目时区分显示，例如「阿那亚三期」。 */
  project?: string | undefined
  /** 已有微信群时填 chatroom id；手工建的客户不填，服务端生成 `manual:` 占位。 */
  chatroom?: string | undefined
  stage?: CustomerStage | undefined
}

/** 修改客户。全部可选且至少一项，服务端用 `minProperties: 1` 保证。 */
export type UpdateCustomerRequest = {
  realName?: string | undefined
  region?: string | undefined
  phone?: string | undefined
  primaryNickname?: string | undefined
  project?: string | undefined
  reviewStatus?: 'pending' | 'confirmed' | 'rejected' | undefined
}

/**
 * 新建订单。
 *
 * 金额单位是分，且**必须是非负整数**。这条不是苛求精度，而是挡住「按元填了金额」
 * 这类最常见的错：168000 元填成 168000 分，汇总凭空少两个数量级，而界面上那个
 * 数字看起来完全正常。
 */
export type CreateCustomerOrderRequest = {
  contractFen?: number | undefined
  receivedFen?: number | undefined
  unpaidFen?: number | undefined
}

/** 更新一个环节。`done: true` 会连带把 `reached` 置真，反之不然。 */
export type UpdateCustomerStepRequest = {
  reached?: boolean | undefined
  done?: boolean | undefined
  startedAt?: string | null | undefined
  finishedAt?: string | null | undefined
  dateImprecise?: boolean | undefined
  note?: string | undefined
}

/** 推进阶段。回退（主线内倒退）必须带 `reason`，否则 400。 */
export type SetCustomerStageRequest = {
  stage: CustomerStage
  reason?: string | undefined
}

/**
 * 调整客户的负责设计师与销售。
 *
 * 两个字段都是可选的：只传一个就只改那一个，`null` 表示清空。
 * **不提供「清空两者回到公共池」的批量语义** —— 想退货回公共池必须显式传两个 null，
 * 而这是刻意的：只传 `designerId: null` 时若顺手把销售也清掉，等于一次操作动了两个人。
 */
export type AssignCustomerRequest = {
  designerId?: string | null | undefined
  salesId?: string | null | undefined
  /** 归属发生变化时必填。归属变更比阶段变更更需要说法。 */
  reason?: string | undefined
}

/** 公共池归类的判定依据。`weight` 为该条依据贡献的分值，界面按它降序展示。 */
export type PoolReason = {
  /** 稳定的机器码，例如 `keyword`、`stage`、`amount`、`no-history`。 */
  code: string
  /** 一句话结论，直接展示给复核人。 */
  label: string
  /** 证据明细，例如「量尺×12、图纸×5」。 */
  detail: string
  weight: number
}

/** 归类结果的复核状态。`pending` 之外的状态都算已签字，重跑不会覆盖。 */
export const POOL_SUGGESTION_STATUSES = ['pending', 'accepted', 'adjusted', 'rejected'] as const
export type PoolSuggestionStatus = (typeof POOL_SUGGESTION_STATUSES)[number]

/**
 * 一条归类结果。
 *
 * `confidence` 是 0–100 的整数，不是 0–1 的小数：它只用于「模糊时提示人工复核」，
 * 用百分比更直观，也避免浮点在 JSON 里出现 0.30000000000000004 这种值。
 */
export type PoolSuggestionDto = {
  id: string
  role: CustomerRole
  suggestedUserId: string | null
  suggestedUserName: string | null
  confidence: number
  salesScore: number
  designerScore: number
  reasons: PoolReason[]
  status: PoolSuggestionStatus
  engine: string
  reviewedByName: string | null
  reviewedAt: string | null
  reviewNote: string | null
  updatedAt: string
}

/** 公共池的一行：客户摘要 + 最近一次归类结果。 */
export type PoolCustomerDto = {
  id: string
  displayName: string
  region: string
  stage: CustomerStage
  msgRows: number
  lastMessageAt: string | null
  suggestion: PoolSuggestionDto | null
}

/**
 * 可被指派为负责人的账号。
 *
 * 单独一个接口而不是复用系统账号列表：系统账号列表要 `system.user.read`，
 * 而业务角色没有这个点。这里只返回「能当负责人」的两类账号与姓名，不含部门、
 * 状态、登录信息 —— 指派一个人不需要知道他什么时候登录过。
 */
export type AssignableUserDto = {
  id: string
  displayName: string
  role: CustomerRole
}

export type AssignableUsersResponse = { users: AssignableUserDto[] }

export type PoolListResponse = {
  items: PoolCustomerDto[]
  total: number
  /** 其中还没有复核的条数。界面用它决定「全部接受」按钮是否可点。 */
  pending: number
}

/** 触发一次归类分析。不传 `customerIds` 时分析整个公共池。 */
export type ClassifyPoolRequest = {
  customerIds?: string[] | undefined
  /** 已复核的条目是否也重算。默认 false，理由见 `customer_pool_suggestions` 表注释。 */
  force?: boolean | undefined
}

export type ClassifyPoolResponse = {
  analyzed: number
  skipped: number
  failed: number
  byRole: { designer: number; sales: number }
  /** 证据来源。`archive` 表示读到了群文件原文，`stored` 表示只用了库里的汇总字段。 */
  source: 'archive' | 'stored'
}

/**
 * 复核一条归类结果。
 *
 * `accepted` 直接按建议落归属；`adjusted` 用请求里的 `role` / `userId` 覆盖；
 * `rejected` 只标状态、不动归属。三种都以 `decision` 区分而不是拆成三个接口：
 * 复核页上这三个按钮是一次动作的三个出口，拆开会把「同一件事」的事务边界打散。
 */
export type ReviewPoolSuggestionRequest = {
  decision: 'accepted' | 'adjusted' | 'rejected'
  role?: CustomerRole | undefined
  userId?: string | null | undefined
  note?: string | undefined
}

/**
 * 新建订单时的十四个环节初始状态。
 *
 * 全部 `reached: false`、`done: false`：**不从阶段推断环节**。状态是纵向位置，
 * 环节是横向骨架，两者关系并不严格 —— 「已签合同」这一档里既有刚收定金的单，
 * 也有量完尺准备生产的单。按状态回填环节会把没发生的事写成发生过，而这类错误
 * 在界面上看起来完全正常。
 */
export function buildInitialSteps(): Omit<CustomerStepDto, 'startedAt' | 'finishedAt'>[] {
  // 从 ORDER_STAGE_DEFS 派生，不手写一份 14 条：两份定义迟早会不一致，而
  // 不一致的表现是「第 11 环叫补件生产」和「第 11 环叫补件」这种没人报的偏差。
  return ORDER_STAGE_DEFS.map((def) => ({
    idx: def.index,
    name: def.label,
    reached: false,
    done: false,
    dateImprecise: false,
    note: null,
  }))
}
