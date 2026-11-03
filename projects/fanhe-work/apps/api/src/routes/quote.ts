import {
  PERMISSIONS,
  QUOTE_LIMITS,
  QUOTE_ITEM_STATUSES,
  type CreateQuoteCategoryRequest,
  type CreateQuoteItemRequest,
  type CreateQuoteSourceRequest,
  type DeleteQuoteCategoryRequest,
  type DeleteQuoteItemRequest,
  type DeleteQuoteSourceRequest,
  type MergeQuoteCategoriesRequest,
  type MergeQuoteCategoryRequest,
  type MergeQuoteItemsRequest,
  type QuoteImportApplyRequest,
  type QuoteImportFailure,
  type QuoteImportPreviewRequest,
  type QuoteItemStatus,
  type QuoteSource,
  type RenameQuoteCategoryRequest,
  type RenameQuoteSourceRequest,
  type ReorderQuoteCategoriesRequest,
  type ReorderQuoteItemsRequest,
  type ReorderQuoteSourcesRequest,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { requireAuth, requirePermission } from '../auth/guard.js'
import {
  getAccessState,
  resolveWriteAccess,
  setAccessSecret,
  unlockWithPassword,
  type QuoteAccessFailure,
  type QuoteWriteAccess,
} from '../quote/access.js'
import {
  createCategory,
  deleteCategory,
  listCategoryRows,
  mergeCategories,
  mergeCategory,
  renameCategory,
  reorderCategories,
  type CategoryFailure,
} from '../quote/categories.js'
import { parseQuoteFile } from '../quote/importer.js'
import { deleteItem, type ItemDeleteFailure } from '../quote/item-delete.js'
import { mergeItems, type ItemMergeFailure } from '../quote/item-merge.js'
import { reorderItems, type ItemOrderFailure } from '../quote/item-order.js'
import {
  createSource,
  deleteSource,
  listSourceRows,
  renameSource,
  reorderSources,
  sourceExists,
  type SourceFailure,
} from '../quote/sources.js'
import {
  applyImportRows,
  createItem,
  getItem,
  getLedgerStats,
  getMeta,
  listRevisions,
  readImage,
  removeItemImage,
  saveItemImage,
  searchItems,
  setItemStatus,
  updateItemPrice,
  type QuoteFailureReason,
} from '../quote/store.js'

/**
 * 报价查价的接口。
 *
 * ## 两组鉴权，刻意不同
 *
 * - **读**（meta / search / 详情 / 取图）挂 `personal.quote.read`。查价是销售与设计
 *   的日常动作，1225 条台账本来就是给大家查的。
 * - **写**（改价 / 停用 / 换图 / 设口令）**不挂权限点**。owner 直入，其他人必须
 *   在 `x-quote-unlock` 里带一个有效的解锁令牌。判据与理由写在
 *   `quote/access.ts` 顶部 —— 一句话：`personal.*` 通配会把任何 write 点静默地
 *   发给全部业务角色，那时口令就是摆设。
 *
 * ## 图片走 base64 JSON，不引 multipart
 *
 * 与案例库上传同一条链路（`POST /api/cases/uploads`）：`bodyLimit` 单条放开到
 * 8MB，其他路由仍是默认的 1MB。引一个 multipart 解析器要处理边界串、临时文件、
 * 分片超时，而这里每次只传一张图。
 *
 * ## 取图接口的缓存要带版本
 *
 * 案例图用 `immutable` 是安全的（id 每次新生成）；这里的 `imageKey` 是**复用的**
 * —— 同一条目换一张图，URL 还是那个。所以缓存策略是 `max-age` 一天加一个
 * `?v=<版本>` 的缓存键，而不是 `immutable`。写成 `immutable` 的后果是「换了图，
 * 客户那边看到的还是旧图」，而且刷新也没用。
 */

const UNAUTHORIZED_BODY = { error: 'unauthorized', message: '请先登录' } as const

/** 写权限失败的状态码。`no_secret` 用 409：请求没错，是还没设过口令。 */
const ACCESS_STATUS: Record<QuoteAccessFailure, number> = {
  not_authenticated: 401,
  forbidden: 403,
  no_secret: 409,
  secret_exists: 409,
  invalid_password: 401,
  invalid_password_shape: 400,
  locked: 429,
}

const ACCESS_MESSAGE: Record<QuoteAccessFailure, string> = {
  not_authenticated: '请先登录',
  forbidden: '需要维护权限：请输入维护口令，或使用超级管理员账号',
  no_secret: '还没有设置维护口令，请先由超级管理员设置',
  secret_exists: '已经设置过维护口令，如需更换请使用「修改口令」',
  invalid_password: '口令不正确',
  invalid_password_shape: `口令长度需在 ${QUOTE_LIMITS.PASSWORD_MIN}–${QUOTE_LIMITS.PASSWORD_MAX} 位之间`,
  locked: `口令已锁定，请 ${QUOTE_LIMITS.UNLOCK_LOCK_MINUTES} 分钟后再试`,
}

const ITEM_STATUS: Record<QuoteFailureReason, number> = {
  not_found: 404,
  invalid_price: 400,
  invalid_reason: 400,
  invalid_image: 400,
  invalid_status: 409,
  invalid_name: 400,
  invalid_category: 400,
}

const ITEM_MESSAGE: Record<QuoteFailureReason, string> = {
  not_found: '找不到这条报价',
  invalid_price: '价格不合法：请填写数字、金额，或「1.5 倍」这类原文',
  invalid_reason: `说明不能超过 ${QUOTE_LIMITS.REASON_MAX} 字`,
  invalid_image: '图片格式不支持，或超出了体积 / 尺寸上限',
  invalid_status: '状态没有变化',
  invalid_name: '名称不能为空，也不能超过长度上限',
  invalid_category: '分类不能为空，也不能超过长度上限',
}

/** 分类维护的失败映射。`duplicate` 用 409：请求没错，是这个名字已经被占了。 */
const CATEGORY_STATUS: Record<CategoryFailure, number> = {
  not_found: 404,
  duplicate: 409,
  invalid_name: 400,
  invalid_source: 400,
  too_few: 400,
  invalid_target: 400,
  has_items: 409,
}

const CATEGORY_MESSAGE: Record<CategoryFailure, string> = {
  not_found: '找不到这个分类',
  duplicate: '这个分类名已经存在。要合并请用「合并到」，不要用改名',
  invalid_name: `分类名不能为空，也不能超过 ${QUOTE_LIMITS.CATEGORY_NAME_MAX} 字`,
  invalid_source: '来源不合法',
  too_few: '至少选两个分类才能合并。只改一个名字请用「改名」',
  invalid_target: '目标分类不能和要合并的分类同名。请换一个名字，或把目标也一起选中',
  has_items: '这个分类下还有产品（含已下架）。先把产品删掉或合并到别的分类，再来删这个分类',
}

/** 主类的失败映射。删不掉时用 409：请求没错，是这一类下面还有东西。 */
const SOURCE_STATUS: Record<SourceFailure, number> = {
  not_found: 404,
  duplicate: 409,
  invalid_name: 400,
  has_items: 409,
  builtin_locked: 409,
  invalid_order: 400,
}

const SOURCE_MESSAGE: Record<SourceFailure, string> = {
  not_found: '找不到这个主类',
  duplicate: '已经有同名的主类了',
  invalid_name: `主类名称不能为空，也不能超过 ${QUOTE_LIMITS.SOURCE_NAME_MAX} 字`,
  has_items: '这个主类下面还有产品（含已下架）。先把产品删掉或合并到别的主类，再来删主类',
  builtin_locked: '内置主类的标识还被导入器与条目号段引用，不能删除',
  invalid_order: '主类清单已经变了（多出来或少了一个）。刷新页面后再拖一次',
}

/** 产品删除的失败映射。 */
const ITEM_DELETE_STATUS: Record<ItemDeleteFailure, number> = {
  not_found: 404,
  // 403 而不是 409：这条产品是存在的，只是不属于你当前打开的这个主类。
  wrong_source: 403,
}

const ITEM_DELETE_MESSAGE: Record<ItemDeleteFailure, string> = {
  not_found: '这条产品已经不在了，可能在另一个窗口里被删掉了。刷新后再试',
  wrong_source: '这条产品不属于当前主类。列表可能还没刷新，刷新页面后再试',
}

/** 产品重排的失败映射。`not_found` 见 `item-order.ts` 的「整批拒绝」。 */
const ITEM_ORDER_STATUS: Record<ItemOrderFailure, number> = {
  invalid_order: 400,
  not_found: 404,
}

const ITEM_ORDER_MESSAGE: Record<ItemOrderFailure, string> = {
  invalid_order: '顺序里出现了空值或重复的条目键。刷新页面后再拖一次',
  not_found: '有产品已经不在了，或不属于当前主类。刷新页面后再拖一次',
}

/** 产品合并的失败映射。 */
const ITEM_MERGE_STATUS: Record<ItemMergeFailure, number> = {
  too_few: 400,
  not_found: 404,
  cross_category: 400,
  bad_target: 400,
  inactive: 400,
}

const ITEM_MERGE_MESSAGE: Record<ItemMergeFailure, string> = {
  too_few: '至少选两条产品才能合并',
  not_found: '有产品已经不在了，请刷新后再试',
  cross_category: '只能合并同一个分类里的产品。要换分类请用「合并分类」',
  bad_target: '要保留的那一条不在选中范围里',
  inactive: '选中范围里含已下架的产品，只能合并还在售的',
}

/** 批量导入的失败映射。`unsupported` 用 415，`too_large` 用 413。 */
const IMPORT_STATUS: Record<QuoteImportFailure, number> = {
  empty_file: 400,
  too_large: 413,
  unsupported: 415,
  parse_failed: 422,
  no_rows: 422,
}

const IMPORT_MESSAGE: Record<QuoteImportFailure, string> = {
  empty_file: '文件是空的',
  too_large: `文件不能超过 ${Math.round(QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX / 1024 / 1024)}MB`,
  unsupported: '只认 Excel（.xlsx）、CSV 与 PDF',
  parse_failed: '文件解析失败',
  no_rows: '没有识别到可导入的行',
}

function currentAuth(request: FastifyRequest) {
  return request.authContext
}

/** 响应体里带上锁定时间与剩余次数，前端据此显示倒计时，不必自己算。 */
function sendAccessFailure(
  reply: FastifyReply,
  reason: QuoteAccessFailure,
  extra: { lockedUntil?: Date; failCount?: number } = {},
): FastifyReply {
  return reply.code(ACCESS_STATUS[reason]).send({
    error: reason,
    message: ACCESS_MESSAGE[reason],
    ...(extra.lockedUntil === undefined ? {} : { lockedUntil: extra.lockedUntil.toISOString() }),
    ...(extra.failCount === undefined ? {} : { failCount: extra.failCount }),
  })
}

function sendItemFailure(reply: FastifyReply, reason: QuoteFailureReason): FastifyReply {
  return reply.code(ITEM_STATUS[reason]).send({ error: reason, message: ITEM_MESSAGE[reason] })
}

function sendCategoryFailure(reply: FastifyReply, reason: CategoryFailure): FastifyReply {
  return reply
    .code(CATEGORY_STATUS[reason])
    .send({ error: reason, message: CATEGORY_MESSAGE[reason] })
}

function sendSourceFailure(reply: FastifyReply, reason: SourceFailure): FastifyReply {
  return reply.code(SOURCE_STATUS[reason]).send({ error: reason, message: SOURCE_MESSAGE[reason] })
}

function sendItemMergeFailure(reply: FastifyReply, reason: ItemMergeFailure): FastifyReply {
  return reply
    .code(ITEM_MERGE_STATUS[reason])
    .send({ error: reason, message: ITEM_MERGE_MESSAGE[reason] })
}

function sendItemDeleteFailure(reply: FastifyReply, reason: ItemDeleteFailure): FastifyReply {
  return reply
    .code(ITEM_DELETE_STATUS[reason])
    .send({ error: reason, message: ITEM_DELETE_MESSAGE[reason] })
}

function sendItemOrderFailure(reply: FastifyReply, reason: ItemOrderFailure): FastifyReply {
  return reply
    .code(ITEM_ORDER_STATUS[reason])
    .send({ error: reason, message: ITEM_ORDER_MESSAGE[reason] })
}

/** 引用了一个不存在的主类。统一一句话，别让每个接口各编一套。 */
function sendMissingSource(reply: FastifyReply): FastifyReply {
  return reply.code(400).send({
    error: 'invalid_source',
    message: '这个主类不存在，可能在另一个窗口里被删掉了。刷新页面后再试',
  })
}

function sendImportFailure(
  reply: FastifyReply,
  reason: QuoteImportFailure,
  message?: string,
): FastifyReply {
  return reply.code(IMPORT_STATUS[reason]).send({
    error: reason,
    // 解析器给的说明比通用文案有用得多（「这份 PDF 里抽不出可读文字」），有就用它。
    message: message ?? IMPORT_MESSAGE[reason],
  })
}

/**
 * 写路径的准入，一步到位：登录 → 角色 / 解锁令牌。
 *
 * 返回 `null` 表示**已经把失败响应发出去了**，调用方直接 `return reply` 即可。
 * 判据本身在 `quote/access.ts`，这里只是把「取 auth → 判权 → 发错误」这三步收成
 * 一处，避免新加的五个写接口各抄一遍、然后有一处抄漏 `readUnlockToken`。
 */
async function resolveWrite(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ userId: string; access: QuoteWriteAccess } | null> {
  const auth = currentAuth(request)
  if (auth === null) {
    void reply.code(401).send(UNAUTHORIZED_BODY)
    return null
  }
  const access = await resolveWriteAccess(auth, readUnlockToken(request))
  if (!access.ok) {
    void sendAccessFailure(reply, access.reason)
    return null
  }
  return { userId: auth.userId, access: access.value }
}

/**
 * 解锁令牌从请求头取。
 *
 * 用自定义头而不是 query 参数：`?token=` 会进访问日志、Referer 与浏览器历史，
 * 而这是一个能改价的凭据。与案例库拒绝把图片令牌放进 URL 是同一条判断。
 */
function readUnlockToken(request: FastifyRequest): string | null {
  const raw = request.headers['x-quote-unlock']
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw)) return raw[0] ?? null
  return null
}

