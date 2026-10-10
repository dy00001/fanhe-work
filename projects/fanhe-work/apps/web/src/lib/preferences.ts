/**
 * 本机界面偏好。
 *
 * 与 `session.ts`、`credential.ts` 的差别在「丢了会怎样」：那两个存的是身份凭证，
 * 丢失的代价是重新登录或重新输密码；这里存的是观感偏好，丢失只是回到默认值。
 * 因此本模块不加密、不做版本迁移，读写失败一律静默回落 —— 为「侧栏是宽是窄」
 * 写一套恢复逻辑，收益远小于它引入的分支。
 *
 * **只存本机，不进数据库。** 偏好落在浏览器 localStorage 里，换机、换浏览器、
 * 清缓存都会回到默认。这是刻意的：桌面外壳下每台机器的窗口尺寸不同，把折叠状态
 * 同步到服务端反而会造出「在这台机器上收起了，到那台机器上还是收起的」。
 *
 * 键名前缀 `fanhe-work.ui.` 把界面偏好与身份类数据分开。除了便于在浏览器存储面板
 * 里一眼分辨，也为将来「恢复默认设置」留出空间：按前缀清理即可，不会碰到会话。
 *
 * 单开一个文件而不是写进 `AppShell.tsx`，一是 react-refresh 的约束（一个文件同时
 * 导出组件与非组件时，热更新无法确定该保留哪一部分的状态，见 `auth/context.ts`
 * 的同款说明），二是与 `session.ts`、`credential.ts` 的分层保持一致：存储细节
 * 不进组件。
 */

/** 侧栏折叠状态。值为 `'true'` 或 `'false'`。 */
const SIDEBAR_COLLAPSED_KEY = 'fanhe-work.ui.sidebar-collapsed'

/**
 * 读取侧栏折叠偏好。
 *
 * **只有 `'true'` 算折叠，其余一律按展开处理。** 不用 `Boolean()` 转换：那样任何
 * 非空字符串（手改出来的 `'maybe'`、旧版本留下的 `'1'`）都会被当成折叠。偏好读不懂
 * 时应当退回默认值，而不是猜一个方向 —— 猜错的表现是「侧栏莫名其妙收起来了」，
 * 而用户没有任何办法把它改回去（他能做的操作本来就会改写这个值，所以其实改得回去；
 * 但那一刻他已经不知道该不该信这个界面了）。
 *
 * 读不出来（隐私模式、存储被禁用）同样按展开处理。
 */
export function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * 写入侧栏折叠偏好。
 *
 * 写不进去不是致命错误：本次会话内界面照常工作，只是下次打开回到默认值。把异常
 * 抛出去会让一次次要的存储失败打断用户的折叠操作，代价与收益不成比例。
 */
export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? 'true' : 'false')
  } catch {
    // 见上。
  }
}
