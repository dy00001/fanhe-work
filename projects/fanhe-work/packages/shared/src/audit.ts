/**
 * 审计动作的唯一事实来源。
 *
 * 与权限点同样的理由放在共享包：动作码会写进 `audit_logs.action` 列，一旦落库就是
 * 历史数据，而审计查看界面要按它过滤与展示。两边各写一份字符串，界面上的表现只会
 * 是「某个动作查不到记录」，而库里其实有数据 —— 这类不一致在界面上看不出来。
 *
 * 命名沿用 模块.对象.操作 三段式，与权限点一致。
 *
 * 成功与失败**不拆成两个动作码**，用 `audit_logs.result` 列区分。同一个动作的两种
 * 结果是同一件事的两面，拆成两个码会让「按动作聚合」时漏掉一半记录。
 */

export const AUDIT_ACTIONS = {
  /** 登录。成功与失败用 result 区分。 */
  AUTH_SESSION_LOGIN: 'auth.session.login',
  /** 登出。撤销范围与本次实际撤销的令牌数记在 detail。 */
  AUTH_SESSION_LOGOUT: 'auth.session.logout',
  /** 刷新令牌重放：已轮换的令牌被再次使用且超出宽限期，按泄露处理并整链撤销。 */
  AUTH_SESSION_REUSE: 'auth.session.reuse',
  /** 首次初始化创建 owner 账号。 */
  SYSTEM_SETUP_INITIALIZE: 'system.setup.initialize',
  /** 创建子账号。 */
  SYSTEM_USER_CREATE: 'system.user.create',
  /** 修改子账号的姓名、部门、角色或状态。 */
  SYSTEM_USER_UPDATE: 'system.user.update',
  /** 删除子账号（软删除）。 */
  SYSTEM_USER_DELETE: 'system.user.delete',
  /** 重置子账号密码。detail 里**不含**新口令。 */
  SYSTEM_USER_RESET_PASSWORD: 'system.user.reset_password',
  /** 调整子账号的账号级权限覆盖。 */
  SYSTEM_USER_SET_PERMISSIONS: 'system.user.set_permissions',
  /**
   * 客户归属变更（设计师 / 销售）。detail 记 `{ from, to, reason }`。
   *
   * 归属变更必须留痕：它同时改变「谁能看到这份档案」与「这单算谁的业绩」，
   * 而客户档案按人隔离之后，「谁把客户划走了」是一个必须能回答的问题。
   */
  CUSTOMER_ASSIGNMENT_CHANGE: 'customer.assignment.change',
  /**
   * 行级越权尝试：有客户段权限，但目标客户不在自己的归属范围内。
   *
   * 与 `system.*` 的 403 不同，行级越权对外返回 404（不泄露存在性），因此请求日志
   * 里看不出来。这条审计的唯一用途是发现「有人在按 id 顺序试探」。
   */
  CUSTOMER_ACCESS_DENIED: 'customer.access.denied',
  /** 公共池归类结果的人工复核：接受 / 调整 / 驳回。detail 记判定与理由。 */
  CUSTOMER_POOL_REVIEW: 'customer.pool.review',
} as const

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]
