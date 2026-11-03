import {
  QUOTE_LIMITS,
  QUOTE_SOURCES,
  QUOTE_SOURCE_NAMES,
  QUOTE_SOURCE_SHORT,
  type QuoteSourceDto,
  type QuoteSourceListResponse,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'

import type { QuoteWriteAccess } from './access.js'

/**
 * 主类（数据来源）维护：列表、新建、编辑、删除。
 *
 * ## 这一层只做三件事，每件都有明确的理由
 *
 * 1. **把写死的三条搬进库**。新增一类是业务动作，不该跟着发一次版本。
 * 2. **算好「能不能删」**。判据要含已下架条目，前端默认只拉在售的，自己判会误放行。
 * 3. **守住 `code` 不可改**。它是每条产品业务键的第 0 段，改了等于把这一类下所有
 *    条目的主键换掉 —— 图、审计、历史报价同时失联，而且全过程不报错。
 *
 * ## 删除很克制
 *
 * 条目只会转 archived、不物理删，所以「把这一类清空」在界面里做不到。结果是内置
 * 三类永远删不掉（它们各有几百条），这不是缺陷 —— `sale` 还牵着导入器的文件名猜测
 * 与 `A/B/C` 号段。新建的空主类可以随便删。
 */

export type SourceFailure =
  'not_found' | 'duplicate' | 'invalid_name' | 'has_items' | 'builtin_locked'

export type SourceResult<T> = { ok: true; value: T } | { ok: false; reason: SourceFailure }

type Operator = { userId: string; access: QuoteWriteAccess }

/** 显示名规范化：折叠空白、去首尾、按列宽截断。 */
function normalizeName(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, QUOTE_LIMITS.SOURCE_NAME_MAX)
}

/**
 * 短名。留空时从名字里取 —— 中文名取前两个字（「销售查价系统」→「销售」），
 * 短名位只有 8 个字符，取多了会把首页卡那行挤断。
 */
function normalizeShort(value: string | undefined, name: string, fallbackIndex: number): string {
  const raw = (value ?? '').replace(/\s+/g, ' ').trim()
  if (raw !== '') return raw.slice(0, QUOTE_LIMITS.SOURCE_SHORT_MAX)
  if (name !== '') return name.slice(0, 2)
  return `主类${String(fallbackIndex)}`
}

/**
 * 兜底：表为空时把内置三类插回去。
 *
 * 迁移里已经 INSERT 过一遍，这里是第二道。之所以留着：这张表一空，维护台顶部就
 * 一个 tab 都不剩，而 1225 条产品还挂在这三个 source 上 —— 界面看起来像整库丢了。
 * 内置三类各有几百条、永远删不掉，所以「删空后复活」这条路径实际走不到。
 */
async function ensureSources(): Promise<void> {
  const count = await prisma.quoteSourceRow.count()
  if (count > 0) return
  await prisma.quoteSourceRow.createMany({
    data: QUOTE_SOURCES.map((code, index) => ({
      code,
      name: QUOTE_SOURCE_NAMES[code],
      short: QUOTE_SOURCE_SHORT[code],
      ledgerPrefix: String.fromCharCode(65 + index),
      sortOrder: index,
      builtin: true,
    })),
  })
}

/** 生成一个新的 `code`：`c` + 6 位 base36。碰撞概率极低，仍然重试几次。 */
async function allocateCode(): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const code = `c${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`
    const existing = await prisma.quoteSourceRow.findUnique({
      where: { code },
      select: { id: true },
    })
    if (existing === null) return code
  }
  // 八次都撞上不是随机问题，是不该继续往下走。
  throw new Error('分配主类标识失败，请重试')
}

/**
 * 条目号前缀。A..Z 优先，用完再用 0..9。
 *
 * 前缀只有两个字符，且**创建后不可改** —— 台账里的「A001」印在纸质表上，改了以后
 * 历史条目号全是错的。所以分配时只看「有没有被占」，不做任何复用。
 */
async function allocatePrefix(): Promise<string> {
  const rows = await prisma.quoteSourceRow.findMany({ select: { ledgerPrefix: true } })
  const used = new Set(rows.map((row) => row.ledgerPrefix.toUpperCase()))
  const candidates = [
    ...Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index)),
    ...Array.from({ length: 10 }, (_, index) => String(index)),
  ]
  const free = candidates.find((value) => !used.has(value))
  return free ?? 'Z'
}

/**
 * 主类清单。
 *
 * 条目按 `source + status` 分两组数一次，不用逐类 `count`。三类变十类也只是
 * 十来个分组的差别，但逐类查会变成 N 次往返。
 */
