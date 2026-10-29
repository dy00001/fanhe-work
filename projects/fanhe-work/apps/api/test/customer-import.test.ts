/**
 * 批量导入的测试。
 *
 * 导入这条路径最容易出两类错，两类都不会报错：
 *
 *   1. **来源字段被覆盖。** 导入若走 `createCustomer`，51 条待复核会全部变成
 *      「已确认 / 高置信」，复核队列空掉，而界面上一切正常。
 *   2. **金额换算出错。** 预览里的金额是**元**，库里是**分**；`received: 0`
 *      是真实值（问过价没打款），一旦写成「未录入」，用户看到的差别只是
 *      少了一行数字而已。
 *
 * 另外三条是纯函数：`yuanToFen`、`parseLogTime`、以及幂等（重跑必须全部跳过）。
 *
 * 数据统一用 `zz_test_import_` 前缀的 chatroom 与 `ZZTEST-` 前缀的编号，结束时级联删除。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { ORDER_STAGE_COUNT } from '@fanhe/shared'

import { resolveTestDatabaseUrl } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

/* 动态导入，理由见 `customer.test.ts` 顶部那段：静态导入会先求值 `env.ts`，
   而那时 `DATABASE_URL` 还没被覆盖。 */
const { prisma } = await import('../src/db/prisma.js')
const { createCustomer, createOrder, getCustomer, insertCustomer } =
  await import('../src/customer/customers.js')
const { importPreview, parseLogTime, yuanToFen } = await import('../src/customer/import.js')

const PREFIX = 'zz_test_import_'
const CODE_PREFIX = 'ZZTEST-'

/** 导入用的来源标记：全部「不确定」，与人工录入相反。 */
const IMPORTED_ORIGIN = {
  nameSource: 'welcome:P2',
  confidence: 'medium',
  reviewStatus: 'pending',
  stageSource: 'ai_stage',
}

describe('导入的纯函数', () => {
  test('元转分：null 保持「未录入」，0 是真实值', () => {
    assert.equal(yuanToFen(null), undefined)
    // 0 元必须是 0 分，不能和 null 一样变成 undefined：问过价没打款是事实。
    assert.equal(yuanToFen(0), 0)
    assert.equal(yuanToFen(37800), 3780000)
    assert.equal(yuanToFen(18151), 1815100)
  })

  test('聊天时间戳解析成本地时间，解析不了给 null 而不是抛错', () => {
    const parsed = parseLogTime('2023-08-14 15:29')
    assert.notEqual(parsed, null)
    assert.equal(parsed?.getHours(), 15)
    assert.equal(parsed?.getMinutes(), 29)
    assert.equal(parseLogTime(''), null)
    assert.equal(parseLogTime(null), null)
    assert.equal(parseLogTime('不是时间'), null)
  })
})

