/**
 * 模块入口卡取值的回归测试。
 *
 * 这张卡此前的毛病是「把没有数据写成固定文案」：数据入库了也不显示，而且没有任何
 * 断言会失败。所以这里的重点不是「有值时显示得好看」，而是三件容易写错的事：
 *
 *   1. **缺失与 0 要分开。** summary 里没有行显示「待接入」，行在且值为 0 显示 0。
 *      两者混同会让「没采到」被读成「业务为零」。
 *   2. **内容来源访客按行判空。** 它在 content 维度而不是 summary，reduce 的初值
 *      是 0，不先判空就会把空集合显示成 0。
 *   3. **金额全为 null 时不合计成 0。** 五店都没权限时合计该是破折号。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NAV_CODES } from '@fanhe/shared'

import { OPS_MODULE_PENDING, buildOpsModuleCards } from '../src/lib/ops-module-cards.ts'

/** 一组空维度。type 按调用方给，其余字段对卡片逻辑没有影响。 */
function emptyGroup(type) {
  return { type, window: null, rows: [] }
}

function makeData({ summary = [], items = [], content = [] } = {}) {
  return {
    shop: {
      id: 's1',
      code: 'fanhe-main',
      name: '梵禾',
      ownerId: null,
      ownerName: null,
      platform: 'taobao',
      sellerNick: null,
      timezone: 'Asia/Shanghai',
      lastCollectedAt: null,
      boundAt: null,
      loginState: 'unknown',
      loginCheckedAt: null,
      collectPort: null,
      syncRequestedAt: null,
      lastSyncError: null,
    },
    range: { from: '2026-10-01', to: '2026-10-30' },
    days: 30,
    previous: null,
    kpi: [],
    series: [],
    dimensions: {
      items: { type: 'item', window: null, rows: items },
      channels: emptyGroup('channel'),
      areas: emptyGroup('area'),
      keywords: emptyGroup('keyword'),
      content: { type: 'content', window: null, rows: content },
      summary: { type: 'summary', window: null, rows: summary },
    },
    flags: {
      lastCollectedAt: null,
      lastRunStatus: null,
      masked: [],
      dailyDays: 0,
      covered: null,
    },
  }
}

function summaryRow(key, value) {
  return { key, label: key, metrics: { value } }
}

function cardOf(cards, code) {
  const found = cards.find((card) => card.code === code)
  assert.ok(found, `缺少 ${code} 这张卡`)
  return found
}

function valueOf(cards, code, label) {
  const card = cardOf(cards, code)
  const entry = card.numbers.find((number) => number.label === label)
  assert.ok(entry, `${code} 卡里缺少「${label}」`)
  return entry.value
}

test('没有任何补充数据时，六个位置都是「待接入」', () => {
  const cards = buildOpsModuleCards(makeData(), [], null)

  assert.equal(valueOf(cards, NAV_CODES.OPS_ITEMS, '商品基础分'), OPS_MODULE_PENDING)
  assert.equal(valueOf(cards, NAV_CODES.OPS_SERVICE, '三分钟响应'), OPS_MODULE_PENDING)
  assert.equal(valueOf(cards, NAV_CODES.OPS_SERVICE, '平均响应'), OPS_MODULE_PENDING)
  assert.equal(valueOf(cards, NAV_CODES.OPS_ADS, '推广花费'), OPS_MODULE_PENDING)
  assert.equal(valueOf(cards, NAV_CODES.OPS_ADS, '点击率'), OPS_MODULE_PENDING)
  assert.equal(valueOf(cards, NAV_CODES.OPS_CONTENT, '内容来源访客'), OPS_MODULE_PENDING)
  assert.equal(valueOf(cards, NAV_CODES.OPS_CONTENT, '内容查看'), OPS_MODULE_PENDING)
})

test('summary 里给了值就按单位格式化成真值', () => {
  const cards = buildOpsModuleCards(
    makeData({
      summary: [
        summaryRow('csThreeMinRate', 0.862),
        summaryRow('csAvgReplySec', 23.380952),
        summaryRow('kwCost', 1234500),
        summaryRow('kwCtr', 0.0312),
        summaryRow('itemBaseScore', 78),
        summaryRow('contentViewUv', 4321),
        summaryRow('flowRecommendUv', 15000),
        summaryRow('bounceRate', 0.334),
      ],
    }),
    [],
    null,
  )

  assert.equal(valueOf(cards, NAV_CODES.OPS_SERVICE, '三分钟响应'), '86.2%')
  assert.equal(valueOf(cards, NAV_CODES.OPS_SERVICE, '平均响应'), '23.4 秒')
  assert.equal(valueOf(cards, NAV_CODES.OPS_ADS, '推广花费'), '¥1.2万')
  assert.equal(valueOf(cards, NAV_CODES.OPS_ADS, '点击率'), '3.1%')
  assert.equal(valueOf(cards, NAV_CODES.OPS_ITEMS, '商品基础分'), '78')
  assert.equal(valueOf(cards, NAV_CODES.OPS_CONTENT, '内容查看'), '4,321')
  assert.equal(valueOf(cards, NAV_CODES.OPS_FLOW, '推荐访客'), '15,000')
  assert.equal(valueOf(cards, NAV_CODES.OPS_FLOW, '跳失率'), '33.4%')
})