const CODE_PATTERN = '^[A-Za-z0-9_-]{1,64}$'

/**
 * 来源字段只校验**形状**，不校验取值。
 *
 * 取值域已经从三个字面量变成了 `quote_sources` 表，而 JSON Schema 是编译期常量、
 * 读不到库。写成 `enum: [...QUOTE_SOURCES]` 的后果很具体：新建一个主类之后，往它
 * 下面加产品一律 400「source must be equal to one of the allowed values」—— 而那个
 * 值明明就显示在界面的 tab 上。
 *
 * 真实校验在写路径上用 `sourceExists` 做，一处不多、一处不少。
 */
const SOURCE_FIELD_SCHEMA = {
  type: 'string',
  minLength: 1,
  maxLength: 16,
  pattern: '^[a-z0-9_]+$',
} as const

const CODE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: { type: 'string', minLength: 1, maxLength: 64, pattern: CODE_PATTERN } },
} as const

/**
 * 取图路由的路径参数。
 *
 * **必须单独写一份。** 取图的路径段叫 `:key`（图可能挂在条目自己的 code 上，也可能
 * 挂在产品族的键上，两者都不是「条目 code」），而上面那份要求 `code` 且
 * `additionalProperties: false` —— 套在 `{ key }` 上时请求会因为「缺少 code」被判
 * 400，即**所有图都取不到**，而响应看起来只是「图片接口不工作」。这一条是集成测试
 * 里「取图 200」那一条抓出来的，纯看代码看不出来：两处都叫 `:key`/`:code` 之外的
 * 东西都长得一样。
 */
