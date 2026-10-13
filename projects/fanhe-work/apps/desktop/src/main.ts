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
 * ## 服务地址（T4-02）
 *
 * `serviceUrl` 决定 `/api` 反代到哪里。它从**工作区的配置文件**读
 * （`.config/fanhe-work/service.json`，见 `config.ts`），换机时带着工作空间走。
 *
 * 环境变量 `FANHE_SERVICE_URL` 保留为**一次性覆盖** —— 设了赢过文件，供开发与
 * 验证指向临时端点用；不设就读配置；配置也没有才退回缺省。
 *
 * 改配置**需要重启外壳**才生效，这是刻意的：反代的上游在起服务时确定，塞进一个
 * 运行中的 HTTP 服务里会带来「切了一半」的中间态，而那种状态在现场看起来与
 * 「切失败了」难以区分。T4-04 的启动自检会把「当前连的是哪个地址、来源是什么」
 * 明确报出来。
 *
 * ## 本机代理（T4-03 / T4-04）
 *
 * 两条 IPC，共用一份跨包加载的 api agent 源码（见 `paths.ts` 与 `agent.ts`）：
 *
 * - `launch:run` —— 启动一条配置。主进程会先做形态复核。
 * - `launch:diagnostics` —— 启动自检：查每条配置指向的文件还在不在，并把每类失效
 *   配一句能照着做的引导。
 *
 * **两条通道都不查库**：配置由渲染进程经现有 `GET /api/launch/profiles` 取来再送进来，
 * 因此远程模式下同样通 —— 而外壳不必知道配置存在哪。
 *
 * ## 冒烟模式
 *
 * `--smoke` 用于自动化验证：窗口隐藏、加载完成后在渲染进程里探一次 DOM，把结果
 * 打到标准输出并按成败设置退出码。它让「外壳能渲染界面」这条验收可以被脚本断言，
 * 而不是只能靠人眼。**它不改变正常启动的任何行为。**
 */
import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  describeSource,
  findWorkspaceRoot,
  loadServiceConfig,
  saveServiceConfig,
  type LoadResult,
} from './config.js'
import { runShellLaunchProfile, normalizeProfile, type LaunchAgentModule } from './agent.js'
import { agentUnavailableReport, checkLaunchDiagnostics } from './diagnostics.js'
import { apiLaunchModule, bundledAgentPath, webDistRoot } from './paths.js'
import { startStaticServer, type StaticServerHandle } from './server.js'
import {
  applyUpdateEvent,
  describeUpdateStatus,
  initialUpdateStatus,
  isReadyToInstall,
  type UpdateEvent,
  type UpdateStatus,
} from './update.js'

/**
 * 前端构建产物的绝对路径。
 *
 * **两种形态的落点不同**（T6-03a）：开发态 `__dirname` 是 `apps/desktop/dist`，
 * 产物在它的上两级兄弟 `apps/web/dist`；打包态 asar 里没有兄弟目录，产物由
 * `electron-builder.yml` 的 extraResources 投到 `resources/web`。
 * 判据是 `app.isPackaged` —— 它看的是「跑在打包产物里吗」，而不是「是不是生产构建」，
 * 所以 `--smoke` 与正式启动走的是同一条分支。
 */
const DIST_ROOT = webDistRoot({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  fromDir: __dirname,
})

/**
 * 安装态在没有任何配置时连的地址。
 *
 * 开发态的兜底是 `http://127.0.0.1:8787`（`config.ts` 的 `DEFAULT_SERVICE_URL`），
 * 那在开发机上恰好是对的 —— api 就在本机跑。**装到别人机器上却会去连一个不存在的
 * 本机端口**，界面是坏的，而本机的冒烟还能全绿。所以兜底必须按形态给。
 *
 * 取值就是这套系统的线上地址（Cloudflare Tunnel，见 T5-04）。换域名时要改这一行。
 */
const PACKAGED_SERVICE_URL = 'https://work.fanhe.dpdns.org'

const IS_SMOKE = process.argv.includes('--smoke')

/**
 * 更新通道的探针模式（T6-03b）。它与 `--smoke` 是两件事：
 * `--smoke` 验「界面能画出来」且**刻意不查更新**（验收要离线可重复），
 * 而 `--update-probe` 正好相反 —— 它只做更新检查这一件事，且必须在打包态跑。
 */
const IS_UPDATE_PROBE = process.argv.includes('--update-probe')

