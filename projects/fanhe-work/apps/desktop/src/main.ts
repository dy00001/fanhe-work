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
 * 另有一条不依赖 agent 的：
 *
 * - `launch:icon` —— 按路径批量取可执行文件的真实图标（§2.9）。走 Electron 内置的
 *   `app.getFileIcon`，与系统「图标来源」同一套实现，因此与桌面快捷方式显示的一致。
 *   逻辑在 `launch-icon.ts`，这里只做接线。
 *
 * **两条通道都不查库**：配置由渲染进程经现有 `GET /api/launch/profiles` 取来再送进来，
 * 因此远程模式下同样通 —— 而外壳不必知道配置存在哪。
 *
 * ## 唤起之后的后置动作
 *
 * spawn 成功只代表进程建起来了，客户端窗口还没出现。后置动作分两类，编排在
 * `runPostLaunchBatch`：**扫码登录类（微信）**等各自的登录窗出现后按网格排开，一个键
 * 都不敲；**账号密码类（QQ / 千牛）**串行地点一下登录。窗口操作的等待与按键原语在
 * `launch-windows.ts`，软件开关在 `launch-login-click.ts`。两者都 best-effort：
 * 失败只进日志，绝不改启动结果。
 *
 * ## 冒烟模式
 *
 * `--smoke` 用于自动化验证：窗口隐藏、加载完成后在渲染进程里探一次 DOM，把结果
 * 打到标准输出并按成败设置退出码。它让「外壳能渲染界面」这条验收可以被脚本断言，
 * 而不是只能靠人眼。**它不改变正常启动的任何行为。**
 *
 * ## 界面来源（端口）必须稳定 —— 这就是「更新后设置不丢」
 *
 * 界面托管在 `http://127.0.0.1:<端口>` 上，而 localStorage 与 IndexedDB 都是按
 * origin 分区的，origin 里含端口。端口一变，存储分区就变，用户看到的是「设置丢了」。
 * 所以端口由 `startShellServer` 定下来、记进 `userData/shell-origin.json`，并且
 * **优先试回「已经有数据的那一个」**；候选顺序的完整推导见 `shell-origin.ts` 文件头。
 *
 * 配合单实例锁（第二个实例会抢不到同一个端口、顺延到一个新分区）。这两件事合起来
 * 才是「更新之后设置与本地数据都还在」的完整实现 —— 改动前先读那两个位置。
 *
 * ## 本机凭据库（P1）
 *
 * 三条 IPC（`credential:status` / `credential:save` / `credential:delete`）管一件事：
 * QQ 与千牛多账号时「这条配置该填哪个账号密码」。密码用 `safeStorage`（Windows 下是
 * DPAPI）加密后落 `userData/credentials.enc`，**只在主进程内解密、绝不过 IPC 回传**，
 * 因此这里**刻意没有第四条 `credential:get`**。逻辑在 `credential-vault.ts`，本节只做
 * 接线；详细取舍见 `docs/LAUNCH-LOGIN-DESIGN-2026-10-15.md` §4。
 */
import { app, BrowserWindow, ipcMain, Menu, safeStorage, Tray, nativeImage, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync } from 'node:fs'
import { readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brandIconPath, TRAY_ICON_WIDTH, windowIconPath } from './brand-icon.js'
import {
  createCredentialVault,
  normalizeCredentialInput,
  normalizeProfileId,
  normalizeProfileIds,
  type CredentialVault,
} from './credential-vault.js'
import {
  describeSource,
  findWorkspaceRoot,
  loadServiceConfig,
  saveServiceConfig,
  type LoadResult,
} from './config.js'
import { isAbsoluteExecutablePath } from '@fanhe/shared'
import {
  detectLaunchPaths,
  knownExecutableCandidates,
  normalizeProfile,
  runShellLaunchProfile,
  runShellLaunchProfiles,
  windowsProgramFilesRoots,
  type LaunchAgentModule,
} from './agent.js'
import {
  fillLoginFieldsAfterLaunch,
  findProcessWindow,
  shouldClickLogin,
  tileWindows,
} from './launch-login-click.js'
import { createLaunchIconReader, normalizeIconPaths } from './launch-icon.js'
import { openShopLogin } from './ops-shop-login.js'
import { readRegistryInstallHints } from './launch-registry.js'
import { agentUnavailableReport, checkLaunchDiagnostics } from './diagnostics.js'
import { apiLaunchModule, bundledAgentPath, webDistRoot } from './paths.js'
import { startStaticServer, type StaticServerHandle } from './server.js'
import {
  SHELL_ORIGIN_FILE,
  isFreshOrigin,
  orderLegacyPorts,
  parseOriginDirName,
  parseOriginPortsInText,
  parseStoredPort,
  shellPortCandidates,
} from './shell-origin.js'
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

/**
 * 单实例。
 *
 * ## 为什么必须有
 *
 * 第二个实例抢不到同一个端口（第一个还占着），会按 `shell-origin.ts` 的候选链
 * 顺延到**另一个端口** —— 也就是另一个存储分区。用户在第二个窗口里看不到自己
 * 的设置，改完之后两边互相覆盖，看起来就是「设置自己会丢」。所以第二个实例
 * **直接退出**，并把已有的那个窗口顶到前面。
 *
 * ## 为什么冒烟与探针模式不加锁
 *
 * 那两个是自动化验收模式（`pnpm --filter @fanhe/desktop smoke`、`--update-probe`），
 * 验收脚本可能在应用已经开着的时候跑。加锁会让它们静默退出，症状是「冒烟没有任何
 * 输出」—— 一条与被验功能无关的失败。它们本来就只读、只跑一小会儿。
 *
 * 顺带说：开发态与安装态的 `userData` 是**两个目录**（实测分别是
 * `%APPDATA%\@fanhe\desktop` 与 `%APPDATA%\梵禾 Work`），所以这条锁不会把
 * 「开着安装版再跑开发态外壳」挡掉。
 */
const isPrimaryInstance = IS_SMOKE || IS_UPDATE_PROBE ? true : app.requestSingleInstanceLock()
if (!isPrimaryInstance) {
  console.log('[shell] 已有实例在运行，本次启动退出。')
  app.quit()
}

