import {
  NOTE_LIMITS,
  isValidNoteTag,
  normalizeNoteTags,
  normalizeSearchQuery,
  type CreateNoteRequest,
  type Note,
  type NoteTagCount,
  type UpdateNoteRequest,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import type { Prisma } from '../generated/prisma/client.js'

/**
 * 工作纪要的读写。
 *
 * **所有权在这一层强制，不在路由层。** 与 `launch/profiles.ts` 同一条规则：每个
 * 函数都要求传入 `userId`，且所有查询都把它写进 where 条件。靠路由层「先查一次
 * 确认归属、再调用 service」的做法，会在新增接口时被漏掉，而漏掉的表现是「换个
 * id 就能读别人的纪要」—— 这类缺陷不报错，只有被人主动尝试才会暴露。
 *
 * **归属不符与真的不存在，对外是同一种结果（404）。** 403 等于确认「这个 id 存在，
 * 只是不属于你」，而 id 是 UUID，能问出存在性就意味着可以逐个试探。
 *
 * 校验分工：路由的 JSON schema 管类型与长度上限（挡住超大请求体），本模块管业务
 * 规则（标题不能为空、标签归一与计数、时间范围能不能解析）。长度上限只在 schema
 * 里写一次，值取自共享包的常量，不在这里重复。
 *
 * **不写审计。** 与启动配置同一条判断：纪要是用户自己的私有数据，增删改的影响范围
 * 不超出他本人。给它记审计只会让 `audit_logs` 里混进大量噪音。
 */

export type NoteFailureReason =
  'not_found' | 'invalid_title' | 'invalid_content' | 'invalid_tags' | 'invalid_range'

export type NoteResult<T> = { ok: true; data: T } | { ok: false; reason: NoteFailureReason }

/**
 * 对外暴露的列。
 *
 * 显式列出而不是取整行：`userId` 与 `deletedAt` 属于服务端内部状态，泄漏出去只会
 * 让前端有机会依赖它们。新增列时也要在这里加一次，这个「多写一行」的代价换来的是
 * 「不会因为加了个内部字段就悄悄改了接口形状」。
 */
const NOTE_SELECT = {
  id: true,
  title: true,
  content: true,
  tags: true,
  pinned: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const

type NoteRow = {
  id: string
  title: string
  content: string
  tags: string[]
  pinned: boolean
  archivedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

function toNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: row.tags,
    pinned: row.pinned,
    archivedAt: row.archivedAt === null ? null : row.archivedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function invalid(reason: NoteFailureReason): NoteResult<never> {
  return { ok: false, reason }
}

/**
 * 标题去掉首尾空白后不能为空。
 *
 * 归一放在服务端而不是只靠前端 trim：前端漏做一次，库里就会出现「看起来一样的
 * 两个标题」，而列表上的标题长短不一会让人以为是渲染问题。
 */
function validateTitle(value: string): NoteResult<string> {
  const title = value.trim()
  if (title === '') return invalid('invalid_title')
  if (title.length > NOTE_LIMITS.TITLE_MAX) return invalid('invalid_title')
  return { ok: true, data: title }
}

/**
 * 正文**不做 trim**。
 *
 * Markdown 的前导空白有意义：缩进决定列表层级与代码块，首尾空行在编辑器里是用户
 * 看得见的东西。标题可以归一，正文不行 —— 归一正文等于悄悄改写了用户写下的内容，
 * 而他在大纲视图里看不出哪里变了。
 *
 * 空正文是合法的：先起个标题、内容回头再补，是记纪要时最常见的动作。
 */
function validateContent(value: string): NoteResult<string> {
  if (typeof value !== 'string') return invalid('invalid_content')
  if (value.length > NOTE_LIMITS.CONTENT_MAX) return invalid('invalid_content')
  return { ok: true, data: value }
}

function validateTags(value: readonly string[]): NoteResult<string[]> {
  if (!Array.isArray(value)) return invalid('invalid_tags')
  if (value.some((item) => typeof item !== 'string')) return invalid('invalid_tags')

  // 先归一去重再判上限：提交 25 个标签但其中有 10 个重复时，归一后是 15 个，那是
  // 一次合法提交。反过来先判上限再归一，会让「重复标签算不算数」变成一个只在边界
  // 上暴露的问题。
  const tags = normalizeNoteTags(value)
  if (tags.length > NOTE_LIMITS.TAGS_MAX_COUNT) return invalid('invalid_tags')
  if (tags.some((tag) => !isValidNoteTag(tag))) return invalid('invalid_tags')
  return { ok: true, data: tags }
}

/**
 * 列表筛选条件。
 *
 * 四个可选字段显式带上 `| undefined`。这个对象在路由层由查询参数拼出来，而查询
 * 参数缺省时读到的就是 `undefined`。项目开启了 `exactOptionalPropertyTypes`，不加
 * 这一项就必须在路由里为每个字段写一次条件赋值，而那只是一层语法噪音 —— 对筛选
 * 条件而言，「字段缺失」与「显式 undefined」是同一件事，都表示不过滤。
 *
 * 这个宽松只留给筛选对象，请求体类型（`UpdateNoteRequest` 等）不跟随：在那里
 * 「没传这个字段」与「传了 undefined」需要区分，因为前者表示不改，后者是一个
 * 需要被拒绝的非法输入。
 */
export type NoteListFilter = {
  /** 只返回带这个标签的纪要。空串与全空白按「不过滤」处理。 */
  tag?: string | undefined
  /** 为真只看已归档，否则只看未归档。没有「两者一起看」这一档。 */
  archived?: boolean | undefined
  /** 创建时间下界，可被 `Date` 解析的字符串。 */
  from?: string | undefined
  /** 创建时间上界。 */
  to?: string | undefined
  /** 关键词，同时匹配标题与正文。空串与全空白按「不检索」处理。 */
  search?: string | undefined
}

/**
 * 列表排序：置顶优先，然后按更新时间倒序，最后用创建时间兜底。
 *
 * `createdAt` 作为第三级键是有必要的：同一秒内创建或批量导入的纪要，`updatedAt`
 * 会撞到一起，那时排序结果随数据库的物理顺序变化，表现为「刷新一次顺序就变一次」。
 */
const NOTE_ORDER: Prisma.NoteOrderByWithRelationInput[] = [
  { pinned: 'desc' },
  { updatedAt: 'desc' },
  { createdAt: 'desc' },
]

/** 解析时间边界。解析不出来返回 null，由调用方转成 `invalid_range`。 */
function parseBoundary(value: string): Date | null {
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

export async function listNotes(
  userId: string,
  filter: NoteListFilter = {},
): Promise<NoteResult<Note[]>> {
  const where: Prisma.NoteWhereInput = { userId, deletedAt: null }

  // 归档状态用 null / not null 表达，不引入第三个「全部」档：界面上归档与未归档是
  // 两个视图，没有「一起看」的位置，而多一个档就要在每个视图里多一次判断。
  where.archivedAt = filter.archived === true ? { not: null } : null

  if (filter.tag !== undefined && filter.tag.trim() !== '') {
    where.tags = { has: filter.tag.trim() }
  }

  /**
   * 关键词检索：标题与正文各匹配一次，取并集。
   *
   * **中文不能用 `tsvector`，这条已经实测过，不要再试。** PostgreSQL 自带的分词器不认
   * 中文：`to_tsvector('simple', '衣柜门板安装说明')` 得到的是**整串一个词**
   * （`'衣柜门板安装说明':1`），于是 `to_tsquery('simple', '衣柜')` 匹配不上 ——
   * 照搬英文那套（`tsvector` + GIN）的结果是「搜什么都搜不到」，而现象看起来像索引
   * 没生效。本机也没有 `zhparser` / `pg_bigm` 这类中文分词扩展可用。
   *
   * **也没有走 `pg_trgm` 索引，理由是实测出来的：它对两个字的关键词根本不生效。**
   * 在三万行中文数据上建好 `gin (body gin_trgm_ops)` 之后，`ILIKE '%衣柜%'`（两字）
   * 仍然走 Seq Scan，而 `'%衣柜门%'`（三字）与 `'%安装说明%'`（四字）才走
   * Bitmap Index Scan —— pg_trgm 从少于三个字符的 **pattern** 里提取不出三元组。
   * 中文关键词恰恰常常就是两个字（衣柜、门板、抽屉），也就是说这个索引解决不了最
   * 典型的那类查询，却要额外带来一个扩展与一次迁移。
   *
   * 因此当前就是 `ILIKE`。单用户量级下（几百到几千条）顺序扫描是微秒级，够用。
   * **等到纪要量级上万、或进入多用户（阶段五）时再加索引**，写法已验证可用：
   * `@@index([title(ops: raw("gin_trgm_ops")), content(ops: raw("gin_trgm_ops"))], type: Gin)`，
   * 并在迁移里先 `CREATE EXTENSION IF NOT EXISTS pg_trgm`。注意那时两字查询仍会退化
   * 成顺序扫描，索引只对三个字以上的关键词有效。
   *
   * **已知局限：LIKE 的元字符没有被转义。** Prisma 的 `contains` 只负责把值包成
   * `%值%`，不提供 `ESCAPE` 子句，所以关键词里若含 `%` 或 `_`，它们会当通配符用 ——
   * 搜 `50%` 会多带出含 `50` 的结果，搜单独一个 `%` 则等于不过滤。这里选择接受：
   * 后果只是结果偏宽（不会漏、也不会越出 userId / deletedAt / 归档这几道边界），
   * 而为一个罕见输入改写整个列表查询（换成 `$queryRaw` 并手工拼转义）得不偿失。
   *
   * 匹配大小写不敏感是为英文字母与代码片段准备的，中文不受影响。
   */
  const search = normalizeSearchQuery(filter.search)
  if (search !== null) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { content: { contains: search, mode: 'insensitive' } },
    ]
  }

  const createdAt: { gte?: Date; lte?: Date } = {}
  if (filter.from !== undefined && filter.from !== '') {
    const from = parseBoundary(filter.from)
    if (from === null) return invalid('invalid_range')
    createdAt.gte = from
  }
  if (filter.to !== undefined && filter.to !== '') {
    const to = parseBoundary(filter.to)
    if (to === null) return invalid('invalid_range')
    createdAt.lte = to
  }
  if (createdAt.gte !== undefined || createdAt.lte !== undefined) {
    where.createdAt = createdAt
  }

  const rows = await prisma.note.findMany({ where, orderBy: NOTE_ORDER, select: NOTE_SELECT })
  return { ok: true, data: rows.map(toNote) }
}

/**
 * 按 id 取一条纪要，取不到返回 null。
 *
 * 存在性、归属与软删除三件事合成一个 where，与其余函数保持同一条规则。归档的纪要
 * 照常返回：归档只影响它出现在哪个视图，不影响它能不能被读到、被改回去。
 */
export async function getNote(userId: string, id: string): Promise<Note | null> {
  const row = await prisma.note.findFirst({
    where: { id, userId, deletedAt: null },
    select: NOTE_SELECT,
  })
  return row === null ? null : toNote(row)
}

export async function createNote(
  userId: string,
  input: CreateNoteRequest,
): Promise<NoteResult<Note>> {
  const title = validateTitle(input.title)
  if (!title.ok) return title

  const content = validateContent(input.content)
  if (!content.ok) return content

  const tags = validateTags(input.tags ?? [])
  if (!tags.ok) return tags

  // 不查重名。纪要允许同名：「周会记录」这种标题一个月会重复好几次，唯一约束在
  // 这个场景下会直接挡住一次合法保存。理由详见 schema.prisma 该模型的注释。
  const row = await prisma.note.create({
    data: { userId, title: title.data, content: content.data, tags: tags.data },
    select: NOTE_SELECT,
  })
  return { ok: true, data: toNote(row) }
}

export async function updateNote(
  userId: string,
  id: string,
  input: UpdateNoteRequest,
): Promise<NoteResult<Note>> {
  const current = await prisma.note.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true },
  })
  if (current === null) return invalid('not_found')

  // 只把传进来的字段拼进 data。写成「缺省时填回原值」会让每次修改都触碰所有列，
  // updatedAt 随之变化，而「这一行到底改了什么」就看不出来了。
  const data: { title?: string; content?: string; tags?: string[] } = {}

  if (input.title !== undefined) {
    const title = validateTitle(input.title)
    if (!title.ok) return title
    data.title = title.data
  }

  if (input.content !== undefined) {
    const content = validateContent(input.content)
    if (!content.ok) return content
    data.content = content.data
  }

  if (input.tags !== undefined) {
    const tags = validateTags(input.tags)
    if (!tags.ok) return tags
    data.tags = tags.data
  }

  const row = await prisma.note.update({ where: { id }, data, select: NOTE_SELECT })
  return { ok: true, data: toNote(row) }
}

