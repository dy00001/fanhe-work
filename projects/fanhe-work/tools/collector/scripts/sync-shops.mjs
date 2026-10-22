/**
 * 绑定后自动同步：把「平台上的待同步店铺」变成「实际跑一轮采集」。
 *
 * ## 它解决的是哪一段
 *
 * 绑定入口只能写库与槽位表，它没有能力开浏览器（API 可能跑在容器里）。所以
 * 「绑定后自动同步」必须有第三个进程：本脚本。它做四件事：
 *
 *   1. 轮询 `GET /api/ops/shops/pending`，拿到被请求过同步的店铺代号。
 *   2. 逐店跑既有的 `collect-daily.mjs`（CDP 旁路录制，不重写采集逻辑）。
 *   3. 跑既有的 `export-daily-ingest.mjs`，把原始响应转成入库契约并 POST。
 *   4. 把登录态与失败原因回写 `POST /api/ops/shops/<code>/state`。
 *
 * ## 为什么用轮询而不是「平台直接调采集器」
 *
 * 采集器必须能在平台不可达时继续按本地配置跑（`tools/collector/README.md` 的
 * 边界）。反过来也成立：平台不能假设采集器在线。轮询把两者解耦成一个「提示」，
 * 丢了就等下一次定时，不会因为一次投递失败而卡住。
 *
 * ## 失败怎么分类
 *
 * 每一条失败都对应一个**人能直接动作**的结论，而不是一句「同步失败」：
 *
 *   - 端口不通 → 采集浏览器没启动，去跑 `shop-login.ps1`
 *   - 退出码 3 → 登录态失效，去采集浏览器里登录一次
 *   - 退出码 4 → 页面没加载出来，查 Edge / 端口 / 首启向导（不要重新登录）
 *   - 槽位缺失 → 绑定只写进了库，把提示的片段补进 `shops.config.json`
 *
 * 用法
 *   node scripts/sync-shops.mjs                 处理全部待办
 *   node scripts/sync-shops.mjs --dry-run       只列出待办，不采集（排查用）
 *   node scripts/sync-shops.mjs --date 2026-10-19
 *   node scripts/sync-shops.mjs --code s2       只处理指定店铺（忽略待办列表）
 *   node scripts/sync-shops.mjs --watch 60      常驻轮询，每 60 秒一轮（默认 60）
 *   node scripts/sync-shops.mjs --transport local   强制走 DB 直连（容器化默认）
 *
 * 传输方式
 *   auto（默认）先试 HTTP；容器化之后回环校验会返回 forbidden_origin，自动切到 local。
 *   http  走 `POST /api/ops/ingest` 与 `GET /api/ops/shops/pending`（本机开发态）
 *   local 走 `apps/api` 下的三个 CLI，直连数据库（容器栈的常规形态）
 *
 * 环境变量
 *   OPS_API_BASE      默认 http://127.0.0.1:8787
 *   OPS_INGEST_TOKEN  与 API 的采集密钥一致；不给时读仓库根的 `.env.compose`
 *
 * 退出码
 *   0 全部处理完成（含「已回写失败原因」的情况）
 *   2 至少一家店在这一轮里失败（原因已回写平台）
 *   3 前置不满足：没有 token、API 不可达
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveShop, outRootOf } from './lib/shops.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API_BASE = String(process.env.OPS_API_BASE || 'http://127.0.0.1:8787').replace(/\/$/, '')

/**
 * 采集密钥。环境变量优先，其次读仓库根的 `.env.compose`。
 *
 * 为什么要读那个文件：容器栈的密钥就配在那里（`OPS_INGEST_TOKEN=`），而计划任务
 * 通常不带环境变量启动。让两个进程各配一份，迟早会出现「界面说在同步、采集器
 * 一直 401」——密钥不一致的表现是静默失败，不是报错。
 */
