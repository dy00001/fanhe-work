import { createHash, randomBytes } from 'node:crypto'

import { SignJWT, jwtVerify } from 'jose'

import { env } from '../config/env.js'

/**
 * 会话令牌。
 *
 * 两种令牌分工明确，不要混用：
 *
 * **访问令牌**是 JWT，短期（默认 15 分钟）、无状态。服务端不存它，每个请求
 * 只做一次签名校验，不需要查库。代价是无法单独撤销 —— 这正是它必须短命的原因。
 *
 * **刷新令牌**是不透明随机串，长期（默认 30 天）、有状态。库里只存它的哈希，
 * 换发新令牌时轮换。撤销只需在库里标记，不必等它过期。
 *
 * 把访问令牌也做成有状态的，等于每个请求查一次库；把刷新令牌也做成 JWT 的，
 * 等于放弃撤销能力。两种退化都会让设计里最有价值的那一半消失。
 */

const ISSUER = 'fanhe-work'
const AUDIENCE = 'fanhe-work-web'
const ALGORITHM = 'HS256'

/**
 * 签名密钥。
 *
 * 选 HS256 而不是 RS256，因为当前只有一个服务在签发和校验，不存在「校验方
 * 不该有签发权」的分离需求 —— 非对称算法解决的正是这个，在没有这个需求时
 * 只是多出一套密钥轮换的负担。将来若有独立服务需要校验令牌，再换成非对称，
 * 那时改的是这一处与配置项。
 */
/**
 * 取签名密钥。
 *
 * **惰性求值，刻意不在模块顶层冻结。** 顶层 `const secretKey = encode(env.jwt.secret)`
 * 在导入那一刻就把密钥读死了，而 `env.ts` 自己也是模块级求值 —— 谁先谁后取决于
 * 导入顺序，`test-env.js` 想用 `JWT_SECRET` 覆盖本机 `.env` 里的值就可能失效。
 *
 * 生产环境察觉不到这个差别（密钥在进程生命周期内不变），**测试里却会**：断言
 * 「签名正确的令牌应当放行」时，签发侧与校验侧拿到不同的密钥，症状是「明明签得
 * 出来却验不过」，而同样的症状在密钥真的不对时也一样 —— 排查方向会被带偏。
 *
 * 每调用一次只做一次 `TextEncoder().encode`，开销可以忽略。
 */
function secretKey(): Uint8Array {
  return new TextEncoder().encode(env.jwt.secret)
}

export type AccessTokenClaims = {
  /** 用户 id。 */
  sub: string
  /**
   * 角色 code。
   *
   * 权限点不放进令牌。展开后的权限有十几条，塞进 JWT 会让每个请求的头部膨胀，
   * 而且改了角色授权后旧令牌仍带着旧权限，直到过期才生效 —— 撤权必须立刻生效。
   */
  role: string
  /**
   * 签发那一刻该账号的 `passwordChangedAt`，毫秒时间戳。
   *
   * **为什么角色可以被撤而它不行：** 角色变更后旧令牌带着旧角色，权限判断会落到
   * 服务端每次都要查的库上（见 guard 的合并规则），所以撤权能立刻生效；而「改密
   * 之后旧令牌必须失效」这件事，若只靠服务端查库比对，等于给每个请求加一次查库，
   * 恰好抵消掉访问令牌「无状态、不查库」的全部好处。
   *
   * **放进载荷而不是每次查库**，代价是这条信息会过期：令牌签发后用户再改一次密，
   * 这个令牌携带的时间戳就成了旧的 —— 但那没关系，判据是「令牌里的时间戳早于库里
   * 当前值」，用户改密之后库里被更新了，比对自然失败。要失效的从来是**改密之前**
   * 签发的那一批令牌，把签发时刻的快照带进令牌就足以识别它们。
   *
   * `null` 表示签发时该账号从未改过密（新建账号的常态）。
   */
  pwd: number | null
}

