import {
  CASE_LIBRARY_LIMITS,
  caseItemIdBelongsTo,
  isCaseCategoryId,
  isValidCaseFolderName,
  normalizeCaseFolderName,
  type CaseFolder,
  type CaseLibrarySnapshot,
  type CasePlacement,
  type CreateCaseFolderRequest,
  type MoveCaseItemsRequest,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import type { Prisma } from '../generated/prisma/client.js'

/**
 * 案例库的读写。
 *
 * **所有权在这一层强制。** 与 `note/notes.ts` 同一条规则：每个函数的第一个参数都是
 * `userId`，且所有查询把它写进 where 条件。靠路由层「先查一次确认归属」的做法，会在
 * 新增接口时被漏掉，而漏掉的表现是「换个 id 就能改别人的文件夹」——不报错，只有被人
 * 主动尝试才会暴露。
 *
 * **每次写操作都回传整个快照。** 客户端只认服务端给的这份，不自己推算「改完之后应该是
 * 什么样」。多设备并发时自己推算会算错，而算错的表现是界面显示的归属与库里不一致、
 * 刷新一次就好——属于最难复现的一类问题。快照最大十几 KB，这点带宽换掉一整类 bug。
 *
 * **不给它加权限点，只要求登录。** 这里有数据的每一条都按 `userId` 隔离，任何账号都
 * 只能读写自己的案例库，因此 `personal.case.read/write` 这样的权限点区分不出任何东西：
 * 它唯一的效果是让某个角色能看到首页案例区却整理不了自己的文件夹。真要区分「谁能整理」
 * 时再加，那时它才是一条有意义的规则。
 *
 * **不写审计。** 与纪要、启动配置同一条判断：影响范围不超出本人。
 */

/**
 * 失败原因。路由层把它映射成状态码，界面按状态码决定出口。
 *
 * `duplicate_name` 与 `folder_unavailable` 是**两种真正的冲突**，不是校验错误：
 * 前者是「另一台设备刚建了同名文件夹」，后者是「目标文件夹在别处被删了」。它们都用
 * 409 —— 请求本身合法，只是与当前状态不一致，客户端重取一次快照就能继续。
 */
export type CaseLibraryFailureReason =
  | 'not_found'
  | 'invalid_category'
  | 'invalid_name'
  | 'invalid_items'
  | 'duplicate_name'
  | 'folder_limit'
  | 'folder_unavailable'

export type CaseLibraryResult<T> =
  { ok: true; data: T } | { ok: false; reason: CaseLibraryFailureReason }

function fail(reason: CaseLibraryFailureReason): CaseLibraryResult<never> {
  return { ok: false, reason }
}

/**
 * 事务内外都要用的那部分客户端。
 *
 * 不写成 `Prisma.TransactionClient` 的别名：`readSnapshot` 既要在事务里跑（写完立刻读，
 * 读到的必须是自己那笔的结果），也要在事务外跑（纯读）。两者的共同接口就是这个类型。
 */
type CaseLibraryClient = Pick<
  Prisma.TransactionClient,
  'caseLibraryState' | 'caseFolder' | 'caseItemPlacement'
>

const FOLDER_SELECT = {
  id: true,
  categoryId: true,
  name: true,
  createdAt: true,
  updatedAt: true,
} as const

type FolderRow = {
  id: string
  categoryId: string
  name: string
  createdAt: Date
  updatedAt: Date
}

function toFolder(row: FolderRow): CaseFolder {
  return {
    id: row.id,
    categoryId: row.categoryId,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/**
 * 读一份快照。三张表读在同一个函数里，是为了让「修订号」与「数据」来自同一时刻。
 *
 * 分成三次查询而不是一次关联查询：归属表可能与文件夹表无关（图片可以未归档），
 * 关联查询会退化成左连接，反而更难读。三次查询在同一个事务里语义等价。
 *
 * **按 `createdAt` 再按 `id` 排序。** 只按时间排时，同一毫秒内建出的两个文件夹顺序
 * 不确定（Postgres 不保证稳定），而顺序不确定的表现是「刷新一下两个文件夹换了位置」。
 * 加上 id 作为决胜项，顺序就稳定了。
 */
async function readSnapshot(
  client: CaseLibraryClient,
  userId: string,
): Promise<CaseLibrarySnapshot> {
  const [state, folders, placements] = await Promise.all([
    client.caseLibraryState.findUnique({ where: { userId }, select: { revision: true } }),
    client.caseFolder.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: FOLDER_SELECT,
    }),
    client.caseItemPlacement.findMany({
      where: { userId, folderId: { not: null } },
      select: { itemId: true, folderId: true },
    }),
  ])

  const placementList: CasePlacement[] = []
  for (const row of placements) {
    // 查询已经过滤了 null，这里的判空只是让类型收窄，不会真的命中。
    if (row.folderId === null) continue
    placementList.push({ itemId: row.itemId, folderId: row.folderId })
  }

  return {
    revision: state?.revision ?? 0,
    folders: folders.map(toFolder),
    placements: placementList,
  }
}

/** 纯读。界面打开图集时调用，也是多设备同步的拉取入口。 */
export function getCaseLibrary(userId: string): Promise<CaseLibrarySnapshot> {
  return readSnapshot(prisma, userId)
}

/**
 * 在一个事务里做一次改动、自增修订号、回传快照。
 *
 * 三步必须在同一个事务里：修订号自增了但数据没写进去（或反过来），客户端就会拿着一个
 * 「看起来是最新的」修订号错过真正的变更。这是整套同步机制唯一的正确性前提。
 */
async function withRevision(
  userId: string,
  mutate: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<CaseLibrarySnapshot> {
  return prisma.$transaction(async (tx) => {
    await mutate(tx)
    await tx.caseLibraryState.upsert({
      where: { userId },
      create: { userId, revision: 1 },
      update: { revision: { increment: 1 } },
    })
    return readSnapshot(tx, userId)
  })
}

/** 校验品类 id。 */
function validateCategory(categoryId: string): CaseLibraryResult<string> {
  if (!isCaseCategoryId(categoryId)) return fail('invalid_category')
  return { ok: true, data: categoryId }
}

function validateFolderName(name: string): CaseLibraryResult<string> {
  const normalized = normalizeCaseFolderName(name)
  if (!isValidCaseFolderName(normalized)) return fail('invalid_name')
  return { ok: true, data: normalized }
}

/**
 * 新建文件夹。
 *
 * **重名判断只在未删除的行之间做，且按归一后的名字精确比较。** 库里没有唯一索引
 * （软删除与唯一索引天然冲突：删掉「客厅」再建一个「客厅」会撞上那条已删除的行），
 * 所以这里先查一次。查与写之间有极小的竞态窗口——两台设备在同一毫秒建同名文件夹时
 * 可能都成功；代价是两个同名文件夹，用户可以自己删掉一个，比为一个罕见情形加一把
 *  Advisory Lock 便宜。
 *
 * 上限按品类计：一个品类的文件夹数量到 30 就拒绝。界面上在接近上限时禁用「新建」，
 * 服务端这一道是真正的闸门。
 */
export async function createFolder(
  userId: string,
  input: CreateCaseFolderRequest,
): Promise<CaseLibraryResult<CaseLibrarySnapshot>> {
  const category = validateCategory(input.categoryId)
  if (!category.ok) return category
  const name = validateFolderName(input.name)
  if (!name.ok) return name

  const existing = await prisma.caseFolder.findMany({
    where: { userId, categoryId: category.data, deletedAt: null },
    select: { name: true },
  })
  if (existing.length >= CASE_LIBRARY_LIMITS.FOLDERS_PER_CATEGORY_MAX) {
    return fail('folder_limit')
  }
  if (existing.some((folder) => folder.name === name.data)) {
    return fail('duplicate_name')
  }

  const snapshot = await withRevision(userId, async (tx) => {
    await tx.caseFolder.create({
      data: { userId, categoryId: category.data, name: name.data },
    })
  })
  return { ok: true, data: snapshot }
}

/** 重命名。改名同样要过重名判断，并且要排除自己。 */
export async function renameFolder(
  userId: string,
  folderId: string,
  nameInput: string,
): Promise<CaseLibraryResult<CaseLibrarySnapshot>> {
  const name = validateFolderName(nameInput)
  if (!name.ok) return name

  const folder = await prisma.caseFolder.findFirst({
    where: { id: folderId, userId, deletedAt: null },
    select: { id: true, categoryId: true },
  })
  if (folder === null) return fail('not_found')

  const siblings = await prisma.caseFolder.findMany({
    where: { userId, categoryId: folder.categoryId, deletedAt: null },
    select: { id: true, name: true },
  })
  const clash = siblings.some((item) => item.id !== folderId && item.name === name.data)
  if (clash) return fail('duplicate_name')

  const snapshot = await withRevision(userId, async (tx) => {
    await tx.caseFolder.update({
      where: { id: folderId },
      data: { name: name.data },
    })
  })
  return { ok: true, data: snapshot }
}

/**
 * 删除文件夹。**里面的图片回到「未归档」，不会被删掉。**
 *
 * 两件事在同一个事务里：软删除文件夹、物理删掉指向它的归属行。归属行必须真的删掉
 * 而不是置空——「未归档」在本模型里的表示就是没有这一行（见 schema 注释），留着一条
 * `folderId = null` 的行会让归属表慢慢积攒无意义的记录，而它读出来还要再过滤一次。
 *
 * 不提供「恢复」：删除的后果是图片回到未归档，用户在界面上看得见、也能重新拖回去，
 * 因此不需要一个撤销栈。这条判断与纪要的归档不同——归档要能回头找，删除只是换个位置。
 */
export async function deleteFolder(
  userId: string,
  folderId: string,
): Promise<CaseLibraryResult<CaseLibrarySnapshot>> {
  const folder = await prisma.caseFolder.findFirst({
    where: { id: folderId, userId, deletedAt: null },
    select: { id: true },
  })
  if (folder === null) return fail('not_found')

  const snapshot = await withRevision(userId, async (tx) => {
    await tx.caseItemPlacement.deleteMany({ where: { userId, folderId } })
    await tx.caseFolder.update({
      where: { id: folderId },
      data: { deletedAt: new Date() },
    })
  })
  return { ok: true, data: snapshot }
}

/**
 * 批量移动。`folderId` 为 `null` 即「移出文件夹」。
 *
 * **整体赋值语义**：提交的每个 itemId 都被设成 `folderId` 指向的文件夹，因此重复提交
 * 同一个请求不会产生副作用，客户端失败后重试不必先问「上一次成没成」。
 *
 * itemId 的归属校验只靠「前缀即品类」这条命名约定：服务端不掌握图片清单（那是前端的
 * 静态资源），能挡住的是「把衣柜的图放进橱柜的文件夹」这类跨品类写入；挡不住的只是
 * 「不存在的编号」，而它对界面无害——客户端按静态清单渲染，查不到的自然不画。
 *
 * 先 `createMany(skipDuplicates)` 再 `updateMany`，而不是逐条 upsert：一次最多 200 条，
 * 逐条就是 200 次往返，而这个写法稳定是两条语句。顺序不能反——先更新后创建时，新建的
 * 那些行会漏掉更新。
 */
export async function moveItems(
  userId: string,
  input: MoveCaseItemsRequest,
): Promise<CaseLibraryResult<CaseLibrarySnapshot>> {
  const category = validateCategory(input.categoryId)
  if (!category.ok) return category

  const itemIds = Array.from(new Set(input.itemIds.map((item) => item.trim())))
  if (itemIds.length === 0) return fail('invalid_items')
  if (itemIds.length > CASE_LIBRARY_LIMITS.BATCH_MAX) return fail('invalid_items')
  for (const itemId of itemIds) {
    if (itemId.length === 0 || itemId.length > CASE_LIBRARY_LIMITS.ITEM_ID_MAX) {
      return fail('invalid_items')
    }
    if (!caseItemIdBelongsTo(itemId, category.data)) return fail('invalid_items')
  }

  const folderId = input.folderId
  if (folderId !== null) {
    const folder = await prisma.caseFolder.findFirst({
      where: { id: folderId, userId, deletedAt: null },
      select: { categoryId: true },
    })
    // 目标文件夹不在（或在别的品类里）：这不是「请求写错了」，而是与当前状态冲突。
    // 另一台设备可能刚把它删掉，界面该做的是重取快照再让用户重选，而不是报一个
    // 看起来像代码错误的 404。
    if (folder === null) return fail('folder_unavailable')
    if (folder.categoryId !== category.data) return fail('folder_unavailable')
  }

  const snapshot = await withRevision(userId, async (tx) => {
    if (folderId === null) {
      await tx.caseItemPlacement.deleteMany({ where: { userId, itemId: { in: itemIds } } })
      return
    }
    await tx.caseItemPlacement.createMany({
      data: itemIds.map((itemId) => ({ userId, itemId, categoryId: category.data, folderId })),
      skipDuplicates: true,
    })
    await tx.caseItemPlacement.updateMany({
      where: { userId, itemId: { in: itemIds } },
      data: { folderId },
    })
  })
  return { ok: true, data: snapshot }
}
