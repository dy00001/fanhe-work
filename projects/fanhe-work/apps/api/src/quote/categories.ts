import {
  QUOTE_LIMITS,
  type DeleteQuoteCategoryResponse,
  type QuoteCategoryDto,
  type QuoteCategoryListResponse,
  type QuoteSource,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'

import type { QuoteWriteAccess } from './access.js'
import { bumpDataset } from './store.js'

/**
 * 分类维护：列表、新建、改名、合并、排序。
 *
 * ## 分类的真值在 `quote_items.category`，这张表只补两件事
 *
 * 「顺序」与「空分类」—— 两件 `groupBy` 表达不了的事。所以：
 *
 * - **改名 / 合并必须改条目**，不只是改这张表。只改表的话，筛选栏按表里的名字列出
 *   一个新名字，点进去 `WHERE category = '新名'` 一条都查不到，而界面上不会报错。
 * - **排序只改这张表**，条目一行不动，也不 bump 数据集版本：价格没变，客户端手里
 *   的缓存价格仍然成立。
 *
 * ## 合并 = 改挂 + 删行，不是「隐藏 from」
 *
 * 留着 from 行会让它继续出现在维护台的分类列表里，看起来像合并没生效。历史报价单
 * 追溯的是 `quote_revisions` 与条目的 `code`，与分类名无关 —— 删掉这行不丢信息。
 *
 * ## 所有写操作都留痕
 *
 * `quote_revision.itemCode` 填 `cat:<source>`。它不是条目号，`listRevisions` 会把这
 * 个前缀翻成「分类 · 销售查价系统」再显示 —— 见 `store.ts` 的 `listRevisions`。
 */

export type CategoryFailure =
  | 'not_found'
  | 'duplicate'
  | 'invalid_name'
  | 'invalid_source'
  /** 批量合并时选了不到两个分类 —— 那不是合并，是改名。 */
  | 'too_few'
  /** 目标名出现在源列表里，或者保留条不在候选里。 */
  | 'invalid_target'
  /** 这个分类下还有产品（在售或已下架），删了它们就成了谁都找不到的孤儿。 */
  | 'has_items'

export type CategoryResult<T> = { ok: true; value: T } | { ok: false; reason: CategoryFailure }

type Operator = { userId: string; access: QuoteWriteAccess }

/** 分类名规范化：折叠空白（台账里有带换行的分类名）、去首尾、截到列宽。 */
function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, QUOTE_LIMITS.CATEGORY_NAME_MAX)
}

function categoryRef(source: QuoteSource): string {
  return `cat:${source}`
}

/**
 * 维护台要的完整清单：**表里的（含空分类）∪ 条目里出现过的**。
 *
 * 两边取并集而不是只读表：刚导入的一批数据里新出现的分类还没人排过序，只读表会
 * 让它们从维护台上消失，而人正要在那里给它们排序。
 */
export async function listCategoryRows(): Promise<QuoteCategoryListResponse> {
  const [groups, persisted, dataset, sourceRows] = await Promise.all([
    prisma.quoteItem.groupBy({
      by: ['source', 'category'],
      where: { status: 'active' },
      _count: { _all: true },
    }),
    prisma.quoteCategory.findMany({ select: { source: true, name: true, sortOrder: true } }),
    prisma.quoteDataset.findFirst({
      orderBy: { importedAt: 'desc' },
      select: { version: true },
    }),
    // 来源的先后从主类表来。写死 `['sale','craft','hardware']` 的话，新建的主类
    // 会排到所有内置来源之后 —— 而人是按自己建它的顺序找它的。
    prisma.quoteSourceRow.findMany({ select: { code: true, sortOrder: true } }),
  ])

  const counts = new Map(
    groups.map((row) => [`${row.source}\u001f${row.category}`, row._count._all]),
  )
  const rows = new Map<string, QuoteCategoryDto>()

  for (const row of persisted) {
    const key = `${row.source}\u001f${row.name}`
    rows.set(key, {
      source: row.source as QuoteSource,
      name: row.name,
      count: counts.get(key) ?? 0,
      sortOrder: row.sortOrder,
      persisted: true,
    })
  }
  for (const group of groups) {
    const key = `${group.source}\u001f${group.category}`
    if (rows.has(key)) continue
    rows.set(key, {
      source: group.source as QuoteSource,
      name: group.category,
      count: group._count._all,
      sortOrder: Number.MAX_SAFE_INTEGER,
      persisted: false,
    })
  }

  const rankOf = new Map(sourceRows.map((row) => [row.code, row.sortOrder]))
  const sourceRank = (source: string): number => rankOf.get(source) ?? Number.MAX_SAFE_INTEGER

  const items = [...rows.values()].sort((a, b) => {
    if (a.source !== b.source) return sourceRank(a.source) - sourceRank(b.source)
    if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder
    return a.name.localeCompare(b.name, 'zh')
  })

  return { version: dataset?.version ?? '', items }
}

