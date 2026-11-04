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

/**
 * 内置来源。三份台账各自一种。
 *
 * **它不再是来源的全集** —— 维护台可以新增主类（见 `quote_sources` 表），新增出来
 * 的 code 形如 `c7k2m9`，不在这里。这个常量现在的用途只剩三个：
 * 「哪些是内置」「导入器按文件名猜来源时能猜哪几个」「没有主类表时的兜底顺序」。
 * 判断一个来源合不合法要查库，不能用 `includes`。
 */
export const QUOTE_SOURCES = ['sale', 'craft', 'hardware'] as const

/**
 * 来源标识。
 *
 * `string & {}` 是故意留的：纯 `string` 会丢掉内置三值的自动补全与拼写检查，纯联合
 * 又会把动态新增的主类判成类型错误。两者相交是 TypeScript 里唯一能同时做到的办法。
 */
export type QuoteSource = (typeof QUOTE_SOURCES)[number] | (string & {})

/**
 * 内置三类的显示名。
 *
 * **不要用它渲染自定义主类** —— 那边查不到会得到 `undefined`，界面上就是一块空白。
 * 任何要显示来源名的地方都用接口给的 `sourceName`（`QuoteItemDto.sourceName` /
 * `QuoteSourceDto.name`），那是唯一来源。
 */
