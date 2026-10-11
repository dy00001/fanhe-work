/**
 * 版本号展示的回归测试。
 *
 * 用 Node 内置测试器直接测源码（与 `relative-time.test.mjs` 同款：前端构建会把它打进
 * 浏览器 bundle，不能像共享包那样导入独立的 dist 模块）。
 *
 * **测的是纯函数，不是注入值。** `lib/version.ts` 里三个构建期常量在 Node 下会退化成
 * 占位值（`typeof` 守卫），断言它们等于多少毫无意义 —— 真正会出错的是**格式化规则**：
 * 构建时间取不到时是否留了一个空档、40 位完整哈希是否被截断、跨时区的日期会不会串天。
 *
 * **时区偏移一律显式传入。** 日期换算若依赖运行环境的时区，同一份代码在构建机上绿、
 * 换一台机器就红，而那种红看起来像业务逻辑坏了。把偏移做成参数之后，下面几个用例
 * 在任何机器上都得到同一个结果。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildVersionDetail,
  buildVersionLine,
  formatBuildDate,
  formatBuildStamp,
  formatVersionLabel,
  shortCommit,
} from '../src/lib/version.ts'

/** 东八区的 `getTimezoneOffset`：本地时间加 480 分钟得到 UTC。 */
const UTC_PLUS_8 = -480

test('版本标签带 v 前缀', () => {
  assert.equal(formatVersionLabel('0.1.0'), 'v0.1.0')
  assert.equal(formatVersionLabel('1.0.0-rc.1'), 'v1.0.0-rc.1')
})

test('构建日期按本地时区换算，不按 UTC 截断', () => {
  // 16:14 UTC 在东八区已是次日 00:14 —— 界面上必须显示次日，否则凌晨构建出来
  // 的版本会显示成一个读起来像过期的日期。
  assert.equal(formatBuildDate('2026-10-11T16:14:42.526Z', UTC_PLUS_8), '2026-10-12')
  // 同一个时刻在 UTC 下仍是当天。两个断言合起来才说明「换算真的发生了」。
  assert.equal(formatBuildDate('2026-10-11T16:14:42.526Z', 0), '2026-10-11')
})

test('构建时刻精确到分钟', () => {
  assert.equal(formatBuildStamp('2026-10-11T16:14:42.526Z', UTC_PLUS_8), '2026-10-12 00:14')
  assert.equal(formatBuildStamp('2026-10-11T16:14:42.526Z', 0), '2026-10-11 16:14')
})

test('构建时间缺失或格式不对时返回 null，不返回空串', () => {
  // 空串与 null 的区别在这里是承重的：调用方靠 null 决定「这一段不渲染」，
  // 返回空串会让界面上多出一个空档。
  assert.equal(formatBuildDate('', UTC_PLUS_8), null)
  assert.equal(formatBuildDate('unknown', UTC_PLUS_8), null)
  assert.equal(formatBuildDate('2026-10-12', UTC_PLUS_8), null)
  assert.equal(formatBuildStamp('', UTC_PLUS_8), null)
})

test('提交号截到 7 位，完整哈希与短哈希得到同一个结果', () => {
  assert.equal(shortCommit('a1b2c3d'), 'a1b2c3d')
  assert.equal(shortCommit('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'), 'a1b2c3d')
})

test('拿不到提交号时显示 unknown，不显示成空', () => {
  assert.equal(shortCommit(''), 'unknown')
  assert.equal(shortCommit('unknown'), 'unknown')
})

test('菜单那一行按「版本 · 日期 · 提交」拼，缺哪段就省哪段', () => {
  assert.equal(
    buildVersionLine('0.1.0', '2026-10-12T07:04:00.000Z', 'a1b2c3d4e5f6', UTC_PLUS_8),
    'v0.1.0 · 2026-10-12 · a1b2c3d',
  )
  // 构建时间取不到时不留下一个连续的分隔符。
  assert.equal(buildVersionLine('0.1.0', '', 'a1b2c3d'), 'v0.1.0 · a1b2c3d')
  assert.equal(buildVersionLine('0.1.0', '', ''), 'v0.1.0 · unknown')
})

test('悬停说明比那一行多出「提交」这个词与 UTC 原值', () => {
  assert.equal(
    buildVersionDetail('0.1.0', '2026-10-12T07:04:00.000Z', 'a1b2c3d', UTC_PLUS_8),
    '版本 0.1.0 · 构建于 2026-10-12 15:04 · UTC 2026-10-12T07:04:00.000Z · 提交 a1b2c3d',
  )
  // 没有构建时间时不留空段。
  assert.equal(buildVersionDetail('0.1.0', '', 'unknown'), '版本 0.1.0 · 提交 unknown')
})
