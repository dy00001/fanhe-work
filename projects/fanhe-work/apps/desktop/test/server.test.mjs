/**
 * 内置静态服务的回归测试。
 *
 * 这一层是外壳与前端之间的唯一通道：产物能不能加载、前端路由刷新会不会 404、
 * `/api` 有没有被原样送到服务地址，全都由它决定。而这些恰恰是**只有跑起来才看得见**
 * 的东西 —— 类型检查与 lint 对「找不到文件时该回退还是该 404」这类判断一无所知。
 *
 * 直接测 `src/server.ts`（与 `apps/web/test/*.test.mjs` 同款，靠 Node 的类型剥离
 * 直接加载 TS 源码），因此**不需要先构建**。
 *
 * 上游用一个假服务替身，不连真 API：这里要验的是「转发这件事做对了没有」，
 * 不是「API 有没有起来」。两者混在一起时，一个与转发无关的接口故障会让这组
 * 用例变红，而红色指向的地方是错的。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import { startStaticServer } from '../src/server.ts'

const INDEX_HTML = '<!doctype html><html><head><title>外壳</title></head><body></body></html>'

async function makeProductRoot() {
  const root = await mkdtemp(join(tmpdir(), 'fanhe-shell-'))
  await writeFile(join(root, 'index.html'), INDEX_HTML)
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'assets', 'app-abc123.js'), 'console.log("shell")')
  return root
}

/** 假上游：把收到的方法、路径与请求体原样回显，便于断言「转发得对不对」。 */
function startFakeUpstream() {
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(200, {
        'content-type': 'application/json',
        // 自定义首部要能穿过去，逐跳首部则不该出现。
        'x-upstream': 'fake',
      })
      response.end(
        JSON.stringify({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      )
    })
  })

  return new Promise((resolveReady) => {
    server.listen(0, '127.0.0.1', () => resolveReady(server))
  })
}

const productRoot = await makeProductRoot()
const upstream = await startFakeUpstream()
const upstreamAddress = upstream.address()
const upstreamPort =
  typeof upstreamAddress === 'object' && upstreamAddress ? upstreamAddress.port : 0

const handle = await startStaticServer({
  root: productRoot,
  apiBaseUrl: `http://127.0.0.1:${upstreamPort}/`,
})
const base = `http://127.0.0.1:${handle.port}`

after(async () => {
  await handle.close()
  await new Promise((resolveClosed) => upstream.close(resolveClosed))
  await rm(productRoot, { recursive: true, force: true })
})

test('根路径返回入口页，且不缓存', async () => {
  const response = await fetch(`${base}/`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/html/)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(await response.text(), INDEX_HTML)
})

test('带内容哈希的资源长期缓存', async () => {
  const response = await fetch(`${base}/assets/app-abc123.js`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type') ?? '', /^text\/javascript/)
  assert.match(response.headers.get('cache-control') ?? '', /immutable/)
})

test('无扩展名的未知路径回退到入口页（前端路由刷新不 404）', async () => {
  for (const path of ['/workbench/notes', '/ops/dashboard', '/assets']) {
    const response = await fetch(`${base}${path}`)
    assert.equal(response.status, 200, `${path} 应当回退到入口页`)
    assert.equal(await response.text(), INDEX_HTML)
  }
})

test('带扩展名的缺失资源是真 404，不回退成 HTML', async () => {
  // 若回退，浏览器会把一段 HTML 当脚本执行，报出的语法错误与真实原因
  // （产物不完整）毫无关系 —— 这条断言钉住的正是那个错位。
  const response = await fetch(`${base}/assets/missing.js`)
  assert.equal(response.status, 404)
  assert.doesNotMatch(response.headers.get('content-type') ?? '', /text\/html/)
})

test('编码过的上级路径被挡在产物目录之外', async () => {
  // `%2f` 不会被 URL 解析当作分隔符，因此它绕过了「把 `..` 段规范化掉」这一层，
  // 真正走到服务自己的边界判断上。
  const response = await fetch(`${base}/..%2f..%2fsecret.txt`)
  assert.equal(response.status, 403)
})

test('静态资源不接受写方法', async () => {
  const response = await fetch(`${base}/`, { method: 'POST' })
  assert.equal(response.status, 405)
  assert.equal(response.headers.get('allow'), 'GET, HEAD')
})

test('HEAD 返回首部但不带正文', async () => {
  const response = await fetch(`${base}/`, { method: 'HEAD' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '')
})

test('/api 原样转发到服务地址：路径、查询串、方法与请求体', async () => {
  const response = await fetch(`${base}/api/notes?tag=甲&page=2`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: '转发' }),
  })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-upstream'), 'fake')

  const echoed = await response.json()
  assert.equal(echoed.method, 'POST')
  assert.equal(echoed.path, '/api/notes?tag=%E7%94%B2&page=2')
  assert.deepEqual(JSON.parse(echoed.body), { title: '转发' })
})

test('服务地址末尾的斜杠不会造成双斜杠', async () => {
  // 构造函数传入的是 `…:端口/`，若拼接时不归一，路径会变成 `//api/health`。
  const response = await fetch(`${base}/api/health`)
  const echoed = await response.json()
  assert.equal(echoed.path, '/api/health')
})

test('上游不可达时回以 502，而不是让渲染进程一直等', async () => {
  const orphan = await startStaticServer({
    root: productRoot,
    apiBaseUrl: 'http://127.0.0.1:1',
  })
  try {
    const response = await fetch(`http://127.0.0.1:${orphan.port}/api/health`)
    assert.equal(response.status, 502)
  } finally {
    await orphan.close()
  }
})
