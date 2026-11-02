/**
 * 客户行的可见范围。
 *
 * 权限点体系只有「动作」这一个维度：`customer.record.read` 表示「能不能读客户」。
 * 本期要的「只能读自己负责的那些行」是**数据行维度**，无法用再加一个动作点表达。
 * 因此把范围做成第三个维度，与动作正交：
 *
 *   - 持有 `customer.scope.read` → 全库；
 *   - 不持有 → 收窄为 `designer_id = 我 OR sales_id = 我`。
 *
 * **默认收窄、显式放开。** 新加一个岗位却忘了配范围点时，结果是看到得少，而不是
 * 看到全部 —— 这两种失败的代价差一个数量级。
 *
 * **只认权限点，不认 roleCode。** 写 `roleCode === 'designer'` 会在「给某个成员单独
 * 授予范围点」时失效，而那种授予正是本设计的目的。
 */

import { PERMISSIONS, hasPermission } from '@fanhe/shared'
import type { FastifyRequest } from 'fastify'

import type { Prisma } from '../generated/prisma/client.js'

export type CustomerScope = { kind: 'all' } | { kind: 'own'; userId: string }

/**
 * 一次客户请求的「观察者」。把四件与当前账号有关的事实打包在一起，
 * 而不是给每个 service 函数加三个布尔参数 —— 加参数时漏传一个的后果是
 * 静默放开整个范围，而编译器不会报错。
 */
export type CustomerViewer = {
  userId: string
  /** 审计里的操作者快照。账号删除后仍要能回答「谁改的」。 */
  displayName: string
  /**
   * 角色 code。**只用于「新建客户时默认归到哪一栏」这一件事**，不参与任何
   * 可见性判断 —— 可见性只看 `scope`。把角色接进授权判断会让「调岗」变成一次
   * 授权变更，而调岗本身不该有这个副作用。
   */
  roleCode: string
  scope: CustomerScope
  /** 在可见行内，金额是否不被打码。行本身是否可见由 `scope` 决定。 */
  canReadFinance: boolean
  /** 能否复核导入与公共池归类（`customer.import.review`）。 */
  canReview: boolean
  /** 能否调整归属、把客户转派给他人（`customer.scope.write`）。 */
  canAssign: boolean
}

/**
 * 从请求上下文算出观察者。未认证返回 null，由调用方决定是 401 还是拒绝。
 *
 * 返回 null 而不是退化成一个「什么都不能看」的观察者：判空方向决定了一旦守卫
 * 出问题，结果是拒绝还是按本人放行。取拒绝。
 */
export function viewerFromRequest(request: FastifyRequest): CustomerViewer | null {
  const context = request.authContext
  if (context === null) return null

  return {
    userId: context.userId,
    displayName: context.displayName,
    roleCode: context.roleCode,
    scope: hasPermission(context.permissions, PERMISSIONS.CUSTOMER_SCOPE_READ)
      ? { kind: 'all' }
      : { kind: 'own', userId: context.userId },
    canReadFinance: hasPermission(context.permissions, PERMISSIONS.CUSTOMER_FINANCE_READ),
    canReview: hasPermission(context.permissions, PERMISSIONS.CUSTOMER_IMPORT_REVIEW),
    canAssign: hasPermission(context.permissions, PERMISSIONS.CUSTOMER_SCOPE_WRITE),
  }
}

/**
 * 范围条件。
 *
 * 用 `OR` 而不是把两个归属合成一个数组列：两列的索引各自可用，而 Postgres 对
 * `OR` 两侧都走索引，成本与一次 union 相当。合成数组列（`assignee_ids uuid[]`）
 * 会让「这位客户的销售是谁」变成一个数组下标问题，界面上根本没法展示。
 */
export function scopeWhere(scope: CustomerScope): Prisma.CustomerWhereInput {
  if (scope.kind === 'all') return {}
  return { OR: [{ designerId: scope.userId }, { salesId: scope.userId }] }
}

/** 已取出的行是否在范围内。给「先查后判」的分支用，正常路径应把条件写进 where。 */
export function isInScope(
  row: { designerId: string | null; salesId: string | null },
  scope: CustomerScope,
): boolean {
  if (scope.kind === 'all') return true
  return row.designerId === scope.userId || row.salesId === scope.userId
}

/**
 * 当前账号在这位客户上的身份。`null` 表示不是负责人（全局范围账号的常态）。
 *
 * 一个人同时是某位客户的设计师与销售时返回 `designer`：两个身份在权限上完全
 * 等价，界面只需要显示一个「我」，取哪一个不影响任何判断。
 */
export function roleOf(
  row: { designerId: string | null; salesId: string | null },
  userId: string,
): 'designer' | 'sales' | null {
  if (row.designerId === userId) return 'designer'
  if (row.salesId === userId) return 'sales'
  return null
}

/**
 * 系统观察者。给命令行工具与「写完之后回读详情」的内部调用用。
 *
 * 它的 userId 是一个全零 UUID，不是任何真实账号 —— 因此 `myRole` 永远为 null，
 * 归属展示不会误标成「我」。scope 为 all、金额可见，因为这个观察者只出现在
 * 不受请求上下文约束的场景（导入脚本、同步任务）。
 */
export const SYSTEM_VIEWER: CustomerViewer = {
  userId: '00000000-0000-0000-0000-000000000000',
  displayName: '系统',
  roleCode: 'owner',
  scope: { kind: 'all' },
  canReadFinance: true,
  canReview: true,
  canAssign: true,
}

/**
 * 审计与「复核人」字段里的操作者。
 *
 * **`SYSTEM_VIEWER` 的 userId 不是任何真实账号**，把它直接写进
 * `audit_logs.actor_id` 或 `customer_pool_suggestions.reviewed_by` 会撞外键。
 * 前者被 `recordAudit` 吞掉（主流程继续，但库里一条审计都没有，日志里只有一行
 * 「写入失败」）；后者不吞，整次复核直接抛错。
 *
 * 这两个后果都不是「明显坏掉」，而是「看起来跑通了、痕迹没了」，所以在这里
 * 统一收口：真实账号给 id，系统观察者只留名字快照。
 */
export function actorOf(viewer: CustomerViewer): { id: string | null; name: string } {
  if (viewer.userId === SYSTEM_VIEWER.userId) return { id: null, name: viewer.displayName }
  return { id: viewer.userId, name: viewer.displayName }
}
