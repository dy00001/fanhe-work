/**
 * 运营数据契约里的日期运算回归。
 *
 * 这些函数看起来"只是加减天数"，但它们是区间统计的地基：日均、环比基线、数据
 * 覆盖天数全部由它们推出，错一天的表现是"每个数字都偏一点"，而不是报错。
 *
 * 三条最需要钉住的：
 *
 *   1. 闭区间的天数是 `差 + 1`。`10-01 ~ 10-01` 是 1 天。少这个加一，日均会
 *      被算成两倍。
 *   2. 上一个区间取"紧邻的等长区间"，不是本期内部的前半段。取错时环比永远接近
 *      100%，看起来"业务很平稳"。
 *   3. 跨月跨年与闰年不能靠本地时区。解析一律走 UTC 正午，测试里也用 UTC 读回，
 *      这样同一条断言在东八区与西半球都成立。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OPS_LIMITS,
  addOpsDays,
  clampOpsRange,
  formatOpsDate,
  isValidOpsRange,
  opsRangeDays,
  opsRangeEndingAt,
  parseOpsDate,
  previousOpsRange,
} from '../dist/index.js'

test('日期解析：合法值原样往返', () => {
  for (const value of ['2026-01-01', '2026-10-18', '2024-02-29']) {
    const parsed = parseOpsDate(value)
    assert.ok(parsed !== null, `${value} 应当能解析`)
    assert.equal(formatOpsDate(parsed), value)
  }
})

test('日期解析：格式合法但日子不存在的输入一律拒绝', () => {
  // Date.UTC 会把 02-31 滚到 3 月 3 日。若不校验回读结果，这类输入会静默变成
  // 另一天，而调用方以为自己写的是 2 月 31 日。
  for (const value of ['2026-02-31', '2025-02-29', '2026-13-01', '2026-04-31']) {
    assert.equal(parseOpsDate(value), null, `${value} 不应当被接受`)
  }
})

test('日期解析：非 YYYY-MM-DD 形式一律拒绝', () => {
  for (const value of ['2026-1-1', '2026/10/18', '20261018', '', '2026-10-18T00:00:00Z']) {
    assert.equal(parseOpsDate(value), null, `${value} 不应当被接受`)
  }
})

test('闭区间天数：首尾同一天算一天', () => {
  assert.equal(opsRangeDays({ from: '2026-10-01', to: '2026-10-01' }), 1)
  assert.equal(opsRangeDays({ from: '2026-09-19', to: '2026-10-18' }), 30)
  // 跨年：2026-12-30 ~ 2027-01-02 是 4 天。
  assert.equal(opsRangeDays({ from: '2026-12-30', to: '2027-01-02' }), 4)
})

test('闭区间天数：顺序颠倒或非法时返回 0，不返回负数', () => {
  assert.equal(opsRangeDays({ from: '2026-10-18', to: '2026-10-01' }), 0)
  assert.equal(opsRangeDays({ from: 'bad', to: '2026-10-01' }), 0)
})

test('日期加减：跨月、跨年、闰年均正确', () => {
  assert.equal(addOpsDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addOpsDays('2026-01-01', -1), '2025-12-31')
  assert.equal(addOpsDays('2024-02-28', 1), '2024-02-29')
  assert.equal(addOpsDays('2025-02-28', 1), '2025-03-01')
})

test('上一区间：等长、紧邻、不重叠', () => {
  const range = { from: '2026-09-19', to: '2026-10-18' }
  const previous = previousOpsRange(range)
  assert.ok(previous !== null)
  assert.equal(opsRangeDays(previous), 30)
  // 紧邻：上一区间的末日是本期首日的前一天。
  assert.equal(previous.to, '2026-09-18')
  assert.equal(previous.from, '2026-08-20')
  // 不重叠：本期首日不在上一区间里。
  assert.ok(previous.to < range.from)
})

test('上一区间：单日区间的基线也是单日', () => {
  const previous = previousOpsRange({ from: '2026-10-15', to: '2026-10-15' })
  assert.deepEqual(previous, { from: '2026-10-14', to: '2026-10-14' })
})

test('截止日推区间：近 30 天含截止日当天', () => {
  const range = opsRangeEndingAt('2026-10-18', 30)
  assert.deepEqual(range, { from: '2026-09-19', to: '2026-10-18' })
  assert.equal(opsRangeDays(range), 30)
})

test('区间合法性：上限为 366 天，超过则靠 clamp 收口', () => {
  const tooLong = { from: '2024-01-01', to: '2026-10-18' }
  assert.equal(isValidOpsRange(tooLong), false)
  const clamped = clampOpsRange(tooLong)
  assert.equal(opsRangeDays(clamped), OPS_LIMITS.RANGE_MAX_DAYS)
  // 收口保留末日、裁掉开头，不自作主张改 to —— 用户看的是"最近这段"。
  assert.equal(clamped.to, tooLong.to)
})
