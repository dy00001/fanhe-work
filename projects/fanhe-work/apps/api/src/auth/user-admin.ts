import {
  AUDIT_ACTIONS,
  isValidUsername,
  mergePermissions,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  ROLE_CODES,
  type AccountPermissions,
  type PermissionCode,
} from '@fanhe/shared'

import { recordAudit, type AuditContext } from '../audit/audit.js'
import { prisma } from '../db/prisma.js'
import { hashPassword } from './password.js'

/** 事务回调里的客户端类型。与 prisma 同源，但不接受 $transaction 之外的方法。 */
type PrismaTransactionClient = Omit<
  typeof prisma,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>

/**
 * 账号与权限管理。
 *
 * 由 owner（或持有 system.user.manage 的账号）调用，为公司员工创建子账号并分配权限。
 *
 * ## 权限模型
 *
 * 一个账号的最终权限 = 角色自带 ∪ 账号级授予 − 账号级拒绝。三者在本文件里合成，
 * 合并规则委托给共享包的 `mergePermissions`（拒绝优先于授予）。角色权限由种子
 * 维护，账号级覆盖存在 `user_permissions` 表，是本功能新增的部分。
 *
 * ## 越权防护
 *
 * 所有写操作都要过同一道层级判定，规则是**只能管理 rank 严格小于自己的账号**。
 * 这条规则比「有没有 system.user.manage」更强：权限点只决定「能不能进这个模块」，
 * 层级决定「能操作谁」。两者都要判 —— 一个持有 manage 的 admin 不能改 owner，
 * 一个 owner 也不能改与自己同 rank 的另一个 owner。
 *
 * 这条判定**不能只靠权限点表达**，原因是权限点是二值的，表达不了层级。当前
 * admin 角色就持有 `system.user.manage`，若不加层级判定，它能改掉 owner 的角色，
 * 把系统的最后一个入口拿走。
 */

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

/** 失败原因。路由层据此映射状态码与文案。 */
export type UserAdminFailureReason =
  | 'user_not_found'
  | 'username_taken'
  | 'invalid_username'
  | 'invalid_password'
  | 'invalid_role'
  | 'invalid_status'
  | 'invalid_permissions'
  | 'role_not_assignable'
  | 'cannot_manage_self'
  | 'cannot_manage_peer_or_above'
  | 'cannot_modify_owner'
  | 'last_owner_protected'
  | 'forbidden'

export type UserAdminFailure = { ok: false; reason: UserAdminFailureReason }
export type UserAdminSuccess<T> = { ok: true; data: T }
export type UserAdminResult<T> = UserAdminSuccess<T> | UserAdminFailure

/**
 * 操作者的身份与权限快照。
 *
 * 刻意只收三个字段，而不是整个 AuthContext。服务层需要的就是「你什么层级、
 * 你是谁」，把整个上下文塞进来会让它有机会用到不相关的字段（比如 permissions），
 * 而那些字段与层级判定无关 —— 混进来之后，某个函数可能不经意地改成按权限点判断。
 */
export type Actor = {
  userId: string
  displayName: string
  roleCode: string
  roleRank: number
}

