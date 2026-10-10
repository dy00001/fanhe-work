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
const secretKey = new TextEncoder().encode(env.jwt.secret)

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
}

/** 签发访问令牌。 */
export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ role: claims.role })
    .setProtectedHeader({ alg: ALGORITHM })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${env.jwt.accessTtlSeconds}s`)
    .sign(secretKey)
}

/**
 * 校验访问令牌，通过则返回载荷，否则返回 null。
 *
 * 不抛异常。校验失败的原因很多（过期、签名不对、格式错误），调用方对它们的
 * 处理完全相同 —— 都是「未认证」—— 区分开只会诱使调用方把细节漏进响应里。
 */
export async function verifyAccessToken(token: string): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
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
    return { sub, role }
  } catch {
    return null
  }
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
