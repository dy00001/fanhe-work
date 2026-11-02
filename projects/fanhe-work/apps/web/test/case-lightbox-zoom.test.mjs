/**
 * 放大查看的缩放 / 平移规则。
 *
 * 这些规则的问题在于「看不出错」：锚点偏了十几像素、放大到边缘后图片能拖出可视区、
 * 触控板滚十下才放大一点点 —— 在浏览器里都要试好几次才能确认，而且改一次代码就得
 * 重试一次。所以几何全放在纯函数里，在这里钉住。
 *
 * 最要紧的一条是 `zoomLightbox` 的不变量：**缩放前后，指针下面的那块图像内容不动。**
 * 它是「滚轮缩放是否好用」的全部体感来源，也是这类实现最常写错的地方（写成围绕图片
 * 中心缩放，用户想看的地方每滚一次就往视野外跑一格）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  clampLightboxScale,
  constrainLightboxView,
  distanceBetween,
  formatLightboxZoom,
  isLightboxReset,
  LIGHTBOX_IDENTITY,
  LIGHTBOX_SCALE_MAX,
  LIGHTBOX_SCALE_MIN,
  pinchLightboxScale,
  wheelLightboxScale,
  zoomLightbox,
} from '../src/lib/case-lightbox-view.ts'

/** 舞台比图片大：图片在这里会以「适配尺寸」显示，四边留白。 */
const STAGE = { width: 1000, height: 800 }
const CONTENT = { width: 800, height: 600 }

test('缩放比被夹在上下限之间', () => {
  assert.equal(clampLightboxScale(0.2), LIGHTBOX_SCALE_MIN)
  assert.equal(clampLightboxScale(99), LIGHTBOX_SCALE_MAX)
  assert.equal(clampLightboxScale(2.5), 2.5)
  // `NaN` 会让所有比较为假，视图就此卡死不动，所以必须在这里挡掉。
  assert.equal(clampLightboxScale(Number.NaN), LIGHTBOX_SCALE_MIN)
  assert.equal(clampLightboxScale(Number.POSITIVE_INFINITY), LIGHTBOX_SCALE_MAX)
})

test('适配状态下偏移一定归零', () => {
  // 图片铺在舞台中央是唯一正确的构图。带着偏移回到 1 倍，图会贴在一侧，
  // 另一侧露出一块空背景，看起来像没加载完。
  assert.deepEqual(constrainLightboxView({ scale: 1, x: 240, y: -120 }, CONTENT, STAGE), {
    scale: 1,
    x: 0,
    y: 0,
  })
})

test('放大后偏移被夹在图片边缘之内', () => {
  // 2 倍时内容 1600×1200，舞台 1000×800 → 横向可移动 ±300，纵向 ±200。
  const clamped = constrainLightboxView({ scale: 2, x: 900, y: -900 }, CONTENT, STAGE)
  assert.equal(clamped.x, 300)
  assert.equal(clamped.y, -200)

  // 没超界的偏移原样保留，否则微调拖动会被莫名"弹回"。
  const kept = constrainLightboxView({ scale: 2, x: 120, y: -60 }, CONTENT, STAGE)
  assert.equal(kept.x, 120)
  assert.equal(kept.y, -60)
})

test('尺寸还没测出来时不夹取', () => {
  // 图片仍在解码时 `content` 是 0。此时若照常夹取，第一帧的缩放锚点位移会被压成 0，
  // 用户看到的是「滚了，但没往指针那边放大」。
  const view = { scale: 2, x: 140, y: 90 }
  assert.deepEqual(constrainLightboxView(view, { width: 0, height: 0 }, STAGE), view)
})

test('缩放锚点下的图像内容保持不动', () => {
  const anchor = { x: 120, y: -80 }
  const next = zoomLightbox(LIGHTBOX_IDENTITY, 2, anchor, CONTENT, STAGE)

  // 缩放前，锚点落在图片上的哪个位置（相对图片中心的图坐标）。
  const pointX = (anchor.x - LIGHTBOX_IDENTITY.x) / LIGHTBOX_IDENTITY.scale
  const pointY = (anchor.y - LIGHTBOX_IDENTITY.y) / LIGHTBOX_IDENTITY.scale

  // 缩放后，同一个图像点也必须仍然出现在锚点处。
  const screenX = next.x + pointX * next.scale
  const screenY = next.y + pointY * next.scale

  assert.ok(Math.abs(screenX - anchor.x) < 1e-9, `横向锚点偏移了 ${screenX - anchor.x} 像素`)
  assert.ok(Math.abs(screenY - anchor.y) < 1e-9, `纵向锚点偏移了 ${screenY - anchor.y} 像素`)
})

