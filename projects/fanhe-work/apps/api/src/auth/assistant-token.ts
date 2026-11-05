import { SignJWT } from 'jose'

/**
 * 给内嵌 AI 助手（EvoFlow 网关）签身份令牌。
 *
 * 这不是梵禾自己的访问令牌，两者的信任方向不同：
 *
 * - 梵禾访问令牌回答「谁能进梵禾」，由 `tokens.ts` 用 `JWT_SECRET` 签；
 * - 这一份回答「进了梵禾的人在助手那边是谁」，用 `ASSISTANT_JWT_SECRET` 签。
 *
 * **两者必须用不同密钥。** 共用一份会让梵禾的访问令牌同时能当助手令牌用，反过来
 * 助手那边的令牌也能冒充梵禾会话 —— 而助手那侧是可以被浏览器扩展、被页面里的任何
 * 脚本读到的（它要存进 localStorage 才能带上），把它和会话令牌绑在一起等于给会话
 * 令牌多开一个泄漏面。
 *
 * 载荷形状由 EvoFlow 的 `webui/middleware.py` 与 `authz/context.py` 决定，改之前
 * 先读那两个文件。要点：
 *
 * - 有 `username` + `webui_user_id` 时，它会在 `evoflow_principals` 里**自动建主体**
 *   并落一条 `provider='webui'` 的身份映射，因此不需要预先在它库里建账号；
 * - `principal_id` 它取的是 `sanitize_user_asset_id(username)`，也就是小写化后的
 *   用户名。这里显式带上同一个值，是为了让首个请求就能命中已建好的主体，而不是
 *   每次先查不到再走一遍「查不到→建」的分支。
 */

/**
 * 令牌寿命。
 *
 * 给到 30 天，是因为**过期不会报错，只会静默降级**：网关验签失败时不会拒绝请求，
 * 而是把这次调用当成「本机管理员」，于是所有人都看到同一份对话历史，界面上没有任何
 * 异常。所以这个值宁长勿短，前端每次进页面都会重新取一个，正常使用下永远碰不到过期。
 */
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60

export type AssistantTokenInput = {
  /** 梵禾账号 id（uuid）。作为 `sub`，同时充当 EvoFlow 侧的身份主键。 */
  userId: string
  /** 登录名。EvoFlow 用它派生主体 id，必须是 ASCII，否则会退化成哈希。 */
  username: string
  /**
   * 梵禾角色 code。**只作携带，不作判据** —— EvoFlow 的授权不看这个字段，
   * 它的组织管理员由 `evoflow_admin_grants` 表决定，由 `sync-admins.mjs` 同步。
   *
   * 带上的理由有两个：一是网关日志里能直接看出「这条身份在梵禾是什么角色」，
   * 排查「为什么他能进设置页」时不用回梵禾再查一次；二是将来若要按角色在助手内部
   * 做差异化，这个字段已经在令牌里了。
   */
  roleCode: string
  /** 与 EvoFlow 网关 `EVOFLOW_WEBUI_SECRET` 逐字一致的共享密钥。 */
  secret: string
}

export type AssistantToken = {
  token: string
  /** 到期时刻（epoch 毫秒）。 */
  expiresAt: number
}

export async function signAssistantToken(input: AssistantTokenInput): Promise<AssistantToken> {
  // 小写化不是为了「好看」：EvoFlow 侧的 `sanitize_user_asset_id` 会把主体 id 转成
  // 小写，若这里保留原始大小写，`Yang` 与 `yang` 会各自算出同一个主体 id 却又在
  // 首次请求时各建一条身份映射，最终两个账号指向同一份历史。梵禾的 username 只在
  // 库层面唯一（区分大小写），所以这一层归一必须在这里做。
  const username = input.username.trim().toLowerCase()

  const issuedAt = Math.floor(Date.now() / 1000)
  const expiresAtSeconds = issuedAt + TOKEN_TTL_SECONDS

  const token = await new SignJWT({
    username,
    // EvoFlow 用它区分令牌来源。它只在 `auth_method === 'oidc'` 时有分支，
    // 这里给一个自己的值，方便在它的日志里认出「这条身份是梵禾给的」。
    auth_method: 'fanhe',
    // 字符串而不是整数：EvoFlow 的读取路径只做 str() 与落库，没有 int() 强转
    // （已逐处核对），所以直接用 uuid 比造一个可能撞号的整数更安全。
    webui_user_id: input.userId,
    // 见文件头：与 sanitize_user_asset_id 的结果保持一致。
    principal_id: username,
    // 只作携带、不作判据（见 `AssistantTokenInput.roleCode`）。
    fanhe_role: input.roleCode,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(input.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAtSeconds)
    // 不设 aud / iss：EvoFlow 的 `verify_jwt` 只校验签名与 exp，带上这两个声明
    // 不会更安全，却会在将来它加上 audience 校验时变成一个「昨天还好用」的故障。
    .sign(new TextEncoder().encode(input.secret))

  return { token, expiresAt: expiresAtSeconds * 1000 }
}