const IMAGE_PARAMS_SCHEMA = {
  type: 'object',
  required: ['key'],
  additionalProperties: false,
  properties: { key: { type: 'string', minLength: 1, maxLength: 64, pattern: CODE_PATTERN } },
} as const

const SEARCH_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    q: { type: 'string', maxLength: QUOTE_LIMITS.QUERY_MAX },
    source: SOURCE_FIELD_SCHEMA,
    category: { type: 'string', maxLength: 80 },
    limit: { type: 'integer', minimum: 1, maximum: QUOTE_LIMITS.PAGE_SIZE_MAX },
    offset: { type: 'integer', minimum: 0, maximum: 100_000 },
    includeArchived: { type: 'boolean' },
  },
} as const

const UNLOCK_BODY_SCHEMA = {
  type: 'object',
  required: ['password'],
  additionalProperties: false,
  // 下限给 1 而不是 PASSWORD_MIN：这里校验的是「用户输进来的那一串」，不是策略。
  // 说「长度不对」会把口令长度泄露给正在试的人。
  properties: { password: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.PASSWORD_MAX } },
} as const

/**
 * 设置 / 轮换口令的请求体。
 *
 * **下限不交给 schema，交给 `checkPasswordShape`。** schema 拦下时响应是 Fastify 的
 * 默认形状（`body/password must NOT have fewer than 6 characters`）—— 英文、且带着
 * 字段路径，出现在「设置维护口令」这个弹窗里非常突兀。而 service 层拒绝时给的是
 * `invalid_password_shape` + 中文「口令长度需在 6–64 位之间」，两者只差一行代码，
 * 体验差很多。上限仍留在 schema：那是防超长请求体，不需要给人看。
 */
const SET_SECRET_BODY_SCHEMA = {
  type: 'object',
  required: ['password'],
  additionalProperties: false,
  properties: {
    password: {
      type: 'string',
      minLength: 1,
      maxLength: QUOTE_LIMITS.PASSWORD_MAX,
    },
  },
} as const

const UPDATE_ITEM_BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    priceFen: { type: ['integer', 'null'], minimum: 0, maximum: 100_000_000 },
    priceText: { type: 'string', maxLength: 200 },
    reason: { type: 'string', maxLength: QUOTE_LIMITS.REASON_MAX },
  },
} as const

const SET_STATUS_BODY_SCHEMA = {
  type: 'object',
  required: ['status'],
  additionalProperties: false,
  properties: {
    status: { type: 'string', enum: [...QUOTE_ITEM_STATUSES] },
    reason: { type: 'string', maxLength: QUOTE_LIMITS.REASON_MAX },
  },
} as const