/**
 * 该来源下一个可用的顺序号。新分类排到末尾，而不是插到 0 —— 插到 0 会把它顶到
 * 第一位，而刚建的分类多半是「还没想好放哪」。
 */
async function nextSortOrder(source: QuoteSource): Promise<number> {
  const row = await prisma.quoteCategory.findFirst({
    where: { source },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  })
  return row === null ? 0 : row.sortOrder + 1
}

/** 新建空分类。**不 bump 版本**：没有任何条目变了，客户端的缓存价格仍然有效。 */
export async function createCategory(
  source: QuoteSource,
  rawName: string,
  operator: Operator,
): Promise<CategoryResult<QuoteCategoryDto>> {
  const name = normalizeName(rawName)
  if (name === '') return { ok: false, reason: 'invalid_name' }

  const existing = await prisma.quoteCategory.findUnique({
    where: { source_name: { source, name } },
    select: { id: true },
  })
  if (existing !== null) return { ok: false, reason: 'duplicate' }

  // 条目里已经有人用这个分类名（还没落表）时，直接把它落表，而不是报「重复」——
  // 从维护台上看，这两种情况是同一件事：这个名字已经有了。
  const count = await prisma.quoteItem.count({ where: { source, category: name } })

  const created = await prisma.quoteCategory.create({
    data: { source, name, sortOrder: await nextSortOrder(source) },
    select: { name: true, sortOrder: true },
  })

  void operator
  return {
    ok: true,
    value: { source, name: created.name, count, sortOrder: created.sortOrder, persisted: true },
  }
}

/**
 * 改名。条目与分类表一起改。
 *
 * 目标名已被占用时给 `duplicate`，而不是自动合并 —— 两者意图不同：改名是「这个分类
 * 换个叫法」，合并是「两个分类其实是一个」。自动合并会安静地吃掉另一个分类，而人
 * 只是想改个字。
 */
export async function renameCategory(
  source: QuoteSource,
  rawFrom: string,
  rawTo: string,
  operator: Operator,
): Promise<CategoryResult<{ version: string; from: string; to: string; moved: number }>> {
  const from = normalizeName(rawFrom)
  const to = normalizeName(rawTo)
  if (to === '') return { ok: false, reason: 'invalid_name' }
  if (from === to) {
    return { ok: true, value: { version: '', from, to, moved: 0 } }
  }

  const [fromRow, toRow, moved] = await Promise.all([
    prisma.quoteCategory.findUnique({ where: { source_name: { source, name: from } } }),
    prisma.quoteCategory.findUnique({
      where: { source_name: { source, name: to } },
      select: { id: true },
    }),
    prisma.quoteItem.count({ where: { source, category: from } }),
  ])
  if (toRow !== null) return { ok: false, reason: 'duplicate' }
  if (fromRow === null && moved === 0) return { ok: false, reason: 'not_found' }

  const version = await bumpDataset(`分类改名：${source} ${from} → ${to}`)

  await prisma.$transaction([
    prisma.quoteItem.updateMany({
      where: { source, category: from },
      data: { category: to, datasetVersion: version },
    }),
    fromRow === null
      ? prisma.quoteCategory.create({
          data: { source, name: to, sortOrder: await nextSortOrder(source) },
        })
      : prisma.quoteCategory.update({
          where: { source_name: { source, name: from } },
          data: { name: to },
        }),
    prisma.quoteRevision.create({
      data: {
        itemCode: categoryRef(source),
        field: 'category',
        oldValue: from,
        newValue: to,
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: '分类改名',
      },
    }),
  ])

  return { ok: true, value: { version, from, to, moved } }
}

/**
 * 删掉一个分类（连同它在 `quote_categories` 里的那一行）。
 *
 * ## 只允许删空的
 *
 * 这张表只负责「有哪些分类 + 顺序」，产品上的 `category` 是另一份值。删掉一个**还有
 * 产品**的分类，那些产品会挂在一个「列表里查不到、筛选栏里也没有」的名字下 —— 它们
 * 仍在库里、仍能被搜索命中，但界面上没有任何入口指向它们，也就永远删不掉了。所以判据
 * 是 `count === 0`，在售与已下架一起算：已下架的条目同样是一个还能上架回来的东西。
 *
 * 拒绝时给 `has_items`，让操作员先合并或先处理产品。
 *
 * ## 不 bump 版本
 *
 * 一条产品都没动，客户端的缓存价格仍然成立 —— 与 `createCategory` 同一个判断，
 * 也与「排序不 bump」一致。
 */
