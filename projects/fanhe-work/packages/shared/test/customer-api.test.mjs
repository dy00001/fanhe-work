/**
 * 客户接口契约的回归测试。
 *
 * 只测两件事：金额裁剪与订单初始环节。两件都属于「写错了界面上看不出来」的那类：
 *
 *   - 裁剪写反 → 所有人看得到金额（或者所有人都看不到）。前者是越权，后者更隐蔽，
 *     因为页面照常渲染，只是金额列空着，看起来像「还没录」。
 *   - 初始环节写错 → 新单凭空多出几个已完成的环节，进度条一上来就走到一半。
 *
 * 与其余测试文件一样跑 `dist`，不跑源码。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CUSTOMER_LIMITS,
  ORDER_STAGE_COUNT,
  ORDER_STAGE_DEFS,
  buildInitialSteps,
  computeOrderSettlement,
  maskContractTotal,
  maskOrderAmounts,
  ownerFilterValue,
  parseOwnerFilter,
  summarizeOrderAmounts,
} from '../dist/index.js'

const AMOUNTS = {
  contractFen: 16_800_000,
  depositFen: 3_000_000,
  prepayFen: 5_000_000,
  finalReceivedFen: 8_800_000,
  feeFen: 0,
  receivedFen: 16_800_000,
  unpaidFen: 0,
}

test('看不到金额时整个 amounts 为 null，而不是三个 null 字段', () => {
  // **这条是反例测试的意义所在。** 若实现改成 `return {contractFen: null, ...}`，
  // 界面会把它渲染成「未录入」，与「没权限」长得一模一样 —— 于是有人去查录入流程，
  // 而真正的原因是权限。断言整个对象为 null，才把这两种情形分开。
  assert.equal(maskOrderAmounts(AMOUNTS, false), null)
})

test('看得到金额时原样返回，0 不被当成空值', () => {
  const masked = maskOrderAmounts(AMOUNTS, true)
  assert.deepEqual(masked, AMOUNTS)
  // 手续费录成 0 是真实状态（这单没手续费），不能被写成 null 让它看起来像没录。
  assert.equal(masked.feeFen, 0)
  assert.notEqual(masked.feeFen, null)
  // 七个字段一个不少：漏一个的表现是「界面上那个格子永远显示未录入」。
  assert.deepEqual(Object.keys(masked).sort(), [
    'contractFen',
    'depositFen',
    'feeFen',
    'finalReceivedFen',
    'prepayFen',
    'receivedFen',
    'unpaidFen',
  ])
})

test('未录入的金额保持 null，不被裁剪成 0', () => {
  // 「没录」与「录了 0」是两件事。前者要人去补，后者是事实。把 null 折成 0 会让
  // 欠款统计凭空少掉一笔，而界面上看不出任何异常。
  const empty = {
    contractFen: null,
    depositFen: null,
    prepayFen: null,
    finalReceivedFen: null,
    feeFen: null,
    receivedFen: null,
    unpaidFen: null,
  }
  assert.deepEqual(maskOrderAmounts(empty, true), empty)
})

test('客户级汇总同理：无权限时为 null，有权限时连 null 原样传递', () => {
  assert.equal(maskContractTotal(79366300, false), null)
  assert.equal(maskContractTotal(79366300, true), 79366300)
  // 汇总为 null（所有订单都没录）与无权限在裁剪后都是 null，但路由层另发
  // `financeReadable` 布尔值区分，前端不靠值猜。
  assert.equal(maskContractTotal(null, true), null)
})

test('新建订单的环节为十四环，序号连续且全部未到达', () => {
  const steps = buildInitialSteps()
  assert.equal(steps.length, ORDER_STAGE_COUNT)
  assert.equal(steps.length, 14)
  assert.deepEqual(
    steps.map((step) => step.idx),
    Array.from({ length: ORDER_STAGE_COUNT }, (_, index) => index + 1),
  )
  for (const step of steps) {
    assert.equal(step.reached, false, `${step.name} 不该一上来就是已到达`)
    assert.equal(step.done, false, `${step.name} 不该一上来就是已完成`)
  }
})

test('环节名称取自模板，不另写一份文案', () => {
  // 两份定义迟早不一致，而不一致的表现是「同样的第 11 环在两个页面叫不同名字」。
  assert.deepEqual(
    buildInitialSteps().map((step) => step.name),
    ORDER_STAGE_DEFS.map((def) => def.label),
  )
})

test('订单编号前缀与看板编号不撞', () => {
  // 看板编号是 BT-01 / TW-03 这类两字母加序号。人工录入若也用两字母前缀，
  // 某天会撞上，而唯一约束会让那条插入直接失败。
  assert.equal(CUSTOMER_LIMITS.ORDER_CODE_PREFIX, 'ORD-')
  assert.ok(!/^[A-Z]{2}-$/.test(CUSTOMER_LIMITS.ORDER_CODE_PREFIX))
})

// ---------------------------------------------------------------------------
// 结算公式
// ---------------------------------------------------------------------------

test('未收尾款 = 合同 − 定金 − 预付款 − 已收尾款', () => {
  const result = computeOrderSettlement({
    contractFen: 1_000_000,
    depositFen: 100_000,
    prepayFen: 200_000,
    finalReceivedFen: 300_000,
    feeFen: 5_000,
  })
  assert.equal(result.unpaidFen, 400_000)
})

test('实收金额 = 定金 + 预付款 + 已收尾款 − 手续费', () => {
  const result = computeOrderSettlement({
    contractFen: 1_000_000,
    depositFen: 100_000,
    prepayFen: 200_000,
    finalReceivedFen: 300_000,
    feeFen: 5_000,
  })
  // 手续费从实收里扣，不进未收：它是「到手少了」而不是「客户还欠着」。
  assert.equal(result.receivedFen, 595_000)
})

test('合同没录时未收尾款是 null，不是负数', () => {
  // 按 0 算会得出「欠款 = −定金」这种荒谬的负数，而界面上只看数字看不出是没录合同。
  const result = computeOrderSettlement({
    contractFen: null,
    depositFen: 100_000,
    prepayFen: null,
    finalReceivedFen: null,
    feeFen: null,
  })
  assert.equal(result.unpaidFen, null)
  // 实收仍然算得出来：录了定金就是收到了定金。
  assert.equal(result.receivedFen, 100_000)
})

test('五项全空时实收是 null，不是 0', () => {
  const result = computeOrderSettlement({
    contractFen: null,
    depositFen: null,
    prepayFen: null,
    finalReceivedFen: null,
    feeFen: null,
  })
  assert.equal(result.receivedFen, null)
  assert.equal(result.unpaidFen, null)
})

test('只填合同额时未收等于合同额', () => {
  // 人工新建订单只填合同额是常态。此时未收若显示「未录入」，会被当成功能没做完。
  const result = computeOrderSettlement({
    contractFen: 1_000_000,
    depositFen: null,
    prepayFen: null,
    finalReceivedFen: null,
    feeFen: null,
  })
  assert.equal(result.unpaidFen, 1_000_000)
  // 但一分钱都没收过时实收仍是 null：0 与「没录」在账上是两件事。
  assert.equal(result.receivedFen, null)
})

test('超收时未收尾款为负，不被截断成 0', () => {
  // 多收、重复记账、退款没记账都会算出负数。截成 0 会把问题藏起来。
  const result = computeOrderSettlement({
    contractFen: 100_000,
    depositFen: 60_000,
    prepayFen: 60_000,
    finalReceivedFen: null,
    feeFen: null,
  })
  assert.equal(result.unpaidFen, -20_000)
})

// ---------------------------------------------------------------------------
// 归属筛选取值
// ---------------------------------------------------------------------------

test('归属取值编码后再解析回到同一个人', () => {
  const id = '2f5c1a9e-1111-4222-8333-444455556666'
  assert.deepEqual(parseOwnerFilter(ownerFilterValue('designer', id)), {
    kind: 'member',
    role: 'designer',
    userId: id,
  })
  assert.deepEqual(parseOwnerFilter(ownerFilterValue('sales', id)), {
    kind: 'member',
    role: 'sales',
    userId: id,
  })
})

test('两个固定档与空值', () => {
  assert.deepEqual(parseOwnerFilter('mine'), { kind: 'mine' })
  assert.deepEqual(parseOwnerFilter('unassigned'), { kind: 'unassigned' })
  assert.deepEqual(parseOwnerFilter(''), { kind: 'all' })
  assert.deepEqual(parseOwnerFilter(null), { kind: 'all' })
})

test('非法归属值回到全部，不抛错也不筛出空表', () => {
  // 地址栏可以手改。回一个 400 会让整页看起来坏了，而意图只是「筛选没生效」。
  assert.deepEqual(parseOwnerFilter('dseigner:abc'), { kind: 'all' })
  assert.deepEqual(parseOwnerFilter('designer:'), { kind: 'all' })
  // 角色必须是已知的两种，不能被当成任意前缀。
  assert.deepEqual(parseOwnerFilter('owner:abc'), { kind: 'all' })
})

/*
 * 客户级金额合计。
 *
 * 这里的风险不是算错一个加法，而是「算错了还看不出来」：有一单缺合同时，未收尾款
 * 会少算一大截，界面上却只是一个偏小的正常数字。
 */

