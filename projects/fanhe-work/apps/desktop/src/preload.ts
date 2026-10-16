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
 * §2.9 再加一个：
 * - `getLaunchIcons(paths)` —— 批量取可执行文件的真实图标。**传的是路径数组**（取图标
 *   只需要路径，不必知道配置叫什么），返回 `path → dataUrl` 的条目表。走 Electron 内置
 *   的 `app.getFileIcon`，与系统「图标来源」同一套实现，因此与桌面快捷方式显示的一致。
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
 * P1 再添三个，都属本机凭据库（第三方账号密码）：
 * - `getCredentialStatus(profileIds)` —— 查一组配置的凭据状态与掩码账号。**不返回
 *    明文密码**，也**刻意没有 `getCredential` 这个口子**：密码只在主进程内解密。
 * - `saveCredential(input)` —— 存一条（账号 + 密码一起，覆盖同 `profileId` 的旧条目）。
 * - `deleteCredential(profileId)` —— 删一条。
 *
 * 三者的入参都经主进程的归一函数复核（见 `credential-vault.ts`），调用方不必替它担保，
 * 但**不要**把 `saveCredential` 当成能存任意长字符串的地方 —— 超长会被拒。
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
import type { CredentialState, CredentialStatusResult } from './credential-vault.js'

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

/** 批量启动里一条的结果。失败项带 `reason`（机器可读码）与 `detail`（可显示文案）。 */
export type LaunchRunManyItemResult = {
  profileId: string
  ok: boolean
  /** 成功时才有：子进程 id。 */
  pid?: number
  /** 失败时才有：机器可读码（invalid_profile / executable_missing / spawn_failed / agent_unavailable）。 */
  reason?: string
  /** 失败时才有：可展示文案。 */
  detail?: string
}

/** 批量启动的聚合结果。每条独立成功/失败，汇总给成功数与失败数。 */
export type LaunchRunManyResult = {
  results: LaunchRunManyItemResult[]
  summary: { total: number; success: number; failed: number }
}

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
 * 一键检测的结果（2.5）。与 `apps/desktop/src/agent.ts` 的 `LaunchPathDetection` 同源，
 * 这里多包一层 IPC 信封（`software` / `agentAvailable`）。
 *
 * `preferred` 是界面回填用的首选路径；`candidates` 是所有本机命中的候选，界面可据此给
 * 一个下拉让用户从多个安装位置里挑。`agentAvailable` 为 false 时表示本机代理没加载
 * 出来，此时 `preferred` / `candidates` 一定为空，界面据此提示「检测不可用」而非假装没找到。
 */
export type LaunchPathDetectResult = {
  /** 被检测的软件标识（原样回传，便于界面把结果与请求对上）。 */
  software: string
  /** 首选可执行路径；一个都没命中为 null。 */
  preferred: string | null
  /** 所有命中（经 inspect 复核存在）的候选路径，可空。 */
  candidates: string[]
  /** 本机代理是否可用 —— 检测依赖它与启动同款的 `inspectExecutablePath`。 */
  agentAvailable: boolean
  /** 代理不可用时给一句可显示的原因。 */
  detail?: string
}

/**
 * 安装请求的结果。
 *
 * 失败只有一种原因（没有下载好的包），但**刻意带上 detail**：界面在开发态点到这一行
 * 时，只有「没准备好」这四个字会让人以为功能坏了，而实际原因是「开发态不检查更新」。
 */
export type UpdateInstallResult = { ok: true } | { ok: false; reason: 'not_ready'; detail: string }

/**
 * 一条程序图标（§2.9）。
 *
 * `dataUrl` 是 `data:image/png;base64,…`；取不到时是 null，界面回落内置的通用图标。
 * `path` 原样回传请求里那一条的写法 —— 同一条 exe 可能被两条配置指向，界面按路径
 * 把结果配回去，不必依赖数组下标（那样一旦有路径被丢弃就会整体错位）。
 */
export type LaunchIconEntry = {
  path: string
  dataUrl: string | null
}

/** 批量取图标的结果。 */
export type LaunchIconResult = {
  icons: LaunchIconEntry[]
}

/**
 * 一条配置的凭据状态（P1）。
 *
 * 详细说明见 `credential-vault.ts` 的 `CredentialStatusResult` —— 这里只补一句与界面
 * 直接相关的：**`none` 与 `undecryptable` 都要把密码框显示成空的**，但提示文案是两个
 * 方向（「还没填」对「换机/换用户后本机解不开了，请重新填」）。混成一个是多账号场景下
 * 最难自查的一类问题：用户在换机后反复重填、反复失败，而界面看不出问题不在他身上。
 */
export type CredentialStatusItem = CredentialStatusResult

/** 三态单独再导出一份，便于在主进程侧写 `state === 'saved'` 的分支时不必 import 两个名字。 */
export type { CredentialState }

/** 查凭据状态的返回。空数组入参时也是空数组，不会报错。 */
export type CredentialStatusReply = {
  items: readonly CredentialStatusItem[]
  /**
   * 本机系统加密是否可用（Windows 下是 DPAPI 是否就绪）。
   *
   * 界面据此决定**要不要把账号密码输入区显示出来**：不可用时保存必然失败（主进程会拒
   * 绝且不落明文），先摆出来比让用户填完再报错好。它不是机密，只是本机能力的一个事实。
   */
  encryptionAvailable: boolean
}

