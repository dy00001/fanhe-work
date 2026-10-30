import { ROLE_CODES } from '@fanhe/shared'

import { env } from '../config/env.js'
import { prisma } from '../db/prisma.js'

/**
 * 案例库的归属账号。
 *
 * **案例库是账号级的，不是个人级的。** 图片、文件夹、整理结果、修订号全部共用一份：
 * 小阳传的图阿阳打开就能看见，阿阳建好的「主卧」文件夹小阳也不必再建一遍。这与笔记
 * 那种「谁写的是谁的」不同 —— 案例图是给客户看的素材库，属于整个账号。
 *
 * 落地方式是**把库固定归属到主账号**，而不是把 `user_id` 从四张表里拆掉：
 *
 *   - 表结构一行都不用改。四张表原本就是「按 user_id 各存一份」，只是现在所有请求都
 *     解析到同一个 user_id，于是「各存一份」自然变成了「共用一份」。
 *   - 修订号因此天然只有一份。若改成「共享行 + 保留 user_id 仅作上传者」，`case_library_states`
 *     的主键就得从 user_id 换成别的键，而那张表的全部意义就是「一个库一个计数器」。
 *   - 主账号被删时四张表随之级联消失，与「库属于这个账号」的语义一致。
 *
 * 取的是**持 owner 角色、最早创建的那个账号**：owner 是账号的建立者，`rank` 最高；
 * 加 `createdAt` 排序是为了在同有两个 owner 时也有确定答案（否则同一份数据会随查询
 * 计划漂移到不同账号名下）。库里一个 owner 都没有时退回最早的账号，而不是抛错 ——
 * 一个数据异常不该让整个案例区打不开。
 *
 * 可以用 `FANHE_CASE_LIBRARY_ACCOUNT`（用户名）把归属改指到别的账号，此时优先按配置
 * 来。这一项是为集成测试留的：测试必须有一个只放测试数据的一次性账号 —— 库共享之后，
 * 测试往「主账号」里写文件夹、挪 `cabinet-1` 这类真实图片，改的就是用户真实的整理结果。
 * 配了但账号不存在时退回角色解析，见下方注释。
 *
 * 不做进程内缓存：这是一条走 `id` 索引的极小查询，而缓存要么在 owner 被删后返回一个
 * 指向空库的 id，要么得自己造一套失效机制。案例库接口不在热路径上（打开图集、每次
 * 写操作各一次），多这一条查询不值得用正确性去换。
 */
export async function resolveCaseLibraryOwnerId(): Promise<string> {
  // 配置项优先。找不到那个账号时**继续往角色解析走**，而不是抛错：一个写错的名字
  // 不该让整个案例区打不开，退回默认归属至少数据还在。
  const configured = env.caseLibrary.ownerUsername
  if (configured !== null) {
    const user = await prisma.user.findFirst({
      where: { username: configured, deletedAt: null },
      select: { id: true },
    })
    if (user !== null) return user.id
  }

  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { code: ROLE_CODES.OWNER } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })
  if (owner !== null) return owner.id

  const fallback = await prisma.user.findFirst({
    where: { deletedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  })
  if (fallback !== null) return fallback.id

  // 一个账号都没有的库不可能有登录用户，走到这里说明数据被清空了。
  throw new Error('库里没有任何账号，案例库无法确定归属')
}