/** 列表里的一条账号，带最终权限与可管理标记。 */
export type ManagedUserRow = {
  id: string
  username: string
  displayName: string
  department: string | null
  status: 'active' | 'locked' | 'disabled'
  roleId: string
  roleCode: string
  roleName: string
  roleRank: number
  /** 最终权限点（角色 ∪ 授予 − 拒绝）。owner 恒为全部。 */
  permissions: readonly PermissionCode[]
  isOwner: boolean
  /** actor 能否管理这个账号。 */
  canBeManaged: boolean
  lastLoginAt: Date | null
  createdAt: Date
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const USER_SELECT = {
  id: true,
  username: true,
  displayName: true,
  department: true,
  status: true,
  lastLoginAt: true,
  createdAt: true,
  // 角色的授权嵌在 role 里：role_permissions 挂在 Role 上，User 上没有这个关系。
  role: {
    select: {
      id: true,
      code: true,
      name: true,
      rank: true,
      rolePermissions: {
        where: { permission: { deletedAt: null } },
        select: { permission: { select: { code: true } } },
      },
    },
  },
  userPermissions: {
    select: { granted: true, permission: { select: { code: true } } },
  },
} as const

type UserWithRelations = {
  id: string
  username: string
  displayName: string
  department: string | null
  status: 'active' | 'locked' | 'disabled'
  lastLoginAt: Date | null
  createdAt: Date
  /**
   * 角色连同它的授权一起取。
   *
   * `role_permissions` 挂在 Role 上而不是 User 上，因此它必须嵌在 role 里取。
   * 写成 User 的一层关系 Prisma 会拒绝，错误信息是「Unknown field
   * `rolePermissions` for select statement on model `User`」——它不指出正确写法，
   * 而这里正是最容易记错的一层嵌套。
   */
  role: {
    id: string
    code: string
    name: string
    rank: number
    rolePermissions: { permission: { code: string } }[]
  }
  userPermissions: { granted: boolean; permission: { code: string } }[]
}

const KNOWN_PERMISSIONS = new Set<string>()

/** 收窄权限码，剔除权限清单里已经删掉的残留码。 */
function narrow(codes: readonly string[]): PermissionCode[] {
  return codes.filter((code): code is PermissionCode => KNOWN_PERMISSIONS.has(code))
}

/**
 * 合成最终权限点。owner 短路返回全部，与守卫里那条规则保持一致 —— 两处必须
 * 同源，否则会出现「列表里显示的权限」与「实际能做的」不一致。
 */
function effectivePermissions(
  user: Pick<UserWithRelations, 'role' | 'userPermissions'>,
  allPermissions: readonly PermissionCode[],
): PermissionCode[] {
  if (user.role.code === ROLE_CODES.OWNER) {
    return [...allPermissions]
  }

  const roleCodes = narrow(user.role.rolePermissions.map((row) => row.permission.code))
  const granted: PermissionCode[] = []
  const denied: PermissionCode[] = []
  for (const row of user.userPermissions) {
    const code = narrow([row.permission.code])[0]
    if (code === undefined) continue
    if (row.granted) granted.push(code)
    else denied.push(code)
  }

  return mergePermissions(roleCodes, granted, denied)
}

/**
 * 层级判定：actor 能否管理 target。
 *
 * 三条规则，返回 true 必须同时满足：
 *
 * 1. **不能操作自己。** 允许自我操作时，一个持有 manage 的账号可以改掉自己的角色，
 *    把自己提权到更高的 rank，此后它就能管理原本管不到的人 —— 提权路径。自我禁用
 *    与自我删除同理：把自己删掉之后没人能撤销这个操作。
 * 2. **target 的 rank 必须严格小于 actor。** 相等也不行 —— 两个 owner 互删会怎样，
 *    取决于谁先点，而那不是一个应该由代码来决定的竞争。
 * 3. **owner 不可被非 owner 操作。** 这条与第 2 条在当前 rank 配置下重叠
 *    （owner 的 rank 最高），但它表达的是一条**独立的不变量**：owner 是系统的最后
 *    入口，这条规则不该因为将来调高了某个角色的 rank 就失效。
 *
 * 判据用 `actor.roleRank > target.roleRank` 而不是「actor 是 owner」。理由是前者
 * 在四个内置角色的任意配置下都成立；写成「是不是 owner」会让 admin 也获得跨层级
 * 操作能力，只要它的 rank 被调高。
 */
function canManage(
  actor: Actor,
  target: { id: string; role: { rank: number; code: string } },
): boolean {
  if (actor.userId === target.id) return false
  if (target.role.code === ROLE_CODES.OWNER && actor.roleCode !== ROLE_CODES.OWNER) return false
  return actor.roleRank > target.role.rank
}

/** 事务内用户名冲突的信号。只在事务内部抛出，用于区分于其它错误。 */
class UsernameTakenError extends Error {
  constructor() {
    super('username taken')
    this.name = 'UsernameTakenError'
  }
}

/** 取一个账号及其权限关联。 */
async function loadUser(id: string): Promise<UserWithRelations | null> {
  const row = await prisma.user.findFirst({
    where: { id, deletedAt: null },
    select: USER_SELECT,
  })
  return row as UserWithRelations | null
}

/**
 * 校验账号级权限覆盖，把未知权限码视为非法（不静默丢弃）。
 *
 * 未知码属于非法输入而非「忽略即可」的噪声。权限清单是代码里的常量，能进到这里
 * 说明调用方拼错了，或清单与部署版本不一致 —— 静默丢弃会让这次授权看起来成功了，
 * 而实际生效的权限比勾选的少。
 */
function validatePermissions(
  granted: readonly string[] | undefined,
  denied: readonly string[] | undefined,
): { ok: true; data: AccountPermissions } | { ok: false } {
  const all = [...(granted ?? []), ...(denied ?? [])]
  if (all.some((code) => !KNOWN_PERMISSIONS.has(code))) {
    return { ok: false }
  }
  return {
    ok: true,
    data: {
      granted: (granted ?? []) as PermissionCode[],
      denied: (denied ?? []) as PermissionCode[],
    },
  }
}

/**
 * 幂等地写入账号级权限覆盖。
 *
 * 整体替换而非增量：先删掉该账号现存的全部覆盖行，再按新内容插入。事务保证
 * 两者之间没有中间态 —— 否则中途失败会留下一个「该删的没删、该加的没加」的账号。
 *
 * 不在同一个权限点上同时写 granted 与 denied：那样会让最终结果取决于 `mergePermissions`
 * 的合并顺序，而它已经写死了「拒绝在后」。这里直接拒绝这种输入，让数据形状与
 * 语义保持一致 —— 判据不成立时报错，好过留下一个看着矛盾的行。
 */
async function writePermissionOverrides(
  tx: PrismaTransactionClient,
  userId: string,
  permissions: AccountPermissions,
): Promise<void> {
  const granted = new Set(permissions.granted)
  const overlap = permissions.denied.filter((code) => granted.has(code))
  if (overlap.length > 0) {
    throw new Error(`权限 ${overlap[0]} 同时出现在授予与拒绝中`)
  }

  await tx.userPermission.deleteMany({ where: { userId } })

  const codes = [
    ...permissions.granted.map((code) => ({ code, granted: true })),
    ...permissions.denied.map((code) => ({ code, granted: false })),
  ]
  if (codes.length === 0) return

  const permissionRows = await tx.permission.findMany({
    where: { code: { in: codes.map((c) => c.code) }, deletedAt: null },
    select: { id: true, code: true },
  })
  const idByCode = new Map(permissionRows.map((row) => [row.code, row.id]))

  await tx.userPermission.createMany({
    data: codes.map((entry) => ({
      userId,
      // 权限码不在库里说明种子没跑或权限清单被改过而种子未重跑。跳过它而不是
      // 写一个悬空引用 —— 外键会拦住，但报错信息会指向数据库而不是「请先跑种子」。
      permissionId: idByCode.get(entry.code) ?? '',
      granted: entry.granted,
    })),
  })
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

/**
 * 账号列表。
 *
 * **只返回 actor 能管理的账号，加上 actor 自己。** 返回全部账号会让界面列出一堆
 * 点了也改不动的行，而用户无法分辨「不能改」是权限问题还是账号本身有问题。
 * 把 owner 自己也带上，是因为界面上需要一个「当前登录者」的对照项。
 *
 * 软删除的账号不返回。要看它们需要另做「回收站」，那是另一个需求。
 */
export async function listManagedUsers(
  actor: Actor,
  allPermissions: readonly PermissionCode[],
): Promise<UserAdminResult<readonly ManagedUserRow[]>> {
  const rows = (await prisma.user.findMany({
    where: { deletedAt: null },
    select: USER_SELECT,
    orderBy: { createdAt: 'asc' },
  })) as unknown as UserWithRelations[]

  const visible = rows.filter((row) => canManage(actor, row) || row.id === actor.userId)

  return {
    ok: true,
    data: visible.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      department: row.department,
      status: row.status,
      roleId: row.role.id,
      roleCode: row.role.code,
      roleName: row.role.name,
      roleRank: row.role.rank,
      permissions: effectivePermissions(row, allPermissions),
      isOwner: row.role.code === ROLE_CODES.OWNER,
      canBeManaged: canManage(actor, row),
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
    })),
  }
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