function readToken() {
  const fromEnv = String(process.env.OPS_INGEST_TOKEN || '').trim()
  if (fromEnv !== '') return fromEnv
  const envFile = path.resolve(ROOT, '..', '..', '.env.compose')
  try {
    const line = fs
      .readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .find((item) => item.startsWith('OPS_INGEST_TOKEN='))
    if (line === undefined) return ''
    return line.slice('OPS_INGEST_TOKEN='.length).trim()
  } catch {
    return ''
  }
}
const TOKEN = readToken()

const argv = process.argv.slice(2)
const has = (name) => argv.includes(`--${name}`)
const value = (name) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

const DRY_RUN = has('dry-run')
const ONLY_CODE = value('code') ?? ''

/**
 * 常驻轮询的间隔。0 表示只跑一轮。
 *
 * 60 秒的依据：绑定后要「一分钟内看到数据」，而一轮采集本身要几十秒，轮询再密
 * 没有意义。轮询只是发现待办，不承担采集节奏。
 */
const API_DIR = path.resolve(ROOT, '..', '..', 'apps', 'api')
const TSX = path.join(API_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')

/**
 * 传输方式。`auto` 会在 HTTP 被拒时自动降级。
 *
 * 为什么必须有 local：容器化之后宿主机经 `127.0.0.1:8787` 进来，容器看到的源
 * 地址是 docker 网关，`isLoopbackAddress` 判否，采集入口按设计返回 403。这不是
 * 配置错误，而是那条校验不打算接受跨网络边界的调用。采集器又必须跑在宿主机上
 * （要连本机 Edge 的调试端口），所以它永远在边界之外。
 */
let TRANSPORT = ['auto', 'http', 'local'].includes(String(value('transport')))
  ? String(value('transport'))
  : 'auto'

const WATCH_SECONDS = (() => {
  if (!has('watch')) return 0
  const raw = Number(value('watch'))
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 3600) : 60
})()