/**
 * 签发访问令牌。
 *
 * 载荷只有 sub、role、pwd 与 iat、exp。注意 iat 与 exp 都是**秒级**精度，因此同一
 * 账号在同一秒内签发两次，得到的令牌逐字节相同。这是 JWT 的固有特性，不是
 * 缺陷：两份令牌的语义完全相同，都能用、也都在同一时刻失效。需要「每次签发
 * 都不同」时应加 jti，但当前没有任何场景需要区分它们。
 *
 * `pwd` 用毫秒而不是秒：它要与库里的 `timestamptz(3)` 直接比对，两者精度必须
 * 一致才能做相等判断。
 */
export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ role: claims.role, pwd: claims.pwd })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.jwt.accessTtlSeconds}s`)
    .sign(secretKey())
}

/**
 * 校验访问令牌，通过则返回载荷，否则返回 null。
 *
 * 不抛异常。校验失败的原因很多（过期、签名不对、格式错误），调用方对它们的
 * 处理完全相同 —— 都是「未认证」—— 区分开只会诱使调用方把细节漏进响应里。
 *
 * `pwd` 的存在性本身也是判据的一部分：**缺这个字段的令牌一律判为无效**，而不是
 * 当成「未改过密」放行。放行等于给伪造者一条绕过改密失效的路径 —— 只要把 `pwd`
 * 从载荷里删掉即可，那比改密码本身容易得多。同理，非有限数字（`NaN`、字符串被
 * 解析成 `null`）也不放行。
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      // 必须显式限定算法。不限定的话，攻击者可以把头部改成 alg: none，或从
      // HS256 换成某个非对称算法，诱导校验方用错误的密钥去验签 —— 这是 JWT
      // 最经典的一类漏洞，而库的默认行为未必拦得住。
      algorithms: [ALGORITHM],
    })

    const sub = payload.sub
    const role = payload.role
    if (typeof sub !== 'string' || sub === '' || typeof role !== 'string' || role === '') {
      return null
    }

    // `pwd` 必须显式出现过。`'pwd' in payload` 而非 `payload.pwd !== undefined`：
    // 后者会把「字段被显式写成 null」（正常载荷）与「字段根本不存在」（可疑）
    // 混成同一种情况，而这两者必须区别对待。
    if (!('pwd' in payload)) return null
    const pwd = payload.pwd
    if (pwd !== null && (typeof pwd !== 'number' || !Number.isFinite(pwd))) {
      return null
    }

    return { sub, role, pwd }
  } catch {
    return null
  }
}

/**
 * 这个令牌是否已被改密作废。
 *
 * **比较而不是相等**：`null`（从未改密）不能与任何值相等，而「库里现在有改密时间」
 * 说明用户确实改过 —— 此时一个 `null` 的令牌必然是改密之前签发的，作废。
 * 反过来两边都是同一毫秒则放行，那是同一时刻签发的同一个账号，正常。
 *
 * 调用方需要的是库里当前的 `passwordChangedAt`，因此这个函数不碰数据库 ——
 * 它只回答「这两个值是否矛盾」，取数是调用方的事。
 */
export function isStaleByPasswordChange(
  claims: AccessTokenClaims,
  currentPasswordChangedAt: Date | null,
): boolean {
  const current = currentPasswordChangedAt === null ? null : currentPasswordChangedAt.getTime()
  if (current === null) return false
  if (claims.pwd === null) return true
  return claims.pwd !== current
}

/** 刷新令牌的原始字节数。256 位熵，穷举不可行。 */
const REFRESH_TOKEN_BYTES = 32

/** 生成一个刷新令牌。只在签发的那一刻存在明文，之后库里只有它的哈希。 */
export function generateRefreshToken(): string {
  return randomBytes(REFRESH_TOKEN_BYTES).toString('base64url')
}

/**
 * 计算刷新令牌的存储哈希。
 *
 * 这里用 SHA-256 而不是 Argon2，和密码的处理必须分开看：密码是低熵的，必须用
 * 慢哈希抵抗离线爆破；刷新令牌是 256 位随机串，不存在「猜」的余地，慢哈希只会
 * 让每次刷新都白付几十毫秒。用哈希的目的只有一个 —— 拖库者拿到的是摘要，
 * 不能直接拿去用。
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 刷新令牌的过期时刻。 */
export function refreshTokenExpiry(from: Date = new Date()): Date {
  const expires = new Date(from)
  expires.setDate(expires.getDate() + env.jwt.refreshTtlDays)
  return expires
}