export type ManagedUserDetail = {
  user: ManagedUserRow
  rolePermissions: readonly PermissionCode[]
  permissions: AccountPermissions
}

export async function getManagedUser(
  actor: Actor,
  userId: string,
  allPermissions: readonly PermissionCode[],
): Promise<UserAdminResult<ManagedUserDetail>> {
  const row = await loadUser(userId)
  if (row === null) return { ok: false, reason: 'user_not_found' }

  // 不在可见范围内的账号按「不存在」返回，而不是 403。403 等于告诉调用者「这个
  // 账号存在只是你管不了」，而账号列表本身不该成为一个枚举接口。
  if (!canManage(actor, row) && row.id !== actor.userId) {
    return { ok: false, reason: 'user_not_found' }
  }

  const granted: PermissionCode[] = []
  const denied: PermissionCode[] = []
  for (const entry of row.userPermissions) {
    const code = narrow([entry.permission.code])[0]
    if (code === undefined) continue
    if (entry.granted) granted.push(code)
    else denied.push(code)
  }

  return {
    ok: true,
    data: {
      user: {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        department: row.department,
        status: row.status,
        roleId: row.role.id,
        roleCode: row.role.code,
        roleName: row.role.name,
        roleRank: row.role.rank,
        permissions: effectivePermissions(row, allPermissions),
        isOwner: row.role.code === ROLE_CODES.OWNER,
        canBeManaged: canManage(actor, row),
        lastLoginAt: row.lastLoginAt,
        createdAt: row.createdAt,
      },
      rolePermissions: narrow(row.role.rolePermissions.map((r) => r.permission.code)),
      permissions: { granted, denied },
    },
  }
}

