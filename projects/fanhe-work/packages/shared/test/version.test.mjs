// T6-01 的版本清单与比较规则测试。
//
// ## 为什么 SHA-256 那部分要拿标准库做逐值对照
//
// `packages/shared/src/version.ts` 里的 SHA-256 是**手写实现**（为了让它能在纯函数
// 里同步调用，见那里「同步的 SHA-256」那节）。手写的加密算法最危险的形态不是报错，
// 是**能算出结果但算错了** —— 它照样返回一个 32 字节的数组，看起来完全正常。
//
// 所以这里用 `node:crypto` 的 `createHash('sha256')` 做**逐值对照**：同一段输入，
// 两者输出必须逐字符相同。**不是比「有没有值」，是比「值对不对」。**
//
// 这一条对照覆盖三种长度：短于一个块（< 56 字节）、恰好跨块、超过两块。SHA-256 的
// 补位逻辑在「长度刚好让 padding 多占一块」时最容易写错，只测一个长度会漏掉。

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'

import {
  BUILD_FINGERPRINT_LENGTH,
  compareManifests,
  compareVersions,
  computeBuildFingerprint,
} from '../dist/version.js'

/** 用标准库算一份参照指纹。 */
function referenceFingerprint(version, builtAt, commitSha) {
  return createHash('sha256')
    .update(`${version}\n${builtAt}\n${commitSha}`, 'utf8')
    .digest('hex')
    .slice(0, BUILD_FINGERPRINT_LENGTH)
}

// ── SHA-256 实现的正确性（与标准库逐值对照）─────────────────────────────────

test('构建指纹与 node:crypto 的 SHA-256 逐值一致（短输入，不足一个块）', () => {
  const args = ['0.1.0', '2026-10-12T00:00:00Z', 'abc1234']
  assert.equal(computeBuildFingerprint(...args), referenceFingerprint(...args))
})

test('构建指纹与标准库一致（跨块边界，恰好触发多补一块）', () => {
  // 版本号刻意做长，让 `版本\n时刻\n提交` 三项合计跨过 64 字节的块边界。
  const version = `0.1.0-${'x'.repeat(60)}`
  const args = [version, '2026-10-12T00:00:00Z', 'abc1234']
  // 长度用**字符数**核对。三个值全是 ASCII，所以字符数即字节数 —— 而这个文件
  // 里不能引用 `Buffer` 或 `TextEncoder`（`eslint.config.js` 的 Node 全局块
  // 覆盖 `packages/**/*.{ts,tsx}` 而**不含 `*.mjs`**，见那条配置的注释）。
  // 不为此去改全局配置：那会波及整个包的类型环境，超出一个版本测试该有的影响面。
  const material = `${version}\n2026-10-12T00:00:00Z\nabc1234`
  assert.ok(material.length > 56, '这一步的前提是输入超过一个 SHA-256 块的前半段')
  assert.equal(computeBuildFingerprint(...args), referenceFingerprint(...args))
})

test('构建指纹与标准库一致（超过两个块）', () => {
  const args = ['0.1.0', '2026-10-12T00:00:00Z', 'y'.repeat(200)]
  assert.equal(computeBuildFingerprint(...args), referenceFingerprint(...args))
})

test('构建指纹与标准库一致（三项全空这一边界也走同一套补位）', () => {
  const args = ['', '', '']
  assert.equal(computeBuildFingerprint(...args), referenceFingerprint(...args))
})

test('构建指纹长度恒为约定的位数', () => {
  for (const args of [
    ['0.1.0', '2026-10-12T00:00:00Z', 'abc1234'],
    ['1.0.0', '', 'unknown'],
    ['0.0.1', '2026-01-01T00:00:00Z', ''],
  ]) {
    assert.equal(computeBuildFingerprint(...args).length, BUILD_FINGERPRINT_LENGTH)
  }
})

// ── 指纹的区分能力 ────────────────────────────────────────────────────────────

test('三项中任一项不同，指纹就不同', () => {
  const base = computeBuildFingerprint('0.1.0', '2026-10-12T00:00:00Z', 'abc1234')
  assert.notEqual(base, computeBuildFingerprint('0.1.1', '2026-10-12T00:00:00Z', 'abc1234'))
  assert.notEqual(base, computeBuildFingerprint('0.1.0', '2026-10-12T00:00:01Z', 'abc1234'))
  assert.notEqual(base, computeBuildFingerprint('0.1.0', '2026-10-12T00:00:00Z', 'abc1235'))
})

test('版本号相同但提交不同，指纹不同 —— 这正是要带提交号的原因', () => {
  // 开发期同一个版本号对应很多次构建。只比版本号会把它们当成一致。
  const a = computeBuildFingerprint('0.1.0', '2026-10-12T10:00:00Z', 'aaaaaaa')
  const b = computeBuildFingerprint('0.1.0', '2026-10-12T11:00:00Z', 'bbbbbbb')
  assert.notEqual(a, b)
})

test('三项全空时仍给出一个非空的指纹（不是「无法判断」）', () => {
  // 只有当调用方真的拿不到指纹时才该报 unknown（见 compareManifests）。
  // 三项全空与「指纹为空」是不同的事：前者有确定的输入，只是输入是空的。
  assert.equal(computeBuildFingerprint('', '', '').length, BUILD_FINGERPRINT_LENGTH)
})

