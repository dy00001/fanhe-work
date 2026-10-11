/**
 * 外壳内置的本地服务：托管前端构建产物，并把 `/api` 反代到服务地址。
 *
 * ## 为什么是「内置服务」而不是 `file://`
 *
 * 前端是 `BrowserRouter` 的单页应用，且服务端**没有 CORS**——开发期靠
 * `apps/web/vite.config.ts` 的 Vite 代理把 `/api` 桥到 `127.0.0.1:8787`，
 * 于是「页面与接口同源」这条前提从头到尾成立，服务端才从不需要 CORS。
 *
 * 若外壳改用 `file://` 直开 `dist/index.html`，页面来源会变成 `null`：
 * 一是 `fetch` 到 `http://127.0.0.1:8787` 成了跨域、会被拦；二是 `BrowserRouter`
 * 的深链（`/workbench/notes`）在 `file://` 下根本没有对应的文件。两条都得靠
 * 改业务代码（给 API 加 CORS、把路由换成 HashRouter）来救，代价远大于收益。
 *
 * 因此外壳自己在回环上起一个服务：`dist` 静态托管 + `/api/*` 反代。这样
 * `apps/web` 一行不用改、路由策略不变、单一来源保持，而且这正是 T4-02 需要的
 * 形状——「切换服务地址」就是换掉这里的 `apiBaseUrl`。
 *
 * ## 只绑回环
 *
 * 监听地址写死 `127.0.0.1`、端口用 `0` 交给系统分配。这不是可配置项：它是外壳
 * 与自己的渲染进程之间的私有通道，一旦绑到 `0.0.0.0` 就等于把前端产物与整个
 * API 反代暴露到局域网，而这台机器上跑的是个人的工作数据。
 */
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

/** 静态资源的类型表。只列产物里真会出现的扩展名，认不出的一律按二进制流回。 */
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

/** 逐跳首部，按 HTTP 语义不该被代理转发。 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * 反代时额外要丢掉的首部。
 *
 * `host` 由 fetch 按目标地址重写；`content-length` 由 fetch 按实际 body 重算
 * （原值可能与重新序列化后的长度不符）；`accept-encoding` 必须丢——Node 的
 * fetch 在自己决定压缩时才自动解压，一旦我们手工转发了这个首部，上游可能回
 * 压缩体而我们不会解开，渲染进程会拿到一段二进制垃圾。
 */
const STRIPPED_REQUEST_HEADERS = new Set(['host', 'content-length', 'accept-encoding'])

/** 同理，响应侧丢掉长度与编码，让 Node 按我们实际写出的字节重新计算。 */
const STRIPPED_RESPONSE_HEADERS = new Set([
  'content-length',
  'content-encoding',
  'transfer-encoding',
  'connection',
  'keep-alive',
])

export type StaticServerOptions = {
  /** 前端构建产物目录的绝对路径。 */
  root: string
  /** 反代目标，形如 `http://127.0.0.1:8787`。末尾斜杠会被归一掉。 */
  apiBaseUrl: string
}

export type StaticServerHandle = {
  /** 实际监听的端口。传入 0 由系统分配，这里把分配结果读回来。 */
  port: number
  /** 关闭服务并释放端口。重复调用是安全的。 */
  close: () => Promise<void>
}

/**
 * 起服务并返回实际端口。
 *
 * 用 `port: 0` 而不是固定端口：外壳可能与开发期的 Vite（5173）或 API（8787）
 * 同机运行，固定端口迟早会撞上，而撞上时的表现是「外壳白屏」，排查方向会先
 * 落到前端。交给系统分配则不存在这个可能。
 */
export async function startStaticServer(options: StaticServerOptions): Promise<StaticServerHandle> {
  const root = resolve(options.root)
  const apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '')

  const server = createServer((request, response) => {
    // 单个请求出错不应拖垮整个服务，因此这里接住 Promise 的拒绝。
    void handleRequest(request, response, root, apiBaseUrl)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolveListen()
    })
  })

  const address = server.address()
  if (address === null || typeof address === 'string') {
    await closeServer(server)
    throw new Error('内置服务未能取得监听端口')
  }

  return {
    port: address.port,
    close: () => closeServer(server),
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error)
      else resolveClose()
    })
  })
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  apiBaseUrl: string,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await proxyToService(request, response, url, apiBaseUrl)
      return
    }
    await serveStatic(request, response, root, url.pathname)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (!response.headersSent) {
      response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    }
    response.end(`内置服务处理失败：${detail}`)
  }
}