// ---------------------------------------------------------------------------
// 创建
// ---------------------------------------------------------------------------

export type CreateUserInput = {
  username: string
  password: string
  displayName: string
  department?: string | undefined
  roleCode: string
  permissions?: AccountPermissions | undefined
}

export async function createManagedUser(
  actor: Actor,
  input: CreateUserInput,
  context?: AuditContext,
): Promise<UserAdminResult<{ id: string; username: string; displayName: string }>> {
  const username = normalizeUsername(input.username)
  if (!isValidUsername(username)) {
    return { ok: false, reason: 'invalid_username' }
  }

  if (input.password.length < PASSWORD_MIN_LENGTH || input.password.length > PASSWORD_MAX_LENGTH) {
    return { ok: false, reason: 'invalid_password' }
  }

  const role = await prisma.role.findFirst({
    where: { code: input.roleCode, deletedAt: null },
    select: { id: true, code: true, rank: true },
  })
  if (role === null) return { ok: false, reason: 'invalid_role' }

  // 不允许创建 owner，也不允许创建 rank 不低于自己的角色。前者防止通过建号
  // 绕过「owner 不可降权」，后者保证层级只能往下派 —— 能给自己派同级角色等于
  // 造出一个平级账号，之后两个账号互相可视、互相可管。
  if (role.code === ROLE_CODES.OWNER || role.rank >= actor.roleRank) {
    return { ok: false, reason: 'role_not_assignable' }
  }

  const validated = validatePermissions(input.permissions?.granted, input.permissions?.denied)
  if (!validated.ok) return { ok: false, reason: 'invalid_permissions' }

  const taken = await prisma.user.findFirst({ where: { username }, select: { id: true } })
  if (taken !== null) return { ok: false, reason: 'username_taken' }

  // 哈希在事务外算，与 createOwnerAccount 同理：Argon2 单次几十毫秒，放进事务
  // 会让事务与它持有的锁多被占用这么久。
  const passwordHash = await hashPassword(input.password)

  let created: { id: string; username: string; displayName: string }
  try {
    created = await prisma.$transaction(async (tx) => {
      // 事务内重查一次用户名。事务外那次是廉价的前置检查，这里才是真正的判定 ——
      // 两次之间可能有另一个并发请求抢注了同一个名字。
      const stillTaken = await tx.user.findFirst({ where: { username }, select: { id: true } })
      if (stillTaken !== null) {
        throw new UsernameTakenError()
      }

      const user = await tx.user.create({
        data: {
          username,
          passwordHash,
          displayName: input.displayName,
          department: input.department?.trim() === '' ? null : (input.department ?? null),
          roleId: role.id,
          passwordChangedAt: new Date(),
        },
        select: { id: true, username: true, displayName: true },
      })

      if (validated.data.granted.length > 0 || validated.data.denied.length > 0) {
        await writePermissionOverrides(tx, user.id, validated.data)
      }

      return user
    })
  } catch (error) {
    // 并发抢注走到这里。事务外那次检查没能拦住竞争，这里才是真正的判定点。
    if (error instanceof UsernameTakenError) {
      return { ok: false, reason: 'username_taken' }
    }
    throw error
  }

  await recordAudit({
    action: AUDIT_ACTIONS.SYSTEM_USER_CREATE,
    actor: { id: actor.userId, name: actor.displayName },
    target: { type: 'user', id: created.id },
    // 不含 password，也不含它的哈希 —— 审计是长期保留且 owner 可读的，
    // 凭证一旦落进去就没有回收的余地。
    detail: { username: created.username, roleCode: role.code },
    ip: context?.ip,
    userAgent: context?.userAgent,
  })

  return { ok: true, data: created }
}

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

