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
 * 监听地址写死 `127.0.0.1`。这不是可配置项：它是外壳与自己的渲染进程之间的私有
 * 通道，一旦绑到 `0.0.0.0` 就等于把前端产物与整个 API 反代暴露到局域网，而这台
 * 机器上跑的是个人的工作数据。
 *
 * ## 端口是「按候选依次试」，不再一律交给系统
 *
 * 原来这里用 `port: 0` 让系统随机分配，理由是「外壳可能与开发期的 Vite（5173）或
 * API（8787）同机运行，固定端口迟早会撞上」。**那个理由本身没错，但代价被低估了**：
 * 端口属于 origin，而 localStorage 与 IndexedDB 按 origin 分区 —— 每次启动换一个
 * 端口，等于每次启动换一个存储分区，用户看到的是「设置丢了」（完整推导见
 * `shell-origin.ts` 的文件头）。
 *
 * 现在改成：调用方给一串**按优先级排好的**端口，依次试，最后一项通常是 `0`。
 * 于是「撞上就白屏」这个顾虑由候选链兜住，而**没有冲突时端口是稳定的** ——
 * 这正是「设置不丢」的全部实现。候选顺序由 `shell-origin.ts` 决定，这里只负责试。
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

/**
 * 反代读请求的上游超时。
 *
 * 20 秒的依据：前端对运营看板设了 15 秒（`OPS_READ_TIMEOUT_MS`），壳这边要比它宽，
 * 让前端的超时先触发 —— 用户看到的是「请求超时」，而不是一个来自网关的 504。
 * 壳这边的超时是兜底，防的是前端已经放弃、请求却还挂在 Node 里。
 */
const UPSTREAM_READ_TIMEOUT_MS = 20_000

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
  /**
   * 依次尝试的端口，按优先级排好。
   *
   * 不传等价于 `[0]`（完全交给系统分配，与 T4-01 的行为一致）。传了则以最后一项
   * 作为兜底 —— 通常调用方会把 `0` 放在末尾，本函数也会在末尾不是 `0` 时补一个，
   * 因为「端口全被占」不该让外壳起不来。
   *
   * **端口决定 origin，origin 决定存储分区**：顺序错了不会报错，只会让用户觉得
   * 设置丢了。改这里之前先读 `shell-origin.ts`。
   */
  preferredPorts?: readonly number[]
  /**
   * 反代读请求（GET / HEAD）的上游超时，毫秒。默认 `UPSTREAM_READ_TIMEOUT_MS`。
   *
   * 之所以做成可传：默认值是 20 秒，而超时这件事只有真的等过一次才算验过。
   * 测试里传 100 毫秒，才能在一个用例的时长内确认「卡住的上游会得到 504」。
   * 不做成环境变量：它是行为参数，不是部署参数，暴露给运维只会多一个配错的地方。
   */
  upstreamReadTimeoutMs?: number
}

export type StaticServerHandle = {
  /**
   * 实际监听的端口。
   *
   * 它可能不等于 `preferredPorts[0]`：前面几个被占时会顺延到后面那个，或者到 `0`
   * 让系统分配。调用方要判断「这次是不是换分区了」就得比这个值，而不是假设
   * 首选端口一定成功。
   */
  port: number
  /** 关闭服务并释放端口。重复调用是安全的。 */
  close: () => Promise<void>
}

/**
 * 起服务并返回实际端口。
 *
 * 按 `preferredPorts` 的顺序试，**只对「端口被占」与「没权限绑这个端口」顺延**：
 * 其余错误（例如地址非法）直接抛出去 —— 它们与「换一个端口」无关，顺延只会把
 * 真正的错误掩盖成一串没意义的尝试。
 *
 * 末尾兜底一个 `0`（系统分配）是刻意的：候选链全被占时，一个「看不到旧设置」的
 * 外壳仍然远好过一个起不来的外壳。
 */
