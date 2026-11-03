import { randomBytes, randomUUID } from 'node:crypto'

import {
  QUOTE_LIMITS,
  QUOTE_SOURCE_NAMES,
  parsePriceInput,
  type QuoteDatasetDto,
  type QuoteImageDto,
  type QuoteItemDto,
  type QuoteItemStatus,
  type QuoteLedgerStatsDto,
  type QuoteMetaResponse,
  type QuotePriceKind,
  type QuoteRevisionDto,
  type QuoteRevisionListResponse,
  type QuoteSource,
  type QuoteBindType,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'

import type { QuoteWriteAccess } from './access.js'

/**
 * 报价查价的数据层。
 *
 * ## 读路径一次查完，不做 N+1
 *
 * 列表最多 100 行，每行要带「有没有图 / 图的版本」。逐行去查图会变成 100 次查询，
 * 而这 100 次查的是同一张小表 —— 先收集 imageKey 再走一次 `IN`，成本是两次查询。
 * 这条在本地看不出差别，装到店里那台旧机器上就是「打字时列表要顿一下」。
 *
 * ## 写路径一律「先判权、后读行、再事务」
 *
 * 判权放在最前面不是为了省一次查询，而是为了让**不可写的人拿不到任何一行数据**：
 * 先读行再判权，等于用一个 403 与一个 404 的差别告诉对方「这个 code 存在」。
 *
 * ## 不在这里算版本号
 *
 * `version` 由导入器与在线改动各自写一条 `quote_datasets`（见 `bumpDataset`）。
 * 它是前端判断「手里的价格还成不成立」的唯一依据，所以**任何改变价格的写入都必须
 * 让它变**。漏掉一处的后果是：界面上显示旧价，而不报任何错。
 */

export type QuoteFailureReason =
  'not_found' | 'invalid_price' | 'invalid_reason' | 'invalid_image' | 'invalid_status'

export type QuoteResult<T> = { ok: true; value: T } | { ok: false; reason: QuoteFailureReason }

/** 当前生效的数据集。没有导入过任何台账时是 null。 */
export async function getLatestDataset(): Promise<QuoteDatasetDto | null> {
  const row = await prisma.quoteDataset.findFirst({
    orderBy: { importedAt: 'desc' },
    select: {
      version: true,
      itemCount: true,
      imageCount: true,
      importedAt: true,
    },
  })
  if (row === null) return null
  return {
    version: row.version,
    itemCount: row.itemCount,
    imageCount: row.imageCount,
    importedAt: row.importedAt.toISOString(),
  }
}

/**
 * 生成一个新的数据集版本。
 *
 * 这里用的是「时间 + 随机」而不是内容指纹：在线改价只动一行，重算全表哈希不值当。
 * 语义上没有损失 —— 前端只问「这个号跟我手里的一样吗」，不关心它是怎么算出来的。
 * 导入这条路仍然用内容指纹，因为那条路上「同一份台账重复导入不产生新版本」是有
 * 意义的（否则每导一次，所有人的界面都要重拉一遍）。
 */
async function bumpDataset(note: string): Promise<string> {
  const latest = await getLatestDataset()
  const version = `r${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
  await prisma.quoteDataset.create({
    data: {
      version,
      itemCount: latest?.itemCount ?? 0,
      imageCount: latest?.imageCount ?? 0,
      changedCount: 1,
      sourceNote: note.slice(0, 300),
    },
  })
  return version
}

/**
 * 条目列白名单。列表、详情、改价回写、状态回写四处共用同一份。
 *
 * 以前这四个 `select` 各抄一遍，加一个字段要改四处，漏一处的表现是「详情页有、
 * 列表里空」或者「改完价那一次的响应少一个字段」—— 都不报错。
 */
const ITEM_SELECT = {
  code: true,
  source: true,
  category: true,
  name: true,
  model: true,
  spec: true,
  ledgerNo: true,
  pricingMode: true,
  materials: true,
  unit: true,
  unitRaw: true,
  priceKind: true,
  priceFen: true,
  priceText: true,
  note: true,
  status: true,
  imageKey: true,
  updatedAt: true,
} as const

/** 数据库行 → 契约 DTO。图片相关的两列由调用方补，避免每处都写一遍 join。 */
function toItemDto(
  row: {
    code: string
    source: string
    category: string
    name: string
    model: string
    spec: string
    ledgerNo: string
    pricingMode: string
    materials: string
    unit: string
    unitRaw: string
    priceKind: string
    priceFen: number | null
    priceText: string
    note: string
    status: string
    imageKey: string | null
    updatedAt: Date
  },
  image: { imageKey: string; version: string } | null,
): QuoteItemDto {
  // 库里存字符串不存枚举（理由见 schema），边界上转一次类型。取值域由导入器与
  // 路由的 schema 共同保证 —— 任一处出现新值，这里的断言才会被打破。
  const source = row.source as QuoteSource
  return {
    code: row.code,
    source,
    sourceName: QUOTE_SOURCE_NAMES[source] ?? row.source,
    category: row.category,
    name: row.name,
    model: row.model,
    spec: row.spec,
    ledgerNo: row.ledgerNo,
    pricingMode: row.pricingMode,
    materials: row.materials,
    unit: row.unit,
    unitRaw: row.unitRaw,
    priceKind: row.priceKind as QuotePriceKind,
    priceFen: row.priceFen,
    priceText: row.priceText,
    note: row.note,
    status: row.status as QuoteItemStatus,
    hasImage: image !== null,
    imageKey: image?.imageKey ?? null,
    imageVersion: image?.version ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 图版本只用于缓存键：字节一改就是新行，`uploadedAt` 一定不同。 */
function imageVersionOf(uploadedAt: Date): string {
  return uploadedAt.getTime().toString(36)
}

function toImageDto(row: {
  imageKey: string
  mime: string
  width: number
  height: number
  bindType: string
  byteSize: number
  sourceRow: number | null
  uploadedAt: Date
}): QuoteImageDto {
  return {
    key: row.imageKey,
    mime: row.mime,
    width: row.width,
    height: row.height,
    bindType: row.bindType as QuoteBindType,
    byteSize: row.byteSize,
    sourceRow: row.sourceRow,
    uploadedAt: row.uploadedAt.toISOString(),
  }
}

/** 批量取图版本。返回 imageKey → 版本号。 */
async function loadImageVersions(
  keys: readonly string[],
): Promise<Map<string, { imageKey: string; version: string }>> {
  const unique = [...new Set(keys)]
  if (unique.length === 0) return new Map()
  const rows = await prisma.quoteItemImage.findMany({
    where: { imageKey: { in: unique }, isActive: true },
    select: { imageKey: true, uploadedAt: true },
  })
  const map = new Map<string, { imageKey: string; version: string }>()
  for (const row of rows) {
    map.set(row.imageKey, { imageKey: row.imageKey, version: imageVersionOf(row.uploadedAt) })
  }
  return map
}

export type QuoteSearchQuery = {
  q: string
  source: QuoteSource | null
  category: string | null
  includeArchived: boolean
  limit: number
  offset: number
}

/**
 * 搜索。
 *
 * **服务端搜索，不下发全表。** 1225 条 JSON 约 180KB，全量塞进首屏只为让浏览器
 * 自己过滤，代价是每次打开面板都多下这么多字节；而台账还会继续长。
 *
 * 匹配范围是名称、型号、规格、分类四列。**不含价格** —— 有人会想「搜 668 找出所有
 * 这个价的」，但那个需求用排序更直接，而把价格放进模糊匹配会让「搜 6」命中一大片。
 */
export async function searchItems(query: QuoteSearchQuery): Promise<{
  version: string
  total: number
  items: readonly QuoteItemDto[]
}> {
  const dataset = await getLatestDataset()
  const keyword = query.q.trim()

  const where = {
    ...(query.includeArchived ? {} : { status: 'active' }),
    ...(query.source === null ? {} : { source: query.source }),
    ...(query.category === null ? {} : { category: query.category }),
    ...(keyword === ''
      ? {}
      : {
          OR: [
            { name: { contains: keyword, mode: 'insensitive' as const } },
            { model: { contains: keyword, mode: 'insensitive' as const } },
            { spec: { contains: keyword, mode: 'insensitive' as const } },
            { category: { contains: keyword, mode: 'insensitive' as const } },
          ],
        }),
  }

  const [total, rows] = await prisma.$transaction([
    prisma.quoteItem.count({ where }),
    prisma.quoteItem.findMany({
      where,
      // 排序按「来源 → 分类 → 名称 → 规格」：同名多行（拉篮按宽度分行）必须排在
      // 一起，否则搜出来的结果看起来像随机顺序。
      // 按条目号排 = 按台账顺序。前缀 A/B/C 的字母序恰好就是销售 → 工艺 → 五金，
      // 所以单键就够，不用再叠 `source`。
      //
      // 以前按「来源 → 分类 → 名称 → 规格」排：同名多行确实会挨在一起，但整体顺序
      // 与台账对不上 —— 销售翻着一张纸质台账问「这一行多少钱」，界面上找不到对应位置。
      // `code` 作为第二键，兜住「还没重导、ledger_no 为空」的旧行（会排在最前）。
      orderBy: [{ ledgerNo: 'asc' }, { code: 'asc' }],
      take: query.limit,
      skip: query.offset,
      select: ITEM_SELECT,
    }),
  ])

  const images = await loadImageVersions(
    rows.map((row) => row.imageKey).filter((key): key is string => key !== null),
  )

  return {
    version: dataset?.version ?? '',
    total,
    items: rows.map((row) =>
      toItemDto(row, row.imageKey === null ? null : (images.get(row.imageKey) ?? null)),
    ),
  }
}

/** 单条详情。带图元数据，不带字节（字节走取图接口，避免详情响应变成几 MB）。 */
export async function getItem(code: string): Promise<{
  version: string
  item: QuoteItemDto
  image: QuoteImageDto | null
} | null> {
  const [dataset, row] = await Promise.all([
    getLatestDataset(),
    prisma.quoteItem.findUnique({
      where: { code },
      select: ITEM_SELECT,
    }),
  ])
  if (row === null) return null

  const imageRow =
    row.imageKey === null
      ? null
      : await prisma.quoteItemImage.findFirst({
          where: { imageKey: row.imageKey, isActive: true },
          select: {
            imageKey: true,
            mime: true,
            width: true,
            height: true,
            bindType: true,
            byteSize: true,
            sourceRow: true,
            uploadedAt: true,
          },
        })

  const image = imageRow === null ? null : toImageDto(imageRow)
  // 用 imageRow 而不是 image 做窄化：TS 无法从 `image === null` 反推 `imageRow`
  // 非空，写成 `imageRow!` 会引入一处不该有的断言。
  const imageRef =
    imageRow === null
      ? null
      : { imageKey: imageRow.imageKey, version: imageVersionOf(imageRow.uploadedAt) }

  return {
    version: dataset?.version ?? '',
    item: toItemDto(row, imageRef),
    image,
  }
}

/** 分类清单。meta 一次带回，前端不必为筛选下拉再发一个请求。 */
export async function listCategories(): Promise<
  readonly { source: QuoteSource; name: string; count: number }[]
> {
  const rows = await prisma.quoteItem.groupBy({
    by: ['source', 'category'],
    where: { status: 'active' },
    _count: { _all: true },
  })
  return rows
    .map((row) => ({
      source: row.source as QuoteSource,
      name: row.category,
      count: row._count._all,
    }))
    .sort((a, b) =>
      a.source === b.source ? a.name.localeCompare(b.name, 'zh') : a.source.localeCompare(b.source),
    )
}

export async function getMeta(): Promise<QuoteMetaResponse> {
  const [dataset, categories, secret, imageCount] = await Promise.all([
    getLatestDataset(),
    listCategories(),
    prisma.quoteAccessSecret.findFirst({ select: { id: true } }),
    prisma.quoteItemImage.count({ where: { isActive: true } }),
  ])

  return {
    version: dataset?.version ?? '',
    itemCount: dataset?.itemCount ?? 0,
    imageCount: imageCount,
    importedAt: dataset?.importedAt ?? '',
    categories,
    hasSecret: secret !== null,
  }
}

/**
 * 台账现状统计。价格维护面板第 4 节那排 Pill 用它。
 *
 * ## 为什么不能读导入时写的那份 counts
 *
 * `quote_datasets` 里确实有一份 `imageBindExact` / `imageBindFamily`，但那是**导入
 * 那一刻**的快照。界面上传图、换图、解绑、停用都不经过导入器，快照立刻过期 ——
 * 而这一排数字存在的意义恰恰是回答「现在图绑得怎么样」。给一个导入当天的旧值，
 * 比给空更糟：它看起来是对的。
 *
 * ## 三条 groupBy，不用逐条查
 *
 * 条目侧按 `source + imageKey` 分组，图侧按 `imageKey + bindType` 分组，两边在内存
 * 里对一次。1225 条的规模下这就是三次索引扫描；逐条查会变成 1225 次。
 */
export async function getLedgerStats(): Promise<QuoteLedgerStatsDto> {
  const [itemGroups, imageGroups] = await Promise.all([
    prisma.quoteItem.groupBy({
      by: ['source', 'imageKey'],
      where: { status: 'active' },
      _count: { _all: true },
    }),
    prisma.quoteItemImage.groupBy({
      by: ['imageKey', 'bindType'],
      where: { isActive: true },
      _count: { _all: true },
    }),
  ])

  // imageKey → 绑定档位。同一个 key 理论上只会有一个档位（同一张图不可能既是
  // exact 又是 family），真出现多档时取先到的那个 —— 这只是兜底，不是正常路径。
  const bindOf = new Map<string, string>()
  for (const group of imageGroups) {
    if (!bindOf.has(group.imageKey)) bindOf.set(group.imageKey, group.bindType)
  }

  let exact = 0
  let family = 0
  let manual = 0
  let noImage = 0
  const referenced = new Set<string>()

  for (const group of itemGroups) {
    const count = group._count._all
    if (group.imageKey === null) {
      // 销售与工艺本来就不配图（629 条），把它们算进「无图」会让分母失去意义。
      if (group.source === 'hardware') noImage += count
      continue
    }
    referenced.add(group.imageKey)
    const bind = bindOf.get(group.imageKey)
    if (bind === 'exact') exact += count
    else if (bind === 'family') family += count
    else if (bind === 'manual') manual += count
  }

  // 有图、但一条条目都没指向它 —— 换图或停用之后留下的孤儿。这些图不该被清掉
  // （审计要能回看），但数量得让人看见，否则会一直悄悄涨。
  let unbound = 0
  for (const key of bindOf.keys()) {
    if (!referenced.has(key)) unbound += 1
  }

  return { exact, family, manual, noImage, imageFiles: bindOf.size, unbound }
}

/**
 * 最近的改价 / 停用 / 换图记录。价格维护面板第 6 节用它。
 *
 * 表里只存了 `itemCode` 与 `operatorId`，没有外键关系 —— 条目被归档、账号被删之后
 * 这两列仍然指向不存在的行。所以这里用两条 `IN` 补齐显示名，缺了就退回 code 与
 * 「未知」，**不做内连接**：内连接会让「条目已归档」的那条记录从审计里消失，而
 * 审计最不该丢掉的就是这类记录。
 */
export async function listRevisions(limit: number): Promise<QuoteRevisionListResponse> {
  const rows = await prisma.quoteRevision.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  if (rows.length === 0) return { items: [] }

  const codes = [...new Set(rows.map((row) => row.itemCode))]
  const operatorIds = [...new Set(rows.map((row) => row.operatorId))]

  const [items, users] = await Promise.all([
    prisma.quoteItem.findMany({
      where: { code: { in: codes } },
      select: { code: true, name: true },
    }),
    prisma.user.findMany({
      where: { id: { in: operatorIds } },
      select: { id: true, displayName: true },
    }),
  ])

  const nameOf = new Map(items.map((item) => [item.code, item.name]))
  const userOf = new Map(users.map((user) => [user.id, user.displayName]))

  const list: QuoteRevisionDto[] = rows.map((row) => ({
    id: row.id,
    itemCode: row.itemCode,
    itemName: nameOf.get(row.itemCode) ?? '',
    field: row.field,
    oldValue: row.oldValue ?? '',
    newValue: row.newValue ?? '',
    operatorName: userOf.get(row.operatorId) ?? '未知',
    reason: row.reason ?? '',
    createdAt: row.createdAt.toISOString(),
  }))

  return { items: list }
}

export type QuoteImageBytes = {
  bytes: Buffer
  mime: string
  version: string
  byteSize: number
}

/**
 * 取图字节。
 *
 * 只认 `isActive`。被替换掉的旧图仍然在库里（审计要能查到当时用的是哪张），但
 * 对外接口一律取不到 —— 否则「换了一张图」之后，旧 URL 还能看到旧图，用户会以为
 * 换图没生效。
 */
export async function readImage(
  imageKey: string,
  variant: 'thumb' | 'full',
): Promise<QuoteImageBytes | null> {
  const row = await prisma.quoteItemImage.findFirst({
    where: { imageKey, isActive: true },
    select: { data: true, thumb: true, mime: true, byteSize: true, uploadedAt: true },
  })
  if (row === null) return null
  return {
    bytes: Buffer.from(variant === 'thumb' ? row.thumb : row.data),
    mime: row.mime,
    version: imageVersionOf(row.uploadedAt),
    byteSize: row.byteSize,
  }
}

/**
 * 改价。
 *
 * 输入可以是金额（分），也可以是原文（`120 元/米`、`1.5 倍`）。给了原文就按
 * `parsePriceInput` 重新判形态 —— **不沿用旧的形态**：一条本来就是「按米」的价，
 * 改成纯数字之后应该变成「金额」，否则界面上会显示 `¥668/米`，而那个「/米」是
 * 上一次的残留。
 */
export async function updateItemPrice(
  code: string,
  input: { priceFen?: number | null; priceText?: string; reason?: string },
  operator: { userId: string; access: QuoteWriteAccess },
): Promise<QuoteResult<{ version: string; item: QuoteItemDto }>> {
  const reason = (input.reason ?? '').trim()
  if (reason.length > QUOTE_LIMITS.REASON_MAX) return { ok: false, reason: 'invalid_reason' }

  const hasFen = input.priceFen !== undefined
  const hasText = input.priceText !== undefined
  if (!hasFen && !hasText) return { ok: false, reason: 'invalid_price' }

  const fen = input.priceFen
  if (fen !== undefined && fen !== null) {
    // 负数与荒谬的大数都在这里挡住：`2147483647` 分是 2147 万元，已经超出这张表
    // 的语义（单件家具）。挡住它比让它进库后在某次求和里溢出要好。
    if (!Number.isInteger(fen) || fen < 0 || fen > 100_000_000) {
      return { ok: false, reason: 'invalid_price' }
    }
  }

  const row = await prisma.quoteItem.findUnique({
    where: { code },
    select: { code: true, priceKind: true, priceFen: true, priceText: true },
  })
  if (row === null) return { ok: false, reason: 'not_found' }

  let nextKind: QuotePriceKind
  let nextFen: number | null
  let nextText: string

  if (hasText) {
    const parsed = parsePriceInput(input.priceText ?? '')
    nextKind = parsed.kind
    nextFen = parsed.priceFen
    nextText = parsed.priceText
    // `amount` 形态下原文只作留档；数值以调用方给的金额为准（若有），否则用解析值。
    if (hasFen && input.priceFen !== undefined && input.priceFen !== null) {
      nextKind = 'amount'
      nextFen = input.priceFen
    }
    if (nextKind === 'empty' && hasFen && input.priceFen !== undefined) {
      nextKind = input.priceFen === null ? 'empty' : 'amount'
      nextFen = input.priceFen
    }
  } else if (hasFen) {
    nextFen = input.priceFen ?? null
    nextKind = nextFen === null ? 'empty' : 'amount'
    nextText = row.priceText
  } else {
    return { ok: false, reason: 'invalid_price' }
  }

  const version = await bumpDataset(`在线改价：${code}`)

  const [updated] = await prisma.$transaction([
    prisma.quoteItem.update({
      where: { code },
      data: {
        priceKind: nextKind,
        priceFen: nextFen,
        priceText: nextText,
        datasetVersion: version,
      },
      select: ITEM_SELECT,
    }),
    prisma.quoteRevision.create({
      data: {
        itemCode: code,
        field: 'price',
        oldValue: describePrice(row.priceKind as QuotePriceKind, row.priceFen, row.priceText),
        newValue: describePrice(nextKind, nextFen, nextText),
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: reason === '' ? null : reason,
      },
    }),
  ])

  const images = await loadImageVersions(updated.imageKey === null ? [] : [updated.imageKey])
  return {
    ok: true,
    value: {
      version,
      item: toItemDto(
        updated,
        updated.imageKey === null ? null : (images.get(updated.imageKey) ?? null),
      ),
    },
  }
}

/** 审计里存的是「当时显示的什么」，所以带上形态 —— 只存数字会看不出「1.5 倍」。 */
function describePrice(kind: QuotePriceKind, fen: number | null, text: string): string {
  if (kind === 'rule' || kind === 'multiplier' || kind === 'empty') return text === '' ? kind : text
  if (fen === null) return kind
  return `${fen}分`
}

/** 停用 / 恢复。**不物理删除**，理由见 schema 里 `status` 的注释。 */
export async function setItemStatus(
  code: string,
  status: QuoteItemStatus,
  reason: string,
  operator: { userId: string; access: QuoteWriteAccess },
): Promise<QuoteResult<{ version: string; item: QuoteItemDto }>> {
  const trimmed = reason.trim()
  if (trimmed.length > QUOTE_LIMITS.REASON_MAX) return { ok: false, reason: 'invalid_reason' }

  const row = await prisma.quoteItem.findUnique({
    where: { code },
    select: { code: true, status: true, imageKey: true },
  })
  if (row === null) return { ok: false, reason: 'not_found' }
  if (row.status === status) return { ok: false, reason: 'invalid_status' }

  const version = await bumpDataset(`状态变更：${code} → ${status}`)

  const [updated] = await prisma.$transaction([
    prisma.quoteItem.update({
      where: { code },
      data: { status, datasetVersion: version },
      select: ITEM_SELECT,
    }),
    prisma.quoteRevision.create({
      data: {
        itemCode: code,
        field: 'status',
        oldValue: row.status,
        newValue: status,
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: trimmed === '' ? null : trimmed,
      },
    }),
  ])

  const images = await loadImageVersions(updated.imageKey === null ? [] : [updated.imageKey])
  return {
    ok: true,
    value: {
      version,
      item: toItemDto(
        updated,
        updated.imageKey === null ? null : (images.get(updated.imageKey) ?? null),
      ),
    },
  }
}

/**
 * base64 → 可直接写库的字节。
 *
 * 先复制到一个按长度新建的 `Uint8Array`，而不是直接塞 `Buffer`：Prisma 的 Bytes
 * 在类型上是 `Uint8Array<ArrayBuffer>`，而 `Buffer` 是 `ArrayBufferLike`（可能是
 * SharedArrayBuffer），赋值过不了类型检查。长度构造的重载产出的正是前者。
 *
 * **`Buffer.from(str, 'base64')` 对非法输入不抛错**，它只是尽量解码并丢掉不认识
 * 的字符。所以「是不是合法图片」这件事只能靠下面的长度校验与浏览器端的解码，
 * 这一步不承担校验职责。
 */
function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.from(value, 'base64')
  const bytes = new Uint8Array(buffer.byteLength)
  bytes.set(buffer)
  return bytes
}

export type UploadImageInput = {
  data: string
  thumb: string
  width: number
  height: number
}

/**
 * 按魔数判图片类型。
 *
 * **不信客户端声明的 mime。** 声明一个与字节不符的类型不会有任何报错，只会让
 * 浏览器按错误的解码器去渲染（表现为一片空白），或者让一张 HTML 被当成图片存下来。
 * 四条魔数覆盖这个场景需要的全部格式，比引一个文件类型库便宜得多。
 */
function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'image/png'
  }
  // RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }
  return null
}

/** 缩略图的长边。与前端压缩器 `UPLOAD_THUMB_EDGE` 对齐。 */
const THUMB_EDGE = 320

/** 按长边等比缩放后的尺寸。只缩不放 —— 放大只会变糊，还多占一倍空间。 */
function thumbSize(width: number, height: number): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= THUMB_EDGE) return { width, height }
  const scale = THUMB_EDGE / longest
  return {
    // 至少留 1px：极端长条图的短边会算成 0，而 0 在画布上是直接报错。
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/**
 * 上传 / 替换某一行的商品图。
 *
 * **新图的键是这一行自己的 code**，`bindType` 记 `manual`。这一点是有意的：
 * 一行原本继承的是同族图（`family`），给它单独传一张之后，同族的其他行不该跟着变。
 * 所以新图的 imageKey 用条目自己的 code，条目指向它，族图原样留着。
 *
 * 旧图不删，只置 `is_active = false` 并记 `replaced_by`。
 */
export async function saveItemImage(
  code: string,
  input: UploadImageInput,
  operator: { userId: string; access: QuoteWriteAccess },
): Promise<QuoteResult<{ version: string; image: QuoteImageDto }>> {
  const row = await prisma.quoteItem.findUnique({
    where: { code },
    select: { code: true, imageKey: true },
  })
  if (row === null) return { ok: false, reason: 'not_found' }

  const data = decodeBase64(input.data)
  const thumb = decodeBase64(input.thumb)

  if (data.length === 0 || data.length > QUOTE_LIMITS.IMAGE_BYTES_MAX) {
    return { ok: false, reason: 'invalid_image' }
  }
  if (thumb.length === 0 || thumb.length > QUOTE_LIMITS.IMAGE_BYTES_MAX) {
    return { ok: false, reason: 'invalid_image' }
  }

  const mime = detectImageMime(data)
  if (mime === null) return { ok: false, reason: 'invalid_image' }

  const badEdge = (value: number): boolean =>
    !Number.isInteger(value) || value < 1 || value > QUOTE_LIMITS.IMAGE_EDGE_MAX
  if (badEdge(input.width) || badEdge(input.height)) return { ok: false, reason: 'invalid_image' }

  const thumbDimensions = thumbSize(input.width, input.height)

  const imageKey = row.code
  const version = await bumpDataset(`换图：${code}`)
  const newId = randomUUID()

  await prisma.$transaction([
    // 先把这一键上现有的活动图降级。注意 `replacedBy` 指向新行 id，方向是
    // 「旧的指向新的」—— 从旧图能追到「现在用的是哪张」，反过来追不到。
    prisma.quoteItemImage.updateMany({
      where: { imageKey, isActive: true },
      data: { isActive: false, replacedBy: newId },
    }),
    prisma.quoteItemImage.create({
      data: {
        id: newId,
        imageKey,
        data,
        thumb,
        mime,
        width: input.width,
        height: input.height,
        thumbWidth: thumbDimensions.width,
        thumbHeight: thumbDimensions.height,
        byteSize: data.length,
        bindType: 'manual',
        sourceRow: null,
        uploadedBy: operator.userId,
      },
    }),
    prisma.quoteItem.update({
      where: { code },
      data: { imageKey, datasetVersion: version },
    }),
    prisma.quoteRevision.create({
      data: {
        itemCode: code,
        field: 'image',
        oldValue: row.imageKey,
        newValue: imageKey,
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: '上传 / 替换商品图',
      },
    }),
  ])

  return {
    ok: true,
    value: {
      version,
      image: {
        key: imageKey,
        mime,
        width: input.width,
        height: input.height,
        bindType: 'manual',
        byteSize: data.length,
        sourceRow: null,
        uploadedAt: new Date().toISOString(),
      },
    },
  }
}

/**
 * 解绑。**不删字节。**
 *
 * 继承族图的行解绑后只是「不显示图」，族图本身属于别的行，不能因为这一行不要了
 * 就把它作废 —— 那会让同族另外十四行一起变空白。
 */
export async function removeItemImage(
  code: string,
  operator: { userId: string; access: QuoteWriteAccess },
): Promise<QuoteResult<{ version: string }>> {
  const row = await prisma.quoteItem.findUnique({
    where: { code },
    select: { code: true, imageKey: true },
  })
  if (row === null) return { ok: false, reason: 'not_found' }
  if (row.imageKey === null) return { ok: false, reason: 'invalid_image' }

  const version = await bumpDataset(`解绑图：${code}`)
  const ownsImage = row.imageKey === row.code

  await prisma.$transaction([
    ...(ownsImage
      ? [
          prisma.quoteItemImage.updateMany({
            where: { imageKey: row.imageKey, isActive: true },
            data: { isActive: false },
          }),
        ]
      : []),
    prisma.quoteItem.update({
      where: { code },
      data: { imageKey: null, datasetVersion: version },
    }),
    prisma.quoteRevision.create({
      data: {
        itemCode: code,
        field: 'image',
        oldValue: row.imageKey,
        newValue: null,
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: ownsImage ? '解绑并作废自己的图' : '解绑继承的族图',
      },
    }),
  ])

  return { ok: true, value: { version } }
}
