/**
 * 账号与权限管理的跨进程传输结构。
 *
 * 与其它共享模块同一原则：这里只放**传输形态**，服务端怎么做校验、数据库怎么存
 * 都不在这里体现。两端各写一份的话，改字段名只会在联调时报错，而那类错误的
 * 表现是「界面拿不到数据」，排查方向会先落到网络与数据库上。
 *
 * ## 角色与权限的关系
 *
 * 一个账号的最终权限由三处共同决定：
 *
 *   1. 它的**角色**带来一组默认权限（`rolePermissions`，由种子维护）
 *   2. 它的**账号级授予**（`granted`）额外加上
 *   3. 它的**账号级拒绝**（`denied`）再减掉
 *
 * 拒绝优先于授予。界面上的勾选结果被拆成这两组，理由见 `AccountPermissions`
 * 的注释。
 */

import type { PermissionCode } from './permissions.js'

/**
 * 账号状态，与数据库枚举取值一致。
 *
 * 刻意不引用服务端生成的 Prisma 枚举：那个类型的路径在 apps/api 内部，共享包
 * 引它会形成 packages → apps 的反向依赖。取值用字符串字面量对齐，schema 是
 * 这里的唯一事实来源。
 */
export const USER_STATUSES = ['active', 'locked', 'disabled'] as const
export type UserStatus = (typeof USER_STATUSES)[number]

/**
 * 账号列表与详情里的单条记录。
 *
 * **不含 passwordHash。** 它是派生值，属于「永远不进传输层」的那一类。任何时候
 * 响应体里出现哈希串，都说明 select 写漏了字段。
 *
 * `permissions` 是该账号最终持有的权限点。服务端算好再传，前端不需要也不应该
 * 知道角色权限与账号覆盖是怎么合并的。
 *
 * `canBeManaged` 由服务端算出，表示当前登录者能否操作这个账号（层级判定）。
 * 前端据此决定编辑/删除按钮的可用状态。它是**体验**依据，服务端在每个接口里
 * 会独立重判 —— 改一个请求就能绕过前端，而前端这一层本来就只是给人看的。
 */
export type ManagedUser = {
  id: string
  username: string
  displayName: string
  /** 所属部门，纯展示。owner 账号为 null。 */
  department: string | null
  status: UserStatus
  role: {
    id: string
    code: string
    name: string
    /** 层级。数值大的能管理数值小的。 */
    rank: number
  }
  permissions: readonly PermissionCode[]
  /** 是否为 owner。owner 账号不可被删除或降权，界面据此禁用相关操作。 */
  isOwner: boolean
  /** 当前登录者能否管理这个账号。 */
  canBeManaged: boolean
  lastLoginAt: string | null
  createdAt: string
}

/** 账号列表响应。 */
export type ManagedUserListResponse = {
  users: readonly ManagedUser[]
}

/**
 * 单个账号的账号级权限覆盖。
 *
 * `granted` 与 `denied` 分开传，而不是传一个最终集合。传最终集合的话，前端
 * 算不出「用户取消了一个勾选」与「用户根本没勾过」的区别 —— 而这两者在保存时
 * 需要写入不同的行。
 *
 * 界面上的实际做法反过来：勾选框只有「选中 / 未选中」两态，提交时对每个权限点
 * 判断它相对角色权限的状态，变化的那些才进这两组。
 */
export type AccountPermissions = {
  /** 相对角色权限额外授予的权限点。 */
  granted: readonly PermissionCode[]
  /** 相对角色权限显式拒绝的权限点，优先于 granted。 */
  denied: readonly PermissionCode[]
}

/** 账号详情响应：账号本身 + 它的角色默认权限 + 账号级覆盖。 */
export type ManagedUserDetailResponse = {
  user: ManagedUser
  /** 角色自带的权限点，界面用它算「默认已勾选」的初始状态。 */
  rolePermissions: readonly PermissionCode[]
  /** 账号级覆盖。 */
  permissions: AccountPermissions
}

/** 创建账号的请求体。 */
export type CreateManagedUserRequest = {
  username: string
  password: string
  displayName: string
  department?: string
  /** 目标角色 code。owner 不接受，会被服务端拒绝。 */
  roleCode: string
  /** 初始账号级覆盖，可省略。 */
  permissions?: AccountPermissions
}

/** 修改账号的请求体。字段全部可选，只更新传了的那些。 */
export type UpdateManagedUserRequest = {
  displayName?: string
  department?: string | null
  roleCode?: string
  status?: UserStatus
}

/** 设置账号级权限的请求体。整体替换，不是增量。 */
export type SetManagedUserPermissionsRequest = {
  granted: readonly PermissionCode[]
  denied: readonly PermissionCode[]
}

/** 重置密码的请求体。 */
export type ResetManagedUserPasswordRequest = {
  /** 不满足强度要求时由服务端拒绝。 */
  newPassword: string
}

/**
 * 创建账号的响应。
 *
 * 额外返回 `effectivePermissions` 与 `rolePermissions`，让界面在创建成功后能
 * 立刻显示「这个账号实际能做什么」，不必再拉一次详情。
 */
export type CreateManagedUserResponse = {
  user: ManagedUser
  rolePermissions: readonly PermissionCode[]
  effectivePermissions: readonly PermissionCode[]
}

/** 通用操作响应。目前只有被影响行数，供界面确认操作已生效。 */
export type ManagedUserActionResponse = {
  /** 实际被修改的记录数。幂等操作返回 0。 */
  affected: number
}

/** 权限点清单响应，供界面渲染勾选树。 */
export type PermissionCatalogResponse = {
  permissions: readonly {
    code: PermissionCode
    module: string
    object: string
    action: string
    description: string
  }[]
}

/** 角色清单响应，供创建/编辑时的角色下拉。 */
export type RoleListResponse = {
  roles: readonly {
    id: string
    code: string
    name: string
    description: string | null
    rank: number
    /** owner 角色为 true，界面据此禁用「选 owner」的选项。 */
    isSystem: boolean
  }[]
}
