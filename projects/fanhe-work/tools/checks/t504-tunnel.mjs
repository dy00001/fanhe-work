// T5-04 的验收脚本：证明「外部网络可访问」与「源站无公网入站端口暴露」**同时**成立。
//
// ## 为什么这两个必须验在一起
//
// 阶段五的出口条件有两句，容易被当成一件事：
//
//   - 外部网络可访问
//   - 无公网入站端口暴露
//
// **它们是不同的性质，不是同一件事的两面。** 「能访问」可能是因为 Tunnel 通了，
// 也可能是因为有人给 web 加了 `ports: '0.0.0.0:8080:80'` —— 后者同样能访问，但
// 公网入站已经成立，而且**外部照样能访问，看起来一切正常**。
//
// 所以本脚本的核心判据是：**在 Tunnel 正常工作的前提下，源站仍然没有对外端口。**
// 只验「能访问」等于什么都没验。
//
// ## 三层判据，从便宜到贵
//
//   1. **配置层**：`cloudflared` 服务没有任何 `ports:`（读 `compose config` 的输出）
//   2. **运行时层**：`docker inspect` 的 `.NetworkSettings.Ports` 为空对象
//   3. **网络层**：从另一个容器网络去连宿主的 8787 / 8080 / 5432，都应连不上
//
// 第 3 层最有力也最慢 —— 它是唯一不依赖「Docker 的配置与运行态一致」这个假设的
// 判据。**前两层都能被「配置改了但容器没 recreate」骗过去**，第 3 层不会。
//
// ## 用法
//
//   node tools/checks/t504-tunnel.mjs
//   node tools/checks/t504-tunnel.mjs --offline    # 跳过需要公网的断言
//
// `--offline` 用于「机器没有外网」或「Tunnel 故意停着」的情形：那时第 4 组断言
// 必然失败，而那不是配置问题。**它只跳过公网相关的那几项，出站与端口判据照跑。**
//
// 退出码 0 = 全部通过，1 = 有断言失败（逐条打印，不中断整轮 —— 中断会让后面的断言
// 全部消失，看不出到底坏在哪几处）。

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

/** 向上找工作区根（不硬编码盘符 —— 工作区会在 E:/F: 之间搬）。 */
function findWorkspaceRoot(start) {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, '.ws-root'))) return current
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`从 ${start} 向上找不到 .ws-root，脚本假定它放在工作区的 tools\\ 下。`)
    }
    current = parent
  }
}

const workspaceRoot = findWorkspaceRoot(here)

const PUBLIC_HOST = process.env.FANHE_PUBLIC_HOST ?? 'work.fanhe.dpdns.org'
const TUNNEL_CONTAINER = 'fanhe-work-cloudflared'
/** 宿主上暴露的三个端口。它们都应绑 127.0.0.1，从容器网络外一律连不上。 */
const HOST_EXPOSED_PORTS = [
  { port: 8787, what: 'api' },
  { port: 8080, what: 'web' },
  { port: 5432, what: 'db' },
]

const offline = process.argv.includes('--offline')

let passed = 0
const failures = []

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
    return
  }
  failures.push(name)
  console.log(`  FAIL  ${name}${detail ? `  —— ${detail}` : ''}`)
}

function section(title) {
  console.log(`\n§${title}`)
}

/**
 * 走 ws-compose.cmd 而不是裸 docker compose —— 前者包住了 --env-file。
 *
 * **两条约束都是踩出来的：**
 *
 * 1. **必须带 `shell: true`。** 在 Windows 上 `execFile` 直接 spawn 一个 `.cmd`
 *    会抛 `spawn EINVAL`（CreateProcess 不能直接执行 .cmd）—— 那条报错完全看不出
 *    是「文件类型不能直接执行」而不是「命令失败」。
 * 2. **必须用相对路径，从工作区根调。** `ws-compose.cmd` 内部按相对位置找
 *    `--env-file`，传绝对路径（含空格，如 `F:\fanhe Work\...`）会被截断，
 *    报出来的是 `'F:\fanhe' 不是内部或外部命令` —— **报错指向一个看起来合法的
 *    路径，而真实原因是空格**。
 */
async function compose(args) {
  return run('infra\\portable\\ws-compose.cmd', args, {
    cwd: workspaceRoot,
    shell: true,
    maxBuffer: 32 * 1024 * 1024,
  })
}

async function docker(args, opts = {}) {
  return run('docker', args, { maxBuffer: 16 * 1024 * 1024, ...opts })
}

/** 取一个容器的某个 inspect 字段（模板由调用方给）。失败返回 null 而不抛。 */
async function inspectField(container, template) {
  try {
    const { stdout } = await docker(['inspect', '-f', template, container])
    return stdout.trim()
  } catch {
    return null
  }
}

