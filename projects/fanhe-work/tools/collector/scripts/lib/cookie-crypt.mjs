/**
 * Chromium/CEF cookie 解密（v10 / v11，AES-256-GCM）。
 *
 * 为什么要自己解
 *   千牛的 CEF 与 Edge 用的是同一套 cookie 加密：AES-256-GCM，密钥由 Windows
 *   DPAPI 保护后存在 profile 根的 `Local State` 里。解出密钥后就能把千牛里
 *   已登录的 .taobao.com 会话搬到采集浏览器，省掉每店扫码。
 *
 * 格式（Chromium 80+ 至今）
 *   [3 字节前缀 "v10"][12 字节 nonce][密文][16 字节 GCM tag]
 *
 * 一个容易踩的细节
 *   Chromium 130 起，明文前面会多 32 字节的 SHA256(host_key)（domain bound
 *   cookie）。不剥掉它，解出来的值前面会带一串乱码，而接口只会报「未登录」，
 *   看不出是解密的问题。所以这里按 host_key 的哈希比对后剥离，比对不上就原样返回
 *   —— 不猜，宁可让调用方看到长度异常。
 */
import crypto from 'node:crypto'

/** 解密单条 cookie 的 encrypted_value。返回 { ok, value } 或 { ok:false, reason }。 */
export function decryptCookieValue(encrypted, key, hostKey = '') {
  if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) {
    return { ok: false, reason: 'empty' }
  }
  const prefix = encrypted.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10' && prefix !== 'v11') {
    return { ok: false, reason: 'unknown-prefix:' + JSON.stringify(prefix) }
  }
  if (encrypted.length < 3 + 12 + 16) {
    return { ok: false, reason: 'too-short:' + encrypted.length }
  }

  const nonce = encrypted.subarray(3, 15)
  const tag = encrypted.subarray(encrypted.length - 16)
  const ciphertext = encrypted.subarray(15, encrypted.length - 16)

  let plain
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
    decipher.setAuthTag(tag)
    plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (e) {
    return { ok: false, reason: 'gcm:' + e.message }
  }

  /* domain bound cookie：明文前 32 字节 = SHA256(host_key) */
  if (plain.length > 32 && hostKey) {
    const expected = crypto.createHash('sha256').update(hostKey).digest()
    if (plain.subarray(0, 32).equals(expected)) {
      plain = plain.subarray(32)
    }
  }

  return { ok: true, value: plain.toString('utf8') }
}

/**
 * 从 Local State 的 os_crypt.encrypted_key 解出 AES 密钥。
 * `dpapiUnwrap` 由调用方注入（Node 没有内置 DPAPI，PowerShell 侧解好后传进来）。
 * 这里只负责剥掉 5 字节 "DPAPI" 前缀并校验长度。
 */
export function stripDpapiPrefix(encryptedKeyB64) {
  const buf = Buffer.from(encryptedKeyB64, 'base64')
  if (buf.length <= 5) throw new Error('encrypted_key 太短：' + buf.length)
  const prefix = buf.subarray(0, 5).toString('latin1')
  if (prefix !== 'DPAPI') {
    throw new Error('不是 DPAPI 包装的密钥（前缀 ' + JSON.stringify(prefix) + '），可能是 app-bound 加密')
  }
  return buf.subarray(5)
}
