/**
 * 时间条在七个入口都要出现，且三个「快照类」入口的说明要讲清口径。
 *
 * 2026-10-30 的反馈：服务体验 / 推广投放 / 内容运营三栏没有区间选择，而其余四栏有。
 * 根因是 `OpsToolbar` 的 `simple` 模式 —— 这三页把六档预设与两个日期框整块换成了
 * 一行「30 天整段快照」。同排按钮在三个入口里凭空消失，看起来就是页面没加载完。
 *
 * 这类问题 lint / typecheck / 纯函数测试全拦不住：它不产生类型错误，`simple` 也是
 * 合法布尔值。所以钉两条：
 *
 *   1. **静态断言**：`simple` 这个入口从组件与调用处一起消失，且时间条仍然渲染
 *      `OPS_PRESETS`（正向对照 —— 防止「删掉控件」也算通过）。
 *   2. **文案断言**：区间控件对三页确实不改变数字，这件事必须由右侧说明讲清楚；
 *      客服是单日口径、推广与内容尚未接入，三种说法不能混。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { opsToolbarNote } from '../src/lib/ops-view.ts'

const TOOLBAR = new URL('../src/components/ops/OpsToolbar.tsx', import.meta.url)
const PAGE = new URL('../src/pages/OpsDashboardPage.tsx', import.meta.url)

/** 注释里可以讨论 `simple` 为什么被去掉，只有落在代码里的才算数。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const LABEL = '09-30 ~ 10-29 · 30 天'

test('客服页说明点明单日口径，不让人把区间当成累加', () => {
  const note = opsToolbarNote('service', LABEL)

  assert.ok(note.startsWith(LABEL), '说明要以区间标签开头，右对齐那一句才知道说的是哪个区间')
  assert.match(note, /单日口径/)
})

test('推广与内容页说明直说尚未接入，而不是让控件沉默', () => {
  for (const view of ['ads', 'content']) {
    const note = opsToolbarNote(view, LABEL)
    assert.ok(note.startsWith(LABEL), `${view} 的说明丢了区间标签`)
    assert.match(note, /尚未接入/, `${view} 的说明没有解释「切换区间为什么不改变下方内容」`)
  }
})

test('其余四栏的说明保持原样，不额外加前缀', () => {
  // 反向对照：上两条若写成「任何视图都拼一句」，这里会立刻失败。
  for (const view of ['screen', 'trade', 'items', 'flow']) {
    assert.equal(opsToolbarNote(view, LABEL), LABEL)
  }
})

test('时间条不再有隐藏控件的分支，且仍然渲染六档预设', () => {
  const code = stripComments(readFileSync(TOOLBAR, 'utf8'))

  assert.ok(
    !/\bsimple\b/.test(code),
    'OpsToolbar.tsx 里还留着 simple。它会按视图抽掉区间控件，' +
      '同一排按钮在部分入口消失，用户会当成页面没加载完。口径差异请写进 note。',
  )
  // 正向对照：确认读到的确实是那个渲染预设的文件，避免文件改名后这条假绿。
  assert.match(code, /OPS_PRESETS\.map/, '时间条应当逐个渲染 OPS_PRESETS')
  assert.match(code, /role="tab"/, '预设按钮应当仍然是 tab 语义')
})

test('页面把三个入口也交给同一套控件，没有视图被排除', () => {
  const code = stripComments(readFileSync(PAGE, 'utf8'))

  assert.ok(!/\bsimple=/.test(code), '页面仍在给 OpsToolbar 传 simple，三个入口会再次丢控件')
  assert.match(
    code,
    /note=\{opsToolbarNote\(view, rangeLabel\)\}/,
    '时间条的说明应由 opsToolbarNote 生成',
  )
})