/**
 * 上传体。`data` / `thumb` 是纯 base64（不带 `data:` 前缀）。
 *
 * **没有 `mime` / 缩略图尺寸这两栏。** 类型由服务端读魔数判断，缩略图尺寸按 320
 * 长边自己算 —— 客户端能声明的字段越少，能填错的地方就越少。形状与案例库上传的
 * `CreateCaseUploadItem` 逐字相同，前端复用同一个压缩器。
 *
 * `maxLength` 比 `IMAGE_BYTES_MAX` 大 4/3 再留一点余量：base64 的膨胀是固定的，
 * 而这里只是挡住明显过大的串，真正的字节数校验在 service 层按解码后的长度做。
 */
const UPLOAD_BODY_SCHEMA = {
  type: 'object',
  required: ['data', 'width', 'height', 'thumb'],
  additionalProperties: false,
  properties: {
    data: {
      type: 'string',
      minLength: 1,
      maxLength: Math.ceil(QUOTE_LIMITS.IMAGE_BYTES_MAX * 1.4),
    },
    thumb: {
      type: 'string',
      minLength: 1,
      maxLength: Math.ceil(QUOTE_LIMITS.IMAGE_BYTES_MAX * 1.4),
    },
    width: { type: 'integer', minimum: 1, maximum: QUOTE_LIMITS.IMAGE_EDGE_MAX },
    height: { type: 'integer', minimum: 1, maximum: QUOTE_LIMITS.IMAGE_EDGE_MAX },
  },
} as const

const IMAGE_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    v: { type: 'string', maxLength: 16 },
    variant: { type: 'string', enum: ['thumb', 'full'] },
  },
} as const

// ---------------------------------------------------------------------------
// 维护台：分类、产品、批量导入
// ---------------------------------------------------------------------------

/** 新增产品。`code` 不在请求体里 —— 它由服务端按业务键算，理由见 `store.createItem`。 */
const CREATE_ITEM_BODY_SCHEMA = {
  type: 'object',
  required: ['source', 'category', 'name'],
  additionalProperties: false,
  properties: {
    source: SOURCE_FIELD_SCHEMA,
    category: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
    name: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.ITEM_NAME_MAX },
    model: { type: 'string', maxLength: QUOTE_LIMITS.ITEM_MODEL_MAX },
    spec: { type: 'string', maxLength: QUOTE_LIMITS.ITEM_SPEC_MAX },
    pricingMode: { type: 'string', maxLength: QUOTE_LIMITS.ITEM_PRICING_MODE_MAX },
    materials: { type: 'string', maxLength: QUOTE_LIMITS.ITEM_MATERIALS_MAX },
    unit: { type: 'string', maxLength: QUOTE_LIMITS.ITEM_UNIT_MAX },
    unitRaw: { type: 'string', maxLength: QUOTE_LIMITS.ITEM_UNIT_MAX },
    priceText: { type: 'string', maxLength: QUOTE_LIMITS.ITEM_PRICE_TEXT_MAX },
    note: { type: 'string', maxLength: QUOTE_LIMITS.ITEM_NOTE_MAX },
    /**
     * 可选的商品图。**复用取图 / 换图那份 `UPLOAD_BODY_SCHEMA`**，不另写一份：
     * 两处判据只要有一处不同，就会出现「换图能传、新增时传不上去」这种只在某个
     * 入口复现的怪现象。
     */
    image: UPLOAD_BODY_SCHEMA,
  },
} as const

const CREATE_CATEGORY_BODY_SCHEMA = {
  type: 'object',
  required: ['source', 'name'],
  additionalProperties: false,
  properties: {
    source: SOURCE_FIELD_SCHEMA,
    name: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
  },
} as const

/** 改名与合并共用一个形状（`from` / `to`），语义差别在路由上。 */
const CATEGORY_PAIR_BODY_SCHEMA = {
  type: 'object',
  required: ['source', 'from', 'to'],
  additionalProperties: false,
  properties: {
    source: SOURCE_FIELD_SCHEMA,
    from: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
    to: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
  },
} as const

/** 删分类只认名字，没有目标 —— 不共用 `from` / `to` 那个形状。 */
const DELETE_CATEGORY_BODY_SCHEMA = {
  type: 'object',
  required: ['source', 'name'],
  additionalProperties: false,
  properties: {
    source: SOURCE_FIELD_SCHEMA,
    name: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
  },
} as const

const REORDER_CATEGORIES_BODY_SCHEMA = {
  type: 'object',
  required: ['source', 'order'],
  additionalProperties: false,
  properties: {
    source: SOURCE_FIELD_SCHEMA,
    order: {
      type: 'array',
      minItems: 1,
      maxItems: 300,
      items: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
    },
  },
} as const

const IMPORT_PREVIEW_BODY_SCHEMA = {
  type: 'object',
  required: ['fileName', 'data'],
  additionalProperties: false,
  properties: {
    fileName: { type: 'string', minLength: 1, maxLength: 200 },
    // base64 膨胀是固定的 4/3，留一点余量。真正的字节数校验在解析器里按解码后长度做。
    data: {
      type: 'string',
      minLength: 1,
      maxLength: Math.ceil(QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX * 1.4),
    },
  },
} as const

const IMPORT_ROW_SCHEMA = {
  type: 'object',
  required: [
    'category',
    'name',
    'model',
    'spec',
    'unit',
    'priceText',
    'note',
    'pricingMode',
    'materials',
    'ledgerNo',
  ],
  additionalProperties: false,
  properties: {
    category: { type: 'string', maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
    name: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.ITEM_NAME_MAX },
    model: { type: 'string', maxLength: 120 },
    spec: { type: 'string', maxLength: 160 },
    unit: { type: 'string', maxLength: 24 },
    priceText: { type: 'string', maxLength: 200 },
    note: { type: 'string', maxLength: 400 },
    pricingMode: { type: 'string', maxLength: 40 },
    materials: { type: 'string', maxLength: 300 },
    ledgerNo: { type: 'string', maxLength: 12 },
    // 确认页会把预览行原样回传，带上这两列。这里允许它们，但**不写库** ——
    // 行号与逐行提示是给人看的，`applyImportRows` 只挑它认识的字段。
    sourceLine: { type: 'integer', minimum: 1 },
    warnings: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 20 },
  },
} as const

