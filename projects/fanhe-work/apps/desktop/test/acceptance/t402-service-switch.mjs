/**
 * T4-02 的验收脚本：验证「改配置能切到远程 URL 且请求真的打到那个 URL」。
 *
 * 口径是「可配置即算」（用户 2026-10-12 裁决）：不假装远程已经存在，用两个本地
 * 假端点代表「本机」与「远程」，验证切换这件事本身做对了。
 *
 * 为什么不能只读配置文件说「值变了」：那份文件被读到不等于生效。真正要证明的是
 * **反代的上游跟着换了** —— 这条链是 主进程读配置 → 起内置服务 → 请求经反代 →
 * 落到上游。中间任一环没接上，读文件那一步照样会「成功」。
 *
 * 因此每个地址都起一个会自报家门（回显自己的标记）的假服务，切到哪个就该从
 * `/api/` 拿到哪个的标记。判据取标记本身，不是状态码 —— 状态码能被上游的真实
 * 响应凑出来，标记不能。
 *
 * **它不是单测**，所以不放 `test/*.test.mjs`（那是 node --test 的 glob）。跑法：
 *
 *     node --experimental-strip-types test/acceptance/t402-service-switch.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { configPathFor, loadServiceConfig, saveServiceConfig } from '../../src/config.ts'
import { startStaticServer } from '../../src/server.ts'

/** 假上游：回显自己的标记，好证明「请求确实落到了这个地址」。 */
async function startFakeService(marker) {
  const server = createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ marker, path: request.url, method: request.method }))
    })
  })

  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  const address = server.address()
  const url = `http://127.0.0.1:${address.port}`

  return {
    url,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  }
}

/** 最小产物目录：只要有个 index.html，反代之外的部分就能起。 */
async function makeDist() {
  const dist = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-dist-'))
  await writeFile(join(dist, 'index.html'), '<!doctype html><title>外壳</title>', 'utf8')
  return dist
}

async function fetchJson(url) {
  const response = await fetch(url)
  assert.equal(response.status, 200, `期望 200，实际 ${response.status}`)
  return response.json()
}

/**
 * 干净暂存根。与 config.test.mjs 同理：**不能用 os.tmpdir()** ——
 * 经 ws-run.cmd 跑时它被指向工作区的 .tmp，而那就在 .ws-root 底下，
 * 会让「配置落在工作区外」的断言失去意义。固定落系统盘。
 */
const SYSTEM_SCRATCH = join(
  process.env['SystemDrive'] ?? 'C:',
  'Users',
  'Administrator',
  'AppData',
  'Local',
  'Temp',
  'fanhe-desktop-test',
)
await mkdir(SYSTEM_SCRATCH, { recursive: true })

const root = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-t402-'))
const dist = await makeDist()
const scratch = [root, dist]
let failures = 0

function report(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 起一次外壳内置服务，请求它的 `/api/`，返回上游回显的内容。 */
async function requestThroughShell(apiBaseUrl) {
  const shell = await startStaticServer({ root: dist, apiBaseUrl })
  try {
    return await fetchJson(`http://127.0.0.1:${shell.port}/api/`)
  } finally {
    await shell.close()
  }
}

const local = await startFakeService('LOCAL')
const remote = await startFakeService('REMOTE')
scratch.push(/** @type {any} */ (local), /** @type {any} */ (remote))

try {
  console.log(`本机假端点 ${local.url} · 远程假端点 ${remote.url}\n`)

  // ---- 第一段：切到「本机」
  await saveServiceConfig(configPathFor(root), { serviceUrl: local.url })
  const loadA = await loadServiceConfig({ workspaceRoot: root, env: {}, fromDir: root })
  report('配置被读到', loadA.source === 'file', `source=${loadA.source}`)
  report(
    '切到本机地址后反代打到本机端点',
    (await requestThroughShell(loadA.config.serviceUrl)).marker === 'LOCAL',
  )

  // ---- 第二段：**只改配置**，不动代码，切到「远程」
  await saveServiceConfig(configPathFor(root), { serviceUrl: remote.url })
  const loadB = await loadServiceConfig({ workspaceRoot: root, env: {}, fromDir: root })
  report('改配置后读到的是新地址', loadB.config.serviceUrl === remote.url, loadB.config.serviceUrl)

  const viaShellB = await requestThroughShell(loadB.config.serviceUrl)
  report(
    '切到远程地址后反代打到远程端点',
    viaShellB.marker === 'REMOTE',
    `marker=${viaShellB.marker}`,
  )
  report('请求路径经反代保留', viaShellB.path === '/api/', `path=${viaShellB.path}`)

  // ---- 第三段：环境变量仍能一次性覆盖（开发与验证靠它）
  const loadC = await loadServiceConfig({
    workspaceRoot: root,
    env: { FANHE_SERVICE_URL: local.url },
    fromDir: root,
  })
  report('环境变量覆盖文件', loadC.source === 'environment', loadC.config.serviceUrl)
  report(
    '覆盖后反代打到环境变量指定的端点',
    (await requestThroughShell(loadC.config.serviceUrl)).marker === 'LOCAL',
  )

  // ---- 第四段：配置在工作区磁盘上可读可改（换机时用户要看/要改的就是它）
  const path = configPathFor(root)
  report('配置路径在工作区下', path.startsWith(root), path)
  // 注意期望值是**第二段写的远程地址**，不是环境变量里那个本机地址：
  // 环境变量是「一次性覆盖」，只影响本次运行、刻意不落盘 —— 这正是它与配置文件
  // 的分工。若这里读到了环境变量那个值，反而说明覆盖被偷偷写进了文件。
  const onDisk = JSON.parse(await readFile(path, 'utf8'))
  report('环境变量覆盖没有写进磁盘配置', onDisk.serviceUrl === remote.url, JSON.stringify(onDisk))
  report('磁盘上的内容是归一后的地址', onDisk.serviceUrl === onDisk.serviceUrl.replace(/\/+$/, ''))

  // ---- 第五段：上游不可达时回 502 而不是让请求悬挂（切错了要能看出来）
  const dead = await startStaticServer({ root: dist, apiBaseUrl: 'http://127.0.0.1:1' })
  try {
    const response = await fetch(`http://127.0.0.1:${dead.port}/api/`)
    await response.arrayBuffer()
    report('上游不可达时回 502', response.status === 502, `status=${response.status}`)
  } finally {
    await dead.close()
  }
} finally {
  await local.close()
  await remote.close()
  for (const item of scratch) {
    if (typeof item?.close === 'function') await item.close()
  }
  for (const dir of [root, dist]) await rm(dir, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  process.exitCode = failures === 0 ? 0 : 1
}