app.on('second-instance', () => {
  const [existing] = BrowserWindow.getAllWindows()
  if (existing === undefined) return
  if (existing.isMinimized()) existing.restore()
  existing.show()
  existing.focus()
})

let staticServer: StaticServerHandle | null = null
let shellOrigin = ''

/** 主窗口引用。供托盘与「第二个实例」复用，避免依赖 `getAllWindows()[0]` 这种脆弱的顺序。 */
let mainWindow: BrowserWindow | null = null
/** 系统托盘。常驻后台时它是唯一的可见入口；为 null 表示尚未创建（如冒烟/探针模式）。 */
let tray: Tray | null = null
/**
 * 是否正在真正退出。
 *
 * 本版本把「最小化 / 关闭」都改成「退到托盘后台常驻」，于是关窗口按钮不再等于退出进程。
 * 只有两条路径会把它置真：① 用户从托盘右键菜单选「退出」；② 更新安装触发
 * `quitAndInstall`（见 `registerUpdateIpc`）。其余情况下窗口的 `close` / `minimize`
 * 都只是隐藏，进程继续后台运行。
 */
let isQuitting = false

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
    // 窗口图标：供 Windows 标题栏左上角使用。
    //
    // 不显式设的话，开发态窗口图标是 `electron.exe` 自带的 Electron 默认图标（一个
    // 深色圆），而打包态才从 exe 的图标资源里取 —— 于是同一个界面在两种形态下顶着
    // 两个不同的图标，开发时看不出问题，装完才发现。显式指定让两种形态一致。
    //
    // 标题栏尺寸很小，使用简化后的多尺寸 ICO，避免完整印章缩小后糊成一团。
    // 任务栏和托盘继续使用品牌 PNG，见 `brand-icon.ts`。
    icon: windowIconPath(DIST_ROOT),
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

  // 关闭按钮（X）：默认行为是销毁窗口并触发退出流程。改为「藏到托盘」——
  // 除非这是一次真正的退出（`isQuitting` 为真），否则只隐藏，让应用继续后台运行。
  // 见文件顶部 `isQuitting` 的说明。
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault()
      window.hide()
    }
  })

  // 最小化按钮：同样退到托盘而不是停在任务栏。隐藏后任务栏只留托盘图标一个入口。
  window.on('minimize', () => {
    window.hide()
  })

  return window
}

/**
 * 注册「应用版本号」这个只读通道（T7-05）。
 *
 * ## 为什么值得单独开一个通道
 *
 * 前端产物里那个版本号是**构建期**从仓库根 `package.json` 文本替换进去的，它回答的是
 * 「这份前端是哪一版、什么时候构建的」，**不是**「用户装的是哪一版」。两者在打包链路
 * 漏掉一次前端重建之后就会分叉：`v0.1.2` 实测就是包里烧着 `0.1.1`，用户从 GitHub
 * 装了 `0.1.2`，菜单那行显示旧版本号，看起来像更新失败。
 *
 * 而 `app.getVersion()` 读的是**被打包的那份 `package.json`**，恒等于用户装的那一版，
 * 不受构建顺序影响。
 *
 * ## 为什么用 `sendSync` / `on`，而不是 `invoke` / `handle`
 *
 * 预加载脚本要在**页面脚本之前**把这个值摆到 `window.fanheDesktop` 上。`invoke` 是
 * 异步的，界面会先渲染一版没有版本号、再补一版 —— 那正是这个字段要消除的
 * 「先显示一个不对的值」。`sendSync` 在启动时只发生一次，阻塞的代价可以忽略。
 *
 * ## 为什么不用 `webPreferences.additionalArguments` 传进来
 *
 * 那样预加载就得自己解析 `process.argv`。**第一版就是这么写的，冒烟当场拦下**：
 * 解析逻辑被抽成 `src/app-version.ts`，而预加载 `require('./app-version.js')`
 * 在**沙箱化的预加载**里不被允许（报 `Unable to load preload script … module not
 * found: ./app-version.js`，整条桥都没了）。沙箱下的预加载只能 require `electron`
 * 与少数几个 Node 垫片，**本地模块一个都不行**。
 *
 * 改回 IPC 之后这个问题整体消失，而且版本号从此只有一处来源（主进程），
 * 不再有「两端字符串必须对齐」的跨进程契约。
 *
 * ## 为什么在窗口之前注册
 *
 * 与 `registerUpdateIpc()` 同一条理由：界面在预加载阶段就要拿到它，晚注册会让那一次
 * 拿到「通道不存在」，而 `sendSync` 对不存在的通道会**挂住**，不是返回空值。
 */
function registerAppVersionIpc(): void {
  ipcMain.on('app:version', (event) => {
    event.returnValue = app.getVersion()
  })
}

/**
 * 把主窗口恢复到前台。托盘图标点击与「显示窗口」菜单项都走这里。
 *
 * 窗口可能处于三种状态：最小化（任务栏里）、隐藏（托盘态，不在任务栏）、正常显示。
 * 统一归一成「显示并聚焦」，调用方不必先判断当前是哪一种。
 */
