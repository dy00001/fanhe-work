/**
 * 维度快照的窗口选择。
 *
 * 这个函数替的是一个很容易写错的判断：**「最新的一份」不等于「最能回答这个问题
 * 的一份」**。日增采集上线后，同一个维度会同时有 30 天快照与逐日快照，取最新会让
 * 「近 30 天」的商品榜变成「最新一天的 Top 5」。
 *
 * 因此下面的用例里，第 1 条本身就是反例：候选取最新的那份会得到 10-19 的单日
 * 快照，正确答案是 09-19~10-18 的 30 天快照。它必须能失败 —— 把 `pickSnapshotIndex`
 * 改成 `return 0` 会立刻红。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { test } from 'node:test'

const { pickSnapshotIndex, rangeOverlapDays } = await import('../src/ops/date.js')

/** 调用方按 `statTo` 降序传入，与 `loadDimensionGroup` 的查询顺序一致。 */
const WINDOWS = [
  { from: '2026-10-19', to: '2026-10-19' },
  { from: '2026-10-18', to: '2026-10-18' },
  { from: '2026-09-19', to: '2026-10-18' },
]

test('重叠天数：单日交集为 1，相邻两段为 0', () => {
  assert.equal(
    rangeOverlapDays(
      { from: '2026-10-19', to: '2026-10-19' },
      { from: '2026-10-19', to: '2026-10-19' },
    ),
    1,
  )
  assert.equal(
    rangeOverlapDays(
      { from: '2026-10-18', to: '2026-10-18' },
      { from: '2026-10-19', to: '2026-10-19' },
    ),
    0,
  )
  assert.equal(
    rangeOverlapDays(
      { from: '2026-09-19', to: '2026-10-18' },
      { from: '2026-09-20', to: '2026-10-19' },
    ),
    29,
  )
})

test('近 30 天：选中 30 天快照，而不是最新的单日快照', () => {
  const picked = pickSnapshotIndex(WINDOWS, { from: '2026-09-20', to: '2026-10-19' })
  // 索引 2 = 09-19~10-18（重叠 29 天）；索引 0 虽然最新，只重叠 1 天。
  assert.equal(picked, 2)
})

test('查询单日 10-19：选中当天快照，而不是 30 天快照', () => {
  // 30 天快照止于 10-18，与 10-19 不相交，本就不该出现在候选里；这里仍把它放进
  // 候选，验的是函数自己不靠调用方的过滤也能给出正确答案。
  assert.equal(pickSnapshotIndex(WINDOWS, { from: '2026-10-19', to: '2026-10-19' }), 0)
})

test('近 7 天跨过数据末日：仍选 30 天快照（重叠 6 天 > 1 天）', () => {
  assert.equal(pickSnapshotIndex(WINDOWS, { from: '2026-10-13', to: '2026-10-19' }), 2)
})

test('重叠天数相同时取更晚的窗口', () => {
  const same = [
    { from: '2026-10-06', to: '2026-10-20' },
    { from: '2026-09-25', to: '2026-10-05' },
  ]
  // 查询 10-01~10-10 与两份各重叠 5 天（10-06~10-10 与 10-01~10-05），取 to 更晚的。
  assert.equal(pickSnapshotIndex(same, { from: '2026-10-01', to: '2026-10-10' }), 0)
  assert.equal(pickSnapshotIndex([...same].reverse(), { from: '2026-10-01', to: '2026-10-10' }), 1)
})

test('全部不相交时退回第一条（最新），不返回 -1', () => {
  const old = [{ from: '2026-08-01', to: '2026-08-31' }]
  assert.equal(pickSnapshotIndex(old, { from: '2026-10-01', to: '2026-10-31' }), 0)
})

test('没有候选时返回 -1', () => {
  assert.equal(pickSnapshotIndex([], { from: '2026-10-01', to: '2026-10-31' }), -1)
})
