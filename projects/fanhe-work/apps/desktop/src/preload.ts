/**
 * 预加载脚本。
 *
 * 运行在渲染进程里、但在页面脚本之前，且处在独立的隔离世界里（`contextIsolation`
 * 为真）。它唯一的职责是**经 `contextBridge` 暴露一组受控能力**——渲染进程
 * 不能直接碰 Node，所有能力都必须在这里显式开口子。
 *
 * T4-01 只开一个口：运行环境标识。它让界面能回答「我是在外壳里还是在浏览器里」，
 * 也是「预加载确实跑过了」的最小证据。
 *
 * T4-02 加两个口，都走 `invoke` / `handle` 成对实现：
 * - `getServiceStatus()` —— 当前服务地址、来源、配置文件路径与警告。
 * - `setServiceUrl(url)` —— 写配置文件；**不在运行中换上游**，返回 `needsRestart`
 *   让界面提示「重启后生效」。
 *
 * T4-03 再加一个：
 * - `runLaunchProfile(profile)` —— 启动一条启动配置。**传的是整条配置对象**，主进程
 *   会重新校验它的形态（见 `agent.ts`）：这条通道对渲染进程开放，路径与参数不能
 *   只信调用方送来的值。
 *
 * T4-04 再加一个：
 * - `checkLaunchProfiles(profiles)` —— 启动自检。**传的是配置数组**，理由同上。
 *   返回一份报告，里面每条问题都带一句能照着做的引导。
 *
 * T6-03b 再加三个，都属更新通道：
 * - `getUpdateStatus()` —— 当前状态（阶段、版本、进度）。界面据此决定那一行说什么。
 * - `checkForUpdates()` —— 主动查一次。**它只检查并下载，不安装。**
 * - `installUpdate()` —— 安装已下载的新版并退出应用。**没有下载好的包时会被拒绝**，
 *   判据在主进程的 `isReadyToInstall`，不在这里 —— 这条通道对页面脚本开放，而
 *   `quitAndInstall()` 会让应用退出，不能只信调用方说「准备好了」。
 *
 * T7-05 再加一个**非函数**字段：
 * - `appVersion` —— 运行期的应用版本号，由主进程经 `ipcMain.on('app:version')` 提供、
 *   这里用 `ipcRenderer.sendSync('app:version')` 在页面脚本之前取到（见 `main.ts` 的
 *   `registerAppVersionIpc` 与 `readAppVersion`）。界面上「本机是哪一版」必须用它，而不是
 *   前端产物里那个构建期常量：后者回答的是「这份前端什么时候构建的」，两者在打包链路
 *   漏掉一次重建之后就会分叉（`v0.1.2` 实测：包里烧着 `0.1.1`，界面显示成旧版本）。
 *   `app.getVersion()` 读的是被打包的那份 `package.json`，**恒等于用户装的那一版**。
 *   第一版曾走 `webPreferences.additionalArguments` + 预加载 `require` 本地模块，被冒烟
 *   当场拦下（沙箱化预加载不能 `require` 本地模块），后改 IPC，详见 `main.ts` 同段注释。
 *
 * T4-03 之后的代理调用与 `credential.ts` 的 `safeStorage` 迁移会在这里继续按同样
 * 的成对方式追加通道。
 *
 * **不要**直接把 `ipcRenderer` 整个暴露出去。
 *
 * 沙箱（`sandbox: true`）下预加载只能拿到 `electron` 模块与少数几个 Node 垫片，
 * `process.platform` / `process.versions` / `process.argv` 在其中可用，因此下面
 * 不需要任何额外依赖。更新状态的那个类型是 `import type`，编译后会被擦掉，不会给
 * 预加载引入运行期依赖。
 */
import { contextBridge, ipcRenderer } from 'electron'

import type { UpdateStatus } from './update.js'

/**
 * 运行期的应用版本号（T7-05）。
 *
 * 界面上的「本机是哪一版」必须用它，而不是前端产物里那个构建期常量 —— 后者回答的是
 * 「这份前端是哪一版、什么时候构建的」，而**不是**「用户装的是哪一版」。两者在打包链路
 * 漏掉一次前端重建之后就会分叉（`v0.1.2` 实测：包里烧着 `0.1.1`，界面显示成旧版本）。
 * `app.getVersion()` 读的是被打包的那份 `package.json`，恒等于用户装的那一版。
 *
 * **`sendSync` 而不是 `invoke`。** 预加载脚本在页面脚本之前执行，要把这个值直接摆到
 * 桥上；`invoke` 是异步的，界面会先渲染一版没有版本号、再补一版 —— 那正是这个字段
 * 要消除的「先显示一个不对的值」。启动时只发生一次，阻塞的代价可以忽略。
 *
 * **这里刻意不 `require()` 任何本地模块。** 沙箱化的预加载只能 require `electron` 与
 * 少数几个 Node 垫片；第一版把解析逻辑抽成 `src/app-version.ts` 再导入，冒烟当场拦下
 * —— `Unable to load preload script … module not found: ./app-version.js`，
 * **整条桥都没了**（连 `isDesktopShell` 一起消失）。逻辑只有两行，不值得为它引本地模块。
 *
 * 校验不在这里做：只原样回传。取值与回落都在前端的 `lib/version.ts`
 * （`readBridgedAppVersion` / `pickAppVersion`）——那是要显示它的地方，
 * 也是唯一需要判断「什么值可用」的地方。这里放一个空串，前端自会回落。
 */