async function fetchPublic(path, { timeoutMs = 30000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`https://${PUBLIC_HOST}${path}`, {
      signal: controller.signal,
      redirect: 'manual',
    })
    const body = await res.text()
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

// ── §1 环境前提 ──────────────────────────────────────────────────────────────
//
// 这些不是「产品对不对」，而是「这一轮验的东西有没有前提」。缺前提时把断言标成
// 跳过而不是失败 —— 否则「今天没开 Tunnel」会被报成「配置错了」，而那两件事的
// 处理方式完全不同。

section('1 环境前提')

let configOk = false
try {
  await compose(['config'])
  configOk = true
  check('compose 配置可解析（--env-file 里的变量齐了）', true)
} catch (error) {
  check(
    'compose 配置可解析（--env-file 里的变量齐了）',
    false,
    String(error.stderr ?? error).slice(0, 200),
  )
}

const tunnelRunning = (await inspectField(TUNNEL_CONTAINER, '{{.State.Status}}')) === 'running'
if (!tunnelRunning) {
  console.log(`  SKIP  ${TUNNEL_CONTAINER} 未运行 —— 与端口相关的断言仍会跑（它们不依赖 Tunnel）`)
}

if (offline) {
  console.log('  SKIP  --offline：跳过所有需要公网可达的断言')
}

// ── §2 配置层：cloudflared 没有 ports ─────────────────────────────────────────
//
// 读的是 `compose config` 的**展开后输出**，不是源文件 —— 源文件里没有 `ports:`
// 不代表展开后没有（锚点或 override 文件都可能带进来）。

section('2 配置层：Tunnel 服务未绑任何宿主端口')

if (configOk) {
  const { stdout } = await compose(['config', '--format', 'json'])
  const parsed = JSON.parse(stdout)
  const services = parsed.services ?? {}

  check('compose 里存在 cloudflared 服务', 'cloudflared' in services)

  const cf = services.cloudflared ?? {}
  // `ports` 缺失与 `ports: []` 都算「没绑」—— 展开后 compose 会补成数组。
  const ports = cf.ports ?? []
  check(
    'cloudflared 没有 ports 条目（配置层）',
    Array.isArray(ports) && ports.length === 0,
    ports.length ? JSON.stringify(ports) : '',
  )

  // 另外三个服务的端口必须仍绑 127.0.0.1。它们绑 0.0.0.0 就是公网入站，
  // **与 Tunnel 是否工作无关** —— 所以这项不放在「Tunnel 相关」的条件里。
  for (const svc of ['api', 'web', 'db']) {
    const list = services[svc]?.ports ?? []
    const bad = list.filter((p) => !String(p.host_ip ?? '').startsWith('127.'))
    check(
      `${svc} 的端口映射仍绑 127.0.0.1`,
      list.length > 0 && bad.length === 0,
      bad.length ? `有 ${bad.length} 条不是 127.x：${JSON.stringify(bad)}` : '',
    )
  }
}

// ── §3 运行时层：容器真的没绑端口 ────────────────────────────────────────────
//
// 这一层与 §2 分开是有意的：**改过 compose 而没 recreate 时，§2 会过而这里会不过。**
// 那正是「配置对、运行态不对」这类故障唯一能露出来的地方。

section('3 运行时层：运行中的容器未暴露端口')

const runtimePorts = await inspectField(TUNNEL_CONTAINER, '{{json .NetworkSettings.Ports}}')
if (runtimePorts === null) {
  check(`${TUNNEL_CONTAINER} 的运行时端口映射为空`, false, '容器不存在或 inspect 失败')
} else {
  check(
    `${TUNNEL_CONTAINER} 的运行时端口映射为空对象`,
    runtimePorts === '{}' || runtimePorts === 'null',
    runtimePorts,
  )
}

for (const { port, what } of HOST_EXPOSED_PORTS) {
  const mappings = await inspectField(`fanhe-work-${what}`, '{{json .NetworkSettings.Ports}}')
  const bound = (mappings ?? '{}').replace(/\s/g, '')
  check(
    `${what} 的 ${port} 只绑回环（运行时层）`,
    bound === 'null' || bound === '{}' || bound.includes('127.0.0.1'),
    mappings ?? 'inspect 失败',
  )
}

// ── §4 网络层：从另一个网络连宿主，探不到 ────────────────────────────────────
//
// **这一层是唯一不依赖「配置与运行态一致」这个假设的判据。** 前两层都可能被
// 「改了没 recreate」骗过去，这里不会 —— 它只问一个事实：这些端口从网络外到底
// 能不能连上。
//
// 走 `alpine` 的 `nc -z`（只探不发数据）。用默认 bridge 网络而不是 compose 的
// 网络：必须在**同一个容器能到宿主的网络**里问，而 compose 网络内的容器当然能
// 连到 web（那正是它该做的）—— 那样问等于没问。

section('4 网络层：从容器网络外探不到宿主端口')

try {
  // **用默认 bridge 网关的地址（172.17.0.1），不用 `host.docker.internal`。**
  // 后者在 Linux Docker 上解析到宿主网关，而宿主的服务绑的是 `127.0.0.1`
  // （只听回环）—— 于是「连不上回环」与「连不上网关」是两件事，探的是后者就
  // 探不到我们要问的那个。判据要问的是「从网络外能不能连上**那个监听**」。
  const probe = HOST_EXPOSED_PORTS.map(
    ({ port, what }) =>
      `nc -z -w 3 172.17.0.1 ${port} >/dev/null 2>&1 && echo "${what}:${port}=OPEN" || echo "${what}:${port}=CLOSED"`,
  ).join('; ')

  const { stdout } = await run(
    'docker',
    ['run', '--rm', '--network', 'bridge', '-e', 'NO_PROXY=*', 'alpine:latest', 'sh', '-c', probe],
    { maxBuffer: 8 * 1024 * 1024 },
  )

  for (const { port, what } of HOST_EXPOSED_PORTS) {
    check(
      `${what} 的 ${port} 从容器网络外不可达`,
      stdout.includes(`${what}:${port}=CLOSED`),
      `读到的是 ${stdout.includes(`${what}:${port}=OPEN`) ? 'OPEN（有入站暴露）' : '无输出'}`,
    )
  }
} catch (error) {
  for (const { port, what } of HOST_EXPOSED_PORTS) {
    check(
      `${what} 的 ${port} 从容器网络外不可达`,
      false,
      `探测容器跑不起来：${String(error.message).slice(0, 120)}`,
    )
  }
}

// ── §5 公网可达（Tunnel 生效的证据）─────────────────────────────────────────
//
// 这一组验的是**另一件事**：Tunnel 确实通了。它证明不了「没暴露」—— §2~§4 才
// 证那个。两组必须都在，缺一则结论不成立。

section('5 公网可达：Tunnel 确实在工作')

if (offline) {
  console.log('  SKIP  --offline')
} else if (!tunnelRunning) {
  for (const name of ['公网根路径可达', '公网深链回退', '公网 API 可达', '公网未授权被拦']) {
    console.log(`  SKIP  ${name}（Tunnel 容器未运行）`)
  }
} else {
  try {
    const root = await fetchPublic('/')
    check(
      `公网根路径可达（https://${PUBLIC_HOST}/）`,
      root.status === 200 && root.body.length > 0,
      `status=${root.status} len=${root.body.length}`,
    )

    const deep = await fetchPublic('/notes')
    check(
      '公网深链回退到 SPA（/notes 返回 200 页面）',
      deep.status === 200,
      `status=${deep.status}`,
    )

    const setup = await fetchPublic('/api/setup/status')
    let parsedOk = false
    try {
      const body = JSON.parse(setup.body)
      parsedOk = typeof body.initialized === 'boolean'
      check(
        '公网 API 可达且回的是 json（经 web 反代到 api）',
        setup.status === 200 && parsedOk,
        `status=${setup.status} body=${setup.body.slice(0, 120)}`,
      )
    } catch {
      check(
        '公网 API 可达且回的是 json（经 web 反代到 api）',
        false,
        `body 不是 json：${setup.body.slice(0, 120)}`,
      )
    }

    const me = await fetchPublic('/api/auth/me')
    check(
      '公网未授权访问被拦（401 + api 自己的文案）',
      me.status === 401 && me.body.includes('unauthorized'),
      `status=${me.status} body=${me.body.slice(0, 120)}`,
    )
  } catch (error) {
    check(
      '公网可达（Tunnel 是否在工作）',
      false,
      `请求失败：${String(error.message).slice(0, 140)}`,
    )
  }
}

// ── 汇总 ─────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`)
if (failures.length === 0) {
  console.log(`${passed} 项通过，0 失败`)
  if (offline) {
    // **offline 下不能打印「外部可访问」** —— 那一组根本没跑。印出来等于把
    // 「没验」说成「验过了」，而这正是验收脚本最不该有的失败模式。
    console.log('结论：源站无公网入站端口暴露。**公网可达性本轮未验证**（--offline）。')
  } else {
    console.log('结论：外部可访问，且源站无公网入站端口暴露。')
  }
  process.exit(0)
} else {
  console.log(`${passed} 项通过，${failures.length} 项失败：`)
  for (const name of failures) console.log(`  - ${name}`)
  console.log(`\n提示：「能访问」与「没暴露」是两个性质。只验前者等于没验后者。`)
  process.exit(1)
}