export async function startStaticServer(options: StaticServerOptions): Promise<StaticServerHandle> {
  const root = resolve(options.root)
  const apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, '')
  const readTimeoutMs = options.upstreamReadTimeoutMs ?? UPSTREAM_READ_TIMEOUT_MS

  const server = createServer((request, response) => {
    // 单个请求出错不应拖垮整个服务，因此这里接住 Promise 的拒绝。
    void handleRequest(request, response, root, apiBaseUrl, readTimeoutMs)
  })

  const candidates = [...(options.preferredPorts ?? [])]
  if (candidates.length === 0) candidates.push(0)
  if (candidates[candidates.length - 1] !== 0) candidates.push(0)

  let lastError: unknown = null
  let listening = false
  for (const port of candidates) {
    try {
      await listenOnce(server, port)
      listening = true
      break
    } catch (error) {
      lastError = error
      if (!isRetryableListenError(error)) {
        await closeServer(server)
        throw error
      }
    }
  }

  if (!listening) {
    await closeServer(server)
    const detail = lastError instanceof Error ? lastError.message : String(lastError)
    throw new Error(`内置服务在 ${candidates.length} 个候选端口上都没能监听：${detail}`)
  }

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

/**
 * 试绑一次。
 *
 * 两个监听器都挂 `once` 并在对方触发时摘掉自己：`error` 之后 `listening` 不会再来，
 * 反之亦然，不摘的话失败那次留下的监听器会在下一次尝试时被再次触发（第一次的
 * 错误会被报成第二次的错误，排查方向直接跑偏）。
 */
function listenOnce(server: Server, port: number): Promise<void> {
  return new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      rejectListen(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      resolveListen()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

/**
 * 这个错误值不值得换下一个端口试。
 *
 * `EADDRINUSE` 是「这个号被占了」，`EACCES` 是「这个号不让你绑」（Windows 上特权
 * 端口、或被安全软件拦住），两者都能靠换号解决。其余错误换号解决不了。
 */
function isRetryableListenError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'EADDRINUSE' || code === 'EACCES'
}

/**
 * 关掉服务。
 *
 * `ERR_SERVER_NOT_RUNNING` 被当成成功：候选端口全试失败时调用方也要关一次，而那时
 * 服务**从来没监听上**，`close` 会以这个错误回绝。那不是「关不掉」，是「本来就没开」——
 * 把它当失败会让真正的错误（端口全占）被一个语义无关的关闭错误顶掉。
 */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      const code = (error as { code?: unknown } | null)?.code
      if (error && code !== 'ERR_SERVER_NOT_RUNNING') rejectClose(error)
      else resolveClose()
    })
  })
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  root: string,
  apiBaseUrl: string,
  readTimeoutMs: number,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await proxyToService(request, response, url, apiBaseUrl, readTimeoutMs)
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
  readTimeoutMs: number,
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

  /*
   * 读请求的上游超时。
   *
   * 为什么只给 GET / HEAD：备份、恢复、导出这类写请求的正常耗时可以到分钟级，
   * 给它们设一个「看起来合理」的上限会在正常使用时误杀，而且失败发生在写了
   * 一半的时候 —— 那比不设超时更难收拾。
   *
   * 为什么读请求必须有：没有超时时，上游卡住（进程活着但不回包，例如数据库连接
   * 池被占满）会让这个反代永远等下去，浏览器那边就是一个永不结束的请求。前端
   * 15 秒会自己放弃，但那个请求仍然挂在壳里，攒多了会把 Node 的连接占满。
   * 20 秒比前端的 15 秒宽：让前端的超时先触发，用户看到的是「请求超时」而不是
   * 网关错误，同时壳这边也有了兜底。
   */
  const isRead = method === 'GET' || method === 'HEAD'
  const controller = isRead ? new AbortController() : null
  let timer: ReturnType<typeof setTimeout> | null = null
  if (controller !== null) {
    timer = setTimeout(() => {
      controller.abort()
    }, readTimeoutMs)
    init.signal = controller.signal
  }

  try {
    const upstream = await fetch(target, init)

    const responseHeaders = new Headers()
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP_HEADERS.has(key) || STRIPPED_RESPONSE_HEADERS.has(key)) return
      responseHeaders.set(key, value)
    })

    // 读响应体也在超时窗口内：只给 fetch 计时会漏掉「响应头回来了、体一直不来」
    // 这种半通状态，而那正是上游被拖垮时最常见的形态。
    const payload = Buffer.from(await upstream.arrayBuffer())
    response.writeHead(upstream.status, Object.fromEntries(responseHeaders.entries()))
    response.end(payload)
  } catch (error) {
    if (controller !== null && controller.signal.aborted) {
      if (!response.headersSent) {
        response.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' })
      }
      response.end('上游服务没有在 20 秒内响应')
      return
    }
    throw error
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
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
