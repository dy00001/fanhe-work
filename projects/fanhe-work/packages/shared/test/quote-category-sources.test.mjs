/**
 * 分类清单的来源过滤。
 *
 * 这一组存在的理由是：**过滤写反了界面上照样能用**。写成「只保留不认得的」时
 * 查价左栏显示的全是改不了的孤儿分类，而正常的分类一个都看不到 —— 没有报错，
 * 也没有空态提示，只有人去维护台找一个不存在的分类时才会发现。
 *
 * 第二条守的是另一种坏法：把「主类表为空」也当成「全部不认得」处理，筛选栏会
 * 整列空掉，看起来像整个报价库丢了。
 *
 * 与其余测试文件一样跑 `dist`，不跑源码。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { filterKnownCategorySources } from '../dist/index.js'

const ROWS = [
  { source: 'sale', name: '柜体门板', count: 33 },
  { source: 'csutsfh', name: 'zz_test_岩板台面', count: 1 },
  { source: 'hardware', name: '拉篮', count: 96 },
]

test('主类表非空时剔掉孤儿来源，认得的原样留下', () => {
  const known = new Set(['sale', 'craft', 'hardware'])
  const visible = filterKnownCategorySources(ROWS, known)

  assert.deepEqual(
    visible.map((row) => row.name),
    ['柜体门板', '拉篮'],
    '孤儿来源既不该出现在筛选栏，也不该顺手改掉别的行的顺序',
  )
})

test('没有孤儿时内容一条不少、顺序不变', () => {
  const known = new Set(['sale', 'craft', 'hardware'])
  const all = [
    { source: 'sale', name: '柜体门板', count: 33 },
    { source: 'hardware', name: '拉篮', count: 96 },
  ]

  // 断言内容而不是引用：实现走的是 `filter`，全部命中时也会返回一个新数组。
  // 这里要守的是「不过滤掉认得的行」，不是「零分配」。
  assert.deepEqual(filterKnownCategorySources(all, known), all)
})

test('主类表为空时整列照常返回，不把筛选栏清空', () => {
  const visible = filterKnownCategorySources(ROWS, new Set())

  assert.equal(visible.length, 3, '主类表为空说明迁移没跑或表被清空，此时宁可多显示')
})

test('一行都没有时返回空数组，不抛错', () => {
  assert.deepEqual(filterKnownCategorySources([], new Set(['sale'])), [])
})