export type UpdateUserInput = {
  displayName?: string | undefined
  department?: string | null | undefined
  roleCode?: string | undefined
  status?: 'active' | 'locked' | 'disabled' | undefined
}

export async function updateManagedUser(
  actor: Actor,
  userId: string,
  input: UpdateUserInput,
  context?: AuditContext,
): Promise<UserAdminResult<{ affected: number }>> {
  const target = await loadUser(userId)
  if (target === null) return { ok: false, reason: 'user_not_found' }
  if (target.id === actor.userId) return { ok: false, reason: 'cannot_manage_self' }
  if (!canManage(actor, target)) return { ok: false, reason: 'cannot_manage_peer_or_above' }
  if (target.role.code === ROLE_CODES.OWNER) return { ok: false, reason: 'cannot_modify_owner' }

  const data: Record<string, unknown> = {}

  if (input.displayName !== undefined) data.displayName = input.displayName

  if (input.department !== undefined) {
    data.department = input.department?.trim() === '' ? null : (input.department ?? null)
  }

  if (input.status !== undefined) {
    if (!['active', 'locked', 'disabled'].includes(input.status)) {
      return { ok: false, reason: 'invalid_status' }
    }
    // 锁定交给登录限速自动处理。这里允许手工置为 locked，但**不允许手工解除** ——
    // 解除锁定会让「猜密码」这条路径的成本下降，而锁定到期的自动恢复已经够用。
    // active 是唯一被接受的「解锁」途径，且它要求管理员明确操作。
    if (target.status === 'locked' && input.status === 'active') {
      return { ok: false, reason: 'invalid_status' }
    }
    data.status = input.status
    // 重新启用时一并清掉锁定计数与截止时间，否则账号虽然能登录，界面上仍显示
    // 「已锁定」这个自相矛盾的状态。
    if (input.status === 'active') {
      data.failedLoginAttempts = 0
      data.lockedUntil = null
    }
  }

  if (input.roleCode !== undefined) {
    const role = await prisma.role.findFirst({
      where: { code: input.roleCode, deletedAt: null },
      select: { id: true, code: true, rank: true },
    })
    if (role === null) return { ok: false, reason: 'invalid_role' }
    if (role.code === ROLE_CODES.OWNER || role.rank >= actor.roleRank) {
      return { ok: false, reason: 'role_not_assignable' }
    }
    data.roleId = role.id
  }

  if (Object.keys(data).length === 0) {
    return { ok: true, data: { affected: 0 } }
  }

  const result = await prisma.user.updateMany({
    where: { id: userId, deletedAt: null },
    data,
  })

  // 停用或改角色后吊销该账号的会话。否则它手上的刷新令牌还能换出新令牌，
  // 「停用」只拦住了下一次登录，已经登录的人照样能用 —— 停用必须立刻生效。
  const shouldRevoke =
    input.status !== undefined && input.status !== 'active' ? true : input.roleCode !== undefined

  if (shouldRevoke) {
    await prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'account_modified' },
    })
  }

  await recordAudit({
    action: AUDIT_ACTIONS.SYSTEM_USER_UPDATE,
    actor: { id: actor.userId, name: actor.displayName },
    target: { type: 'user', id: userId },
    detail: {
      fields: Object.keys(data),
      // 不记 data 的值：它含 displayName 与 department，个人信息进长期审计表
      // 没有必要，记「改了哪些字段」足够回答「谁在什么时候动过这个账号」。
    },
    ip: context?.ip,
    userAgent: context?.userAgent,
  })

  return { ok: true, data: { affected: result.count } }
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

