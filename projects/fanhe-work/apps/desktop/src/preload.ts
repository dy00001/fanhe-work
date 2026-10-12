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
 * T4-03 之后的代理调用与 `credential.ts` 的 `safeStorage` 迁移会在这里继续按同样
 * 的成对方式追加通道。
 *
 * **不要**直接把 `ipcRenderer` 整个暴露出去。
 *
 * 沙箱（`sandbox: true`）下预加载只能拿到 `electron` 模块与少数几个 Node 垫片，
 * `process.platform` / `process.versions` 在其中可用，因此下面不需要任何额外依赖。
 */
import { contextBridge, ipcRenderer } from 'electron'

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

const desktopBridge = Object.freeze({
  /** 供界面判定「当前跑在外壳里」。浏览器里这个对象不存在。 */
  isDesktopShell: true as const,
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
})

contextBridge.exposeInMainWorld('fanheDesktop', desktopBridge)

export type DesktopBridge = typeof desktopBridge
