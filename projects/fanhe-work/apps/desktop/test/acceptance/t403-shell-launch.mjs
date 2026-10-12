/**
 * T4-03 的验收脚本：验证「服务地址指到别处时，本机代理仍能起本机进程」。
 *
 * ## 验的是哪一件事
 *
 * T4-03 的全部价值在这一句话：**外壳内置代理，连的是远程服务也能启动本机软件。**
 * 若这条不成立，阶段四就没有意义 —— 用户还是得在本机另开一个 API 进程。
 *
 * ## 为什么不能只断言「返回 ok」
 *
 * `runLaunchProfile` 返回 `ok: true` 只说明 `spawn` 事件到了，不说明那个进程真的
 * 是我们要的那个。所以这里的可执行文件是 **node 自己 + 一段会写标记文件的脚本**：
 * 判据是**标记文件真的出现了**，而不是返回值、也不是 pid 是否存在（pid 存在与
 * 程序跑对了是两件事）。
 *
 * 同理，「远程」不是靠一个假地址糊过去的：脚本先把服务地址配置写到一个自报家门的
 * 假上游上，再证明进程照样起来了，且那个假上游**一次请求都没收到** —— 后者才说明
 * 启动走的是主进程的 IPC 与本机代理，没有绕回服务那条路。若只断言「进程起来了」，
 * 一条偷偷走了远程 HTTP 的实现也能通过。
 *
 * **它不是单测**，所以不放 `test/*.test.mjs`（那是 node --test 的 glob）。跑法：
 *
 *     node --experimental-strip-types test/acceptance/t403-shell-launch.mjs
 *
 * 注意它会真的启动进程（跑的是 node 与一段临时脚本），几秒内自己退出。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'

import { runShellLaunchProfile } from '../../src/agent.ts'
import { configPathFor, loadServiceConfig, saveServiceConfig } from '../../src/config.ts'
import { apiLaunchModule } from '../../src/paths.ts'

/**
 * 干净暂存根。与 t402 同理：**不能用 `os.tmpdir()`** —— 经 ws-run.cmd 跑时它被指向
 * 工作区的 .tmp（就在 .ws-root 底下），而本脚本要验的正是「工作区完整时能加载代理」。
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

let failures = 0

function report(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 假上游：记录自己被访问了几次，且回显标记。 */
async function startFakeService(marker) {
  const hits = []
  const server = createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`)
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify({ marker }))
  })
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  return {
    hits,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  }
}

/**
 * 一段会自报家门的「程序」：把收到的参数写进标记文件。
 *
 * 用 node 当被启动的可执行文件，是因为它是本机上一定存在、且行为可预期的绝对路径
 * —— 换成写一个 .cmd 会引入 shebang 与 shell 的变量，反而让失败原因变得不可读。
 */
function markerScript(markerPath) {
  return [
    "const { writeFileSync } = require('node:fs')",
    `writeFileSync(${JSON.stringify(markerPath)}, JSON.stringify(process.argv.slice(2)), 'utf8')`,
  ].join('\n')
}

/** 等标记文件出现，最多等 timeoutMs。返回其内容或 null。 */
async function waitForMarker(markerPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(markerPath, 'utf8')
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  return null
}

const scratch = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-t403-'))
const remote = await startFakeService('REMOTE')

try {
  console.log(`假上游（代表远程） ${remote.url}\n`)

  // ---- 准备：工作区里指向「远程」的服务地址配置
  await saveServiceConfig(configPathFor(scratch), { serviceUrl: remote.url })
  const loaded = await loadServiceConfig({ workspaceRoot: scratch, env: {}, fromDir: scratch })
  report(
    '当前服务地址指向远程',
    loaded.source === 'file' && loaded.config.serviceUrl === remote.url,
    `${loaded.config.serviceUrl}（来源 ${loaded.source}）`,
  )

  // ---- 第一段：加载的是 api 那一份 agent 源码，不是拷贝
  const agentModule = await apiLaunchModule(process.cwd())
  report('加载到 api 的 agent 核心', typeof agentModule.runLaunchProfile === 'function')

  // ---- 第二段：**远程模式下**起本机进程，判据是标记文件真的出现
  const scriptPath = join(scratch, 'target.js')
  const markerPath = join(scratch, 'marker.json')
  await writeFile(scriptPath, markerScript(markerPath), 'utf8')

  const profile = {
    id: 'acc-remote-mode',
    software: 'custom',
    name: '验收用程序',
    executablePath: process.execPath,
    args: [scriptPath, '第一参数', '第二参数'],
    icon: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }

  const outcome = await runShellLaunchProfile(profile, agentModule)
  report(
    '远程模式下启动返回成功',
    outcome.ok === true,
    outcome.ok === false ? outcome.detail : `pid=${outcome.data.pid}`,
  )

  const marker = await waitForMarker(markerPath, 8000)
  report('被启动的程序真的跑起来了（标记文件出现）', marker !== null)
  if (marker !== null) {
    // 参数逐个对上，证明「启动配置」这条链路是完整的 —— 只证明进程起来了的话，
    // 一个无视参数、把 cwd 当参数传的错实现也能通过。
    // 注意偏移：`node script.js a b` 的 argv[1] 是脚本路径本身，所以脚本里
    // `slice(2)` 拿到的正好是配置里的那两个参数。
    const received = JSON.parse(marker)
    report(
      '参数原样传到了被启动的程序',
      Array.isArray(received) &&
        received.length === 2 &&
        received[0] === '第一参数' &&
        received[1] === '第二参数',
      JSON.stringify(received),
    )
  }

  // ---- 第三段：**没有绕回服务那条路**（这是「本机代理内置」的核心）
  // 假上游一次都没被访问，才说明进程是主进程直接起的，而不是让远程服务去起。
  report('启动没有绕经远程服务', remote.hits.length === 0, `远程被访问 ${remote.hits.length} 次`)

  // ---- 第四段：复核不过的形态，压根不碰进程（这条边界在外壳上同样成立）
  const before = remote.hits.length
  const bad = await runShellLaunchProfile({ ...profile, executablePath: 'node.exe' }, agentModule)
  report(
    '相对路径被主进程挡下',
    bad.ok === false && bad.reason === 'invalid_profile',
    bad.ok === false ? bad.detail : '',
  )
  const missing = await runShellLaunchProfile(
    { ...profile, id: 'acc-missing', executablePath: join(scratch, '不存在.exe') },
    agentModule,
  )
  report(
    '路径不存在被归为 executable_missing（与形态不对分开）',
    missing.ok === false && missing.reason === 'executable_missing',
    missing.ok === false ? missing.detail : '',
  )
  report('失败路径同样没碰远程服务', remote.hits.length === before)

  // ---- 第五段：连点去重在主进程这条链路上生效（同一个 id 第二次不再起进程）
  // 去重表在 agent 模块作用域上，而外壳每次 IPC 都重新 import —— 这条正是
  // 「同 URL 拿同一实例」那个前提的兑现。
  const dedupeId = `acc-dedupe-${Date.now()}`
  const first = await runShellLaunchProfile({ ...profile, id: dedupeId }, agentModule)
  const second = await runShellLaunchProfile({ ...profile, id: dedupeId }, agentModule)
  report(
    '连点第二次被去重，没有再起一个进程',
    first.ok === true &&
      second.ok === true &&
      second.data.deduplicated === true &&
      second.data.pid === first.data.pid,
    second.ok === true ? `deduplicated=${second.data.deduplicated}` : '',
  )
} finally {
  await remote.close()
  await rm(scratch, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  process.exitCode = failures === 0 ? 0 : 1
}