function readAppVersion(): string {
  const value: unknown = ipcRenderer.sendSync('app:version')
  return typeof value === 'string' ? value : ''
}

export type ServiceStatus = {
  /** 当前生效的服务地址。尚未读取完成时为空串。 */
  serviceUrl: string
  /** 'environment' | 'file' | 'default'。 */
  source: string
  /** 上者的人类可读形式，界面直接显示，不必自己再映射一次。 */
  sourceLabel: string
  /** 配置文件绝对路径；未定位到时为空串。 */
  path: string
  /** 读配置时遇到的问题；没有则 null。 */
  warning: string | null
}

export type SetServiceResult =
  { ok: true; serviceUrl: string; needsRestart: true } | { ok: false; error: string }

export type LaunchRunResult =
  | {
      ok: true
      data: { profileId: string; pid: number; startedAt: string; deduplicated: boolean }
    }
  | { ok: false; reason: string; detail: string }

/** 自检里一条问题。`reason` 三类各有不同的引导方向，界面据此决定渲染什么。 */
export type LaunchDiagnosticResult = {
  /** 该配置在传入数组里的下标。形态不合法时它是唯一可靠的指认依据。 */
  index: number
  profileId: string
  name: string
  executablePath: string
  reason: 'agent_unavailable' | 'invalid_profile' | 'path_unavailable'
  detail: string
}

/**
 * 自检报告。
 *
 * **它总是能被显示，不存在「检查失败」这个状态** —— 连代理加载不了也会变成一条
 * `agent_unavailable`。界面因此不必区分「没检查成」与「检查出问题」，而用户也
 * 分不清那两者的区别。
 */
export type LaunchDiagnosticsResult = {
  agentAvailable: boolean
  total: number
  okCount: number
  diagnostics: LaunchDiagnosticResult[]
}

/**
 * 安装请求的结果。
 *
 * 失败只有一种原因（没有下载好的包），但**刻意带上 detail**：界面在开发态点到这一行
 * 时，只有「没准备好」这四个字会让人以为功能坏了，而实际原因是「开发态不检查更新」。
 */
export type UpdateInstallResult = { ok: true } | { ok: false; reason: 'not_ready'; detail: string }

const desktopBridge = Object.freeze({
  /** 供界面判定「当前跑在外壳里」。浏览器里这个对象不存在。 */
  isDesktopShell: true as const,
  /**
   * 运行期的应用版本号，等于已装 exe 的版本。取不到时是空串（界面据此回落）。
   *
   * 读法与理由见 `app-version.ts`。**界面上的「本机是哪一版」必须用这个值** ——
   * 前端产物里那个构建期常量在打包链路漏掉一次重建之后就会与实际装的版本分叉。
   */
  appVersion: readAppVersion(),
  platform: process.platform,
  versions: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }),
  /** 读当前服务地址及其来源。 */
  getServiceStatus: (): Promise<ServiceStatus> =>
    ipcRenderer.invoke('service:status') as Promise<ServiceStatus>,
  /** 写服务地址配置。运行中不换上游，需重启外壳才生效。 */
  setServiceUrl: (serviceUrl: string): Promise<SetServiceResult> =>
    ipcRenderer.invoke('service:set', { serviceUrl }) as Promise<SetServiceResult>,
  /**
   * 启动一条配置。
   *
   * **入参是整条 `LaunchProfile`**（含 `executablePath` 与 `args`），因为主进程不连
   * 数据库、配置得由界面从 `GET /api/launch/profiles` 取到再送进来。主进程会重新
   * 校验形态，所以调用方不必替它担保 —— 但也**不要**把这条通道当成可以传任意路径
   * 与参数的地方，那不是它的工作方式。
   */
  runLaunchProfile: (profile: unknown): Promise<LaunchRunResult> =>
    ipcRenderer.invoke('launch:run', { profile }) as Promise<LaunchRunResult>,
  /**
   * 启动自检。
   *
   * **入参是配置数组**，理由与 `runLaunchProfile` 相同：主进程不连数据库。
   *
   * 返回值**总是**一份可显示的报告 —— 代理不可用也会变成一条 `agent_unavailable`
   * 诊断而不是一个错误。界面因此不必处理「检查失败」这个第四种状态。
   */
  checkLaunchProfiles: (profiles: unknown): Promise<LaunchDiagnosticsResult> =>
    ipcRenderer.invoke('launch:diagnostics', { profiles }) as Promise<LaunchDiagnosticsResult>,
  /** 更新通道的当前状态。界面挂载时问一次，之后按需要重问。 */
  getUpdateStatus: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke('update:status') as Promise<UpdateStatus>,
  /**
   * 主动查一次更新。**只检查并下载，不安装** —— 安装是 `installUpdate`。
   *
   * 返回检查之后的状态。开发态与冒烟态下通道不可用，此时返回的 `phase` 是
   * `unsupported` 而不是抛错，调用方不必为此写一条分支。
   */
  checkForUpdates: (): Promise<UpdateStatus> =>
    ipcRenderer.invoke('update:check') as Promise<UpdateStatus>,
  /** 安装已下载的新版并退出应用。没有就绪的包时返回 `not_ready`，应用不会退出。 */
  installUpdate: (): Promise<UpdateInstallResult> =>
    ipcRenderer.invoke('update:install') as Promise<UpdateInstallResult>,
})

contextBridge.exposeInMainWorld('fanheDesktop', desktopBridge)

export type DesktopBridge = typeof desktopBridge