test('值为 0 显示 0，不能回落成「待接入」', () => {
  const cards = buildOpsModuleCards(
    makeData({
      summary: [summaryRow('csAvgReplySec', 0), summaryRow('csThreeMinRate', 0)],
    }),
    [],
    null,
  )

  assert.equal(valueOf(cards, NAV_CODES.OPS_SERVICE, '平均响应'), '0.0 秒')
  assert.equal(valueOf(cards, NAV_CODES.OPS_SERVICE, '三分钟响应'), '0.0%')
})

test('值不是有限数时按缺失处理，不显示 NaN', () => {
  const cards = buildOpsModuleCards(
    makeData({ summary: [summaryRow('kwCtr', Number.NaN)] }),
    [],
    null,
  )

  assert.equal(valueOf(cards, NAV_CODES.OPS_ADS, '点击率'), OPS_MODULE_PENDING)
})

test('内容来源访客：空集合显示待接入，有行则求和', () => {
  const empty = buildOpsModuleCards(makeData(), [], null)
  assert.equal(valueOf(empty, NAV_CODES.OPS_CONTENT, '内容来源访客'), OPS_MODULE_PENDING)

  const filled = buildOpsModuleCards(
    makeData({
      content: [
        { key: 'live', label: '直播', metrics: { visitors: 1200 } },
        { key: 'video', label: '短视频', metrics: { visitors: 800 } },
      ],
    }),
    [],
    null,
  )
  assert.equal(valueOf(filled, NAV_CODES.OPS_CONTENT, '内容来源访客'), '2,000')
})

test('有成交链接：只数支付金额大于 0 的行', () => {
  const cards = buildOpsModuleCards(
    makeData({
      items: [
        { key: 'a', label: 'A', metrics: { payAmountFen: 120000 } },
        { key: 'b', label: 'B', metrics: { payAmountFen: 0 } },
        { key: 'c', label: 'C', metrics: {} },
      ],
    }),
    [],
    null,
  )

  assert.equal(valueOf(cards, NAV_CODES.OPS_ITEMS, '有成交链接'), '1 / 3')
})

test('五店金额全为 null 时合计是破折号，不是 ¥0', () => {
  const boards = [
    {
      shop: { code: 'a' },
      hasData: false,
      coveredDays: 0,
      payAmountFen: null,
      payBuyers: null,
      visitors: null,
      payRate: null,
      masked: true,
      series: [],
    },
    {
      shop: { code: 'b' },
      hasData: false,
      coveredDays: 0,
      payAmountFen: null,
      payBuyers: null,
      visitors: null,
      payRate: null,
      masked: true,
      series: [],
    },
  ]
  const cards = buildOpsModuleCards(makeData(), boards, null)

  assert.equal(valueOf(cards, NAV_CODES.OPS_TRADE, '五店合计'), '—')
})

/*
 * 只有单日口径的指标会从另一份快照补进来，接口在 `supplementedFrom` 里说明来源。
 * 页头写着「近 30 天」而卡片显示某一天的值、却不注明日期，等于把两个口径混成一句
 * 话 —— 这种错不会让任何数字变成 NaN，只会让读数的人判断错。
 */
test('指标来自单日快照时，数值后面标出那一天', () => {
  const data = makeData({
    summary: [summaryRow('csThreeMinRate', 0.9941), summaryRow('visitors', 336)],
  })
  data.dimensions.summary = {
    type: 'summary',
    window: { from: '2026-09-19', to: '2026-10-18' },
    rows: [summaryRow('csThreeMinRate', 0.9941), summaryRow('visitors', 336)],
    supplementedFrom: { from: '2026-10-29', to: '2026-10-29' },
    supplementedKeys: ['csThreeMinRate'],
  }

  const cards = buildOpsModuleCards(data, [], null)

  assert.equal(valueOf(cards, NAV_CODES.OPS_SERVICE, '三分钟响应'), '99.4% · 10-29')
})

test('同组里未标注的行不带日期，避免整组看起来都只有一天', () => {
  const data = makeData()
  data.dimensions.summary = {
    type: 'summary',
    window: { from: '2026-09-19', to: '2026-10-18' },
    rows: [summaryRow('csThreeMinRate', 1), summaryRow('kwCtr', 0.05)],
    supplementedFrom: { from: '2026-10-29', to: '2026-10-29' },
    supplementedKeys: ['csThreeMinRate'],
  }

  const cards = buildOpsModuleCards(data, [], null)

  assert.equal(valueOf(cards, NAV_CODES.OPS_SERVICE, '三分钟响应'), '100.0% · 10-29')
  assert.equal(valueOf(cards, NAV_CODES.OPS_ADS, '点击率'), '5.0%')
})
