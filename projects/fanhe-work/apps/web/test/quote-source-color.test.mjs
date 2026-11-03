/**
 * 来源配色的单一出处。
 *
 * ## 为什么值得单独一个测试
 *
 * 2026-11-03 用户报的故障：左栏「板式工艺收费」是青色，结果表同一批行的「板式工艺」
 * 标签是褐色。两处都不报错、都不缺色、控制台干净 —— 只有并排看才发现对不上。
 *
 * 根因是**同一件事有两份实现**：筛选栏改成了按 code 哈希分配，结果表还留着一张写死的
 * `{ sale: 青, craft: 褐, hardware: 蓝 }`。这种「一处改了、另一处忘了」在颜色上特别
 * 难自查，因为一列标签有没有颜色、颜色对不对，肉眼在滚动时并不敏感；而用户会拿颜色
 * 当「这两条是不是同一个主类」的判据。
 *
 * 所以这里钉两件事：
 *
 * 1. **接线**：三个画来源色的地方都调 `quoteSourceColor()`，谁都不许再自带一份表；
 * 2. **行为**：同一个 code 永远同一个颜色，内置三值保持静态稿定的配色。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { quoteSourceColor } from '../src/lib/quote-display.ts'

const FILTERS = readFileSync(
  new URL('../src/components/quote/QuoteFilters.tsx', import.meta.url),
  'utf8',
)
const TABLE = readFileSync(
  new URL('../src/components/quote/QuoteResultTable.tsx', import.meta.url),
  'utf8',
)
const CARD = readFileSync(
  new URL('../src/components/quote/QuoteEntryCard.tsx', import.meta.url),
  'utf8',
)
const DISPLAY = readFileSync(new URL('../src/lib/quote-display.ts', import.meta.url), 'utf8')

// ---------------------------------------------------------------------------
// 接线：一个来源色只有一个出处
// ---------------------------------------------------------------------------

test('左栏圆点走 quoteSourceColor(entry.code)', () => {
  assert.match(
    FILTERS,
    /dot=\{quoteSourceColor\(entry\.code\)\}/,
    '筛选栏的圆点必须按 code 取色，否则同一主类在左栏与表格里两个颜色',
  )
})

test('结果表的来源标签走 quoteSourceColor(item.source)', () => {
  assert.match(
    TABLE,
    /const color = quoteSourceColor\(item\.source\)/,
    '结果表还留着写死的配色表 —— 这正是 2026-11-03 那次对不上的原因',
  )
})

test('结果表里不许再出现写死配色表的取色写法', () => {
  // 只禁「引用」：注释里说明历史时可以提这个名字，真正取色是 `SOURCE_COLOR[...]`。
  assert.doesNotMatch(
    TABLE,
    /SOURCE_COLOR\s*\[/,
    '又有人加了一张按来源名索引的颜色表。主类能自建，这张表对新来源会取到 undefined',
  )
})

test('详情浮层的圆点也走同一个函数', () => {
  assert.match(CARD, /background: quoteSourceColor\(item\.source\)/)
})

test('配色表只 define 一次，且只在 quote-display 里', () => {
  const definitions = [FILTERS, TABLE, CARD].filter((source) =>
    /var\(--m-teal\)[\s\S]{0,200}?var\(--m-amber\)/.test(source),
  )
  assert.deepEqual(
    definitions,
    [],
    '组件里又出现了颜色字面量。颜色定义留在 quote-display.ts，组件只调函数',
  )
  assert.match(DISPLAY, /export function quoteSourceColor\(code: string\): string/)
})

// ---------------------------------------------------------------------------
// 行为：稳定 + 内置保持原样
// ---------------------------------------------------------------------------

test('内置三值保持静态稿的配色：销售青、工艺褐、五金蓝', () => {
  // 换成哈希以后，sale 落到 purple、craft 落到 teal —— 全都变了色。这三条钉住
  // 「内置的配色不许因为换算法而整体换一遍」。
  assert.equal(quoteSourceColor('sale'), 'var(--m-teal)')
  assert.equal(quoteSourceColor('craft'), 'var(--m-amber)')
  assert.equal(quoteSourceColor('hardware'), 'var(--m-blue)')
})

test('同一个 code 永远同一个颜色，且不会取到 undefined', () => {
  for (const code of ['sale', 'craft', 'hardware', 'c0abc123', 'c9z8y7x6', 'x']) {
    const first = quoteSourceColor(code)
    assert.equal(typeof first, 'string')
    assert.ok(first.length > 0, `${code} 取到了空颜色（圆点会变透明）`)
    assert.equal(quoteSourceColor(code), first, `${code} 两次取色不同`)
  }
})

test('自定义主类也有颜色，不用回落到内置那三个名字', () => {
  const custom = quoteSourceColor('c7k2m9q1')
  assert.match(custom, /^var\(--m-(teal|amber|blue|purple)\)$/)
})
