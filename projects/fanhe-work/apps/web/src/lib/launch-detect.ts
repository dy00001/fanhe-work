import { currentHost } from './host.ts'

/**
 * 一键检测的结果（2.5）。
 *
 * 与 `apps/desktop/src/preload.ts` 的 `LaunchPathDetectResult` 同源同形：界面只关心这一份
 * 结构，桌面态由 `launch:detect` IPC 返回、浏览器态由本模块回落成空结果。两份定义刻意
 * 一致而不是互相 import——web 不依赖 desktop（壳反过来依赖 web 的构建产物），所以没有
 * 可以共享的类型来源；少一个字段会在编译期报错，那正是我们要的失败方向。
 *
 * `preferred` 是回填用的首选路径；`candidates` 是所有本机命中的候选，界面可据下拉让用户
 * 从多个安装位置里挑。`agentAvailable` 为 false 表示本机代理没加载出来，桌面态下界面据此
 * 提示「检测不可用」而非假装没找到。
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
 * 一键检测本机路径（2.5）。
 *
 * **宿主分流**与单条启动 / 批量启动同一条：桌面态走 `launch:detect` IPC（主进程用与启动
 * 同款的 `inspectExecutablePath` 复核候选，因此不会出现「检测说在、点启动说不在」），
 * 浏览器态没有本机文件系统、检测无意义，回落为空结果（界面只在桌面态显示「一键检测」入口，
 * 不会真正调用到这里）。两者返回同一份 `LaunchPathDetectResult`，界面不感知差异。
 */
export function detectLaunchPath(
  software: string,
  extraPath?: string,
): Promise<LaunchPathDetectResult> {
  if (currentHost() === 'desktop' && window.fanheDesktop?.detectLaunchPath) {
    return window.fanheDesktop.detectLaunchPath(software, extraPath)
  }
  return Promise.resolve({ software, preferred: null, candidates: [], agentAvailable: false })
}