test('放大到上限后不再变大，但视图仍然合法', () => {
  const atMax = zoomLightbox(LIGHTBOX_IDENTITY, 10, { x: 0, y: 0 }, CONTENT, STAGE)
  assert.equal(atMax.scale, LIGHTBOX_SCALE_MAX)

  const beyond = zoomLightbox(atMax, 10, { x: 0, y: 0 }, CONTENT, STAGE)
  assert.equal(beyond.scale, LIGHTBOX_SCALE_MAX)
  assert.ok(Math.abs(beyond.x) <= (CONTENT.width * LIGHTBOX_SCALE_MAX - STAGE.width) / 2)
})

test('滚轮向上放大、向下缩小，且到边界截断', () => {
  assert.ok(wheelLightboxScale(1, -100) > 1)
  assert.ok(wheelLightboxScale(2, 100) < 2)
  // 已经是最小或最大时，再滚也不越界。
  assert.equal(wheelLightboxScale(1, 100), LIGHTBOX_SCALE_MIN)
  assert.equal(wheelLightboxScale(LIGHTBOX_SCALE_MAX, -100), LIGHTBOX_SCALE_MAX)
  // 触控板一次只给几个像素，也必须能推动 —— 这是指数映射存在的理由。
  assert.ok(wheelLightboxScale(1, -4) > 1)
})

test('捏合以按下那一刻的倍率为基准，不随移动次数累积', () => {
  // 手指距离翻倍 → 倍率翻倍。
  assert.equal(pinchLightboxScale(2, 100, 200), 4)
  // 同一手势分两次上报（先 150 再 200），结果必须和一次到位一致。
  assert.equal(pinchLightboxScale(2, 100, 150), 3)
  assert.equal(pinchLightboxScale(2, 100, 200), 4)
  // 起始距离为 0 时不产生 NaN。
  assert.equal(pinchLightboxScale(2, 0, 200), 2)
})

test('距离与展示用的辅助函数', () => {
  assert.equal(distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 }), 5)
  assert.equal(formatLightboxZoom(1), '100%')
  assert.equal(formatLightboxZoom(2.456), '246%')
  assert.equal(isLightboxReset(LIGHTBOX_IDENTITY), true)
  assert.equal(isLightboxReset({ scale: 2, x: 0, y: 0 }), false)
})

/**
 * 下面两条是静态断言。它们拦住的都是「改完看着对、实际坏了」的形态：
 * 滚轮监听写成被动的、拖动用指针捕获。两者都不会产生类型错误，单测也测不到。
 */
const SOURCE_PATH = new URL('../src/components/home/CaseLightbox.tsx', import.meta.url)

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('滚轮监听必须是非被动的', () => {
  const code = stripComments(readFileSync(SOURCE_PATH, 'utf8'))
  assert.ok(code.includes("addEventListener('wheel'"), '没找到 wheel 监听，断言前提不成立')
  assert.match(
    code,
    /addEventListener\('wheel'[^)]*\{\s*passive:\s*false\s*\}\)/,
    '滚动监听丢了 passive: false。被动监听里 preventDefault() 不生效，图片放大的同时' +
      '下面的网格会跟着滚，关掉放大层会发现列表已经换了位置。',
  )
})

test('拖动不使用指针捕获', () => {
  const code = stripComments(readFileSync(SOURCE_PATH, 'utf8'))
  // 捕获会把后续鼠标事件的 target 改成捕获元素，`<img>` 再也收不到 click，
  // 而「点图片进全屏」正是靠这个命中。拖动改用 window 上的 pointermove 实现。
  assert.ok(
    !code.includes('setPointerCapture'),
    '出现了 setPointerCapture。它会让点击图片之外的目标，破坏「点图片进全屏」。',
  )
  assert.ok(code.includes("addEventListener('pointermove'"), '没找到 window 上的拖动监听')
})
