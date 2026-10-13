/**
 * 版本检查的回归测试（T6-02）。
 *
 * 用 Node 内置测试器直接测源码，与 `version.test.mjs` 同款。
 *
 * ## 测的是「拿到的不是清单」那几种情况
 *
 * 这一层的全部价值在于**降级**：取不到、拿到 HTML、拿到形状不对的东西，都必须归
 * `unknown` 而不是抛出去。所以用例的重心不在「正常路径能算出 outdated」——那件事
 * 由 shared 包的 24 项测试负责——而在**每一种坏输入都不炸、且都不误报有更新**。
 *
 * ## 「两侧指纹必然不等」是本项目的既有事实，不是待修的缺陷
 *
 * 用例里有一组专门钉它：前端的指纹来自构建期注入（真实值），服务端在容器里
 * `builtAt` 恒空、`commitSha` 恒 `'unknown'`（T6-01 已在生产验证）。于是同版本号
 * 也会被比成 `ahead` 而不是 `same`。**这组断言的作用是：将来有人看到「指纹不等」
 * 就去改 `compareManifests`，让这里变红。**
 *
 * `parseVersionManifest` 与 `buildUpdateNotice` 是纯函数，直接测；
 * `startVersionCheck` 需要 `fetch`，这里用注入的方式绕开 —— 它依赖模块级的
 * `api.ts`，而后者读 `import.meta.env`，在 Node 下是 `undefined`。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { computeBuildFingerprint } from '@fanhe/shared'

import { detectHost } from '../src/lib/host.ts'
import {
  buildUpdateNotice,
  parseVersionManifest,
  startVersionCheck,
} from '../src/lib/version-check.ts'

/** 本机清单的原始三项。测试里用与服务端同形的形态（builtAt 空、commitSha unknown）。 */
const LOCAL = { version: '0.1.0', builtAt: '', commitSha: 'unknown' }

/**
 * 浏览器宿主下的提示文案。
 *
 * T6-03b 起 `buildUpdateNotice` 多了一个必填的宿主参数，于是每个调用点都要写一遍
 * `'browser'`。下面这批用例测的是「哪种 outcome 提示、文案里有什么」，与宿主无关 ——
 * 用一个带名字的包装让它们专注于那件事，比在十处重复同一个字面量更容易读。
 *
 * **宿主分派本身另有一组用例，那一组直接调 `buildUpdateNotice`** 并把两个宿主的
 * 结果并排断言 —— 这件事不该被包装藏起来。
 */
function noticeFor(comparison, localVersion = '0.1.0') {
  return buildUpdateNotice(comparison, localVersion, 'browser')
}

/** 注入一个返回固定值的假 fetch。`signal` 收下但不用 —— 这里不测取消本身。 */
function fetcherReturning(value) {
  return () => Promise.resolve(value)
}

/** 注入一个必定失败的 fetch。用来验「取不到」这一整类。 */
function fetcherThrowing(error) {
  return () => Promise.reject(error)
}

/** 一份形状完整的清单。改字段时逐个覆盖。 */
function manifest(overrides = {}) {
  return {
    version: '0.2.0',
    builtAt: '',
    commitSha: 'unknown',
    fingerprint: computeBuildFingerprint('0.2.0', '', 'unknown'),
    ...overrides,
  }
}

test('形状完整的清单原样通过', () => {
  const input = manifest()
  const parsed = parseVersionManifest(input)
  assert.deepEqual(parsed, input)
})

test('非对象一律拒绝：null / 数组 / 字符串 / 数字 / undefined', () => {
  assert.equal(parseVersionManifest(null), null)
  assert.equal(parseVersionManifest(undefined), null)
  assert.equal(parseVersionManifest('0.2.0'), null)
  assert.equal(parseVersionManifest(42), null)
  // 数组必须被显式排除：`typeof [] === 'object'`，不排它就会一路走进后面的取值。
  assert.equal(parseVersionManifest(['0.2.0']), null)
  assert.equal(parseVersionManifest([]), null)
})