export async function listSourceRows(): Promise<QuoteSourceListResponse> {
  await ensureSources()

  const [sources, groups] = await Promise.all([
    prisma.quoteSourceRow.findMany({ orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] }),
    prisma.quoteItem.groupBy({ by: ['source', 'status'], _count: { _all: true } }),
  ])

  const active = new Map<string, number>()
  const archived = new Map<string, number>()
  for (const group of groups) {
    const target = group.status === 'active' ? active : archived
    target.set(group.source, (target.get(group.source) ?? 0) + group._count._all)
  }

  const items: QuoteSourceDto[] = sources.map((row) => {
    const itemCount = active.get(row.code) ?? 0
    const archivedCount = archived.get(row.code) ?? 0
    const total = itemCount + archivedCount
    return {
      code: row.code,
      name: row.name,
      short: row.short,
      ledgerPrefix: row.ledgerPrefix,
      sortOrder: row.sortOrder,
      builtin: row.builtin,
      itemCount,
      archivedCount,
      deletable: total === 0 && !row.builtin,
      // 措辞按「最要紧的那条限制」给，不堆两句：内置的说内置，有条目的说条数。
      deleteBlockedReason:
        total > 0
          ? `这一类下面还有 ${String(total)} 条产品（其中 ${String(archivedCount)} 条已下架）。产品只能下架、不能物理删除，所以这个主类删不掉。`
          : row.builtin
            ? '这是内置主类。它的标识还被导入器与条目号段引用，不能删除。'
            : '',
    }
  })

  return { items }
}

/**
 * 这个来源是否存在。
 *
 * 路由层用它做语义校验 —— JSON Schema 只能卡「是 1–16 位小写字母数字」，卡不了
 * 「库里有没有这个主类」。不查就会写出一条 `source = 'cxxxx'` 的孤儿条目：它不在
 * 任何 tab 下，查价页永远看不到，而导入报告的「新增 N 条」是对的。
 */
export async function sourceExists(code: string): Promise<boolean> {
  await ensureSources()
  const row = await prisma.quoteSourceRow.findUnique({ where: { code }, select: { id: true } })
  return row !== null
}

/** 新建主类。`code` 与 `ledgerPrefix` 由服务端定死，之后不可改。 */
export async function createSource(
  rawName: string,
  rawShort: string | undefined,
  operator: Operator,
): Promise<SourceResult<QuoteSourceDto>> {
  const name = normalizeName(rawName)
  if (name === '') return { ok: false, reason: 'invalid_name' }

  const duplicated = await prisma.quoteSourceRow.findFirst({
    where: { name },
    select: { id: true },
  })
  if (duplicated !== null) return { ok: false, reason: 'duplicate' }

  const count = await prisma.quoteSourceRow.count()
  const code = await allocateCode()
  const short = normalizeShort(rawShort, name, count + 1)
  const created = await prisma.quoteSourceRow.create({
    data: {
      code,
      name,
      short,
      ledgerPrefix: await allocatePrefix(),
      sortOrder: count,
      builtin: false,
    },
  })

  void operator
  return {
    ok: true,
    value: {
      code: created.code,
      name: created.name,
      short: created.short,
      ledgerPrefix: created.ledgerPrefix,
      sortOrder: created.sortOrder,
      builtin: false,
      itemCount: 0,
      archivedCount: 0,
      deletable: true,
      deleteBlockedReason: '',
    },
  }
}

/**
 * 编辑。**只改显示名与短名**。
 *
 * `code` 与 `ledgerPrefix` 不在可改字段里，也不接受客户端传 —— 理由见文件头。
 * 名字允许改成与原来相同（那样是一次空改动，直接返回成功），但不允许撞别人的名字：
 * 顶部 tab 上两个一模一样的名字，人就分不清哪个是哪个了。
 */
export async function renameSource(
  rawCode: string,
  rawName: string,
  rawShort: string | undefined,
  operator: Operator,
): Promise<SourceResult<{ code: string; name: string; short: string }>> {
  const code = rawCode.trim()
  const name = normalizeName(rawName)
  if (name === '') return { ok: false, reason: 'invalid_name' }

  const row = await prisma.quoteSourceRow.findUnique({ where: { code } })
  if (row === null) return { ok: false, reason: 'not_found' }

  const duplicated = await prisma.quoteSourceRow.findFirst({
    where: { name, code: { not: code } },
    select: { id: true },
  })
  if (duplicated !== null) return { ok: false, reason: 'duplicate' }

  const short = normalizeShort(rawShort ?? row.short, name, row.sortOrder + 1)
  await prisma.quoteSourceRow.update({ where: { code }, data: { name, short } })

  void operator
  return { ok: true, value: { code, name, short } }
}

/**
 * 删除。判据与 `deletable` 完全一致 —— 列表上按钮亮着就一定删得掉，亮着却删不掉
 * 是最招人烦的一种不一致。
 *
 * 顺带清掉该主类在 `quote_categories` 里的行。条目为 0 时那些行已经没用了，留着会让
 * 下次新建同名主类时凭空多出一堆分类。
 */
export async function deleteSource(
  rawCode: string,
  operator: Operator,
): Promise<SourceResult<{ code: string; name: string }>> {
  const code = rawCode.trim()
  const row = await prisma.quoteSourceRow.findUnique({ where: { code } })
  if (row === null) return { ok: false, reason: 'not_found' }

  const total = await prisma.quoteItem.count({ where: { source: code } })
  if (total > 0) return { ok: false, reason: 'has_items' }
  if (row.builtin) return { ok: false, reason: 'builtin_locked' }

  await prisma.$transaction([
    prisma.quoteCategory.deleteMany({ where: { source: code } }),
    prisma.quoteSourceRow.delete({ where: { code } }),
  ])

  void operator
  return { ok: true, value: { code, name: row.name } }
}
