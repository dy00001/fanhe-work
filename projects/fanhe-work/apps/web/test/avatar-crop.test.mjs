/**
 * 头像裁剪几何的回归测试。
 *
 * 这一层守的是**「存下来的就是预览里看到的那一块」**。它在界面上没有报错可看：算错了
 * 只会表现为「裁出来偏了一点」或者「边上有一条透明缝」，而这两种都要用户存完才发现。
 *
 * 三个最值钱的断言：
 *   ① **源矩形恒在图片范围内**（属性测试，扫一遍缩放 × 偏移的网格）。越界就是那条
 *      透明缝，而它只在「刚好拖到底」时才出现，手测几乎碰不到。
 *   ② **缩放时视口中心对着的源点不动**。不成立的话，拉滑杆的同时图会往一边滑走，
 *      用户得一边放大一边把图拖回来 —— 所有粗糙的裁剪控件都栽在这里。
 *   ③ **偏移被夹到「图片始终盖满视口」**。不成立就会露出底色。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AVATAR_OUTPUT_SIZE,
  MAX_ZOOM,
  clampOffset,
  coverScale,
  createCropState,
  displaySize,
  panBy,
  setZoom,
  sourceRect,
} from '../src/lib/avatar-crop.ts'

/** 视口边长，与对话框里那个常量取同一个值。 */
const VIEW = 264

