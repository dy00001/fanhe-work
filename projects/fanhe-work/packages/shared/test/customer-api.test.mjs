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
  maskContractTotal,
  maskOrderAmounts,
} from '../dist/index.js'

const AMOUNTS = { contractFen: 16800000, receivedFen: 0, unpaidFen: 16800000 }

test('看不到金额时整个 amounts 为 null，而不是三个 null 字段', () => {
  // **这条是反例测试的意义所在。** 若实现改成 `return {contractFen: null, ...}`，
  // 界面会把它渲染成「未录入」，与「没权限」长得一模一样 —— 于是有人去查录入流程，
  // 而真正的原因是权限。断言整个对象为 null，才把这两种情形分开。
  assert.equal(maskOrderAmounts(AMOUNTS, false), null)
})

test('看得到金额时原样返回，0 不被当成空值', () => {
  const masked = maskOrderAmounts(AMOUNTS, true)
  assert.deepEqual(masked, AMOUNTS)
  // 已收 0 元是真实状态（合同签了、钱还没到），不能被写成 null 让它看起来像没录。
  assert.equal(masked.receivedFen, 0)
  assert.notEqual(masked.receivedFen, null)
})

test('未录入的金额保持 null，不被裁剪成 0', () => {
  // 「没录」与「录了 0」是两件事。前者要人去补，后者是事实。把 null 折成 0 会让
  // 欠款统计凭空少掉一笔，而界面上看不出任何异常。
  const empty = { contractFen: null, receivedFen: null, unpaidFen: null }
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