/**
 * 探针等多久。见 `runUpdateProbe`：**超时是一种结果（`阶段=timeout`），不是错误** ——
 * 网络卡住时这个进程必须退出，否则验收脚本会挂在那里等它。
 */
const UPDATE_PROBE_TIMEOUT_MS = 120_000

/**
 * 本次启动读到的配置结果。进程内唯一一份，IPC 通道直接返回它。
 *
 * 记成模块级而不是塞进闭包，是为了让「切换服务地址」这件事有个明确的中转点：
 * 写入配置后由调用方重启，不在运行中改这个对象，避免反代上游与界面显示不一致。
 */
let currentService: LoadResult | null = null

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

/**
 * 注册服务地址相关的 IPC。
 *
 * **不把 `ipcRenderer` 整个暴露出去**，渲染进程只能调到这里显式开的两个口子。
 *
 * - `service:status` —— 读当前连的是哪个地址、从哪来的、配置文件在哪。T4-04 的
 *   启动自检与界面上的「当前连接」展示都靠它。
 * - `service:set` —— 写配置。**只写文件，不在运行中换上游**，返回值告诉调用方
 *   需要重启。这是上面那个「不产生中间态」的取舍在接口上的体现。
 */
function registerServiceIpc(): void {
  ipcMain.handle('service:status', () => {
    if (currentService === null) {
      return { serviceUrl: '', source: 'default', path: '', warning: '服务地址尚未读取' }
    }
    return {
      serviceUrl: currentService.config.serviceUrl,
      source: currentService.source,
      sourceLabel: describeSource(currentService.source),
      path: currentService.path,
      warning: currentService.warning,
    }
  })

  ipcMain.handle('service:set', async (_event, payload: unknown) => {
    if (currentService === null || currentService.path === '') {
      return { ok: false, error: '未找到配置文件路径，无法写入。请确认工作区完整。' }
    }
    const requested = (payload as { serviceUrl?: unknown } | null)?.serviceUrl
    try {
      const saved = await saveServiceConfig(currentService.path, {
        serviceUrl: requested as string,
      })
      return { ok: true, serviceUrl: saved.serviceUrl, needsRestart: true }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return { ok: false, error: detail }
    }
  })
}

/**
 * 载入本机代理核心。
 *
 * **按需加载而不是启动时就加载**：它是一次动态 `import()` 跨包的 TS 源码，失败原因
 * 可能是工作区不完整 —— 那不该让外壳连界面都开不出来。两个调用方（`launch:run` 与
 * `launch:diagnostics`）都需要它，**共用这一处**是为了让「代理不可用」这个状态在两条
 * 通道上的说法完全一致；分成两处写，迟早会有一处忘了带上原因。
 *
 * **安装态没有工作区**（T6-03a），所以打包时把随包资源的位置一并传下去，让
 * `paths.ts` 在工作区推不出来时退到 `resources/agent/agent.ts`。开发态传 `undefined`，
 * 于是那四条失败分支的报错与 T4-03 一字不差 —— 降级只在真正需要它的形态里生效。
 */
async function loadLaunchAgent(): Promise<
  { ok: true; module: LaunchAgentModule } | { ok: false; detail: string }
> {
  try {
    const bundled = app.isPackaged ? bundledAgentPath(process.resourcesPath) : undefined
    return { ok: true, module: (await apiLaunchModule(__dirname, bundled)) as LaunchAgentModule }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error(`[launch] 本机代理不可用：${detail}`)
    return { ok: false, detail }
  }
}

/**
 * 注册本机代理的 IPC（T4-03）。
 *
 * **和 `apps/api` 那条 HTTP 路由相比，这里少了权限中间件与用户身份。** 那不是漏掉，
 * 是形态不同：外壳的主进程与它启动的窗口同属一个用户，「哪个用户」这个问题在这条
 * 链路上没有意义；而权限点属于远程 API 关心的范畴 —— **远程不应该能启动任何人
 * 电脑上的进程**，那道边界由 API 侧的 `isLoopbackAddress` 判定守着（见
 * `apps/api/src/routes/launch.ts`）。本机外壳起本机进程，是用户自己在自己机器上
 * 的操作。
 *
 * **但形态复核不能省**，且它落在 `agent.ts` 的 `normalizeProfile` 里：IPC 通道对
 * 渲染进程里的任何脚本开放，所以主进程不能只信传入对象的 `executablePath`。少了
 * 那一步，这条 IPC 就等于一个本机任意命令执行入口。
 */