const ORDER_A = {
  contractFen: 10_000_000,
  depositFen: 2_000_000,
  prepayFen: 1_000_000,
  finalReceivedFen: 3_000_000,
  feeFen: 100_000,
  receivedFen: 5_900_000,
  unpaidFen: 4_000_000,
}

const ORDER_B = {
  contractFen: 5_000_000,
  depositFen: 1_000_000,
  prepayFen: null,
  finalReceivedFen: 2_000_000,
  feeFen: null,
  receivedFen: 3_000_000,
  unpaidFen: 2_000_000,
}

const BLANK_AMOUNTS = {
  contractFen: null,
  depositFen: null,
  prepayFen: null,
  finalReceivedFen: null,
  feeFen: null,
  receivedFen: null,
  unpaidFen: null,
}

test('多单七项各自相加', () => {
  const summary = summarizeOrderAmounts([ORDER_A, ORDER_B])
  assert.equal(summary.orderCount, 2)
  assert.equal(summary.hiddenCount, 0)
  assert.equal(summary.missingContractCount, 0)
  assert.deepEqual(summary.amounts, {
    contractFen: 15_000_000,
    depositFen: 3_000_000,
    prepayFen: 1_000_000,
    finalReceivedFen: 5_000_000,
    feeFen: 100_000,
    receivedFen: 8_900_000,
    unpaidFen: 6_000_000,
  })
})