/**
 * 保存请求。
 *
 * `label` 只是明文外壳里的提示（取配置显示名），非机密：凭据库文件被拷到别的机器上
 * 解不开时，用户仍能看出「原本存的是哪一条」。**密码只走这条路，没有第二条读的口子。**
 */
export type CredentialSaveInput = {
  profileId: string
  account: string
  password: string
  label?: string | undefined
}

/**
 * 写操作的结果。
 *
 * `reason` 是机器可读码，界面据此分流：`encryption_unavailable`（本机系统加密不可用，
 * 重启应用再试）、`vault_corrupt`（文件损坏，按提示里的路径备份后删除）、
 * `invalid_input`（账号或密码为空 / 超长）、`write_failed`（磁盘或权限）。
 * **没有「网络错误」这一类** —— 这条通道根本不碰网络。
 */
export type CredentialWriteReply = { ok: true } | { ok: false; reason: string; detail: string }

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
   * 批量启动一组配置。
   *
   * 与 `runLaunchProfile` 同一条承载：入参是配置数组，主进程不连库、每条重新校验形态。
   * 返回聚合结果，每条独立成功/失败、互不影响；汇总层给出成功数与失败数。单条失败只
   * 落在自己那一项上，界面据此给各自可照做的出口。
   */
  runLaunchProfiles: (profiles: unknown): Promise<LaunchRunManyResult> =>
    ipcRenderer.invoke('launch:runMany', { profiles }) as Promise<LaunchRunManyResult>,
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
  /**
   * 一键检测本机路径（2.5）。
   *
   * 入参是 `software` 与一个可选的 `extraPath`（用户已经填过、想顺带校验的路径）。
   * 主进程扫本机已知安装位置、用与启动同款的 `inspectExecutablePath` 复核，返回首选命中
   * + 候选清单。浏览器里没有本机文件系统，这条通道只有外壳场景有意义，界面对应的
   * 「一键检测」按钮只在桌面态渲染。
   */
  detectLaunchPath: (software: string, extraPath?: string): Promise<LaunchPathDetectResult> =>
    ipcRenderer.invoke('launch:detect', { software, extraPath }) as Promise<LaunchPathDetectResult>,
  /**
   * 批量取可执行文件的真实图标（§2.9）。
   *
   * 入参是**路径数组**，不是配置数组 —— 取图标只需要路径。传绝对路径；相对路径、空串、
   * 非字符串会在主进程被丢弃（见 `launch-icon.ts` 的 `normalizeIconPaths`）。
   *
   * 传 `.lnk` 拿不到目标的图标：实测 9 个不同的快捷方式返回的 PNG 逐字节相同，都是系统
   * 那张「快捷方式」通用图标。要的是快捷方式**指向的那个 exe** 的路径。
   */
  getLaunchIcons: (paths: string[]): Promise<LaunchIconResult> =>
    ipcRenderer.invoke('launch:icon', { paths }) as Promise<LaunchIconResult>,
  /**
   * 查一组配置的凭据状态（P1）。
   *
   * 入参是**配置 id 数组**，与 `getLaunchIcons` 同一条承载：主进程不连数据库，不知道
   * 配置叫什么，只认 id。每个被问到的 id 都会拿到一条结果（包括「还没填」的那种）——
   * 这是为了区分 `none` 与 `undecryptable` 所必需的，缺一条就没法判断。
   *
   * 返回里的账号是掩码形式。**没有读取明文的姊妹方法**，见 `saveCredential` 的注释。
   */
  getCredentialStatus: (profileIds: string[]): Promise<CredentialStatusReply> =>
    ipcRenderer.invoke('credential:status', { profileIds }) as Promise<CredentialStatusReply>,
  /**
   * 保存一条凭据（账号 + 密码，P1）。
   *
   * 同 `profileId` 重复保存是覆盖，不是追加 —— 一条配置只对应一个账号密码。加密不可用
   * 时拒绝写入且**不落明文**，此时 `reason` 是 `encryption_unavailable`。
   *
   * 🔴 **没有配对的读取方法，这是刻意的。** 密码从这条路进主进程，被 `safeStorage`
   * 加密后落盘，此后只在 P2 自动填表那一刻在主进程内被解密。把它送回渲染进程需要多开
   * 一个口子，而那个口子会让「密码不出主进程」这条约束变成一句空话 —— 一次同源 XSS
   * 就够把它读走。界面上的密码框恒为空，「改没改」由调用方的意图决定（不调 = 不改，
   * 调 = 覆盖），不需要先读再比。
   */
  saveCredential: (input: CredentialSaveInput): Promise<CredentialWriteReply> =>
    ipcRenderer.invoke('credential:save', { credential: input }) as Promise<CredentialWriteReply>,
  /**
   * 删掉一条凭据（P1）。软删除是幂等的：本来就没有也返回 `ok`。
   *
   * 用在两处：用户在对话框里点「清除密码」，以及删除启动配置时顺手清掉它的凭据
   * （否则 `userData` 里会留下一份再也配不上任何配置的孤儿密文）。
   */
  deleteCredential: (profileId: string): Promise<CredentialWriteReply> =>
    ipcRenderer.invoke('credential:delete', { profileId }) as Promise<CredentialWriteReply>,
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
