/**
 * 把千牛导出的 cookie 注入某个店铺的采集浏览器 profile。
 *
 * 为什么用 CDP 而不是直接写 Cookies 库
 *   写 SQLite 要自己处理加密（AES-GCM + Local State 密钥）、库版本、WAL、
 *   以及「Edge 必须关闭」的锁。而 CDP 的 Network.setCookie 是浏览器自己的
 *   官方接口，加密、持久化、同源策略都由它处理 —— 少一层自己实现的加密，
 *   就少一类「写进去了但浏览器读不出来」的故障。
 *
 * 用法
 *   node scripts/shop-cookie-inject.mjs --shop s2                    # 注入并验证
 *   node scripts/shop-cookie-inject.mjs --shop s2 --no-verify        # 只注入
 *
 * 前置：该店铺的 Edge 已经起来（scripts/shop-login.ps1 -Shop s2 -Keep），
 *       cookie 文件来自 scripts/shop-cookie-export.ps1。
 *
 * 退出码：0 注入成功且验证为已登录；2 注入成功但验证未通过；1 无法注入
 */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveShop } from './lib/shops.mjs'
import { checkLogin } from './lib/login-check.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BASE = 'https://sycm.taobao.com'

const argv = process.argv.slice(2)
function option(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? fallback : v
}

const shopCode = option('shop')
if (!shopCode) {
  console.error('用法：--shop <code> [--cookies <file>] [--no-verify]')
  process.exit(1)
}

let shop
try {
  shop = resolveShop(shopCode)
} catch (e) {
  console.error(e.message)
  process.exit(1)
}

const cookiesFile = option('cookies', path.join(ROOT, '.secrets', `${shop.code}-cookies.json`))
if (!fs.existsSync(cookiesFile)) {
  console.error(`cookie 文件不存在：${cookiesFile}`)
  console.error('  先跑 scripts/shop-cookie-export.ps1 -Shop ' + shop.code)
  process.exit(1)
}

const payload = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'))
const cookies = Array.isArray(payload.cookies) ? payload.cookies : []
if (cookies.length === 0) {
  console.error('cookie 文件里没有条目')
  process.exit(1)
}

const port = Number(option('port') ?? shop.port)
const verify = !argv.includes('--no-verify')

function req(method, p) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method }, (res) => {
      let d = ''
      res.on('data', (c) => (d += c))
      res.on('end', () => resolve({ status: res.statusCode, body: d }))
    })
    r.on('error', reject)
    r.setTimeout(8000, () => r.destroy(new Error('timeout ' + p)))
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

/* CDP 的 sameSite 只认三个值，大小写敏感；'Unspecified' 表示不传 */
const SAME_SITE = { None: 'None', Lax: 'Lax', Strict: 'Strict' }

async function main() {
  /* 端口必须先活着：没起 Edge 就注入，等于往空气里写 */
  try {
    await req('GET', '/json/version')
  } catch (e) {
    console.error(`端口 ${port} 连不上（${e.message}）。先起 Edge：`)
    console.error(`  powershell -ExecutionPolicy Bypass -File scripts/shop-login.ps1 -Shop ${shop.code} -Keep`)
    process.exit(1)
  }

  const created = JSON.parse((await req('PUT', '/json/new?' + encodeURIComponent('about:blank'))).body)
  const conn = await connect(created.webSocketDebuggerUrl)
  let okCount = 0
  const failed = []
  try {
    await conn.send('Network.enable')

    for (const c of cookies) {
      const params = {
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        secure: Boolean(c.secure),
        httpOnly: Boolean(c.httpOnly),
      }
      if (Number.isFinite(c.expires) && c.expires > 0) params.expires = c.expires
      const ss = SAME_SITE[c.sameSite]
      if (ss) params.sameSite = ss

      try {
        const r = await conn.send('Network.setCookie', params)
        if (r?.success === false) failed.push({ name: c.name, domain: c.domain, reason: 'rejected' })
        else okCount += 1
      } catch (e) {
        failed.push({ name: c.name, domain: c.domain, reason: e.message })
      }
    }

    if (!verify) return { code: okCount > 0 ? 0 : 1 }

    /* 验证：导航到生意参谋，用与采集器相同的判据看是否已是登录态 */
    await conn.send('Page.enable')
    await conn.send('Page.navigate', { url: BASE + '/' })
    await sleep(Number(process.env.VERIFY_WAIT || 10000))
    const pf = await checkLogin(conn.send)
    return {
      code: pf.ok ? 0 : 2,
      verified: pf.ok,
      reason: pf.reason,
      href: pf.href,
      title: pf.title,
    }
  } finally {
    conn.close()
    try {
      await req('GET', '/json/close/' + created.id)
    } catch {
      /* 标签关不掉不影响结论 */
    }
  }
}

const result = await main()

console.log(`店铺 ${shop.code}（${shop.name}）  端口 ${port}`)
console.log(`注入 ${okCount}/${cookies.length} 条 cookie`)
if (failed.length) {
  console.log(`失败 ${failed.length} 条：`)
  for (const f of failed.slice(0, 10)) console.log(`  ${f.domain} ${f.name}  ${f.reason}`)
}
if (result.verified !== undefined) {
  if (result.verified) {
    console.log('验证：已是登录态（可以直接采集）')
  } else {
    console.log('验证：仍是未登录 —— ' + result.reason)
    console.log('  ' + (result.title || '') + '  ' + (result.href || ''))
    console.log('  常见原因：cookie 过期（千牛里重新登录一次再导出）、或该账号本身没有这家店的权限')
  }
}

process.exit(result.code)