function registerLaunchIpc(): void {
  ipcMain.handle('launch:run', async (_event, payload: unknown) => {
    const loaded = await loadLaunchAgent()
    if (!loaded.ok) {
      return { ok: false, reason: 'spawn_failed', detail: `本机代理不可用：${loaded.detail}` }
    }

    const raw = (payload as { profile?: unknown } | null)?.profile
    const outcome = await runShellLaunchProfile(raw, loaded.module)
    if (!outcome.ok) {
      console.warn(`[launch] 启动未成功（${outcome.reason}）：${outcome.detail}`)
      return outcome
    }
    console.log(`[launch] 已启动 pid=${outcome.data.pid} 去重=${outcome.data.deduplicated}`)
    return outcome
  })

  /**
   * 启动自检（T4-04）。
   *
   * **入参是配置数组而不是配置 id**，与 `launch:run` 同一条理由：主进程不连数据库，
   * 配置得由界面从 `GET /api/launch/profiles` 取到再送进来。
   *
   * **校验依赖在这里注入而不是在 `diagnostics.ts` 里 import**，是为了让那个模块能在
   * 单测里被直接加载（desktop 产出 CJS，模块间 import 必须写 `.js` 后缀，而单测走
   * 类型剥离加载 `src/*.ts`，那里没有 `.js` 文件）。注意传的是同一份实现 ——
   * 自检与启动对「什么算合法配置」的判断因此不会分叉。
   */
  ipcMain.handle('launch:diagnostics', async (_event, payload: unknown) => {
    const profiles = (payload as { profiles?: unknown } | null)?.profiles

    // **空配置先判，不加载代理。** 一条配置都没有时自检该说「没有要检查的」，而先
    // 加载代理会在工作区恰好有问题时报成「代理不可用」—— 那与事实不符（代理没事，
    // 只是没东西可查），且会把用户引去查工作区而不是先看看自己是不是还没配。
    if (!Array.isArray(profiles) || profiles.length === 0) {
      return checkLaunchDiagnostics({
        profiles,
        // 空列表走不到下面那两处，留两个永不被调用的实现只是为了让类型完整。
        normalize: () => null,
        inspect: () => Promise.resolve('missing'),
      })
    }

    const loaded = await loadLaunchAgent()
    if (!loaded.ok) return agentUnavailableReport(loaded.detail)

    const report = await checkLaunchDiagnostics({
      profiles,
      normalize: normalizeProfile,
      inspect: loaded.module.inspectExecutablePath,
    })
    const count = report.diagnostics.length
    console.log(
      `[launch] 自检完成 可用=${report.okCount}/${report.total}` +
        (count === 0 ? '' : ` 问题=${count}`),
    )
    return report
  })
}

/**
 * 更新通道（T6-03b）。
 *
 * ## 这一层只做翻译，判断在 `update.ts`
 *
 * `applyUpdateEvent` / `isReadyToInstall` 是纯函数、有单测；这里把
 * `electron-updater` 的回调翻译成那边的事件，把结果通过 IPC 交出去。
 * **翻译层刻意做得很薄** —— 它是这条链路上唯一跑不了单测的部分。
 *
 * ## 为什么「重启后生效」这句话是真的
 *
 * `autoInstallOnAppQuit = true`。T6-02 的提示在桌面态写的是「已可更新到 vX，
 * 重启后生效」，而那句话成立的前提正是这个开关：下载完的新版会在应用退出时被装上。
 * 若它被改成 false，文案就成了一句空话 —— 用户重启之后还是旧版，而且不会再有提示。
 * 两条路都保留：**点那一行**立即安装并退出（`update:install`），**正常退出**也会装上。
 *
 * ## 只在打包态、且不在冒烟/探针模式时启用
 *
 * 开发态没有 `app-update.yml`（它由 electron-builder 在打包时生成），
 * `checkForUpdates()` 会直接抛。冒烟模式刻意不检查：验收脚本要可重复、离线可跑，
 * 而更新检查会去访问 GitHub。
 *
 * 探针模式（`--update-probe`）则**故意**要在打包态真的走一次检查 —— 见下面。
 */
let updateStatus: UpdateStatus = initialUpdateStatus()

function dispatchUpdateEvent(event: UpdateEvent): void {
  updateStatus = applyUpdateEvent(updateStatus, event)
  console.log(`[update] ${describeUpdateStatus(updateStatus)}`)
}

/** 更新通道在当前形态下可用吗。 */
function updateChannelAvailable(): boolean {
  return app.isPackaged && !IS_SMOKE
}

