/**
 * 运营看板读模型的集成测试。
 *
 * 需要真实数据库，理由与 `note.test.ts` 相同：这里要验的是「同一批数据在不同权限下
 * 返回不同形状」，而裁剪发生在 Prisma 查出来的对象上 —— 用内存替身测，测的是替身。
 *
 * **这个文件是补一个真实缺陷的回归。** 首版把「维度金额裁剪」写在了取数路径上，
 * 与权限判断无关，于是所有人（包括持有 `ops.finance.read` 的管理员）都看不到商品与
 * 渠道的金额列。KPI 那一路是对的，所以只测 KPI 的用例全绿 —— 这正是「断言必须覆盖
 * 到实际会坏的那一处」的例子。
 *
 * 三条断言各自守一件事：
 *
 *   1. 有金额权限 → 金额字段在，`masked` 为空。
 *   2. 无金额权限 → 金额字段消失、`masked` 记名、KPI 的 `value` 为 null 而不是 0。
 *   3. 查询区间不等于快照窗口 → KPI 退回逐日口径（`source === 'daily'`），
 *      因为整段去重的数字在那个区间上不成立。
 *
 * 测试数据用 `zz_test_` 前缀，结束时按 shop code 级联删除。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ALL_PERMISSIONS, type PermissionCode } from '@fanhe/shared'

import { resolveTestDatabaseUrl } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { loadOpsDashboard } = await import('../src/ops/query.js')

const SHOP_CODE = 'zz_test_ops_shop'
const WINDOW = { from: '2026-09-19', to: '2026-10-18' }

/** 与快照窗口相同的区间：走整段口径。 */
const RANGE_SAME = { from: '2026-09-19', to: '2026-10-18' }
/** 与快照窗口不同的区间：只能走逐日求和。 */
const RANGE_DIFFERENT = { from: '2026-10-01', to: '2026-10-18' }

const asDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