/**
 * 软删除账号。
 *
 * 走软删除而非物理删除，与 users 表上其它数据一致：账号被笔记、事件、审计日志
 * 引用，物理删除会连带抹掉那些历史痕迹（外键是 SetNull 或 Restrict，前者让
 * 历史记录里的操作人变空）。
 *
 * 删除前**必须吊销全部会话**，理由同 updateManagedUser。软删除后账号立刻无法
 * 登录，已签发的访问令牌也因 deletedAt 非空而失效，但刷新令牌若不吊销，仍能
 * 换出新的访问令牌 —— 那条路径查的是 tokenHash 而不检查账号状态。
 */
export async function deleteManagedUser(
  actor: Actor,
  userId: string,
  context?: AuditContext,
): Promise<UserAdminResult<{ affected: number }>> {
  const target = await loadUser(userId)
  if (target === null) return { ok: false, reason: 'user_not_found' }
  if (target.id === actor.userId) return { ok: false, reason: 'cannot_manage_self' }
  if (!canManage(actor, target)) return { ok: false, reason: 'cannot_manage_peer_or_above' }
  if (target.role.code === ROLE_CODES.OWNER) return { ok: false, reason: 'cannot_modify_owner' }

  const now = new Date()
  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { deletedAt: now, status: 'disabled' },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'account_deleted' },
    }),
  ])

  await recordAudit({
    action: AUDIT_ACTIONS.SYSTEM_USER_DELETE,
    actor: { id: actor.userId, name: actor.displayName },
    target: { type: 'user', id: userId },
    detail: { username: target.username },
    ip: context?.ip,
    userAgent: context?.userAgent,
  })

  return { ok: true, data: { affected: 1 } }
}

// ---------------------------------------------------------------------------
// 重置密码
// ---------------------------------------------------------------------------

/**
 * 重置密码。
 *
 * 与改其它字段相比，这一条多做了三件事，少做了一件：
 *
 * 多做的：**吊销全部会话**（改完密码旧设备还在用，等于密码没改）、**清零失败
 * 计数与锁定**（管理员重置密码的常见动机正是「账号被锁住了」，不清零的话
 * 重置完仍然登不进去）、**刷新 passwordChangedAt**。
 *
 * 少做的：**不改角色与权限**。重置密码不该顺带调整这个账号能做什么 ——
 * 那是权限页的事，混在一起会让一次操作产生两处变更，出问题时说不清是哪一处。
 */
