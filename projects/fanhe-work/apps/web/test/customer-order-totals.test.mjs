/**
 * 客户级订单金额合计（单客户详情里那块「N 单合计」）。
 *
 * 这些断言守的不是渲染样式，而是**汇总与明细必须是同一套口径**。另一种写法很自然：
 * 在组件里把七个数各加一遍、再另起一份字段表。它能渲染出看起来完全正确的界面，
 * 但结算规则一旦调整（比如手续费改成计入合同），只有一处会跟着变，而两个数字都
 * 长得像对的，没人能从界面上看出矛盾。
 *
 * 所以这里钉住三件事：合计走契约函数、字段表复用明细那张、一单时不重复显示。
 * 四道门禁都拦不住这类退化 —— 类型对、lint 过、纯函数测试也不覆盖组件内部。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../src/pages/CustomerPage.tsx', import.meta.url), 'utf8')

/** 截出汇总组件的函数体，避免断言落到同文件里 OrderCard 的相似代码上。 */
const TOTALS_BODY = (() => {
  const start = SOURCE.indexOf('function OrderAmountTotals')
  assert.notEqual(start, -1, '找不到 OrderAmountTotals：汇总行被删了或改名了')
  const end = SOURCE.indexOf('function OrderCard', start)
  assert.notEqual(end, -1, '找不到 OrderCard：截取范围失效，下面的断言会失去意义')
  return SOURCE.slice(start, end)
})()

test('合计调契约函数，不自己加那七个数', () => {
  assert.match(
    TOTALS_BODY,
    /summarizeOrderAmounts\(/,
    '汇总行没有调 summarizeOrderAmounts。自己在这里累加会与订单卡片使用两套口径。',
  )
  // 手算的痕迹：拿某个金额字段做加减。出现了就说明又写了一份结算规则。
  assert.doesNotMatch(
    TOTALS_BODY,
    /(contractFen|depositFen|prepayFen|finalReceivedFen|feeFen|receivedFen|unpaidFen)\s*[-+]/,
    '汇总行里出现了对金额字段的直接加减。派生口径只能来自 summarizeOrderAmounts。',
  )
})

test('七个格子复用明细那张字段表', () => {
  assert.match(
    TOTALS_BODY,
    /ORDER_AMOUNT_FIELDS\.map\(/,
    '汇总行没有复用 ORDER_AMOUNT_FIELDS，另起字段表会让两处的标签或顺序悄悄分叉。',
  )
})

test('只有一单时不显示合计', () => {
  // 一单的合计就是那张卡片本身，再列一遍是把同样的数字印两次。
  assert.match(
    TOTALS_BODY,
    /orders\.length\s*<\s*2/,
    '汇总行少了「一单不显示」的判断，单订单客户会看到一块重复的数字。',
  )
})
