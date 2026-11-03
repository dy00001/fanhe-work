/**
 * 删除分类 / 删除产品的接线与文案。
 *
 * 这两个动作与「下架」只差一个动词，后果差一个量级：下架能上架回来，删除不能。
 * 所以这里钉的是四件在浏览器里「看起来都正常」的事：
 *
 *   - 点一次就发请求（少了二次确认，误触就没了）；
 *   - 前端在「分类下还有产品」时仍然发请求（服务端会 409，但用户看到的是一句
 *     与操作无关的错，不如先说人话）；
 *   - 删完之后父级列表不刷新（分类条数还停在旧值，界面上看起来删的是别的东西）；
 *   - 变更记录里 `deleted` / `category` 两个新字段走了「待补价」的兜底文案。
 *
 * 最后一条是纯函数，直接调；前三条钉源码 —— 它们只有点对路径才复现。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { describeRevisionChange } from '../src/lib/quote-display.ts'

const MAINT_DIR = new URL('../src/components/quote/maint/', import.meta.url)

/** 注释里可以大段讨论这些写法（本文件自己就写了），只有落在代码里的才算数。 */
function readCode(path) {
  const source = readFileSync(path, 'utf8')
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const CATEGORY = readCode(new URL('QuoteCategoryManager.tsx', MAINT_DIR))
const PRODUCTS = readCode(new URL('QuoteCategoryProducts.tsx', MAINT_DIR))
const PRODUCT = readCode(new URL('QuoteProductManager.tsx', MAINT_DIR))
const API = readCode(new URL('../src/lib/api.ts', import.meta.url))
const QUOTE_LIB = readCode(new URL('../src/lib/quote.ts', import.meta.url))

test('删分类：接的是 deleteQuoteCategory，点两次才发请求', () => {
  assert.match(
    CATEGORY,
    /deleteQuoteCategory\(\{ source: activeCode, name \}\)/,
    '删分类要带当前主类与分类名，缺一个服务端就删错东西或删不掉',
  )
  // 第一次点击只进入待确认，第二次才发请求 —— 与主类管理条同一套写法。
  assert.match(
    CATEGORY,
    /if \(deleting !== row\.name\) \{[\s\S]{0,240}?setDeleting\(row\.name\)[\s\S]{0,80}?return\s*\}/,
    '第一次点删除不能直接调接口',
  )
  assert.match(
    CATEGORY,
    /deleting === row\.name \? '确认删除' : '删除'/,
    '按钮文案必须随待确认状态变化',
  )
})

test('删分类：有产品时先说人话，不发请求', () => {
  // 服务端会 409，但「409 has_items」到用户眼里只是一句操作失败。条数前端就有
  // （行上那个「N 条」），先说清楚要做什么。
  assert.match(CATEGORY, /if \(count > 0\) \{/, '有产品时必须先拦下来')
  assert.match(CATEGORY, /条产品（含已下架）/, '提示里要写清是「含已下架」—— 下架的也算')
  // 拦下来之后不能继续往下走到发请求那一行。
  const guard = CATEGORY.indexOf('if (count > 0) {')
  const call = CATEGORY.indexOf('deleteQuoteCategory({ source: activeCode, name })')
  assert.ok(guard > 0 && call > guard, '拒绝分支必须在发请求之前')
  assert.ok(
    CATEGORY.slice(guard, call).includes('return'),
    '拒绝分支要 return，否则会接着把请求发出去',
  )
})

test('删分类：删完把勾选、展开、合并目标里的旧名字清掉', () => {
  // 不清的话，下面那条批量合并会显示一个已经不存在的分类，点下去必然失败。
  assert.match(
    CATEGORY,
    /setPicked\(\(current\) => current\.filter\(\(value\) => value !== name\)\)/,
  )
  assert.match(CATEGORY, /setExpanded\(\(current\) => \(current === name \? null : current\)\)/)
  assert.match(CATEGORY, /setMergeTo\(\(current\) => \(current === name \? '' : current\)\)/)
})

test('分类内产品列表：删的是产品本身，且删完刷新这一屏与父级', () => {
  assert.match(
    PRODUCTS,
    /deleteQuoteItem\(\{ source, code: item\.code \}\)/,
    '这个列表里删的是产品，别接成删分类',
  )
  assert.match(
    PRODUCTS,
    /if \(confirming !== item\.code\) \{[\s\S]{0,120}?setConfirming\(item\.code\)[\s\S]{0,80}?return/,
    '第一次点删除只进入待确认',
  )
  assert.match(PRODUCTS, /不可撤销/, '删除的提示必须写明不可撤销')
  // 删完这一屏自己要重取（列表少一行），父级也要刷（分类条数变了）。
  // 切片要**只截 remove 这一个函数**：整个文件里 `onChanged` 还出现在 props 解构与
  // 合并那条路径上，从函数开头切到文件末尾等于什么都没钉住（2026-11-03 反例注入时
  // 实测：把这里的 onChanged 删掉，测试依然全绿）。
  const start = PRODUCTS.indexOf('async function remove(')
  const end = PRODUCTS.indexOf('\n  return (', start)
  assert.ok(start > 0 && end > start, 'remove 函数的边界变了，改这条断言')
  const body = PRODUCTS.slice(start, end)
  assert.match(body, /onChanged\(\)/, '父级的分类条数不会自己变')
  assert.match(body, /await refresh\(\)/, '这一屏的列表要重取，否则删掉的行还挂在上面')
})

test('产品与价格区：删除与下架并排，是两个不同的按钮', () => {
  assert.match(PRODUCT, /deleteQuoteItem\(\{ source, code: item\.code \}\)/)
  assert.match(PRODUCT, /if \(deletingCode !== item\.code\) \{/, '第一次点只进入待确认')
  assert.match(PRODUCT, /deletingCode === item\.code \? '确认删除' : '删除'/)
  // 下架那条路径不能顺带删东西：两个动作共用 run() 可以，但接口不能混。
  assert.match(PRODUCT, /saveQuoteStatus\(/, '下架/上架仍然走状态接口')
  assert.doesNotMatch(
    PRODUCT,
    /saveQuoteStatus\([\s\S]{0,200}?deleteQuoteItem/,
    '状态变更里不该夹着删除',
  )
})

test('删除接口：POST 且带口令，不能退化成 GET 或 DELETE', () => {
  assert.match(
    API,
    /'\/api\/quote\/categories\/delete',\s*\{\s*method: 'POST'/,
    '删分类走 POST：DELETE 带 body 会被部分代理丢掉',
  )
  assert.match(API, /'\/api\/quote\/items\/delete',\s*\{\s*method: 'POST'/, '删产品走 POST')
  for (const name of ['deleteQuoteCategoryRequest', 'deleteQuoteItemRequest']) {
    const at = API.indexOf(`export function ${name}(`)
    assert.ok(at > 0, `${name} 不见了`)
    assert.match(API.slice(at, at + 600), /x-quote-unlock/, `${name} 没带口令头`)
  }
  // lib 层是唯一拿得到 unlock token 的地方。
  for (const name of ['deleteQuoteCategoryRequest', 'deleteQuoteItemRequest']) {
    assert.match(
      QUOTE_LIB,
      new RegExp(`${name}\\(token, input, getQuoteUnlockToken\\(\\)\\)`),
      `${name} 没拿口令，写操作会 401`,
    )
  }
})

test('变更记录：删除与分类删除各有自己的文案，不落进「待补价」兜底', () => {
  // 兜底那一支是给改价用的：新值为空 = 「待补价」。删除的记录新值也是空，
  // 落到兜底里会显示成「… → 待补价」，读的人会以为这条产品在等报价。
  assert.deepEqual(describeRevisionChange('deleted', '名称=x；条目号=A037', ''), {
    before: '名称=x；条目号=A037',
    after: '已删除',
  })
  assert.deepEqual(describeRevisionChange('category', '旧分类', ''), {
    before: '旧分类',
    after: '分类已删除',
  })
  // 改名还是照常显示两个名字。
  assert.deepEqual(describeRevisionChange('category', '甲', '乙'), {
    before: '甲',
    after: '乙',
  })
})
