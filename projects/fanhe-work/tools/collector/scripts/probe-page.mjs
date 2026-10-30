/**
 * 抓一个页面实际发出的接口请求。
 *
 * 为什么要有这个
 *   平台把数据接口藏得很深：页面 HTML 里看不到，`tb sycm api <path>` 要你先知道
 *   路径才能试。以前只能让人在浏览器里按 F12、翻 Network、把 URL 抄出来，一次
 *   问一个接口，问一次人就得配合一次。
 *
 *   这个脚本把那一手变成可重复的动作：给一个 URL，它开页面、让它自己跑完 JS、
 *   把期间发出的 XHR/Fetch 全记下来，连同状态码与响应大小。拿到清单之后，再用
 *   `scripts\sycm.cmd api <path>` 逐条验证是不是要的那个。
 *
 * 前提
 *   浏览器必须带着 `--remote-debugging-port=<port>` 启动。注意 **不能同时带
 *   `--load-extension`** —— 实测（Edge 156，2026-10-30）：带扩展加载时进程活着、
 *   但调试端口根本不会监听，`netstat` 里连影子都没有。插件要装就装进 profile
 *   （edge://extensions 手动加载一次），不要靠命令行加载。
 *
 * 用法
 *   node scripts/probe-page.mjs --port 9222 --url "https://sycm.taobao.com/..."
 *   node scripts/probe-page.mjs --url "..." --wait 25000 --json .tmp/probe.json
 *   node scripts/probe-page.mjs --url "..." --all        （连静态资源一起列）
 *
 * 退出码
 *   0 抓到了至少一条 XHR/Fetch
 *   3 页面没抓到任何 XHR/Fetch（多半是没登录被踢到登录页，或被重定向）
 *   1 连不上调试端口 / 参数不对
 */
import fs from 'node:fs'
import path from 'node:path'

function option(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = process.argv[i + 1]
  return v === undefined || v.startsWith('--') ? fallback : v
}

const port = option('port', '9222')
const url = option('url')
const waitMs = Number(option('wait', '20000'))
const outFile = option('json')
const showAll = process.argv.includes('--all')

if (!url) {
  console.error('缺 --url。用法：node scripts/probe-page.mjs --port 9222 --url <页面地址>')
  process.exit(1)
}

const base = `http://127.0.0.1:${port}`

/** 调试端口探活。连不上时报清楚是「没开」还是「开了但连不上」。 */
async function listTargets() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${base}/json/list`, { signal: controller.signal })
    return await response.json()
  } catch (error) {
    console.error(`连不上 ${base}：${error.message}`)
    console.error('浏览器得带 --remote-debugging-port 启动，且不要同时带 --load-extension（端口会失效）')
    process.exit(1)
  } finally {
    clearTimeout(timer)
  }
}

const targets = await listTargets()
let page = targets.find((t) => t.type === 'page')
if (!page) {
  const created = await fetch(`${base}/json/new?about:blank`, { method: 'PUT' })
  page = await created.json()
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
let nextId = 0
const pending = new Map()

function send(method, params = {}) {
  const id = (nextId += 1)
  const promise = new Promise((resolve) => pending.set(id, resolve))
  ws.send(JSON.stringify({ id, method, params }))
  return promise
}

/** requestId → 这条请求的账。响应与失败都是后到的，靠它把账补齐。 */
const requests = new Map()

ws.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message.result ?? {})
    pending.delete(message.id)
    return
  }
  const params = message.params ?? {}
  if (message.method === 'Network.requestWillBeSent') {
    requests.set(params.requestId, {
      url: params.request.url,
      method: params.request.method,
      type: params.type ?? 'Other',
      at: Date.now(),
    })
    return
  }
  if (message.method === 'Network.responseReceived') {
    const row = requests.get(params.requestId)
    if (row) {
      row.status = params.response.status
      row.mime = params.response.mimeType
      row.bodyBytes = params.response.encodedDataLength ?? null
    }
    return
  }
  if (message.method === 'Network.loadingFailed') {
    const row = requests.get(params.requestId)
    if (row) row.failed = params.errorText ?? 'failed'
  }
})

await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve)
  ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')))
})

await send('Network.enable')
await send('Page.enable')
await send('Page.navigate', { url })

/* 等到点就收工。不做「网络空闲」判断：这类后台页常年有心跳轮询，
   永远等不到空闲，会把简单的事拖成超时。 */
await new Promise((resolve) => setTimeout(resolve, waitMs))

const finalUrl = (await send('Runtime.evaluate', {
  expression: 'location.href',
  returnByValue: true,
})).result?.value

const rows = [...requests.values()]
const isData = (row) =>
  row.type === 'XHR' ||
  row.type === 'Fetch' ||
  /\.json(\?|$)/i.test(row.url) ||
  /\/api\/|\/mtop\/|\/h5\/|\.dop\.taobao/.test(row.url)
const interesting = (showAll ? rows : rows.filter(isData)).sort((a, b) => a.at - b.at)

console.log(`入口：${url}`)
console.log(`落点：${finalUrl ?? '(取不到)'}`)
console.log(finalUrl && finalUrl !== url ? '  ⚠ 发生了跳转，跳转后的页面上才有数据接口' : '')
console.log(`共 ${rows.length} 条请求，其中数据类 ${interesting.length} 条（等待 ${waitMs}ms）\n`)

for (const row of interesting) {
  const status = row.failed ? `FAIL ${row.failed}` : String(row.status ?? '-')
  const size = row.bodyBytes === null || row.bodyBytes === undefined ? '-' : String(row.bodyBytes)
  console.log(`[${status.padEnd(4)}] ${String(size).padStart(7)}B  ${row.type.padEnd(6)}  ${row.url.slice(0, 160)}`)
}

if (outFile) {
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify({ url, finalUrl, rows }, null, 1), 'utf8')
  console.log(`\n已写入 ${outFile}`)
}

ws.close()

/*
 * 判「有没有登录」不能数条数：未登录时页面照样会发几条（alicdn 的配置、埋点、
 * 登录页自己的 getValues.json），数出来是 3～5 条，看着像成功。**落点才是铁证**：
 * 要的页面如果被踢到 login.htm / havanalogin，那抓到的全是登录页的杂项，
 * 一条店铺数据都没有。所以这里单独判、单独退出码，不让它冒充成功。
 */
if (/login|passport|havanalogin/i.test(finalUrl ?? '')) {
  console.log('\n✗ 落点是登录页：这个 profile 没有有效登录态。')
  console.log('  上面那几条是登录页自己的杂项请求，不是店铺数据。')
  console.log('  处理：用 scripts\\start-plugin-edge.cmd 启动浏览器，在里面登录一次，')
  console.log('        cookie 会留在该 profile 里，之后再抓就不用登了。')
  process.exit(4)
}

process.exit(interesting.length > 0 ? 0 : 3)
