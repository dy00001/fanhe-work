import {
  AUDIT_ACTIONS,
  isValidUsername,
  mergePermissions,
  normalizeUsername,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  ROLE_CODES,
  USERNAME_MAX_LENGTH,
  type AccountPermissions,
  type PermissionCode,
} from '@fanhe/shared'

import { recordAudit, type AuditContext } from '../audit/audit.js'
import { prisma } from '../db/prisma.js'
import { Prisma } from '../generated/prisma/client.js'
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

/**
 * 已删除账号的登录名墓碑前缀。
 *
 * 首字符取 `#`，而 `USERNAME_PATTERN` 要求首字符是字母或数字 —— 这类名字**永远
 * 无法通过 `isValidUsername`**，因此不可能被谁注册进来，也就不会与真实账号撞名。
 */
const DELETED_USERNAME_PREFIX = '#deleted#'

/**
 * 把已删除账号的登录名改写成「墓碑」，释放它占着的那一格唯一索引。
 *
 * ## 为什么要这么做
 *
 * `users.username` 上是**全表唯一索引**（`users_username_key`），不带
 * `deleted_at IS NULL` 条件。Prisma 的 `@unique` 表达不出部分唯一索引，这一点在
 * `launch_profiles` 的表注释里已经记过一次：软删除与普通唯一索引天然冲突 ——
 * 删掉一行之后，同名的第二行永远插不进来，而报错信息只说「重复键」。
 *
 * 账号管理这条路径比它更严重：`POST /api/system/users` 撞上的是业务层预检，
 * 提示「登录账号已被占用」，而占用它的那条记录在界面上已经看不到了。管理员看到
 * 的是一个自相矛盾的画面 —— 列表里没有这个账号，系统却说它被占着。
 *
 * 两条可选的路：把唯一索引换成 `WHERE deleted_at IS NULL` 的部分索引，或者在
 * 删除时把登录名让出来。选后者，理由有三条：
 *
 * 1. **不需要迁移。** 部分唯一索引只能手写 SQL 迁移，且 `schema.prisma` 里会留下
 *    一个 Prisma 认不出的索引，之后每次 `migrate dev` 都会想把它改回去。把代价
 *    压在一条 UPDATE 上，比压在 schema 的长期一致性上划算。
 * 2. **数据库的唯一性保证不被削弱。** 全表唯一索引仍在，并发抢注由数据库兜底；
 *    改成部分索引虽然语义更准，但那条约束从此只存在于迁移文件里，任何人重建库时
 *    都可能漏掉。
 * 3. **「删除后释放登录名」本身就是产品语义。** 管理员删掉一个账号，期望的是
 *    这个名字可以再给下一个人用，而这条规则由删除动作自己完成，不依赖调用方记得
 *    去过滤 `deletedAt`。
 *
 * ## 为什么用 id 而不是随机串
 *
 * 墓碑值必须**互不相同**：同一个登录名可能被建、删、再建、再删反复多轮，每轮的
 * 行都要有自己的墓碑。用行 id 做后缀是确定性的，不会出现「随机串碰撞导致删除
 * 失败」这种无法复现的故障；id 本身是全表唯一，重复的墓碑值不可能出现。
 *
 * 长度：`#deleted#` + uuid(36) + `#` 共 46 字符，`username` 是 VarChar(64)，因此
 * 原名最多还能留 18 个字符。留一段原名是为了让直接查库的人一眼看出这行原来是谁，
 * 完整的原名另有去处 —— 删除动作会把 `username` 写进审计 detail，那条记录不会被
 * 后续改名影响。
 */
