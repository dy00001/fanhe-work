/**
 * 「价格与产品维护」操作台的接线。
 *
 * 2026-11-03 这一屏从「六节说明书」重写成四个操作区（分类 / 产品与价格 / 批量导入 /
 * 变更记录），同时把查价面板右栏的改价入口全部撤掉。几何与四区存在性钉在
 * `quote-dialog-geometry.test.mjs`；**这里钉的是「每个按钮接到了哪个接口」**。
 *
 * 为什么值得单独钉：这些接线错了都不报错。
 *
 *   - 分类改名如果只改 `quote_categories` 而不改 `quote_items.category`，筛选栏会
 *     列出新名字、点进去一条都查不到 —— 查询返回空数组，200 OK。
 *   - 产品区查询如果漏了 `includeArchived`，下架的产品从列表里消失，于是**再也
 *     上不回来**。而界面上只是「列表短了一截」。
 *   - 导入如果让「识别」这一步顺带写库，选错文件的代价就从「多点一次」变成
 *     「往库里灌一批错行」，且不可逆。
 *
 * 这些都在静态稿里看不出、在浏览器里也要点对路径才能复现，所以钉源码断言。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const MAINT_DIR = new URL('../src/components/quote/maint/', import.meta.url)
const MAINT_PATH = new URL('../src/components/quote/QuoteMaintPanel.tsx', import.meta.url)

/** 注释里可以大段讨论这些写法（本文件自己就写了），只有落在代码里的才算数。 */
function readCode(path) {
  const source = readFileSync(path, 'utf8')
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const CATEGORY = readCode(new URL('QuoteCategoryManager.tsx', MAINT_DIR))
const PRODUCT = readCode(new URL('QuoteProductManager.tsx', MAINT_DIR))
const IMPORT = readCode(new URL('QuoteImportPanel.tsx', MAINT_DIR))
const REVISION = readCode(new URL('QuoteRevisionList.tsx', MAINT_DIR))
const MAINT = readCode(MAINT_PATH)
const TASK = readCode(new URL('../src/lib/quote-import-task.ts', import.meta.url))
const UPLOAD = readCode(new URL('../src/lib/quote-import-upload.ts', import.meta.url))
const DISPLAY = readCode(new URL('../src/lib/quote-import-display.ts', import.meta.url))

test('分类区：改名、合并、排序各自接到对应的写接口', () => {
  // 改名与合并是两个动作，不是「合并 = 改名到目标」的复用：合并要把目标分类的
  // 顺序位置也接管过来，改名不该动顺序。接口分开才不会在一次改动里互相污染。
  //
  // `source: activeCode` 而不是 `source`：主类可以被删掉，当前选中的那个可能已经
  // 不在清单里。`activeCode` 是渲染时算出的兜底值，直接用 `source` 会往一个不存在
  // 的主类里写数据。
  assert.match(
    CATEGORY,
    /renameQuoteCategory\(\{\s*source:\s*activeCode,\s*from,\s*to\s*\}\)/,
    '分类区没有调改名接口（或者参数名被改了）',
  )
  assert.match(
    CATEGORY,
    /mergeQuoteCategory\(\{\s*source:\s*activeCode,\s*from,\s*to\s*\}\)/,
    '分类区没有调单条合并接口',
  )
  assert.match(
    CATEGORY,
    /reorderQuoteCategories\(\{\s*source:\s*activeCode,\s*order\s*\}\)/,
    '分类区没有调排序接口',
  )

  // 排序发的是**完整顺序**。只发「把 A 移到 B 前面」那种增量协议，在并发编辑时
  // 会得到两种都说得通的解释，而结果是顺序看起来没变。
  assert.ok(
    CATEGORY.includes('const order = [...names]'),
    '排序没有基于完整分类清单构造顺序，增量协议在并发下会算错',
  )

  // 合并的目标里不能出现自己 —— 自己合并到自己等于删除，而用户点的时候想的是「并到别处」。
  assert.ok(
    CATEGORY.includes('row.name !== merging.from'),
    '合并的目标下拉没有排除自己，选中自己会把分类连同产品一起挂空',
  )
})

test('产品区：新增、改价、上下架三个动作，改价复用原接口', () => {
  assert.ok(PRODUCT.includes('createQuoteItem('), '产品区没有新增产品的入口')
  // 🔴 改价走的是原来右栏那条接口，一行没改 —— 判权、审计、版本号全部沿用。
  // 如果这里换成一条新接口，`quote_revisions` 的写入规则就会有两套。
  assert.match(
    PRODUCT,
    /saveQuotePrice\(\s*item\.code\s*,/,
    '改价没有走原来的 saveQuotePrice(PATCH /api/quote/items/:code)，业务逻辑会分叉',
  )
  assert.match(
    PRODUCT,
    /saveQuoteStatus\(\s*item\.code\s*,\s*item\.status === 'active' \? 'archived' : 'active'/,
    '下架 / 上架没有按当前状态取反',
  )

  // 🔴 漏了 includeArchived 的话，下架的产品从列表里消失 → 再也点不到「上架」。
  assert.ok(
    PRODUCT.includes('includeArchived: true'),
    '产品列表没有带 includeArchived。下架之后列表里看不到它，就没有入口再上架 —— ' +
      '而「上个月那条现在多少钱」正是下架这个设计存在的理由。',
  )

  // 新增产品的分类可以复用已有分类，也可以直接打一个新名字。
  assert.ok(
    PRODUCT.includes('list="quote-maint-categories"'),
    '新增表单的分类没有接 datalist，只能靠手打，打错一个字就是新分类',
  )
})

test('导入区：识别与写库是两个动作，中间那张草稿表可编辑', () => {
  // 识别只经由 `startImportUpload`，写库只经由 `submitImportTask`；两个动作都在
  // `lib/quote-import-task.ts` 里，面板只负责画。混在一起（例如选文件时顺带写库）
  // 就等于「选错文件 = 灌一批错行」，且不可逆。
  assert.ok(IMPORT.includes('startImportUpload(file)'), '选文件之后没有调识别')
  assert.ok(
    !IMPORT.includes('applyQuoteImport('),
    '面板自己调了写库接口。写库必须只在「确认导入」之后发生。',
  )
  assert.ok(IMPORT.includes('submitImportTask()'), '「确认导入」没有接写库')

  assert.equal(
    TASK.split('applyQuoteImport(').length - 1,
    1,
    '写库接口出现了不止一处。只要有一处在识别路径上，选错文件就会被直接写进库。',
  )

  // 草稿表必须能改：`patchImportRow` 是唯一入口，且分类 / 名称 / 价格都接了它。
  for (const field of ['category', 'name', 'priceText', 'model', 'spec', 'unit']) {
    assert.ok(
      IMPORT.includes(`patchImportRow(index, { ${field}: value })`),
      `草稿表的「${field}」列不可编辑。识别错的行只能删掉重导，而删掉就丢了这一行。`,
    )
  }
  assert.ok(IMPORT.includes('removeImportRow(index)'), '草稿表没有删行入口')

  // 逐行显示源行号：核对时人要能回到原文件那一行。
  assert.ok(IMPORT.includes('row.sourceLine'), '草稿表没有显示源文件行号，核对时无从对照')
})

test('导入区：任务状态在组件外，切页面不中断也不丢结果', () => {
  // 2026-11-03 的现场：上传途中切到别的页面，回来是一片空白。原因是 preview / rows
  // 这些都挂在组件的 useState 上，组件卸载就跟着走 —— 而请求还在飞，结果没人接。
  assert.ok(!IMPORT.includes('useState<QuoteImportPreview'), '面板又把识别结果放回组件状态了')
  assert.ok(IMPORT.includes('useSyncExternalStore('), '面板没有订阅外部任务状态')

  // 状态必须活在模块级：`let state` 在模块作用域，且这个文件里不许出现 useState
  // （一旦出现，说明有第二份状态，两份迟早会不一致）。
  assert.ok(TASK.includes('let state: QuoteImportState'), '任务状态不在模块级')
  assert.ok(!TASK.includes('useState'), '任务模块里出现了组件状态，说明有两份真相')

  // 超限文件必须**一个字节都不发**。旧实现照传 17MB 之后才被服务端拒掉，最终界面
  // 上写的是「服务器超时」，与真实原因（文件太大）毫无关系。
  assert.ok(TASK.includes('validateImportFile(file)'), '选文件时没有前置校验')
  assert.ok(
    TASK.indexOf('validateImportFile(file)') < TASK.indexOf('uploadQuoteImportFile('),
    '前置校验在发请求之后，等于没有',
  )
  assert.ok(
    DISPLAY.includes('QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX'),
    '前置校验没有用共享上限常量，两边会漂开',
  )

  // 上传用原始字节 + XHR：这是拿到真实百分比的唯一办法，也顺手去掉 base64 的 40% 膨胀。
  assert.ok(UPLOAD.includes('upload.onprogress'), '上传没有接进度事件，界面只能转圈')
  assert.ok(
    UPLOAD.includes('application/octet-stream'),
    '上传用的还是 JSON + base64，体积多 40% 且没有进度',
  )
  assert.ok(
    UPLOAD.includes("'x-quote-file-name'"),
    '文件名没有走请求头。服务端靠扩展名选识别器，缺了就只能回 400。',
  )
  assert.ok(IMPORT.includes('role="progressbar"'), '上传/识别期间没有画进度条')

  // 「识别中」那一段不许编百分比：服务端一次请求一个结果，中间没有刻度。
  assert.ok(
    IMPORT.includes("phase === 'uploading' && percent !== null"),
    '识别阶段也画了确定态百分比。给不出来的数字就是假进度。',
  )
})

test('变更记录面板仍在，且别的区改完能刷新它', () => {
  assert.ok(REVISION.includes('loadQuoteRevisions('), '变更记录面板没有取数')
  assert.ok(
    REVISION.includes('[reload, reloadToken]'),
    '变更记录的 effect 没有依赖 reloadToken，别的区改完切过来还是旧的那几条',
  )

  // 维护台里每个区写完之后都要通知外层：重查列表（价格变了）、重取 meta（分类与
  // 条数变了）、重判授权（30 分钟到期后就该显示「口令失效」）。
  assert.ok(MAINT.includes('setRevisionToken'), '维护台没有在写操作之后刷新变更记录')
  for (const region of ['QuoteCategoryManager', 'QuoteProductManager', 'QuoteImportPanel']) {
    assert.match(
      MAINT,
      new RegExp(`<${region}\\s+[^>]*onChanged=`),
      `${region} 没有接 onChanged，改完之后查价页的列表与筛选栏不会更新`,
    )
  }
})

test('每个写操作都带口令头，读接口不带', () => {
  // 口令在进这一屏之前验过（PriceGateDialog），30 分钟有效。四个区共用这一张票，
  // 不逐区校验 —— 但每一次写都必须把它带上，过期时服务端 403，界面上给一句人话。
  const api = readCode(new URL('../src/lib/api.ts', import.meta.url))

  for (const fn of [
    'createQuoteCategoryRequest',
    'renameQuoteCategoryRequest',
    'mergeQuoteCategoryRequest',
    'reorderQuoteCategoriesRequest',
    'createQuoteItemRequest',
    'quoteImportApplyRequest',
  ]) {
    const start = api.indexOf(`export function ${fn}(`)
    assert.ok(start !== -1, `api.ts 里找不到 ${fn}`)
    // 取到下一个 export 之前的那一段，确认里面有 x-quote-unlock。
    const next = api.indexOf('\nexport ', start + 1)
    const body = api.slice(start, next === -1 ? undefined : next)
    assert.ok(
      body.includes("'x-quote-unlock'"),
      `${fn} 没有带 x-quote-unlock。不带就是「口令过期了也照写」，而界面上看不出区别。`,
    )
  }

  // 导入的上传那条不走 `request()`（要用 XHR 拿进度），口令头在它自己的模块里。
  assert.ok(
    UPLOAD.includes("'x-quote-unlock'"),
    '上传没有带 x-quote-unlock。口令过期时会得到 403，而界面拿不到原因。',
  )
  assert.ok(UPLOAD.includes('authorization'), '上传没有带 authorization，服务端只会回 401。')

  // 分类清单是唯一例外：它挂在读权限上，看目录不该要口令。
  const readStart = api.indexOf('export function quoteCategoriesRequest(')
  const readBody = api.slice(readStart, api.indexOf('\nexport ', readStart + 1))
  assert.ok(
    !readBody.includes('x-quote-unlock'),
    '分类清单接口带上口令头了。看一张目录不该要口令，那会把筛选栏的加载也卡住。',
  )
})