/** 浮点比较。这几个量是除法算出来的，用 `assert.equal` 会假失败。 */
function near(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message}：期望 ${expected}，实际 ${actual}`)
}

function nearRect(actual, expected) {
  for (const key of ['x', 'y', 'width', 'height']) {
    near(actual[key], expected[key], `源矩形的 ${key}`)
  }
}

/** 视口中心在源像素坐标系里对应的点。缩放不动点那条断言用它。 */
function sourceCenter(image, view, state) {
  const scale = coverScale(image, view) * state.zoom
  return {
    x: image.width / 2 - state.offset.x / scale,
    y: image.height / 2 - state.offset.y / scale,
  }
}

const LANDSCAPE = { width: 800, height: 600 }
const PORTRAIT = { width: 600, height: 800 }
const SQUARE = { width: 500, height: 500 }

test('coverScale 取两个方向的较大值，让图恰好铺满', () => {
  // 横图由高度决定：264/600
  near(coverScale(LANDSCAPE, VIEW), 264 / 600, '横图 cover 系数')
  // 竖图由宽度决定：264/600（高度方向是 264/800，更小）
  near(coverScale(PORTRAIT, VIEW), 264 / 600, '竖图 cover 系数')
  near(coverScale(SQUARE, VIEW), 264 / 500, '方图 cover 系数')
})

test('coverScale 遇到坏尺寸返回 1 而不是 Infinity/NaN', () => {
  // 返回 Infinity 会让后续每一步都变成 NaN，最后表现为「画布全白且没有报错」。
  assert.equal(coverScale({ width: 0, height: 0 }, VIEW), 1)
  assert.equal(coverScale({ width: 100, height: 100 }, 0), 1)
})

test('zoom=1 时显示尺寸在两个方向上都不小于视口（否则会露底色）', () => {
  for (const image of [LANDSCAPE, PORTRAIT, SQUARE]) {
    const size = displaySize(image, VIEW, 1)
    assert.ok(size.width >= VIEW - 1e-9, `宽 ${size.width}`)
    assert.ok(size.height >= VIEW - 1e-9, `高 ${size.height}`)
  }
})

test('初始状态是「恰好铺满 + 居中」', () => {
  assert.deepEqual(createCropState(LANDSCAPE, VIEW), { zoom: 1, offset: { x: 0, y: 0 } })
})

test('横图初始源矩形：满高、横向居中', () => {
  const state = createCropState(LANDSCAPE, VIEW)
  nearRect(sourceRect(LANDSCAPE, VIEW, state), { x: 100, y: 0, width: 600, height: 600 })
})

test('竖图初始源矩形：满宽、纵向居中', () => {
  const state = createCropState(PORTRAIT, VIEW)
  nearRect(sourceRect(PORTRAIT, VIEW, state), { x: 0, y: 100, width: 600, height: 600 })
})

test('方图初始源矩形就是整张图', () => {
  const state = createCropState(SQUARE, VIEW)
  nearRect(sourceRect(SQUARE, VIEW, state), { x: 0, y: 0, width: 500, height: 500 })
})

test('偏移被夹到「图片始终盖满视口」', () => {
  const display = displaySize(LANDSCAPE, VIEW, 1) // 352×264
  // 横向可移动范围是 ±(352−264)/2 = ±44；纵向已经是满高，动不了。
  assert.deepEqual(clampOffset({ x: 1000, y: 1000 }, display, VIEW), { x: 44, y: 0 })
  assert.deepEqual(clampOffset({ x: -1000, y: -1000 }, display, VIEW), { x: -44, y: 0 })
  assert.deepEqual(clampOffset({ x: 10, y: 0 }, display, VIEW), { x: 10, y: 0 })
})

test('显示尺寸不大于视口时偏移归零，而不是被推到角上', () => {
  // 范围算成负数会让 min > max，Math.min/Math.max 的组合会把值顶到其中一个端点。
  assert.deepEqual(clampOffset({ x: 50, y: -50 }, { width: 100, height: 100 }, VIEW), {
    x: 0,
    y: 0,
  })
})

test('拖到边界时源矩形贴边但不越界', () => {
  const state = { zoom: 1, offset: { x: 44, y: 0 } }
  nearRect(sourceRect(LANDSCAPE, VIEW, state), { x: 0, y: 0, width: 600, height: 600 })
  const other = { zoom: 1, offset: { x: -44, y: 0 } }
  nearRect(sourceRect(LANDSCAPE, VIEW, other), { x: 200, y: 0, width: 600, height: 600 })
})

test('panBy 累加位移并夹取', () => {
  const state = createCropState(LANDSCAPE, VIEW)
  assert.deepEqual(panBy(LANDSCAPE, VIEW, state, 10, 0).offset, { x: 10, y: 0 })
  assert.deepEqual(panBy(LANDSCAPE, VIEW, state, 1000, 1000).offset, { x: 44, y: 0 })
  assert.deepEqual(panBy(LANDSCAPE, VIEW, state, -1000, 0).offset, { x: -44, y: 0 })
})

test('panBy 不改缩放', () => {
  const state = setZoom(LANDSCAPE, VIEW, createCropState(LANDSCAPE, VIEW), 2)
  assert.equal(panBy(LANDSCAPE, VIEW, state, 10, 10).zoom, 2)
})

test('缩放时视口中心对着的源点不动', () => {
  // 这条是「拉滑杆图会滑走」那个手感的直接判据。
  let state = createCropState(LANDSCAPE, VIEW)
  state = panBy(LANDSCAPE, VIEW, state, 30, 0)
  const before = sourceCenter(LANDSCAPE, VIEW, state)

  for (const zoom of [1.5, 2, 3, 4]) {
    const next = setZoom(LANDSCAPE, VIEW, state, zoom)
    const after = sourceCenter(LANDSCAPE, VIEW, next)
    near(after.x, before.x, `zoom=${zoom} 时中心 x 漂移`)
    near(after.y, before.y, `zoom=${zoom} 时中心 y 漂移`)
  }
})

test('缩放被夹在 [1, MAX_ZOOM] 之间', () => {
  const base = createCropState(LANDSCAPE, VIEW)
  assert.equal(setZoom(LANDSCAPE, VIEW, base, 0.1).zoom, 1)
  assert.equal(setZoom(LANDSCAPE, VIEW, base, 99).zoom, MAX_ZOOM)
  assert.equal(setZoom(LANDSCAPE, VIEW, base, 2).zoom, 2)
})

test('放大后仍夹取（偏移跟着缩放比放大，但要落在新的可移动范围内）', () => {
  const state = panBy(LANDSCAPE, VIEW, createCropState(LANDSCAPE, VIEW), 44, 0)
  const next = setZoom(LANDSCAPE, VIEW, state, 2)
  // 新显示尺寸 704×528 → 横向范围 ±220，纵向 ±132；旧偏移 44 乘 2 得 88，在范围内。
  assert.deepEqual(next.offset, { x: 88, y: 0 })
})

test('属性：任意缩放 × 偏移下，源矩形都完整落在图片内', () => {
  // 越界 = 画布上出现透明边。它只在「刚好拖到底」那一帧出现，手测很难碰到。
  for (const image of [LANDSCAPE, PORTRAIT, SQUARE]) {
    for (const zoom of [1, 1.3, 2, 2.7, MAX_ZOOM]) {
      for (const dx of [-5000, -120, -1, 0, 1, 120, 5000]) {
        for (const dy of [-5000, -120, -1, 0, 1, 120, 5000]) {
          const state = panBy(image, VIEW, { zoom, offset: { x: 0, y: 0 } }, dx, dy)
          const rect = sourceRect(image, VIEW, state)
          const label = `${image.width}×${image.height} zoom=${zoom} d=(${dx},${dy})`
          assert.ok(rect.x >= -1e-9, `${label} 左边越界 ${rect.x}`)
          assert.ok(rect.y >= -1e-9, `${label} 上边越界 ${rect.y}`)
          assert.ok(rect.x + rect.width <= image.width + 1e-9, `${label} 右边越界`)
          assert.ok(rect.y + rect.height <= image.height + 1e-9, `${label} 下边越界`)
          // 源矩形恒为正方形：视口是方的，两个方向同一个 scale。
          near(rect.width, rect.height, `${label} 源矩形不是正方形`)
        }
      }
    }
  }
})

test('导出尺寸是 256（头像最大只画到 40px，2 倍屏 80px，余量足够）', () => {
  assert.equal(AVATAR_OUTPUT_SIZE, 256)
})
