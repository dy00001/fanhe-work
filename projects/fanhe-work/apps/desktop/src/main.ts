/**
 * Electron 外壳主进程入口。
 *
 * T4-01 的范围只有一件事：**让外壳打开并渲染出前端界面**。因此这里只做四步——
 * 起内置服务、开窗口、把窗口指向该服务、处理关闭与退出。业务代码一行不碰。
 *
 * ## 与前端的关系
 *
 * 外壳加载的是**构建产物**（`apps/web/dist`），不是开发服务器。产物由
 * `pnpm --filter @fanhe/web build` 生成，不入版本控制，因此每次开工前应先重建
 * 一次，否则加载到的是上一轮的界面。
 *
 * ## 服务地址
 *
 * `FANHE_SERVICE_URL` 决定 `/api` 反代到哪里。T4-01 只读环境变量，**T4-02 会把它
 * 变成可持久化的配置项**（本机地址 / 远程地址两档切换），届时这个常量会被替换，
 * 但「渲染进程始终访问自己的来源、由主进程决定上游」这条结构不变。
 *
 * ## 冒烟模式
 *
 * `--smoke` 用于自动化验证：窗口隐藏、加载完成后在渲染进程里探一次 DOM，把结果
 * 打到标准输出并按成败设置退出码。它让「外壳能渲染界面」这条验收可以被脚本断言，
 * 而不是只能靠人眼。**它不改变正常启动的任何行为。**
 */
import { app, BrowserWindow, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { startStaticServer, type StaticServerHandle } from './server.js'

/** 前端构建产物的绝对路径。`__dirname` 是 `apps/desktop/dist`。 */
const DIST_ROOT = resolve(__dirname, '../../web/dist')

/** `/api` 的反代目标。T4-02 会把它升级为可切换的配置。 */
const SERVICE_URL = process.env.FANHE_SERVICE_URL ?? 'http://127.0.0.1:8787'

const IS_SMOKE = process.argv.includes('--smoke')

/**
 * 渲染进程永远只加载本机回环上的内置服务，因此**不该经过任何代理**。
 *
 * 这台机器（以及 CI、不少公司网络）会带 `http_proxy` / `HTTPS_PROXY` 之类的
 * 环境变量或系统代理设置。一旦 Chromium 把 `127.0.0.1` 的请求也送去代理，代理
 * 无法回连本机端口，加载会以一个不含原因的 `ERR_FAILED (-2)` 结束 —— 看起来像
 * 外壳自己坏了。所有对外请求都由主进程的 Node 侧发出，Chromium 这一层不需要
 * 代理，直接关掉最省事。
 */
app.commandLine.appendSwitch('no-proxy-server')

let staticServer: StaticServerHandle | null = null
let shellOrigin = ''

/**
 * `console-message` 的参数形态在 Electron 各版本间变过（旧版是
 * `(event, level, message, …)`，新版是 `(event, details)`）。这里只用到「级别」与
 * 「文本」两项，于是把它收成一个宽松签名，两种形态都能解析，也就不必跟着版本改。
 */
type LooseWebContents = {
  on: (event: 'console-message', listener: (...args: unknown[]) => void) => void
}

/** 收渲染进程的 console 错误。用于冒烟模式判定「渲染层是否干净」。 */
function collectConsoleErrors(window: BrowserWindow, sink: string[]): void {
  const contents = window.webContents as unknown as LooseWebContents
  contents.on('console-message', (...args: unknown[]) => {
    const second = args[1]
    let level: string | undefined
    let message: string
    if (typeof second === 'object' && second !== null) {
      const details = second as { level?: string; message?: string }
      level = details.level
      message = details.message ?? ''
    } else {
      level = typeof second === 'number' ? String(second) : undefined
      message = typeof args[2] === 'string' ? args[2] : ''
    }
    if (level === 'error' || level === '3') sink.push(message)
  })
}

function buildWindow(visible: boolean): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: visible,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // 页面里的外链一律交给系统浏览器，不在外壳内开新窗口——外壳没有地址栏，
  // 在新窗口里打开的页面会变成一个回不去的孤岛。
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // 只允许在外壳自己的来源内导航。跳出这个来源的跳转同样交给系统浏览器，
  // 否则一次误点就会把外壳整页替换成外部站点。
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== shellOrigin) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  return window
}

async function bootstrap(): Promise<void> {
  if (!existsSync(DIST_ROOT)) {
    throw new Error(`未找到前端构建产物：${DIST_ROOT}。请先运行 pnpm --filter @fanhe/web build`)
  }

  staticServer = await startStaticServer({ root: DIST_ROOT, apiBaseUrl: SERVICE_URL })
  shellOrigin = `http://127.0.0.1:${staticServer.port}`

  if (IS_SMOKE) {
    await runSmoke()
    return
  }

  const window = buildWindow(true)
  await window.loadURL(`${shellOrigin}/`)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      const next = buildWindow(true)
      void next.loadURL(`${shellOrigin}/`)
    }
  })
}

/**
 * 冒烟：隐藏窗口加载一次，探渲染结果，打印一行结论后按成败退出。
 *
 * 判据是「`#root` 里有元素」——它同时证明了产物可加载、脚本可执行、React 完成了
 * 首次渲染。只看 HTTP 200 是不够的：那只能说明文件在，说明不了界面画出来了。
 */
async function runSmoke(): Promise<void> {
  const consoleErrors: string[] = []
  const window = buildWindow(false)
  collectConsoleErrors(window, consoleErrors)

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
    console.error(`[smoke] 加载失败 ${errorCode} ${errorDescription} ${validatedUrl}`)
  })

  await window.loadURL(`${shellOrigin}/`)

  const probe = (await window.webContents.executeJavaScript(
    `(() => {
       const root = document.getElementById('root')
       return {
         rendered: root ? root.childElementCount : 0,
         title: document.title,
         path: location.pathname,
         bridge: typeof window.fanheDesktop === 'object' && window.fanheDesktop !== null,
       }
     })()`,
    true,
  )) as { rendered: number; title: string; path: string; bridge: boolean }

  const ok = probe.rendered > 0 && consoleErrors.length === 0
  console.log(
    `[smoke] 渲染元素=${probe.rendered} 标题=${probe.title} 路径=${probe.path} ` +
      `预加载桥=${probe.bridge ? '有' : '无'} console错误=${consoleErrors.length}`,
  )
  for (const message of consoleErrors) console.error(`[smoke] console.error: ${message}`)
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'}`)

  app.exit(ok ? 0 : 1)
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('will-quit', () => {
  const server = staticServer
  staticServer = null
  if (server) void server.close().catch(() => undefined)
})

void app
  .whenReady()
  .then(bootstrap)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    app.exit(1)
  })
