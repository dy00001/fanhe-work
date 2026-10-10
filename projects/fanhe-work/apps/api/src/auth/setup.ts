import { isValidUsername, normalizeUsername, ROLE_CODES } from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import { hashPassword } from './password.js'

/**
 * 首次初始化。
 *
 * 空库时创建一个 owner 账号，之后入口拒绝再次执行。这是系统里唯一一处「不需要
 * 认证就能创建账号」的代码，因此它的门禁必须比别处更严：判断条件是存在性而不是
 * 可用性，理由见 isInitialized 的注释。
 */

/**
 * 咨询锁的键。取一个固定的整数，值本身没有含义，只要不与项目里其它 advisory
 * lock 重复即可。
 */
const SETUP_LOCK_KEY = 981_273_645

/**
 * 系统是否已经完成初始化。
 *
 * 判定条件是「存在任意一个 owner 角色的账号」，**不过滤状态与软删除标记**。
 *
 * 这一点必须写清楚。初始化入口是一次性的，它的安全性完全依赖于「不可再次进入」。
 * 如果把已停用或已软删除的 owner 排除在外，「先让 owner 不可用，再走初始化入口
 * 给自己建一个」就成了一条完整的路径。停用与删除 owner 本身需要 owner 权限，但
 * 一条只差一步就能成立的路径不该留着。
 *
 * 代价是 owner 被全部删除后入口不会重新开放，需要走 `pnpm db:create-owner` 恢复。
 * 那个脚本不经过 HTTP，只有能操作服务器的人才能执行，与直接改数据库的权限要求
 * 一致，因此不构成额外的暴露面。
 */
export async function isInitialized(): Promise<boolean> {
  const owner = await prisma.user.findFirst({
    where: { role: { code: ROLE_CODES.OWNER } },
    select: { id: true },
  })
  return owner !== null
}

export type InitializeInput = {
  username: string
  password: string
  displayName: string
}

export type InitializeFailureReason = 'already_initialized' | 'invalid_username' | 'username_taken'

export type CreatedOwner = {
  id: string
  username: string
  displayName: string
}

export type InitializeResult =
  { ok: true; data: CreatedOwner } | { ok: false; reason: InitializeFailureReason }

type CreateOwnerOptions = {
  /** 是否要求系统尚未初始化。HTTP 入口传 true，恢复脚本传 false。 */
  requireUninitialized: boolean
}

/**
 * 创建 owner 账号。
 *
 * 恢复脚本与 HTTP 入口共用这一份实现，差别只在 requireUninitialized 这一个开关。
 * 分成两份代码的话，两条路径的校验与并发处理迟早会走偏，而其中一条只在出事时
 * 才被用到，偏了也发现不了。
 */
export async function createOwnerAccount(
  input: InitializeInput,
  options: CreateOwnerOptions,
): Promise<InitializeResult> {
  const username = normalizeUsername(input.username)
  if (!isValidUsername(username)) {
    return { ok: false, reason: 'invalid_username' }
  }

  // 先做一次廉价的存在性检查，再算哈希。已初始化的系统上，初始化接口是匿名可调的；
  // 若每次都先算一遍 Argon2，这个接口就成了一个不需要认证的 CPU 消耗点。检查本身
  // 只是一次 SELECT，代价可以忽略。
  //
  // 这次检查与事务内的那一次重复，但两者职责不同。这一次省掉的是无谓的哈希计算，
  // 事务内的那一次才是真正的判定：两者之间可能有另一个请求完成了初始化。
  if (options.requireUninitialized && (await isInitialized())) {
    return { ok: false, reason: 'already_initialized' }
  }

  // 哈希在事务外算。Argon2 单次要几十毫秒，放进事务会让咨询锁被多持有这么久。
  const passwordHash = await hashPassword(input.password)

  return prisma.$transaction(async (tx): Promise<InitializeResult> => {
    // 咨询锁把并发的初始化请求串行化。没有它，两个请求会同时读到「还没有 owner」，
    // 各自创建一个，于是一次初始化产生两个超级管理员，而流程不报任何错。
    //
    // 用 advisory lock 而不是给 users 表加约束，是因为要表达的条件是「owner 角色
    // 至多一个账号」，跨行，普通唯一约束写不出来。事务结束时锁自动释放。
    //
    // 套一层子查询取一个整型常量，而不是直接 SELECT 这个函数。原因在返回值类型：
    // pg_advisory_xact_lock 返回 void，而 Prisma 的驱动适配器无法反序列化 void 列，
    // 直接写会抛 UnsupportedNativeDataType（表现为接口 500，且日志里只看到
    // 「Failed to deserialize column of type 'void'」）。子查询不改变锁的语义，
    // 函数是 volatile 的，不会被优化掉。
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(${SETUP_LOCK_KEY})) AS setup_lock`

    if (options.requireUninitialized) {
      const existingOwner = await tx.user.findFirst({
        where: { role: { code: ROLE_CODES.OWNER } },
        select: { id: true },
      })
      if (existingOwner !== null) {
        return { ok: false, reason: 'already_initialized' }
      }
    }

    const taken = await tx.user.findUnique({ where: { username }, select: { id: true } })
    if (taken !== null) {
      return { ok: false, reason: 'username_taken' }
    }

    const ownerRole = await tx.role.findUnique({
      where: { code: ROLE_CODES.OWNER },
      select: { id: true },
    })
    if (ownerRole === null) {
      // 角色由种子脚本维护。缺失说明种子没跑过，属于部署问题，不该在这里静默补建。
      throw new Error('库里没有 owner 角色，先执行 pnpm db:seed')
    }

    const created = await tx.user.create({
      data: {
        username,
        passwordHash,
        displayName: input.displayName,
        roleId: ownerRole.id,
      },
      select: { id: true, username: true, displayName: true },
    })

    return { ok: true, data: created }
  })
}

/** HTTP 初始化入口。 */
export function initializeOwner(input: InitializeInput): Promise<InitializeResult> {
  return createOwnerAccount(input, { requireUninitialized: true })
}