describe('运营看板读模型', { skip: databaseUrl === null ? '数据库不可达' : false }, () => {
  before(async () => {
    await prisma.ecomShop.deleteMany({ where: { code: SHOP_CODE } })

    const shop = await prisma.ecomShop.create({
      data: {
        code: SHOP_CODE,
        name: 'zz_test_运营看板',
        platform: 'taobao',
        lastCollectedAt: new Date('2026-10-19T00:30:00.000Z'),
      },
      select: { id: true },
    })

    // 三天逐日：10-01、10-02 有值，10-03 全 null（模拟「没采到」而不是「没成交」）。
    await prisma.ecomDailyMetric.createMany({
      data: [
        {
          shopId: shop.id,
          statDate: asDate('2026-10-01'),
          payAmountFen: 1_000_000,
          visitors: 100,
          payBuyers: 4,
          itemVisitors: 90,
        },
        {
          shopId: shop.id,
          statDate: asDate('2026-10-02'),
          payAmountFen: 500_000,
          visitors: 50,
          payBuyers: 2,
          itemVisitors: 45,
        },
        {
          shopId: shop.id,
          statDate: asDate('2026-10-03'),
          payAmountFen: null,
          visitors: null,
          payBuyers: null,
          itemVisitors: null,
        },
      ],
    })

    // 整段快照：窗口与 RANGE_SAME 相同。
    await prisma.ecomDimensionSnapshot.createMany({
      data: [
        {
          shopId: shop.id,
          dimType: 'item',
          statFrom: asDate(WINDOW.from),
          statTo: asDate(WINDOW.to),
          dimKey: 'zz_item_1',
          dimLabel: 'zz_test_商品一',
          metrics: {
            visitors: 1000,
            payBuyers: 10,
            payRate: 0.01,
            payAmountFen: 2_000_000,
            cartFen: 3_000_000,
          },
        },
        {
          shopId: shop.id,
          dimType: 'item',
          statFrom: asDate(WINDOW.from),
          statTo: asDate(WINDOW.to),
          dimKey: 'zz_item_2',
          dimLabel: 'zz_test_商品二',
          metrics: {
            visitors: 200,
            payBuyers: 8,
            payRate: 0.04,
            payAmountFen: 900_000,
            cartFen: 100_000,
          },
        },
        {
          shopId: shop.id,
          dimType: 'summary',
          statFrom: asDate(WINDOW.from),
          statTo: asDate(WINDOW.to),
          dimKey: 'payAmount',
          dimLabel: 'payAmount',
          metrics: { value: 9_990_000, cycleCrc: 0.5 },
        },
        {
          shopId: shop.id,
          dimType: 'summary',
          statFrom: asDate(WINDOW.from),
          statTo: asDate(WINDOW.to),
          dimKey: 'visitors',
          dimLabel: 'visitors',
          metrics: { value: 3_890, cycleCrc: 1.9 },
        },
        /*
         * 客服指标只有单日口径（平台按 dateType=1d 返回）。造一份落在窗口内的单日
         * 快照，用来验「区间视图从单日快照补齐」。日期放在窗口中间而不是窗口末一天，
         * 是为了区分「取最近一份」与「取窗口末日」两种实现 —— 后者在数据缺一天时
         * 会静默取到更早的值。
         */
        {
          shopId: shop.id,
          dimType: 'summary',
          statFrom: asDate('2026-10-15'),
          statTo: asDate('2026-10-15'),
          dimKey: 'csThreeMinRate',
          dimLabel: 'csThreeMinRate',
          metrics: { value: 1 },
        },
        {
          shopId: shop.id,
          dimType: 'summary',
          statFrom: asDate('2026-10-15'),
          statTo: asDate('2026-10-15'),
          dimKey: 'csAvgReplySec',
          dimLabel: 'csAvgReplySec',
          metrics: { value: 23.380952 },
        },
        {
          shopId: shop.id,
          dimType: 'summary',
          statFrom: asDate('2026-10-15'),
          statTo: asDate('2026-10-15'),
          dimKey: 'csConsultUv',
          dimLabel: 'csConsultUv',
          metrics: { value: 1 },
        },
        {
          shopId: shop.id,
          dimType: 'summary',
          statFrom: asDate('2026-10-15'),
          statTo: asDate('2026-10-15'),
          dimKey: 'csReplyUv',
          dimLabel: 'csReplyUv',
          metrics: { value: 1 },
        },
      ],
    })
  })

  after(async () => {
    // 外键是级联删除，删店铺即可带走逐日与快照。
    await prisma.ecomShop.deleteMany({ where: { code: SHOP_CODE } })
    await prisma.$disconnect()
  })

  test('有金额权限：金额字段在，masked 为空', async () => {
    const data = await loadOpsDashboard({
      shopCode: SHOP_CODE,
      range: RANGE_SAME,
      viewer: { permissions: [...ALL_PERMISSIONS] },
    })
    assert.ok(data !== null)

    const item = data.dimensions.items.rows.find((row) => row.key === 'zz_item_1')
    assert.ok(item !== undefined)
    assert.equal(item.metrics.payAmountFen, 2_000_000)
    assert.equal(item.metrics.cartFen, 3_000_000)
    assert.deepEqual(data.flags.masked, [])

    const payAmount = data.kpi.find((k) => k.key === 'payAmount')
    assert.ok(payAmount !== undefined)
    assert.notEqual(payAmount.value, null)
    assert.equal(payAmount.masked, false)
  })

  /*
   * 客服四项只有单日口径，区间快照里永远没有它们。没有这条补齐路径，界面在
   * 「近 30 天」下永远是「待接入」，而单日视图却有数 —— 看起来像采集坏了。
   *
   * 同时守两件事：补齐的行必须留下 `supplementedFrom`（界面据此标日期），
   * 且不能把原窗口的行挤掉（一次响应里两种口径并存是正常的）。
   */
  test('区间快照缺客服指标时，从窗口内最近一份单日快照补齐并标日期', async () => {
    const data = await loadOpsDashboard({
      shopCode: SHOP_CODE,
      range: RANGE_SAME,
      viewer: { permissions: [...ALL_PERMISSIONS] },
    })
    assert.ok(data !== null)

    const summary = data.dimensions.summary
    const byKey = new Map(summary.rows.map((row) => [row.key, row.metrics.value]))

    assert.equal(byKey.get('csThreeMinRate'), 1)
    assert.equal(byKey.get('csAvgReplySec'), 23.380952)
    assert.equal(byKey.get('csConsultUv'), 1)
    assert.equal(byKey.get('csReplyUv'), 1)

    assert.deepEqual(summary.supplementedFrom, { from: '2026-10-15', to: '2026-10-15' })
    assert.deepEqual([...(summary.supplementedKeys ?? [])].sort(), [
      'csAvgReplySec',
      'csConsultUv',
      'csReplyUv',
      'csThreeMinRate',
    ])

    // 原窗口的行不能被补进来的行挤掉：两种口径在同一份响应里并存是正常状态。
    assert.equal(byKey.get('payAmount'), 9_990_000)
    assert.equal(byKey.get('visitors'), 3_890)
  })

  test('无金额权限：金额字段消失、masked 记名、KPI 为 null 而不是 0', async () => {
    const data = await loadOpsDashboard({
      shopCode: SHOP_CODE,
      range: RANGE_SAME,
      viewer: { permissions: ['ops.shop.read' satisfies PermissionCode] },
    })
    assert.ok(data !== null)

    const item = data.dimensions.items.rows.find((row) => row.key === 'zz_item_1')
    assert.ok(item !== undefined)
    // 键不存在，而不是值为 null —— 前端据此整列消失而非显示一列破折号。
    assert.equal(Object.hasOwn(item.metrics, 'payAmountFen'), false)
    assert.equal(Object.hasOwn(item.metrics, 'cartFen'), false)
    // 非金额字段照常返回，否则「无金额权限」会退化成「什么都看不到」。
    assert.equal(item.metrics.visitors, 1000)

    assert.ok(data.flags.masked.includes('payAmountFen'))
    assert.ok(data.flags.masked.includes('cartFen'))

    const payAmount = data.kpi.find((k) => k.key === 'payAmount')
    assert.ok(payAmount !== undefined)
    assert.equal(payAmount.value, null)
    assert.equal(payAmount.masked, true)

    // 非金额的 KPI 不受影响。0 与 null 的区别在这里体现：访客有值，金额为 null。
    const visitors = data.kpi.find((k) => k.key === 'visitors')
    assert.ok(visitors !== undefined)
    assert.equal(visitors.value !== null, true)
  })

  test('区间等于快照窗口时用整段口径，环比取自平台', async () => {
    const data = await loadOpsDashboard({
      shopCode: SHOP_CODE,
      range: RANGE_SAME,
      viewer: { permissions: ['ops.shop.read', 'ops.finance.read'] },
    })
    assert.ok(data !== null)

    const payAmount = data.kpi.find((k) => k.key === 'payAmount')
    assert.ok(payAmount !== undefined)
    assert.equal(payAmount.source, 'period')
    assert.equal(payAmount.value, 9_990_000)
    assert.equal(payAmount.deltaPct, 0.5)
  })

  test('区间不等于快照窗口时退回逐日求和，且没有上一周期时不编造环比', async () => {
    const data = await loadOpsDashboard({
      shopCode: SHOP_CODE,
      range: RANGE_DIFFERENT,
      viewer: { permissions: ['ops.shop.read', 'ops.finance.read'] },
    })
    assert.ok(data !== null)

    const payAmount = data.kpi.find((k) => k.key === 'payAmount')
    assert.ok(payAmount !== undefined)
    assert.equal(payAmount.source, 'daily')
    // 10-01 与 10-02 两天：1,000,000 + 500,000
    assert.equal(payAmount.value, 1_500_000)

    const visitors = data.kpi.find((k) => k.key === 'visitors')
    assert.ok(visitors !== undefined)
    // 10-03 全 null 不计入求和，也不补 0 —— 两天 100 + 50。
    assert.equal(visitors.value, 150)

    // 上一周期（9 月）库里没有任何数据，环比必须是 null 而不是 0 或 Infinity。
    assert.equal(payAmount.deltaPct, null)
  })

  test('没有这家店时返回 null，而不是一个空壳对象', async () => {
    const data = await loadOpsDashboard({
      shopCode: 'zz_test_不存在的店',
      range: RANGE_SAME,
      viewer: { permissions: [...ALL_PERMISSIONS] },
    })
    assert.equal(data, null)
  })
})