const IMPORT_APPLY_BODY_SCHEMA = {
  type: 'object',
  required: ['fileName', 'source', 'rows'],
  additionalProperties: false,
  properties: {
    fileName: { type: 'string', minLength: 1, maxLength: 200 },
    source: SOURCE_FIELD_SCHEMA,
    rows: {
      type: 'array',
      minItems: 1,
      maxItems: QUOTE_LIMITS.IMPORT_ROWS_MAX,
      items: IMPORT_ROW_SCHEMA,
    },
  },
} as const

const CREATE_SOURCE_BODY_SCHEMA = {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.SOURCE_NAME_MAX },
    short: { type: 'string', maxLength: QUOTE_LIMITS.SOURCE_SHORT_MAX },
  },
} as const

/** 编辑主类。`code` 只用来定位，`name` / `short` 才是可改的字段。 */
const RENAME_SOURCE_BODY_SCHEMA = {
  type: 'object',
  required: ['code', 'name'],
  additionalProperties: false,
  properties: {
    code: SOURCE_FIELD_SCHEMA,
    name: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.SOURCE_NAME_MAX },
    short: { type: 'string', maxLength: QUOTE_LIMITS.SOURCE_SHORT_MAX },
  },
} as const

const DELETE_SOURCE_BODY_SCHEMA = {
  type: 'object',
  required: ['code'],
  additionalProperties: false,
  properties: { code: SOURCE_FIELD_SCHEMA },
} as const

/**
 * 主类重排的 body。
 *
 * 上限 50：主类就是顶部那排页签，一百个页签谁也用不了。这个数字只防超长请求体，
 * 不参与业务判断 —— 真正的判据是「发来的 code 数与库里一致」（见 `reorderSources`）。
 */
const REORDER_SOURCES_BODY_SCHEMA = {
  type: 'object',
  required: ['order'],
  additionalProperties: false,
  properties: {
    order: {
      type: 'array',
      minItems: 1,
      maxItems: 50,
      items: SOURCE_FIELD_SCHEMA,
    },
  },
} as const

/**
 * 产品重排的 body。
 *
 * `maxItems` 用 `PAGE_SIZE_MAX`：契约是「这一屏看到的那些条目键的新顺序」，而一屏
 * 最多就是 200 条。取更大的数字没有意义 —— 服务端也只会收到前端手里有的那些。
 */
const REORDER_ITEMS_BODY_SCHEMA = {
  type: 'object',
  required: ['source', 'order'],
  additionalProperties: false,
  properties: {
    source: SOURCE_FIELD_SCHEMA,
    order: {
      type: 'array',
      minItems: 1,
      maxItems: QUOTE_LIMITS.PAGE_SIZE_MAX,
      items: { type: 'string', minLength: 1, maxLength: 64, pattern: CODE_PATTERN },
    },
  },
} as const

/**
 * 批量合并分类的 body。
 *
 * `from` 的 `minItems` 故意写 1 而不是 2：选一个就走「改名」更合适，让服务端返回
 * `too_few` 并给出那句「至少选两个」，比 schema 抛一条英文校验信息有用得多。
 */
const MERGE_CATEGORIES_BODY_SCHEMA = {
  type: 'object',
  required: ['source', 'from', 'to'],
  additionalProperties: false,
  properties: {
    source: SOURCE_FIELD_SCHEMA,
    from: {
      type: 'array',
      minItems: 1,
      maxItems: QUOTE_LIMITS.CATEGORY_COUNT_MAX,
      items: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
    },
    to: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
  },
} as const

/** 合并同一个分类里的多条产品。 */
const DELETE_ITEM_BODY_SCHEMA = {
  type: 'object',
  required: ['source', 'code'],
  additionalProperties: false,
  properties: {
    source: SOURCE_FIELD_SCHEMA,
    code: { type: 'string', minLength: 1, maxLength: 64, pattern: CODE_PATTERN },
  },
} as const

const MERGE_ITEMS_BODY_SCHEMA = {
  type: 'object',
  required: ['source', 'category', 'codes', 'keep'],
  additionalProperties: false,
  properties: {
    source: SOURCE_FIELD_SCHEMA,
    category: { type: 'string', minLength: 1, maxLength: QUOTE_LIMITS.CATEGORY_NAME_MAX },
    codes: {
      type: 'array',
      minItems: 1,
      // 一次合并 200 条是上限：再多就该用批量导入重导，而不是在界面上逐条勾。
      maxItems: 200,
      items: { type: 'string', minLength: 1, maxLength: 64, pattern: CODE_PATTERN },
    },
    keep: { type: 'string', minLength: 1, maxLength: 64, pattern: CODE_PATTERN },
  },
} as const

