/**
 * 报价查价的跨进程契约。
 *
 * ## 为什么价格要用 `priceKind` 判别，而不是一个数字
 *
 * 三份台账里的「单价」这一列并不是同一种东西：销售查价是「668 元/㎡」，板式工艺
 * 有一整段是「按投影面积 1.5 倍」，五金有「120 元/米」。早年把这些一律当数字读，
 * 得到的结果是「1.5 倍」渲染成 `¥1.5` —— 界面上看不出任何异常，只有拿它算过一次
 * 报价的人才知道错了。所以价格拆成三样：**数值**（`priceFen` / 倍率）、**形态**
 * （`priceKind`）、**原文**（`priceText`）。展示永远按形态走，数值只参与计算。
 *
 * ## 为什么金额存「分」
 *
 * 浮点数存钱在累加时会出现 `0.1 + 0.2 = 0.30000000000000004` 这类结果，而报价单
 * 是要给人看的。台账里的价格最多两位小数，乘 100 存整数足以精确表达。倍率是唯一
 * 的例外（1.5 倍），它按「千分之一」存会失真，因此倍率单独走 `priceText`、
 * 不参与金额计算 —— 见 `parsePriceInput`。
 *
 * ## 这个文件不碰数据库
 *
 * 本包同时被 web 与 api 引用（见 index.ts 顶部）。DTO 里出现的都是原始类型，
 * Prisma 的模型类型留在 apps/api，一旦从这里导出，web 的构建就会被拖上数据库依赖。
 */

/** 价格形态。决定「这一格该怎么显示、能不能参与计算」。 */
export const QUOTE_PRICE_KINDS = ['amount', 'per_meter', 'multiplier', 'rule', 'empty'] as const
export type QuotePriceKind = (typeof QUOTE_PRICE_KINDS)[number]

/** 条目状态。台账里消失的项目转 `archived`，不物理删除（历史报价要能追溯）。 */
export const QUOTE_ITEM_STATUSES = ['active', 'archived'] as const
export type QuoteItemStatus = (typeof QUOTE_ITEM_STATUSES)[number]

/** 数据来源。三份台账各自一种，界面上按来源分栏。 */
export const QUOTE_SOURCES = ['sale', 'craft', 'hardware'] as const
export type QuoteSource = (typeof QUOTE_SOURCES)[number]

export const QUOTE_SOURCE_NAMES: Record<QuoteSource, string> = {
  sale: '销售查价系统',
  craft: '板式工艺收费',
  hardware: '诺米/百隆五金',
}

/**
 * 来源的短名。**只在空间不够的地方用**：首页卡底部那行「1225 条 · 柜体 · 工艺 · 五金」
 * 与结果浮层每行末尾的出处。全名在那里会把 560px 的浮层挤成两行。
 *
 * 短名与全名的关系是「这一类是什么」对「这张表叫什么」，不是缩写 —— 所以
 * `hardware` 是「五金」而不是「诺米」：五金里同时有诺米和百隆两家。
 */
export const QUOTE_SOURCE_SHORT: Record<QuoteSource, string> = {
  sale: '柜体',
  craft: '工艺',
  hardware: '五金',
}

/** 图片绑定方式。`exact` 是这一行自己的图，`family` 是同一产品族继承来的。 */
export const QUOTE_BIND_TYPES = ['exact', 'family', 'manual'] as const
export type QuoteBindType = (typeof QUOTE_BIND_TYPES)[number]

export const QUOTE_LIMITS = {
  /** 搜索词长度上限。再长就不是「查价」而是「读表」。 */
  QUERY_MAX: 60,
  /**
   * 一页最多返回多少条。
   *
   * 200 是照静态稿的 `LIMIT`：1225 条全量下发会让首屏多下 180KB，且搜「板」能命中
   * 几百条；200 条大约覆盖「搜一个常用词」的全部结果，再多就该让人把词打准一点。
   */
  PAGE_SIZE_MAX: 200,
  PAGE_SIZE_DEFAULT: 30,
  /** 改价理由。留空允许，但写明更好 —— 审计里只有这一栏能解释「为什么改」。 */
  REASON_MAX: 200,
  /** 维护口令。下限 8 位：这是全公司价格的总开关，比账号密码更该长一点。 */
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 64,
  /** 一次解锁的有效期。 */
  UNLOCK_MINUTES: 30,
  /** 连续输错几次进入锁定。 */
  UNLOCK_FAIL_LIMIT: 5,
  /** 锁定多久。 */
  UNLOCK_LOCK_MINUTES: 15,
  /** 单张图字节上限。与案例库的 6MB 一致，取图时也用它做 content-length 校验。 */
  IMAGE_BYTES_MAX: 6 * 1024 * 1024,
  /** 图片长边上限。超了前端先压，服务端只做范围校验、不重新编码。 */
  IMAGE_EDGE_MAX: 2400,
  /** 缩略图宽。表格行高 56，2 倍屏下 320 足够。 */
  THUMB_WIDTH: 320,
} as const