function yesterday() {
  const d = new Date()
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const TARGET_DATE = value('date') ?? yesterday()

async function api(pathname, init = {}) {
  const response = await fetch(`${API_BASE}${pathname}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-ops-token': TOKEN,
      ...(init.headers ?? {}),
    },
  })
  const text = await response.text()
  let payload = null
  try {
    payload = text === '' ? null : JSON.parse(text)
  } catch {
    payload = null
  }
  return { status: response.status, payload, text }
}

/** 子进程跑既有脚本。输出直接透传，出问题时日志就是现场。 */
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', script), ...args], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', (error) => {
      console.error(`[sync] 启动 ${script} 失败：${error.message}`)
      resolve(-1)
    })
    child.on('exit', (code) => resolve(code ?? -1))
  })
}

/**
 * 跑 tsx CLI 并捕获 stdout（待办列表要从输出里解析）。
 *
 * **每个片段都要自己加引号。** Windows 上 `tsx` 是 `.cmd`，必须经 cmd.exe 启动；
 * 而本仓库路径含空格（`E://fanhe Work\...`），`spawn(TSX, args, {shell:true})`
 * 拼出来的命令行不会给可执行文件加引号，cmd 会把 `E://fanhe` 当成命令名并报
 * 「不是内部或外部命令」。实测踩过一次，报错还带着乱码，很容易误判成编码问题。
 */
function runTsx(args) {
  const line = [TSX, ...args].map((item) => `"${item}"`).join(' ')
  return new Promise((resolve) => {
    const child = spawn(line, [], {
      cwd: API_DIR,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }))
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

/** 端口探活。先探再采，能把「浏览器没开」与「登录失效」分开报。 */
async function portAlive(port) {
  if (!Number.isInteger(port) || port <= 0) return false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal })
      return response.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

function readPreflight(code) {
  const file = path.join(outRootOf(code), '_preflight.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

async function report(code, body) {
  if (TRANSPORT === 'local') {
    const file = path.join(ROOT, '.tmp', `shop-state-${code}.json`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ code, ...body }), 'utf8')
    const result = await runTsx([path.join('src', 'tools', 'ops-shop-state.ts'), file])
    if (result.code !== 0) {
      console.error(`[sync] 回写状态失败 ${code}：${result.stderr.trim().slice(0, 300)}`)
    }
    return
  }
  const result = await api(`/api/ops/shops/${encodeURIComponent(code)}/state`, {
    method: 'POST',
    body: JSON.stringify({ code, ...body }),
  })
  if (result.status >= 300) {
    console.error(`[sync] 回写状态失败 ${code}：HTTP ${result.status} ${result.text.slice(0, 200)}`)
  }
}

async function pendingCodesLocal() {
  const result = await runTsx([path.join('src', 'tools', 'ops-shop-pending.ts'), '--limit', '5'])
  if (result.code !== 0) {
    console.error(`[sync] 读取待办失败：${result.stderr.trim().slice(0, 300)}`)
    return null
  }
  const line = result.stdout.trim().split(/\r?\n/).pop() ?? ''
  try {
    const parsed = JSON.parse(line)
    return Array.isArray(parsed?.codes) ? parsed.codes : []
  } catch {
    console.error(`[sync] 待办输出无法解析：${line.slice(0, 200)}`)
    return null
  }
}

async function pendingCodes() {
  if (ONLY_CODE !== '') return [ONLY_CODE]
  if (TRANSPORT === 'local') return pendingCodesLocal()

  const result = await api('/api/ops/shops/pending?limit=5')
  if (result.status === 401 || result.status === 403 || result.status === 503) {
    if (TRANSPORT === 'http') {
      console.error(
        `[sync] 待办接口拒绝（HTTP ${result.status}）：${
          result.payload?.message ?? '检查 OPS_INGEST_TOKEN'
        }`,
      )
      return null
    }
    /* auto：容器化之后这是常态（回环校验看到的是 docker 网关），切 DB 直连。 */
    console.log(`[sync] 待办接口不可用（HTTP ${result.status}），切换为 DB 直连`)
    TRANSPORT = 'local'
    return pendingCodesLocal()
  }
  if (result.status >= 300) {
    console.error(`[sync] 拉取待办失败：HTTP ${result.status} ${result.text.slice(0, 200)}`)
    return null
  }
  return Array.isArray(result.payload?.codes) ? result.payload.codes : []
}

async function runOnce() {
  if (TOKEN === '') {
    console.error('[sync] 缺少 OPS_INGEST_TOKEN，无法访问采集接口')
    return 3
  }

  const codes = await pendingCodes()
  if (codes === null) return 3
  if (codes.length === 0) {
    console.log('[sync] 没有待同步的店铺')
    return 0
  }

  console.log(`[sync] 待处理 ${codes.length} 家：${codes.join('、')}（业务日 ${TARGET_DATE}）`)
  if (DRY_RUN) return 0

  let failed = 0
  for (const code of codes) {
    let shop
    try {
      shop = resolveShop(code)
    } catch (error) {
      /* 绑定写进了库，但槽位没写进文件（容器部署或文件只读）。这是可修的配置问题，
         报清楚该补什么，比一句「未知店铺」有用。 */
      const message = `采集槽位缺失：${error instanceof Error ? error.message : String(error)}`
      console.error(`[sync] ${code} ${message}`)
      await report(code, {
        loginState: 'unknown',
        lastSyncError: message.slice(0, 480),
        collectedAt: null,
        clearSyncRequest: true,
      })
      failed += 1
      continue
    }

    if (!(await portAlive(shop.port))) {
      const message = `采集浏览器未启动（端口 ${shop.port} 无响应），先跑 scripts/shop-login.ps1 -Shop ${code}`
      console.error(`[sync] ${code} ${message}`)
      await report(code, {
        loginState: 'unknown',
        lastSyncError: message.slice(0, 480),
        collectedAt: null,
        clearSyncRequest: true,
      })
      failed += 1
      continue
    }

    console.log(`[sync] ---- ${code} 采集 ${TARGET_DATE} ----`)
    const collectCode = await run('collect-daily.mjs', ['--shop', code, '--date', TARGET_DATE])

    if (collectCode === 3) {
      const preflight = readPreflight(code)
      await report(code, {
        loginState: 'needs_login',
        lastSyncError: `登录态失效：${preflight?.reason ?? '采集器判定未登录'}`.slice(0, 480),
        collectedAt: null,
        clearSyncRequest: true,
      })
      failed += 1
      continue
    }
    if (collectCode === 4 || collectCode < 0) {
      /* 退出码 4 是「页面没加载出来」，与账号过期是两件事。回写 unknown 而不是
         needs_login，否则界面会引导人去重新登录一个其实没问题的账号。 */
      const preflight = readPreflight(code)
      await report(code, {
        loginState: 'unknown',
        lastSyncError: `页面未加载：${preflight?.reason ?? '控制标签停在空白页'}`.slice(0, 480),
        collectedAt: null,
        clearSyncRequest: true,
      })
      failed += 1
      continue
    }

    console.log(`[sync] ---- ${code} 导出并入库 ----`)
    const exportCode = await run('export-daily-ingest.mjs', [
      '--shop', code,
      '--date', TARGET_DATE,
    ])
    if (exportCode !== 0 && exportCode !== 2) {
      await report(code, {
        loginState: 'authenticated',
        lastSyncError: '采集完成但导出失败，检查 data/daily 下的原始响应是否完整'.slice(0, 480),
        collectedAt: null,
        clearSyncRequest: true,
      })
      failed += 1
      continue
    }

    const contractPath = path.join(ROOT, 'data', 'ingest', `ops-daily-${TARGET_DATE}.json`)
    if (!fs.existsSync(contractPath)) {
      await report(code, {
        loginState: 'authenticated',
        lastSyncError: `导出脚本没有产出契约文件：${path.relative(ROOT, contractPath)}`,
        collectedAt: null,
        clearSyncRequest: true,
      })
      failed += 1
      continue
    }

    let contract
    try {
      contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'))
    } catch (error) {
      await report(code, {
        loginState: 'authenticated',
        lastSyncError: `契约文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        collectedAt: null,
        clearSyncRequest: true,
      })
      failed += 1
      continue
    }

    const ingest =
      TRANSPORT === 'local'
        ? await (async () => {
            const result = await runTsx([path.join('src', 'tools', 'ops-import.ts'), contractPath])
            return {
              status: result.code === 0 ? 201 : 400,
              payload: null,
              text: result.code === 0 ? '' : result.stderr.trim(),
            }
          })()
        : await api('/api/ops/ingest', { method: 'POST', body: JSON.stringify(contract) })
    if (ingest.status >= 300) {
      await report(code, {
        loginState: 'authenticated',
        lastSyncError: `入库被拒绝：${String(ingest.payload?.message ?? ingest.text).slice(0, 400)}`,
        collectedAt: null,
        clearSyncRequest: true,
      })
      failed += 1
      continue
    }

    await report(code, {
      loginState: 'authenticated',
      lastSyncError: null,
      collectedAt: new Date().toISOString(),
      clearSyncRequest: true,
    })
    console.log(`[sync] ${code} 完成：${JSON.stringify(ingest.payload)}`)
  }

  return failed === 0 ? 0 : 2
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  if (WATCH_SECONDS === 0) return runOnce()

  let stopping = false
  process.on('SIGINT', () => {
    stopping = true
    console.log('[sync] 收到中断，当前轮结束后退出')
  })

  console.log(`[sync] 常驻模式，每 ${WATCH_SECONDS} 秒轮询一次（Ctrl+C 退出）`)
  while (!stopping) {
    const code = await runOnce()
    /* 前置不满足（没密钥、API 不可达）时退避重试：常驻进程不该因为平台重启而退出，
       但也不该每秒打一次同样的错误。 */
    const wait = code === 3 ? Math.max(WATCH_SECONDS, 30) : WATCH_SECONDS
    for (let slept = 0; slept < wait * 1000 && !stopping; slept += 500) await sleep(500)
  }
  return 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('[sync] 未捕获异常：', error)
    process.exit(2)
  })