export async function deleteCategory(
  source: QuoteSource,
  rawName: string,
  operator: Operator,
): Promise<CategoryResult<DeleteQuoteCategoryResponse>> {
  const name = normalizeName(rawName)
  if (name === '') return { ok: false, reason: 'invalid_name' }

  const [row, total] = await Promise.all([
    prisma.quoteCategory.findUnique({
      where: { source_name: { source, name } },
      select: { id: true },
    }),
    prisma.quoteItem.count({ where: { source, category: name } }),
  ])
  // **先判「有没有产品」，再判「这一行在不在」**：分类名可以只出现在条目里而从没落过表
  // （导入的数据就是这样）。那种名字在维护台上照样是一行，点删该说「下面还有产品」，
  // 而不是「找不到这个分类」—— 后者会让人以为界面上的那一行是假的。
  if (total > 0) return { ok: false, reason: 'has_items' }
  if (row === null) return { ok: false, reason: 'not_found' }

  await prisma.$transaction([
    prisma.quoteCategory.delete({ where: { id: row.id } }),
    prisma.quoteRevision.create({
      data: {
        itemCode: categoryRef(source),
        field: 'category',
        oldValue: name,
        // 删除没有新值。写空串而不是 null：这一列在「改名 / 合并」里永远有值，
        // 留 null 会让读审计的人去猜是「没记」还是「删了」。
        newValue: '',
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: '删除分类',
      },
    }),
  ])

  return { ok: true, value: { version: '', name } }
}

/**
 * 合并的唯一写入实现：把 `fromList` 下所有条目改挂到 `to`，删掉这些行。
 *
 * 单条与批量都走这里，两者的差别只在入口校验（批量要求至少两个源、且不能把目标
 * 自己也列进去）。写两份实现的话，迟早有一处忘了删 `from` 行 —— 那一行会一直挂在
 * 维护台列表里，看起来像合并没生效。
 *
 * 顺序：`to` 已存在就保持它的位置；否则取源里最小的那个 `sort_order`，这样合并
 * 之后列表不会跳。
 */
async function applyMerge(
  source: QuoteSource,
  fromList: readonly string[],
  to: string,
  operator: Operator,
  reason: string,
): Promise<{ version: string; moved: number }> {
  const [fromRows, toRow, groups] = await Promise.all([
    prisma.quoteCategory.findMany({
      where: { source, name: { in: [...fromList] } },
      select: { name: true, sortOrder: true },
    }),
    prisma.quoteCategory.findUnique({ where: { source_name: { source, name: to } } }),
    prisma.quoteItem.groupBy({
      by: ['category'],
      where: { source, category: { in: [...fromList] } },
      _count: { _all: true },
    }),
  ])

  const moved = groups.reduce((sum, group) => sum + group._count._all, 0)
  const version = await bumpDataset(`${reason}：${source} ${fromList.join('、')} → ${to}`)
  const sortOrder =
    toRow?.sortOrder ??
    (fromRows.length === 0
      ? await nextSortOrder(source)
      : Math.min(...fromRows.map((row) => row.sortOrder)))

  // `old_value` 只有 400 字。批量合并十个分类时名字加起来会超，宁可截断也不能让
  // 整条事务因为「字符串太长」失败 —— psql 那里是硬报错，不是静默截断。
  const oldValue = fromList.join('、').slice(0, 400)

  await prisma.$transaction([
    prisma.quoteItem.updateMany({
      where: { source, category: { in: [...fromList] } },
      data: { category: to, datasetVersion: version },
    }),
    toRow === null
      ? prisma.quoteCategory.create({ data: { source, name: to, sortOrder } })
      : prisma.quoteCategory.update({
          where: { source_name: { source, name: to } },
          data: { sortOrder },
        }),
    prisma.quoteCategory.deleteMany({ where: { source, name: { in: [...fromList] } } }),
    prisma.quoteRevision.create({
      data: {
        itemCode: categoryRef(source),
        field: 'category',
        oldValue,
        newValue: to,
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason,
      },
    }),
  ])

  return { version, moved }
}

/**
 * 单个合并：把 `from` 下的条目改挂到 `to`，删掉 `from` 行。
 *
 * `to` 不存在时自动创建 —— 这正是「自定义分类 + 合并」的组合用法：先把要保留的名字
 * 建出来，再把别的并进去。
 */
export async function mergeCategory(
  source: QuoteSource,
  rawFrom: string,
  rawTo: string,
  operator: Operator,
): Promise<CategoryResult<{ version: string; from: string; to: string; moved: number }>> {
  const from = normalizeName(rawFrom)
  const to = normalizeName(rawTo)
  if (to === '') return { ok: false, reason: 'invalid_name' }
  if (from === to) return { ok: false, reason: 'invalid_target' }

  const [fromRow, moved] = await Promise.all([
    prisma.quoteCategory.findUnique({ where: { source_name: { source, name: from } } }),
    prisma.quoteItem.count({ where: { source, category: from } }),
  ])
  if (fromRow === null && moved === 0) return { ok: false, reason: 'not_found' }

  const result = await applyMerge(source, [from], to, operator, '分类合并')
  return { ok: true, value: { version: result.version, from, to, moved: result.moved } }
}

