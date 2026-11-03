/**
 * 批量导入的**四层上限必须同源**。
 *
 * 2026-11-03 的「服务器超时」是三处数字互不相干造成的：
 *
 *   - 共享契约 `IMPORT_FILE_BYTES_MAX` = 8MB（真实台账 12.25MB，本来就在门槛外）；
 *   - nginx `client_max_body_size` = 20m（收得下 17MB 的 base64，于是「传完了」）；
 *   - api 路由 `bodyLimit` = 12MB（收不下 17MB，413）；
 *   - 客户端 `timeoutMs` = 90s（传完 17MB 的地方早就超时了）。
 *
 * 四个数字各自「看起来合理」，拼在一起就是「文件选完，转圈一分钟，报服务器超时」。
 * 这类问题在任何一层单独看都发现不了，所以钉一条跨文件的断言：**外层必须比内层宽**。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { QUOTE_LIMITS } from '@fanhe/shared'

const NGINX = readFileSync(new URL('../deploy/nginx.conf', import.meta.url), 'utf8')
const ROUTE = readFileSync(new URL('../../api/src/routes/quote.ts', import.meta.url), 'utf8')
const UPLOAD = readFileSync(new URL('../src/lib/quote-import-upload.ts', import.meta.url), 'utf8')
const DISPLAY = readFileSync(new URL('../src/lib/quote-import-display.ts', import.meta.url), 'utf8')

function megabytes(source, pattern, label) {
  const match = pattern.exec(source)
  assert.ok(match !== null, `找不到 ${label}`)
  return Number(match[1]) * 1024 * 1024
}

test('nginx 的请求体上限必须大于等于共享契约里的文件上限', () => {
  const nginxLimit = megabytes(
    NGINX,
    /client_max_body_size\s+(\d+)m;/,
    'apps/web/deploy/nginx.conf 里的 client_max_body_size',
  )
  assert.ok(
    nginxLimit >= QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX,
    `nginx 只收 ${String(nginxLimit / 1024 / 1024)}MB，而契约允许 ${String(
      QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX / 1024 / 1024,
    )}MB：nginx 会先回一张 HTML 的 413，前端只能显示「服务返回了无法解析的响应」`,
  )
})

test('nginx 的读超时必须比客户端自己的上限更宽', () => {
  const match = /QUOTE_IMPORT_UPLOAD_TIMEOUT_MS = ([\d_]+)/.exec(UPLOAD)
  assert.ok(match !== null, '客户端没有上传超时常量')
  const clientMs = Number(match[1].replaceAll('_', ''))
  const nginxSeconds = Number(/proxy_read_timeout\s+(\d+)s;/.exec(NGINX)?.[1])
  assert.ok(Number.isFinite(nginxSeconds), '找不到 proxy_read_timeout')

  assert.ok(
    nginxSeconds * 1000 >= clientMs,
    `nginx 读超时 ${String(nginxSeconds)} 秒 < 客户端 ${String(
      clientMs / 1000,
    )} 秒。中间这层会先断，用户看到的是 504 的 HTML 页，而不是我们写好的那句中文。`,
  )
})

test('api 的 bodyLimit 从共享常量推出来，不写死', () => {
  // 挂了两个地方：内容类型解析器一个、路由一个。写死数字的那一处一定会在
  // 某次调上限时被漏掉。
  const occurrences = ROUTE.split('QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX + 1024 * 1024').length - 1
  assert.ok(
    occurrences >= 2,
    `bodyLimit 只有 ${String(occurrences)} 处从常量推导。解析器与路由各要一处 —— 少的那处会写死。`,
  )
})

test('octet-stream 的解析器必须带 bodyLimit', () => {
  const start = ROUTE.indexOf("'application/octet-stream'")
  assert.ok(start !== -1, '没有注册 octet-stream 的解析器，原始字节上传会直接 415')
  const slice = ROUTE.slice(start, start + 400)
  assert.ok(slice.includes("parseAs: 'buffer'"), 'octet-stream 没有按 buffer 原样收')
  assert.ok(
    slice.includes('bodyLimit'),
    '「原样收字节」没有给上限：等于开了一个「一个请求把进程内存吃光」的入口',
  )
})

test('前端校验用的上限与契约同源', () => {
  assert.ok(
    DISPLAY.includes('QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX'),
    '前端的文件校验没有引用共享上限，两边会漂开',
  )
  // 文案里的数字也必须从常量来，否则改了上限、提示里还写着旧的那个。
  assert.ok(
    DISPLAY.includes('超过 ${String(limit)}MB'),
    '提示文案里的上限是写死的数字，改常量时它会留在旧值上',
  )
})