function showMainWindow(): void {
  if (mainWindow === null) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 创建系统托盘（T7-06）。
 *
 * ## 为什么需要它
 *
 * 本版本把「最小化 / 关闭」都改成「退到托盘后台常驻」，于是关闭按钮不再等于退出。
 * 用户需要一条始终在场的入口来恢复窗口或真正退出 —— 托盘图标就是这条入口。
 *
 * ## 图标来源
 *
 * 与窗口图标、任务栏图标**同一枚**：`DIST_ROOT/brand/app-icon.png`（打包态是
 * `resources/web/brand/app-icon.png`，开发态是 `apps/web/dist/brand/app-icon.png`）。
 * 路径与尺寸由 `brand-icon.ts` 定义一次，托盘不需要独立资源文件，少一处要维护的二进制。
 *
 * 用 `app-icon.png` 而不是页面里那个 `logo.png`：托盘给的是 16px 方形槽位，而
 * `logo.png` 是 362×391、无 alpha，缩到 16px 会得到一个 16×17 的图并被系统按方形
 * 重排，托盘里看起来是带底色的糊块。方图缩出来是干净的。
 *
 * ## 为什么不在冒烟/探针模式建托盘
 *
 * 那两个是自动化验收模式，跑在无显示的沙箱里，`new Tray` 在那种环境会抛。
 * 验收脚本本来也不关心托盘，跳过它对功能无影响。
 */
function createTray(): void {
  const iconPath = brandIconPath(DIST_ROOT)
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createEmpty()
  else image = image.resize({ width: TRAY_ICON_WIDTH, height: TRAY_ICON_WIDTH })
  tray = new Tray(image)
  tray.setToolTip('梵禾 Work')
  // 左键点击托盘图标：直接恢复窗口（最常见的操作，不该藏进右键菜单）。
  tray.on('click', () => showMainWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true
          app.quit()
        },
      },
    ]),
  )
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

/** 本机凭据库只由主进程持有，启动后的登录自动填写直接调用，不经过 IPC 回传明文。 */
let credentialVaultForLaunch: CredentialVault | null = null

/**
 * §2.4 best-effort 点登录：fire-and-forget，只把结果写进日志供排障。
 *
 * **刻意 await 它再打日志、但绝不 await 它再返回启动结果** —— 登录点击是后置的锦上
 * 添花，启动通道已在 `runShellLaunchProfile` 返回时给出结论；这里多等一步只为让现场
 * 能看清「发了没有、等了多久、结果如何」，否则 best-effort 失败时与成功时在界面上
 * 毫无差别，真机验证也无从判断 Enter 是否落到登录窗。
 */
async function runSingleLoginClick(item: PostLaunchItem): Promise<void> {
  if (!shouldClickLogin(item.software)) return
  const credential = await credentialVaultForLaunch?.getForLaunch(item.profileId)
  if (credential === undefined || credential === null) {
    console.log(
      `[launch] 登录凭据不可用 ${item.software} profileId=${item.profileId} 原因=未保存或无法解密`,
    )
    return
  }

  const filled = await fillLoginFieldsAfterLaunch(
    item.software,
    item.pid,
    credential.account,
    credential.password,
  )
  if (!filled.ok) {
    console.warn(
      `[launch] 登录框填写失败 ${item.software} pid=${item.pid} 原因=${filled.reason}` +
        `${filled.detail === undefined ? '' : `（${filled.detail}）`}`,
    )
    return
  }

  console.log(`[launch] 自动登录 ${item.software} pid=${item.pid} 填写与提交=已执行`)
}

/**
 * 一条待做后置动作的启动结果。
 *
 * 只需要三样东西：对回哪个配置（日志与排障）、是什么软件（决定做什么动作）、它的
 * 进程 id（找窗口的唯一依据）。路径与参数一概不带：后置动作只与「刚起来的那个进程」
 * 打交道，与用户当初配了什么无关。
 */
type PostLaunchItem = { profileId: string; software: string; pid: number }

/**
 * 扫码登录类的软件。唤起后要做的不是按键，而是「把 N 个登录窗排开」。
 *
 * **自定义程序不在此列。** 它的窗口千差万别，可能是一个对话框、一个全屏工具、
 * 一个会记住自己位置的小窗口，替它改尺寸与位置是无理由的干扰。只有微信这种
 * 「多开的每一个窗口都要用户亲手扫一次码」的场景，排布才直接决定功能能不能用。
 */
const TILE_AFTER_LAUNCH_SOFTWARES: ReadonlySet<string> = new Set(['wechat'])

/**
 * 批量启动之后的后置编排（P0）。
 *
 * ## 两类软件走两条路
 *
 * - **扫码登录（微信）**：等每一个实例的登录窗立住，把拿到的句柄按网格平铺。
 *   等待是并发的（各等各的进程），平铺是一次完成的。**一个键都不敲** —— 扫码登录
 *   没有可点的默认按钮，敲 Enter 只会干扰用户扫码头。
 * - **账号密码登录（QQ / 千牛）**：串行执行「点一下登录」。串行的理由不是性能，
 *   而是**等前一个的登录窗立住并处理完，再动下一个**：并行的两条 Enter 会互相把
 *   对方窗口带到前台，后敲的那个落在已经处理过的窗口上，表现为「第二个账号没登录」。
 *   自动填表落地后这里还要再进一步（凭据与窗口的配对只能靠时序保证），届时串行的
 *   单位会前移到 spawn 上。
 *
 * ## 全程 best-effort
 *
 * 编排内部任何一步失败都只进日志。返回给界面的启动结果在 `runShellLaunchProfiles`
 * 那一刻就已经定了，`launch:runMany` 不会等这个函数返回。
 */
