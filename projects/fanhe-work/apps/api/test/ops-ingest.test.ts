/**
 * 采集写入路径的回归测试。
 *
 * 为什么要有这个文件：`ops.test.ts` 只覆盖读模型（权限裁剪与口径切换），写入路径
 * 一条断言都没有。于是两个真实缺陷长期存在而没有任何用例会红 ——
 *
 *   1. **同窗口重采时，某维度类型本次零行 → 该类型的旧行被整片删掉。** 清理语句
 *      写的是 `dimKey: { notIn: keys.length === 0 ? [''] : keys }`，本意是「删掉
 *      本次没上报的旧行」，但当 keys 为空时它退化成「这个类型一行都不留」。上午
 *      采到渠道 5 行、下午重采时渠道页偏薄只回了商品榜，上午的数据就没了，而这次
 *      运行仍记 succeeded。
 *   2. **`partial` 从不产出。** `OPS_COLLECT_STATUSES` 里有它，展示层也照着写了
 *      文案，但写入端只有 failed / succeeded 两个出口。「逐日拿到了、维度全没拿到」
 *      这种最常见的半截采集被记成成功，看板上商品榜一片「—」而运行记录是绿的。
 *
 * 两条都不抛错、不违反类型、不影响别的用例，只有针对**写入结果**的断言能发现。
 *
 * 数据用 `zz_test_` 前缀，结束按 shop code 级联删除（三张子表都是 onDelete: Cascade）。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'

import type { OpsIngestDimension, OpsIngestRequest } from '@fanhe/shared'

import { resolveTestDatabaseUrl } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { ingestOpsSnapshot } = await import('../src/ops/ingest.js')

const SHOP_CODE = 'zz_test_ops_ingest'
const SHOP_NAME = 'zz_test_写入路径'

/** 一个合法窗口。所有用例共用同一窗口，才能测到「同窗口重采」这条路径。 */
const WINDOW = { from: '2026-10-01', to: '2026-10-30' }

const asDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

function dimension(type: OpsIngestDimension['type'], key: string): OpsIngestDimension {
  return {
    type,
    key,
    label: `zz_test_${key}`,
    metrics: { visitors: 100, payAmountFen: 10_000 },
  }
}

function payload(overrides: Partial<OpsIngestRequest>): OpsIngestRequest {
  return {
    contractVersion: 1,
    shop: { code: SHOP_CODE, name: SHOP_NAME, platform: 'taobao', sellerNick: null },
    window: WINDOW,
    source: 'api',
    trigger: 'manual',
    rawPath: null,
    daily: [
      {
        date: '2026-10-01',
        payAmountFen: 100_000,
        visitors: 10,
        payBuyers: 1,
        itemVisitors: 9,
      },
    ],
    dimensions: [dimension('item', 'zz_test_item_a')],
    ...overrides,
  }
}

/** 取某类型在本窗口的行数。断言都落在「库里还剩几行」上，而不是返回值。 */
async function countOf(type: OpsIngestDimension['type']): Promise<number> {
  const shop = await prisma.ecomShop.findUnique({
    where: { code: SHOP_CODE },
    select: { id: true },
  })
  assert.ok(shop !== null, '店铺应当已由首次入库建档')
  return prisma.ecomDimensionSnapshot.count({
    where: {
      shopId: shop.id,
      dimType: type,
      statFrom: asDate(WINDOW.from),
      statTo: asDate(WINDOW.to),
    },
  })
}

/** 取最近一次运行的记录。运行是串行写入的，按 startedAt 倒序第一条就是本次。 */
async function latestRun() {
  const shop = await prisma.ecomShop.findUnique({
    where: { code: SHOP_CODE },
    select: { id: true },
  })
  assert.ok(shop !== null)
  const run = await prisma.ecomCollectRun.findFirst({
    where: { shopId: shop.id },
    orderBy: { startedAt: 'desc' },
    select: { status: true, errorMessage: true, dailyRows: true, dimensionRows: true },
  })
  assert.ok(run !== null, '每次入库都必须留一行运行记录')
  return run
}

