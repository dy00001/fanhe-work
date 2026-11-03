/**
 * 放大查看的旋转规则。
 *
 * 旋转看着是最简单的一个动作，但它牵动三处会「悄悄错」的地方：
 *
 *   1. **宽高互换。** 90°/270° 之后图片在屏幕上的宽高与布局盒子相反。用未旋转的盒子
 *      去算夹取上限，放大后往右下角拖会被提前夹住；不去换 `max-width/height`，横图转
 *      过来会比舞台高一截，下缘被裁掉 —— 两种表现都像「图坏了」。
 *   2. **角度归一。** 左旋最自然的写法是 `-90`，而「是否互换宽高」的判断按 `% 180`
 *      来算，`-90 % 180` 是 `-90`，不为 0 —— 直接拿差数判断会漏掉左旋这一边。
 *   3. **场景复位。** 旋转后沿用旧的缩放倍率会让刚转过来的图立刻溢出。角度进 `sceneKey`
 *      是让它回到「适配」的机制，也是一条纯逻辑的静态断言能钉住的点。
 *
 * 前两条在这里用纯函数钉住；第三条是静态断言（组件里的写法）。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  isQuarterTurned,
  lightboxFitLimit,
  lightboxVisualSize,
  LIGHTBOX_ROTATIONS,
  normalizeLightboxRotation,
  rotateLightbox,
} from '../src/lib/case-lightbox-view.ts'

/** 横着的舞台与一张 4:3 的图（适配后 800×600）。 */
const STAGE = { width: 1000, height: 800 }
const CONTENT = { width: 800, height: 600 }

test('角度归一到四个方向，负数与越界值都落到合法值上', () => {
  assert.deepEqual([...LIGHTBOX_ROTATIONS], [0, 90, 180, 270])
  assert.equal(normalizeLightboxRotation(0), 0)
  assert.equal(normalizeLightboxRotation(90), 90)
  assert.equal(normalizeLightboxRotation(180), 180)
  assert.equal(normalizeLightboxRotation(270), 270)

  // 左旋就是减 90，调用方不该被迫自己加 360。
  assert.equal(normalizeLightboxRotation(-90), 270)
  assert.equal(normalizeLightboxRotation(-180), 180)
  assert.equal(normalizeLightboxRotation(360), 0)
  assert.equal(normalizeLightboxRotation(450), 90)
  // 三位数一路带着没有意义，所以每次点完都要归一。
  assert.equal(normalizeLightboxRotation(1080), 0)

  // 非四分之一圈就近取整；坏值回落 0 而不是 NaN（NaN 会让比较全部为假）。
  assert.equal(normalizeLightboxRotation(37), 0)
  assert.equal(normalizeLightboxRotation(100), 90)
  assert.equal(normalizeLightboxRotation(Number.NaN), 0)
})

test('右旋四次回到原样，左旋四次也是', () => {
  let clockwise = normalizeLightboxRotation(0)
  for (let step = 0; step < 4; step += 1) clockwise = rotateLightbox(clockwise, 90)
  assert.equal(clockwise, 0)

  let counter = normalizeLightboxRotation(0)
  for (let step = 0; step < 4; step += 1) counter = rotateLightbox(counter, -90)
  assert.equal(counter, 0)

  // 左旋一次等价于右旋三次 —— 这就是「点一下左旋」与「点三下右旋」看到的画面相同。
  assert.equal(
    rotateLightbox(0, -90),
    rotateLightbox(rotateLightbox(rotateLightbox(0, 90), 90), 90),
  )
})

test('只有 90° 与 270° 互换宽高', () => {
  assert.equal(isQuarterTurned(0), false)
  assert.equal(isQuarterTurned(90), true)
  assert.equal(isQuarterTurned(180), false)
  assert.equal(isQuarterTurned(270), true)
})

