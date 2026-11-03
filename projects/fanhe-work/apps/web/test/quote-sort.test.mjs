/**
 * 拖动排序的落点算术。
 *
 * 这一块**只能**在这里钉：下标算术在组件里要靠手点去验，而手点只会点「往后拖一格」
 * 这一条路径。真正出错的两处都不会报错，只会「差一位」：
 *
 *   - 移除拖动项之后，落在其后的插入位要左移一格（否则往下拖永远少一格）；
 *   - 落在目标行上半 / 下半是两个不同的插入位（只按行算的话，相邻换位要拖两次）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applyDrop, isAfterMidpoint, sameOrder } from '../src/lib/quote-sort.ts'

const A = 'a'
const B = 'b'
const C = 'c'
const D = 'd'

test('往下的拖动：落点在移除之后，插入位要左移一格', () => {
  const list = [A, B, C, D]
  // 把 a 拖到 c 的上半 = 插到 c 前面 = b 前面。
  assert.deepEqual(applyDrop(list, { from: 0, over: 2, after: false }), [B, A, C, D])
  // 把 a 拖到 c 的下半 = 插到 c 后面。
  assert.deepEqual(applyDrop(list, { from: 0, over: 2, after: true }), [B, C, A, D])
  // 拖到最后一行下面 = 追加到末尾。
  assert.deepEqual(applyDrop(list, { from: 0, over: 3, after: true }), [B, C, D, A])
})

test('往上的拖动：插入位不需要补偿', () => {
  const list = [A, B, C, D]
  assert.deepEqual(applyDrop(list, { from: 3, over: 1, after: false }), [A, D, B, C])
  assert.deepEqual(applyDrop(list, { from: 2, over: 0, after: false }), [C, A, B, D])
  // 拖到第一行的下半 = 插在第一行后面（这一格不补偿会让它跑到最前）。
  assert.deepEqual(applyDrop(list, { from: 2, over: 0, after: true }), [A, C, B, D])
})

test('原地松手是空操作，且不改入参', () => {
  const list = [A, B, C]
  for (const after of [false, true]) {
    assert.deepEqual(applyDrop(list, { from: 1, over: 1, after }), [A, B, C])
  }
  // 越界也不该抛：拖动过程中列表可能因为一次刷新变短了。
  assert.deepEqual(applyDrop(list, { from: 0, over: 9, after: false }), [A, B, C])
  assert.deepEqual(applyDrop(list, { from: -1, over: 0, after: false }), [A, B, C])

  const input = [A, B, C]
  applyDrop(input, { from: 0, over: 2, after: true })
  assert.deepEqual(input, [A, B, C], 'applyDrop 不能就地修改传进来的数组')
})

test('相邻换位：上半 = 插到它前面，下半 = 插到它后面', () => {
  const list = [A, B, C]
  assert.deepEqual(applyDrop(list, { from: 1, over: 0, after: false }), [B, A, C])
  assert.deepEqual(applyDrop(list, { from: 0, over: 1, after: true }), [B, A, C])
  assert.deepEqual(applyDrop(list, { from: 1, over: 2, after: false }), [A, B, C])
  assert.deepEqual(applyDrop(list, { from: 1, over: 2, after: true }), [A, C, B])
})

test('上下半的判据是半高，不是固定像素', () => {
  // 行高 40：y=19 算上半、y=21 算下半。
  assert.equal(isAfterMidpoint(100, 40, 119), false)
  assert.equal(isAfterMidpoint(100, 40, 121), true)
  // 行高 80 时同一个绝对位置仍然是上半 —— 用固定阈值（比如 20px）的话
  // 高行（产品行有两行文字）会有整个下半区都被判成「前面」。
  assert.equal(isAfterMidpoint(100, 80, 119), false)
})

test('顺序比较：用来省掉原地松手的那次请求', () => {
  assert.equal(sameOrder([A, B], [A, B]), true)
  assert.equal(sameOrder([A, B], [B, A]), false)
  assert.equal(sameOrder([A], [A, B]), false)
  assert.equal(sameOrder([], []), true)
})
