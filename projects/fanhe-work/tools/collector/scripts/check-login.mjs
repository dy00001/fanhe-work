/**
 * 单店登录态检查：连某一家店自己的 Edge 调试端口，判这个账号现在能不能采。
 *
 * 为什么单独一个脚本
 *   `collect-daily.mjs` 的 preflight 只在「跑采集」时才知道登录态，而登录引导
 *   需要在采集之前先问一句「这家店现在是什么状态」。两边必须用同一套判据
 *   （lib/login-check.mjs），否则会出现「引导说登好了、采集说没登」。
 *
 * 用法
 *   node scripts/check-login.mjs --shop s2          # 用槽位表里的端口
 *   node scripts/check-login.mjs --port 9223        # 直接指定端口
 *   node scripts/check-login.mjs --shop s2 --json   # 只输出机器可读结果
 *
 * 退出码
 *   0 已登录，可以采集
 *   3 未登录 / 登录已失效（需要人登录一次）
 *   1 端口没起来或连不上（Edge 没启动，或端口被别的进程占着）
 */
import http from 'node:http'
import { resolveShop } from './lib/shops.mjs'
import { checkLogin } from './lib/login-check.mjs'

const BASE = 'https://sycm.taobao.com'
const argv = process.argv.slice(2)

function option(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? fallback : v
}

const jsonOnly = argv.includes('--json')

let shop = null
const shopCode = option('shop')
if (shopCode !== null) {
  try {
    shop = resolveShop(shopCode)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}

const port = Number(option('port') ?? shop?.port ?? 9222)
if (!Number.isInteger(port) || port <= 0) {
  console.error(`端口不合法：${option('port')}`)
  process.exit(1)
}

function req(method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    r.on('error', reject)
    r.setTimeout(5000, () => r.destroy(new Error('timeout ' + path)))
    r.end()
  })
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let seq = 0
    const pending = new Map()
    const timer = setTimeout(() => reject(new Error('WebSocket 连接超时')), 8000)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({ send, close })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket 连接失败'))
    })
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      const hit = pending.get(msg.id)
      if (hit !== undefined) {
        pending.delete(msg.id)
        msg.error ? hit.reject(new Error(msg.error.message)) : hit.resolve(msg.result)
      }
    })
    function send(method, params = {}) {
      return new Promise((res, rej) => {
        const id = ++seq
        pending.set(id, { resolve: res, reject: rej })
        ws.send(JSON.stringify({ id, method, params }))
      })
    }
    function close() {
      try {
        ws.close()
      } catch {
        /* 关不掉不影响结论 */
      }
    }
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  /* 端口活着吗。这一步失败与「没登录」是两件事：前者要起 Edge，后者要人登录。 */
  let version
  try {
    const v = await req('GET', '/json/version')
    version = JSON.parse(v.body)
  } catch (e) {
    return {
      ok: false,
      state: 'port-down',
      code: 1,
      reason: `端口 ${port} 连不上（${e.message}）。Edge 没启动，或端口被别的进程占着。`,
    }
  }

  let created = null
  try {
    created = JSON.parse((await req('PUT', '/json/new?' + encodeURIComponent(BASE + '/'))).body)
  } catch (e) {
    return {
      ok: false,
      state: 'port-down',
      code: 1,
      reason: `端口 ${port} 在，但开不出新标签（${e.message}）`,
    }
  }

  let conn = null
  try {
    conn = await connect(created.webSocketDebuggerUrl)
    /* 首页要时间把 SPA 与登录态都算出来，读太早会读到空白页被判成未登录 */
    await sleep(Number(process.env.LOGIN_WAIT || 9000))
    const pf = await checkLogin(conn.send)
    return {
      ok: pf.ok,
      state: pf.ok ? 'logged-in' : 'login-required',
      code: pf.ok ? 0 : 3,
      reason: pf.reason || '',
      href: pf.href,
      title: pf.title,
      textLength: pf.len,
      sample: (pf.text || '').replace(/\s+/g, ' ').slice(0, 160),
      browser: version.Browser,
    }
  } finally {
    if (conn !== null) conn.close()
    try {
      await req('GET', '/json/close/' + created.id)
    } catch {
      /* 标签关不掉不影响结论 */
    }
  }
}

const result = await main()
const payload = {
  checkedAt: new Date().toISOString(),
  shop: shop === null ? null : { code: shop.code, name: shop.name, port: shop.port },
  port,
  ...result,
}

if (jsonOnly) {
  console.log(JSON.stringify(payload))
} else {
  const label = shop === null ? `端口 ${port}` : `${shop.code}（${shop.name}）`;
  console.log(`店铺    ${label}`)
  console.log(`端口    ${port}${payload.browser ? '  ' + payload.browser : ''}`)
  console.log(`状态    ${payload.ok ? '已登录，可以采集' : '未登录 / 登录已失效'}`)
  if (payload.reason) console.log(`原因    ${payload.reason}`)
  if (payload.href) console.log(`页面    ${payload.title || ''}  ${payload.href}`)
  if (payload.sample) console.log(`正文    ${payload.sample}`)
}

process.exit(payload.code)
