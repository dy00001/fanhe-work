/**
 * 运营看板「地址 ↔ 看板」映射与区间换算的回归测试。
 *
 * 这些函数决定了「点侧栏第几项看到哪块看板」和「选某个预设实际查哪两天」。
 * 两件事都没有报错路径：映射漏一项就是点进去看到空页，区间差一天就是数字偏移，
 * 而界面照常渲染。因此这里对每个分支逐一钉死，包括边界（月初、闰年、数据起点）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NAV_CODES } from '@fanhe/shared'

import {
  isOpsNavCode,
  isOpsPreset,
  monthEnd,
  monthStart,
  presetDays,
  presetQuery,
  presetRange,
  rangeCaption,
  viewFromNav,
} from '../src/lib/ops-view.ts'

const COVERAGE = { from: '2026-09-19', to: '2026-10-18' }

test('七个运营入口各自映射到一块看板，且没有遗漏', () => {
  const expected = [
    [NAV_CODES.DASHBOARD, 'screen'],
    [NAV_CODES.OPS_TRADE, 'trade'],
    [NAV_CODES.OPS_ITEMS, 'items'],
    [NAV_CODES.OPS_FLOW, 'flow'],
    [NAV_CODES.OPS_SERVICE, 'service'],
    [NAV_CODES.OPS_ADS, 'ads'],
    [NAV_CODES.OPS_CONTENT, 'content'],
  ]
  for (const [code, view] of expected) {
    assert.equal(viewFromNav(code), view, `${code} 应映射到 ${view}`)
    assert.equal(isOpsNavCode(code), true)
  }
  // 非运营入口必须返回 null，交给调用方渲染兜底，而不是悄悄落到第一块看板。
  assert.equal(viewFromNav(NAV_CODES.WORKBENCH), null)
  assert.equal(isOpsNavCode(NAV_CODES.WORKBENCH), false)
})

test('月份边界：大小月与闰年都对', () => {
  assert.equal(monthStart('2026-10-18'), '2026-10-01')
  assert.equal(monthEnd('2026-10-18'), '2026-10-31')
  assert.equal(monthEnd('2026-04-05'), '2026-04-30')
  assert.equal(monthEnd('2026-02-10'), '2026-02-28')
  assert.equal(monthEnd('2024-02-10'), '2024-02-29')
  // 跨年边界：12 月的下一个月是次年 1 月。
  assert.equal(monthEnd('2026-12-01'), '2026-12-31')
})

test('预设天数：固定档有天数，月份与自定义没有', () => {
  assert.equal(presetDays('d1'), 1)
  assert.equal(presetDays('7d'), 7)
  assert.equal(presetDays('30d'), 30)
  assert.equal(presetDays('tm'), null)
  assert.equal(presetDays('lm'), null)
  assert.equal(presetDays('custom'), null)
})

test('预设识别：不认识的取值不当作预设', () => {
  assert.equal(isOpsPreset('30d'), true)
  assert.equal(isOpsPreset('90d'), false)
  assert.equal(isOpsPreset(null), false)
})

test('单日区间落在数据末日，不是今天', () => {
  assert.deepEqual(presetRange('d1', COVERAGE, null), { from: '2026-10-18', to: '2026-10-18' })
})

test('近 7 / 近 30 天以数据末日为终点，并夹到数据起点', () => {
  assert.deepEqual(presetRange('7d', COVERAGE, null), { from: '2026-10-12', to: '2026-10-18' })
  assert.deepEqual(presetRange('30d', COVERAGE, null), { from: '2026-09-19', to: '2026-10-18' })
  // 数据只有 30 天时，请求「近 30 天」正好等于覆盖范围，不会跨出起点。
  assert.deepEqual(presetRange('30d', { from: '2026-10-01', to: '2026-10-18' }, null), {
    from: '2026-10-01',
    to: '2026-10-18',
  })
})

test('本月：从月初到今天有数的最后一天，夹住数据起点', () => {
  assert.deepEqual(presetRange('tm', COVERAGE, null), { from: '2026-10-01', to: '2026-10-18' })
  // 数据末日在上个月时，本月区间应从数据起点开始，而不是跨到空的月份。
  assert.deepEqual(presetRange('tm', { from: '2026-09-19', to: '2026-10-18' }, null), {
    from: '2026-10-01',
    to: '2026-10-18',
  })
})

test('上月：整月，且夹在数据范围内', () => {
  // 9 月整月里只有 09-19 之后有数，所以起点被夹到 09-19。
  assert.deepEqual(presetRange('lm', COVERAGE, null), { from: '2026-09-19', to: '2026-09-30' })
  // 数据只覆盖 10 月时，上月整段在数据之前 → 返回 null，由界面显示「无数据」。
  assert.equal(presetRange('lm', { from: '2026-10-01', to: '2026-10-18' }, null), null)
})

test('自定义：起止非法或颠倒时返回 null', () => {
  assert.deepEqual(presetRange('custom', COVERAGE, { from: '2026-10-01', to: '2026-10-18' }), {
    from: '2026-10-01',
    to: '2026-10-18',
  })
  assert.equal(presetRange('custom', COVERAGE, null), null)
  assert.equal(presetRange('custom', COVERAGE, { from: '2026-10-18', to: '2026-10-01' }), null)
})

test('请求参数：固定档交给 days，月份类给具体两端', () => {
  assert.deepEqual(presetQuery('7d', null, null), { days: 7 })
  assert.deepEqual(presetQuery('30d', null, null), { days: 30 })
  // 本月在还不知道覆盖范围时先按 30 天取一份，避免首屏空白。
  assert.deepEqual(presetQuery('tm', null, null), { days: 30 })
  assert.deepEqual(presetQuery('tm', COVERAGE, null), { from: '2026-10-01', to: '2026-10-18' })
  assert.deepEqual(presetQuery('custom', COVERAGE, { from: '2026-10-01', to: '2026-10-10' }), {
    from: '2026-10-01',
    to: '2026-10-10',
  })
})

test('区间说明：带数据范围与天数，缺覆盖范围时只说天数', () => {
  assert.equal(rangeCaption(COVERAGE, 30), '数据范围 2026-09-19 ~ 2026-10-18（30 天）')
  assert.equal(rangeCaption(null, 7), '当前区间 7 天')
})
