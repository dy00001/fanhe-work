/**
 * 上传前压缩的纯逻辑测试。
 *
 * 这里只测 `fitWithin` —— 它是整条链路上唯一不依赖浏览器的判断，而它恰好是最容易
 * 「看起来对」的那一段：算错的后果是图片被拉变形或糊掉，两者的共同点是**没人会报 bug**，
 * 只会觉得「这图怎么不清楚」。
 *
 * `prepareUpload` 本身要 canvas 与 createImageBitmap，跑不了 Node；它的行为靠实机验证
 * （见 PR 说明里的手测清单）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { fitWithin, UPLOAD_FULL_EDGE, UPLOAD_THUMB_EDGE } from '../src/lib/case-upload.ts'

test('长边超限时按长边等比缩放', () => {
  assert.deepEqual(fitWithin(4000, 3000, 1600), { width: 1600, height: 1200 })
  // 竖图：长边是高度，缩放之后宽度跟着算。
  assert.deepEqual(fitWithin(3000, 4000, 1600), { width: 1200, height: 1600 })
})

test('没超限就不放大', () => {
  // 800px 的图放大到 1600 只会变糊，还多占一倍空间。
  assert.deepEqual(fitWithin(800, 600, 1600), { width: 800, height: 600 })
  // 正好等于上限时不动。
  assert.deepEqual(fitWithin(1600, 900, 1600), { width: 1600, height: 900 })
})

test('极端长条的短边至少留 1px', () => {
  // 3000×40 的拼接图缩到 320 宽，短边按比例是 4.27 → 4；再极端一点会算成 0，
  // 而 0 高的 canvas 是直接抛错。
  assert.deepEqual(fitWithin(3000, 40, 320), { width: 320, height: 4 })
  assert.deepEqual(fitWithin(3000, 2, 320), { width: 320, height: 1 })
})

test('两个目标尺寸都小于长边时，缩略图比原图小', () => {
  const full = fitWithin(4000, 3000, UPLOAD_FULL_EDGE)
  const thumb = fitWithin(4000, 3000, UPLOAD_THUMB_EDGE)
  assert.equal(full.width, 1600)
  assert.equal(thumb.width, 320)
  assert.ok(thumb.width < full.width)
})
