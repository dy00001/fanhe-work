/**
 * 折线图的悬停读数。
 *
 * 曲线是一条覆盖整段 X 轴的 `<path>`，浏览器原生 `<title>` 在这里给不出「这一天」
 * 的读数 —— 所以下标换算必须自己做。这几个边界（只有一个点、鼠标移出、越界、
 * 数据为空）都不是「看一眼就知道对不对」的，钉在这里比开浏览器试快得多：
 *
 *   - 用 floor 而不是 round 会让右半边整体错一格，读到的是隔壁那天的数，不报错；
 *   - 不钳制 ratio 时，鼠标移出绘图区（-0.02 或 1.03）会得到 -1 或 count，取到 undefined；
 *   - count === 1 时除以 (count - 1) 会得到 NaN。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hoverIndexAt, hoverRatioAt, hoverRows } from '../src/lib/ops-hover.ts'

function point(overrides = {}) {
  return {
    date: '2026-10-28',
    payAmountFen: 1234500,
    visitors: 26,
    payBuyers: 3,
    itemVisitors: 40,
    ...overrides,
  }
}

test('没有数据点时不返回下标', () => {
  assert.equal(hoverIndexAt(0.5, 0), null)
})

test('只有一个点时恒为 0（不能除零）', () => {
  assert.equal(hoverIndexAt(0, 1), 0)
  assert.equal(hoverIndexAt(0.5, 1), 0)
  assert.equal(hoverIndexAt(1, 1), 0)
})

test('两端对齐到首末两点', () => {
  assert.equal(hoverIndexAt(0, 7), 0)
  assert.equal(hoverIndexAt(1, 7), 6)
})

test('取最近的点而不是向下取整', () => {
  // 7 个点，间距 1/6 ≈ 0.1667。0.20 更靠近下标 1（0.1667）而不是下标 0。
  assert.equal(hoverIndexAt(0.2, 7), 1)
  // 0.083 正落在 0 与 1 中间偏左，取 0
  assert.equal(hoverIndexAt(0.083, 7), 0)
  // 0.084 已过半，取 1
  assert.equal(hoverIndexAt(0.084, 7), 1)
})

test('鼠标移出绘图区时钳到两端，不给越界下标', () => {
  assert.equal(hoverIndexAt(-0.5, 7), 0)
  assert.equal(hoverIndexAt(1.5, 7), 6)
})

test('ratio 非有限值时不给下标（NaN 会让 round 返回 NaN）', () => {
  assert.equal(hoverIndexAt(Number.NaN, 7), null)
  assert.equal(hoverIndexAt(Number.POSITIVE_INFINITY, 7), null)
})

test('下标换算回位置：单点时居中', () => {
  assert.equal(hoverRatioAt(0, 1), 0.5)
})

test('下标换算回位置：两端与中间', () => {
  assert.equal(hoverRatioAt(0, 7), 0)
  assert.equal(hoverRatioAt(6, 7), 1)
  assert.equal(hoverRatioAt(3, 7), 0.5)
})

test('下标越界时钳制，不产生负数位置', () => {
  assert.equal(hoverRatioAt(-3, 7), 0)
  assert.equal(hoverRatioAt(99, 7), 1)
})

test('提示框只列启用的曲线，顺序与图例一致', () => {
  const rows = hoverRows(point(), ['payRate', 'payAmountFen'])
  assert.deepEqual(
    rows.map((row) => row.key),
    ['payAmountFen', 'payRate'],
  )
})

test('提示框给出真实数值而不是归一后的高度', () => {
  const rows = hoverRows(point(), ['payAmountFen', 'visitors', 'payBuyers'])
  assert.deepEqual(
    rows.map((row) => row.text),
    ['¥1.2万', '26', '3'],
  )
})

test('转化率由买家数除访客数现算', () => {
  const rows = hoverRows(point({ payBuyers: 3, visitors: 26 }), ['payRate'])
  assert.equal(rows[0].text, '11.54%')
})

test('访客为 0 时转化率显示「—」而不是 0%', () => {
  const rows = hoverRows(point({ visitors: 0, payBuyers: 0 }), ['payRate'])
  assert.equal(rows[0].text, '—')
})

test('缺失的指标显示「—」，不猜 0', () => {
  const rows = hoverRows(point({ payAmountFen: null, visitors: null, payBuyers: null }), [
    'payAmountFen',
    'visitors',
    'payBuyers',
  ])
  assert.deepEqual(
    rows.map((row) => row.text),
    ['—', '—', '—'],
  )
})

test('一条曲线都没启用时提示框为空', () => {
  assert.deepEqual(hoverRows(point(), []), [])
})