export function registerQuoteRoutes(app: FastifyInstance): void {
  const readGuard = [requireAuth, requirePermission(PERMISSIONS.PERSONAL_QUOTE_READ)]

  /** 数据集版本、分类清单、有没有设过口令。一次拿全，界面挂载时只发这一个请求。 */
  app.get('/api/quote/meta', { preHandler: readGuard }, async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return getMeta()
  })

  app.get<{
    Querystring: {
      q?: string
      source?: QuoteSource
      category?: string
      limit?: number
      offset?: number
      includeArchived?: boolean
    }
  }>(
    '/api/quote/search',
    { preHandler: readGuard, schema: { querystring: SEARCH_QUERY_SCHEMA } },
    async (request, reply) => {
      // 价格随时可能变，缓存一次就等于给旧价。`no-store` 是这条接口的默认，
      // 与「宁可空白不给旧价」同一个判断。
      reply.header('cache-control', 'no-store')
      const query = request.query
      return searchItems({
        q: query.q ?? '',
        source: query.source ?? null,
        category: query.category ?? null,
        includeArchived: query.includeArchived === true,
        limit: Math.min(query.limit ?? QUOTE_LIMITS.PAGE_SIZE_DEFAULT, QUOTE_LIMITS.PAGE_SIZE_MAX),
        offset: query.offset ?? 0,
      })
    },
  )

  app.get<{ Params: { code: string } }>(
    '/api/quote/items/:code',
    { preHandler: readGuard, schema: { params: CODE_PARAMS_SCHEMA } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      const result = await getItem(request.params.code)
      if (result === null) {
        return reply.code(404).send({ error: 'not_found', message: '找不到这条报价' })
      }
      return result
    },
  )

  /**
   * 台账现状：绑定档位分布、图文件数、孤儿图数。
   *
   * 与 `meta` 分开是因为两者节奏不同：`meta` 每次挂载都要（版本号决定缓存能不能用），
   * 这组数字只有打开维护面板时才看，而它要扫三遍全表。塞进 `meta` 等于让每次查价
   * 都付一次全表统计的代价。
   */
  app.get('/api/quote/stats', { preHandler: readGuard }, async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return getLedgerStats()
  })

  /**
   * 变更记录。挂读权限而不是写权限 —— 审计的意义是「谁都能看改过什么」，
   * 只有能改的人能看，等于把审计变成了内部台账。
   */
  app.get<{ Querystring: { limit?: number } }>(
    '/api/quote/revisions',
    {
      preHandler: readGuard,
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 100 } },
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store')
      return listRevisions(request.query.limit ?? 20)
    },
  )
  /**
   * 取图。
   *
   * 要登录、要读权限，**不要解锁令牌**：图是商品图，不是价格。把它也锁在口令后面，
   * 结果是销售查价时看不到任何产品图 —— 而查价正是这张图唯一的用途。
   */
  app.get<{ Params: { key: string }; Querystring: { v?: string; variant?: 'thumb' | 'full' } }>(
    '/api/quote/images/:key',
    {
      preHandler: readGuard,
      schema: { params: IMAGE_PARAMS_SCHEMA, querystring: IMAGE_QUERY_SCHEMA },
    },
    async (request, reply) => {
      const variant = request.query.variant === 'full' ? 'full' : 'thumb'
      const image = await readImage(request.params.key, variant)
      if (image === null) {
        return reply.code(404).send({ error: 'not_found', message: '图片不存在' })
      }
      reply.header('content-type', image.mime)
      reply.header('content-length', String(image.bytes.length))
      // 不带 `immutable`，理由见文件头：同一个 key 的字节会被替换。
      reply.header('cache-control', 'private, max-age=86400')
      reply.header('etag', `"${image.version}-${variant}"`)
      return reply.send(image.bytes)
    },
  )

  app.get('/api/quote/access-state', { preHandler: requireAuth }, async (request, reply) => {
    const auth = currentAuth(request)
    if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)
    reply.header('cache-control', 'no-store')
    return getAccessState(auth)
  })

  app.post<{ Body: { password: string } }>(
    '/api/quote/unlock',
    { preHandler: requireAuth, schema: { body: UNLOCK_BODY_SCHEMA } },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const result = await unlockWithPassword(auth, request.body.password, request.ip ?? null)
      if (!result.ok) {
        return sendAccessFailure(reply, result.reason, {
          ...(result.lockedUntil === undefined ? {} : { lockedUntil: result.lockedUntil }),
          ...(result.failCount === undefined ? {} : { failCount: result.failCount }),
        })
      }
      reply.header('cache-control', 'no-store')
      return {
        unlockToken: result.value.unlockToken,
        expiresAt: result.value.expiresAt.toISOString(),
      }
    },
  )

  /** 首次设置口令。仅 owner —— 判据在 service 层，那里是唯一强制的一层。 */
  app.post<{ Body: { password: string } }>(
    '/api/quote/access-secret',
    { preHandler: requireAuth, schema: { body: SET_SECRET_BODY_SCHEMA } },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      const result = await setAccessSecret(auth, request.body.password, 'create')
      if (!result.ok) return sendAccessFailure(reply, result.reason)
      return { ok: true, version: result.value.version }
    },
  )

  /** 轮换口令。版本 +1，其他设备上已开的解锁立刻失效。 */
  app.put<{ Body: { password: string } }>(
    '/api/quote/access-secret',
    { preHandler: requireAuth, schema: { body: SET_SECRET_BODY_SCHEMA } },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)
      const result = await setAccessSecret(auth, request.body.password, 'rotate')
      if (!result.ok) return sendAccessFailure(reply, result.reason)
      return { ok: true, version: result.value.version }
    },
  )

  app.patch<{
    Params: { code: string }
    Body: { priceFen?: number | null; priceText?: string; reason?: string }
  }>(
    '/api/quote/items/:code',
    {
      preHandler: requireAuth,
      schema: { params: CODE_PARAMS_SCHEMA, body: UPDATE_ITEM_BODY_SCHEMA },
    },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const access = await resolveWriteAccess(auth, readUnlockToken(request))
      if (!access.ok) return sendAccessFailure(reply, access.reason)

      const result = await updateItemPrice(
        request.params.code,
        {
          ...(request.body.priceFen === undefined ? {} : { priceFen: request.body.priceFen }),
          ...(request.body.priceText === undefined ? {} : { priceText: request.body.priceText }),
          ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
        },
        { userId: auth.userId, access: access.value },
      )
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  app.post<{ Params: { code: string }; Body: { status: QuoteItemStatus; reason?: string } }>(
    '/api/quote/items/:code/status',
    {
      preHandler: requireAuth,
      schema: { params: CODE_PARAMS_SCHEMA, body: SET_STATUS_BODY_SCHEMA },
    },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const access = await resolveWriteAccess(auth, readUnlockToken(request))
      if (!access.ok) return sendAccessFailure(reply, access.reason)

      const result = await setItemStatus(
        request.params.code,
        request.body.status,
        request.body.reason ?? '',
        { userId: auth.userId, access: access.value },
      )
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  app.post<{ Params: { code: string }; Body: Parameters<typeof saveItemImage>[1] }>(
    '/api/quote/items/:code/image',
    {
      preHandler: requireAuth,
      schema: { params: CODE_PARAMS_SCHEMA, body: UPLOAD_BODY_SCHEMA },
      // 默认 1MB 装不下一张压好的原图（1600px webp 约 300KB，但也常有 2MB 的
      // 手机直出图）。这条路由单独放开，其他路由仍是默认值。
      bodyLimit: 8 * 1024 * 1024,
    },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const access = await resolveWriteAccess(auth, readUnlockToken(request))
      if (!access.ok) return sendAccessFailure(reply, access.reason)

      const result = await saveItemImage(request.params.code, request.body, {
        userId: auth.userId,
        access: access.value,
      })
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  app.delete<{ Params: { code: string } }>(
    '/api/quote/items/:code/image',
    { preHandler: requireAuth, schema: { params: CODE_PARAMS_SCHEMA } },
    async (request, reply) => {
      const auth = currentAuth(request)
      if (auth === null) return reply.code(401).send(UNAUTHORIZED_BODY)

      const access = await resolveWriteAccess(auth, readUnlockToken(request))
      if (!access.ok) return sendAccessFailure(reply, access.reason)

      const result = await removeItemImage(request.params.code, {
        userId: auth.userId,
        access: access.value,
      })
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  // -------------------------------------------------------------------------
  // 维护台：主类
  // -------------------------------------------------------------------------

  /**
   * 主类清单。维护台顶部的 tab 就靠它渲染。
   *
   * 走读权限而不是写权限：查价页也要显示来源名，而它拿的是 `meta.categories` 里的
   * `source`（一个 code），名字只能从这张表对。
   */
  app.get('/api/quote/sources', { preHandler: readGuard }, async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return listSourceRows()
  })

  /** 新增主类。`code` 与条目号前缀由服务端分配。 */
  app.post<{ Body: CreateQuoteSourceRequest }>(
    '/api/quote/sources',
    { preHandler: requireAuth, schema: { body: CREATE_SOURCE_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      const result = await createSource(request.body.name, request.body.short, context)
      if (!result.ok) return sendSourceFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /** 编辑主类。只能改显示名与短名 —— `code` 是每条产品业务键的第 0 段。 */
  app.patch<{ Body: RenameQuoteSourceRequest }>(
    '/api/quote/sources',
    { preHandler: requireAuth, schema: { body: RENAME_SOURCE_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      const result = await renameSource(
        request.body.code,
        request.body.name,
        request.body.short,
        context,
      )
      if (!result.ok) return sendSourceFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /**
   * 删除主类。
   *
   * 用 `POST .../delete` 而不是 `DELETE` 带 body：`DELETE` 的请求体在部分代理与
   * 某些 fetch 实现里会被丢掉（隧道那一层尤其常见），届时服务端读到空对象、报一条
   * 「code 必填」，看起来像接口坏了。
   */
  app.post<{ Body: DeleteQuoteSourceRequest }>(
    '/api/quote/sources/delete',
    { preHandler: requireAuth, schema: { body: DELETE_SOURCE_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      const result = await deleteSource(request.body.code, context)
      if (!result.ok) return sendSourceFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /**
   * 主类重排（页签先后）。
   *
   * 用 `PUT` 而不是 `PATCH`：这条接口的语义是「把这串顺序整份写上去」，重复提交同一
   * 份 body 结果一样。`PATCH` 会让人以为这里支持「挪一位」的增量语义，而增量协议在
   * 并发编辑下会得到两种都说得通的解释 —— 分类重排（`categories/order`）也是 `PUT`。
   */
  app.put<{ Body: ReorderQuoteSourcesRequest }>(
    '/api/quote/sources/order',
    { preHandler: requireAuth, schema: { body: REORDER_SOURCES_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      const result = await reorderSources(request.body.order, context)
      if (!result.ok) return sendSourceFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  // -------------------------------------------------------------------------
  // 维护台：分类
  // -------------------------------------------------------------------------

  /**
   * 分类清单，**含空分类与未落表的分类**。
   *
   * 与 `meta.categories` 的区别：那边只给筛选下拉用，空分类出现没有意义；这边是
   * 维护台，人正要在空分类里传第一个产品。
   */
  app.get('/api/quote/categories', { preHandler: readGuard }, async (_request, reply) => {
    reply.header('cache-control', 'no-store')
    return listCategoryRows()
  })

  app.post<{ Body: CreateQuoteCategoryRequest }>(
    '/api/quote/categories',
    { preHandler: requireAuth, schema: { body: CREATE_CATEGORY_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await createCategory(request.body.source, request.body.name, context)
      if (!result.ok) return sendCategoryFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /** 改名。条目与分类表一起改，所以会 bump 数据集版本。 */
  app.patch<{ Body: RenameQuoteCategoryRequest }>(
    '/api/quote/categories',
    { preHandler: requireAuth, schema: { body: CATEGORY_PAIR_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await renameCategory(
        request.body.source,
        request.body.from,
        request.body.to,
        context,
      )
      if (!result.ok) return sendCategoryFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /** 合并：`from` 下的条目全部改挂到 `to`，然后删掉 `from`。 */
  app.post<{ Body: MergeQuoteCategoryRequest }>(
    '/api/quote/categories/merge',
    { preHandler: requireAuth, schema: { body: CATEGORY_PAIR_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await mergeCategory(
        request.body.source,
        request.body.from,
        request.body.to,
        context,
      )
      if (!result.ok) return sendCategoryFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /**
   * 多选合并：把选中的多个分类并成一项。
   *
   * 与单条合并分开成两条路由而不是给旧的加一个 `from[]`：单条那个已经被「行内合并」
   * 用着，改形状等于同时改两处的调用约定，而这里的失败语义也不同（少了 `too_few`）。
   */
  app.post<{ Body: MergeQuoteCategoriesRequest }>(
    '/api/quote/categories/merge-many',
    { preHandler: requireAuth, schema: { body: MERGE_CATEGORIES_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await mergeCategories(
        request.body.source,
        request.body.from,
        request.body.to,
        context,
      )
      if (!result.ok) return sendCategoryFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /**
   * 删掉一个空分类。
   *
   * 用 POST 而不是 DELETE：DELETE 带 body 会被部分代理丢掉，到时候变成「没有名字的
   * 删除请求」，服务端只能回一句参数错误。`sources/delete` 出于同一个理由也是 POST。
   *
   * 只允许删空分类（判据在 `deleteCategory` 里）。这里不做幂等：删一个不存在的分类
   * 回 404，而不是回 200 —— 界面上「删了两次」应该看到「找不到了」，那才说明刷新没做。
   */
  app.post<{ Body: DeleteQuoteCategoryRequest }>(
    '/api/quote/categories/delete',
    { preHandler: requireAuth, schema: { body: DELETE_CATEGORY_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await deleteCategory(request.body.source, request.body.name, context)
      if (!result.ok) return sendCategoryFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /** 重排。只改顺序，不动条目，也不 bump 版本。 */
  app.put<{ Body: ReorderQuoteCategoriesRequest }>(
    '/api/quote/categories/order',
    { preHandler: requireAuth, schema: { body: REORDER_CATEGORIES_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await reorderCategories(request.body.source, request.body.order, context)
      if (!result.ok) return sendCategoryFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  // -------------------------------------------------------------------------
  // 维护台：产品
  // -------------------------------------------------------------------------

  /**
   * 新增产品。
   *
   * 与 `PATCH /api/quote/items/:code`（改价）分开，是因为语义不同：那条改一行已有
   * 的数据，这条要**先算业务键**再决定是新建还是恢复一条已下架的行。混在一个接口
   * 里，客户端就得先知道 code —— 而新产品的 code 只有服务端算得出来。
   */
  app.post<{ Body: CreateQuoteItemRequest }>(
    '/api/quote/items',
    {
      preHandler: requireAuth,
      schema: { body: CREATE_ITEM_BODY_SCHEMA },
      // 带图时请求体里有两张 base64（原图 + 缩略图，各约 4/3 膨胀），默认 1MB 装不下。
      // 与换图那条路由同一个量级。
      bodyLimit: 8 * 1024 * 1024,
    },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await createItem(request.body, context)
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /**
   * 产品重排（维护台里拖动产品排出来的先后）。
   *
   * 与 `PUT /categories/order` 同一条思路：发的是「这一屏的新顺序」而不是「把 A 挪
   * 到 B 前面」。差别在于产品一次显示不完（五金 596 条、一屏 200 条），所以服务端
   * 把没提到的行按原相对次序接在后面再整段重排 —— 细则见 `item-order.ts`。
   *
   * 不 bump 数据集版本：价格没变，只是顺序变了。
   */
  app.put<{ Body: ReorderQuoteItemsRequest }>(
    '/api/quote/items/order',
    { preHandler: requireAuth, schema: { body: REORDER_ITEMS_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await reorderItems(request.body.source, request.body.order, context)
      if (!result.ok) return sendItemOrderFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /**
   * 把同一个分类里的多条产品折叠成一条。
   *
   * 和上面的「新增产品」分开，和 `PATCH /items/:code` 也分开：这条会**同时改** N 条
   * 条目的状态，而那两个接口各只碰一条。混在一个接口里，判权与审计粒度都不对了。
   */
  app.post<{ Body: MergeQuoteItemsRequest }>(
    '/api/quote/items/merge',
    { preHandler: requireAuth, schema: { body: MERGE_ITEMS_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await mergeItems(request.body, context)
      if (!result.ok) return sendItemMergeFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  /**
   * 物理删掉一条产品。
   *
   * 与 `POST /items/:code/status`（下架）刻意分成两条路由：下架可逆、删除不可逆，
   * 混在一个接口里靠一个布尔参数区分，前端只要传错一个字段就变成不可逆操作。
   *
   * 删除前服务端会把整行快照写进审计（`field = 'deleted'`），事后还能回答「这条
   * 当时叫什么、多少钱、什么编号」。
   */
  app.post<{ Body: DeleteQuoteItemRequest }>(
    '/api/quote/items/delete',
    { preHandler: requireAuth, schema: { body: DELETE_ITEM_BODY_SCHEMA } },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)
      const result = await deleteItem(request.body, context)
      if (!result.ok) return sendItemDeleteFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )

  // -------------------------------------------------------------------------
  // 维护台：批量导入
  // -------------------------------------------------------------------------

  /**
   * 识别文件，**一行都不写库**。
   *
   * 之所以要把「识别」与「导入」拆成两个接口：识别一定会出错（合并单元格、跨行备注、
   * 表头前多一行标题），而导入是不可逆的。操作员在中间那一步逐条核对、改完再提交，
   * 是这条链路唯一的安全阀。
   */
  app.post<{ Body: QuoteImportPreviewRequest }>(
    '/api/quote/import/preview',
    {
      preHandler: requireAuth,
      schema: { body: IMPORT_PREVIEW_BODY_SCHEMA },
      // base64 是 4/3 膨胀，8MB 的文件约 11MB。这条路由单独放开，其他路由仍是默认值。
      bodyLimit: 12 * 1024 * 1024,
    },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply

      const bytes = new Uint8Array(Buffer.from(request.body.data, 'base64'))
      const parsed = parseQuoteFile(request.body.fileName, bytes)
      if (!parsed.ok) return sendImportFailure(reply, parsed.reason, parsed.message)

      reply.header('cache-control', 'no-store')
      return {
        fileName: request.body.fileName,
        format: parsed.value.format,
        total: parsed.value.rows.length,
        rows: parsed.value.rows.slice(0, QUOTE_LIMITS.IMPORT_PREVIEW_ROWS),
        warnings: parsed.value.warnings,
        suggestedSource: parsed.value.suggestedSource,
        detectedColumns: parsed.value.detectedColumns,
      }
    },
  )

  /** 应用确认过的行。按业务键 upsert，同一份文件重复提交不产生重复行。 */
  app.post<{ Body: QuoteImportApplyRequest }>(
    '/api/quote/import/apply',
    {
      preHandler: requireAuth,
      schema: { body: IMPORT_APPLY_BODY_SCHEMA },
      bodyLimit: 8 * 1024 * 1024,
    },
    async (request, reply) => {
      const context = await resolveWrite(request, reply)
      if (context === null) return reply
      if (!(await sourceExists(request.body.source))) return sendMissingSource(reply)

      // 只挑十个业务字段。确认页回传的行里带着 `sourceLine` / `warnings`，那是给
      // 人看的，进库会让 `quote_items` 多出两列没人读的数据。
      const rows = request.body.rows.map((row) => ({
        category: row.category,
        name: row.name,
        model: row.model,
        spec: row.spec,
        unit: row.unit,
        priceText: row.priceText,
        note: row.note,
        pricingMode: row.pricingMode,
        materials: row.materials,
        ledgerNo: row.ledgerNo,
      }))

      const result = await applyImportRows(request.body.source, rows, context)
      if (!result.ok) return sendItemFailure(reply, result.reason)
      reply.header('cache-control', 'no-store')
      return result.value
    },
  )
}
