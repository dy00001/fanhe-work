import type {
  AccountPermissions,
  CreateManagedUserRequest,
  ManagedUser,
  ManagedUserDetailResponse,
  PermissionCode,
  PermissionCatalogResponse,
  RoleListResponse,
  UpdateManagedUserRequest,
} from '@fanhe/shared'

import { ApiError } from './api'
import {
  createManagedUserRequest,
  deleteManagedUserRequest,
  managedUserDetailRequest,
  managedUsersRequest,
  permissionCatalogRequest,
  resetManagedUserPasswordRequest,
  roleListRequest,
  setManagedUserPermissionsRequest,
  updateManagedUserRequest,
} from './api'
import { withAccessToken } from './session'

/**
 * 账号与权限管理的前端数据层。
 *
 * 沿用 `lib/notes.ts` 的三层分工：api.ts 发请求，本文件拆信封，session.ts 管令牌。
 * 这里额外承担一件业务计算，理由见 `diffPermissions` 的注释。
 */

/** 账号列表。 */
export function loadManagedUsers(): Promise<readonly ManagedUser[]> {
  return withAccessToken(async (token) => (await managedUsersRequest(token)).users)
}

/**
 * 账号详情，含角色默认权限与账号级覆盖。
 *
 * 界面要用「角色默认权限」算勾选框的初始状态，因此这个函数把 detail 原样透出，
 * 不在这里压扁 —— 压掉的那一项恰好是界面需要的。
 */
export function loadManagedUserDetail(id: string): Promise<ManagedUserDetailResponse> {
  return withAccessToken((token) => managedUserDetailRequest(token, id))
}

export function loadPermissionCatalog(): Promise<PermissionCatalogResponse> {
  return withAccessToken((token) => permissionCatalogRequest(token))
}

export function loadRoles(): Promise<RoleListResponse> {
  return withAccessToken((token) => roleListRequest(token))
}

export function createManagedUser(input: CreateManagedUserRequest): Promise<ManagedUser> {
  return withAccessToken(async (token) => (await createManagedUserRequest(token, input)).user)
}

export function updateManagedUser(
  id: string,
  input: UpdateManagedUserRequest,
): Promise<{ affected: number }> {
  return withAccessToken((token) => updateManagedUserRequest(token, id, input))
}

/**
 * 删除账号。
 *
 * 失败时把服务端的文案原样传出。特别是「只能管理层级低于自己的账号」这类，
 * 服务端的说法比前端的通用提示准确 —— 前端不知道对方的 rank。
 */
export function deleteManagedUser(id: string): Promise<{ affected: number }> {
  return withAccessToken((token) => deleteManagedUserRequest(token, id))
}

export function resetManagedUserPassword(
  id: string,
  newPassword: string,
): Promise<{ affected: number }> {
  return withAccessToken((token) => resetManagedUserPasswordRequest(token, id, newPassword))
}

export function setManagedUserPermissions(
  id: string,
  permissions: AccountPermissions,
): Promise<{ affected: number }> {
  return withAccessToken((token) =>
    setManagedUserPermissionsRequest(token, id, {
      granted: permissions.granted,
      denied: permissions.denied,
    }),
  )
}

/**
 * 算出一组勾选相对角色默认权限的变化。
 *
 * **这是整个权限界面的核心，也是最容易写错的一处。** 勾选框只有「选中 / 未选中」
 * 两态，而服务端要的是「相对角色默认权限改变了什么」：
 *
 *   - 角色本来就有、用户也勾了 → 什么都没变，不写行
 *   - 角色本来没有、用户勾了 → **granted**
 *   - 角色本来有、用户取消了 → **denied**
 *   - 角色本来没有、用户也没勾 → 什么都没变，不写行
 *
 * 第二条与第三条是关键：如果只把「勾中的」当成 granted，那么「取消一个角色自带的
 * 权限」就表达不出来 —— 界面上取消掉了，保存后它又回来了，且界面上仍显示已取消。
 * 用户会看到一个勾选框怎么点都存不住。
 *
 * 纯函数，不依赖 React，因此可以直接测。
 */
export function diffPermissions(
  selected: ReadonlySet<PermissionCode>,
  roleDefaults: ReadonlySet<PermissionCode>,
): AccountPermissions {
  const granted: PermissionCode[] = []
  const denied: PermissionCode[] = []

  for (const code of selected) {
    if (!roleDefaults.has(code)) granted.push(code)
  }
  for (const code of roleDefaults) {
    if (!selected.has(code)) denied.push(code)
  }

  return { granted, denied }
}

/**
 * 把服务端错误翻成一句能直接展示的话。
 *
 * 服务端已经给了中文文案，直接用即可。这里只对「不是 ApiError」的情况补一句
 * 兜底 —— 那时服务端没有给过文案。
 */
export function describeUserAdminError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message
  }
  return '操作失败，请稍后重试'
}