test('视觉尺寸：转四分之一圈后宽高互换', () => {
  assert.deepEqual(lightboxVisualSize(CONTENT, 0), { width: 800, height: 600 })
  assert.deepEqual(lightboxVisualSize(CONTENT, 90), { width: 600, height: 800 })
  // 180° 只是上下颠倒，占的地方没变。
  assert.deepEqual(lightboxVisualSize(CONTENT, 180), { width: 800, height: 600 })
  assert.deepEqual(lightboxVisualSize(CONTENT, 270), { width: 600, height: 800 })
})

test('旋转后的适配上限：宽用舞台的高、高用舞台的宽', () => {
  // 0°/180°：和默认的 max-w-full / max-h-full 一致。
  assert.deepEqual(lightboxFitLimit(STAGE, 0), { width: 1000, height: 800 })
  assert.deepEqual(lightboxFitLimit(STAGE, 180), { width: 1000, height: 800 })

  // 90°/270°：反过来。竖过来之后，图片的视觉宽度来自布局高度，所以布局高度不能超过
  // 舞台的宽 —— 反之亦然。写反的话，一张 4:3 的横图转过来会是 800 高 > 800 舞台高
  // 的边界刚好卡住，但换成 16:9 就会溢出并被裁掉。
  assert.deepEqual(lightboxFitLimit(STAGE, 90), { width: 800, height: 1000 })
  assert.deepEqual(lightboxFitLimit(STAGE, 270), { width: 800, height: 1000 })

  // 舞台还没量出来（首帧）时给 0，调用方据此回落成 100%。
  assert.deepEqual(lightboxFitLimit({ width: 0, height: 0 }, 90), { width: 0, height: 0 })
})

// ---------------------------------------------------------------------------
// 静态断言
// ---------------------------------------------------------------------------
//
// 下面几条拦的是「改完看着对、实际坏了」的写法。它们都不产生类型错误：
//   - 变换顺序写反（`rotate` 放到最左边），放大后的拖动方向会跟着转 90°，像在跟手较劲。
//   - 角度没进 `sceneKey`，旋转后沿用旧倍率，图立刻溢出舞台。
//   - 自己手写宽高互换，与 `lightboxVisualSize` 的口径分叉。

const SOURCE_PATH = new URL('../src/components/home/CaseLightbox.tsx', import.meta.url)

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

test('变换顺序是「先旋转、再缩放、最后平移」', () => {
  const code = stripComments(readFileSync(SOURCE_PATH, 'utf8'))
  const transform = /transform:\s*`([^`]+)`/.exec(code)
  assert.ok(transform !== null, '没找到 transform，断言的前提不成立')

  const value = transform[1]
  const translate = value.indexOf('translate3d(')
  const scale = value.indexOf('scale(')
  const rotate = value.indexOf('rotate(')
  assert.ok(translate >= 0 && scale >= 0 && rotate >= 0, `变换里缺少某一项：${value}`)
  // CSS 的变换函数从右往左应用，所以字符串顺序必须是 translate → scale → rotate。
  assert.ok(
    translate < scale && scale < rotate,
    `变换顺序不对：${value}。rotate 写在左边会让偏移量的坐标系跟着转 90°，` +
      '放大后往右拖、图片往上走。',
  )
})

test('旋转角度进了 sceneKey，转完回到适配尺寸', () => {
  const code = stripComments(readFileSync(SOURCE_PATH, 'utf8'))
  const sceneKey = /const sceneKey = `([^`]+)`/.exec(code)
  assert.ok(sceneKey !== null, '没找到 sceneKey，断言的前提不成立')
  assert.ok(
    sceneKey[1].includes('${rotation}'),
    `sceneKey 里没有角度：${sceneKey[1]}。旋转后沿用旧倍率，刚转过来的图会立刻溢出舞台。`,
  )
})

test('几何计算走纯函数，不在组件里手写宽高互换', () => {
  const code = stripComments(readFileSync(SOURCE_PATH, 'utf8'))
  assert.ok(code.includes('lightboxVisualSize('), 'measure 应当用 lightboxVisualSize 算视觉尺寸')
  assert.ok(code.includes('lightboxFitLimit('), '适配上限应当用 lightboxFitLimit 算')
  assert.ok(!code.includes('% 180'), '出现了手写的「是否互换宽高」判断，与纯函数口径会分叉')
})