async function runPostLaunchBatch(items: readonly PostLaunchItem[]): Promise<void> {
  if (items.length === 0) return

  // 按软件分组：平铺只在同软件的多个实例之间做，不同软件的窗口排到一起没有意义。
  const tileGroups = new Map<string, PostLaunchItem[]>()
  for (const item of items) {
    if (!TILE_AFTER_LAUNCH_SOFTWARES.has(item.software)) continue
    const group = tileGroups.get(item.software)
    if (group === undefined) tileGroups.set(item.software, [item])
    else group.push(item)
  }

  for (const [software, group] of tileGroups) {
    // 单个实例没有排布可言：它本就该在客户端的默认位置。
    if (group.length < 2) continue
    // 并发等：各等各的进程，总时长取最慢的那一个，不按数量累加。
    const found = await Promise.all(
      group.map(async (item) => {
        const outcome = await findProcessWindow(item.pid)
        return { item, hwnd: outcome.hwnd, waitedMs: outcome.waitedMs, reason: outcome.reason }
      }),
    )
    const handles: number[] = []
    for (const entry of found) {
      if (entry.hwnd === null) {
        console.log(
          `[launch] 登录窗未出现 ${software} pid=${entry.item.pid} 原因=${entry.reason}` +
            `${entry.waitedMs === undefined ? '' : ` 等待=${entry.waitedMs}ms`}`,
        )
        continue
      }
      handles.push(entry.hwnd)
    }
    const tiled = await tileWindows(handles)
    console.log(
      `[launch] 登录窗排布 ${software} 实例数=${group.length}` +
        ` 找到窗口=${handles.length} 已排开=${tiled.moved}` +
        `${tiled.reason === undefined ? '' : ` 未排开原因=${tiled.reason}`}`,
    )
  }

  // 账号密码登录：逐条解密并填入对应进程的窗口，再提交登录。串行保证焦点与凭据配对。
  for (const item of items) {
    if (!shouldClickLogin(item.software)) continue
    await runSingleLoginClick(item)
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
  /**
   * 程序图标读取器（§2.9）。**建在模块级而不是每次调用现造** —— 缓存要跨调用活着，
   * 否则界面每次重渲染都会把 N 个 exe 的图标重新读一遍。
   *
   * `size: 'large'` 实测出 48×48（`normal` 32 / `small` 16）。界面按 24 CSS px 渲染，
   * 2 倍屏上要 48 设备像素，用 `normal` 在大屏上会被放大发虚。
   *
   * **不拿 `isEmpty()` 当「没取到」的判据**：实测路径不存在时它返回的仍是「非空」的
   * 系统通用文件图标。这里只挡真正的空图，其余原样交给界面 —— 路径失效这件事由卡片
   * 右上角那个红点表达，不该由同一个信号承担（见 `launch-icon.ts` 的形态说明）。
   */
  const launchIconReader = createLaunchIconReader({
    fetchIcon: async (path) => {
      const image = await app.getFileIcon(path, { size: 'large' })
      return image.isEmpty() ? null : image.toDataURL()
    },
  })

  /**
   * 打开采集浏览器的登录窗口。
   *
   * 只有桌面壳能做这件事：脚本要起一个带调试端口的 Edge，容器里的 API 与浏览器页面
   * 都碰不到宿主机进程。找不到脚本（安装态常见）时返回 `collector_missing` 并带上
   * 手工命令，由界面展示 —— 点了没反应比「请自己跑这条命令」更糟。
   */
  ipcMain.handle('ops:shop-login', async (_event, code: unknown) =>
    openShopLogin(code, { workspaceRoot: findWorkspaceRoot(__dirname) }),
  )

  ipcMain.handle('launch:run', async (_event, payload: unknown) => {
    const loaded = await loadLaunchAgent()
    if (!loaded.ok) {
      return { ok: false, reason: 'spawn_failed', detail: `本机代理不可用：${loaded.detail}` }
    }

    const raw = (payload as { profile?: unknown } | null)?.profile
    const rawProfile = raw as { software?: unknown } | null
    const software = typeof rawProfile?.software === 'string' ? (rawProfile.software as string) : ''
    const outcome = await runShellLaunchProfile(raw, loaded.module)
    if (!outcome.ok) {
      console.warn(`[launch] 启动未成功（${outcome.reason}）：${outcome.detail}`)
      return outcome
    }
    console.log(`[launch] 已启动 pid=${outcome.data.pid} 去重=${outcome.data.deduplicated}`)
    // 唤起后 best-effort 点登录（2.4）：fire-and-forget，绝不阻断启动结果。
    void runSingleLoginClick({ profileId: outcome.data.profileId, software, pid: outcome.data.pid })
    return outcome
  })

  /**
   * 批量启动（2.2）。
   *
   * 与 `launch:run` 共用 `runShellLaunchProfiles`：每条独立走 `runShellLaunchProfile`，
   * 单条失败不影响其余，`Promise.allSettled` 并发收集。各条的 3 秒去重按 `profile.id`
   * 各算，批量接口不把整批当一个去重单位（见 `agent.ts` 该函数的注释）。
   *
   * 空数组直接返回空结果、不加载代理：与 `launch:diagnostics` 同一条取舍 —— 没有东西
   * 可启动时，不该把「代理不可用」误报成「批量失败」。
   */
  ipcMain.handle('launch:runMany', async (_event, payload: unknown) => {
    const raws = (payload as { profiles?: unknown } | null)?.profiles
    if (!Array.isArray(raws) || raws.length === 0) {
      return { results: [], summary: { total: 0, success: 0, failed: 0 } }
    }

    const loaded = await loadLaunchAgent()
    if (!loaded.ok) {
      // 代理都加载不出来，逐条尝试没有意义，每条直接报同一个原因。
      return {
        results: raws.map((raw) => ({
          profileId:
            typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : '',
          ok: false,
          reason: 'agent_unavailable',
          detail: `本机代理不可用：${loaded.detail}`,
        })),
        summary: { total: raws.length, success: 0, failed: raws.length },
      }
    }

    const manyResult = await runShellLaunchProfiles(raws, loaded.module)

    // 唤起后的 best-effort 后置动作：扫码登录类排布登录窗、账号密码类点一下登录。
    // fire-and-forget，只为成功的条目做；按 `id` 反查 software（raws 与
    // manyResult.results 同序，但用 id 配更稳 —— 顺序一旦因排序变化而错位，
    // 错误的表现是「按了 A 的按钮、进了 B 的窗口」，那种现场极难解释）。
    const softwareById = new Map<string, string>()
    for (const raw of raws) {
      const item = raw as { id?: unknown; software?: unknown }
      if (typeof item.id === 'string' && typeof item.software === 'string') {
        softwareById.set(item.id, item.software)
      }
    }
    const postLaunch: PostLaunchItem[] = []
    for (const result of manyResult.results) {
      if (result.ok && result.pid !== undefined) {
        postLaunch.push({
          profileId: result.profileId,
          software: softwareById.get(result.profileId) ?? '',
          pid: result.pid,
        })
      }
    }
    if (postLaunch.length > 0) void runPostLaunchBatch(postLaunch)

    return manyResult
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

  /**
   * 本地路径一键检测（2.5）。
   *
   * 入参 `software` 与一个可选的 `extraPath`（用户已经填过、想顺带校验的路径）。返回
   * 首选命中 + 候选清单。与 `launch:diagnostics` 同源的取舍：**没有可查的东西时不加载
   * 代理**。`knownExecutableCandidates` 是纯枚举（不碰文件系统），未知 software 或
   * custom 在没给 `extraPath` 时本来就没有候选，此时加载代理只会引入「代理不可用」这种
   * 与事实无关的报错。只有真正要校验路径时才去加载 api agent、用它与启动同款的
   * `inspectExecutablePath` 复核（见 `agent.ts` 的 `detectLaunchPaths` 注释：检测与启动
   * 必须用同一份路径判断，否则会出现「检测说在、点启动说不在」）。
   */
  ipcMain.handle('launch:detect', async (_event, payload: unknown) => {
    const { software, extraPath } =
      (payload as { software?: unknown; extraPath?: unknown } | null) ?? {}
    const softwareStr = typeof software === 'string' ? software : ''
    const extraPathStr = typeof extraPath === 'string' && extraPath !== '' ? extraPath : ''

    // 「所有盘的 Program Files」—— 环境变量那三个根只覆盖系统盘，装到 D 盘会漏。
    const extraRoots = windowsProgramFilesRoots()

    // 注册表 Uninstall 键里的自定义安装位置（2.5 增强）。目录扫描原理上覆盖不了用户自选
    // 的目录名（如 `D:\软件安装目录\`），注册表能。best-effort：读不到就空数组，不阻断检测。
    const registryCandidates = await readRegistryInstallHints(softwareStr)

    // 没有可查的东西（非字符串 software 且无已知候选、无注册表命中，且没给可校验的
    // extraPath）：空结果、不加载代理、不报代理不可用，与 diagnostics 的「空配置先判」同取舍。
    const hasKnown =
      knownExecutableCandidates(softwareStr, process.env, { extraRoots }).length > 0 ||
      registryCandidates.length > 0
    const hasExtra = extraPathStr !== '' && isAbsoluteExecutablePath(extraPathStr)
    if (!hasKnown && !hasExtra) {
      return { software: softwareStr, preferred: null, candidates: [], agentAvailable: true }
    }

    const loaded = await loadLaunchAgent()
    if (!loaded.ok) {
      return {
        software: softwareStr,
        preferred: null,
        candidates: [],
        agentAvailable: false,
        detail: `本机代理不可用：${loaded.detail}`,
      }
    }

    // `extraPath` 只在确实可校验时传入：`detectLaunchPaths` 的选项是
    // `exactOptionalPropertyTypes`，显式给 `undefined` 反而不合法（见 tsconfig）。
    // `extraCandidates` 给数组（可空数组，不是 undefined），不触这条约束。
    const detection = await detectLaunchPaths(
      softwareStr,
      hasExtra
        ? {
            extraPath: extraPathStr,
            extraCandidates: registryCandidates,
            inspect: loaded.module.inspectExecutablePath,
            extraRoots,
          }
        : {
            extraCandidates: registryCandidates,
            inspect: loaded.module.inspectExecutablePath,
            extraRoots,
          },
    )
    return { software: softwareStr, ...detection, agentAvailable: true }
  })

  /**
   * 取可执行文件的真实图标（§2.9）。
   *
   * 入参是**路径数组**而不是配置数组：取图标只需要路径，而主进程不连数据库、也不必
   * 知道「这条配置叫什么」。批量而不是逐条，是为了让界面一次请求取回整盘图标 —— 托盘
   * 里十几枚图标逐条往返会在打开首页时明显卡一下。
   *
   * **空入参直接返回、不做任何事**：与 `launch:diagnostics` 的「空配置先判」同一条取舍，
   * 没有东西要取时不该有任何副作用。路径归一（绝对路径、去重、限长）在
   * `normalizeIconPaths` 里做，它同时是这条通道的形态复核 —— 通道对渲染进程里的任何
   * 脚本开放，不能只信调用方送来的值。
   */
  ipcMain.handle('launch:icon', async (_event, payload: unknown) => {
    const paths = normalizeIconPaths((payload as { paths?: unknown } | null)?.paths)
    if (paths.length === 0) return { icons: [] }
    return { icons: await launchIconReader.read(paths) }
  })
}

/**
 * 凭据库文件名。放在 `userData` 里，与 `shell-origin.json`、服务地址配置同一处
 * 逐用户目录 —— 换 Windows 用户时那份 DPAPI 密文本来就解不开（密钥按用户派生），
 * 放在这里正好让「换用户 = 凭据也要重填」这件事在目录层面也是自然成立的。
 */
const CREDENTIAL_VAULT_FILE = 'credentials.enc'

/**
 * 注册第三方账号密码的本机凭据库（P1）。
 *
 * ## 它解决的是什么
 *
 * QQ 与千牛的「记住密码 + 自动登录」只能记一个账号；多账号时第二个起不来。于是启动
 * 配置需要一个「这条配置该填哪个账号密码」的地方，而**密码只留在这台机器上**。
 *
 * ## 三条通道，刻意没有第四条
 *
 * - `credential:status` —— 查一组配置的凭据状态 + 掩码账号。
 * - `credential:save` —— 存一条（覆盖同 `profileId` 的旧条目）。
 * - `credential:delete` —— 删一条。
 *
 * **没有 `credential:get`。** 明文密码只在主进程内、且只在 P2 自动填表那一刻被读出来；
 * 这条 IPC 一律不回传。渲染进程拿到的账号是掩码形式（`maskAccount`），编辑态密码框恒为
 * 空，「用户改没改密码」这件事靠三个显式信号表达（不改 / 覆盖 / clear），不靠「回传一次
 * 再比对」—— 后者等于把密码送出了主进程。
 *
 * ## 为什么形态复核在通道里再做一次
 *
 * `credential-vault.ts` 的归一函数被搬到这里用了：这条通道对渲染进程里的任何脚本开放，
 * 与 `launch:run` 同一条理由（那边复核 `executablePath`，这边复核 id / 账号 / 密码的形态
 * 与长度）。**归一函数本身是被单测覆盖的**，两处用的是同一份实现，不会分叉。
 *
 * ## 日志纪律
 *
 * 只记 `profileId` 与成败。**账号与密码一律不进日志** —— 排障日志会被截图、会被打包
 * 发走，那是这套方案里最容易失守的一处。`label`（配置显示名）也不记：它对排障没有
 * 额外价值，而多记一个字段就多一个抄漏的地方。
 */
function registerCredentialIpc(): void {
  const vaultPath = join(app.getPath('userData'), CREDENTIAL_VAULT_FILE)
  const vault = createCredentialVault(vaultPath, {
    // 读不到一律按「没有库」处理（第一次用就是这个状态）。读失败（权限、被占用）与
    // 文件不存在在这条路径上不可区分，也不需要区分：两者的下一步都是「保存时新建」。
    readFile: async (path) => {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    writeFile: async (path, content) => {
      await writeFile(path, content, 'utf8')
    },
    rename: async (from, to) => {
      await rename(from, to)
    },
    unlink: async (path) => {
      await unlink(path)
    },
    // Windows 下是 DPAPI，密钥由 OS 按当前用户派生，主进程拿不到密钥本身。
    // 这两条只在 `credential-vault.ts` 内部被调，抛不抛都由那边兜住转成状态。
    encrypt: (plaintext) => safeStorage.encryptString(plaintext),
    decrypt: (ciphertext) => safeStorage.decryptString(ciphertext),
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  })
  credentialVaultForLaunch = vault

  ipcMain.handle('credential:status', async (_event, payload: unknown) => {
    const profileIds = normalizeProfileIds((payload as { profileIds?: unknown } | null)?.profileIds)
    // 空查询不读凭据文件，但仍返回系统加密能力，供新增配置判断账号密码输入区是否可用。
    if (profileIds.length === 0) {
      return { items: [], encryptionAvailable: safeStorage.isEncryptionAvailable() }
    }
    const items = await vault.status(profileIds)
    // 注意：**凭据库损坏时这里全部报 `none`**（读不出来就没有条目）。那种状态会在
    // 用户点保存时由 `vault_corrupt` 明确报出来并给出文件路径，因此不在这里单独
    // 造一个状态 —— 界面要处理的状态越少，越不会把「损坏」误显示成「还没填」。
    // `encryptionAvailable` 随车带回，界面据此决定「要不要把账号密码输入区显示出来」：
    // 系统加密不可用时保存必然失败，先摆出来比让用户填完再报错好。
    console.log(`[credential] 查状态 条数=${profileIds.length}`)
    return { items, encryptionAvailable: safeStorage.isEncryptionAvailable() }
  })

  ipcMain.handle('credential:save', async (_event, payload: unknown) => {
    const input = normalizeCredentialInput((payload as { credential?: unknown } | null)?.credential)
    if (input === null) {
      return {
        ok: false as const,
        reason: 'invalid_input',
        detail: '账号与密码都不能为空，且长度要在上限之内。',
      }
    }
    const result = await vault.save(input)
    if (result.ok) {
      console.log(`[credential] 已保存 profileId=${input.profileId}`)
    } else {
      console.warn(`[credential] 保存失败 profileId=${input.profileId} 原因=${result.reason}`)
    }
    return result
  })

  ipcMain.handle('credential:delete', async (_event, payload: unknown) => {
    const profileId = normalizeProfileId((payload as { profileId?: unknown } | null)?.profileId)
    if (profileId === null) {
      return { ok: false as const, reason: 'invalid_profile_id', detail: '配置 id 不合法。' }
    }
    const result = await vault.remove(profileId)
    if (result.ok) {
      console.log(`[credential] 已删除 profileId=${profileId}`)
    } else {
      console.warn(`[credential] 删除失败 profileId=${profileId} 原因=${result.reason}`)
    }
    return result
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

  // **不自动下载**：检测到新版只是「有这件事」，下不下由用户点一下决定。
  //
  // 这条在 0.1.6 改过。原先是 `true`，理由是「用户点重启更新时不该再等一次下载」，
  // 代价是**检测到新版就开始吃掉带宽**，而用户可能正在开会、正在跑别的下载，或者
  // 根本不想现在更新 —— 他连一个「稍后」都没得选。改成显式点击之后，代价是多一次
  // 点击，换来的是这条通道不再自作主张。
  autoUpdater.autoDownload = false
  // 见上方「为什么「重启后生效」这句话是真的」。
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => dispatchUpdateEvent({ type: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    dispatchUpdateEvent({ type: 'available', version: info.version }),
  )
  autoUpdater.on('update-not-available', () => dispatchUpdateEvent({ type: 'not-available' }))
  autoUpdater.on('download-progress', (progress) =>
    dispatchUpdateEvent({
      type: 'progress',
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
      // 时间戳由这一层给：`update.ts` 是纯函数，不读时钟，否则它的用例就得
      // 假装一个时间，而「速度是怎么随时间变化的」恰恰是要断言的东西。
      at: Date.now(),
    }),
  )
  autoUpdater.on('update-downloaded', (info) =>
    dispatchUpdateEvent({ type: 'downloaded', version: info.version, at: Date.now() }),
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

  /**
   * 开始下载（0.1.6）。
   *
   * **不等下载结束就返回**：一次 112 MB 的下载要几十秒到几分钟，让 IPC 挂在那里
   * 会让渲染进程那边一个 `await` 悬上几分钟，中间任何一次组件卸载都变成泄漏。
   * 进度走轮询（`update:status`），这里只负责「踢一脚」。
   *
   * 只在 `available` / `error` 两态接受：已下载完再下是浪费，`idle` 时下载则
   * 说明上游还没告诉我们有哪一版 —— 那种情况下 `downloadUpdate()` 会抛
   * 「Please check update first」。
   */
  ipcMain.handle('update:download', () => {
    if (!updateChannelAvailable()) return updateStatus
    if (updateStatus.phase !== 'available' && updateStatus.phase !== 'error') return updateStatus
    void autoUpdater.downloadUpdate().catch((error: unknown) => {
      dispatchUpdateEvent({
        type: 'error',
        detail: error instanceof Error ? error.message : String(error),
      })
    })
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
    // 先置位：否则窗口的 `close` 拦截会把它当成「藏到托盘」而拦下，更新装不上。
    isQuitting = true
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

/** 扫来源时单个文件最多读多大。超过就当它不可能只是键值库，跳过。 */
const ORIGIN_SCAN_MAX_BYTES = 8 * 1024 * 1024

/** 列一个目录，带上每项的修改时刻。目录不存在或读不动时返回空数组。 */
async function listDir(
  path: string,
): Promise<{ name: string; isFile: boolean; mtimeMs: number }[]> {
  try {
    const dirents = await readdir(path, { withFileTypes: true })
    return await Promise.all(
      dirents.map(async (dirent) => {
        const info = await stat(join(path, dirent.name)).catch(() => null)
        return { name: dirent.name, isFile: dirent.isFile(), mtimeMs: info?.mtimeMs ?? 0 }
      }),
    )
  } catch {
    return []
  }
}

/** 读一个 JSON 文件。不存在、读不动、不是合法 JSON 一律返回 `null`（按「没有偏好」处理）。 */
async function readJsonIfExists(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}

/**
 * 找出「已经存过数据的那些来源」用过的端口，按最近使用倒序。
 *
 * ## 为什么要找它们
 *
 * 首次升级到本版本时，用户的数据躺在**上一版随机分配的那个端口**的分区里。若直接
 * 启用一段全新的固定端口，那些数据不会被删，但**再也访问不到** —— 在用户看来与
 * 「丢了」没有区别。所以候选链里要优先试回这些端口（见 `shell-origin.ts`）。
 *
 * ## 两条来源，精确的那条优先
 *
 * ① `IndexedDB/<来源>.indexeddb.leveldb` —— Chromium 给每个来源建一个目录，目录名
 *    里带端口，**目录 mtime 就是这个来源最后一次被写的时刻**。这是精确信号。
 * ② `Local Storage/leveldb/*.log|*.ldb` —— localStorage 是**单库**，来源名写在键里
 *    （`_http://127.0.0.1:49901\0\1<键名>`），只能扫内容。它补的是「只用过
 *    localStorage、没用过 IndexedDB」的来源。
 *
 * 🔴 **② 不许覆盖 ① 已经记下的时刻。** 同一个 leveldb 文件里装着所有来源的键，它的
 * mtime 对所有来源都是同一个值；拿它去 `remember` 会让每个来源都拿到相同的时间戳，
 * 于是排序退化成目录枚举顺序。实测（本机）：49901 的 IndexedDB 比 57352 晚 4 分钟，
 * 但两者都出现在同一个日志文件里 —— 那个文件的时间把差别抹平之后，外壳挑中了**较旧**
 * 的那一个。所以 ② 只补 ① 没见过的端口。
 *
 * 排障提示：这一层扫不到东西时**不报错**，只是候选链少一段。新机器本来就该扫不到。
 */
async function collectLegacyPorts(userDataDir: string): Promise<number[]> {
  const lastSeen = new Map<number, number>()
  const remember = (port: number, at: number): void => {
    lastSeen.set(port, Math.max(lastSeen.get(port) ?? 0, at))
  }

  for (const entry of await listDir(join(userDataDir, 'IndexedDB'))) {
    const port = parseOriginDirName(entry.name)
    if (port !== null) remember(port, entry.mtimeMs)
  }

  const leveldbDir = join(userDataDir, 'Local Storage', 'leveldb')
  for (const entry of await listDir(leveldbDir)) {
    if (!entry.isFile || !/\.(log|ldb)$/i.test(entry.name)) continue
    const filePath = join(leveldbDir, entry.name)
    const size = await stat(filePath)
      .then((info) => info.size)
      .catch(() => 0)
    if (size === 0 || size > ORIGIN_SCAN_MAX_BYTES) continue
    // 用 `latin1` 读：文件是二进制的，而 latin1 把每个字节映成一个字符，其中的
    // ASCII 片段（来源名就是 ASCII）被原样保留。`utf8` 遇到非法字节序列会替换掉
    // 它们，反而更容易把要找的那串切坏。
    const text = await readFile(filePath, 'latin1').catch(() => '')
    for (const port of parseOriginPortsInText(text)) {
      // 见上面 ② 的注释：这里**只补未知的**。
      if (lastSeen.has(port)) continue
      remember(port, entry.mtimeMs)
    }
  }

  return orderLegacyPorts(lastSeen)
}

/**
 * 起内置服务，并把选中的端口记进 `userData/shell-origin.json`。
 *
 * ## 这一个函数就是「更新后设置不丢」的全部实现
 *
 * 端口 → origin → localStorage / IndexedDB 的分区。把端口钉住，分区就不变，
 * 于是主题、侧栏折叠、纪要草稿、记住的账号、设备标识在**重启与更新之后都还在**。
 * 而更新本身不会碰 `userData`（NSIS 的 `deleteAppDataOnUninstall` 默认为假，
 * 本项目也没有打开它），所以这条链上没有任何一环会丢东西。
 *
 * ## 三个细节是刻意的
 *
 * - **无论落在哪个端口都记下来**，包括兜底的系统分配值。记下来它才稳定；
 *   不记的话下一次又从头挑，等于把这个缺陷重新引入一遍。
 * - **写失败只警告不中断**：偏好写不进去（磁盘满、权限）时外壳仍应能开，
 *   代价是下次端口可能变。
 * - **换分区时打醒目警告**。这是唯一会让人以为「数据丢了」的情况，必须让日志
 *   说清楚「没删，只是这个进程访问不到」—— 否则下一个人会去查数据库。
 */
async function startShellServer(root: string, apiBaseUrl: string): Promise<StaticServerHandle> {
  const userDataDir = app.getPath('userData')
  const preferencePath = join(userDataDir, SHELL_ORIGIN_FILE)
  const stored = parseStoredPort(await readJsonIfExists(preferencePath))
  const legacy = await collectLegacyPorts(userDataDir)
  const candidates = shellPortCandidates(stored, legacy)

  const server = await startStaticServer({ root, apiBaseUrl, preferredPorts: candidates })

  console.log(
    `[shell] 界面来源 http://127.0.0.1:${server.port}` +
      `（${stored === server.port ? '沿用上次' : '本次新定'}；候选 ${candidates.join(' → ')}）`,
  )
  if (isFreshOrigin(server.port, legacy)) {
    console.warn(
      `[shell] ⚠️ 本次端口不在任何已有存储的端口里（已有：${legacy.join('、')}）—— ` +
        '界面上将看不到上次的设置与登录状态。数据没有被删除，只是这个进程访问不到；' +
        '通常是那些端口被别的进程占了，关掉占用者再重启即可恢复。',
    )
  }

  if (stored !== server.port) {
    try {
      await writeFile(preferencePath, `${JSON.stringify({ port: server.port }, null, 2)}\n`, 'utf8')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(
        `[shell] 端口偏好写入失败（${preferencePath}）：${detail}。下次启动端口可能变化。`,
      )
    }
  }

  return server
}

async function bootstrap(): Promise<void> {
  // 非首个实例在模块顶层就 `app.quit()` 了，这里再挡一道 —— `whenReady` 仍会
  // 兑现，不挡的话它会继续把内置服务与窗口都建起来，等于锁白加了。
  if (!isPrimaryInstance) return

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

  registerAppVersionIpc()
  registerServiceIpc()
  registerLaunchIpc()
  // 凭据库要在界面挂载之前就位：配置对话框打开时会问一次「这条配置存的是哪个账号」，
  // 与更新通道同一条理由（晚注册会让那一次拿到「通道不存在」）。
  registerCredentialIpc()
  // 更新通道的 IPC 在窗口之前注册：界面挂载时就会问一次当前状态（见 T6-02 的
  // 「挂载时查一次」），晚注册会让那一次拿到「通道不存在」。
  registerUpdateIpc()

  staticServer = await startShellServer(DIST_ROOT, serviceUrl)
  shellOrigin = `http://127.0.0.1:${staticServer.port}`

  if (IS_SMOKE) {
    await runSmoke()
    return
  }

  const window = buildWindow(true)
  mainWindow = window
  await window.loadURL(`${shellOrigin}/`)
  createTray()

  // 检查放在窗口显示之后：这条链路会去访问网络，不该让它挡在首屏前面。
  wireAutoUpdater()

  app.on('activate', () => {
    if (mainWindow !== null) {
      // 窗口可能只是藏在托盘里（最小化/关闭到托盘），直接恢复而不是新建。
      showMainWindow()
    } else {
      mainWindow = buildWindow(true)
      void mainWindow.loadURL(`${shellOrigin}/`)
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
  const credentials = await probeCredentials(window)

  const ok =
    rendered && consoleErrors.length === 0 && diagnostics.reachable && credentials.reachable
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
  // 凭据通道同理：只看通不通、结构完整不完整，不看本机到底存了哪些账号。
  console.log(
    `[smoke] 凭据通道=${credentials.reachable ? '可用' : '不可用'}` +
      `${credentials.reachable ? ` 加密=${credentials.encryptionAvailable ? '可用' : '不可用'}` : ''}`,
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
 * 从**渲染进程里**查一次凭据状态。
 *
 * 与 `probeDiagnostics` 同一条理由走 `executeJavaScript`：这条链路有四段（预加载桥、
 * 通道名、`contextBridge` 结构克隆、主进程里的 `safeStorage` + 文件读取），主进程自己
 * 调自己只能验到最后一段。
 *
 * **用一个本机不可能存在的配置 id**，于是拿到的一定是 `none`，断言就与这台机器上到底
 * 存了哪些凭据无关 —— 冒烟的成败不允许随用户数据变化。它同时真的走了一遍
 * `readVault`（读文件、解析、按 id 查表），因此「文件读不出来」这类问题会在这里现形。
 *
 * 顺带取回 `encryptionAvailable`：**DPAPI 不可用时冒烟仍然算 PASS** —— 那是本机环境的
 * 事实而不是外壳的缺陷，把它算进成败会让同一份产物在无密钥环的机器上恒失败。只打出来
 * 供排障。
 */
async function probeCredentials(window: BrowserWindow): Promise<{
  reachable: boolean
  encryptionAvailable: boolean
}> {
  const empty = { reachable: false, encryptionAvailable: false }
  try {
    const report = (await window.webContents.executeJavaScript(
      `(async () => {
         const bridge = window.fanheDesktop
         if (typeof bridge?.getCredentialStatus !== 'function') return null
         const result = await bridge.getCredentialStatus(['__smoke_probe__'])
         const item = Array.isArray(result?.items) ? result.items[0] : undefined
         return {
           hasItems: Array.isArray(result?.items) && result.items.length === 1,
           stateKnown:
             item?.state === 'none' ||
             item?.state === 'saved' ||
             item?.state === 'undecryptable',
           encryptionAvailable: result?.encryptionAvailable === true,
         }
       })()`,
      true,
    )) as null | {
      hasItems: boolean
      stateKnown: boolean
      encryptionAvailable: boolean
    }

    if (report === null || !report.hasItems || !report.stateKnown) {
      return empty
    }
    return { reachable: true, encryptionAvailable: report.encryptionAvailable }
  } catch (error) {
    console.error(
      `[smoke] 凭据通道不可用：${error instanceof Error ? error.message : String(error)}`,
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

// 真正退出前的统一钩子：任何会导致退出的路径（托盘「退出」、更新安装、系统注销）都先到这里，
// 把 `isQuitting` 置真，确保窗口的 `close` 拦截不会再把它当成「藏到托盘」。
app.on('before-quit', () => {
  isQuitting = true
})

// 窗口「全部关闭」不再自动退出：本应用常驻托盘，窗口被关（实为隐藏）时进程继续后台运行。
// 真正的退出只来自 `isQuitting` 已置真的那些路径，它们走到这里时窗口已经在销毁，
// 本就不该再拦。macOS 同样沿用（Dock 仍在，可再次唤起）。
app.on('window-all-closed', () => {
  // 空实现：进程靠托盘维持，不在此退出。
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
