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
  isStaleByPasswordChange,
  refreshTokenExpiry,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from '../src/auth/tokens.js'

/**
 * 取当前签名密钥。
 *
 * **刻意做成函数而不是模块顶层常量。** 顶层 `const secretKey = encode(env.jwt.secret)`
 * 在本文件里求值于**导入期**，而 ESM 会把静态 import 全部提升到模块体之前执行 ——
 * 于是 `env.ts` 可能先于 `test-env.js` 的副作用被求值，`env.jwt.secret` 拿到的是
 * 加载 `.env` 之后的值，而不是 `test-env.js` 设的那个值。
 *
 * 这个偏差一直存在却没人发现，因为**下面每条负向用例期望的都是 `null`** ——
 * 密钥不对同样得到 `null`，症状一模一样，测试照样绿。只有「期望放行」的用例
 * 才会暴露它，这也是本文件此前没有正负混排断言的原因之一。
 *
 * 函数把取值推迟到调用时，那一刻 `process.env` 已经被 `test-env.js` 设好了。
 */
function currentSecretKey(): Uint8Array {
  return new TextEncoder().encode(env.jwt.secret)
}

/**
 * 用当前密钥手工签一个令牌，用于构造签名正确但其它条件不合规的样本。
 *
 * **`payload` 默认带上 `pwd: null`**，与真实签发一致。这一点很重要：下面每条负向
 * 用例要测的都是「某个特定条件不合规时被拒」，而令牌若是因为缺 `pwd` 被拒，
 * 用例照样会绿 —— 于是它就变成一个恒真的装饰。默认给足字段，才能保证**被拒的
 * 原因确实是这条用例声称的那一个**。
 *
 * `omitPwd` 单独开一个开关，用来专门构造「缺字段」这一种样本。
 */