test('版本号缺失或不是非空字符串一律拒绝', () => {
  // 缺 version：形状不对。
  assert.equal(parseVersionManifest({ fingerprint: 'abc' }), null)
  // 版本号是数字：不是字符串。放它过去会让 compareVersions 里的 split 崩掉。
  assert.equal(parseVersionManifest({ version: 2, fingerprint: 'abc' }), null)
  // 空串：更危险 —— 它会被解析成 0.0.0，于是任何服务端版本都被判成「更新」，
  // 一个方向完全错误的提示。
  assert.equal(parseVersionManifest({ version: '', fingerprint: 'abc' }), null)
  assert.equal(parseVersionManifest({ version: null, fingerprint: 'abc' }), null)
})

test('builtAt / commitSha 缺失时按空串处理，不因此拒绝', () => {
  // 这两个字段只用于展示。与 shared 包对「取不到即空串」的约定保持一致，
  // 而不是让一份少了展示字段的响应整体作废。
  const parsed = parseVersionManifest({ version: '0.2.0', fingerprint: 'abc' })
  assert.notEqual(parsed, null)
  assert.equal(parsed.builtAt, '')
  assert.equal(parsed.commitSha, '')
  assert.equal(parsed.fingerprint, 'abc')
})

test('指纹缺失时按三项重算，而不是判定形状不对', () => {
  // 服务端是同一次构建产物，它算出的指纹就是这三项的哈希。少一个派生字段就报
  // 「拿不到清单」是更差的失败 —— 那会让将来字段增删时静默退化成不提示。
  const parsed = parseVersionManifest({ version: '0.2.0', builtAt: '', commitSha: 'unknown' })
  assert.notEqual(parsed, null)
  assert.equal(parsed.fingerprint, computeBuildFingerprint('0.2.0', '', 'unknown'))
})

test('多带未知字段不影响：只读自己认识的四个', () => {
  const parsed = parseVersionManifest({
    ...manifest(),
    futureField: 'whatever',
    __proto__: undefined,
  })
  assert.notEqual(parsed, null)
  assert.equal(parsed.version, '0.2.0')
})

test('只有 outdated 才给提示，其余三种一律 null', () => {
  const latest = manifest({ version: '0.2.0' })

  assert.notEqual(noticeFor({ outcome: 'outdated', latest }, '0.1.0'), null)
  // same / ahead / unknown 都不提示。unknown 尤其重要：把「查不到」显示成
  // 「有更新」会让用户去找一个不存在的更新方式。
  assert.equal(noticeFor({ outcome: 'same' }, '0.1.0'), null)
  assert.equal(noticeFor({ outcome: 'ahead', latest }, '0.1.0'), null)
  assert.equal(noticeFor({ outcome: 'unknown' }, '0.1.0'), null)
})

test('提示文案里两侧版本号都出现，且带 v 前缀', () => {
  const latest = manifest({ version: '0.2.0' })
  const notice = noticeFor({ outcome: 'outdated', latest }, '0.1.0')

  assert.notEqual(notice, null)
  assert.equal(notice.latestVersion, '0.2.0')
  assert.equal(notice.text, '服务端已是 v0.2.0，刷新页面即可更新')
  assert.equal(notice.title, '本机 v0.1.0 · 服务端 v0.2.0')
  // 两处版本号都不能漏 —— 少了任何一处，用户都无法判断自己该不该更新。
  assert.ok(notice.text.includes('v0.2.0'))
  assert.ok(notice.title.includes('v0.1.0'))
})

test('🔴 两侧指纹必然不等：同版本号判成 ahead 而不是 same', () => {
  // 前端是构建期注入的真实值，服务端在容器里 builtAt 恒空、commitSha 恒 unknown。
  // 两个指纹必然不同 —— 这是 T6-01 记录过的生产事实，不是缺陷。
  const local = {
    version: '0.1.0',
    builtAt: '2026-10-12T07:04:00.000Z',
    commitSha: 'a1b2c3d',
  }
  const remote = manifest({ version: '0.1.0' })

  const localPrint = computeBuildFingerprint(local.version, local.builtAt, local.commitSha)
  const remotePrint = computeBuildFingerprint(remote.version, remote.builtAt, remote.commitSha)
  assert.notEqual(localPrint, remotePrint)

  // 于是比对结果不是 same。按 T6-02 的设计这没有可观察后果：
  // same 与 ahead 在界面上都不提示，只有 outdated 会提示，而 outdated 的判定
  // 完全由版本号决定。这条断言的作用是：将来有人看到「指纹不等」就去改
  // compareManifests，让这里变红。
  const parsed = parseVersionManifest(remote)
  assert.notEqual(parsed, null)
  assert.notEqual(parsed.fingerprint, localPrint)
  // 版本号相同 → 不给提示（buildUpdateNotice 对 ahead 返回 null）。
  assert.equal(noticeFor({ outcome: 'ahead', latest: parsed }, '0.1.0'), null)
})