/**
 * 一条报价。
 *
 * `code` 是**业务键**，不是自增号：它由「来源 + 分类 + 名称 + 型号 + 规格」算出，
 * 导入器按它做幂等 upsert。用它而不是 uuid 当对外 id，是因为审计、图片绑定、
 * 在线改价三处都要跨导入批次引用同一行 —— 而重新导入一次，uuid 会全变。
 */
export type QuoteItemDto = {
  code: string
  source: QuoteSource
  sourceName: string
  category: string
  name: string
  /** 型号。柜体类 571 条没有型号，这里是空串而不是 null。 */
  model: string
  spec: string
  /**
   * 条目号：台账里的「第几行」，形如 `A001`（销售）/ `B001`（工艺）/ `C001`（五金）。
   *
   * 它只用来跟纸质台账对号，不参与查表 —— 真正的键是 `code`。前端**必须**用它而
   * 不是列表下标：一筛选，下标全变。
   */
  ledgerNo: string
  /**
   * 计价方式（`投影面积` / `拉手` / `石材` …）。只有销售那 571 条有，其余空串。
   *
   * **不是备注。** 它决定「单价乘以什么」，详情页单独成行、报价文本里也在括号中
   * 带上；早期导入把它拼进了 note 前缀，界面上的这一栏因此是空的。
   */
  pricingMode: string
  /** 可选花色。只有 15 条木皮类有值，最长 96 字。空串表示这款没有可选花色。 */
  materials: string
  /** 归一后的单位（`㎡` / `米` / `个` …）。 */
  unit: string
  /** 台账原文单位。归一只是为了让同一件事能排在一起，展示仍以原文为准。 */
  unitRaw: string
  priceKind: QuotePriceKind
  /** 金额（分）。`rule` / `empty` 为 null —— 那是「不是金额」，不是「零元」。 */
  priceFen: number | null
  /** 原文。倍率与规则文本只在这里，数值那份不参与金额计算。 */
  priceText: string
  note: string
  status: QuoteItemStatus
  /** 是否绑了图。列表里据此决定画不画缩略图位，避免每条都发一次 404。 */
  hasImage: boolean
  /** 图的业务键。**与条目 code 不一定相同**：族继承的图和族首行共用一个键。 */
  imageKey: string | null
  /** 图的版本（上传时间毫秒的 36 进制）。只用于缓存键，不参与语义判断。 */
  imageVersion: string | null
  /** 最近一次改价时间。没改过就是导入时间。 */
  updatedAt: string
}

export type QuoteImageDto = {
  key: string
  mime: string
  width: number
  height: number
  bindType: QuoteBindType
  byteSize: number
  /** 台账行号。进口商写入，用来回答「这张图当初是从哪一行绑来的」。 */
  sourceRow: number | null
  uploadedAt: string
}

/** 数据集版本。改价、导入都会让它变，前端据此判断手里的价格是否还成立。 */
export type QuoteDatasetDto = {
  version: string
  itemCount: number
  imageCount: number
  importedAt: string
}

export type QuoteMetaResponse = QuoteDatasetDto & {
  /** 分类清单带条数，供筛选下拉。按来源分组，前端不再自己算。 */
  categories: readonly { source: QuoteSource; name: string; count: number }[]
  /** 是否已经设过维护口令。没设过时 owner 要先进「设置口令」。 */
  hasSecret: boolean
}

export type QuoteSearchResponse = {
  /** 本次结果对应的数据集版本。与前端手里的不一致时，前端要丢掉这次结果重查。 */
  version: string
  /** 命中总数（不受分页限制）。 */
  total: number
  items: readonly QuoteItemDto[]
}

export type QuoteItemResponse = {
  version: string
  item: QuoteItemDto
  image: QuoteImageDto | null
}

/**
 * 台账现状统计。价格维护面板第 4 节那排数字用它。
 *
 * **从库里实时算，不从导入时的快照读。** 导入器确实会在 `counts` 里写一份，但人工
 * 换图、手工上传、停用都会让那份快照过期 —— 而这一排数字存在的意义正是回答「现在
 * 图绑得怎么样」。给一个导入当天的旧值，比不给更糟。
 */
export type QuoteLedgerStatsDto = {
  /** 精确绑定：这一行在台账里有自己的图。 */
  exact: number
  /** 同产品继承：同名块首行有图，本行继承它的图。 */
  family: number
  /** 手工上传：界面上传、台账里没有的。 */
  manual: number
  /** 五金里没有图的条数。只统计 hardware —— 销售与工艺本来就不配图。 */
  noImage: number
  /** 图文件数（活跃行按 imageKey 去重）。 */
  imageFiles: number
  /** 图文件里没有任何条目引用的。 */
  unbound: number
}

/** 一条改价 / 停用 / 换图记录。追加写，不可改不可删。 */
export type QuoteRevisionDto = {
  id: string
  itemCode: string
  /** 条目名，按 `itemCode` join 出来。条目已归档时是空串。 */
  itemName: string
  /** 变更的字段。 */
  field: 'price' | 'status' | 'image' | string
  oldValue: string
  newValue: string
  /** 操作人显示名。账号已删时为 `未知`。 */
  operatorName: string
  reason: string
  createdAt: string
}

export type QuoteRevisionListResponse = {
  items: readonly QuoteRevisionDto[]
}