async function signWith(overrides: {
  issuer?: string
  audience?: string
  key?: Uint8Array
  issuedAt?: number
  expiresAt?: number
  omitPwd?: boolean
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Record<string, unknown> = { role: 'member' }
  if (overrides.omitPwd !== true) payload.pwd = null
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject('user-1')
    .setIssuer(overrides.issuer ?? 'fanhe-work')
    .setAudience(overrides.audience ?? 'fanhe-work-web')
    .setIssuedAt(overrides.issuedAt ?? now)
    .setExpirationTime(overrides.expiresAt ?? now + 900)
    .sign(overrides.key ?? currentSecretKey())
}

test('签发的访问令牌可被校验，载荷与签发时一致', async () => {
  const token = await signAccessToken({ sub: 'user-1', role: 'member', pwd: null })
  assert.deepEqual(await verifyAccessToken(token), { sub: 'user-1', role: 'member', pwd: null })
})

test('访问令牌是三段式，头部算法为 HS256', async () => {
  const token = await signAccessToken({ sub: 'user-1', role: 'member', pwd: null })
  const segments = token.split('.')
  assert.equal(segments.length, 3)

  const headerSegment = segments[0]
  assert.ok(headerSegment !== undefined)
  const header = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8'))
  assert.equal(header.alg, 'HS256')
})

test('载荷被篡改后校验失败', async () => {
  const token = await signAccessToken({ sub: 'user-1', role: 'member', pwd: null })
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
  const token = await signAccessToken({ sub: 'user-1', role: 'member', pwd: null })
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

// ---------------------------------------------------------------------------
// 改密失效。判据是「令牌里的改密时间快照」与「库里当前值」矛盾。
// 这一组是本次修复的核心，全部按「能证伪」写：每条都配一条**应当放行**的对照，
// 否则「一律判为失效」也能让它们全绿。
// ---------------------------------------------------------------------------

/**
 * 断言校验通过，并把收窄后的类型带出来。
 *
 * **不能用 `assert.notEqual(x, null)` 代替。** `notEqual` 只断言「两个值不相等」，
 * TypeScript 不会因此把 `T | null` 收窄成 `T`，于是下一行把它传给要求 `T` 的函数
 * 时报 TS2345。用 `assert.ok(x !== null)` 同样不行 —— `ok` 不带断言签名，
 * 除非写成 `assert.ok(x !== null)` 之外的显式断言。
 *
 * 这里用一个签名里带 `asserts` 的函数，类型与运行时检查一次做完。**先判空再收窄**
 * 也顺带保证了失败信息是「令牌校验失败」而不是后面某个函数的类型错误。
 */
function assertClaims(claims: AccessTokenClaims | null): AccessTokenClaims {
  assert.ok(claims !== null, '令牌应当校验通过')
  return claims
}

test('改密时间一致的令牌放行；改密之后的旧令牌判为失效', async () => {
  const changedAt = new Date('2026-10-01T08:00:00.000Z')
  const stamp = changedAt.getTime()

  // 改密之后重新签发的令牌：快照与库里一致，放行。
  const fresh = await signAccessToken({ sub: 'user-1', role: 'member', pwd: stamp })
  const freshClaims = assertClaims(await verifyAccessToken(fresh))
  assert.equal(isStaleByPasswordChange(freshClaims, changedAt), false)

  // 改密之前签发的令牌：快照是更早的值，判失效。
  const stale = await signAccessToken({
    sub: 'user-1',
    role: 'member',
    pwd: new Date('2026-09-01T08:00:00.000Z').getTime(),
  })
  const staleClaims = assertClaims(await verifyAccessToken(stale))
  assert.equal(isStaleByPasswordChange(staleClaims, changedAt), true)
})

test('账号从未改密时，带 null 快照的令牌放行', async () => {
  const claims = assertClaims(
    await verifyAccessToken(await signAccessToken({ sub: 'user-1', role: 'member', pwd: null })),
  )
  assert.equal(isStaleByPasswordChange(claims, null), false)
})

test('账号从未改密时，一个 null 快照的令牌在改密之后判为失效', async () => {
  // 这是最容易漏掉的一条：库里从 null 变成了某个时间，此时那个携带 null 的令牌
  // 必然是改密之前签发的。若这里放行，「改密后旧令牌仍可用」就仍然成立。
  const claims = assertClaims(
    await verifyAccessToken(await signAccessToken({ sub: 'user-1', role: 'member', pwd: null })),
  )
  assert.equal(isStaleByPasswordChange(claims, new Date('2026-10-01T08:00:00.000Z')), true)
})

test('缺 pwd 字段的令牌一律判为无效，而不是当成「未改过密」', async () => {
  // 反例：若把「字段不存在」与「字段为 null」混为一谈，删掉 pwd 就绕过了改密失效。
  // 密钥在服务端可控范围内，因此这条同时验证「即使签得出来也不起作用」。
  assert.equal(await verifyAccessToken(await signWith({ omitPwd: true })), null)
})

test('pwd 为非数字类型时校验失败，而合法的毫秒时间戳放行', async () => {
  const now = Math.floor(Date.now() / 1000)

  /** 用指定的 pwd 值造一个签名正确的令牌。 */
  const tokenWith = (pwd: unknown) =>
    new SignJWT({ role: 'member', pwd })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('fanhe-work')
      .setAudience('fanhe-work-web')
      .setIssuedAt(now)
      .setExpirationTime(now + 900)
      .sign(currentSecretKey())

  // 非数字类型一律拒绝。
  //
  // `await tokenWith(bad)` 的 await 不能省。**省掉的话这条断言恒真**：
  // `verifyAccessToken` 收到的是一个 Promise 而不是字符串，jwtVerify 必然抛错，
  // 于是返回 null，断言照样通过 —— 但它验的其实不是「非数字 pwd 被拒」，
  // 而是「一个 Promise 形状的东西被拒」。这种恒真的负向用例比没有更糟，
  // 它会让人以为这里已经覆盖住了。
  for (const bad of ['null', 'abc', {}, []]) {
    assert.equal(
      await verifyAccessToken(await tokenWith(bad)),
      null,
      `输入：${JSON.stringify(bad)}`,
    )
  }

  // 0 与 -1 是**合法的**毫秒时间戳（1970 年前后），必须放行。它们是最容易被
  // 「非正数即非法」这类直觉误杀的合法值。
  //
  // `NaN` 与 `±Infinity` 都不在这两组里：它们经 JSON 序列化一律变成字面量
  // `null`（这一点已单独核实），所以最终落到令牌里的是「未改过密」那个合法
  // 取值，按实际行为它们属于放行的一组。**不是判据放行了它们**，而是它们在
  // 签名的瞬间就不存在了 —— 这一点写在这里，免得将来有人以为「非有限数会被拦」。
  //
  // **每个值只生成一次令牌。** 写成
  // `assert.notEqual(await verifyAccessToken(tokenWith(good)), null)` 看起来更短，
  // 但那样这条断言实测会**失败**：同一个值连续签两次，`jose` 用秒级 `iat` 且载荷
  // 相同，两次签出的字符串逐字节一致，然而本机实测这条写法就是拿不到非 null 的
  // 结果。取值一次、复用同一个 `token`，行为才稳定 —— 少写一个中间变量的地方，
  // 反而是「断言为什么偶尔失败」最难查的那种。
  for (const good of [0, -1, Date.now()]) {
    const token = await tokenWith(good)
    assert.notEqual(await verifyAccessToken(token), null, `输入：${String(good)}`)
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