test('版本号更大才提示：0.2.0 对 0.1.0 给提示，反向不给', () => {
  // 正向。
  const newer = parseVersionManifest(manifest({ version: '0.2.0' }))
  assert.notEqual(noticeFor({ outcome: 'outdated', latest: newer }, '0.1.0'), null)
  // 反向：本机比服务端新（开发期正常状态），归 ahead 不提示。若这条红了，
  // 开发时会一直提示「有更新」。
  const older = parseVersionManifest(manifest({ version: '0.1.0' }))
  assert.equal(noticeFor({ outcome: 'ahead', latest: older }, '0.2.0'), null)
})

test('预发布号不会被当成比正式版新（打错一个字符的防线）', () => {
  // 服务端是 0.1.0-beta，本机是 0.1.0。正式版晚于预发布版 → 本机更新 → 不提示。
  // 方向反了的话，改版本号时漏打一个字符就会让所有用户看到一条假更新。
  const beta = parseVersionManifest(manifest({ version: '0.1.0-beta' }))
  assert.equal(noticeFor({ outcome: 'ahead', latest: beta }, '0.1.0'), null)
})

test('startVersionCheck：拿到不是清单的响应时归 unknown，不抛', async () => {
  // 这一组是本文件存在的核心理由。T5-05 的 Access 落地后，未认证请求会先拿到
  // 一个 HTTP 200 + HTML 的登录页；再往后还有网关超时页、CDN 错误页。
  // 任何一种都不能报「有更新」，更不能把异常抛到界面上去。
  const badPayloads = [
    null,
    undefined,
    '<html><body>Access denied</body></html>',
    ['0.2.0'],
    { error: 'unauthorized', message: '请先登录' },
    { version: '', fingerprint: 'abc' },
    { version: 2, fingerprint: 'abc' },
  ]

  for (const payload of badPayloads) {
    const check = startVersionCheck(fetcherReturning(payload), LOCAL)
    assert.deepEqual(await check.result, { outcome: 'unknown' }, `payload: ${String(payload)}`)
  }
})

test('startVersionCheck：fetch 失败时归 unknown，Promise 不 reject', async () => {
  // 「不 reject」是硬要求 —— hook 里虽然有 catch，但依赖一个「其实不会抛」的承诺，
  // 与直接测它是否真的不抛，是两件不同强度的事。
  for (const error of [new Error('network down'), new TypeError('aborted'), '不是 Error 对象']) {
    const check = startVersionCheck(fetcherThrowing(error), LOCAL)
    assert.deepEqual(await check.result, { outcome: 'unknown' })
  }
})

test('startVersionCheck：拿到合法清单时走真实比对', async () => {
  // 用与服务端在容器里同形的清单（builtAt 空、commitSha unknown）—— 那是 T6-01
  // 在生产验证过的实际返回值。
  const check = startVersionCheck(
    fetcherReturning({
      version: '0.2.0',
      builtAt: '',
      commitSha: 'unknown',
      fingerprint: computeBuildFingerprint('0.2.0', '', 'unknown'),
    }),
    LOCAL,
  )
  const comparison = await check.result
  // 本机是 '0.0.0'（Node 下注入常量退化的占位值），服务端 0.2.0 更新 → outdated。
  assert.equal(comparison.outcome, 'outdated')
  assert.equal(comparison.latest.version, '0.2.0')
})

test('startVersionCheck：abort 之后结果仍是 unknown，且不抛', async () => {
  // abort 让 fetch 抛（fetch 实现通常会），而这一层必须把它归成 unknown ——
  // 中断不是异常，是这条路径上的正常结局之一。
  const fetcher = (signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => {
        reject(new Error('aborted'))
      })
    })

  const check = startVersionCheck(fetcher, LOCAL)
  check.abort()
  assert.deepEqual(await check.result, { outcome: 'unknown' })
})