/**
 * 批量合并：多个分类并成一项。
 *
 * ## 为什么整体拒绝、不做部分成功
 *
 * 三个源里有一个已经被别人删了，最自然的实现是「合了能合的，跳过找不到的」。但界面
 * 上看到的是「合并完成」，列表里还剩一个同名分类 —— 操作员只会以为自己点错了，再合
 * 一次，于是又多一条审计。宁可整批失败并指明是哪个名字没了。
 *
 * ## 目标名可以是一个全新的名字，也可以就是选中的其中一个
 *
 * 「把 A、B、C 并成 D」是常见诉求（三个旧叫法统一成一个新叫法）。而「A、B、C 合并，
 * 名字保留 A」同样常见 —— 所以 `to` **允许出现在源列表里**，它在写入时会从源列表里
 * 剔除：留下的那个就是目标自己，不能「把 A 并到 A」。
 *
 * 早期版本把「目标在源里」判成 `invalid_target`，结果是想保留原名的用户必须先把 A
 * 排除、再手打一遍 A，而手打的名字只要差一个全角空格，就会建出一个看着一样的重复分类。
 */
export async function mergeCategories(
  source: QuoteSource,
  rawFrom: readonly string[],
  rawTo: string,
  operator: Operator,
): Promise<CategoryResult<{ version: string; to: string; from: string[]; moved: number }>> {
  const to = normalizeName(rawTo)
  if (to === '') return { ok: false, reason: 'invalid_name' }

  // 去重之后再数：前端多选里有重复项时不该报「太少」。
  const picked: string[] = []
  for (const raw of rawFrom) {
    const name = normalizeName(raw)
    if (name === '') return { ok: false, reason: 'invalid_name' }
    if (!picked.includes(name)) picked.push(name)
  }
  if (picked.length < 2) return { ok: false, reason: 'too_few' }

  // 目标自己不出现在 updateMany 的 `in` 里。它本来就是结果，再「并到它自己」是空操作；
  // 但它必须留在 `picked` 里，否则「A、B 合并、保留 A」会被判成只有一个源。
  const from = picked.filter((name) => name !== to)
  if (from.length === 0) return { ok: false, reason: 'too_few' }

  // 逐个核实在不在。既没有分类行、也没有条目 = 这个名字不存在。
  const [rows, groups] = await Promise.all([
    prisma.quoteCategory.findMany({
      where: { source, name: { in: picked } },
      select: { name: true },
    }),
    prisma.quoteItem.groupBy({
      by: ['category'],
      where: { source, category: { in: picked } },
      _count: { _all: true },
    }),
  ])
  const known = new Set<string>([...rows.map((row) => row.name), ...groups.map((g) => g.category)])
  const missing = picked.find((name) => !known.has(name))
  if (missing !== undefined) {
    // 用 `not_found` 而不是自定义 reason：前端本来就在处理这个码，多一个码要多一处
    // 文案映射，而这里能说的和「找不到分类」是同一句话。
    return { ok: false, reason: 'not_found' }
  }

  const result = await applyMerge(source, from, to, operator, '分类合并（多选）')
  return { ok: true, value: { version: result.version, to, from, moved: result.moved } }
}

/**
 * 重排。`order` 是该来源下的完整顺序，按下标写 `sort_order`。
 *
 * **不 bump 数据集版本**：价格没变。排序变化只影响 `meta.categories` 的先后，而
 * 版本号的语义是「你手里的价格还成不成立」—— 让它跟着排序变，等于每次拖一下都要
 * 全端重拉价格。
 */
export async function reorderCategories(
  source: QuoteSource,
  order: readonly string[],
  operator: Operator,
): Promise<CategoryResult<{ updated: number }>> {
  const names: string[] = []
  for (const raw of order) {
    const name = normalizeName(raw)
    if (name === '') return { ok: false, reason: 'invalid_name' }
    if (names.includes(name)) return { ok: false, reason: 'duplicate' }
    names.push(name)
  }
  if (names.length === 0) return { ok: false, reason: 'invalid_name' }

  await prisma.$transaction(
    names.map((name, index) =>
      prisma.quoteCategory.upsert({
        where: { source_name: { source, name } },
        create: { source, name, sortOrder: index },
        update: { sortOrder: index },
      }),
    ),
  )

  void operator
  return { ok: true, value: { updated: names.length } }
}
