/**
 * 看板加载态的推导规则。
 *
 * 这里钉住的是一条容易写反、且写反后只在界面上表现为「点一下店铺，页面跳到最顶端」
 * 的规则 —— 它不报错、不抛异常，单测之外没有更早的发现手段：
 *
 *   只有店铺变了 → **不能**回到加载态（否则内容区整块卸载、高度塌陷、滚动位置被钳到 0）
 *   区间变了     → 必须回到加载态（整页语义已变，留着旧区间的数字更容易误读）
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  dashboardKey,
  dashboardRangeKey,
  resolveDashboardState,
} from '../src/lib/ops-load-state.ts'

const DATA_A = { range: { from: '2026-10-22', to: '2026-10-28' }, shop: { code: 's2' } }

function readyEntry(overrides = {}) {
  const input = { days: 7, from: undefined, to: undefined, shop: 's2' }
  return {
    key: dashboardKey(input, 0),
    rangeKey: dashboardRangeKey(input, 0),
    state: { status: 'ready', data: DATA_A },
    ...overrides,
  }
}

test('没有结果时是加载中', () => {
  assert.deepEqual(resolveDashboardState(null, 'k', 'r'), { status: 'loading' })
})

test('指纹完全一致时直接用那份结果', () => {
  const entry = readyEntry()
  const state = resolveDashboardState(entry, entry.key, entry.rangeKey)
  assert.equal(state.status, 'ready')
  assert.equal(state.data, DATA_A)
  // 不是换店，不该带 switching 标记
  assert.equal(state.switching, undefined)
})

test('只有店铺变了：沿用上一份数据并标记 switching', () => {
  const entry = readyEntry()
  const otherShop = { days: 7, from: undefined, to: undefined, shop: 's4' }
  const state = resolveDashboardState(
    entry,
    dashboardKey(otherShop, 0),
    dashboardRangeKey(otherShop, 0),
  )
  assert.equal(state.status, 'ready')
  // 关键断言：仍然是旧数据，而不是 loading —— 这是「不跳顶」的全部实现
  assert.equal(state.data, DATA_A)
  assert.equal(state.switching, true)
})

test('区间变了必须回到加载中', () => {
  const entry = readyEntry()
  const otherRange = { days: 30, from: undefined, to: undefined, shop: 's2' }
  const state = resolveDashboardState(
    entry,
    dashboardKey(otherRange, 0),
    dashboardRangeKey(otherRange, 0),
  )
  assert.deepEqual(state, { status: 'loading' })
})

test('换店同时换区间也回到加载中（区间优先）', () => {
  const entry = readyEntry()
  const both = { days: 30, from: undefined, to: undefined, shop: 's4' }
  const state = resolveDashboardState(entry, dashboardKey(both, 0), dashboardRangeKey(both, 0))
  assert.deepEqual(state, { status: 'loading' })
})

test('重试（ticket 变化）回到加载中', () => {
  const entry = readyEntry()
  const input = { days: 7, from: undefined, to: undefined, shop: 's2' }
  const state = resolveDashboardState(entry, dashboardKey(input, 1), dashboardRangeKey(input, 1))
  assert.deepEqual(state, { status: 'loading' })
})

test('上一份是错误态时，换店应当重新请求而不是沿用错误', () => {
  const input = { days: 7, from: undefined, to: undefined, shop: 's2' }
  const entry = {
    key: dashboardKey(input, 0),
    rangeKey: dashboardRangeKey(input, 0),
    state: { status: 'error', error: { code: 'x' } },
  }
  const other = { days: 7, from: undefined, to: undefined, shop: 's4' }
  const state = resolveDashboardState(entry, dashboardKey(other, 0), dashboardRangeKey(other, 0))
  assert.deepEqual(state, { status: 'loading' })
})

test('店铺指纹与区间指纹只差店铺这一项', () => {
  const a = { days: 7, from: undefined, to: undefined, shop: 's2' }
  const b = { days: 7, from: undefined, to: undefined, shop: 's4' }
  assert.notEqual(dashboardKey(a, 0), dashboardKey(b, 0))
  assert.equal(dashboardRangeKey(a, 0), dashboardRangeKey(b, 0))
})

test('自定义区间参与两种指纹', () => {
  const a = { days: undefined, from: '2026-10-01', to: '2026-10-10', shop: 's2' }
  const b = { days: undefined, from: '2026-10-02', to: '2026-10-10', shop: 's2' }
  assert.notEqual(dashboardKey(a, 0), dashboardKey(b, 0))
  assert.notEqual(dashboardRangeKey(a, 0), dashboardRangeKey(b, 0))
})
