/**
 * 三个维护列表的「表头固定 / 拖动排序」，以及产品行的图片入口。
 *
 * 这三件事都有同一个特征：**做错了不报错**。
 *
 *   - 表头忘了 `sticky` —— 只是滚下去看不见列名，谁也不会上报；
 *   - 拖动算错了下标 —— 只是「偶尔差一位」，两三次里才碰到一次；
 *   - 图格还是纯展示 —— 用户点上去什么都不会发生，而「有没有图」这件事看起来正常。
 *
 * 所以钉源码：钉的是「列数对不对得上」「发出去的顺序是不是这一屏的全部条目」
 * 「图格是不是一个能点的东西」，不是样式喜好。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const MAINT_DIR = new URL('../src/components/quote/maint/', import.meta.url)

/** 注释里可以大段讨论这些写法（本文件自己就写了），只有落在代码里的才算数。 */
function readCode(path) {
  const source = readFileSync(path, 'utf8')
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const CATEGORY = readCode(new URL('QuoteCategoryManager.tsx', MAINT_DIR))
const PRODUCT = readCode(new URL('QuoteProductManager.tsx', MAINT_DIR))
const SOURCE = readCode(new URL('QuoteSourceManager.tsx', MAINT_DIR))
const DRAG = readCode(new URL('use-row-drag.ts', MAINT_DIR))

test('表头：三个列表都粘在滚动容器顶端，且底下有一条不随内容滚走的线', () => {
  for (const [name, code] of [
    ['分类', CATEGORY],
    ['产品', PRODUCT],
    ['主类', SOURCE],
  ]) {
    const th = code.slice(code.indexOf('function Th('))
    assert.ok(
      /className=\{`sticky top-0 z-10 bg-background/.test(th),
      `${name}列表的表头没有 sticky + 不透明底色。粘性表头必须自己带背景，否则下面的行会透上来`,
    )
    // `border-collapse` 的表格里，粘性表头的 `border-b` 会跟着内容一起滚走 ——
    // 滚到中间时表头与第一行之间就没有分隔线了。改用 box-shadow 画这一条。
    //
    // 🔴 **必须写成任意属性 `[box-shadow:...]`，不能写 `shadow-[inset_...]`。**
    // Tailwind v4 对 `shadow-[...]` 的任意值里出现 `inset` 关键字会**整条丢弃**：
    // 源码里字符串在、typecheck 与 lint 全绿、构建也成功，但产物 CSS 里没有这条规则，
    // 界面上就是「什么都没有」。这一条是构建后 grep 产物 CSS 才发现的。
    assert.ok(
      th.includes('[box-shadow:inset_0_-1px_0_0_var(--border-soft)]'),
      `${name}列表的表头用 border-b 画底边。粘性表头会把边框一起滚走，改用 box-shadow`,
    )
    assert.ok(
      !th.includes('shadow-[inset'),
      `${name}列表用了 shadow-[inset ...]。Tailwind v4 会整条丢弃这种写法（构建成功、产物里没有），改用 [box-shadow:inset ...]`,
    )
    assert.ok(
      !/border-b border-border-soft bg-background px-3/.test(th),
      `${name}列表的表头还留着旧的 border-b 写法`,
    )
  }
})

test('拖动：三个列表都接了同一个手柄与同一套落点算法', () => {
  for (const [name, code] of [
    ['分类', CATEGORY],
    ['产品', PRODUCT],
    ['主类', SOURCE],
  ]) {
    assert.ok(code.includes('useRowDrag('), `${name}列表没有接拖动`)
    assert.ok(code.includes('<RowDragHandle'), `${name}列表没有一个看得见的拖动手柄`)
    assert.ok(
      code.includes('drag.rowProps(index)'),
      `${name}列表的行没有挂落点处理 —— 手柄能拖，但松手没人接`,
    )
    assert.ok(
      code.includes('applyDrop('),
      `${name}列表自己算了下标。三处必须共用 quote-sort 的 applyDrop，各写一遍必然有一处差一位`,
    )
    // 原地松手不该发请求。
    assert.ok(code.includes('sameOrder('), `${name}列表没有拦「原地松手」，会白发一次写请求`)
  }

  // 手柄的 `draggable` 只在手柄上，不挂在整行：行里还有输入框与勾选框，
  // 整行可拖会让「选中输入框里的文字」变成拖动整行。
  // 拖动落点的指示线同一条坑：`[&>td]:shadow-[inset_...]` 不生成 CSS。
  assert.ok(
    DRAG.includes('[&>td]:[box-shadow:inset_0_2px_0_0_var(--primary)]'),
    '拖动落点的指示线没有生成得出来的写法（见上一条：shadow-[inset ...] 会被丢弃）',
  )
  assert.ok(
    !DRAG.includes('shadow-[inset'),
    'use-row-drag 用了 shadow-[inset ...]，Tailwind v4 不会生成这条规则',
  )

  const handle = DRAG.slice(DRAG.indexOf('function handleProps('))
  assert.ok(handle.includes('draggable: true'), '手柄没有 draggable')
  assert.ok(
    DRAG.includes("event.dataTransfer.setData('text/plain'"),
    'dragstart 里没有 setData：Firefox 不 setData 就不启动拖动',
  )
  assert.ok(
    !/function rowProps[\s\S]{0,400}?draggable: true/.test(DRAG),
    '整行被设成了可拖动，行内的输入框会选不了字',
  )
})

test('拖动落库：发的是「这一屏的完整顺序」，不是增量', () => {
  assert.match(
    CATEGORY,
    /reorderQuoteCategories\(\{\s*source:\s*activeCode,\s*order\s*\}\)/,
    '分类区没有调排序接口',
  )
  assert.match(
    PRODUCT,
    /reorderQuoteItems\(\{\s*source,\s*order\s*\}\)/,
    '产品区没有调排序接口（或参数名被改了）',
  )
  assert.match(SOURCE, /reorderQuoteSources\(\{\s*order\s*\}\)/, '主类区没有调排序接口')

  // 产品的顺序必须由**当前列表**的 code 构造 —— 它同时是「服务端要知道的那一段」。
  const productDrop = PRODUCT.slice(PRODUCT.indexOf('const drag = useRowDrag('))
  assert.ok(
    productDrop.includes('(rows ?? []).map((row) => row.code)'),
    '产品的顺序不是从当前列表的 code 来的，服务端会收到一份对不上列表的顺序',
  )

  // 带着关键词拖动会改到没显示的那几百条 —— 必须在搜索状态下关掉。
  assert.match(
    PRODUCT,
    /const canDrag = canWrite && !busy && debounced === '' &&/,
    '搜索状态下仍然可以拖产品：拖的是筛选后的一小撮，写下去的却是整份顺序',
  )
  assert.ok(
    PRODUCT.includes('搜索状态下不能拖动排序'),
    '界面上没有说明「搜索时不能拖」，手柄按不动就只是「不好使」',
  )
})

test('列数：加了拖动列之后，展开行的 colSpan 必须跟着改', () => {
  // 产品 8 列（手柄 / 条目号 / 图 / 名称 / 分类 / 价格 / 状态 / 操作），
  // 分类 7 列（手柄 / 勾选 / # / 名称 / 产品 / 顺序 / 操作）。
  assert.ok(PRODUCT.includes('colSpan={8}'), '产品列表的展开行 colSpan 与列数对不上，右侧会留白')
  assert.ok(CATEGORY.includes('colSpan={7}'), '分类列表的展开行 colSpan 与列数对不上')
  assert.ok(!PRODUCT.includes('colSpan={7}'), '产品列表还留着旧的 colSpan={7}')
  assert.ok(!CATEGORY.includes('colSpan={6}'), '分类列表还留着旧的 colSpan={6}')

  const productHead = PRODUCT.slice(PRODUCT.indexOf('<thead>'), PRODUCT.indexOf('</thead>'))
  const thCount = productHead.split('<Th').length - 1
  assert.equal(thCount, 8, `产品表头有 ${String(thCount)} 列，与 colSpan={8} 不一致`)
  const categoryHead = CATEGORY.slice(CATEGORY.indexOf('<thead>'), CATEGORY.indexOf('</thead>'))
  assert.equal(categoryHead.split('<Th').length - 1, 7, '分类表头列数与 colSpan={7} 不一致')
})

test('产品行的图格：有图没图都是一个能点开的入口', () => {
  // 有图与无图用**同一个按钮**，只是 aria-label 不同。分成两个分支写，
  // 迟早会出现「无图那一支忘了接点击」—— 而那一支正是这次要补的。
  assert.match(
    PRODUCT,
    /aria-label=\{\s*item\.imageKey === null\s*\? `为「\$\{item\.name\}」新增商品图`/,
    '无图状态没有独立的 aria-label —— 读屏用户不知道这一格是干什么的',
  )
  assert.ok(
    PRODUCT.includes('管理「${item.name}」的商品图'),
    '有图状态没有「管理商品图」的入口说明',
  )
  assert.ok(
    PRODUCT.includes('setImageCode(imageCode === item.code ? null : item.code)'),
    '点图格没有展开 / 收起图片面板',
  )

  // 面板三个动作齐全。
  assert.ok(PRODUCT.includes("hasImage ? '更换图片' : '新增图片'"), '缺少新增 / 更换图片的按钮')
  assert.ok(PRODUCT.includes('确认删除图片'), '删除图片没有二次确认文案')
  assert.ok(PRODUCT.includes('onRemove()'), '删除图片没有接到回调')

  // 走的是原来那两条接口：上传 / 删除。不新开一条，判权与审计都不分叉。
  assert.ok(PRODUCT.includes('uploadQuoteImage(item.code, prepared.request)'), '换图没有走上传接口')
  assert.ok(PRODUCT.includes('removeQuoteImage(item.code)'), '删图没有走解绑接口')
  // 选完就传，不需要第二次确认。
  assert.ok(
    PRODUCT.includes('const ok = await onUpload(prepared.value)'),
    '选完图没有立即上传 —— 多一个保存步骤就会有人以为已经传上去了',
  )
  // 格式白名单与压缩器同源。
  assert.ok(PRODUCT.includes('accept={QUOTE_IMAGE_ACCEPT}'), '图片面板的文件框没有接白名单')
  assert.ok(
    PRODUCT.includes('describeQuoteImageFailure(prepared.reason)'),
    '图片面板的失败提示没有走统一的描述函数',
  )
})
