/**
 * 谁能用「AI 数据汇报」，以及每个模块能看到什么。
 *
 * **两层，各管一件事，不要合并。**
 *
 *   第一层：角色。只有超级管理员与管理员能调用这个能力。判据是 `roleCode`，
 *           不是权限点 —— 需求原话是「仅对超级管理员和管理员角色开放」，说的是
 *           岗位而不是某个动作。新增一个权限点表达它，代价是 `migrate` 与 `api`
 *           两个镜像都得重建，还得重跑 `db:seed`；而换来的只是把同一个判断挪个地方。
 *
 *   第二层：权限点。决定**进去之后能看到哪些字段**。这一层必须走权限点，
 *           因为它要和现有体系联动：管理员哪天被收回 `ops.finance.read`，
 *           汇报里的金额要立刻跟着消失，而不是继续出现在一份「AI 生成的文档」里。
 *
 * 换句话说：**角色决定「能不能问」，权限点决定「能问到什么」。** 前者是入口，
 * 后者是边界。把后者也写成角色判断，就会出现「汇报里的金额」与「看板上的金额」
 * 两套口径 —— 那种不一致比多给一个入口危险得多。
 */

import { PERMISSIONS, ROLES, hasPermission, type PermissionCode } from '@fanhe/shared'
import type { AuthContext } from '../auth/guard.js'
import type { AssistantDataModule, AssistantModuleReason } from '@fanhe/shared'

/**
 * 允许使用数据汇报的角色。
 *
 * `owner` 与 `admin` 是六个内置角色里仅有的两个管理岗。`designer` / `sales` /
 * `member` / `viewer` 一律不可见、不可调用 —— 前端的入口不渲染，后端的接口返回 403，
 * 两道都在，不靠「前端藏起来」当权限。
 */
export const ASSISTANT_DATA_ROLES: readonly string[] = ['owner', 'admin']

/** 每个模块的「读」权限点。与各自路由上的 `preHandler` 用的是同一个常量。 */
const MODULE_PERMISSION: Record<AssistantDataModule, PermissionCode> = {
  ops: PERMISSIONS.OPS_SHOP_READ,
  customer: PERMISSIONS.CUSTOMER_RECORD_READ,
  quote: PERMISSIONS.PERSONAL_QUOTE_READ,
}

export type AssistantModuleAccess = {
  allowed: boolean
  /** 不允许时的原因。允许时为 null。 */
  reason: AssistantModuleReason | null
}

export type AssistantDataViewer = {
  userId: string
  roleCode: string
  roleName: string
  permissions: readonly PermissionCode[]
  /** 三模块各自的取数资格。没资格的模块不进汇报，也不进提示词。 */
  modules: Record<AssistantDataModule, AssistantModuleAccess>
}

/** 角色名给汇报正文用。查不到时退回 code，绝不编一个好听的名字。 */
function roleNameOf(roleCode: string): string {
  const role = ROLES.find((item) => item.code === roleCode)
  return role === undefined ? roleCode : role.name
}

/**
 * 把认证上下文转成数据桥视角。角色不符时返回 `null`，由调用方回 403。
 *
 * 返回 `null` 而不是抛错：路由层还要区分「没登录（401）」与「登录了但角色不够
 * （403）」，抛错会把这个区分糊掉。
 */
export function viewerForAssistant(context: AuthContext): AssistantDataViewer | null {
  if (!ASSISTANT_DATA_ROLES.includes(context.roleCode)) return null

  const modules = Object.fromEntries(
    (Object.keys(MODULE_PERMISSION) as AssistantDataModule[]).map((module) => {
      const allowed = hasPermission(context.permissions, MODULE_PERMISSION[module])
      return [module, { allowed, reason: allowed ? null : 'no_permission' }]
    }),
  ) as Record<AssistantDataModule, AssistantModuleAccess>

  return {
    userId: context.userId,
    roleCode: context.roleCode,
    roleName: roleNameOf(context.roleCode),
    permissions: context.permissions,
    modules,
  }
}

/** 汇报开头那句「数字的边界」。范围收窄这件事必须在正文里说出来，不能只体现在数字上。 */
export function scopeNoteOf(viewer: AssistantDataViewer): string {
  const entries = (Object.keys(viewer.modules) as AssistantDataModule[]).map((module) => {
    const access = viewer.modules[module]
    return `${MODULE_LABEL[module]}：${access.allowed ? '已纳入' : '无权限，未纳入'}`
  })
  return entries.join('；')
}

export const MODULE_LABEL: Record<AssistantDataModule, string> = {
  ops: '运营信息平台',
  customer: '客户信息平台',
  quote: '报价体系',
}