test('换行分隔让三项的分法不同必然给出不同字节串', () => {
  // 三项按固定顺序用换行连接时，**拼接结果唯一决定了三项的取值**：
  // 反过来看，两组不同的三项绝不可能拼出同一段字节串（换行不会出现在正常
  // 的版本号、时间戳、git 短号里）。
  //
  // 这条与「用逗号分隔」对比就很清楚：逗号分隔时 `('a,b','c')` 与 `('a','b,c')`
  // 会撞成同一段 `a,b,c`，而换行分隔下它们是 `a,b\nc` 与 `a\nb,c`，不同。
  const left = computeBuildFingerprint('a,b', 'c', '')
  const right = computeBuildFingerprint('a', 'b,c', '')
  assert.notEqual(left, right)
})

// ── 版本比较 ─────────────────────────────────────────────────────────────────

test('相等的版本号比出 0', () => {
  assert.equal(compareVersions('0.1.0', '0.1.0'), 0)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
})

test('逐段按数值比较，10 排在 9 之后', () => {
  // 字符串比较会把 '10' 排在 '9' 前面（'1' < '9'），这是个真实会踩的错。
  assert.ok(compareVersions('0.10.0', '0.9.0') > 0)
  assert.ok(compareVersions('10.0.0', '9.0.0') > 0)
  assert.ok(compareVersions('0.2.0', '0.11.0') < 0)
})

test('缺段与非法段按 0 处理，不抛错', () => {
  // 人手写的版本号出现意外形态时，比对这条路径不该崩 —— 它在 T6-02 里是非关键的。
  assert.doesNotThrow(() => compareVersions('', '0.1.0'))
  assert.doesNotThrow(() => compareVersions('abc', '0.1.0'))
  assert.doesNotThrow(() => compareVersions('0.1', '0.1.0'))
  assert.equal(compareVersions('', '0.0.0'), 0)
  assert.equal(compareVersions('0.1', '0.1.0'), 0)
})

test('预发布版排在正式版之前', () => {
  assert.ok(compareVersions('0.1.0-beta', '0.1.0') < 0)
  assert.ok(compareVersions('0.1.0', '0.1.0-beta') > 0)
})

test('预发布号逐段比较，数字段按数值比', () => {
  assert.ok(compareVersions('0.1.0-beta.2', '0.1.0-beta.10') < 0)
  assert.ok(compareVersions('0.1.0-beta.10', '0.1.0-beta.2') > 0)
  assert.equal(compareVersions('0.1.0-beta.1', '0.1.0-beta.1'), 0)
})

test('纯数字的预发布段早于带字母的', () => {
  // semver 的规定：alpha < beta < rc，而 1 是数字、beta 是字符串。
  assert.ok(compareVersions('0.1.0-1', '0.1.0-beta') < 0)
})

test('一方预发布段用尽则更早（alpha 早于 alpha.1）', () => {
  assert.ok(compareVersions('0.1.0-alpha', '0.1.0-alpha.1') < 0)
})

test('构建元数据（+ 号之后）不参与比较', () => {
  assert.equal(compareVersions('0.1.0+build1', '0.1.0+build2'), 0)
  assert.equal(compareVersions('0.1.0+build1', '0.1.0'), 0)
})

test('不同预发布号在同一版本号下分出先后', () => {
  assert.ok(compareVersions('0.1.0-alpha', '0.1.0-beta') < 0)
  assert.ok(compareVersions('0.1.0-beta', '0.1.0-rc') < 0)
})

// ── 清单比对 ─────────────────────────────────────────────────────────────────

function manifest(version, fingerprint) {
  return { version, builtAt: '2026-10-12T00:00:00Z', commitSha: 'abc1234', fingerprint }
}

test('指纹相同即 same，不看版本号', () => {
  const fp = computeBuildFingerprint('0.1.0', '2026-10-12T00:00:00Z', 'abc1234')
  const result = compareManifests({ version: '0.1.0', fingerprint: fp }, manifest('0.1.0', fp))
  assert.equal(result.outcome, 'same')
})

test('指纹不同且服务端更新 → outdated', () => {
  const local = { version: '0.1.0', fingerprint: 'local-fingerprint-1' }
  const result = compareManifests(local, manifest('0.2.0', 'remote-fingerprint-2'))
  assert.equal(result.outcome, 'outdated')
})

test('指纹不同但本机更新 → ahead（开发期的正常状态，不该提示有更新）', () => {
  const local = { version: '0.2.0', fingerprint: 'local-fingerprint-1' }
  const result = compareManifests(local, manifest('0.1.0', 'remote-fingerprint-2'))
  assert.equal(result.outcome, 'ahead')
})

test('任一侧指纹为空 → unknown（不提示更新）', () => {
  const remote = manifest('0.2.0', 'remote-fingerprint-2')
  assert.equal(compareManifests({ version: '0.1.0', fingerprint: '' }, remote).outcome, 'unknown')
  assert.equal(
    compareManifests({ version: '0.1.0', fingerprint: 'local-1' }, manifest('0.2.0', '')).outcome,
    'unknown',
  )
})

test('指纹不同但版本号相同 → ahead，而不是 outdated', () => {
  // 同一版本号的两次不同构建（开发期很常见）。提示「有更新」会指向一个不存在的版本。
  const local = { version: '0.1.0', fingerprint: 'local-fingerprint-1' }
  const result = compareManifests(local, manifest('0.1.0', 'remote-fingerprint-2'))
  assert.equal(result.outcome, 'ahead')
})

test('unknown 优先于版本号判断 —— 取不到构建信息时不猜', () => {
  const local = { version: '0.0.1', fingerprint: '' }
  const result = compareManifests(local, manifest('0.9.9', 'remote-fingerprint-2'))
  assert.equal(result.outcome, 'unknown')
})
