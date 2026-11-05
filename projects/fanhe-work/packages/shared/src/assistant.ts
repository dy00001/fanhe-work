/**
 * AI 助手（内嵌 EvoFlow）的身份桥契约。
 *
 * 为什么需要单独一份令牌：EvoFlow 是一个独立进程，它不知道梵禾的登录态。它自己那套
 * 账号体系已被关闭（界面上也隐藏了），但它的鉴权中间件仍然认 JWT —— 只要请求里带一个
 * 用**共享密钥**签出的令牌，它就把「这个人是谁」挂到请求上下文上，会话、技能、知识库
 * 随之按人隔离。
 *
 * 因此这里的令牌**只承载身份，不承载权限**。梵禾的 24 个权限点、四种角色在这条链路上
 * 不生效：能进梵禾的人，在助手里的能力是一样的。要按角色限制助手能力，得在 EvoFlow
 * 内部另做，那是另一件事。
 */
export type AssistantTokenResponse = {
  /** 交给 EvoFlow 前端的 JWT。由梵禾 api 用共享密钥签出，网关只验签、不查库。 */
  token: string

  /**
   * 令牌到期时刻（epoch 毫秒）。
   *
   * 前端在每次进入助手页面时都会重新取一个，这个值目前只用于日志与排障。**不要**把它
   * 存下来做「快过期才续」—— 令牌过期不会让界面报错，只会让网关静默退回共享身份，
   * 表现是「忽然能看到别人的对话」，比报错更难发现。
   */
  expiresAt: number
}

// ---------------------------------------------------------------------------
// 数据桥：助手读梵禾三个业务模块的只读摘要
// ---------------------------------------------------------------------------
//
// **为什么是「梵禾取数再交给模型」，而不是让 AI 直接连数据库或走 MCP。**
//
// EvoFlow 支持 MCP，但 MCP 服务是**进程级单例**：一份配置、一个连接，全公司共用。
// 它的调用里没有「这一轮对话属于哪个梵禾账号」这个信息，因此按账号权限裁剪无从谈起 ——
// 接上去的结果是所有人都能拿到全部数据，而且没有任何报错。
//
// 所以取数发生在梵禾 api：那里拿得到登录态、角色和 24 个权限点，行级范围（客户只看
// 自己名下）与字段级裁剪（金额要不要给）都是现成的。模型只接收**已经裁剪过**的摘要，
// 它看不到、也推不出被裁掉的字段。
//
// **字段白名单是硬约束。** 下面每个类型里出现的字段就是 AI 能看到的全部；手机号、
// 真实姓名、聊天原文、报价单价与清单明细**根本不进这个结构**。不传就不可能泄漏，
// 这比「传了之后靠提示词约束模型别说」可靠一个量级。

/** 可纳入汇报的三个模块。 */
export const ASSISTANT_DATA_MODULES = ['ops', 'customer', 'quote'] as const
export type AssistantDataModule = (typeof ASSISTANT_DATA_MODULES)[number]

/**
 * 单个模块的取数结果。
 *
 * 三态而不是「有数据 / 没数据」两态：模块没数据（`empty`）和模块取不到（`unavailable`）
 * 在汇报里必须分开写。合成一种，读者会把「今天没成交」读成「系统坏了」，或者反过来。
 */
export type AssistantModuleStatus = 'ok' | 'empty' | 'unavailable'

/** 取不到的原因码。前端与提示词各自映射成不同文案，不共用一句话。 */
export type AssistantModuleReason =
  /** 当前账号没有这个模块的读权限点。 */
  | 'no_permission'
  /** 取数过程抛错（数据库、下游异常）。 */
  | 'fetch_failed'
  /** 模块存在但库里一行数据都没有（例如还没采集过、还没有客户）。 */
  | 'no_data'

export type AssistantModuleBlock<T> = {
  status: AssistantModuleStatus
  reason: AssistantModuleReason | null
  data: T | null
}

