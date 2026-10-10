/**
 * 认证相关的跨进程传输结构。
 *
 * 服务端签发、前端消费，两端引用同一份定义。分别写在两边的话，改一个字段名
 * 只会在联调时报错，而这类错误的表现是「界面拿不到数据」，排查方向会先落到
 * 网络与数据库上。
 *
 * 这里只放**传输形态**，不放行为。令牌的签发、校验、轮换留在 apps/api 内部，
 * 前端也不该知道访问令牌是 JWT、刷新令牌是随机串 —— 它只需要知道哪个该短命、
 * 哪个该持久化。把实现细节放进共享包会让前端有机会依赖它，从而在将来更换
 * 令牌方案时被反向牵制。
 */

import type { PermissionCode } from './permissions.js'

/**
 * 已认证用户的公开信息。
 *
 * 刻意不含 email、手机号这类字段，也刻意不含 passwordHash 之类的派生值。
 * 它是「可以展示给客户端」的集合，新增字段前先确认它是否属于这个集合。
 */
export type AuthenticatedUser = {
  id: string
  username: string
  /** 展示名，允许中文。与 username 的区别见 account.ts。 */
  displayName: string
  /**
   * 角色 code。取值域是 ROLE_CODES，但库里读出的是字符串，这里不把它收窄成
   * RoleCode：收窄需要在服务端做一次运行期断言，而失败方式只是「类型好看一点」。
   * 需要穷举判断时在消费侧对照 ROLE_CODES 收窄。
   */
  role: string
}

/**
 * 登录成功的响应体。
 *
 * `expiresIn` 是访问令牌的有效期（秒），客户端据此安排静默续期。让客户端知道
 * 这个值，是为了避免它靠「请求失败再刷新」这种被动方式续期 —— 那样每个到期点
 * 都会先产生一次失败请求。
 */
export type LoginResponse = {
  accessToken: string
  refreshToken: string
  /** 访问令牌有效期，单位秒。 */
  expiresIn: number
  user: AuthenticatedUser
}

/**
 * 刷新令牌换新令牌的响应体。
 *
 * 不返回 user：刷新只延长会话，不改变身份。需要用户信息时由 /api/auth/me 提供，
 * 把两份数据合并会让「刷新成功但用户已被停用」这种中间状态缺少落点。
 */
export type RefreshResponse = {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

/**
 * 登出响应。
 *
 * `revoked` 是本次实际撤销的令牌数。登出是幂等的，令牌不存在或已撤销时返回 0，
 * 调用方仍应视为成功。把这个数返回出来，是为了让「点了登出但什么都没发生」在
 * 排查时有据可查。
 */
export type LogoutResponse = {
  revoked: number
}

/**
 * 当前用户与展开后的权限点。
 *
 * 权限点是**给前端做可见性判断**用的，服务端仍然独立校验。前端拿到的是「可以
 * 展示什么」，不是「可以做什么」：任何人改一个请求就能绕过前端的判断。
 *
 * 用 readonly 数组：调用方只应读取，不应就地修改后再当作授权依据。
 */
export type MeResponse = {
  user: AuthenticatedUser
  permissions: readonly PermissionCode[]
}

/**
 * 初始化状态。只回答一个问题，且答案在攻击者试一次初始化时就知道，因此不设门禁。
 */
export type SetupStatusResponse = {
  initialized: boolean
}

/**
 * 初始化成功后返回的账号摘要。
 *
 * 不含令牌。初始化与登录是两件事，合成一条路径会多出一条需要单独验证的令牌
 * 签发入口，而客户端紧接着调一次登录接口的成本几乎为零。
 */
export type InitializeOwnerResponse = {
  id: string
  username: string
  displayName: string
}

/**
 * 错误响应体。
 *
 * `error` 是稳定的机器可读码，供客户端分支判断；`message` 是给人看的文案，允许
 * 随产品调整。客户端不应解析 message 来判分支，文案一改分支就失效，且失效时
 * 不报错，只是走进错误的分支。
 */
export type ApiErrorResponse = {
  error: string
  message: string
}
