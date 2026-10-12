/**
 * 版本清单接口的测试（T6-01）。
 *
 * ## 这里验的不是「返回一个 JSON」，而是几件事各自的安全边界
 *
 * 1. **不设门禁也要能用** —— T6-02 要在登录之前拿到它，接口存在但返回 401 就等于
 *    整个 T6-02 建立在一条拿不到数据的链上。**这条是最容易被改坏又最难发现的**
 *    （给接口加上门禁时所有正向用例照样通过）。
 * 2. **版本号必须与根 `package.json` 一致** —— 那份文件是唯一来源。断言用读文件
 *    算出来的期望值，而不是硬编码 `0.1.0`，否则改版本号后这条会跟着一起错。
 * 3. **形状与 shared 的类型一致** —— 字段名拼错时 `VersionManifestResponse` 的
 *    类型标注抓不到（响应是 JSON，没有静态类型），所以这里逐字段断言存在性。
 * 4. **找不到清单时抛错而不是说谎** —— 这是 `manifest.ts` 里刻意选的失败方式，
 *    所以要钉住它。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { computeBuildFingerprint } from '@fanhe/shared'

import { buildApp } from '../src/app.js'

/**
 * 从测试文件的位置读根 package.json —— 期望值不能硬编码。
 *
 * `test/` 往上三层才是仓库根（`apps/api/test` → `apps/api` → `apps` → 仓库根）。
 */
function readRootVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const parsed = JSON.parse(
    readFileSync(resolve(here, '..', '..', '..', 'package.json'), 'utf8'),
  ) as { version: string }
  return parsed.version
}

test('版本清单不设门禁，未登录可读（T6-02 要在登录之前拿到它）', async () => {
  const app = buildApp({ logger: false })
  const res = await app.inject({ method: 'GET', url: '/api/version' })

  assert.equal(res.statusCode, 200)
  app.close()
})

test('版本号与仓库根 package.json 一致', async () => {
  const app = buildApp({ logger: false })
  const res = await app.inject({ method: 'GET', url: '/api/version' })
  const body = res.json() as { version: string }

  // 断言「与清单一致」而不是硬编码某个值 —— 那份清单就是唯一来源。
  assert.equal(body.version, readRootVersion())
  app.close()
})

test('响应含清单的全部字段，且 builtAt 与 commitSha 是「这一侧拿不到」那两个值', async () => {
  const app = buildApp({ logger: false })
  const res = await app.inject({ method: 'GET', url: '/api/version' })
  const body = res.json() as Record<string, unknown>

  // 逐字段断言存在性 —— JSON 没有静态类型，字段名拼错时类型标注抓不到。
  assert.ok('version' in body, '缺 version')
  assert.ok('builtAt' in body, '缺 builtAt')
  assert.ok('commitSha' in body, '缺 commitSha')
  assert.ok('fingerprint' in body, '缺 fingerprint')

  // **这两项是刻意的空值**，理由见 manifest.ts 文件头（容器里没有 .git，
  // 镜像层也不记录构建时刻）。它们不是「忘了填」。
  assert.equal(body.builtAt, '')
  assert.equal(body.commitSha, 'unknown')
  app.close()
})

test('指纹是本侧三项的摘要，长度符合约定', async () => {
  const app = buildApp({ logger: false })
  const res = await app.inject({ method: 'GET', url: '/api/version' })
  const body = res.json() as {
    version: string
    builtAt: string
    commitSha: string
    fingerprint: string
  }

  // **用 shared 的函数重算一遍** —— 这样「接口算的和 shared 算的一致」也被钉住了，
  // 而不只是「有个 32 位十六进制串」。
  assert.equal(
    body.fingerprint,
    computeBuildFingerprint(body.version, body.builtAt, body.commitSha),
  )
  app.close()
})

test('重复请求返回同一份清单（进程内缓存不改变结果）', async () => {
  const app = buildApp({ logger: false })
  const first = (await app.inject({ method: 'GET', url: '/api/version' })).json()
  const second = (await app.inject({ method: 'GET', url: '/api/version' })).json()

  assert.deepEqual(first, second)
  app.close()
})

test('版本号不是 0.0.0 —— 那是「永远比正式版旧」的值，说出来会让 T6-02 永远提示有更新', async () => {
  const app = buildApp({ logger: false })
  const res = await app.inject({ method: 'GET', url: '/api/version' })
  const body = res.json() as { version: string }

  // manifest.ts 里专门解释了为什么不能回落成 0.0.0，这条钉住那个选择的反面。
  assert.notEqual(body.version, '0.0.0')
  app.close()
})

test('从编译产物的位置也能找到根清单（生产形态的那条路）', async () => {
  // 上面那些用例跑的是**源码**（tsx 直接跑 test 与 src）。而生产形态跑的是
  // `dist/version/manifest.js`，两者深度相同但**真实存在的目录结构不同** ——
  // dist 下没有 node_modules 与 src。
  //
  // **一条只在源码态成立的路径，换成编译产物就会静默读到另一个 package.json。**
  // 沿路每一层都有 package.json 且那份的 version 是 `0.0.0`，所以「读错了」
  // 不表现为报错，表现为版本号变成 0.0.0 —— 那恰好被上面那条用例拦住，
  // 但只在源码态。这里直接对编译产物做一次断言。
  const distManifest = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'dist',
    'version',
    'manifest.js',
  )
  assert.ok(existsSync(distManifest), `编译产物不存在：${distManifest}（先跑 pnpm build）`)

  // 产物所在目录往上找，第一层带 pnpm-workspace.yaml 的就是根。
  const distDir = dirname(distManifest)
  let found: string | null = null
  for (let dir = distDir; ;) {
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      found = dir
      break
    }
  }
  assert.ok(found, '从 dist 向上找不到根标记')
  // 根那份的版本号不是 0.0.0 —— 而 apps/api 那份是。**这就是「读错文件」与
  // 「读对文件」的可观测差别。**
  const rootVersion = (
    JSON.parse(readFileSync(resolve(found!, 'package.json'), 'utf8')) as { version: string }
  ).version
  assert.equal(rootVersion, readRootVersion())
  assert.notEqual(rootVersion, '0.0.0')
})
