/**
 * 预加载脚本。
 *
 * 运行在渲染进程里、但在页面脚本之前，且处在独立的隔离世界里（`contextIsolation`
 * 为真）。它唯一的职责是**经 `contextBridge` 暴露一组受控的只读信息**——渲染进程
 * 不能直接碰 Node，所有能力都必须在这里显式开口子。
 *
 * T4-01 只开一个口：运行环境标识。它让界面能回答「我是在外壳里还是在浏览器里」，
 * 也是「预加载确实跑过了」的最小证据。代理调用（T4-03）与 `safeStorage`
 * （凭据存储迁移）会在这里追加新的通道，届时按 `invoke/handle` 成对实现，
 * **不要**直接把 `ipcRenderer` 整个暴露出去。
 *
 * 沙箱（`sandbox: true`）下预加载只能拿到 `electron` 模块与少数几个 Node 垫片，
 * `process.platform` / `process.versions` 在其中可用，因此下面不需要任何额外依赖。
 */
import { contextBridge } from 'electron'

const desktopBridge = Object.freeze({
  /** 供界面判定「当前跑在外壳里」。浏览器里这个对象不存在。 */
  isDesktopShell: true as const,
  platform: process.platform,
  versions: Object.freeze({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }),
})

contextBridge.exposeInMainWorld('fanheDesktop', desktopBridge)

export type DesktopBridge = typeof desktopBridge
