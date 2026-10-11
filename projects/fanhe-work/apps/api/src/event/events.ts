import {
  EVENT_LIMITS,
  isValidNoteTag,
  normalizeNoteTags,
  normalizeSearchQuery,
  type CreateEventRequest,
  type Event,
  type EventLog,
  type EventLogAction,
  type EventStatus,
  type EventTagCount,
  type SetEventStatusRequest,
  type UpdateEventRequest,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import type { Prisma } from '../generated/prisma/client.js'

/**
 * 事件记录的读写。
 *
 * **所有权在这一层强制，不在路由层。** 与 `note/notes.ts`、`launch/profiles.ts`
 * 同一条规则：每个函数都要求传入用户 id，且所有查询都把它写进 where 条件。靠路由
 * 层「先查一次确认归属、再调用 service」的做法，会在新增接口时被漏掉，而漏掉的
 * 表现是「换个 id 就能读别人的事件」—— 这类缺陷不报错，只有被人主动尝试才会暴露。
 *
 * **归属不符与真的不存在，对外是同一种结果（404）。** 403 等于确认「这个 id 存在，
 * 只是不属于你」，而 id 是 UUID，能问出存在性就意味着可以逐个试探。
 *
 * **状态变更一定同时落两份数据**：更新 `events` 上的当前状态，以及往 `event_logs`
 * 追加一行。两件事在同一个事务里，因为「状态变了但没有日志」与「有日志但状态没变」
 * 都会让详情面板展示出一段说不通的历史，而这种不一致没有任何后续步骤能修回来。
 *
 * 校验分工与纪要一致：路由的 JSON schema 管类型、枚举与长度上限（挡住超大请求体），
 * 本模块管业务规则（标题不能为空、标签归一与计数、时间能不能解析）。长度上限只在
 * schema 里写一次，值取自共享包的常量，不在这里重复。
 *
 * **不写审计。** 与启动配置、纪要同一条判断：事件是用户自己的私有数据，增删改的
 * 影响范围不超出他本人。事件自己的变更流水（`event_logs`）是产品功能的一部分，
 * 与 `audit_logs` 是两回事 —— 后者记的是「谁动了权限、谁在试密码」。
 */

export type EventFailureReason =
  | 'not_found'
  | 'invalid_title'
  | 'invalid_description'
  | 'invalid_tags'
  | 'invalid_due_at'
  | 'invalid_comment'
  | 'invalid_range'

export type EventResult<T> = { ok: true; data: T } | { ok: false; reason: EventFailureReason }

/**
 * 操作人。状态变更要记下「谁做的」，取自认证上下文，不由请求体传入 ——
 * 让客户端传操作人等于让它自己声明身份，那条路径上的校验形同虚设。
 */
export type EventActor = {
  id: string
  displayName: string
}

/**
 * 对外暴露的列。
 *
 * 显式列出而不是取整行：`userId` 与 `deletedAt` 属于服务端内部状态，泄漏出去只会
 * 让前端有机会依赖它们。`completedById` 同样不外泄：界面要的是完成人的名字，而
 * id 一旦暴露就会有人拿它去拼别的接口。
 */
const EVENT_SELECT = {
  id: true,
  title: true,
  description: true,
  status: true,
  priority: true,
  tags: true,
  dueAt: true,
  completedAt: true,
  completedByName: true,
  createdAt: true,
  updatedAt: true,
} as const

type EventRow = {
  id: string
  title: string
  description: string
  status: EventStatus
  priority: Event['priority']
  tags: string[]
  dueAt: Date | null
  completedAt: Date | null
  completedByName: string | null
  createdAt: Date
  updatedAt: Date
}

const EVENT_LOG_SELECT = {
  id: true,
  action: true,
  fromStatus: true,
  toStatus: true,
  comment: true,
  actorName: true,
  createdAt: true,
} as const

type EventLogRow = {
  id: string
  action: string
  fromStatus: EventStatus | null
  toStatus: EventStatus | null
  comment: string | null
  actorName: string | null
  createdAt: Date
}

function toEvent(row: EventRow): Event {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    tags: row.tags,
    dueAt: row.dueAt === null ? null : row.dueAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
    completedBy: row.completedByName,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 日志行转传输形态。
 *
 * `action` 原样透传，不做收窄：一篇历史里可能有当前代码认不出的动作码，把它丢掉或
 * 塞成 `'unknown'` 都会让「这条记录到底发生了什么」永远查不回来。认不认识由展示方
 * 用 `isEventLogAction` 判断，见共享包 `EventLog.action` 的说明。
 */
function toEventLog(row: EventLogRow): EventLog {
  return {
    id: row.id,
    action: row.action,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    comment: row.comment,
    actor: row.actorName,
    createdAt: row.createdAt.toISOString(),
  }
}

function invalid(reason: EventFailureReason): EventResult<never> {
  return { ok: false, reason }
}

function validateTitle(value: string): EventResult<string> {
  const title = value.trim()
  if (title === '') return invalid('invalid_title')
  if (title.length > EVENT_LIMITS.TITLE_MAX) return invalid('invalid_title')
  return { ok: true, data: title }
}

/**
 * 描述**不做 trim**，理由与纪要正文完全相同：Markdown 的前导空白有意义（缩进决定
 * 列表层级与代码块），首尾空行是用户在编辑器里看得见的东西。归一描述等于悄悄改写了
 * 他写下的内容。空描述是合法的 —— 先记下「要做什么」，细节回头再补。
 */
function validateDescription(value: string): EventResult<string> {
  if (typeof value !== 'string') return invalid('invalid_description')
  if (value.length > EVENT_LIMITS.DESCRIPTION_MAX) return invalid('invalid_description')
  return { ok: true, data: value }
}

/**
 * 标签归一与校验**复用纪要那一套**，见共享包 event.ts 顶部关于标签的说明。
 *
 * 顺序与纪要一致：先归一去重再判数量上限。提交 25 个标签但里面有 10 个重复时，
 * 归一后是 15 个，那是一次合法提交；反过来先判上限，会让「重复标签算不算数」变成
 * 一个只在边界上暴露的问题。
 */
function validateTags(value: readonly string[]): EventResult<string[]> {
  if (!Array.isArray(value)) return invalid('invalid_tags')
  if (value.some((item) => typeof item !== 'string')) return invalid('invalid_tags')

  const tags = normalizeNoteTags(value)
  if (tags.length > EVENT_LIMITS.TAGS_MAX_COUNT) return invalid('invalid_tags')
  if (tags.some((tag) => !isValidNoteTag(tag))) return invalid('invalid_tags')
  return { ok: true, data: tags }
}

/**
 * 解析截止时间。传 `null` 表示清除。
 *
 * schema 只限长度，合法性由这里的 `new Date()` 判断 —— 用正则去校验时间字符串的
 * 合法边界（闰年、月份天数、时区偏移的写法）比直接解析更容易出错。
 *
 * **允许填过去的时刻。** 补录一件已经发生过的事、或把原来没填的截止时间追加上去时，
 * 截止时间早于创建时间是常态；拒绝它只会逼用户填一个假的。
 */
function validateComment(value: string | null | undefined): EventResult<string | null> {
  if (value === null || value === undefined) return { ok: true, data: null }
  if (typeof value !== 'string') return invalid('invalid_comment')
  const comment = value.trim()
  if (comment === '') return { ok: true, data: null }
  if (comment.length > EVENT_LIMITS.COMMENT_MAX) return invalid('invalid_comment')
  return { ok: true, data: comment }
}

function parseDueAt(value: string | null): EventResult<Date | null> {
  if (value === null) return { ok: true, data: null }
  if (typeof value !== 'string') return invalid('invalid_due_at')
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return invalid('invalid_due_at')
  return { ok: true, data: at }
}

/**
 * 列表筛选条件。
 *
 * 可选字段显式带上 `| undefined`，理由与 `NoteListFilter` 相同：这个对象在路由层
 * 由查询参数拼出来，缺省时读到的就是 `undefined`。项目开启了
 * `exactOptionalPropertyTypes`，不加这一项就要在路由里为每个字段写一次条件赋值。
 */
export type EventListFilter = {
  /** 只返回这个状态的事件。缺省表示不做状态筛选。 */
  status?: EventStatus | undefined
  /** 只返回带这个标签的事件。空串与全空白按「不过滤」处理。 */
  tag?: string | undefined
  /** 关键词，同时匹配标题与描述。空串与全空白按「不检索」处理。 */
  q?: string | undefined
  /** 创建时间下界，可被 `Date` 解析的字符串。 */
  from?: string | undefined
  /** 创建时间上界。 */
  to?: string | undefined
}

/**
 * 列表排序：未完成在前，组内按截止时间升序，最后用创建时间兜底。
 *
 * **`status: 'asc'` 让 `todo` 排在 `done` 前面，靠的是 PostgreSQL 按枚举的定义顺序
 * 比较**（`event_status` 是 `('todo', 'done')`）。改动枚举里的书写顺序就会翻转这个
 * 结果，所以那不是一个纯排版动作 —— 集成测试里有一条断言钉住了当前行为。
 *
 * `dueAt` 升序把近的排前面。没有截止时间的事件落在组尾，靠的是 PostgreSQL 对 ASC
 * 的默认行为（NULLS LAST），Prisma 不会显式生成 NULLS 子句。这与纪要列表里
 * 「`createdAt` 兜底」是同一种做法：显式声明一次排序方向，靠数据库的既定语义补齐
 * 边界，而不是写一串细碎的排序键。
 *
 * `createdAt` 作为第三级键是有必要的：同一秒内创建、截止时间又都为空的事件，
 * 前两级键会撞到一起，那时顺序随数据库的物理顺序变化，表现为「刷新一次顺序就变」
 */
const EVENT_ORDER: Prisma.EventOrderByWithRelationInput[] = [
  { status: 'asc' },
  { dueAt: 'asc' },
  { createdAt: 'desc' },
]

/** 解析时间边界。解析不出来返回 null，由调用方转成 `invalid_range`。 */
function parseBoundary(value: string): Date | null {
  const at = new Date(value)
  return Number.isNaN(at.getTime()) ? null : at
}

export async function listEvents(
  userId: string,
  filter: EventListFilter = {},
): Promise<EventResult<Event[]>> {
  const where: Prisma.EventWhereInput = { userId, deletedAt: null }

  if (filter.status !== undefined) {
    where.status = filter.status
  }

  if (filter.tag !== undefined && filter.tag.trim() !== '') {
    where.tags = { has: filter.tag.trim() }
  }

  /**
   * 关键词检索与纪要走同一条路：标题与描述各匹配一次取并集，用 `ILIKE`，不建索引。
   *
   * 理由与实测结论完整记在 `note/notes.ts` 的 `listNotes` 里，不在这里重复 ——
   * 结论是：PostgreSQL 自带的分词器不认中文（`tsvector` 把整串当成一个词），
   * `pg_trgm` 对两个字的 pattern 提不出三元组，因此当前量级下顺序扫描就够了。
   *
   * 同样继承那条已知局限：`LIKE` 的元字符 `%` 与 `_` 没有转义（Prisma 的 `contains`
   * 不提供 `ESCAPE`），后果只是结果偏宽，不会越出 userId / deletedAt 这两道边界。
   */
  const search = normalizeSearchQuery(filter.q)
  if (search !== null) {
    where.OR = [
      { title: { contains: search, mode: 'insensitive' } },
      { description: { contains: search, mode: 'insensitive' } },
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

  const rows = await prisma.event.findMany({ where, orderBy: EVENT_ORDER, select: EVENT_SELECT })
  return { ok: true, data: rows.map(toEvent) }
}

/** 按 id 取一条，取不到返回 null。存在性、归属与软删除合成一个 where。 */
export async function getEvent(userId: string, id: string): Promise<Event | null> {
  const row = await prisma.event.findFirst({
    where: { id, userId, deletedAt: null },
    select: EVENT_SELECT,
  })
  return row === null ? null : toEvent(row)
}

/**
 * 一条事件的状态变更历史，按时间正序。
 *
 * 返回 null 表示事件不存在、不属于这个用户、或已被软删除 —— 与 `getEvent` 同样，
 * 这三种情况对外是同一个结果。**先确认归属再读日志**：日志表里没有 userId 一列
 * （它由事件归属决定），少这一步就等于「拿到任意 eventId 就能读到别人的历史」。
 */
export async function listEventLogs(userId: string, eventId: string): Promise<EventLog[] | null> {
  const event = await prisma.event.findFirst({
    where: { id: eventId, userId, deletedAt: null },
    select: { id: true },
  })
  if (event === null) return null

  const rows = await prisma.eventLog.findMany({
    where: { eventId },
    orderBy: { createdAt: 'asc' },
    select: EVENT_LOG_SELECT,
  })
  return rows.map(toEventLog)
}

/**
 * 创建事件，同时写下第一条日志。
 *
 * 创建要写日志，是因为详情面板的历史得有个起点 —— 只有「完成」「撤销」而没有
 * 「创建」，那条时间线看起来像是从半路开始的，而「什么时候建的」恰恰是耗时计算的
 * 基准（T3-12 要展示「从创建到完成的耗时」）。
 *
 * 事务是必要的：一次写入失败（例如日志表的外键不满足）不应该留下一条没有历史的
 * 事件，那会让详情面板永远少一行且没有任何办法补。
 */
export async function createEvent(
  actor: EventActor,
  input: CreateEventRequest,
): Promise<EventResult<Event>> {
  const title = validateTitle(input.title)
  if (!title.ok) return title

  const description = validateDescription(input.description ?? '')
  if (!description.ok) return description

  const tags = validateTags(input.tags ?? [])
  if (!tags.ok) return tags

  const dueAt = parseDueAt(input.dueAt ?? null)
  if (!dueAt.ok) return dueAt

  // 不查重名。事件的标题允许重复：「与客户确认尺寸」这种事一个月会做好几次，
  // 唯一约束在这个场景下会直接挡住一次合法提交。
  return prisma.$transaction(async (tx) => {
    const row = await tx.event.create({
      data: {
        userId: actor.id,
        title: title.data,
        description: description.data,
        priority: input.priority ?? 'normal',
        tags: tags.data,
        dueAt: dueAt.data,
      },
      select: EVENT_SELECT,
    })

    await tx.eventLog.create({
      data: {
        eventId: row.id,
        action: 'created',
        // 此前没有状态，因此 fromStatus 是 null 而不是 'todo' —— 写成 'todo' 会
        // 让这条记录看起来像一次「从 todo 变成 todo」的空流转。
        fromStatus: null,
        toStatus: 'todo',
        actorId: actor.id,
        actorName: actor.displayName,
      },
    })

    return { ok: true as const, data: toEvent(row) }
  })
}

/**
 * 修改事件。**只改传入的字段，且不写状态变更日志。**
 *
 * 不写日志是有意的：详情面板要回答的是「状态怎么变的」，把每次改标题也塞进去，
 * 这条流水就从「状态变更历史」变成一份全字段的修改记录 —— 而后者真正的归宿是
 * 审计，不是这里。少写这一类的代价是「谁改了标题」暂时查不到，而那个问题当前
 * 没有人问。
 *
 * 不含 `status`：状态变更走 `setEventStatus`，因为它是唯一需要在同一事务里追加
 * 日志的改动。放在接口层分清楚，好过在这一个函数里判断「这次改的算不算状态变更」。
 */
export async function updateEvent(
  userId: string,
  id: string,
  input: UpdateEventRequest,
): Promise<EventResult<Event>> {
  const current = await prisma.event.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true },
  })
  if (current === null) return invalid('not_found')

  // 只把传进来的字段拼进 data。写成「缺省时填回原值」会让每次修改都触碰所有列，
  // updatedAt 随之变化，而「这一行到底改了什么」就看不出来了。
  const data: Prisma.EventUpdateInput = {}

  if (input.title !== undefined) {
    const title = validateTitle(input.title)
    if (!title.ok) return title
    data.title = title.data
  }

  if (input.description !== undefined) {
    const description = validateDescription(input.description)
    if (!description.ok) return description
    data.description = description.data
  }

  if (input.priority !== undefined) {
    data.priority = input.priority
  }

  if (input.tags !== undefined) {
    const tags = validateTags(input.tags)
    if (!tags.ok) return tags
    data.tags = tags.data
  }

  // 这里「没传」与「传 null」必须区分：前者是不改，后者是清除截止时间。
  if (input.dueAt !== undefined) {
    const dueAt = parseDueAt(input.dueAt)
    if (!dueAt.ok) return dueAt
    data.dueAt = dueAt.data
  }

  const row = await prisma.event.update({ where: { id }, data, select: EVENT_SELECT })
  return { ok: true, data: toEvent(row) }
}

/**
 * 状态切换：勾选完成与撤销共用这一条。
 *
 * **幂等，且幂等时不写日志。** 重复提交 `{ status: 'done' }` 不会追加第二行
 * `completed`：没改变任何东西就等于没有事件。与登出不写第二条是同一判断 —— 客户端
 * 在超时后重试、用户连点两下都会走到写入点，让它们各写一行会让历史里出现一串
 * 相同动作，而「到底完成过几次」这个问题的答案就此失真。前端由此可以放心重试。
 *
 * 两件事在同一事务里：改 `events` 上的当前状态，以及向 `event_logs` 追加一行。
 * 拆开的话，一次中途失败会留下「状态是已完成但历史里没有完成记录」或反过来，
 * 而这两种不一致都没有后续步骤能修回来 —— 事件自己的历史只能由事件自己的变更写。
 *
 * 撤销不是删除那条 `completed`，而是再追加一行 `reopened`：删掉它等于抹去「这件事
 * 曾经被完成过」，而详情面板要展示的耗时正需要那个时刻。
 */
export async function setEventStatus(
  actor: EventActor,
  id: string,
  input: SetEventStatusRequest,
): Promise<EventResult<Event>> {
  const comment = validateComment(input.comment)
  if (!comment.ok) return comment

  const current = await prisma.event.findFirst({
    where: { id, userId: actor.id, deletedAt: null },
    select: EVENT_SELECT,
  })
  if (current === null) return invalid('not_found')

  if (current.status === input.status) {
    return { ok: true, data: toEvent(current) }
  }

  const toDone = input.status === 'done'
  const action: EventLogAction = toDone ? 'completed' : 'reopened'

  const row = await prisma.$transaction(async (tx) => {
    const updated = await tx.event.update({
      where: { id },
      data: toDone
        ? {
            status: 'done',
            completedAt: new Date(),
            completedById: actor.id,
            // 显示名快照。账号随后改名或被删，这条记录仍读得出来。
            completedByName: actor.displayName,
          }
        : {
            status: 'todo',
            // 三列一起清空：留一个「已完成但不知道是谁」的中间状态没有意义，
            // 只会让详情面板多一个分支去猜。
            completedAt: null,
            completedById: null,
            completedByName: null,
          },
      select: EVENT_SELECT,
    })

    await tx.eventLog.create({
      data: {
        eventId: id,
        action,
        fromStatus: current.status,
        toStatus: input.status,
        comment: comment.data,
        actorId: actor.id,
        actorName: actor.displayName,
      },
    })

    return updated
  })

  return { ok: true, data: toEvent(row) }
}

/**
 * 软删除。幂等：重复删除返回 `removed: false` 而不是报错。
 *
 * 用 `updateMany` 而不是「先查再 update」：一条语句同时完成归属校验与写入，中间没有
 * 可被并发插入的窗口。返回的 count 天然表达了「本次是否真的改动了一行」。
 *
 * **日志不跟着删。** 事件被软删除后详情面板的入口就没了，但那些记录仍在库里 ——
 * 与纪要的软删除同一条处理：删除只是让它退出默认视图，不是抹掉。级联清理由外键
 * 在事件被物理清理时触发。
 */
export async function removeEvent(
  userId: string,
  id: string,
): Promise<EventResult<{ removed: boolean }>> {
  const result = await prisma.event.updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  return { ok: true, data: { removed: result.count > 0 } }
}

/**
 * 标签清单与计数，供标签输入框给出候选。实现与纪要的 `listNoteTags` 同构。
 *
 * 展开数组元素再分组，`groupBy` 表达不了这个写法（它对标量列分组，而标签在数组
 * 里），因此走原生查询。`userId` 用参数绑定而不是字符串拼接 —— 拼接在这个位置会
 * 直接变成一个注入口。
 *
 * 排序按条数倒序、标签名升序：条数相同时的次级键不写，结果会随数据库的物理顺序
 * 变化，表现为「刷新一次标签顺序就变一次」。
 *
 * **已完成的事件计入**（只要没被软删除）。已完成不是「不要了」，按标签找东西时把
 * 它们排除掉，会让「这个标签下只有两条」这种结论失真。
 */
export async function listEventTags(userId: string): Promise<EventTagCount[]> {
  const rows = await prisma.$queryRaw<{ tag: string; count: bigint }[]>`
    SELECT tag, COUNT(*) AS count
    FROM events, unnest(tags) AS tag
    WHERE user_id = ${userId}::uuid AND deleted_at IS NULL
    GROUP BY tag
    ORDER BY count DESC, tag ASC
  `
  return rows.map((row) => ({ tag: row.tag, count: Number(row.count) }))
}
