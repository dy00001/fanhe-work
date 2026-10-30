/**
 * 服务体验指标格的回归测试。
 *
 * 这个页面前身是一张「尚未接入」清单 —— 数据入库了页面也不显示，而且没有任何断言
 * 会红。所以这里的重点同样是三件容易写错的事：
 *
 *   1. **缺失与 0 要分开。** 没有行显示「待接入」，行在且值为 0 显示 0。
 *   2. **单日口径要带日期。** 30 天视图里显示的是某一天的值，不标日期会被当成区间值。
 *   3. **清单来自契约。** 指标格由 `OPS_SUMMARY_METRICS` 里 `module === 'service'`
 *      的项生成，不在组件里手写 —— 手写必然漂。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OPS_SUMMARY_METRICS } from '@fanhe/shared'

import { buildServiceMetrics } from '../src/lib/ops-service-metrics.ts'

function group({ rows = [], window = null, supplementedFrom = null } = {}) {
  return { type: 'summary', window, rows, supplementedFrom }
}

function row(key, value) {
  return { key, label: key, metrics: { value } }
}

function valueOf(cells, key) {
  const found = cells.find((cell) => cell.key === key)
  assert.ok(found, `指标格里缺少 ${key}`)
  return found.value
}

test('指标清单与契约里的 service 模块一致，不在组件里手写', () => {
  const expected = OPS_SUMMARY_METRICS.filter((spec) => spec.module === 'service').map(
    (spec) => spec.key,
  )
  const { cells } = buildServiceMetrics(group())
  assert.deepEqual(
    cells.map((cell) => cell.key),
    expected,
  )
})

test('没有任何客服行时全部显示待接入，并说明没有数据', () => {
  const { cells, note } = buildServiceMetrics(group())

  assert.equal(valueOf(cells, 'csThreeMinRate'), null)
  assert.equal(valueOf(cells, 'csAvgReplySec'), null)
  assert.equal(valueOf(cells, 'csConsultUv'), null)
  assert.equal(valueOf(cells, 'csReplyUv'), null)
  assert.equal(note, '还没有客服数据')
})

test('有值时按单位格式化：比率带百分号、时长带秒、人数带千分位', () => {
  const { cells, note } = buildServiceMetrics(
    group({
      window: { from: '2026-10-29', to: '2026-10-29' },
      rows: [
        row('csThreeMinRate', 1),
        row('csAvgReplySec', 23.380952),
        row('csConsultUv', 1),
        row('csReplyUv', 1234),
      ],
    }),
  )

  assert.equal(valueOf(cells, 'csThreeMinRate'), '100.0%')
  assert.equal(valueOf(cells, 'csAvgReplySec'), '23.4 秒')
  assert.equal(valueOf(cells, 'csConsultUv'), '1')
  assert.equal(valueOf(cells, 'csReplyUv'), '1,234')
  assert.equal(note, '2026-10-29 单日快照')
})

test('值为 0 显示 0，不能回落成待接入', () => {
  const { cells } = buildServiceMetrics(
    group({
      window: { from: '2026-10-29', to: '2026-10-29' },
      rows: [row('csThreeMinRate', 0), row('csAvgReplySec', 0), row('csConsultUv', 0)],
    }),
  )

  assert.equal(valueOf(cells, 'csThreeMinRate'), '0.0%')
  assert.equal(valueOf(cells, 'csAvgReplySec'), '0.0 秒')
  assert.equal(valueOf(cells, 'csConsultUv'), '0')
})

test('非有限数按缺失处理，不显示 NaN', () => {
  const { cells } = buildServiceMetrics(
    group({
      window: { from: '2026-10-29', to: '2026-10-29' },
      rows: [row('csThreeMinRate', Number.NaN)],
    }),
  )

  assert.equal(valueOf(cells, 'csThreeMinRate'), null)
})

test('从单日快照补进来时，口径说明带上那一天', () => {
  const { note } = buildServiceMetrics(
    group({
      window: { from: '2026-09-30', to: '2026-10-29' },
      rows: [row('csThreeMinRate', 1)],
      supplementedFrom: { from: '2026-10-29', to: '2026-10-29' },
    }),
  )

  assert.ok(note.includes('2026-10-29'), `口径说明里没有数据日期：${note}`)
  assert.ok(note.includes('单日口径'), `口径说明里没写清单日口径：${note}`)
})

test('未接入的项仍留在格子里，而不是从版面上消失', () => {
  const { cells } = buildServiceMetrics(
    group({
      window: { from: '2026-10-29', to: '2026-10-29' },
      rows: [row('csThreeMinRate', 1)],
    }),
  )

  const pending = cells.filter((cell) => cell.value === null).map((cell) => cell.key)
  assert.deepEqual(pending, [
    'csAvgReplySec',
    'csConsultUv',
    'csReplyUv',
    'rateUnrepliedCnt',
    'wendaPendingCnt',
  ])
})

/*
 * 待办计数是「采集那一刻欠着多少条」，与响应率那四项同批但不同源：
 *
 *   - 它们由自建的千牛模块采，不经过生意参谋的 csp 接口；
 *   - 为 0 是**真的没有待办**，必须显示 0，不能回落成「待接入」（48 天前那种
 *     「一条都没欠」和「没采到」在界面上必须能分开）。
 */
test('待办计数为 0 显示 0，不当成未接入', () => {
  const { cells } = buildServiceMetrics(
    group({
      window: { from: '2026-10-30', to: '2026-10-30' },
      rows: [row('rateUnrepliedCnt', 0), row('wendaPendingCnt', 0)],
    }),
  )

  assert.equal(valueOf(cells, 'rateUnrepliedCnt'), '0')
  assert.equal(valueOf(cells, 'wendaPendingCnt'), '0')
})

test('待办计数按人数格式带千分位，不写成比率或时长', () => {
  const { cells } = buildServiceMetrics(
    group({
      window: { from: '2026-10-30', to: '2026-10-30' },
      rows: [row('rateUnrepliedCnt', 48), row('wendaPendingCnt', 1234)],
    }),
  )

  assert.equal(valueOf(cells, 'rateUnrepliedCnt'), '48')
  assert.equal(valueOf(cells, 'wendaPendingCnt'), '1,234')
})