export async function resetManagedUserPassword(
  actor: Actor,
  userId: string,
  newPassword: string,
  context?: AuditContext,
): Promise<UserAdminResult<{ affected: number }>> {
  const target = await loadUser(userId)
  if (target === null) return { ok: false, reason: 'user_not_found' }
  if (target.id === actor.userId) return { ok: false, reason: 'cannot_manage_self' }
  if (!canManage(actor, target)) return { ok: false, reason: 'cannot_manage_peer_or_above' }
  if (target.role.code === ROLE_CODES.OWNER) return { ok: false, reason: 'cannot_modify_owner' }

  if (newPassword.length < 12 || newPassword.length > 512) {
    return { ok: false, reason: 'invalid_password' }
  }

  const passwordHash = await hashPassword(newPassword)
  const now = new Date()

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash,
        passwordChangedAt: now,
        failedLoginAttempts: 0,
        lockedUntil: null,
        // 停用状态在重置密码后**不恢复**。停用与改密码是两件事：管理员可能刚
        // 停用某人就误点了重置，一并恢复 active 会让停用凭空失效。
        status: target.status === 'locked' ? 'active' : target.status,
      },
    }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'password_reset' },
    }),
  ])

  await recordAudit({
    action: AUDIT_ACTIONS.SYSTEM_USER_RESET_PASSWORD,
    actor: { id: actor.userId, name: actor.displayName },
    target: { type: 'user', id: userId },
    // 只有 id 与动作，没有新口令。审计是长期保留且 owner 可读的。
    detail: { username: target.username },
    ip: context?.ip,
    userAgent: context?.userAgent,
  })

  return { ok: true, data: { affected: 1 } }
}

// ---------------------------------------------------------------------------
// 权限设置
// ---------------------------------------------------------------------------

/**
 * 替换账号的权限覆盖。
 *
 * 整体替换（先删后建）而非增量，理由见 writePermissionOverrides 的注释。
 *
 * 对 owner 调用会被拒绝：owner 的权限来自服务端短路返回全部权限点，本表的数据
 * 对它不生效。在这里接受一次写入只会让人以为「设置生效了」，而实际上没有 ——
 * 静默无效比明确报错更难排查。
 */
export async function setManagedUserPermissions(
  actor: Actor,
  userId: string,
  permissions: { granted: readonly string[]; denied: readonly string[] },
  context?: AuditContext,
): Promise<UserAdminResult<{ affected: number }>> {
  const target = await loadUser(userId)
  if (target === null) return { ok: false, reason: 'user_not_found' }
  if (target.id === actor.userId) return { ok: false, reason: 'cannot_manage_self' }
  if (!canManage(actor, target)) return { ok: false, reason: 'cannot_manage_peer_or_above' }
  if (target.role.code === ROLE_CODES.OWNER) return { ok: false, reason: 'cannot_modify_owner' }

  const validated = validatePermissions(permissions.granted, permissions.denied)
  if (!validated.ok) return { ok: false, reason: 'invalid_permissions' }

  const grantedSet = new Set(validated.data.granted)
  if (validated.data.denied.some((code) => grantedSet.has(code))) {
    return { ok: false, reason: 'invalid_permissions' }
  }

  try {
    await prisma.$transaction(async (tx) => {
      await writePermissionOverrides(tx, userId, validated.data)
    })
  } catch {
    // 权限码在库里不存在（种子没跑或清单改过）。对外报非法权限，而不是把数据库
    // 的外键错误透给调用方 —— 后者会让排查方向先落到数据库上。
    return { ok: false, reason: 'invalid_permissions' }
  }

  await recordAudit({
    action: AUDIT_ACTIONS.SYSTEM_USER_SET_PERMISSIONS,
    actor: { id: actor.userId, name: actor.displayName },
    target: { type: 'user', id: userId },
    detail: {
      username: target.username,
      granted: validated.data.granted,
      denied: validated.data.denied,
    },
    ip: context?.ip,
    userAgent: context?.userAgent,
  })

  return { ok: true, data: { affected: 1 } }
}

/** 由路由层在启动时注入权限清单，避免本文件直接依赖 shared 的目录结构。 */
export function initPermissionCatalog(codes: readonly string[]): void {
  KNOWN_PERMISSIONS.clear()
  for (const code of codes) KNOWN_PERMISSIONS.add(code)
}