/**
 * 把 `electron-updater` 的回调接上，并在启动后检查一次。
 *
 * **启动后检查而不是等用户点**：桌面工具会被开一整天，用户不会主动去想「有没有新版」。
 * 检查失败不弹任何东西 —— 它是一条非关键路径，报错的表现应当是「没有提示」，
 * 而不是让一个已经能用的应用弹一个用户无法处理的错误框。
 */
function wireAutoUpdater(): void {
  if (!updateChannelAvailable()) {
    dispatchUpdateEvent({
      type: 'unsupported',
      detail: app.isPackaged ? '冒烟模式不检查更新' : '开发态不检查更新',
    })
    return
  }

  // 有新版就自动下（默认即 true，写出来是因为这是一条决定而非巧合）：
  // 用户点「重启更新」时不该再等一次下载。
  autoUpdater.autoDownload = true
  // 见上方「为什么「重启后生效」这句话是真的」。
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => dispatchUpdateEvent({ type: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    dispatchUpdateEvent({ type: 'available', version: info.version }),
  )
  autoUpdater.on('update-not-available', () => dispatchUpdateEvent({ type: 'not-available' }))
  autoUpdater.on('download-progress', (progress) =>
    dispatchUpdateEvent({ type: 'progress', percent: progress.percent }),
  )
  autoUpdater.on('update-downloaded', (info) =>
    dispatchUpdateEvent({ type: 'downloaded', version: info.version }),
  )
  autoUpdater.on('error', (error) =>
    dispatchUpdateEvent({
      type: 'error',
      detail: error instanceof Error ? error.message : String(error),
    }),
  )

  void autoUpdater.checkForUpdates().catch((error: unknown) => {
    // 上面那个 error 监听通常已经收过了；这里兜住「还没接上监听就同步抛」的情况。
    dispatchUpdateEvent({
      type: 'error',
      detail: error instanceof Error ? error.message : String(error),
    })
  })
}

/**
 * 注册更新通道的 IPC。
 *
 * 三个通道，对应界面上的三件事：**看现在什么状态**、**现在去查一下**、**装并重启**。
 *
 * `update:install` 用 `isReadyToInstall` 而不是只信调用方：这条通道对渲染进程里的
 * 任何脚本开放，而 `quitAndInstall()` 会让应用退出。**没有下载好的包时一律拒绝** ——
 * 那是「点了没反应」与「点了一次莫名其妙的退出」的区别。
 */
function registerUpdateIpc(): void {
  ipcMain.handle('update:status', () => updateStatus)

  ipcMain.handle('update:check', async () => {
    if (!updateChannelAvailable()) return updateStatus
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      dispatchUpdateEvent({
        type: 'error',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    return updateStatus
  })

  ipcMain.handle('update:install', () => {
    if (!isReadyToInstall(updateStatus)) {
      return {
        ok: false as const,
        reason: 'not_ready' as const,
        detail: '还没有下载完成的新版本，无法安装。',
      }
    }
    // 不等它返回：这一行之后进程就会开始退出流程。
    autoUpdater.quitAndInstall()
    return { ok: true as const }
  })
}

/**
 * 更新通道的探针模式（`--update-probe`）。
 *
 * ## 为什么要有它
 *
 * 更新通道的验收（改 sha512 → 拒绝、换签名主体 → 拒绝）**只能在打包态、且需要真的
 * 走一次网络下载**。手工做法是发两版、装一台、等一次下载 —— 那样这两条反例基本不会
 * 被跑第二次。有了这个模式，验收脚本能拿一个本地静态目录冒充更新源（`provider:
 * 'generic'`），把整条链路变成可离线重复的断言。
 *
 * ## 判据只报事实，不判好坏
 *
 * 它把最后一行状态打成 `[update-probe] 阶段=... 版本=...`，然后**按调用方给的期望**
 * 决定退出码。期望由命令行给出（`--expect-downloaded` / `--expect-error`），
 * 因为这个探针同时要服务于「应该装成功」与「应该被拒绝」两种反例。
 *
 * 超时也归为一种结果（`阶段=timeout`）而不是挂死：不改写状态机里的状态，
 * 就打印一行、退出非零。
 */
async function runUpdateProbe(): Promise<void> {
  const expectDownloaded = process.argv.includes('--expect-downloaded')
  const expectError = process.argv.includes('--expect-error')

  wireAutoUpdater()

  // 🔴 探针显式关掉「退出时自动安装」。
  //
  // 正常使用路径需要它为真（见 `wireAutoUpdater` 上面那段：那是「重启后生效」这句话
  // 成立的前提），但探针不是正常使用路径 —— 它只观察「通道把这次检查判成了什么」。
  // 第一次跑验收时它带着默认值，于是成功下载之后 `app.exit()` 顺手把新版本装了：
  // **一个只读的验收动作修改了这台机器上的软件**，而且下一次跑的结果会被上一轮的
  // 安装影响。验收脚本必须是可重复的，所以这里关掉它，并把生效值打进输出。
  autoUpdater.autoInstallOnAppQuit = false

  // 轮询而不是再加一份事件监听：状态机已经是唯一真相，多一处监听就多一处会分叉。
  const deadline = Date.now() + UPDATE_PROBE_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (updateStatus.phase === 'downloaded' || updateStatus.phase === 'error') break
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  const status = updateStatus
  console.log(`[update-probe] 阶段=${status.phase} 版本=${status.version ?? '-'}`)
  if (status.detail !== '') console.log(`[update-probe] 说明=${status.detail}`)
  console.log(`[update-probe] 是否可安装=${isReadyToInstall(status) ? '是' : '否'}`)
  console.log(`[update-probe] 退出时自动安装=关（探针刻意关掉，正常启动时为开）`)

  let ok: boolean
  if (expectDownloaded) ok = status.phase === 'downloaded'
  else if (expectError) ok = status.phase === 'error'
  else ok = status.phase !== 'idle' && status.phase !== 'checking'
  console.log(`[update-probe] ${ok ? 'PASS' : 'FAIL'}`)
  app.exit(ok ? 0 : 1)
}

async function bootstrap(): Promise<void> {
  // 探针模式先于一切：它只关心更新通道，不需要前端产物，也不需要内置服务。
  // 放在最前面是为了让 `dist:dir` 产物能单独被验，而不必先构建 web。
  if (IS_UPDATE_PROBE) {
    await runUpdateProbe()
    return
  }

  if (!existsSync(DIST_ROOT)) {
    throw new Error(`未找到前端构建产物：${DIST_ROOT}。请先运行 pnpm --filter @fanhe/web build`)
  }

  // 安装态没有工作区，配置改落 userData —— 与凭据密钥库同一处逐用户目录。
  // 不这么改的话 `currentService.path` 是空串，`service:set` 会一直返回
  // 「未找到配置文件路径」，界面上的「切换服务地址」在安装版里是死的。
  //
  // 用展开而不是直接传 `undefined`：`tsconfig.base.json` 开了
  // `exactOptionalPropertyTypes`，把「属性缺席」与「属性是 undefined」当作两件事，
  // 而 `loadServiceConfig` 的可选参数只在缺席时才走开发态那条分支。
  const packagedOnly = app.isPackaged
    ? { configDir: app.getPath('userData'), defaultUrl: PACKAGED_SERVICE_URL }
    : {}
  currentService = await loadServiceConfig({ fromDir: __dirname, ...packagedOnly })
  const serviceUrl = currentService.config.serviceUrl

  // 这三行是「配置跟着工作空间走」这件事的直接后果：换台电脑时它读的是那边工作区
  // 里的文件，而不是本机残留的默认值。找不到根时警告已经写进 currentService。
  const workspaceRoot = findWorkspaceRoot(__dirname)
  console.log(
    `[config] 服务地址 ${serviceUrl}（来源：${describeSource(currentService.source)}）` +
      (workspaceRoot === null ? '' : `，工作区 ${workspaceRoot}`),
  )
  // 打印运行形态是给排障用的：安装态与开发态的前端产物落在完全不同的地方，
  // 而「界面是旧的」这类报告的第一分岔点就是这里。
  console.log(`[config] 运行形态 ${app.isPackaged ? '安装态' : '开发态'}，前端产物 ${DIST_ROOT}`)
  if (currentService.warning !== null) console.warn(`[config] ${currentService.warning}`)

  registerServiceIpc()
  registerLaunchIpc()
  // 更新通道的 IPC 在窗口之前注册：界面挂载时就会问一次当前状态（见 T6-02 的
  // 「挂载时查一次」），晚注册会让那一次拿到「通道不存在」。
  registerUpdateIpc()

  staticServer = await startStaticServer({ root: DIST_ROOT, apiBaseUrl: serviceUrl })
  shellOrigin = `http://127.0.0.1:${staticServer.port}`

  if (IS_SMOKE) {
    await runSmoke()
    return
  }

  const window = buildWindow(true)
  await window.loadURL(`${shellOrigin}/`)

  // 检查放在窗口显示之后：这条链路会去访问网络，不该让它挡在首屏前面。
  wireAutoUpdater()

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
 *
 * 顺带验一条 T4-02 的核心判据：**反代是否真的打到了配置里那个地址**。做法是
 * 在主进程侧直接请求内置服务的 `/api/`，若上游是活的会拿到上游的响应（哪怕是
 * 401/404 也算「打到了」），上游不可达则是 502。这条比「改了配置没白改」更难
 * 糊弄 —— 它走的是外壳自己的反代路径，而不是直接去 ping 上游。
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

  const rendered = probe.rendered > 0
  const upstreamReachable = await probeUpstream()
  const diagnostics = await probeDiagnostics(window)

  const ok = rendered && consoleErrors.length === 0 && diagnostics.reachable
  console.log(
    `[smoke] 渲染元素=${probe.rendered} 标题=${probe.title} 路径=${probe.path} ` +
      `预加载桥=${probe.bridge ? '有' : '无'} console错误=${consoleErrors.length}`,
  )
  console.log(
    `[smoke] 服务地址=${currentService?.config.serviceUrl ?? '?'} ` +
      `来源=${currentService ? describeSource(currentService.source) : '?'} ` +
      `反代到达上游=${upstreamReachable ? '是' : '否'}`,
  )
  // 自检判据只看「通道通、返回结构完整」，不判自检结果好不好 —— 此刻库里有没有失效
  // 配置取决于用户数据，把它算进 PASS/FAIL 会让冒烟结果随数据变化。
  console.log(
    `[smoke] 启动自检=${diagnostics.reachable ? '可用' : '不可用'} ` +
      `代理=${diagnostics.agentAvailable ? '可用' : '不可用'} ` +
      `配置=${diagnostics.total}条 可用=${diagnostics.okCount}条`,
  )
  for (const message of consoleErrors) console.error(`[smoke] console.error: ${message}`)
  console.log(`[smoke] ${ok ? 'PASS' : 'FAIL'}`)

  app.exit(ok ? 0 : 1)
}

/**
 * 从**渲染进程里**调一次启动自检。
 *
 * **走 `executeJavaScript` 而不是直接在主进程调**，是因为这条链路的每一段都可能是
 * 断的：预加载没暴露方法、通道名写错、`contextBridge` 的结构克隆失败。主进程自己调
 * 自己注册的处理函数，前三段全绕过去了，冒烟会绿而界面用不了。
 *
 * **判据是「返回结构完整」而不是「有没有查出问题」**：前者证明通道可用，后者取决于
 * 用户库里有没有失效配置 —— 后者会让冒烟的成败随数据变化，而冒烟不该有那种依赖。
 */
async function probeDiagnostics(window: BrowserWindow): Promise<{
  reachable: boolean
  agentAvailable: boolean
  total: number
  okCount: number
}> {
  const empty = { reachable: false, agentAvailable: false, total: -1, okCount: -1 }
  try {
    const report = (await window.webContents.executeJavaScript(
      `(async () => {
         const bridge = window.fanheDesktop
         if (typeof bridge?.checkLaunchProfiles !== 'function') return null
         const result = await bridge.checkLaunchProfiles([])
         return {
           agentAvailable: result.agentAvailable,
           total: result.total,
           okCount: result.okCount,
           diagnostics: Array.isArray(result.diagnostics),
         }
       })()`,
      true,
    )) as null | {
      agentAvailable: boolean
      total: number
      okCount: number
      diagnostics: boolean
    }

    if (report === null || !report.diagnostics) return empty
    return {
      reachable: true,
      agentAvailable: report.agentAvailable,
      total: report.total,
      okCount: report.okCount,
    }
  } catch (error) {
    console.error(
      `[smoke] 自检通道不可用：${error instanceof Error ? error.message : String(error)}`,
    )
    return empty
  }
}

/**
 * 经内置服务请求 `/api/`，据状态码判断反代是否真的到达了上游。
 *
 * **上游返回 401/404 也算到达** —— 那证明请求走完了反代并拿到了上游的响应。
 * 只有 502 才是没到达，而 502 由 `server.ts` 在 fetch 抛错时给出。
 */
async function probeUpstream(): Promise<boolean> {
  try {
    const response = await fetch(`${shellOrigin}/api/`, { redirect: 'manual' })
    await response.arrayBuffer()
    return response.status !== 502
  } catch {
    return false
  }
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
