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

/** 一个环节的对外形状。 */
export type CustomerStepDto = {
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

export type CustomerListResponse = {
  items: CustomerListItemDto[]
  /** 命中筛选条件的总数，与 `items.length` 不同：列表分页时后者是当前页条数。 */
  total: number
  summary: {
    byScope: Record<RegionScope, number>
    byStage: CustomerStageBucket[]
  }
  /** 当前账号是否看得到金额。前端据此决定要不要渲染金额列，而不是靠值为 null 猜。 */
  financeReadable: boolean
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