describe('批量导入', { skip: databaseUrl === null ? '数据库不可达' : false }, () => {
  before(async () => {
    await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })
    await prisma.customerOrder.deleteMany({ where: { code: { startsWith: CODE_PREFIX } } })
  })

  after(async () => {
    await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })
    await prisma.customerOrder.deleteMany({ where: { code: { startsWith: CODE_PREFIX } } })
  })

  test('导入的客户保留 pending / medium / 原始 nameSource，不被改成「已确认」', async () => {
    const result = await insertCustomer(
      {
        chatroom: `${PREFIX}origin`,
        realName: '测试甲',
        region: '包头',
        stage: 'quoted',
      },
      IMPORTED_ORIGIN,
      { msgRows: 321, skipImg: 12, skipVoice: 3, groupFile: '测试群.md' },
    )
    assert.equal(result.ok, true)
    if (!result.ok) return

    const row = await prisma.customer.findUnique({
      where: { id: result.data.id },
      select: {
        reviewStatus: true,
        confidence: true,
        nameSource: true,
        stageSource: true,
        stage: true,
        msgRows: true,
        skipImg: true,
        skipVoice: true,
      },
    })
    assert.equal(row?.reviewStatus, 'pending')
    assert.equal(row?.confidence, 'medium')
    assert.equal(row?.nameSource, 'welcome:P2')
    assert.equal(row?.stageSource, 'ai_stage')
    // 阶段本身照数据落库，不因为「来源是 ai」而退回 consulting。
    assert.equal(row?.stage, 'quoted')
    assert.equal(row?.msgRows, 321)
    assert.equal(row?.skipImg, 12)
  })

  test('人工录入与导入算出同一份显示名 —— 两条路径共用一套派生', async () => {
    const manual = await createCustomer({
      chatroom: `${PREFIX}same_manual`,
      realName: '测试乙',
      region: '中国台湾',
    })
    const imported = await insertCustomer(
      { chatroom: `${PREFIX}same_imported`, realName: '测试乙', region: '中国台湾' },
      IMPORTED_ORIGIN,
    )
    assert.equal(manual.ok, true)
    assert.equal(imported.ok, true)
    if (!manual.ok || !imported.ok) return

    assert.equal(manual.data.displayName, imported.data.displayName)
    assert.equal(manual.data.shortName, imported.data.shortName)
    // 唯一该不同的地方就是来源。
    assert.equal(manual.data.reviewStatus, 'confirmed')
    assert.equal(imported.data.reviewStatus, 'pending')
  })

  test('订单历史明细：指定编号与序号，只覆盖给出的环节，done 连带 reached', async () => {
    const customer = await createCustomer({
      chatroom: `${PREFIX}order`,
      realName: '测试丙',
      region: '成都',
    })
    assert.equal(customer.ok, true)
    if (!customer.ok) return

    const order = await createOrder(customer.data.id, { contractFen: 1815100 }, true, {
      code: `${CODE_PREFIX}01`,
      seq: 1,
      stage: 'producing',
      stageSource: 'board',
      amountSource: 'board-evidence',
      amountConfidence: 'high',
      amountEvidenceDate: '2023-08-24',
      steps: [
        // 只给「已完成」不给 reached：服务层必须补上，否则界面显示「未到达但已完成」。
        { idx: 1, reached: false, done: true, startedAt: '2023-08-20', finishedAt: '2023-08-24' },
        { idx: 2, reached: true, done: false, note: '进行中' },
      ],
    })
    assert.equal(order.ok, true)
    if (!order.ok) return

    const created = order.data.orders.find((item) => item.code === `${CODE_PREFIX}01`)
    assert.notEqual(created, undefined)
    assert.equal(created?.seq, 1)
    assert.equal(created?.stage, 'producing')
    assert.equal(created?.stageSource, 'board')
    assert.equal(created?.amountSource, 'board-evidence')
    assert.equal(created?.amountEvidenceDate, '2023-08-24')
    // 分母仍是十四环：只给两环明细不等于「这个订单只有两个环节」。
    assert.equal(created?.steps.length, ORDER_STAGE_COUNT)

    const first = created?.steps.find((step) => step.idx === 1)
    assert.equal(first?.done, true)
    assert.equal(first?.reached, true)
    assert.equal(first?.startedAt, '2023-08-20')
    assert.equal(first?.finishedAt, '2023-08-24')

    const second = created?.steps.find((step) => step.idx === 2)
    assert.equal(second?.reached, true)
    assert.equal(second?.done, false)
    assert.equal(second?.note, '进行中')

    // 没给明细的环节保持模板状态。
    const third = created?.steps.find((step) => step.idx === 3)
    assert.equal(third?.reached, false)
    assert.equal(third?.done, false)

    // 客户级合同额是派生列，导入也要重算，否则列表上的合计是空的。
    const detail = await getCustomer(customer.data.id, true)
    assert.equal(detail.ok, true)
    if (!detail.ok) return
    assert.equal(detail.data.contractTotalFen, 1815100)
  })

  test('同一份预览跑两遍：第二遍全部跳过，订单不会重复建', async () => {
    const preview = {
      generatedAt: '2026-10-29T00:00:00.000Z',
      customers: [
        {
          chatroom: `${PREFIX}idem`,
          customerName: '测试丁',
          region: '保定',
          phone: '13800000000',
          nameSource: 'groupname',
          primaryNickname: 'tester',
          confidence: 'low',
          reviewStatus: 'pending',
          repeatOf: null,
          project: null,
          groupFile: '幂等测试.md',
          msgRows: 10,
          firstMessageAt: '2024-01-02 09:10',
          lastMessageAt: '2024-02-03 11:12',
          skipImg: 1,
          skipVoice: 0,
          stage: 'consulting',
          stageSource: 'ai_stage',
        },
      ],
      orders: [
        {
          code: `${CODE_PREFIX}IDEM`,
          chatroom: `${PREFIX}idem`,
          displayName: '保定测试丁',
          seq: 1,
          isRepeat: false,
          stage: 'consulting',
          stageSource: 'ai_stage',
          steps: [],
          amount: {
            contract: null,
            received: 0,
            unpaid: null,
            source: 'cleared',
            confidence: 'none',
            evidenceDate: null,
            evidenceNote: null,
          },
        },
      ],
    }

    const first = await importPreview(preview)
    assert.equal(first.customers.created, 1)
    assert.equal(first.orders.created, 1)
    assert.equal(first.issues.length, 0)

    const second = await importPreview(preview)
    assert.equal(second.customers.created, 0)
    assert.equal(second.customers.skipped, 1)
    assert.equal(second.orders.created, 0)
    assert.equal(second.orders.skipped, 1)

    // `received: 0` 必须落成 0 分，而不是「未录入」。
    const order = await prisma.customerOrder.findUnique({
      where: { code: `${CODE_PREFIX}IDEM` },
      select: { receivedFen: true, contractFen: true, steps: { select: { idx: true } } },
    })
    assert.equal(order?.receivedFen, 0)
    assert.equal(order?.contractFen, null)
    assert.equal(order?.steps.length, ORDER_STAGE_COUNT)
  })
})
