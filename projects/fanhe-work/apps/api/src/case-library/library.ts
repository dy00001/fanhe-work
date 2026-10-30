import { randomUUID } from 'node:crypto'

import {
  CASE_LIBRARY_LIMITS,
  caseItemIdBelongsTo,
  caseUploadItemId,
  isCaseCategoryId,
  isCaseUploadItemId,
  isValidCaseFolderName,
  normalizeCaseFolderName,
  type CaseFolder,
  type CaseLibrarySnapshot,
  type CasePlacement,
  type CaseUpload,
  type CreateCaseFolderRequest,
  type CreateCaseUploadsRequest,
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
 * **不给它加权限点，只要求登录。** 案例库是**全账号共用一份**的素材库：所有函数收到的
 * `userId` 都是路由层解析出来的「库归属账号」（`case-library/scope.ts`），不是发起请求的
 * 那个人。因此每个登录用户看到的都是同一批图与同一批文件夹，也都能整理、能删。既然没有
 * 「别人的库」这种东西，`personal.case.read/write` 这样的权限点就区分不出任何东西：它
 * 唯一的效果是让某个角色能看到首页案例区却整理不了案例库。真要区分「谁能整理」时再加，
 * 那时它才是一条有意义的规则。
 *
 * **不写审计。** 与纪要、启动配置同一条判断：影响范围不超出这个账号。
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
  | 'invalid_image'
  | 'upload_limit'

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
  'caseLibraryState' | 'caseFolder' | 'caseItemPlacement' | 'caseUpload'
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
  const [state, folders, placements, uploads] = await Promise.all([
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
    // **不取字节。** 一次快照动辄几十张上传图，把 bytea 一起拖回来会让一个十几 KB
    // 的响应变成几 MB，而界面此刻只需要知道「有哪些图、多大」。字节走取图接口。
    client.caseUpload.findMany({
      where: { userId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        itemId: true,
        categoryId: true,
        width: true,
        height: true,
        createdAt: true,
      },
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
    uploads: uploads.map((row): CaseUpload => ({
      itemId: row.itemId,
      categoryId: row.categoryId,
      width: row.width,
      height: row.height,
      createdAt: row.createdAt.toISOString(),
    })),
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
 * **可以跨品类。** 目标文件夹属于哪个品类不影响这次写入 —— 图片跟着文件夹走，源品类
 * 那边会因为归属行指向别人的文件夹而不再显示它（规则在 `case-library-display.ts` 里，
 * 服务端只存事实，不判断「该不该显示」）。
 *
 * itemId 的合法性只靠「前缀即品类」这条命名约定：服务端不掌握图片清单（那是前端的
 * 静态资源），能挡的只是「不存在的编号」，而它对界面无害——客户端按静态清单渲染，
 * 查不到的自然不画。
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
  /**
   * 归属行里的 `categoryId` 记的是**这张图现在归在哪个品类**，所以跨品类移动要跟着目标
   * 文件夹走。快照不读这一列（客户端靠 `folderId` 反查文件夹的品类），但库里留着一列
   * 「图片属于衣柜」而它正躺在橱柜的文件夹里，下一个人查数据时会被它带偏。
   */
  let placementCategoryId = category.data
  if (folderId !== null) {
    const folder = await prisma.caseFolder.findFirst({
      where: { id: folderId, userId, deletedAt: null },
      select: { categoryId: true },
    })
    // 目标文件夹不在：这不是「请求写错了」，而是与当前状态冲突。另一台设备可能刚把它
    // 删掉，界面该做的是重取快照再让用户重选，而不是报一个看起来像代码错误的 404。
    //
    // **目标文件夹在别的品类里是允许的**（见 `MoveCaseItemsRequest` 的注释）。这里只挡
    // 「不存在」，不挡「不是这个品类的」。
    if (folder === null) return fail('folder_unavailable')
    placementCategoryId = folder.categoryId
  }

  const snapshot = await withRevision(userId, async (tx) => {
    if (folderId === null) {
      await tx.caseItemPlacement.deleteMany({ where: { userId, itemId: { in: itemIds } } })
      return
    }
    await tx.caseItemPlacement.createMany({
      data: itemIds.map((itemId) => ({
        userId,
        itemId,
        categoryId: placementCategoryId,
        folderId,
      })),
      skipDuplicates: true,
    })
    // 跨品类移动时，已存在的那一行 `categoryId` 还是旧品类 —— 一并改掉，否则同一张图
    // 在不同文件夹之间来回搬几次之后，这一列就与事实无关了。
    await tx.caseItemPlacement.updateMany({
      where: { userId, itemId: { in: itemIds } },
      data: { folderId, categoryId: placementCategoryId },
    })
  })
  return { ok: true, data: snapshot }
}

// ---------------------------------------------------------------------------
// 上传图片
// ---------------------------------------------------------------------------
//
// 与上面五个函数的分工：它们改的是「哪张图在哪个文件夹」，这里多管一件「图从哪来」。
// 上传之后的所有动作（移动、删除文件夹、跨品类整理）**走的是完全相同的路径** ——
// 界面上的图片只有 `itemId`，来源差异被抹平在展示层（见 `case-library-display.ts`）。

/**
 * 允许的图片类型与其文件头。
 *
 * **按魔数判类型，不看客户端声明的 mime。** 请求体里那个字段来自浏览器，改一行
 * devtools 就能让它说自己是 png；而这个值最终会被写进 `content-type` 回给 `<img>`。
 * 用文件头判等于把「这张图到底是什么」交给字节本身，客户端说的只作为提示。
 */
const IMAGE_SIGNATURES: readonly { mime: string; test: (bytes: Buffer) => boolean }[] = [
  {
    mime: 'image/webp',
    test: (bytes) =>
      bytes.length > 12 &&
      bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP',
  },
  {
    mime: 'image/jpeg',
    test: (bytes) =>
      bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  {
    mime: 'image/png',
    test: (bytes) =>
      bytes.length > 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47,
  },
]

function sniffMime(bytes: Buffer): string | null {
  for (const signature of IMAGE_SIGNATURES) {
    if (signature.test(bytes)) return signature.mime
  }
  return null
}

/**
 * base64 → Buffer。
 *
 * 先按长度估算解码后的大小再 `Buffer.from`：一个形状合法但内容巨大的字符串（比如
 * 有人直接传了几十 MB 的 base64）在解码那一刻就会占满内存，而它的长度本身已经说明
 * 它超限了。估算是 `长度 × 3 / 4`（上界，忽略 padding 差异），够用。
 *
 * `Buffer.from(str, 'base64')` 对非法输入**不抛错**，它会尽量解码并丢掉不认识的字符 ——
 * 所以先用正则过一遍，否则「随手一个字符串」会被解成一堆垃圾字节，然后在魔数判断那里
 * 得到一个含义正确的 400，只是中间多绕一圈。
 */
function decodeBase64(value: string, maxBytes: number): Buffer | null {
  if (value.length === 0) return null
  if (Math.floor((value.length * 3) / 4) > maxBytes) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null
  const bytes = Buffer.from(value, 'base64')
  if (bytes.length === 0 || bytes.length > maxBytes) return null
  return bytes
}

/**
 * 生成 itemId。
 *
 * 用 UUID 去掉连字符做后缀，而不是自增序号或时间戳：**两台设备同时上传不能撞 id**，
 * 而撞了的后果不是报错 —— 后写的那张会顶掉先写的（主键冲突时 `createMany` 跳过），
 * 用户看到的是「我传了两张，只多了一张」。
 */
function newUploadItemId(categoryId: string): string {
  return caseUploadItemId(categoryId, randomUUID().replace(/-/g, ''))
}

/**
 * 上传一批图片。
 *
 * **字节与归属在同一个事务里。** 分开写的话，一旦归属写入失败，库里就留下一批没人
 * 引用的字节 —— 它们不在任何品类下显示，却永远占着空间，而且没有任何界面能删掉它们。
 *
 * 张数上限按品类计、在写入前查一次。查与写之间有竞态窗口（同时传最后两张时可能都过），
 * 代价是超出上限一两张，与新建文件夹的重名判断是同一笔账：为罕见情形加锁不划算。
 */
export async function createUploads(
  userId: string,
  input: CreateCaseUploadsRequest,
): Promise<CaseLibraryResult<CaseLibrarySnapshot>> {
  const category = validateCategory(input.categoryId)
  if (!category.ok) return category

  const items = input.items
  if (items.length === 0 || items.length > CASE_LIBRARY_LIMITS.UPLOAD_BATCH_MAX) {
    return fail('invalid_items')
  }

  const decoded: {
    itemId: string
    mime: string
    width: number
    height: number
    data: Buffer
    thumb: Buffer
  }[] = []
  for (const item of items) {
    const data = decodeBase64(item.data, CASE_LIBRARY_LIMITS.UPLOAD_BYTES_MAX)
    const thumb = decodeBase64(item.thumb, CASE_LIBRARY_LIMITS.UPLOAD_THUMB_BYTES_MAX)
    if (data === null || thumb === null) return fail('invalid_image')
    const mime = sniffMime(data)
    const thumbMime = sniffMime(thumb)
    // 缩略图与原图必须都是图片。两处都判，是因为它们各走各的解码路径，只判一个
    // 会让「缩略图是别的字节」这种情形带着一个错误的 content-type 存进库。
    if (mime === null || thumbMime === null) return fail('invalid_image')
    if (!Number.isInteger(item.width) || !Number.isInteger(item.height))
      return fail('invalid_image')
    if (item.width <= 0 || item.height <= 0) return fail('invalid_image')
    if (item.width > 10000 || item.height > 10000) return fail('invalid_image')
    decoded.push({
      itemId: newUploadItemId(category.data),
      mime,
      width: item.width,
      height: item.height,
      data,
      thumb,
    })
  }

  const existing = await prisma.caseUpload.count({
    where: { userId, categoryId: category.data, deletedAt: null },
  })
  if (existing + decoded.length > CASE_LIBRARY_LIMITS.UPLOADS_PER_CATEGORY_MAX) {
    return fail('upload_limit')
  }

  /**
   * 目标文件夹。**必须与 `categoryId` 同品类**（见 `CreateCaseUploadsRequest` 的注释）。
   * 与移动不同，这里没有「这张图原来在哪」可讲，允许跨品类只会让新图出现在用户没打开
   * 的那个图集里 —— 那看起来就像图丢了。
   */
  const folderId = input.folderId
  if (folderId !== null) {
    const folder = await prisma.caseFolder.findFirst({
      where: { id: folderId, userId, deletedAt: null },
      select: { categoryId: true },
    })
    if (folder === null || folder.categoryId !== category.data) return fail('folder_unavailable')
  }

  const snapshot = await withRevision(userId, async (tx) => {
    await tx.caseUpload.createMany({
      data: decoded.map((item) => ({
        userId,
        itemId: item.itemId,
        categoryId: category.data,
        width: item.width,
        height: item.height,
        byteSize: item.data.length,
        thumbByteSize: item.thumb.length,
        mime: item.mime,
        data: new Uint8Array(item.data),
        thumb: new Uint8Array(item.thumb),
      })),
    })
    if (folderId !== null) {
      await tx.caseItemPlacement.createMany({
        data: decoded.map((item) => ({
          userId,
          itemId: item.itemId,
          categoryId: category.data,
          folderId,
        })),
        skipDuplicates: true,
      })
    }
  })
  return { ok: true, data: snapshot }
}

/** 取图接口要的那一份。`variant` 只有两档：网格用的缩略图、放大用的原图。 */
export type CaseUploadImage = {
  bytes: Buffer
  mime: string
  /** 缩略图与原图可能不同格式（客户端按需选 webp / jpeg），因此 MIME 跟着变体走。 */
  version: string
}

/**
 * 读一张上传图的字节。
 *
 * **按 `userId` 过滤**，与其它函数同一条规则：换个 itemId 也读不到别人的图。返回
 * `null` 由路由层翻译成 404 —— 「不存在」与「不是你的」在这一层不区分，区分了等于
 * 告诉对方「这个 id 是存在的」。
 */
export async function readUploadImage(
  userId: string,
  itemId: string,
  variant: 'thumb' | 'full',
): Promise<CaseUploadImage | null> {
  if (!isCaseUploadItemId(itemId)) return null
  const row = await prisma.caseUpload.findFirst({
    where: { userId, itemId, deletedAt: null },
    select: { data: true, thumb: true, mime: true, createdAt: true },
  })
  if (row === null) return null
  const bytes = Buffer.from(variant === 'thumb' ? row.thumb : row.data)
  return {
    bytes,
    mime: row.mime,
    // 字节永不变（删了就是删了，改图等于重新上传一张），所以版本号用创建时间即可：
    // 它只参与缓存键，不参与任何语义判断。
    version: row.createdAt.getTime().toString(36),
  }
}

/**
 * 删除一张上传图。
 *
 * **软删。** 另一台设备可能正拿着这个 itemId 在发移动请求；硬删会让它收到一个分不清
 * 「被删了」与「从没存在」的 404。软删之后那张图不再出现在任何快照里，字节留着由以后
 * 的清理任务处置 —— 这与文件夹的删除是同一条取舍。
 *
 * 归属行跟着物理删除（不是置空）：图片已经不在了，留一条指向它的归属只会让统计张数
 * 时多算一张。
 *
 * **只能删自己上传的。** 静态清单里的图（`cabinet-3`）根本没有这一行，进来就是 404。
 */
export async function deleteUpload(
  userId: string,
  itemId: string,
): Promise<CaseLibraryResult<CaseLibrarySnapshot>> {
  if (!isCaseUploadItemId(itemId)) return fail('not_found')
  const row = await prisma.caseUpload.findFirst({
    where: { userId, itemId, deletedAt: null },
    select: { id: true },
  })
  if (row === null) return fail('not_found')

  const snapshot = await withRevision(userId, async (tx) => {
    await tx.caseItemPlacement.deleteMany({ where: { userId, itemId } })
    await tx.caseUpload.update({ where: { id: row.id }, data: { deletedAt: new Date() } })
  })
  return { ok: true, data: snapshot }
}
