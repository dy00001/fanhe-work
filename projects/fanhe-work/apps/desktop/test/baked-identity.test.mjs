/**
 * 从产物里读回构建期身份三连（T7-05）。
 *
 * ## 为什么这一组值得单独钉住
 *
 * 这组函数是「安装包里的前端产物是不是当前版本构建的」这条判据的**唯一实现**。
 * 它出错的后果分两种，都不会当场报错：
 *
 * - **漏检**（该报不符却报相符）：正是 2026-10-14 发 `v0.1.2` 时发生的事 —— 包里烧着
 *   `0.1.1`，而所有既有断言全绿。所以下面有几条是**反例**，专门证明它认得出来。
 * - **误检**（形态稍变就报「找不到」）：一条会假红的断言比不红更糟，它会让人去修
 *   一个本来没坏的东西。所以引号形态、压缩形态、`unknown` 降级值都要各钉一条。
 *
 * 直接测 `scripts/baked-identity.mjs` —— 它是纯 ESM，不需要先构建、也不需要 Electron。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  extractBakedIdentities,
  extractBakedIdentity,
  readBakedBundle,
  readBakedIdentity,
} from '../scripts/baked-identity.mjs'

/**
 * 实测的压缩形态（取自 `v0.1.2` 那份 `apps/web/dist` 的入口脚本）。
 *
 * **三个值之间不是裸逗号** —— 中间夹着下一次赋值 `cg=` / `lg=`。这不是编出来的形状，
 * 写这个模块时第一版正则按「逗号 + 引号」写，结果一条都匹配不上，失败信息还是
 * 「找不到三连」，把人引向「产物不是这套流程产出的」这个错误结论。
 */
const REAL_MINIFIED =
  'var sg=`0.1.1`,cg=`2026-10-14T14:40:32.661Z`,lg=`dd4e9e6`,ug=sg,dg=cg,fg=lg;function pg(e=fg){return e===``?`unknown`:e.slice(0,7)}'

test('认得实测的压缩形态（逗号之间夹着 `标识符=`）', () => {
  const found = extractBakedIdentities(REAL_MINIFIED)
  assert.equal(found.length, 1)
  assert.deepEqual(
    { version: found[0].version, builtAt: found[0].builtAt, commit: found[0].commit },
    { version: '0.1.1', builtAt: '2026-10-14T14:40:32.661Z', commit: 'dd4e9e6' },
  )
})

test('三种引号形态都认得（换一次打包配置不该假红）', () => {
  const shapes = [
    'var a=`0.1.2`,b=`2026-10-14T14:40:32.661Z`,c=`dd4e9e6`;',
    'var a="0.1.2",b="2026-10-14T14:40:32.661Z",c="dd4e9e6";',
    "var a='0.1.2',b='2026-10-14T14:40:32.661Z',c='dd4e9e6';",
  ]
  for (const shape of shapes) {
    const found = extractBakedIdentities(shape)
    assert.equal(found.length, 1, `没认出：${shape}`)
    assert.equal(found[0].version, '0.1.2')
  }
})

test('未压缩形态也认得（分号分隔、值之间隔着 `var x =`）', () => {
  const unminified = 'var a = "0.1.2"; var b = "2026-10-14T14:40:32.661Z"; var c = "dd4e9e6";'
  const found = extractBakedIdentities(unminified)
  assert.equal(found.length, 1, '未压缩形态没认出来 —— 会假红')
  assert.equal(found[0].commit, 'dd4e9e6')
})

test('提交号为 `unknown`（git 不可用的降级值）时仍然认得出', () => {
  const found = extractBakedIdentities('a=`0.1.2`,b=`2026-10-14T14:40:32.661Z`,c=`unknown`;')
  assert.equal(found.length, 1)
  assert.equal(found[0].commit, 'unknown')
})

test('同一段文本连读两次结果相同（正则的 `g` 状态不能泄漏）', () => {
  // 带 `g` 的正则是有状态的：不重置 `lastIndex` 的话，第二次调用会从上次停下的位置
  // 继续，于是**同样的输入得出不同的结果**。这类错误在真实调用里表现为「第一次打包
  // 检查通过、第二次同样的产物却不通过」，极难归因。
  const first = extractBakedIdentities(REAL_MINIFIED)
  const second = extractBakedIdentities(REAL_MINIFIED)
  assert.deepEqual(second, first)
  assert.equal(second.length, 1)
})