/**
 * 维护准入状态。
 *
 * `direct` 表示「不用口令」—— 只有 owner 为真，判据是**角色**而不是权限点
 * （理由见 `apps/api/src/quote/access.ts` 顶部：管理员的 `personal.*` 通配会把
 * 一个 write 点静默地一并授予，那条路径不报错、日志干净、界面上看不出来）。
 */
export type QuoteAccessStateResponse = {
  role: string
  direct: boolean
  hasSecret: boolean
  /** 当前解锁会话的到期时间。没解锁是 null。 */
  unlockedUntil: string | null
  /** 处于锁定态时，什么时候能再试。 */
  lockedUntil: string | null
  failCount: number
  failLimit: number
  /** 口令允许的最短长度，前端据此给提示，不在界面里写死 8。 */
  passwordMin: number
}

export type QuoteUnlockRequest = { password: string }

export type QuoteUnlockResponse = {
  /** 明文令牌只在这一次响应里出现，服务端只存哈希。 */
  unlockToken: string
  expiresAt: string
}

export type SetQuoteSecretRequest = { password: string }

/** 在线改价。三个字段都可选，但至少要有一个 —— 服务端会校验。 */
export type UpdateQuoteItemRequest = {
  priceFen?: number | null
  priceText?: string
  reason?: string
}

export type SetQuoteItemStatusRequest = {
  status: QuoteItemStatus
  reason?: string
}

/**
 * 上传 / 替换商品图。字节走 base64，与案例库上传同一条链路（不引 multipart）。
 *
 * **形状与 `CreateCaseUploadItem` 逐字相同**：同一个前端压缩器（`lib/case-upload.ts`
 * 的 `prepareUpload`）产出的就是这四个字段。多一个 `mime` 只会给「客户端声明一个
 * 与字节不符的类型」开一道门 —— 真正的类型由服务端读魔数判断，不信声明的那个。
 * 缩略图尺寸同理，服务端按 320 长边自己算，少一个可以填错的地方。
 */
export type UploadQuoteImageRequest = {
  /** 纯 base64，不带 `data:image/...;base64,` 前缀。 */
  data: string
  thumb: string
  width: number
  height: number
}

export type QuoteImageMutationResponse = {
  version: string
  image: QuoteImageDto
}

/**
 * 把台账里的「单价」原文解析成三件套。
 *
 * **导入器与在线改价共用这一份。** 两处各写一份的话，同一条数据经 Excel 进来是
 * 「倍率」、经界面手改一遍变成「规则文本」，而界面上看起来只是格式变了。
 *
 * 判定顺序是有讲究的：
 *   1. 空 → `empty`。**不能当成 0**，4 条房门工艺整段空价，显示成 ¥0 会让销售
 *      直接按「免费」报价。
 *   2. 含「倍」或 `×` → `multiplier`。必须在纯数字判断之前，否则「1.5倍」里的
 *      1.5 会被取出来当金额。
 *   3. 含「/米」「每米」「元/米」→ `per_meter`。同样能在纯数字判断里被误伤。
 *   4. 整串就是一个数（允许 ¥ / 元 / 圆 前后缀与千分位逗号）→ `amount`。
 *   5. 其余 → `rule`，原文进 `priceText`，数值留空。
 */
export function parsePriceInput(raw: string): {
  kind: QuotePriceKind
  priceFen: number | null
  priceText: string
} {
  const text = raw.trim()
  if (text === '') return { kind: 'empty', priceFen: null, priceText: '' }

  if (/[倍×]/.test(text)) {
    return { kind: 'multiplier', priceFen: null, priceText: text }
  }
  if (/(\/\s*米|每\s*米|米\s*\/)/.test(text)) {
    // 「120 元/米」这类带数值的按米价，数值取出来；「按米计价」这类纯文本归 rule。
    const value = extractNumber(text)
    return value === null
      ? { kind: 'rule', priceFen: null, priceText: text }
      : { kind: 'per_meter', priceFen: toFen(value), priceText: text }
  }

  // 纯数值：去掉 ¥ / 元 / 圆、千分位逗号与空白后，整串必须还是一个数。
  const bare = text.replace(/[¥￥,，\s]/g, '').replace(/[元圆]$/, '')
  if (/^\d+(\.\d{1,2})?$/.test(bare)) {
    return { kind: 'amount', priceFen: toFen(Number(bare)), priceText: text }
  }

  return { kind: 'rule', priceFen: null, priceText: text }
}

/** 从任意文本里取第一个数。取不到返回 null。 */
function extractNumber(text: string): number | null {
  const match = /(\d+(?:\.\d+)?)/.exec(text.replace(/[¥￥,，\s]/g, ''))
  if (match === null) return null
  const value = Number(match[1])
  return Number.isFinite(value) ? value : null
}

/**
 * 元 → 分。
 *
 * 用 `Math.round` 而不是 `Math.floor`：`19.99 * 100` 在浮点里是 1998.9999…，
 * 截断会少一分钱，而少的那一分钱会被财务在月末对账时找出来。
 */
function toFen(yuan: number): number {
  return Math.round(yuan * 100)
}