function deletedUsernameTombstone(username: string, userId: string): string {
  const head = `${DELETED_USERNAME_PREFIX}${userId}#`
  const keep = Math.max(0, USERNAME_MAX_LENGTH - head.length)
  return `${head}${username.slice(0, keep)}`
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

  // 占用判定只认**未删除**的行。
  //
  // 这里此前少了 `deletedAt: null`，于是软删除的账号会继续挡住同名的新账号：
  // 界面上已经看不到它，接口却回「登录账号已被占用」。那段残留同时体现在唯一索引
  // 上，见 deletedUsernameTombstone 的注释 —— 两处都要修，只修一处仍然建不回来。
  const taken = await prisma.user.findFirst({
    where: { username, deletedAt: null },
    select: { id: true },
  })
  if (taken !== null) return { ok: false, reason: 'username_taken' }

  // 哈希在事务外算，与 createOwnerAccount 同理：Argon2 单次几十毫秒，放进事务
  // 会让事务与它持有的锁多被占用这么久。
  const passwordHash = await hashPassword(input.password)

  let created: { id: string; username: string; displayName: string }
  try {
    created = await prisma.$transaction(async (tx) => {
      // 事务内重查一次用户名。事务外那次是廉价的前置检查，这里才是真正的判定 ——
      // 两次之间可能有另一个并发请求抢注了同一个名字。
      //
      // 查的是**任意状态**的行，而不是只查未删除的：唯一索引覆盖全表，一条已删除
      // 的行如果还顶着这个名字，插入必然撞键。那种行来自本修复上线之前的历史数据
      // （删除时没有改名），在这里顺手把它改成墓碑，等于一次惰性回收 —— 管理员
      // 不需要记得跑清理脚本，第一次重建同名账号时数据自己就对齐了。
      const holder = await tx.user.findFirst({
        where: { username },
        select: { id: true, deletedAt: true },
      })
      if (holder !== null && holder.deletedAt === null) {
        throw new UsernameTakenError()
      }
      if (holder !== null) {
        await tx.user.update({
          where: { id: holder.id },
          data: { username: deletedUsernameTombstone(username, holder.id) },
        })
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
    // 兜底：唯一索引是最后一道防线，它拦下的重复键同样是「名字被占用」这件事。
    // 不接这一支的话，两个并发请求各自通过预检时，后到的那个会拿到 500，而界面
    // 会把 500 显示成「操作失败，请稍后重试」—— 管理员会反复重试，每一次都被
    // 同一条约束拒绝，却看不出真正的原因。
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
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
 * 软删除账号，并把它占着的登录名、权限覆盖与会话一并清干净。
 *
 * 走软删除而非物理删除，与 users 表上其它数据一致：账号被笔记、事件、审计日志
 * 引用，物理删除会连带抹掉那些历史痕迹（外键是 SetNull 或 Restrict，前者让
 * 历史记录里的操作人变空）。
 *
 * **删除必须同时清掉三类残留**，缺任何一类都会留下「账号已删除却还在影响系统」
 * 的状态：
 *
 * 1. **登录名（唯一性校验数据）。** 软删除的行仍然是一行真实存在的记录，
 *    `users_username_key` 这个全表唯一索引照样认它。删除时把登录名改写成墓碑，
 *    名字才真正让出来 —— 细节见 `deletedUsernameTombstone`。
 * 2. **账号级权限覆盖。** 那是「这个人被单独调整过什么」，账号没了就失去归属对象。
 *    同名重建会拿到新的 `user_id`，旧行不会被继承，留着只是孤儿数据。
 * 3. **会话。** 刷新令牌若不吊销，仍能换出新的访问令牌 —— 那条路径查的是
 *    `tokenHash` 而不检查账号状态。**吊销而不删除**：那一行是「这张令牌为什么
 *    失效」的唯一凭据，删掉就再答不出它是被删除带走的还是自然过期的。
 *
 * 失败计数与锁定时间也一并清零。行被软删后没有任何路径再读它们，留着只会在人工
 * 查库时误导 —— 看起来像这个账号还在被人爆破。
 *
 * 删除前的层级与 owner 判定见上方 `canManage`：能删掉谁，与它是不是 owner、
 * rank 高低有关，与权限点无关。
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
      data: {
        // 登录名改写必须在**同一个事务**里与软删除一起提交。分成两次写的话，
        // 中间态是「行还在列表外、名字已被改掉」或者反过来「名字还占着、账号
        // 已消失」，两个中间态都会让并发到来的创建请求做出错误判断。
        username: deletedUsernameTombstone(target.username, userId),
        deletedAt: now,
        status: 'disabled',
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    }),
    prisma.userPermission.deleteMany({ where: { userId } }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'account_deleted' },
    }),
  ])

  await recordAudit({
    action: AUDIT_ACTIONS.SYSTEM_USER_DELETE,
    actor: { id: actor.userId, name: actor.displayName },
    target: { type: 'user', id: userId },
    // 记的是**删除前**的那个登录名。行上的 username 此刻已经变成墓碑，审计是
    // 事后回答「删掉的是哪个账号」的唯一依据，它不能被墓碑影响。
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

  // 长度必须用 shared 的常量，不要在这里写字面量。
  //
  // 这里曾写死成 `< 12`：路由的 JSON schema 与错误文案都是 `PASSWORD_MIN_LENGTH`
  // （6），于是 6~11 位的密码过了 schema、被业务层拦下，返回的却是「密码长度需在
  // 6 到 512 之间」—— 用户照着提示输 6 位，系统坚持说不合要求。三个地方各说各的
  // 话，只有常量能把它们绑在一起。
  //
  // 若将来要收紧或放宽，改 `packages/shared/src/account.ts` 的常量：schema、文案、
  // 创建账号的校验、前端输入框占位符会一起跟着变。
  if (newPassword.length < PASSWORD_MIN_LENGTH || newPassword.length > PASSWORD_MAX_LENGTH) {
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
