/**
 * 全屏放大层的几何。
 *
 * 2026-11-02 的真实故障：点了「全屏」，浏览器确实进了全屏，但整个品类弹窗被推到视口
 * 左上角之外，只有右下四分之一留在屏幕里 —— 用户看到的是「一张图卡在左上角、旁边还是
 * 原来的页面、顶栏不见了」。
 *
 * 根因不在布局代码里，而在 CSS 的演进上：Tailwind v4 把 `translate-x-[-50%]` 编译成
 * **独立属性** `translate`，不再是 `transform` 的一部分。于是「用内联 `transform: none`
 * 抹掉基类位移」这个写法失效了，`-50% -50%` 照旧生效，100vw×100dvh 的面板被平移走半屏。
 *
 * 这类错误四道门禁全拦不住：不产生类型错误，纯函数没变，lint 也看不出「少写了一个属性」。
 * 而它只在点下全屏按钮之后才出现，冒烟测试也未必覆盖。因此在这里把整份尺寸钉住 ——
 * 少任何一条都会重新变回那个形态。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { CASE_IMMERSIVE_DIALOG_STYLE as STYLE } from '../src/lib/case-immersive-style.ts'

const DIALOG_SOURCE = new URL('../src/components/home/CaseLibraryDialog.tsx', import.meta.url)

test('全屏时必须抹掉 translate 独立属性，而不只是 transform', () => {
  assert.equal(
    STYLE.translate,
    'none',
    'CASE_IMMERSIVE_DIALOG_STYLE 少了 translate: "none"。Tailwind v4 的 ' +
      'translate-x-[-50%] 编译成独立属性 translate，只写 transform: none 抹不掉它，' +
      '弹窗会被平移半屏、只剩右下四分之一留在视口里。',
  )
  // 两条都留：`transform: none` 覆盖旧版 Tailwind / 手写 translate 的写法，
  // `translate: none` 覆盖 v4 的独立属性。丢掉任意一条都是同一类故障。
  assert.equal(STYLE.transform, 'none')
})

test('全屏面板钉在视口原点，尺寸不受基类 max-w / max-h 限制', () => {
  assert.equal(STYLE.position, 'fixed', '不靠基类给 fixed：基类的定位会被覆盖的场合不止一次')
  assert.equal(STYLE.inset, 0, 'inset: 0 同时压住基类的 top-[50%] left-[50%]，不必逐个写')
  assert.equal(STYLE.width, '100vw')
  // dvh 而不是 vh：移动端地址栏收起后 vh 比可视区高，底部一条会伸到屏幕外面。
  assert.equal(STYLE.height, '100dvh')
  assert.equal(STYLE.maxWidth, 'none', '基类有 sm:max-w-[min(1120px,94vw)]，不清掉就不是满屏')
  assert.equal(STYLE.maxHeight, 'none', '基类有 max-h-[92vh]，不清掉全屏会矮一截')
  assert.equal(STYLE.borderRadius, 0, '满屏还带圆角时四角会露出底色')
  assert.equal(STYLE.margin, 0)
})

test('弹窗确实只在全屏状态挂这份样式', () => {
  const source = readFileSync(DIALOG_SOURCE, 'utf8')
  assert.ok(
    source.includes('style={immersive ? CASE_IMMERSIVE_DIALOG_STYLE : undefined}'),
    '没有找到「按 immersive 挂样式」的那一行。样式没被用上，上面几条断言就只是在测一个死对象。',
  )
  assert.ok(
    source.includes('<DialogContent'),
    '没找到 DialogContent，断言的前提不成立（文件可能被改名或清空了）。',
  )
})