test('没有订单时七项全 null，合计不是 0', () => {
  // 「一单都没录」和「合计为零」是两件事。折成 0 会让「这客户还没记账」看起来像
  // 「钱都结清了」。
  const summary = summarizeOrderAmounts([])
  assert.equal(summary.orderCount, 0)
  assert.deepEqual(summary.amounts, BLANK_AMOUNTS)
})

test('缺合同的那一单不进未收尾款，其余项照算', () => {
  const noContract = { ...ORDER_B, contractFen: null, unpaidFen: null }
  const summary = summarizeOrderAmounts([ORDER_A, noContract])

  assert.equal(summary.amounts.contractFen, 10_000_000)
  // 定金两单都录了，照加。
  assert.equal(summary.amounts.depositFen, 3_000_000)

  // 未收尾款只算 A 的 400 万。若改成「先合手填五项再调 computeOrderSettlement」，
  // 会拿 A 的合同减掉两单的收款，得 100 万 —— 少算 300 万，且界面上看不出错。
  assert.equal(summary.amounts.unpaidFen, 4_000_000)
  assert.equal(summary.missingContractCount, 1)
})

test('看不到金额的订单只计数，不进合计', () => {
  const summary = summarizeOrderAmounts([ORDER_A, null])
  assert.equal(summary.orderCount, 1)
  assert.equal(summary.hiddenCount, 1)
  assert.equal(summary.amounts.contractFen, ORDER_A.contractFen)
})

test('全空订单计入单数但不改变合计', () => {
  const summary = summarizeOrderAmounts([ORDER_A, BLANK_AMOUNTS])
  assert.equal(summary.orderCount, 2)
  assert.equal(summary.amounts.contractFen, ORDER_A.contractFen)
  assert.equal(summary.amounts.receivedFen, ORDER_A.receivedFen)
  // 它确实没录合同，如实报一单，让界面能提示「未收尾款没算全」。
  assert.equal(summary.missingContractCount, 1)
})

test('派生两项按手填五项重算，不照抄传入的派生值', () => {
  // 汇总只信手填五项。若某张单的 received_fen 是历史遗留的错值，跟着它加会把错
  // 放大到客户级 —— 而客户级数字正是签合同、对账时看的那个。
  const stale = { ...ORDER_A, receivedFen: 0, unpaidFen: 0 }
  const summary = summarizeOrderAmounts([stale])
  assert.equal(summary.amounts.receivedFen, 5_900_000)
  assert.equal(summary.amounts.unpaidFen, 4_000_000)
})

test('合计保留负的未收尾款，不截断', () => {
  // 合同 3 万却收了 6 万，这一单未收尾款是 −300 万。与 A 的 +400 万相抵后净欠
  // 100 万；若把负数截成 0，合计会报成 400 万。
  const overpaid = { ...ORDER_A, contractFen: 3_000_000 }
  const summary = summarizeOrderAmounts([ORDER_A, overpaid])
  assert.equal(summary.amounts.unpaidFen, 1_000_000)
})
