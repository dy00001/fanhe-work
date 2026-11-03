/**
 * 查价弹窗的几何与事件边界。
 *
 * 2026-11-03 用户一次性报了三个「看起来毫不相干」的问题，根因却都是**层与层之间的
 * 契约被打破**，而且 lint、typecheck、单元测试全绿：
 *
 *   1. 弹窗不居中 —— `DialogContent` 基类是 `fixed left-[50%] top-[50%]` 配
 *      `translate-x/y-[-50%]`，Tailwind v4 把后两者编成**独立属性 `translate`**，
 *      再叠上 `data-[state=open]:zoom-in-95` 停在 `scale(.95)`。实测面板落在
 *      `L=475`（视口 1436，本该 128）、尺寸 1121×722（本该 1180×760）。
 *      现在改成「整屏 flex 容器 + 面板自身定尺」，居中由 flex 算。
 *
 *   2. 灯箱里滚轮不缩放、点一下就回首页 —— 三件事各错一层：
 *      a) React 17 起 `onWheel` 是**被动**监听，`preventDefault()` 拦不住默认滚动；
 *      b) 灯箱 portal 到 `body`，DOM 上在 Radix Dialog **外面** → 点灯箱被判成
 *         「点了对话框外面」→ 连查价面板一起关；
 *      c) Esc 挂在 `window` 冒泡阶段，Radix 在 `document` 上先收到 → 一起收掉。
 *
 *   3. 「价格维护页面不可操作」不是权限也不是表单坏了：那一屏在静态稿里本来就写着
 *      「本期只读，不可写」，只有「关闭」一个按钮。补一个「去改价」把路指到右栏。
 *
 * 这些都不产生类型错误、也不改变任何纯函数的输出，浏览器里要复现一次还得先点到
 * 那个品类、再滚一次滚轮。所以在这里钉静态断言。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const LAUNCH_PATH = new URL('../src/components/home/LaunchSection.tsx', import.meta.url)
const LIGHTBOX_PATH = new URL('../src/components/quote/QuoteLightbox.tsx', import.meta.url)
const MAINT_PATH = new URL('../src/components/quote/QuoteMaintPanel.tsx', import.meta.url)
const PANEL_PATH = new URL('../src/components/quote/QuotePanel.tsx', import.meta.url)

/** 注释里可以大段讨论这些写法，只有落在代码里的才算数。 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function readCode(path) {
  return stripComments(readFileSync(path, 'utf8'))
}

test('查价弹窗用整屏 flex 居中，不依赖基类的 left-50% + translate-50%', () => {
  const code = readCode(LAUNCH_PATH)

  // 前提：确认读的确实是那个挂 DialogContent 的文件，否则下面的断言会假绿。
  assert.ok(code.includes('<DialogContent'), '没找到 DialogContent，断言的前提不成立')
  assert.ok(code.includes('showCloseButton={false}'), '没找到查价弹窗的标记，断言的前提不成立')

  // ① 整屏容器：`vw/vh` 永远按视口算，不受包含块变宽的影响。
  assert.match(code, /width:\s*'100vw'/, '弹窗容器宽度不再是 100vw，居中会重新依赖包含块')
  assert.match(code, /height:\s*'100vh'/, '弹窗容器高度不再是 100vh')

  // ② 居中交给 flex。
  assert.match(code, /justifyContent:\s*'center'/, '水平居中丢了')
  assert.match(code, /alignItems:\s*'center'/, '垂直居中丢了')

  // ③ 三条抹除，缺一条都会被基类拽回去。
  assert.match(
    code,
    /translate:\s*'none'/,
    '缺 translate: none。Tailwind v4 把 translate-x/y-[-50%] 编成**独立属性 translate**，' +
      '只写 transform: none 抹不掉它，面板会被平移半个视口（2026-11-02、11-03 两次踩到）。',
  )
  assert.match(code, /transform:\s*'none'/, '缺 transform: none')
  assert.match(
    code,
    /scale:\s*'none'/,
    '缺 scale: none。基类带 data-[state=open]:zoom-in-95，挂载即打开时动画停在 scale(.95)，' +
      '面板会缩成 1121×722。',
  )
  assert.match(
    code,
    /animation:\s*'none'/,
    '缺 animation: none。zoom-in-95 的动画会留在起始帧，尺寸和位置都对不上。',
  )
})

test('弹窗的空白处点击仍然关闭，且不误伤面板内部', () => {
  const code = readCode(LAUNCH_PATH)
  assert.match(
    code,
    /onMouseDown=\{\(event\)\s*=>\s*\{[\s\S]*?event\.target === event\.currentTarget/,
    '整屏容器的「点空白关闭」丢了。改成整屏后遮罩收不到点击，只能挂在容器上；' +
      '且必须比 target 与 currentTarget，否则面板内任意一次按下都会关掉弹窗。',
  )
})

test('灯箱滚轮缩放用非被动监听，不再挂在 JSX 上', () => {
  const code = readCode(LIGHTBOX_PATH)

  assert.ok(
    !/onWheel=\{/.test(code),
    '又出现了 JSX 上的 onWheel。React 17 起它是**被动**监听器，回调里的 preventDefault() ' +
      '只会打一条控制台警告 —— 结果是图没放大、底下的页面滚走了。',
  )
  // 钉在具体那一行上：文件里的注释也写着 `{ passive: false }` 的示例，宽松匹配会被
  // 注释里的示例文本满足，代码改坏了照样绿（本文件写完后用反例测试才发现）。
  assert.match(
    code,
    /element\.addEventListener\('wheel',\s*onWheel,\s*\{\s*passive:\s*false\s*\}\)/,
    'wheel 监听丢了 passive: false，等同于回到被动监听。',
  )
  assert.match(
    code,
    /element\.removeEventListener\('wheel',\s*onWheel\)/,
    'wheel 监听没有成对摘除，重开灯箱会叠监听',
  )
})

test('灯箱在 DOM 上位于 Dialog 之外，靠标记让外层放行', () => {
  const lightbox = readCode(LIGHTBOX_PATH)
  const launch = readCode(LAUNCH_PATH)

  assert.ok(
    lightbox.includes('data-quote-lightbox=""'),
    '灯箱根节点缺 data-quote-lightbox 标记。它 portal 到 body，DOM 上在 Radix Dialog 外面，' +
      '没有标记就会被判成「点了对话框外面」，点图片任意位置都会关掉整个查价面板。',
  )
  assert.ok(
    launch.includes('onInteractOutside'),
    'DialogContent 缺 onInteractOutside，灯箱里的点击会把面板一起关掉。',
  )
  assert.ok(
    launch.includes("closest('[data-quote-lightbox]')"),
    'onInteractOutside 里没有按 data-quote-lightbox 放行，灯箱仍然被当成外部点击。',
  )
  assert.match(
    launch,
    /onInteractOutside=\{[\s\S]{0,400}?event\.preventDefault\(\)/,
    'onInteractOutside 命中了灯箱却没有 preventDefault，等于没拦。',
  )
})

test('Esc 在捕获阶段处理，先于 Radix 收走面板', () => {
  const code = readCode(LIGHTBOX_PATH)

  assert.match(
    code,
    /addEventListener\('keydown',\s*onKeyDown,\s*true\)/,
    'Esc 监听不在捕获阶段。Radix 在 document 上按冒泡阶段收 Esc，会先跑 —— ' +
      '按一下 Esc 连查价面板一起关掉。',
  )
  assert.match(
    code,
    /removeEventListener\('keydown',\s*onKeyDown,\s*true\)/,
    '摘除时漏了第三个参数 true。捕获与冒泡是两份注册，摘不掉会叠监听。',
  )
  assert.match(
    code,
    /event\.stopPropagation\(\)/,
    'Esc 分支没有 stopPropagation，事件继续往下传，Radix 照样会收掉面板。',
  )
})

test('灯箱必须把自己设回 pointer-events: auto', () => {
  const code = readCode(LIGHTBOX_PATH)

  // 🔴 这是整个灯箱能不能用的前提，也是 2026-11-03「滚轮不缩放 + 点哪都关」的**真正根因**。
  // Radix 的模态 Dialog 打开时把 `document.body.style.pointerEvents` 设成 `none`
  // （DismissableLayer 里那句 `ownerDocument.body.style.pointerEvents = "none"`），
  // 然后只给自己的内容层设回 `auto`。灯箱 portal 到 body，是 body 的子节点，
  // 于是整层继承了 `none` —— 对鼠标完全透明：滚轮落到下面列表上（图不缩放、页面在滚），
  // 点击落到下面那层整屏容器上（触发「点空白关闭」→ 面板关掉、回首页）。
  // 鼠标事件根本不进来，`passive: false` 与 `onInteractOutside` 全都无从谈起。
  assert.match(
    code,
    /style=\{\{\s*pointerEvents:\s*'auto'\s*\}\}/,
    '灯箱根节点丢了 pointer-events: auto。模态 Dialog 会把 body 设成 pointer-events: none，' +
      'portal 到 body 的灯箱会整层变成鼠标透明的 —— 滚轮穿透、点击穿透，看起来像「点哪都关」。',
  )
})

test('点图片不关闭：关闭判定用 pointerdown 记下的目标，不是 pointerup 的 target', () => {
  const code = readCode(LIGHTBOX_PATH)

  assert.ok(
    code.includes('onStage: event.target === event.currentTarget'),
    '缺 pointerdown 时记下的 onStage。舞台调了 setPointerCapture，pointerup 的 target 会被' +
      '重定向成舞台本身，「点在图上」与「点在背景上」在 pointerup 里长得一模一样。',
  )
  assert.match(code, /drag\.onStage/, '关闭判定没有用 onStage')
  assert.ok(
    !/!drag\.moved && event\.target === event\.currentTarget/.test(code),
    '关闭判定又回到比 pointerup 的 target 了。指针捕获下它恒等于 currentTarget，' +
      '点图片任意位置都会关掉灯箱。',
  )
})

test('维护面板有直达改价的入口，而不是只有一个「关闭」', () => {
  const maint = readCode(MAINT_PATH)
  const panel = readCode(PANEL_PATH)

  assert.ok(
    maint.includes('onGoEdit: () => void'),
    'QuoteMaintPanel 缺 onGoEdit。这一屏是说明书、只读，没有出口的话点进去就是一堵墙。',
  )
  assert.match(maint, /onClick=\{onGoEdit\}/, '「去改价」按钮没接到 onGoEdit')
  assert.ok(maint.includes('去改价'), '「去改价」按钮的文字被改了，静态稿里没有别的措辞')

  assert.ok(panel.includes('onGoEdit={handleGoEdit}'), 'QuotePanel 没把 handleGoEdit 传下去')
  assert.ok(
    panel.includes("getElementById('quote-price-input')"),
    'handleGoEdit 没有把焦点送到价格输入框，用户还是得自己找',
  )
  assert.match(
    panel,
    /setTimeout\([\s\S]{0,200}?focus\(\)/,
    '聚焦必须延后。Radix 关闭时会在卸载那一刻把焦点还给触发按钮，同步聚焦会被抢回去。',
  )
})
