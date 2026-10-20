/**
 * 案例清单的回归测试。
 *
 * 与其它前端测试同款：Node 内置测试器直接测源码，启用类型擦除即可。
 *
 * 这里钉的是「全部品类」窗口与首页横滑条共同依赖的那几条不变量：九个品类一个不少、
 * 顺序固定、id 唯一且是英文。界面本身（按钮开合、卡片布局）不在这里 —— 它要靠浏览器
 * 跑起来才判定得了。
 *
 * **这一版不带案例位。** 案例库尚未建立，弹窗与主页横滑条共用同一份 `CASE_CATEGORIES`，
 * `cases` 当前是空数组。等案例落库时再加关于 `CaseSlot` 的字段不变量测试 —— 那时这条
 * 总注释与文件头会一起更新。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CASE_CATEGORIES } from '../src/lib/case-catalog.ts'

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

/**
 * `id` 用英文是为了将来进 URL 与接口参数时不必再转一层拼音。
 * 中文 id 会让 `?category=橱柜` 这种参数走两次编码，调试日志也读不顺。
 */
const ID_PATTERN = /^[a-z][a-z0-9-]*$/

test('九个品类齐全且顺序固定', () => {
  assert.deepEqual(
    CASE_CATEGORIES.map((category) => category.name),
    EXPECTED_NAMES,
  )
})

test('品类 id 唯一且非空，且符合英文拼写约束', () => {
  const ids = CASE_CATEGORIES.map((category) => category.id)
  assert.equal(new Set(ids).size, ids.length)
  for (const id of ids) {
    assert.ok(id.length > 0, '品类 id 不能为空串')
    assert.match(id, ID_PATTERN, `品类 id 应为英文小写加连字符：${id}`)
  }
})

test('案例库尚未建立：每个品类的 cases 是空数组', () => {
  // 这一条是「当下的事实」，不是「永远的不变量」——案例库建立时会反过来断言长度 > 0
  // 并校验 CaseSlot 字段。这是先把它作为现状钉下来，等数据来了再切换断言方向。
  for (const category of CASE_CATEGORIES) {
    assert.ok(Array.isArray(category.cases), `${category.name} 的 cases 必须是数组`)
    assert.equal(category.cases.length, 0, `${category.name} 的案例库尚未建立`)
  }
})

test('name 没有前后空白', () => {
  for (const category of CASE_CATEGORIES) {
    assert.equal(category.name, category.name.trim(), `${category.name} 有前后空白`)
    assert.equal(category.name.length, [...category.name].length, `${category.name} 含隐式字符`)
  }
})