/**
 * 托管产物。
 *
 * 找不到文件时**只有无扩展名的路径**才回落到 `index.html`——那是单页应用的前端
 * 路由（`/workbench/notes` 之类）。带扩展名的路径（`/assets/index-xxx.js`）缺失
 * 就是真的缺资源，回落到 HTML 会让浏览器拿到一段 `text/html` 当脚本执行，报出
 * 一个与真实原因（构建产物不完整）无关的语法错误。
 */
async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  pathname: string,
): Promise<void> {
  const method = request.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'text/plain; charset=utf-8' })
    response.end('仅支持 GET 与 HEAD')
    return
  }

  const relative = decodePathname(pathname)
  const candidate = resolve(root, relative)
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('路径越界')
    return
  }

  const found = await statFile(candidate)
  if (found?.isFile()) {
    sendFile(request, response, candidate, found.size)
    return
  }

  if (extname(pathname) === '') {
    const fallback = resolve(root, 'index.html')
    const fallbackStat = await statFile(fallback)
    if (fallbackStat?.isFile()) {
      sendFile(request, response, fallback, fallbackStat.size)
      return
    }
  }

  response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('未找到')
}

function sendFile(
  request: IncomingMessage,
  response: ServerResponse,
  filePath: string,
  size: number,
): void {
  const contentType = MIME_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': String(size),
    // 产物文件名带内容哈希，可以长期缓存；`index.html` 不在此列，它必须每次
    // 回源，否则发版之后外壳会一直加载旧的入口。
    'cache-control': filePath.endsWith('index.html')
      ? 'no-store'
      : 'public, max-age=31536000, immutable',
  })

  if (request.method === 'HEAD') {
    response.end()
    return
  }

  const stream = createReadStream(filePath)
  stream.on('error', () => response.destroy())
  stream.pipe(response)
}

/**
 * 把 `/api` 转发到服务地址。
 *
 * body 先整体读进内存再转发：这里的请求体是登录、纪要、事件这些 JSON，量级在
 * 几十 KB 以内，流式转发要处理 `duplex: 'half'` 与背压，换来的收益在这个量级
 * 上量不出来，而多出来的分支是实打实的出错面。
 */
async function proxyToService(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  apiBaseUrl: string,
): Promise<void> {
  const method = request.method ?? 'GET'
  const target = `${apiBaseUrl}${url.pathname}${url.search}`

  const headers = new Headers()
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue
    const lower = key.toLowerCase()
    if (HOP_BY_HOP_HEADERS.has(lower) || STRIPPED_REQUEST_HEADERS.has(lower)) continue
    headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }

  const body = method === 'GET' || method === 'HEAD' ? undefined : await readBody(request)

  // `exactOptionalPropertyTypes` 下不能显式传 `body: undefined`，只能按需挂上。
  const init: RequestInit = { method, headers }
  if (body !== undefined) init.body = body

  const upstream = await fetch(target, init)

  const responseHeaders = new Headers()
  upstream.headers.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key) || STRIPPED_RESPONSE_HEADERS.has(key)) return
    responseHeaders.set(key, value)
  })

  const payload = Buffer.from(await upstream.arrayBuffer())
  response.writeHead(upstream.status, Object.fromEntries(responseHeaders.entries()))
  response.end(payload)
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolveBody(Buffer.concat(chunks)))
    request.on('error', rejectBody)
  })
}

/** 把 URL 路径转成相对路径；解码失败时退回到不解码的原值，而不是抛错。 */
function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return pathname.replace(/^\/+/, '')
  }
}

async function statFile(filePath: string) {
  try {
    return await stat(filePath)
  } catch {
    return null
  }
}
