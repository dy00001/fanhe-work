/**
 * 从千牛 CEF 的 cookie 库里导出 .taobao.com 会话，供采集浏览器复用登录态。
 *
 * 为什么要这一步
 *   四个店铺各有账号密码，逐个在浏览器里扫码是四次人工。而千牛客户端本来就
 *   已经登录着，它的 CEF cookie 与生意参谋同域（.taobao.com）。把这份会话搬到
 *   采集浏览器的 profile 里，sycm 打开就是登录态，密码只在千牛输一次。
 *
 * 前提（必须由调用方保证）
 *   ① 千牛实例已退出：CEF 运行期间对 Cookies 库持有独占锁，任何进程都读不到。
 *      关闭千牛不会丢 cookie（它在磁盘上），重启后仍是登录态。
 *   ② 已用 DPAPI 解出 Local State 里的 AES 密钥，32 字节，base64 存文件传入。
 *
 * 用法
 *   node scripts/export-qianniu-cookies.mjs \
 *     --db <Cookies 副本> --key-file <key.b64> --shop s2 \
 *     --source "qianniu instance_2" --out .secrets/s2-cookies.json
 *
 * 安全
 *   输出文件含明文 cookie，等同登录凭据。默认写进 .secrets/（已 gitignore），
 *   调用方负责用 icacls 收紧权限，用完即删。
 *
 * 退出码：0 导出成功且关键 cookie 齐全；2 导出成功但关键 cookie 缺失；1 无法导出
 */
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { decryptCookieValue } from './lib/cookie-crypt.mjs'

const argv = process.argv.slice(2)
function option(name, fallback = null) {
  const i = argv.indexOf(`--${name}`)
  if (i < 0) return fallback
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? fallback : v
}

const dbPath = option('db')
const keyFile = option('key-file')
const shopCode = option('shop')
const source = option('source', 'qianniu')
const outPath = option('out')

if (!dbPath || !keyFile || !outPath) {
  console.error('用法：--db <Cookies> --key-file <key.b64> --out <file> [--shop s2] [--source ...]')
  process.exit(1)
}
if (!fs.existsSync(dbPath)) {
  console.error('Cookies 库不存在：' + dbPath)
  process.exit(1)
}
if (!fs.existsSync(keyFile)) {
  console.error('密钥文件不存在：' + keyFile)
  process.exit(1)
}

const key = Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'base64')
if (key.length !== 32) {
  console.error(`密钥长度应为 32 字节，实际 ${key.length}。DPAPI 解出来的原始值不对。`)
  process.exit(1)
}

/* 生意参谋登录态必须的 cookie。缺任何一个，页面能打开但接口会报未登录。 */
const REQUIRED = ['cookie2', '_tb_token_', 'unb', 'sgcookie', '_l_g_', 'cna']

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare(
    `SELECT host_key, name, value, encrypted_value, path, expires_utc,
            is_secure, is_httponly, samesite
     FROM cookies
     WHERE host_key LIKE '%taobao.com' OR host_key LIKE '%tmall.com' OR host_key LIKE '%alicdn.com'
     ORDER BY host_key, name`,
  )
  .all()
db.close()

if (rows.length === 0) {
  console.error('库里没有淘系域名的 cookie。这个实例可能还没登录，或 profile 选错了。')
  process.exit(1)
}

/** Chromium 时间（1601-01-01 起微秒）→ Unix 秒 */
function toUnixSeconds(us) {
  const n = Number(us)
  if (!n) return -1
  return Math.floor(n / 1e6 - 11644473600)
}

const SAME_SITE = { [-1]: 'Unspecified', 0: 'None', 1: 'Lax', 2: 'Strict' }

const cookies = []
const failures = []
for (const r of rows) {
  let value = r.value
  /* v10 之后明文不再进 value 列，一律走 encrypted_value */
  if ((!value || value.length === 0) && r.encrypted_value) {
    const enc = Buffer.from(r.encrypted_value)
    const res = decryptCookieValue(enc, key, r.host_key)
    if (!res.ok) {
      failures.push({ host: r.host_key, name: r.name, reason: res.reason })
      continue
    }
    value = res.value
  }
  if (typeof value !== 'string' || value.length === 0) continue

  cookies.push({
    name: r.name,
    value,
    domain: r.host_key,
    path: r.path || '/',
    expires: toUnixSeconds(r.expires_utc),
    secure: Boolean(r.is_secure),
    httpOnly: Boolean(r.is_httponly),
    sameSite: SAME_SITE[Number(r.samesite)] ?? 'Unspecified',
  })
}

const names = new Set(cookies.map((c) => c.name))
const missing = REQUIRED.filter((n) => !names.has(n))

const payload = {
  shop: shopCode,
  source,
  exportedAt: new Date().toISOString(),
  note: '含明文登录凭据，等同密码。用完即删，不要提交、不要外发。',
  total: cookies.length,
  requiredMissing: missing,
  cookies,
}

fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })

console.log(`导出 ${cookies.length} 条 cookie（淘系域名），失败 ${failures.length} 条`)
console.log(`关键 cookie：命中 ${REQUIRED.length - missing.length}/${REQUIRED.length}${missing.length ? '，缺 ' + missing.join(', ') : ''}`)
if (failures.length) {
  const byReason = new Map()
  for (const f of failures) byReason.set(f.reason, (byReason.get(f.reason) ?? 0) + 1)
  console.log('失败原因：')
  for (const [reason, n] of byReason) console.log(`  ${n} 条  ${reason}`)
}
console.log('写入 ' + outPath)

process.exit(missing.length === 0 ? 0 : 2)
