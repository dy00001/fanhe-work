import {
  LAUNCH_PROFILE_LIMITS,
  isAbsoluteExecutablePath,
  isLaunchSoftware,
  type CreateLaunchProfileRequest,
  type LaunchProfile,
  type UpdateLaunchProfileRequest,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'

/**
 * 一键登录启动配置的读写。
 *
 * **所有权在这一层强制，不在路由层。** 每个函数都要求传入 `userId`，且所有查询都
 * 把它写进 where 条件。靠路由层「先查一次确认归属、再调用 service」的做法，会在
 * 新增接口时被漏掉，而漏掉的表现是「换个 id 就能读别人的配置」—— 这类缺陷不报错，
 * 只有被人主动尝试才会暴露。
 *
 * **归属不符与真的不存在，对外是同一种结果（404）。** 403 等于确认「这个 id 存在，
 * 只是不属于你」，而 id 是 UUID，能问出存在性就意味着可以逐个试探。这两件事在
 * service 层就合并掉，路由层不需要知道区别。
 *
 * 校验分工：路由的 JSON schema 管类型与长度上限（挡住超大请求体），本模块管业务
 * 规则（软件标识是否在清单里、路径是不是绝对路径、显示名是否重复）。长度上限只在
 * schema 里写一次，值取自共享包的常量，不在这里重复。
 */

export type LaunchFailureReason =
  | 'not_found'
  | 'duplicate_name'
  | 'invalid_software'
  | 'invalid_name'
  | 'invalid_path'
  | 'invalid_args'
  | 'invalid_icon'
  | 'stale_order'

export type LaunchResult<T> = { ok: true; data: T } | { ok: false; reason: LaunchFailureReason }

/**
 * 对外暴露的列。
 *
 * 显式列出而不是取整行：`userId` 与 `deletedAt` 属于服务端内部状态，泄漏出去只会
 * 让前端有机会依赖它们。新增列时也要在这里加一次，这个「多写一行」的代价换来的是
 * 「不会因为加了个内部字段就悄悄改了接口形状」。
 */
const PROFILE_SELECT = {
  id: true,
  software: true,
  name: true,
  executablePath: true,
  args: true,
  icon: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} as const

type ProfileRow = {
  id: string
  software: string
  name: string
  executablePath: string
  args: string[]
  icon: string | null
  sortOrder: number
  createdAt: Date
  updatedAt: Date
}

function toProfile(row: ProfileRow): LaunchProfile {
  return {
    id: row.id,
    software: row.software,
    name: row.name,
    executablePath: row.executablePath,
    args: row.args,
    icon: row.icon,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

function invalid(reason: LaunchFailureReason): LaunchResult<never> {
  return { ok: false, reason }
}

function validateSoftware(value: string): LaunchResult<string> {
  // 数据库侧没有约束（清单会演进，做成枚举意味着每加一个软件都要一次迁移），
  // 所以这里是唯一的强制点。漏掉它的表现是列表里某几行图标空白，且不报错。
  if (!isLaunchSoftware(value)) return invalid('invalid_software')
  return { ok: true, data: value }
}

/**
 * 显示名去掉首尾空白后不能为空。
 *
 * 归一放在服务端而不是只靠前端 trim：前端漏做一次，库里就会出现「看起来一样的
 * 两个名字」，而重名检查是按字符串精确比较的，那两条会被判为不同名。
 */
function validateName(value: string): LaunchResult<string> {
  const name = value.trim()
  if (name === '') return invalid('invalid_name')
  return { ok: true, data: name }
}

function validatePath(value: string): LaunchResult<string> {
  const path = value.trim()
  if (!isAbsoluteExecutablePath(path)) return invalid('invalid_path')
  return { ok: true, data: path }
}

/**
 * 启动参数只做「是字符串数组」这一层判断。
 *
 * 参数内容一律原样保留，不 trim、不过滤空串：空字符串是一个合法参数（表示显式的
 * 空值），而前导空格在某些客户端的参数解析里是有意义的。用户填什么就传什么，
 * 长度上限由路由 schema 挡住。
 */
function validateArgs(value: readonly string[]): LaunchResult<string[]> {
  if (!Array.isArray(value)) return invalid('invalid_args')
  if (value.some((item) => typeof item !== 'string')) return invalid('invalid_args')
  return { ok: true, data: [...value] }
}

/** 图标标识。空串按「没有图标」处理，与「未提供」合并成同一个值，避免出现两种空。 */
function validateIcon(value: string | null): LaunchResult<string | null> {
  if (value === null) return { ok: true, data: null }
  const icon = value.trim()
  if (icon === '') return { ok: true, data: null }
  if (icon.length > LAUNCH_PROFILE_LIMITS.ICON_MAX) return invalid('invalid_icon')
  return { ok: true, data: icon }
}

/**
 * 查同用户下是否已有同名的未删除配置。
 *
 * `excludeId` 用于修改场景：一条配置保留原名只改别的字段时，不该被自己挡住。
 *
 * 重名检查放在这里而不是数据库唯一约束，是因为软删除与唯一索引冲突：Prisma 的
 * @@unique 无法附加「deletedAt IS NULL」条件，删掉一条再建同名的会撞约束，而报错
 * 信息里看不出「是因为那条已删除的记录」。
 */
async function hasDuplicateName(
  userId: string,
  name: string,
  excludeId?: string,
): Promise<boolean> {
  const existing = await prisma.launchProfile.findFirst({
    where: {
      userId,
      name,
      deletedAt: null,
      ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
    },
    select: { id: true },
  })
  return existing !== null
}

export async function listProfiles(userId: string): Promise<LaunchProfile[]> {
  const rows = await prisma.launchProfile.findMany({
    where: { userId, deletedAt: null },
    // 次级键取 createdAt：sortOrder 在正常情况下互不相同，但历史数据或手工改库
    // 都可能造出重复值，那时排序结果会随数据库的物理顺序变化，表现为「刷新一次
    // 顺序就变一次」，很难排查。
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: PROFILE_SELECT,
  })
  return rows.map(toProfile)
}

export async function createProfile(
  userId: string,
  input: CreateLaunchProfileRequest,
): Promise<LaunchResult<LaunchProfile>> {
  const software = validateSoftware(input.software)
  if (!software.ok) return software

  const name = validateName(input.name)
  if (!name.ok) return name

  const executablePath = validatePath(input.executablePath)
  if (!executablePath.ok) return executablePath

  const args = validateArgs(input.args ?? [])
  if (!args.ok) return args

  const icon = validateIcon(input.icon ?? null)
  if (!icon.ok) return icon

  if (await hasDuplicateName(userId, name.data)) return invalid('duplicate_name')

  // 新配置一律排在末尾。取当前最大值加一而不是用行数：软删除之后行数与最大序号
  // 会错开，用行数会让新条目插进已有条目中间。
  const last = await prisma.launchProfile.findFirst({
    where: { userId, deletedAt: null },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  })
  const sortOrder = last === null ? 0 : last.sortOrder + 1

  const row = await prisma.launchProfile.create({
    data: {
      userId,
      software: software.data,
      name: name.data,
      executablePath: executablePath.data,
      args: args.data,
      icon: icon.data,
      sortOrder,
    },
    select: PROFILE_SELECT,
  })
  return { ok: true, data: toProfile(row) }
}

export async function updateProfile(
  userId: string,
  id: string,
  input: UpdateLaunchProfileRequest,
): Promise<LaunchResult<LaunchProfile>> {
  const current = await prisma.launchProfile.findFirst({
    where: { id, userId, deletedAt: null },
    select: { id: true, name: true },
  })
  if (current === null) return invalid('not_found')

  // 只把传进来的字段拼进 data。写成「缺省时填回原值」会让每次修改都触碰所有列，
  // updatedAt 随之变化，而「这一行到底改了什么」就看不出来了。
  const data: {
    software?: string
    name?: string
    executablePath?: string
    args?: string[]
    icon?: string | null
  } = {}

  if (input.software !== undefined) {
    const software = validateSoftware(input.software)
    if (!software.ok) return software
    data.software = software.data
  }

  if (input.name !== undefined) {
    const name = validateName(input.name)
    if (!name.ok) return name
    if (name.data !== current.name && (await hasDuplicateName(userId, name.data, id))) {
      return invalid('duplicate_name')
    }
    data.name = name.data
  }

  if (input.executablePath !== undefined) {
    const executablePath = validatePath(input.executablePath)
    if (!executablePath.ok) return executablePath
    data.executablePath = executablePath.data
  }

  if (input.args !== undefined) {
    const args = validateArgs(input.args)
    if (!args.ok) return args
    data.args = args.data
  }

  if (input.icon !== undefined) {
    const icon = validateIcon(input.icon)
    if (!icon.ok) return icon
    data.icon = icon.data
  }

  const row = await prisma.launchProfile.update({ where: { id }, data, select: PROFILE_SELECT })
  return { ok: true, data: toProfile(row) }
}

/**
 * 软删除。幂等：重复删除返回 `removed: false` 而不是报错。
 *
 * 用 updateMany 而不是「先查再 update」：一条语句同时完成归属校验与写入，中间没有
 * 可被并发插入的窗口。返回的 count 天然表达了「本次是否真的改动了一行」。
 */
export async function removeProfile(
  userId: string,
  id: string,
): Promise<LaunchResult<{ removed: boolean }>> {
  const result = await prisma.launchProfile.updateMany({
    where: { id, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  })
  return { ok: true, data: { removed: result.count > 0 } }
}

/**
 * 按提交的完整顺序重排。
 *
 * **要求提交的 id 集合与当前列表完全一致。** 少一个意味着有一行没有被分配新位置，
 * 多一个意味着客户端拿着一份过期的列表在操作（期间别的标签页删过或加过）。两种
 * 情况都直接拒绝而不是「尽力而为」：部分成功的重排会让顺序变成一个谁也没预期过的
 * 排列，而界面上看起来只是「拖拽没生效」，用户会反复重试。
 *
 * 整个重排在一个事务里完成。中途失败若留下写了一半的序号，排序会变得不稳定。
 */
export async function reorderProfiles(
  userId: string,
  ids: readonly string[],
): Promise<LaunchResult<LaunchProfile[]>> {
  const rows = await prisma.launchProfile.findMany({
    where: { userId, deletedAt: null },
    select: { id: true },
  })

  const submitted = new Set(ids)
  const unchanged = submitted.size === ids.length && submitted.size === rows.length
  if (!unchanged || !rows.every((row) => submitted.has(row.id))) {
    return invalid('stale_order')
  }

  await prisma.$transaction(
    ids.map((id, index) =>
      prisma.launchProfile.update({ where: { id }, data: { sortOrder: index } }),
    ),
  )

  return { ok: true, data: await listProfiles(userId) }
}
