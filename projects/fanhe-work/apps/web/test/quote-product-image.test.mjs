/**
 * 新增产品时的图片上传。
 *
 * 这一块的风险全部是「静默的」：拖拽没 preventDefault 会让整页导航走（看起来像
 * 工作台崩了）；校验顺序错了会把「解不开的 HEIC」报成「图片太大」；图和产品分成
 * 两次请求会留下「产品建好了、图没上去」的半成品，而界面上那句「已新增」是对的。
 *
 * 这里钉的每一条都能在别处被悄悄改掉、而门禁（typecheck / lint）一声不响：
 * 它们全是行为顺序与属性取值，不是类型。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const IMAGE_PATH = new URL('../src/lib/quote-image.ts', import.meta.url)
const PRODUCT_PATH = new URL(
  '../src/components/quote/maint/QuoteProductManager.tsx',
  import.meta.url,
)

/** 注释里可以大段讨论这些写法（本文件自己就写了），只有落在代码里的才算数。 */
function readCode(path) {
  const source = readFileSync(path, 'utf8')
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const IMAGE = readCode(IMAGE_PATH)
const PRODUCT = readCode(PRODUCT_PATH)

test('格式白名单只放行三种，accept 与白名单同源', () => {
  // 服务端按魔数只认 JPEG / PNG / WebP（`store.ts` 的 `detectImageMime`）。前端一旦
  // 放宽到 GIF / SVG，用户会顺利选进来、走完压缩、最后在提交时收到一个
  // `invalid_image` —— 而他根本不知道是哪一步不对。
  assert.match(
    IMAGE,
    /QUOTE_IMAGE_MIMES\s*=\s*\[\s*'image\/jpeg'\s*,\s*'image\/png'\s*,\s*'image\/webp'\s*,?\s*\]/,
    '允许的图片类型被改了。服务端只认 JPEG / PNG / WebP 三种魔数，前端放宽等于把错误推迟到提交那一步。',
  )
  // `accept` 手写一份字符串是最容易漂的地方：改了白名单忘了改 accept，选择框里就能
  // 挑出 HEIC，然后「拖进来才被拒」。
  assert.match(
    IMAGE,
    /QUOTE_IMAGE_ACCEPT\s*=\s*QUOTE_IMAGE_MIMES\.join\(','\)/,
    'accept 必须由白名单拼出来，不能另写一份字面量',
  )
})

test('校验顺序：类型 → 解码 → 压缩 → 体积', () => {
  // **只看函数体**：`encodeBitmap` 在文件顶部的 import 里也出现一次，用全文
  // `indexOf` 会把 import 行当成「已经压缩过了」—— 顺序断言会通过，但通过的理由
  // 是错的（这条本身就被它坑过一次）。
  const body = IMAGE.slice(IMAGE.indexOf('export async function prepareQuoteImage'))
  const typeAt = body.indexOf("reason: 'bad_type'")
  const decodeAt = body.indexOf('createImageBitmap')
  const encodeAt = body.indexOf('encodeBitmap(')
  const sizeAt = body.indexOf('full.size > QUOTE_LIMITS.IMAGE_BYTES_MAX')

  assert.ok(typeAt > -1 && decodeAt > -1 && encodeAt > -1 && sizeAt > -1, '四个判定点缺了一个')
  assert.ok(typeAt < decodeAt, '类型判断必须在解码之前')
  // 顺序反过来（先判体积）的话，一张 8MB 的 HEIC 会得到「图片太大」，而真正的问题
  // 是「解不开」。用户按提示去压，压完还是传不上去。
  assert.ok(
    decodeAt < encodeAt,
    '先解码再压缩：解码这一步失败才说明「格式不支持」，而它是最常见的失败',
  )
  assert.ok(
    encodeAt < sizeAt,
    '体积必须判压缩后的字节数。判原图大小会让「手机直出 8MB、压完 200KB」的图在门口被挡掉。',
  )

  // 原图只做快速拒绝，阈值必须是 4 倍余量那一档，不是单张上限本身。
  assert.match(
    IMAGE,
    /QUOTE_IMAGE_FILE_BYTES_MAX\s*=\s*QUOTE_LIMITS\.IMAGE_BYTES_MAX \* 4/,
    '原图快速拒绝线不能等于单张上限，否则手机原图全被挡在门外',
  )
})

test('压缩后的尺寸与解压后的位图都要处理掉', () => {
  // 缩略图长边必须取共享常量：后端 `THUMB_EDGE = 320` 是按这个值写死的，
  // 前端写别的数字会让缩略图与表格占位对不上。
  assert.match(
    IMAGE,
    /encodeBitmap\(bitmap,\s*QUOTE_LIMITS\.THUMB_WIDTH,\s*0\.72\)/,
    '缩略图长边要用 QUOTE_LIMITS.THUMB_WIDTH，与后端 THUMB_EDGE 同源',
  )
  // `ImageBitmap` 是解码后的位图（4000×3000 约 48MB），不显式 close 要等 GC。
  // 连着换几张图很容易在释放前撞上内存压力 —— 表现为「传第三张时页面卡住」。
  assert.match(
    IMAGE,
    /finally\s*\{[\s\S]{0,200}?bitmap\.close\(\)/,
    '解码出来的 bitmap 必须在 finally 里关掉',
  )
})

test('拖拽区：dragover 必须 preventDefault，否则拖进来整个工作台会被导航走', () => {
  // 只写 onDrop 是不够的：不拦 dragover，浏览器不会派发 drop，而是把这张图当成
  // 一次导航 —— 用户看到的是工作台整个没了，还以为是自己点错了。
  assert.match(
    PRODUCT,
    /onDragOver=\{\(event\)\s*=>\s*\{[\s\S]{0,260}?event\.preventDefault\(\)/,
    'onDragOver 缺 preventDefault：drop 不会触发，浏览器会导航到那张图',
  )
  assert.match(PRODUCT, /onDrop=\{handleDrop\}/, '找不到 drop 处理')
  assert.match(PRODUCT, /onDragEnter=/, '拖入高亮没接上，用户看不出这一块是可放置的')

  const dropBody = PRODUCT.slice(
    PRODUCT.indexOf('function handleDrop'),
    PRODUCT.indexOf('function handleDrop') + 600,
  )
  assert.ok(dropBody.includes('event.preventDefault()'), 'onDrop 也要 preventDefault')
  assert.ok(
    dropBody.includes('dataTransfer.files'),
    '读取必须走 dataTransfer.files，用 text/uri-list 拿到的是路径或网址，不是字节',
  )
})

test('只有一个文件输入框，且是单张语义', () => {
  const fileInput = PRODUCT.match(/<input[\s\S]*?type="file"[\s\S]*?\/>/)?.[0] ?? ''
  assert.ok(fileInput !== '', '找不到 type="file" 的输入框')
  assert.ok(
    fileInput.includes('accept={QUOTE_IMAGE_ACCEPT}'),
    'accept 没有接到白名单常量，选择框会列出所有文件类型',
  )
  // 单张是底层决定的（`quote_items.image_key` 是一个字段）。开了 multiple，用户会
  // 一次选十张，然后界面只留最后一张 —— 他以为传了十张。
  assert.ok(
    !/\bmultiple\b\s*(?:\/>|>|\{)/.test(fileInput),
    '文件框不能开 multiple：一条产品只有一张主图',
  )
})

test('图片随产品一次提交，不是先建条目再补图', () => {
  // 新产品没有 code（服务端按五元组算），图键又必须用 code。分成两步就会留中间态：
  // 产品建好了、图没上去，而界面上那句「已新增」是不报错的。
  assert.match(
    PRODUCT,
    /onSubmit\(\s*\{[\s\S]{0,400}?\},\s*image\?\.request,?\s*\)/,
    '提交时没把图片请求体带上（或参数顺序变了）',
  )
  assert.match(
    PRODUCT,
    /createQuoteItem\(image === undefined \? input : \{ \.\.\.input, image \}\)/,
    'createQuoteItem 没有把 image 并进请求体 —— 服务端收不到图，只会建一条空图产品',
  )
})

test('保存失败不收起表单，已填的字段和选好的图都留着', () => {
  // `run` 吞掉异常时返回值必须是布尔：无条件 `setCreating(false)` 会让操作员在
  // 失败后从头再填七个字段、再选一次图。
  assert.match(PRODUCT, /if \(ok\) setCreating\(false\)/, '失败时不能收表单')
  assert.match(
    PRODUCT,
    /async function run\(task: \(\) => Promise<string>\): Promise<boolean>/,
    'run 要返回是否成功，否则上层判断不了',
  )
})

test('三种状态都有明确出口：处理中 / 失败 / 就绪', () => {
  assert.ok(PRODUCT.includes('正在处理图片'), '压缩阶段没有提示，界面在选完图后会像卡住')
  assert.ok(PRODUCT.includes('上传中'), '提交阶段没有单独措辞，和普通保存混在一起')
  assert.ok(PRODUCT.includes('换一张'), '没有替换入口，换图只能先移除再选')
  assert.ok(PRODUCT.includes('移除'), '没有移除入口，选错图只能重开表单')
  // 有图时也要能继续拖 —— 拖拽区在两种状态下都是同一个容器。
  assert.match(PRODUCT, /aria-label="产品图预览"|<img[\s\S]{0,120}产品图预览/, '找不到预览图')

  // 失败提示来自统一的描述函数，不是随手一句「上传失败」。
  assert.match(
    PRODUCT,
    /describeQuoteImageFailure\(result\.reason\)/,
    '失败提示要走 describeQuoteImageFailure，四种失败用户要做的事完全不同',
  )
})

test('列表里的缩略图：无图不同步写 state', () => {
  // `react-hooks/set-state-in-effect` 会拦「effect 里同步 setState」。正确的写法是
  // 没图直接渲染占位、有图才发请求 —— 写成 `setUrl(null)` 再 return 会挂 lint，
  // 而绕开 lint 的写法（加 eslint-disable）会把这个坑留在这里。
  const thumbBody = PRODUCT.slice(PRODUCT.indexOf('function ProductThumb'))
  assert.match(
    thumbBody,
    /if \(key === null\) return/,
    '无图时要在 effect 里直接 return，不能 setState',
  )
  assert.match(
    thumbBody,
    /loadQuoteImageUrl\(key, 'thumb', version\)/,
    '缩略图必须取 thumb 变体，取 full 会让一页 200 行拖下几十 MB',
  )
})