/**
 * 置顶开关。幂等：设成与当前相同的值不报错。
 *
 * 先确认归属与存在性再写入，是为了拿到更新后的整行返回给调用方 —— `updateMany`
 * 只给行数，拿不到那一行。两次调用之间有一个窗口，只可能让这次操作落在一条刚被
 * 软删除的纪要上：那时 `update` 仍会成功（主键还在），但结果不会再出现在任何列表
 * 里。这个影响限于一次无人看到的写入，不值得为它引入事务。
 *
 * 副作用提醒：`@updatedAt` 会随之刷新。取消置顶后这条纪要会落在「最近修改」的第一
 * 位，而用户刚刚确实操作过它，这个位置是符合直觉的。
 */
export async function setNotePinned(
  userId: string,
  id: string,
  pinned: boolean,
): Promise<NoteResult<Note>> {
  const current = await prisma.note.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true },
  })
  if (current === null) return invalid('not_found')

  const row = await prisma.note.update({ where: { id }, data: { pinned }, select: NOTE_SELECT })
  return { ok: true, data: toNote(row) }
}

/**
 * 归档开关。幂等，语义与置顶同构。
 *
 * 归档时刻记的是**动作发生的时刻**，取消归档时清回 null。再次归档会得到一个新的
 * 时刻，而不是沿用上一次 —— 「这个月归档了哪些」问的是最近一次归档，保留旧时刻
 * 会让这个问题的答案停在几个月前。
 */
