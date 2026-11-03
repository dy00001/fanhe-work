/**
 * 主类管理 + 两种合并的接线。
 *
 * 2026-11-03 这一轮把「数据来源」从代码里的三字面量搬进了库，并在维护台加了
 * 主类增删改 + 两种合并（多个分类合成一个 / 一个分类里的多条产品折成一条）。
 * 几何、四个操作区的存在性钉在 `quote-maint-workbench.test.mjs` 与
 * `quote-dialog-geometry.test.mjs`；**这里钉的是「谁调哪个接口」和「什么时候
 * 那个按钮才该出现」**。
 *
 * 为什么这些值得逐条钉：它们全都不报错。
 *
 *   - 主类删除如果在前端自己算「有没有产品」（`itemCount === 0`），会在**分类
 *     空了但产品全是 archived** 时放行 —— 服务端才看得到 archived 那一半。
 *   - 多选合并如果不卡「至少两条」，只勾一条点下去等于给这个分类改名，而
 *     用户以为自己做了合并；界面上两种结果长得一样。
 *   - 产品合并如果不校验「保留条必须在勾选里」，服务端会把没被勾的那条当成
 *     保留条，其余全下架 —— 一次点击下架一整个分类且不报错。
 *   - 主类如果还在用 `QUOTE_SOURCES` 渲染，新建的主类不出现，`undefined` 只
 *     表现为「少一个 tab」「圆点透明」。
 *
 * 这些在静态稿里看不见、在浏览器里也要点对路径才复现，所以钉源码断言。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const MAINT_DIR = new URL('../src/components/quote/maint/', import.meta.url)
const QUOTE_DIR = new URL('../src/components/quote/', import.meta.url)

/** 注释里可以大段讨论这些写法（本文件自己就写了），只有落在代码里的才算数。 */
function readCode(path) {
  const source = readFileSync(path, 'utf8')
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const SOURCE_MGR = readCode(new URL('QuoteSourceManager.tsx', MAINT_DIR))
const CATEGORY = readCode(new URL('QuoteCategoryManager.tsx', MAINT_DIR))
const PRODUCTS = readCode(new URL('QuoteCategoryProducts.tsx', MAINT_DIR))
const PRODUCT = readCode(new URL('QuoteProductManager.tsx', MAINT_DIR))
const IMPORT = readCode(new URL('QuoteImportPanel.tsx', MAINT_DIR))
const FILTERS = readCode(new URL('QuoteFilters.tsx', QUOTE_DIR))
const ENTRY = readCode(new URL('QuoteEntryCard.tsx', QUOTE_DIR))
const API = readCode(new URL('../src/lib/api.ts', import.meta.url))
const QUOTE_LIB = readCode(new URL('../src/lib/quote.ts', import.meta.url))

test('主类管理条：新增 / 改名 / 删除各接各的接口，删除要两次点击', () => {
  // 三个动作三个接口。改名不能复用「新增一条再删旧的」—— 那会把 code 换掉，
  // 而 code 是每条产品业务键的第一段。
  assert.match(
    SOURCE_MGR,
    /createQuoteSource\(short === '' \? \{ name \} : \{ name, short \}\)/,
    '新建主类应当只传名称（短名可留空，由服务端取名前两字）',
  )
  // 改名要把 code 一起带上：只传新名字服务端不知道改哪一行。而且 code 取自
  // 行内编辑的草稿快照（`const draft = editingThis`，先于 `setEditing(null)`），
  // 不能等 await 回来再读 `editingThis` —— 那时编辑器已经收起来了。
  assert.match(
    SOURCE_MGR,
    /const draft = editingThis[\s\S]{0,200}?renameQuoteSource\(\{\s*code: draft\.code,/,
    '改名要带 code，且要在收起编辑器之前把草稿快照下来',
  )
  assert.match(
    SOURCE_MGR,
    /deleteQuoteSource\(\{ code: row\.code \}\)/,
    '删除主类应当接 deleteQuoteSource',
  )

  // 删除是不可逆动作里最不可逆的那个（连分类一起删），必须两次点击。
  assert.match(
    SOURCE_MGR,
    /if \(confirming !== row\.code\) \{\s*setConfirming\(row\.code\)\s*return\s*\}/,
    '第一次点删除只应该进入待确认状态，不能直接调接口',
  )
  assert.match(
    SOURCE_MGR,
    /confirming === row\.code \? '确认删除' : '删除'/,
    '按钮文案必须随待确认状态变化，否则用户不知道自己点的是第二次',
  )
})

test('主类删除资格由服务端下发，前端不自己算', () => {
  // 判据是 `active + archived === 0`：条目只转 archived、不物理删，所以界面里
  // 「清空」是做不出来的。前端只看得到 `itemCount`，看不到 archived 那一半。
  assert.match(SOURCE_MGR, /row\.deleteBlockedReason/, '拦截原因要由服务端给')
  assert.match(
    SOURCE_MGR,
    /!row\.deletable && row\.deleteBlockedReason !== ''/,
    '不可删时要先把原因说出来',
  )
  assert.doesNotMatch(
    SOURCE_MGR,
    /itemCount\s*===?\s*0|archivedCount\s*===?\s*0/,
    '前端自己算删除资格会漏掉 archived 那一半，放行后连分类一起没了',
  )
  // 置灰等于不解释：按钮要能点，点下去由服务端给一句「还有 N 条产品」。
  assert.doesNotMatch(
    SOURCE_MGR,
    /disabled=\{[^}]*!row\.deletable[^}]*\}/,
    '删除按钮不该按 deletable 置灰',
  )
})

test('主类清单不得再用内置常量渲染', () => {
  // `QUOTE_SOURCES` 现在只含内置三类。任何一个组件还在用它取名字 / 短名 / 圆点，
  // 自建主类就在那一处变成 undefined —— 少一个 tab、圆点透明、出处空白，
  // 全都不报错。
  const OWNERS = [
    ['主类管理条', SOURCE_MGR],
    ['分类区', CATEGORY],
    ['分类内产品区', PRODUCTS],
    ['产品与价格区', PRODUCT],
    ['批量导入区', IMPORT],
    ['查价筛选栏', FILTERS],
    ['查价结果卡', ENTRY],
  ]
  for (const [label, code] of OWNERS) {
    assert.doesNotMatch(
      code,
      /QUOTE_SOURCES|QUOTE_SOURCE_NAMES|QUOTE_SOURCE_SHORT/,
      `${label}还在用内置常量，自建主类在这里会是 undefined`,
    )
  }
})

test('分类多选合并：至少两条才出现，且目标名不许空', () => {
  // 只勾一条点合并 = 给这个分类改名。两种操作在界面上长得一样，所以宁可
  // 不渲染这个条，也不能让用户点出一件自己没打算做的事。
  assert.match(CATEGORY, /picked\.length >= 2 && \(/, '多选合并条只在勾了至少两条时渲染')
  assert.match(
    CATEGORY,
    /if \(picked\.length < 2 \|\| to === ''\) return/,
    '入口守卫要在 handle 里再写一遍，不能只靠不渲染',
  )
  assert.match(
    CATEGORY,
    /mergeQuoteCategories\(\{ source: activeCode, from: picked, to \}\)/,
    '多选合并接 mergeQuoteCategories，from 是勾选的数组',
  )
  // 目标名默认取第一个勾选项：最常见诉求是「合到名字最像的那个」，让用户
  // 手打一遍既慢又容易打出一个看着一样的重复分类。
  assert.match(CATEGORY, /next\[0\] \?\? ''/, '取消勾选后目标名要回落到剩下的第一个')
  assert.match(CATEGORY, /disabled=\{busy \|\| mergeTo\.trim\(\) === ''\}/, '目标名为空时不许提交')
})

test('分类内产品合并：保留条必须在勾选里，且明说「不删除」', () => {
  // 保留条不在勾选里时，服务端会把一条用户没看到的行当成保留条、其余全下架。
  assert.match(
    PRODUCTS,
    /const canMerge = selected\.length >= 2 && keep !== null && selected\.includes\(keep\)/,
    '三个条件缺一不可：够两条、选了保留条、保留条在勾选里',
  )
  assert.match(
    PRODUCTS,
    /mergeQuoteItems\(\{ source, category, codes: selected, keep \}\)/,
    '产品合并要同时带分类与保留条，否则服务端无法判同分类',
  )
  assert.match(PRODUCTS, /disabled=\{busy \|\| !canMerge\}/, '不满足条件时按钮必须不可点')
  assert.match(PRODUCTS, /至少勾选两条/, '空选要有一句人话，而不是一个灰按钮')
  assert.match(PRODUCTS, /不删除，可单独上架回来/, '要告诉用户这里是下架不是删除')
})

test('写接口走 POST/PATCH 且带口令头，读主类不带口令', () => {
  // 读主类不带口令：查价页左栏挂载就要名字，为它多要一个口令会闪一次 code。
  assert.match(API, /quoteSourcesRequest\(accessToken: string\)/, '读主类不该收 unlockToken')
  assert.match(API, /'\/api\/quote\/sources',\s*\{\s*method: 'GET'/, '读主类走 GET')

  assert.match(API, /'\/api\/quote\/sources',\s*\{\s*method: 'POST'/, '新建主类走 POST')
  assert.match(API, /'\/api\/quote\/sources',\s*\{\s*method: 'PATCH'/, '改名主类走 PATCH')
  assert.match(
    API,
    /'\/api\/quote\/sources\/delete',\s*\{\s*method: 'POST'/,
    '删除主类走 POST：DELETE 带 body 会被某些代理丢掉，变成「无 body 删除」',
  )
  assert.match(API, /'\/api\/quote\/categories\/merge-many'/, '多选合并是独立路由')
  assert.match(API, /'\/api\/quote\/items\/merge'/, '产品合并是独立路由')

  // 写接口必须带口令头，否则服务端一律 401，界面只会显示一句「操作失败」。
  for (const name of [
    'createQuoteSourceRequest',
    'renameQuoteSourceRequest',
    'deleteQuoteSourceRequest',
    'mergeQuoteCategoriesRequest',
    'mergeQuoteItemsRequest',
  ]) {
    const at = API.indexOf(`export function ${name}(`)
    assert.ok(at > 0, `${name} 不见了`)
    const body = API.slice(at, at + 700)
    assert.match(body, /x-quote-unlock/, `${name} 没带口令头`)
  }

  // lib 层是唯一能拿到 unlock token 的地方，五个写动作都要经它转发。
  for (const name of [
    'createQuoteSourceRequest',
    'renameQuoteSourceRequest',
    'deleteQuoteSourceRequest',
    'mergeQuoteCategoriesRequest',
    'mergeQuoteItemsRequest',
  ]) {
    assert.match(
      QUOTE_LIB,
      new RegExp(`${name}\\(token, input, getQuoteUnlockToken\\(\\)\\)`),
      `${name} 没拿口令，写操作会 401`,
    )
  }
})
