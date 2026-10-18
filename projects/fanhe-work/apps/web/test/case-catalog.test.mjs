/**
 * 案例清单的回归测试。
 *
 * 与其它前端测试同款：Node 内置测试器直接测源码，启用类型擦除即可。
 *
 * 这里钉的是**「全部品类」窗口依赖的那几条不变量**：九个品类一个不少、顺序固定、
 * 每个品类都有案例位、筛选值认不出时退回全量。界面本身（按钮开合、筛选切换、滚动
 * 复位）不在这里 —— 它要靠浏览器跑起来才判定得了。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALL_CASE_CATEGORIES,
  CASE_CATEGORIES,
  countCaseSlots,
  filterCaseCategories,
} from '../src/lib/case-catalog.ts'

/** 原型里的九个品类，顺序即界面顺序。改动这一行等于改产品口径，必须是有意的。 */
const EXPECTED_NAMES = [
  '橱柜',
  '衣柜',
  '书柜',
  '鞋柜',
  '酒柜',
  '套装门',
  '电视柜',
  '餐边柜',
  '护墙板',
]

test('九个品类齐全且顺序固定', () => {
  assert.deepEqual(
    CASE_CATEGORIES.map((category) => category.name),
    EXPECTED_NAMES,
  )
})

test('品类 id 唯一且非空', () => {
  const ids = CASE_CATEGORIES.map((category) => category.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) assert.ok(id.length > 0, '品类 id 不能为空串')
})

test('每个品类都有案例位，案例 id 全局唯一', () => {
  const slotIds = []

  for (const category of CASE_CATEGORIES) {
    assert.ok(category.cases.length > 0, `${category.name} 没有案例位`)
    for (const slot of category.cases) {
      // 冗余存的 categoryId 必须与所属分组一致，否则将来按品类单查会漏。
      assert.equal(slot.categoryId, category.id)
      // 这一版没有案例内容：标题留空、封面为 null，界面据此显示占位而不是编一个名字。
      assert.equal(slot.title, '')
      assert.equal(slot.cover, null)
      slotIds.push(slot.id)
    }
  }

  assert.equal(new Set(slotIds).size, slotIds.length, '案例 id 出现重复')
})

test('案例总数由数据算出，等于九个品类各自的案例位之和', () => {
  const sum = CASE_CATEGORIES.reduce((total, category) => total + category.cases.length, 0)
  assert.equal(countCaseSlots(CASE_CATEGORIES), sum)
  assert.ok(sum > 0)
})

test('筛选「全部」返回全量', () => {
  const visible = filterCaseCategories(CASE_CATEGORIES, ALL_CASE_CATEGORIES)
  assert.equal(visible.length, CASE_CATEGORIES.length)
  assert.equal(countCaseSlots(visible), countCaseSlots(CASE_CATEGORIES))
})

test('筛选单个品类只返回那一组', () => {
  for (const category of CASE_CATEGORIES) {
    const visible = filterCaseCategories(CASE_CATEGORIES, category.id)
    assert.equal(visible.length, 1)
    assert.equal(visible[0].id, category.id)
    // 筛选后的计数必须跟着变小，否则窗口顶部那句「共 N 个案例位」会一直是全量。
    assert.equal(countCaseSlots(visible), category.cases.length)
  }
})

test('认不出的筛选值退回全量，而不是返回空列表', () => {
  const visible = filterCaseCategories(CASE_CATEGORIES, 'not-a-category')
  assert.equal(visible.length, CASE_CATEGORIES.length)
})