export async function setNoteArchived(
  userId: string,
  id: string,
  archived: boolean,
): Promise<NoteResult<Note>> {
  const current = await prisma.note.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true },
  })
  if (current === null) return invalid('not_found')

  const row = await prisma.note.update({
    where: { id },
    data: { archivedAt: archived ? new Date() : null },
    select: NOTE_SELECT,
  })
  return { ok: true, data: toNote(row) }
}

/**
 * 软删除。幂等：重复删除返回 `removed: false` 而不是报错。
 *
 * 用 `updateMany` 而不是「先查再 update」：一条语句同时完成归属校验与写入，中间没有
 * 可被并发插入的窗口。返回的 count 天然表达了「本次是否真的改动了一行」。
 */
export async function removeNote(
  userId: string,
  id: string,
): Promise<NoteResult<{ removed: boolean }>> {
  const result = await prisma.note.updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  return { ok: true, data: { removed: result.count > 0 } }
}

/**
 * 标签清单与计数，供标签输入框给出候选。
 *
 * **已归档的纪要计入，已删除的不计。** 归档是「收起来」，不是「不要了」，按标签找
 * 东西时把归档里的排除掉，会让「这个标签下只有两条」这种结论失真。删除的纪要则
 * 连标题都不该再出现，它的标签自然也不该再被推荐。
 *
 * 展开数组元素再分组，`groupBy` 表达不了这个写法（它对标量列分组，而标签在数组
 * 里），因此走原生查询。`userId` 用参数绑定而不是字符串拼接 —— 拼接在这个位置会
 * 直接变成一个注入口。
 *
 * 排序按条数倒序、标签名升序：条数相同时的次级键不写，结果会随数据库的物理顺序
 * 变化，表现为「刷新一次标签顺序就变一次」。
 */
export async function listNoteTags(userId: string): Promise<NoteTagCount[]> {
  const rows = await prisma.$queryRaw<{ tag: string; count: bigint }[]>`
    SELECT tag, COUNT(*) AS count
    FROM notes, unnest(tags) AS tag
    WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `
  return rows.map((row) => ({ tag: row.tag, count: Number(row.count) }))
}
