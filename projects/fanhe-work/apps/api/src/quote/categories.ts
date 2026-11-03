import {
  QUOTE_LIMITS,
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

export type CategoryFailure = 'not_found' | 'duplicate' | 'invalid_name' | 'invalid_source'

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
  const [groups, persisted, dataset] = await Promise.all([
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

  const sourceRank = (source: string): number => {
    const order: readonly string[] = ['sale', 'craft', 'hardware']
    const index = order.indexOf(source)
    return index === -1 ? order.length : index
  }

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
 * 合并：把 `from` 下的条目改挂到 `to`，删掉 `from` 行。
 *
 * `to` 不存在时自动创建 —— 这正是「自定义分类 + 合并」的组合用法：先把要保留的名字
 * 建出来，再把别的并进去。顺序取 `from` 原来的位置，这样合并之后列表不会跳。
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
  if (from === to) return { ok: false, reason: 'invalid_name' }

  const [fromRow, toRow, moved] = await Promise.all([
    prisma.quoteCategory.findUnique({ where: { source_name: { source, name: from } } }),
    prisma.quoteCategory.findUnique({ where: { source_name: { source, name: to } } }),
    prisma.quoteItem.count({ where: { source, category: from } }),
  ])
  if (fromRow === null && moved === 0) return { ok: false, reason: 'not_found' }

  const version = await bumpDataset(`分类合并：${source} ${from} → ${to}`)
  const sortOrder = toRow?.sortOrder ?? fromRow?.sortOrder ?? (await nextSortOrder(source))

  await prisma.$transaction([
    prisma.quoteItem.updateMany({
      where: { source, category: from },
      data: { category: to, datasetVersion: version },
    }),
    toRow === null
      ? prisma.quoteCategory.create({ data: { source, name: to, sortOrder } })
      : prisma.quoteCategory.update({
          where: { source_name: { source, name: to } },
          data: { sortOrder },
        }),
    ...(fromRow === null
      ? []
      : [prisma.quoteCategory.delete({ where: { source_name: { source, name: from } } })]),
    prisma.quoteRevision.create({
      data: {
        itemCode: categoryRef(source),
        field: 'category',
        oldValue: from,
        newValue: to,
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: '分类合并',
      },
    }),
  ])

  return { ok: true, value: { version, from, to, moved } }
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
