/**
 * 会话令牌的测试。
 *
 * 覆盖签发与校验的往返、以及各类伪造与失效场景。访问令牌是 JWT，安全边界完全
 * 落在「校验」这一步上 —— 签发永远成功，只有校验能挡住伪造，所以负向用例比
 * 正向用例更值得写全。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SignJWT } from 'jose'

import { env } from '../src/config/env.js'
import {
  generateRefreshToken,
  hashRefreshToken,
  refreshTokenExpiry,
  signAccessToken,
  verifyAccessToken,
} from '../src/auth/tokens.js'

const secretKey = new TextEncoder().encode(env.jwt.secret)

/** 用当前密钥手工签一个令牌，用于构造签名正确但其它条件不合规的样本。 */
async function signWith(overrides: {
  issuer?: string
  audience?: string
  key?: Uint8Array
  issuedAt?: number
  expiresAt?: number
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ role: 'member' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(overrides.issuer ?? 'fanhe-work')
    .setAudience(overrides.audience ?? 'fanhe-work-web')
    .setIssuedAt(overrides.issuedAt ?? now)
    .setExpirationTime(overrides.expiresAt ?? now + 900)
    .sign(overrides.key ?? secretKey)
}

test('签发的访问令牌可被校验，载荷与签发时一致', async () => {
  const token = await signAccessToken({ sub: 'user-1', role: 'member' })
  assert.deepEqual(await verifyAccessToken(token), { sub: 'user-1', role: 'member' })
})

test('访问令牌是三段式，头部算法为 HS256', async () => {
  const token = await signAccessToken({ sub: 'user-1', role: 'member' })
  const segments = token.split('.')
  assert.equal(segments.length, 3)

  const headerSegment = segments[0]
  assert.ok(headerSegment !== undefined)
  const header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8'))
  assert.equal(header.alg, 'HS256')
})

test('载荷被篡改后校验失败', async () => {
  const token = await signAccessToken({ sub: 'user-1', role: 'member' })
  const [headerSegment, , signatureSegment] = token.split('.')
  assert.ok(headerSegment !== undefined && signatureSegment !== undefined)

  // 把角色改成 owner，签名保持原样。这正是提权最直接的一种尝试。
  const forgedPayload = Buffer.from(JSON.stringify({ sub: 'user-1', role: 'owner' })).toString(
    'base64url',
  )
  assert.equal(
    await verifyAccessToken(`${headerSegment}.${forgedPayload}.${signatureSegment}`),
    null,
  )
})

test('签名被篡改后校验失败', async () => {
  const token = await signAccessToken({ sub: 'user-1', role: 'member' })
  const [headerSegment, payloadSegment] = token.split('.')
  assert.ok(headerSegment !== undefined && payloadSegment !== undefined)

  assert.equal(await verifyAccessToken(`${headerSegment}.${payloadSegment}.AAAA`), null)
})

test('用其它密钥签发的令牌校验失败', async () => {
  const otherKey = new TextEncoder().encode('a-different-key-that-is-long-enough-32')
  assert.equal(await verifyAccessToken(await signWith({ key: otherKey })), null)
})

test('过期令牌校验失败', async () => {
  const now = Math.floor(Date.now() / 1000)
  assert.equal(
    await verifyAccessToken(await signWith({ issuedAt: now - 3600, expiresAt: now - 60 })),
    null,
  )
})

test('签发者或受众不匹配时校验失败', async () => {
  assert.equal(await verifyAccessToken(await signWith({ issuer: 'someone-else' })), null)
  assert.equal(await verifyAccessToken(await signWith({ audience: 'another-app' })), null)
})

test('格式非法的令牌返回 null 而不抛异常', async () => {
  for (const bad of ['', 'not-a-token', 'a.b', 'a.b.c.d', '....']) {
    assert.equal(await verifyAccessToken(bad), null, `输入：${JSON.stringify(bad)}`)
  }
})

test('刷新令牌是 32 字节的 base64url 串，两次生成不相同', () => {
  const first = generateRefreshToken()
  const second = generateRefreshToken()

  assert.notEqual(first, second)
  assert.match(first, /^[A-Za-z0-9_-]+$/)
  // 32 字节 base64url 编码后为 43 个字符，无填充。
  assert.equal(first.length, 43)
})

test('刷新令牌的哈希稳定、为 64 位十六进制，且不等于明文', () => {
  const token = generateRefreshToken()
  const hash = hashRefreshToken(token)

  assert.equal(hash, hashRefreshToken(token))
  assert.notEqual(hash, token)
  assert.match(hash, /^[0-9a-f]{64}$/)
})

test('刷新令牌的过期时刻按配置的天数计算', () => {
  const from = new Date('2026-10-10T00:00:00Z')
  const expected = new Date(from)
  expected.setDate(expected.getDate() + env.jwt.refreshTtlDays)

  assert.equal(refreshTokenExpiry(from).getTime(), expected.getTime())
})