export const QUOTE_SOURCE_NAMES: Record<(typeof QUOTE_SOURCES)[number], string> = {
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
export const QUOTE_SOURCE_SHORT: Record<(typeof QUOTE_SOURCES)[number], string> = {
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
  /**
   * 维护口令的长度下限。
   *
   * 原来是 8 位（「全公司价格的总开关，比账号密码更该长一点」）。2026-11-03 用户明确
   * 拍板「6 位以上就 OK」—— 这是店里几个人共用的一把操作口令，不是账号密码，太长会
   * 被写在便利贴上。放宽到 6 位不等于放弃护栏：真正的防线是连续错 5 次锁 15 分钟、
   * 以及改口令时版本 +1 让所有旧令牌当场失效。
   *
   * 这个值同时被三处读：服务端 schema（只用来给前端一个数）、`checkPasswordShape`
   * 的强制校验、以及 `access-state` 下发给界面做提示。改这里就全改了，别再写死数字。
   */
  PASSWORD_MIN: 6,
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
  /** 分类名长度上限。与 `quote_items.category` 的列宽一致。 */
  CATEGORY_NAME_MAX: 80,
  /** 主类显示名上限。与 `quote_sources.name` 的列宽一致。 */
  SOURCE_NAME_MAX: 40,
  /** 主类短名上限。首页卡底部那行只有几个字的位置。 */
  SOURCE_SHORT_MAX: 8,
  /** 一个主类下最多多少个分类。超了排序接口的 `maxItems` 也会拒。 */
  CATEGORY_COUNT_MAX: 300,
  /** 产品名长度上限。与 `quote_items.name` 的列宽一致。 */
  ITEM_NAME_MAX: 200,
  /**
   * 下面五个是新增产品表单里那几个可选字段的上限。
   *
   * **抽成常量是因为它们必须与 `routes/quote.ts` 的 `CREATE_ITEM_BODY_SCHEMA`
   * 同源。** 表单不设 `maxLength`、schema 却卡长度，表现是「填得好好的，
   * 点保存弹一条 400」；反过来表单卡得比 schema 严，则是「明明还能写更多，输入框
   * 却不吃字」。两种都不会报错，只能靠人发现自己少了几个字。
   */
  ITEM_MODEL_MAX: 120,
  ITEM_SPEC_MAX: 160,
  ITEM_UNIT_MAX: 24,
  ITEM_NOTE_MAX: 400,
  ITEM_PRICE_TEXT_MAX: 200,
  ITEM_PRICING_MODE_MAX: 40,
  ITEM_MATERIALS_MAX: 300,
  /**
   * 批量导入单份文件的上限。
   *
   * 从 8MB 提到 20MB（2026-11-03）。原来的判断是「台账 xlsx 约 300KB，8MB 足够」，
   * 那条判断没见过实物：五金那份《诺米拉篮价格表.xlsx》是 **12.25MB**（每一行都带
   * 产品图），从上线起就一直在门槛外 —— 而界面上给出的反馈是「服务器超时」，
   * 因为客户端把 12MB 编成 base64 之后仍然照传，传完才在服务端被拒。
   *
   * 20MB 是「覆盖真实台账 + 留一倍余量」：解析 12.25MB 的实测耗时是 135ms（见
   * docs/QUOTE-IMPORT-UPLOAD-2026-11-03.md），成本几乎全在传输入口，不在解析。
   */
  IMPORT_FILE_BYTES_MAX: 20 * 1024 * 1024,
  /**
   * 一次最多识别多少行。
   *
   * 上限的意义不是性能，而是**让人别把整本产品手册拖进来**：识别出来的行要人工
   * 逐条确认，两千行没人会看第二眼，确认就变成了走过场。
   */
  IMPORT_ROWS_MAX: 2000,
  /** 预览里回传多少行。超出部分只给计数 —— 一次回两千行的 JSON 有 400KB。 */
  IMPORT_PREVIEW_ROWS: 200,
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
  /**
   * 来源短名（「柜体 / 工艺 / 五金」）。
   *
   * 单独给一个字段而不是让前端查 `QUOTE_SOURCE_SHORT`：那张表只有内置三类，自建
   * 主类取出来是 `undefined`，渲染成一行末尾的空缺 —— 而结果浮层那行是「规格 ·
   * 出处」，缺了出处就分不清这条是三份台账里的哪一份。
   */
  sourceShort: string
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
  /**
   * 主类清单（code / 显示名 / 短名），按 `sort_order` 排好。
   *
   * 放进 meta 而不是让前端另发一次 `/api/quote/sources`：左栏一挂载就要这几个名字，
   * 多一个请求就多一次「名字还没到、先渲染成 code」的闪烁。这也是查价页能显示
   * 自建主类的唯一途径 —— 前端不能再查 `QUOTE_SOURCE_NAMES`，那张表只有内置三类。
   */
  sources: readonly { code: QuoteSource; name: string; short: string }[]
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

// ---------------------------------------------------------------------------
// 维护台：主类（数据来源）
// ---------------------------------------------------------------------------

/**
 * 一个主类在维护台里的样子。
 *
 * ## 为什么把 `deletable` 由服务端算好
 *
 * 「能不能删」不是前端能算的：它取决于这一类下还有多少条**含已下架**的条目，而
 * 维护台的产品列表默认只拉在售的。前端自己按 `itemCount === 0` 判，会出现「看着
 * 空的、点了删除却被拒」，或者更糟——放行了一个还有 200 条 archived 的主类。
 *
 * ## 为什么 `code` 与 `ledgerPrefix` 没有 editable 开关
 *
 * 它们根本不可改。`code` 是每一条产品业务键的第 0 段，改了等于把这一类下每一条的
 * 主键全换掉，历史报价、图片绑定、审计同时失联且不报错。编辑只开放 `name` / `short`。
 */
export type QuoteSourceDto = {
  code: string
  name: string
  /** 短名。「柜体 / 工艺 / 五金」，只用在空间不够的地方。 */
  short: string
  /** 条目号前缀，如 `A`。新建产品时按它续号。 */
  ledgerPrefix: string
  sortOrder: number
  builtin: boolean
  /** 在售条数。 */
  itemCount: number
  /** 已下架条数。删除判据要把它算进去 —— 下架不等于删掉。 */
  archivedCount: number
  /** 删得掉：条目为 0 且不是内置。直接用服务端给的，不要自己判。 */
  deletable: boolean
  /** 删不掉时给一句人话，说清是「还有 N 条」还是「内置主类」。 */
  deleteBlockedReason: string
}

export type QuoteSourceListResponse = {
  items: readonly QuoteSourceDto[]
}

/** 新建主类。`code` 由服务端生成，不接受客户端指定。 */
export type CreateQuoteSourceRequest = {
  name: string
  /** 留空则从名字里取前两个字，再不行用 `主类N`。 */
  short?: string
}

/** 编辑主类。只能改显示名与短名。 */
export type RenameQuoteSourceRequest = {
  code: string
  name: string
  short?: string
}

export type DeleteQuoteSourceRequest = {
  code: string
}

// ---------------------------------------------------------------------------
// 维护台：分类、产品、批量导入
// ---------------------------------------------------------------------------

/**
 * 一个分类在维护台里的样子。
 *
 * `count` 是**在售**条数（不含 archived）：维护台要回答的是「这个分类下现在还能
 * 卖出什么」，把已下架的算进去会让「合并前先看一眼有多少条」失去意义。
 */
export type QuoteCategoryDto = {
  source: QuoteSource
  name: string
  count: number
  sortOrder: number
  /** 是否已经在 `quote_categories` 里落了行。false 表示它是从条目里临时补出来的。 */
  persisted: boolean
}

export type QuoteCategoryListResponse = {
  version: string
  items: readonly QuoteCategoryDto[]
}

/** 改名。`from` 与 `to` 都必须在同一来源内。 */
export type RenameQuoteCategoryRequest = {
  source: QuoteSource
  from: string
  to: string
}

/**
 * 合并：把 `from` 下的所有条目改挂到 `to`，然后删掉 `from`。
 *
 * `to` 不存在时会被创建 —— 这正是「自定义分类 + 合并」的组合用法：先把要保留的
 * 名字建出来，再把别的分类并进去。
 */
export type MergeQuoteCategoryRequest = {
  source: QuoteSource
  from: string
  to: string
}

/**
 * 批量合并：把 `from` 里列出的**多个**分类一起并到 `to`。
 *
 * 与单条合并的区别只有一处，但是要紧的一处：**要么全成，要么一条不动**。分量调用
 * 单条合并时，第三个名字要是刚好被人删了，前两个已经合过去了 —— 界面刷新后看起来
 * 「合并了一部分」，而操作员只会以为自己点错了。
 *
 * `from` 少于 2 个不算合并（那是改名），服务端返回 `too_few`。
 */
export type MergeQuoteCategoriesRequest = {
  source: QuoteSource
  from: readonly string[]
  /** 目标名。可以是一个已有分类（并进去），也可以是一个全新的名字（并成一项）。 */
  to: string
}

export type MergeQuoteCategoriesResponse = {
  version: string
  to: string
  from: readonly string[]
  /** 一共挪了多少条产品。 */
  moved: number
}

/** 新建空分类。用于「先建分类，再往里传产品」。 */
export type CreateQuoteCategoryRequest = {
  source: QuoteSource
  name: string
}

/** 重排：给出该来源下分类名的完整顺序，按数组下标重写 sort_order。 */
export type ReorderQuoteCategoriesRequest = {
  source: QuoteSource
  order: readonly string[]
}

/**
 * 产品重排：给出**这一屏看到的那些条目键**的新顺序，按数组下标重写 `sort_order`。
 *
 * ## 为什么不是「完整顺序」
 *
 * 分类一次全发得起（一屏最多几十个），产品不行：五金 596 条、列表只显示前 200 条
 * （`PAGE_SIZE_MAX`）。把「完整顺序」当契约，前端就得先知道没显示的那 396 条 ——
 * 它不知道，除非再拉一次。
 *
 * 所以契约是「**这一段的新顺序**」：服务端把没提到的行按原有相对次序接在后面，然后
 * 整段重排。这样做才安全 —— 只给提到的行写下标 0..k-1 的话，没提到的那 396 行的
 * `sort_order` 还是 0，会跟第 0 名撞在一起，整张列表的顺序立刻散掉。
 *
 * ## 只在「没有搜索关键词」时允许拖
 *
 * 带着关键词拖动，命中的是**筛选后的一小撮**。把它们提到最前，等于把剩下的几百条
 * 的整体位置都改了，而这正是用户没打算动的东西。前端在这种情况下把拖拽关掉。
 */
export type ReorderQuoteItemsRequest = {
  source: QuoteSource
  order: readonly string[]
}

/** 主类重排：给出全部主类 code 的完整顺序（主类最多几十个，一次发完）。 */
export type ReorderQuoteSourcesRequest = {
  order: readonly string[]
}

/**
 * 新产品。`code` 由服务端按业务键算，**不接受客户端指定** —— 前端算一遍、服务端
 * 再算一遍，两边只要有一处折叠空白的规则不同，同一条产品就会有两个键。
 */
export type CreateQuoteItemRequest = {
  source: QuoteSource
  category: string
  name: string
  model?: string
  spec?: string
  pricingMode?: string
  materials?: string
  unit?: string
  unitRaw?: string
  /** 价格原文。服务端按 `parsePriceInput` 判形态，与在线改价、台账导入同一套。 */
  priceText?: string
  note?: string
  /**
   * 商品图。**可选，且推荐随这一个请求一起提交**，而不是先建条目再调
   * `POST /items/:code/image`。
   *
   * 理由是图键：`imageKey` 用的是条目自己的 `code`，而新产品的 `code` 由服务端按
   * 业务键算 —— 客户端拿不到，只能等第一次响应回来。分成两步就有中间态「产品建好
   * 了、图没上去」，操作员看到「已新增」，回到列表却是一张空图，而且这个状态不会
   * 报错、也不会自动重试。
   *
   * 带在同一个请求里，服务端就能把「写条目 + 写图字节 + 绑定」放进一个事务：要么
   * 两样都在，要么一行都没有，前端只需要区分成功 / 失败两种结果。
   */
  image?: UploadQuoteImageRequest
}

/**
 * 把同一个分类里的多条产品折叠成一条。
 *
 * ## 保留哪一条，是操作员选的，不是「第一条」
 *
 * 默认取第一条看着省事，但台账里同一个分类下的条往往只有一条带价格、一条带图。
 * 折叠时保留错的那条，结果是「价格没了、图也没了」，而列表上只剩一行，看不出少了
 * 什么。所以 `keep` 必须由人明确指定，且必须在 `codes` 里。
 *
 * ## 被折叠的行不删
 *
 * 转 `archived`，物理行留在库里。历史报价单上那条编号还指得到它，审计也能回答
 * 「这行为什么查不到了」。想恢复，用 `PUT /items/:code/status` 单独上架即可。
 */
export type MergeQuoteItemsRequest = {
  source: QuoteSource
  /** 必须与所有 `codes` 所属分类一致。跨分类合并本质是改分类，不是合并。 */
  category: string
  /** 参与折叠的条目键，至少 2 条。 */
  codes: readonly string[]
  /** 保留哪一条。必须出现在 `codes` 里。 */
  keep: string
}

export type MergeQuoteItemsResponse = {
  version: string
  /** 保留下来的条目键。 */
  kept: string
  /** 转成 archived 的条数。 */
  archived: number
  /** 从被折叠行里补到保留行上的东西，逐项给人看（`价格` / `商品图`）。 */
  inherited: readonly string[]
}

/**
 * 删掉一个分类。
 *
 * 与「合并」不同，这里**没有目标**：分类连同它在 `quote_categories` 里的那一行一起
 * 消失，它下面的产品不会被改挂到任何地方。所以服务端只在**这个分类下一条产品都没有**
 * （在售与已下架都算）时才允许删 —— 否则产品会挂在一个列表里查不到、筛选栏里也没有
 * 的分类名下，变成谁都看不见的孤儿。
 *
 * 用 `POST .../delete` 而不是 `DELETE`：后者带 body 会被部分代理丢掉。
 */
export type DeleteQuoteCategoryRequest = {
  source: QuoteSource
  name: string
}

export type DeleteQuoteCategoryResponse = {
  version: string
  name: string
}

/**
 * 删掉一条产品。**物理删除**，与「下架」是两件不同的事。
 *
 * - 下架（`status = archived`）：历史报价单上的条目号查得到、能单独上架回来。
 * - 删除（这里）：这一行从库里消失，条目号从此查不到任何东西。
 *
 * 所以删除前服务端会把整行快照写进审计（`field = 'deleted'`），事后还能回答
 * 「当时那条叫什么、多少钱、什么编号」。商品图只有在这一条**自己**持有图时才删
 * （`image_key === code`）—— 同族继承来的图键属于整个产品族，删了会把别的行的图
 * 一起弄没。
 */
export type DeleteQuoteItemRequest = {
  source: QuoteSource
  code: string
}

export type DeleteQuoteItemResponse = {
  version: string
  code: string
  name: string
  /** 删掉时是不是已下架状态。界面上要用它把提示写得准一点。 */
  wasArchived: boolean
  /** 顺带删掉的商品图张数（0 或 1）。 */
  imageRemoved: boolean
}

/** 批量导入里的一行。字段与 `CreateQuoteItemRequest` 对齐，少一个来源（整批一个来源）。 */
export type QuoteImportRow = {
  category: string
  name: string
  model: string
  spec: string
  unit: string
  priceText: string
  note: string
  pricingMode: string
  materials: string
  /** 台账行号。识别时给出行序，应用后写进 `ledger_no`。 */
  ledgerNo: string
}

export const QUOTE_IMPORT_FORMATS = ['xlsx', 'csv', 'pdf'] as const
export type QuoteImportFormat = (typeof QUOTE_IMPORT_FORMATS)[number]

/**
 * 识别结果的一行。
 *
 * `warnings` 是**逐行**的：整批一条警告会让人不知道该改哪一行。识别器把「价格为空」
 * 「名称像表头」这类问题挂在具体行上，操作员在确认表里能直接看到。
 */
export type QuoteImportPreviewRow = QuoteImportRow & {
  /** 1 基，指源文件里的行号。人工核对时按它回原表。 */
  sourceLine: number
  warnings: readonly string[]
}

export type QuoteImportPreviewResponse = {
  fileName: string
  format: QuoteImportFormat
  /** 识别到的总行数（可能大于 `rows.length`，见 `QUOTE_LIMITS.IMPORT_PREVIEW_ROWS`）。 */
  total: number
  rows: readonly QuoteImportPreviewRow[]
  /** 文件级提示：格式降级、列没认出来、PDF 抽出的文本可能串行等。 */
  warnings: readonly string[]
  /** 识别时猜到的来源。操作员可以在确认页改。 */
  suggestedSource: QuoteSource | null
  /** 识别时看到的表头，给确认页显示「认成了哪几列」。 */
  detectedColumns: readonly string[]
}

/**
 * 识别请求**没有请求体类型**。
 *
 * 2026-11-03 之前这里是 `{ fileName, data: base64 }`。它有两个问题：base64 让
 * 传输量多 40%，而这条链路唯一的慢变量就是传输；并且 JSON 字符串在中途不产生
 * 任何事件，界面上只能给一个转圈，给不出百分比。
 *
 * 现在请求体是文件的原始字节（`application/octet-stream`），文件名走
 * `x-quote-file-name` 头，响应类型仍是 `QuoteImportPreviewResponse`。
 */
export type QuoteImportApplyRequest = {
  fileName: string
  source: QuoteSource
  rows: readonly QuoteImportRow[]
}

export type QuoteImportApplyResponse = {
  version: string
  /** 新增 / 覆盖 / 归档（本次未出现但库里有、且来自同一份导入批次的行）。 */
  added: number
  changed: number
  unchanged: number
  total: number
}

/** 批量导入的准入与失败原因。路由按它映射状态码。 */
export type QuoteImportFailure =
  'empty_file' | 'too_large' | 'unsupported' | 'parse_failed' | 'no_rows'

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

/**
 * 从分类聚合结果里剔掉主类表不认得的来源。
 *
 * ## 为什么需要一个专门的函数
 *
 * 查价左栏的分类来自 `quote_items` 的 `groupBy(source, category)`，维护台顶部那排
 * 页签来自 `quote_sources`。这是两个真值，对不上时就会出现「分类出现在筛选栏、
 * 点进任何页签都找不到」的黑洞：分类照常显示、条目照常能搜到，但改名 / 合并 /
 * 删除三个入口全都够不到。2026-11-04 现场查出 41 条这种残留，源头是集成测试
 * 直接删主类行、没删条目。
 *
 * 数据库侧现在有外键兜底（`quote_items.source` → `quote_sources.code`），这个函数
 * 是第二道：读路径不该把「库里有不一致」直接渲染成界面上一个改不掉的入口。
 *
 * ## 主类表为空时原样返回
 *
 * 那个状态说明迁移还没跑、或主类表被清空。此时按「全部不认得」过滤会让整个筛选栏
 * 变成空的，比多列几个孤儿严重得多。宁可多显示，也不显示成空库。
 */
export function filterKnownCategorySources<T extends { source: string }>(
  rows: readonly T[],
  knownCodes: ReadonlySet<string>,
): readonly T[] {
  if (knownCodes.size === 0) return rows
  return rows.filter((row) => knownCodes.has(row.source))
}
