/**
 * 宿主判定的回归测试（T6-03b）。
 *
 * ## 这个判定错了会怎样
 *
 * 它的唯一用途是决定「更新提示那一行说什么、点下去做什么」。判错的方向不对称：
 *
 * - 把外壳判成浏览器 → 提示让人去刷新页面，而外壳里刷新不会变 → 用户对着一个
 *   永远无效的提示反复试；
 * - 把浏览器判成外壳 → 提示让人「点此重启更新」，而浏览器里没有那条通道。
 *
 * 两种都会让用户失去对这条提示的信任，而这条提示的全部价值就是让他知道有新版本。
 *
 * ## 为什么要求 `=== true` 而不是「非空」
 *
 * `isDesktopShell` 是预加载脚本写死的 `true`。放宽成「非空即真」会让
 * `isDesktopShell: 'false'`（字符串，环境变量式注入的常见产物）被判成外壳 ——
 * 那是**静默改变文案**的一类错误，而且只在有人真的那样写时才暴露。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectHost } from '../src/lib/host.ts'

test('有桥且标记为真 → 桌面外壳', () => {
  assert.equal(detectHost({ fanheDesktop: { isDesktopShell: true } }), 'desktop')
})

test('没有桥 → 浏览器', () => {
  assert.equal(detectHost({}), 'browser')
})

test('拿不到 window（Node、SSR、被删掉的全局）→ 浏览器', () => {
  // 降级方向必须是浏览器：那边的文案与动作在任何环境下都不会造成意外后果。
  assert.equal(detectHost(undefined), 'browser')
  assert.equal(detectHost(null), 'browser')
})

test('桥不是对象 → 浏览器', () => {
  for (const value of ['yes', 1, true, undefined, null]) {
    assert.equal(detectHost({ fanheDesktop: value }), 'browser')
  }
})

test('标记必须是真正的 true —— 字符串与数字都不算', () => {
  // `'false'` 是这一组里最要紧的一个：非空字符串在 `if` 里为真，若判定放宽成
  // 「非空即外壳」，它会静默把浏览器判成外壳。
  for (const value of ['true', 'false', '', 1, 0, {}, []]) {
    assert.equal(
      detectHost({ fanheDesktop: { isDesktopShell: value } }),
      'browser',
      `isDesktopShell=${JSON.stringify(value)} 不该被判成外壳`,
    )
  }
})

test('反例：把判定放宽成「桥存在即外壳」会被上面两条抓住', () => {
  /** 故意写松的实现：只看桥在不在。 */
  function naive(target) {
    return target?.fanheDesktop ? 'desktop' : 'browser'
  }
  const cases = [
    { fanheDesktop: {} },
    { fanheDesktop: { isDesktopShell: 'false' } },
    { fanheDesktop: { isDesktopShell: false } },
  ]
  for (const c of cases) {
    assert.equal(naive(c), 'desktop')
    assert.equal(detectHost(c), 'browser', '真实现必须比「桥存在」更严')
  }
})
