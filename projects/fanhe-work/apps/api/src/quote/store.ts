import { randomBytes, randomUUID } from 'node:crypto'

import {
  QUOTE_LIMITS,
  QUOTE_SOURCES,
  QUOTE_SOURCE_NAMES,
  parsePriceInput,
  type CreateQuoteItemRequest,
  type QuoteDatasetDto,
  type QuoteImportRow,
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
import { buildQuoteItemCode } from './keys.js'

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
  | 'not_found'
  | 'invalid_price'
  | 'invalid_reason'
  | 'invalid_image'
  | 'invalid_status'
  | 'invalid_name'
  | 'invalid_category'

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
export async function bumpDataset(note: string): Promise<string> {
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

/**
 * 分类清单。meta 一次带回，前端不必为筛选下拉再发一个请求。
 *
 * **顺序来自 `quote_categories`，不来自字典序。** 台账里的分类是自然顺序（柜体门板
 * → 木门 → 护墙板），`groupBy` 出来却是拼音序，读起来像被打乱过。没在表里落行的
 * 分类（还没人排过序的新导入）排在后面、按名称 —— 这样「刚导入一个新分类」不会插
 * 到列表中间，让人以为顺序乱了。
 *
 * 只返回**有条目**的分类：筛选栏里出现一个点进去必然为空的分类没有意义。空分类
 * 只在维护台出现（`listCategoryRows`）。
 */
export async function listCategories(): Promise<
  readonly { source: QuoteSource; name: string; count: number }[]
> {
  const [rows, persisted] = await Promise.all([
    prisma.quoteItem.groupBy({
      by: ['source', 'category'],
      where: { status: 'active' },
      _count: { _all: true },
    }),
    prisma.quoteCategory.findMany({ select: { source: true, name: true, sortOrder: true } }),
  ])

  const orderOf = new Map(persisted.map((row) => [`${row.source}\u001f${row.name}`, row.sortOrder]))
  const sourceRank = (source: string): number => {
    const index = QUOTE_SOURCES.indexOf(source as QuoteSource)
    return index === -1 ? QUOTE_SOURCES.length : index
  }

  return rows
    .map((row) => ({
      source: row.source as QuoteSource,
      name: row.category,
      count: row._count._all,
    }))
    .sort((a, b) => {
      if (a.source !== b.source) return sourceRank(a.source) - sourceRank(b.source)
      const orderA = orderOf.get(`${a.source}\u001f${a.name}`) ?? Number.MAX_SAFE_INTEGER
      const orderB = orderOf.get(`${b.source}\u001f${b.name}`) ?? Number.MAX_SAFE_INTEGER
      if (orderA !== orderB) return orderA - orderB
      return a.name.localeCompare(b.name, 'zh')
    })
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

  /**
   * 变更记录里的「项目」一列。
   *
   * 除了条目号，还有两种不是条目的写入会落进这张表：分类改名 / 合并（`cat:<source>`）
   * 与批量导入（`import`）。它们 join 不到条目，直接显示 `cat:sale` 会让人以为
   * 库里有一条叫这个名字的产品。
   */
  function subjectOf(code: string): string {
    if (code === 'import') return '批量导入'
    if (code.startsWith('cat:')) {
      const source = code.slice(4) as QuoteSource
      return `分类 · ${QUOTE_SOURCE_NAMES[source] ?? source}`
    }
    return nameOf.get(code) ?? ''
  }

  const list: QuoteRevisionDto[] = rows.map((row) => ({
    id: row.id,
    itemCode: row.itemCode,
    itemName: subjectOf(row.itemCode),
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

/**
 * 列宽上限。**与导入器同一份口径**（`tools/quote-import.ts` 里的 `COLUMN_MAX`）：
 * 两处不一致的后果是「界面上能存下的名字，导入时被截断」，而界面上看不出来。
 */
const ITEM_COLUMN_MAX = {
  category: 80,
  name: 200,
  model: 120,
  spec: 160,
  unit: 24,
  unitRaw: 24,
  priceText: 200,
  note: 400,
  pricingMode: 40,
  materials: 300,
  ledgerNo: 12,
} as const

/** 折叠空白再截断。新产品是手输的，粘贴进来的多行文本要压成一行。 */
function clipText(value: string, max: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

/**
 * 手动新增产品的条目号。
 *
 * 台账里的号是 `A001` / `B001` / `C001`（按来源），手动新增的用 `M` 前缀另开一串 ——
 * 混进台账号里会让「拿纸质台账对号」这件事失效。列表按 `ledger_no` 排序，`M` 在
 * `A/B/C` 之后，新产品自然排在各自来源的末尾。
 */
async function nextManualLedgerNo(source: QuoteSource): Promise<string> {
  const rows = await prisma.quoteItem.findMany({
    where: { source, ledgerNo: { startsWith: 'M' } },
    select: { ledgerNo: true },
  })
  let max = 0
  for (const row of rows) {
    const matched = /^M(\d{1,8})$/.exec(row.ledgerNo)
    if (matched !== null) max = Math.max(max, Number(matched[1]))
  }
  return `M${String(max + 1).padStart(3, '0')}`
}

/**
 * 新增产品（维护台上传）。
 *
 * ## 键仍然由五元组算，不接受客户端给
 *
 * 客户端算一遍、服务端再算一遍，只要有一处折叠空白的规则不同，同一条产品就会拿到
 * 两个键 —— 表现为「刚加的产品，搜出来有两条」。所以 `code` 只在这里生成。
 *
 * ## 撞上已下架的同名行 = 恢复，不是新建
 *
 * 台账里删掉的产品转 `archived`。再把它加回来时，如果算出一个新键，历史报价单上
 * 那条 `archived` 记录就永远对不上新产品了。所以先找「同五元组里第一个 archived
 * 的键」复用，并把 `ledger_no` 保留原值。
 *
 * ## 同名同规格可以有多条
 *
 * 台账里确实有（板式工艺同名但说明与收费不同）。所以不是「查重就拒」，而是按
 * `occurrence` 往后找第一个空位，与导入器的规则完全一致。
 *
 * ## 图片与条目在同一个事务里
 *
 * 新产品没有 code，图的键又必须是 code（`saveItemImage` 的规则），所以图片只能等
 * 条目建好之后才绑。把「写条目 + 写图字节 + 指过去」放进一个事务，就消掉了那个
 * 中间态：要么两样都在，要么一行都没写。校验放在**写库之前**，因为一次失败的
 * 新增如果留下了一行没有图的产品，操作员看到的是「保存失败」，不会想到库里已经
 * 多了一条。
 */
export async function createItem(
  input: CreateQuoteItemRequest,
  operator: { userId: string; access: QuoteWriteAccess },
): Promise<QuoteResult<{ version: string; item: QuoteItemDto }>> {
  const category = clipText(input.category, ITEM_COLUMN_MAX.category)
  const name = clipText(input.name, ITEM_COLUMN_MAX.name)
  if (name === '') return { ok: false, reason: 'invalid_name' }
  if (category === '') return { ok: false, reason: 'invalid_category' }

  // 图在写库前先验一遍。`invalid_image` 与换图接口同一个错误码、同一套判据。
  const image = input.image === undefined ? null : validateImage(input.image)
  if (input.image !== undefined && image === null) return { ok: false, reason: 'invalid_image' }

  const base = {
    source: input.source,
    category,
    name,
    model: clipText(input.model ?? '', ITEM_COLUMN_MAX.model),
    spec: clipText(input.spec ?? '', ITEM_COLUMN_MAX.spec),
  }

  const siblings = await prisma.quoteItem.findMany({
    where: base,
    select: { code: true, status: true, ledgerNo: true },
  })
  const known = new Map(siblings.map((row) => [row.code, row]))

  let code: string | null = null
  let restoringLedgerNo: string | null = null
  for (let occurrence = 0; occurrence < 64; occurrence += 1) {
    const candidate = buildQuoteItemCode({ ...base, occurrence })
    const row = known.get(candidate)
    if (row === undefined) {
      code = candidate
      break
    }
    if (row.status === 'archived') {
      code = candidate
      restoringLedgerNo = row.ledgerNo
      break
    }
  }
  // 64 个位置都被占满只可能是异常数据；当作「名字不可用」报出去，而不是覆盖某一行。
  if (code === null) return { ok: false, reason: 'invalid_name' }

  const parsed = parsePriceInput(clipText(input.priceText ?? '', ITEM_COLUMN_MAX.priceText))
  const ledgerNo = restoringLedgerNo ?? (await nextManualLedgerNo(input.source))
  const version = await bumpDataset(`新增产品：${code}`)

  const data = {
    ...base,
    ledgerNo,
    pricingMode: clipText(input.pricingMode ?? '', ITEM_COLUMN_MAX.pricingMode),
    materials: clipText(input.materials ?? '', ITEM_COLUMN_MAX.materials),
    unit: clipText(input.unit ?? '', ITEM_COLUMN_MAX.unit),
    unitRaw: clipText(input.unitRaw ?? '', ITEM_COLUMN_MAX.unitRaw),
    priceKind: parsed.kind,
    priceFen: parsed.priceFen,
    priceText: parsed.priceText,
    note: clipText(input.note ?? '', ITEM_COLUMN_MAX.note),
    status: 'active' as const,
    datasetVersion: version,
  }

  // 图键用条目自己的 code —— 与 `saveItemImage` 一致，手工图不挂在产品族上，
  // 否则同族的十几行会跟着一起换图。
  const imageKey = code
  const imageId = image === null ? null : randomUUID()
  const baseReason = restoringLedgerNo === null ? '新增产品' : '重新上架'

  const [saved] = await prisma.$transaction([
    restoringLedgerNo === null
      ? prisma.quoteItem.create({
          data: { code, ...data, ...(image === null ? {} : { imageKey }) },
          select: ITEM_SELECT,
        })
      : // 恢复：不带图时 `imageKey` 不在更新字段里 —— 下架前绑的图还在，重新上架
        // 不该丢图。带了图就用新图覆盖旧的。
        prisma.quoteItem.update({
          where: { code },
          data: { ...data, ...(image === null ? {} : { imageKey }) },
          select: ITEM_SELECT,
        }),
    // 旧图不删字节，只降级并记 `replaced_by`。恢复一条已下架的行时，它可能挂着自己
    // 上次的图，那一条同样要让位。
    ...(image === null || imageId === null
      ? []
      : [
          prisma.quoteItemImage.updateMany({
            where: { imageKey, isActive: true },
            data: { isActive: false, replacedBy: imageId },
          }),
          prisma.quoteItemImage.create({
            data: {
              id: imageId,
              imageKey,
              ...image,
              byteSize: image.data.length,
              bindType: 'manual',
              sourceRow: null,
              uploadedBy: operator.userId,
            },
          }),
        ]),
    prisma.quoteRevision.create({
      data: {
        itemCode: code,
        field: 'product',
        oldValue: restoringLedgerNo === null ? null : 'archived',
        newValue: 'active',
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: image === null ? baseReason : `${baseReason}（含商品图）`,
      },
    }),
  ])

  const images = await loadImageVersions(saved.imageKey === null ? [] : [saved.imageKey])
  return {
    ok: true,
    value: {
      version,
      item: toItemDto(saved, saved.imageKey === null ? null : (images.get(saved.imageKey) ?? null)),
    },
  }
}

/**
 * 批量导入：把确认过的行写进库。
 *
 * ## 只 upsert，不归档
 *
 * 台账全量导入（CLI 那条路）会把「本次没出现」的行转 archived —— 那是整表重导的
 * 语义。这里的输入是**一份增量文件**（新品报价、供应商调价单），把它当成全量会让
 * 一次只导 20 行的操作顺手把 1205 行全部下架。下架是维护台里单独的按钮。
 *
 * ## 幂等靠业务键
 *
 * 与导入器同一套键：同一份文件导两次，第二次全是 `unchanged`，不产生重复行。这
 * 正是「确认页可以反复点」的前提。
 *
 * ## 版本号只 bump 一次
 *
 * 逐行 bump 会让前端收到一串中间版本；一次批量导入对客户端来说就是「价格变了」，
 * 一个号足够。
 */
export async function applyImportRows(
  source: QuoteSource,
  rows: readonly QuoteImportRow[],
  operator: { userId: string; access: QuoteWriteAccess },
): Promise<
  QuoteResult<{ version: string; added: number; changed: number; unchanged: number; total: number }>
> {
  if (rows.length === 0) return { ok: false, reason: 'invalid_name' }
  if (rows.length > QUOTE_LIMITS.IMPORT_ROWS_MAX) return { ok: false, reason: 'invalid_name' }

  // 同一批里出现两次同五元组时，靠 occurrence 分开 —— 与导入器、新增产品同一条规则。
  const seen = new Map<string, number>()
  const prepared = rows.map((row) => {
    const category = clipText(row.category, ITEM_COLUMN_MAX.category)
    const name = clipText(row.name, ITEM_COLUMN_MAX.name)
    const model = clipText(row.model, ITEM_COLUMN_MAX.model)
    const spec = clipText(row.spec, ITEM_COLUMN_MAX.spec)
    const tuple = [source, category, name, model, spec].join('\u001f')
    const occurrence = seen.get(tuple) ?? 0
    seen.set(tuple, occurrence + 1)
    return {
      code: buildQuoteItemCode({ source, category, name, model, spec, occurrence }),
      category,
      name,
      model,
      spec,
      pricingMode: clipText(row.pricingMode, ITEM_COLUMN_MAX.pricingMode),
      materials: clipText(row.materials, ITEM_COLUMN_MAX.materials),
      unit: clipText(row.unit, ITEM_COLUMN_MAX.unit),
      // 识别器只有一列「单位」，归一值与原文取同一个 —— 台账里两者的差别（`㎡` 与
      // `平方`）是导入器按来源做的归一，界面上手填的行没有这个上下文。
      unitRaw: clipText(row.unit, ITEM_COLUMN_MAX.unitRaw),
      priceText: clipText(row.priceText, ITEM_COLUMN_MAX.priceText),
      note: clipText(row.note, ITEM_COLUMN_MAX.note),
      ledgerNo: clipText(row.ledgerNo, ITEM_COLUMN_MAX.ledgerNo),
    }
  })

  const existing = new Map(
    (
      await prisma.quoteItem.findMany({
        where: { code: { in: prepared.map((row) => row.code) } },
        select: { code: true, priceKind: true, priceFen: true, priceText: true, status: true },
      })
    ).map((row) => [row.code, row]),
  )

  // 没带条目号的行按 `M` 续号。留空会让它们全部排到列表最前，而且彼此分不出先后。
  let manualSeq = 0
  {
    const manualRows = await prisma.quoteItem.findMany({
      where: { source, ledgerNo: { startsWith: 'M' } },
      select: { ledgerNo: true },
    })
    for (const row of manualRows) {
      const matched = /^M(\d{1,8})$/.exec(row.ledgerNo)
      if (matched !== null) manualSeq = Math.max(manualSeq, Number(matched[1]))
    }
  }

  const version = await bumpDataset(`批量导入：${source} ${rows.length} 行`)
  let added = 0
  let changed = 0
  let unchanged = 0

  const CHUNK = 100
  for (let offset = 0; offset < prepared.length; offset += CHUNK) {
    const slice = prepared.slice(offset, offset + CHUNK)
    await prisma.$transaction(
      slice.map((row) => {
        const before = existing.get(row.code)
        const parsed = parsePriceInput(row.priceText)
        const ledgerNo =
          row.ledgerNo !== '' ? row.ledgerNo : `M${String(++manualSeq).padStart(3, '0')}`

        if (before === undefined) added += 1
        else if (
          before.priceKind !== parsed.kind ||
          before.priceFen !== parsed.priceFen ||
          before.priceText !== parsed.priceText ||
          before.status !== 'active'
        ) {
          changed += 1
        } else {
          unchanged += 1
        }

        const data = {
          source,
          category: row.category,
          name: row.name,
          model: row.model,
          spec: row.spec,
          ledgerNo,
          pricingMode: row.pricingMode,
          materials: row.materials,
          unit: row.unit,
          unitRaw: row.unitRaw,
          priceKind: parsed.kind,
          priceFen: parsed.priceFen,
          priceText: parsed.priceText,
          note: row.note,
          status: 'active',
          datasetVersion: version,
        }

        // `imageKey` 不在更新字段里：手工绑的图不该被一次导入顶掉。
        return prisma.quoteItem.upsert({
          where: { code: row.code },
          create: { code: row.code, ...data },
          update: data,
        })
      }),
    )
  }

  await prisma.quoteRevision.create({
    data: {
      itemCode: 'import',
      field: 'import',
      oldValue: null,
      newValue: `新增 ${added} / 更新 ${changed} / 未变 ${unchanged}`,
      operatorId: operator.userId,
      unlockSessionId: operator.access.unlockSessionId,
      reason: `批量导入 ${source} ${rows.length} 行`,
    },
  })

  return { ok: true, value: { version, added, changed, unchanged, total: rows.length } }
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

/** 校验通过的一张图，字段名与 `QuoteItemImage` 的列对齐。 */
type ValidatedImage = {
  data: Uint8Array<ArrayBuffer>
  thumb: Uint8Array<ArrayBuffer>
  mime: string
  width: number
  height: number
  thumbWidth: number
  thumbHeight: number
}

/**
 * 把请求里的 base64 校验成可以落库的一张图。
 *
 * **抽成函数是为了让两条入口共用同一套判据**：`saveItemImage`（换图）与
 * `createItem`（新增产品时带图）。两处各写一份，只要阈值有一处不同，就会出现
 * 「同一张图换图能传、新增时传不上去」这种谁也说不清的现象 —— 而两处代码单看都
 * 是对的。
 *
 * 校验顺序是刻意的：先看长度（不必解码就能挡掉明显过大的串），再解码判魔数
 * （**不信客户端声明的 mime**），最后判边长。反过来先判边长的话，一段不是图片的
 * 文本会得到「尺寸不合法」，而真正的问题是「这不是图」。
 */
function validateImage(input: UploadImageInput): ValidatedImage | null {
  const data = decodeBase64(input.data)
  const thumb = decodeBase64(input.thumb)

  if (data.length === 0 || data.length > QUOTE_LIMITS.IMAGE_BYTES_MAX) return null
  if (thumb.length === 0 || thumb.length > QUOTE_LIMITS.IMAGE_BYTES_MAX) return null

  const mime = detectImageMime(data)
  if (mime === null) return null

  const badEdge = (value: number): boolean =>
    !Number.isInteger(value) || value < 1 || value > QUOTE_LIMITS.IMAGE_EDGE_MAX
  if (badEdge(input.width) || badEdge(input.height)) return null

  const thumbDimensions = thumbSize(input.width, input.height)
  return {
    data,
    thumb,
    mime,
    width: input.width,
    height: input.height,
    thumbWidth: thumbDimensions.width,
    thumbHeight: thumbDimensions.height,
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

  const validated = validateImage(input)
  if (validated === null) return { ok: false, reason: 'invalid_image' }

  const imageKey = row.code
  const version = await bumpDataset(`换图：${code}`)
  const newId = randomUUID()
  const { data, thumb, mime } = validated

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
        width: validated.width,
        height: validated.height,
        thumbWidth: validated.thumbWidth,
        thumbHeight: validated.thumbHeight,
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
        width: validated.width,
        height: validated.height,
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