/** 运营快照。金额字段受 `ops.finance.read` 控制，无权时整体为 `null` 且 `masked` 为真。 */
export type AssistantOpsSnapshot = {
  range: { from: string; to: string }
  days: number
  shops: Array<{
    code: string
    name: string
    hasData: boolean
    coveredDays: number
    payAmountFen: number | null
    payBuyers: number | null
    visitors: number | null
    payRate: number | null
    /** 该店金额是否被权限裁掉。汇总时要能说清「合计为什么是 null」。 */
    masked: boolean
  }>
  /** 有金额权限时的全店合计；任一店被打码则为 `null`。 */
  totalPayAmountFen: number | null
  totalPayBuyers: number | null
  /**
   * 采集状态。
   *
   * `emptyShops` 是「区间内一天数都没有」的店铺，不是「采集器挂了」—— 两者要分开说，
   * 否则汇报会把「新店还没接入」写成「数据采集故障」。
   * `online` 表示采集器心跳是否在窗口内。
   */
  collect: {
    online: boolean
    lastSeenAt: string | null
    emptyShops: string[]
  } | null
}

/** 客户快照。不含姓名之外的任何联系方式，也不含聊天内容。 */
export type AssistantCustomerSnapshot = {
  /** 命中当前可见范围的客户总数。 */
  total: number
  /**
   * 可见范围。`own` 表示只统计本人负责的客户 —— 汇报里必须写明，
   * 否则数字比同事小会被读成「客户少了」。
   */
  scopeKind: 'all' | 'own'
  /** 是否有金额权限。false 时下面两个金额字段恒为 null。 */
  financeReadable: boolean
  byStage: Array<{ stage: string; count: number }>
  byRegion: Array<{ region: string; count: number }>
  amountTotalFen: number | null
  inProgress: number
  /** 时间窗内首次沟通的客户数。 */
  newInWindow: number
  /** 待复核的公共池建议条数；无 `customer.scope.read` 时为 null（看不到池子）。 */
  pendingReview: number | null
}

/**
 * 报价台账快照。
 *
 * **只给规模与缺口，不给任何单价。** 报价模块的改价权限是「角色 + 口令」两段式，
 * 不进权限点体系；把单价塞进汇报等于绕开那层口令，是明确的越权。
 */
export type AssistantQuoteSnapshot = {
  /** 精确绑定（这一行在台账里有自己的图）的条目数。 */
  exact: number
  /** 同产品继承图的行数。 */
  family: number
  /** 手工上传、台账里没有的行数。 */
  manual: number
  /** 五金里没有图的条数。 */
  noImage: number
  imageFiles: number
  /** 图文件里没有任何条目引用的数量 —— 清理台账时的第一优先项。 */
  unbound: number
  categories: number
  sources: number
  /** 近 7 天的变更条数（改价 / 停用 / 换图），只给数量与动作分布，不给具体价格。 */
  recentRevisions: number
  revisionActions: Array<{ action: string; count: number }>
}

export type AssistantBrief = {
  generatedAt: string
  range: { from: string; to: string }
  /** 当前账号的角色与可见范围，汇报开头要复述，读者才知道数字的边界。 */
  viewer: {
    roleCode: string
    roleName: string
    /** 三模块里实际取到数与取不到的清单，用于「本次汇报覆盖了什么」。 */
    scopeNote: string
  }
  ops: AssistantModuleBlock<AssistantOpsSnapshot>
  customer: AssistantModuleBlock<AssistantCustomerSnapshot>
  quote: AssistantModuleBlock<AssistantQuoteSnapshot>
}

export type AssistantBriefResponse = {
  brief: AssistantBrief
}

export type AssistantReportRequest = {
  /** 回看天数，1 至 90。 */
  days: number
  /** 要纳入的模块；省略时取全部三项。 */
  modules?: AssistantDataModule[]
}

export type AssistantReportResponse = {
  brief: AssistantBrief
  /** 模型生成的汇报正文（markdown）。模型失败时这里是空串，用 `fallbackMarkdown`。 */
  markdown: string
  /** 纯数据版汇报。模型不可用时前端改渲染它，保证「生成失败也有东西看」。 */
  fallbackMarkdown: string
  /** `model` 表示正文由模型生成；`fallback` 表示走了纯数据兜底。 */
  source: 'model' | 'fallback'
  /** `fallback` 时的原因；正常情况下为 null。 */
  reason: AssistantReportFailureReason | null
  model: string | null
}

export type AssistantReportFailureReason =
  /** 未配置模型端点，没法生成叙述。 */
  | 'model_not_configured'
  /** 模型超时。 */
  | 'model_timeout'
  /** 模型返回非 2xx 或响应体不合预期。 */
  | 'model_failed'
  /** 三个模块全部取不到数，没有可汇报的内容。 */
  | 'no_data'
