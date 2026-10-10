/**
 * 密码哈希的测试。
 *
 * 先固定环境变量再动态 import 被测模块。env.ts 在模块加载期就求值，静态 import
 * 会被提升到赋值之前；dotenv 又不覆盖已存在的变量，所以这里设的值不会被本机
 * .env 改写，测试结果与开发者的本地配置无关。
 *
 * 用 tsx 跑源码而不是像 shared 那样跑 dist：api 的构建要先过 prisma generate，
 * 为一个测试付十几秒不划算，而 tsx 本来就是这个包的开发期运行方式。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hash as argon2Hash } from '@node-rs/argon2'

process.env.DATABASE_URL ??= 'postgresql://unused/unused'
process.env.ARGON2_MEMORY_KIB = '19456'
process.env.ARGON2_TIME_COST = '2'
process.env.ARGON2_PARALLELISM = '1'

const { hashPassword, verifyPassword, needsRehash } = await import('../src/auth/password.js')

/** 低于当前配置的参数，用来构造「该重算」的样本。 */
const WEAK_OPTIONS = { memoryCost: 8192, timeCost: 1, parallelism: 1 }

test('哈希串是 Argon2id 的 PHC 格式，参数与配置一致', async () => {
  const hash = await hashPassword('correct horse battery staple')
  assert.match(hash, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
})

test('同一密码两次哈希结果不同，说明盐是随机的', async () => {
  const first = await hashPassword('same-password')
  const second = await hashPassword('same-password')
  assert.notEqual(first, second)
})

test('哈希串里不含明文密码', async () => {
  const plain = 'plaintext-marker-9f3a'
  const hash = await hashPassword(plain)
  assert.ok(!hash.includes(plain))
})

test('正确密码校验通过', async () => {
  const hash = await hashPassword('梵禾-work-密码')
  assert.equal(await verifyPassword(hash, '梵禾-work-密码'), true)
})

test('错误密码校验失败', async () => {
  const hash = await hashPassword('梵禾-work-密码')
  assert.equal(await verifyPassword(hash, '梵禾-work-密码x'), false)
})

test('多字节密码与 emoji 能正确往返', async () => {
  const plain = '密码🔐with-emoji-中文'
  const hash = await hashPassword(plain)
  assert.equal(await verifyPassword(hash, plain), true)
  assert.equal(await verifyPassword(hash, '密码🔐with-emoji-中'), false)
})

test('哈希串格式非法时返回 false 而不抛异常', async () => {
  for (const bad of ['', 'not-a-hash', '$argon2id$v=19$m=19456,t=2,p=1$onlyfivefields', '$$$$$']) {
    assert.equal(await verifyPassword(bad, 'anything'), false, `输入：${JSON.stringify(bad)}`)
  }
})

test('按当前配置生成的哈希不需要重算', async () => {
  const hash = await hashPassword('current-policy')
  assert.equal(needsRehash(hash), false)
})

test('参数低于当前配置的哈希需要重算', async () => {
  const weak = await argon2Hash('legacy-password', WEAK_OPTIONS)
  assert.equal(needsRehash(weak), true)
})

test('旧参数的哈希仍能校验通过，改配置不会让已有密码失效', async () => {
  const weak = await argon2Hash('legacy-password', WEAK_OPTIONS)
  assert.equal(await verifyPassword(weak, 'legacy-password'), true)
  assert.equal(await verifyPassword(weak, 'wrong-password'), false)
})

test('格式非法的串不触发重算', async () => {
  assert.equal(needsRehash(''), false)
  assert.equal(needsRehash('garbage'), false)
})

test('参数调低不会反过来要求重算', async () => {
  // 比当前配置更强的参数，不应被判为需要重算。
  const stronger = await argon2Hash('stronger', {
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
  })
  assert.equal(needsRehash(stronger), false)
})
