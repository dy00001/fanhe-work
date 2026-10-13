/**
 * 「界面跑在哪个宿主里」的判定（T6-03b）。
 *
 * ## 为什么需要它
 *
 * T6-02 的更新提示只有一句话：「服务端已是 vX，**刷新页面即可更新**」。那句话在
 * 浏览器里是对的，在桌面外壳里是错的 —— 外壳加载的是**内置的构建产物**
 * （`apps/web/dist`，经 extraResources 投进安装目录），刷新页面什么都不会变。
 * 用户会照着做、发现没变化，然后不再信这条提示。
 *
 * 所以同一份判定要按宿主给出不同的结论。这个模块只回答「在哪个宿主里」这一个问题，
 * 怎么用是调用方的事。
 *
 * ## 判定依据是显式标记，不是「对象存不存在」
 *
 * `apps/desktop/src/preload.ts` 通过 `contextBridge` 暴露 `window.fanheDesktop`，
 * 其中 `isDesktopShell: true` 是唯一的正式标记。**不靠 `typeof window.fanheDesktop
 * === 'object'` 来推断**：页面脚本可以往 `window` 上挂一个同名对象，那时靠「存在」
 * 判断就会把浏览器当成外壳。
 *
 * ## 它不是一个安全边界
 *
 * 这个值只决定**显示哪句话、点下去走哪条路**。真正的动作在主进程里重新校验：
 * `update:install` 会先看有没有下载好的包，`launch:run` 会重新校验配置形态。
 * 所以即使这里的判断被伪造，能换到的也只是文案。
 *
 * ## 纯函数与边界
 *
 * `detectHost` 收一个 window 形状的对象，**不自己读全局** —— 与 `version-check.ts`
 * 「把环境相关的东西推到边界上」同款，这样它能在 Node 里直接测（`test/host.test.mjs`）。
 * 读全局的 `currentHost` 只是薄薄一层包装。
 */

export type HostKind = 'browser' | 'desktop'

/** `window` 里我们要看的那一部分。写成独立类型，测试才能传一个普通对象进来。 */
export type HostProbeTarget = {
  fanheDesktop?: { isDesktopShell?: unknown } | undefined
}

/**
 * 判定宿主。
 *
 * 拿不到 `window`（服务端渲染、Node 里的测试、被删除的全局）时归 `browser`：
 * **降级方向必须是「浏览器」**，因为浏览器态的文案与动作在任何环境下都不会造成
 * 意外后果（刷新一下而已），而误判成外壳会让界面去调一个不存在的桥。
 */
export function detectHost(target: HostProbeTarget | undefined | null): HostKind {
  if (target === undefined || target === null) return 'browser'
  const bridge = target.fanheDesktop
  if (typeof bridge !== 'object' || bridge === null) return 'browser'
  // 必须是真正的布尔 `true`，`'true'` / `1` / 非空对象都不算 —— 环境变量式的
  // 字符串注入在前端是常见做法，而它在这里会静默改变文案。
  return bridge.isDesktopShell === true ? 'desktop' : 'browser'
}

/** 读当前全局的宿主。见文件头：判定本身在 `detectHost`，这里只是取全局。 */
export function currentHost(): HostKind {
  if (typeof window === 'undefined') return 'browser'
  return detectHost(window as unknown as HostProbeTarget)
}