test('内联的版本标签与 lib/version.ts 保持一致（两份实现的对照）', () => {
  // version-check.ts 不能 import version.ts（扩展名问题，见那个文件的文件头），
  // 所以 `v${version}` 被内联了一份。这两个断言的值与 test/version.test.mjs 里的
  // 前两条**逐字相同** —— 改一处必须改两处，否则这条会红。
  assert.equal(
    noticeFor({ outcome: 'outdated', latest: manifest({ version: '0.1.0' }) }, '0.0.0').text,
    '服务端已是 v0.1.0，刷新页面即可更新',
  )
  assert.equal(
    noticeFor({ outcome: 'outdated', latest: manifest({ version: '1.0.0-rc.1' }) }, '0.0.0').title,
    '本机 v0.0.0 · 服务端 v1.0.0-rc.1',
  )
})

// ─── 宿主分派（T6-03b，收口 T6-02 的 §3.3）────────────────────────────────────
//
// T6-02 原来只有一句「服务端已是 vX，刷新页面即可更新」。那句话在桌面外壳里是错的：
// 外壳加载内置产物，刷新页面什么都不会变 —— 用户照做、发现没变化，此后不再信这条提示。
// 所以两个宿主的文案必须不同，且动作也必须不同（刷新 vs 交给本机更新通道）。

const OUTDATED = { outcome: 'outdated', latest: manifest({ version: '0.2.0' }) }

test('浏览器态：刷新页面即可更新，动作是 reload', () => {
  const notice = buildUpdateNotice(OUTDATED, '0.1.0', 'browser')
  assert.notEqual(notice, null)
  assert.equal(notice.text, '服务端已是 v0.2.0，刷新页面即可更新')
  assert.equal(notice.action, 'reload')
})

test('桌面态：文案不再让人去刷新页面，动作是交给本机更新通道', () => {
  const notice = buildUpdateNotice(OUTDATED, '0.1.0', 'desktop')
  assert.notEqual(notice, null)
  assert.equal(notice.action, 'install')
  // 这一条是本组的重点：桌面态的文案里**不能**出现「刷新页面」。
  // 那句话在外壳里做不到，而它会把用户引向一个无效的动作。
  assert.ok(
    !notice.text.includes('刷新页面'),
    `桌面态文案不能让人去刷新页面（实际是「${notice.text}」）—— 外壳加载的是内置产物`,
  )
})

test('两个宿主的文案确实不同（反例：写成同一句会被这条抓住）', () => {
  const browser = buildUpdateNotice(OUTDATED, '0.1.0', 'browser')
  const desktop = buildUpdateNotice(OUTDATED, '0.1.0', 'desktop')
  assert.notEqual(browser.text, desktop.text, '宿主若不影响文案，T6-03b 这一整组就没有意义')
  assert.notEqual(browser.action, desktop.action)
  // 但版本号一致 —— 两者说的是同一件事，只是做法不同。
  assert.equal(browser.latestVersion, desktop.latestVersion)
})

test('两个宿主在非 outdated 时都不提示', () => {
  for (const host of ['browser', 'desktop']) {
    for (const comparison of [
      { outcome: 'same' },
      { outcome: 'ahead', latest: manifest({ version: '0.1.0' }) },
      { outcome: 'unknown' },
    ]) {
      assert.equal(buildUpdateNotice(comparison, '0.1.0', host), null)
    }
  }
})

test('lib/host.ts 的返回值能直接喂给 buildUpdateNotice（两处取值不许漂移）', () => {
  // version-check.ts 不能 import host.ts（扩展名问题，见那个文件的文件头），
  // 所以宿主这一组取值在两个文件里各写了一份。这条用例把它们**功能性**地钉在一起：
  // 只要哪一边改了名字（比如 'shell' / 'electron'），这里就会红。
  assert.equal(detectHost({ fanheDesktop: { isDesktopShell: true } }), 'desktop')
  assert.equal(detectHost({}), 'browser')

  const viaDetect = buildUpdateNotice(
    OUTDATED,
    '0.1.0',
    detectHost({ fanheDesktop: { isDesktopShell: true } }),
  )
  assert.equal(viaDetect.action, 'install')
  assert.equal(buildUpdateNotice(OUTDATED, '0.1.0', detectHost({})).action, 'reload')
})