test('多处出现时全部返回（判据要看的是「有没有第二个版本」）', () => {
  const text =
    'a=`0.1.2`,b=`2026-10-14T14:40:32.661Z`,c=`dd4e9e6`;x=`0.1.1`,y=`2026-10-13T10:00:00.000Z`,z=`abcdef1`;'
  const found = extractBakedIdentities(text)
  assert.equal(found.length, 2)
  assert.deepEqual(
    found.map((i) => i.version),
    ['0.1.2', '0.1.1'],
  )
})

test('反例 · 只有版本号、没有构建时刻与提交号时必须认不出', () => {
  // 这是「漏检」最可能的样子：某个依赖包里正好有个 `"0.1.2"`。若这种文本被判成
  // 「找到了身份」，那么比对就退化成「产物里有没有出现过这个版本号」—— 而旧产物
  // 里也可能因为别的原因出现它，判据就不再可信。
  for (const text of [
    'version:"0.1.2",name:"dep"',
    'const v = "0.1.2"',
    'a=`0.1.2`,b=`不是时间`,c=`dd4e9e6`;',
    'a=`0.1.2`,b=`2026-10-14T14:40:32.661Z`,c=`这不是提交号`;',
  ]) {
    assert.equal(extractBakedIdentities(text).length, 0, `不该被认成身份三连：${text}`)
  }
})

test('反例 · 中间那个不是带 Z 的 ISO 时刻就不算', () => {
  // 只到分钟的形态是**合法**的日期串，但构建注入的恒是 `toISOString()` 的完整形态。
  // 放宽到「能被 Date.parse 接受」会让来路不明的值混进来。
  const found = extractBakedIdentities('a=`0.1.2`,b=`2026-10-14T14:40`,c=`dd4e9e6`;')
  assert.equal(found.length, 0)
})

test('extractBakedIdentity 给第一个；没有则给 null', () => {
  assert.equal(extractBakedIdentity(REAL_MINIFIED)?.version, '0.1.1')
  assert.equal(extractBakedIdentity('nothing here'), null)
  assert.equal(extractBakedIdentity(undefined), null)
})

/** 造一个最小可用的前端产物目录：`index.html` 引一个 `assets/*.js`。 */
function fakeWebDist(bundleText) {
  const dir = mkdtempSync(join(tmpdir(), 'fanhe-baked-'))
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(
    join(dir, 'index.html'),
    '<!doctype html><html><body><script type="module" crossorigin src="/assets/index-abc.js"></script></body></html>',
    'utf8',
  )
  writeFileSync(join(dir, 'assets', 'index-abc.js'), bundleText, 'utf8')
  return dir
}

test('readBakedIdentity 只读入口引用的脚本', () => {
  const dir = fakeWebDist(REAL_MINIFIED)
  try {
    const read = readBakedIdentity(dir)
    assert.deepEqual(read.files, ['index-abc.js'])
    assert.equal(read.identity?.version, '0.1.1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('反例 · 没被入口引用的死文件里的版本号不算数', () => {
  // 这正是「按 index.html 引用的名字去读，而不是 glob assets/*.js」要挡的：
  // 上一轮留下的旧 chunk 仍躺在 assets/ 里，若把它们也算进来，产物里就会同时
  // 出现新旧两个版本号，判据随即失去意义。
  const dir = fakeWebDist(REAL_MINIFIED)
  try {
    writeFileSync(
      join(dir, 'assets', 'index-stale.js'),
      'a=`9.9.9`,b=`2020-01-01T00:00:00.000Z`,c=`abcdef1`;',
      'utf8',
    )
    const read = readBakedIdentity(dir)
    assert.equal(read.identities.length, 1)
    assert.equal(read.identity?.version, '0.1.1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readBakedBundle 在产物不完整时抛错，而不是降级成「没有版本号」', () => {
  const empty = mkdtempSync(join(tmpdir(), 'fanhe-baked-empty-'))
  try {
    assert.throws(() => readBakedBundle(empty), /前端产物还没构建/)

    writeFileSync(join(empty, 'index.html'), '<!doctype html><html><body></body></html>', 'utf8')
    assert.throws(() => readBakedBundle(empty), /产物不完整/)
  } finally {
    rmSync(empty, { recursive: true, force: true })
  }
})