describe('运营采集写入路径', { skip: databaseUrl === null ? '数据库不可达' : false }, () => {
  before(async () => {
    await prisma.ecomShop.deleteMany({ where: { code: SHOP_CODE } })
  })

  after(async () => {
    await prisma.ecomShop.deleteMany({ where: { code: SHOP_CODE } })
  })

  /*
   * 每个用例前清空子表但保留店铺：店铺一旦建成，后续入库走的是 update 分支，
   * 而这里要测的正是「重复入库到同一家店」。
   */
  beforeEach(async () => {
    const shop = await prisma.ecomShop.findUnique({
      where: { code: SHOP_CODE },
      select: { id: true },
    })
    if (shop === null) return
    await prisma.ecomDimensionSnapshot.deleteMany({ where: { shopId: shop.id } })
    await prisma.ecomDailyMetric.deleteMany({ where: { shopId: shop.id } })
    await prisma.ecomCollectRun.deleteMany({ where: { shopId: shop.id } })
  })

  test('同窗口重采时，本次没上报的维度类型保留旧行', async () => {
    // 第一轮：渠道三行 + 商品一行。
    const first = await ingestOpsSnapshot(
      payload({
        dimensions: [
          dimension('channel', 'zz_test_ch_1'),
          dimension('channel', 'zz_test_ch_2'),
          dimension('channel', 'zz_test_ch_3'),
          dimension('item', 'zz_test_item_a'),
        ],
      }),
    )
    assert.equal(first.ok, true)
    assert.equal(await countOf('channel'), 3)

    /*
     * 第二轮：同窗口，只回商品（渠道页偏薄）。渠道三行必须原样留着 ——
     * 这是本文件存在的首要理由。修复前的行为是变成 0 行。
     */
    const second = await ingestOpsSnapshot(
      payload({ dimensions: [dimension('item', 'zz_test_item_a')] }),
    )
    assert.equal(second.ok, true)
    assert.equal(await countOf('channel'), 3, '本次没上报 channel，不应删除该类型的旧行')
    assert.equal(await countOf('item'), 1)
  })

  test('本次上报的维度类型里，消失的对象仍然被清掉', async () => {
    /*
     * 反向断言。上面那条只说「没上报的类型别动」，如果实现改成「一律不清」，
     * 上一条依然绿 —— 那样下架商品会永远留在榜上。这条守的是另一半。
     */
    await ingestOpsSnapshot(
      payload({
        dimensions: [dimension('item', 'zz_test_item_a'), dimension('item', 'zz_test_item_b')],
      }),
    )
    assert.equal(await countOf('item'), 2)

    await ingestOpsSnapshot(payload({ dimensions: [dimension('item', 'zz_test_item_a')] }))
    assert.equal(await countOf('item'), 1, '本次上报了 item 但少了 b，b 应被清掉')
  })

  test('只有维度、逐日为空 → partial，并更新采集时间', async () => {
    const result = await ingestOpsSnapshot(
      payload({ daily: [], dimensions: [dimension('item', 'zz_test_item_a')] }),
    )
    assert.equal(result.ok, true)

    const run = await latestRun()
    assert.equal(run.status, 'partial', '半边缺失不能记成 succeeded')
    assert.equal(run.errorMessage, '只有维度数据，逐日数据为空')
    assert.equal(run.dimensionRows, 1)

    /*
     * partial 也要更新 lastCollectedAt：这次确实采到了东西。把它排除在外会让
     * 一次半截采集把店铺推回「待接入」，比记成成功更误导。
     */
    const shop = await prisma.ecomShop.findUnique({
      where: { code: SHOP_CODE },
      select: { lastCollectedAt: true },
    })
    assert.ok(shop?.lastCollectedAt !== null, 'partial 也代表采到了数据，应更新时间')
  })

  test('只有逐日、维度为空 → partial', async () => {
    const result = await ingestOpsSnapshot(payload({ dimensions: [] }))
    assert.equal(result.ok, true)

    const run = await latestRun()
    assert.equal(run.status, 'partial')
    assert.equal(run.errorMessage, '只有逐日数据，维度数据为空')
  })

  test('逐日与维度都为空 → failed，且不更新采集时间', async () => {
    // 先造一次成功入库，把 lastCollectedAt 填上，才能观察「失败不更新」。
    await ingestOpsSnapshot(payload({}))
    const beforeShop = await prisma.ecomShop.findUnique({
      where: { code: SHOP_CODE },
      select: { lastCollectedAt: true },
    })
    assert.ok(beforeShop?.lastCollectedAt !== null && beforeShop?.lastCollectedAt !== undefined)

    await new Promise((resolve) => setTimeout(resolve, 20))

    const result = await ingestOpsSnapshot(payload({ daily: [], dimensions: [] }))
    assert.equal(result.ok, true)

    const run = await latestRun()
    assert.equal(run.status, 'failed')
    assert.equal(run.errorMessage, '上报内容为空')

    const afterRun = await prisma.ecomShop.findUnique({
      where: { code: SHOP_CODE },
      select: { lastCollectedAt: true },
    })
    assert.deepEqual(
      afterRun?.lastCollectedAt,
      beforeShop?.lastCollectedAt,
      '空批次不该把采集时间往前推',
    )
  })

  test('两侧都有 → succeeded，且同值重跑 revisedDays 为 0', async () => {
    const first = await ingestOpsSnapshot(payload({}))
    assert.equal(first.ok, true)
    assert.equal((await latestRun()).status, 'succeeded')

    /*
     * 幂等：同一份 payload 再跑一次，`revised` 必须为 0。若实现写成「只要写就
     * 算改写」，平台回溯改数这件事就再也看不出来了 —— 每天都是「有改动」。
     */
    const second = await ingestOpsSnapshot(payload({}))
    assert.equal(second.ok, true)
    assert.equal(second.ok && second.data.revisedDays, 0, '值没变，不该记成改写')

    const changed = await ingestOpsSnapshot(
      payload({
        daily: [
          {
            date: '2026-10-01',
            payAmountFen: 999_999,
            visitors: 10,
            payBuyers: 1,
            itemVisitors: 9,
          },
        ],
      }),
    )
    assert.equal(changed.ok, true)
    assert.equal(changed.ok && changed.data.revisedDays, 1, '金额变了，应记 1 天改写')
  })
})
