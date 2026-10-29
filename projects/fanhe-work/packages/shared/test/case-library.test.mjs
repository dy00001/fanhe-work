/**
 * 案例库规则的单元测试。
 *
 * 这里钉的是「前后端必须一致」的那几条：品类 id 取值域、文件夹名的归一与长度、
 * 图片 id 与品类的从属判断。它们全都同时被表单与服务端使用，两边规则一旦分叉，
 * 表现是「表单说可以，提交后 400」—— 用户看不出自己哪里做错了。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  CASE_CATEGORY_IDS,
  CASE_LIBRARY_LIMITS,
  caseItemIdBelongsTo,
  isCaseCategoryId,
  isValidCaseFolderName,
  normalizeCaseFolderName,
} from '../dist/index.js'

test('品类 id 清单固定为十三个，顺序即界面顺序', () => {
  assert.equal(CASE_CATEGORY_IDS.length, 13)
  assert.deepEqual(CASE_CATEGORY_IDS.slice(0, 3), ['cabinet', 'wardrobe', 'bookcase'])
  assert.equal(CASE_CATEGORY_IDS.at(-1), 'aluminum-wood-cabinet')
})

test('isCaseCategoryId 只认清单里的值', () => {
  assert.equal(isCaseCategoryId('cabinet'), true)
  assert.equal(isCaseCategoryId('aluminum-wood-cabinet'), true)
  // 反向：大小写不同、带空格、空串、以及一个不存在的品类都要被拒。
  assert.equal(isCaseCategoryId('Cabinet'), false)
  assert.equal(isCaseCategoryId(' cabinet'), false)
  assert.equal(isCaseCategoryId(''), false)
  assert.equal(isCaseCategoryId('bedroom'), false)
})

test('文件夹名归一：去首尾空白、压缩中间连续空白', () => {
  assert.equal(normalizeCaseFolderName('  主卧 衣柜  '), '主卧 衣柜')
  assert.equal(normalizeCaseFolderName('主卧\t\t衣柜'), '主卧 衣柜')
  // 不做大小写折叠：英文名的大小写是用户的区分手段。
  assert.equal(normalizeCaseFolderName('Living'), 'Living')
})

test('文件夹名合法性与长度上限，按归一后的值判断', () => {
  assert.equal(isValidCaseFolderName('客厅'), true)
  assert.equal(isValidCaseFolderName('   '), false)
  assert.equal(isValidCaseFolderName(''), false)
  assert.equal(isValidCaseFolderName('柜'.repeat(CASE_LIBRARY_LIMITS.FOLDER_NAME_MAX)), true)
  assert.equal(isValidCaseFolderName('柜'.repeat(CASE_LIBRARY_LIMITS.FOLDER_NAME_MAX + 1)), false)
})

test('图片 id 的品类归属靠前缀判断', () => {
  assert.equal(caseItemIdBelongsTo('cabinet-3', 'cabinet'), true)
  assert.equal(caseItemIdBelongsTo('cabinet-cover', 'cabinet'), true)
  // 反向：跨品类、以及只是前缀相同的另一个品类。
  assert.equal(caseItemIdBelongsTo('wardrobe-3', 'cabinet'), false)
  assert.equal(caseItemIdBelongsTo('cabinet-3', 'cab'), false)
  assert.equal(caseItemIdBelongsTo('cabinet', 'cabinet'), false)
})
