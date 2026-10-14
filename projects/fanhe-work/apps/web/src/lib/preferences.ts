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

/**
 * 侧栏折叠状态。值为 `'true'` 或 `'false'`。
 *
 * **0.1.3 布局重置迁移：键名从 `fanhe-work.ui.sidebar-collapsed` 升到
 * `…v2`，旧键不再被读。** 原因是 0.1.3 重做了侧栏的折叠对齐（`nav` 在折叠
 * 态改为 `px-0`）、托盘常驻与运行期版本号读取；开发期间为验证折叠对齐曾把
 * `'true'` 写入此键，跨会话持久化在 Electron 的 userData 里，导致每一次启
 * 动都从折叠态开始 —— 而折叠态按设计就是无文字、底色与边框极淡（`bg-card`
 * =#fff 对 `bg-background`=#fafafa 仅 5 档差），看起来像「侧栏没修好」。
 * 升键名让旧值自然失效、新键从默认（展开）开始，是一次性的、**故意不可逆**
 * 的偏好重置。注释里写明原因，方便以后翻历史时知道键名为何突变。
 */
const SIDEBAR_COLLAPSED_KEY = 'fanhe-work.ui.sidebar-collapsed.v2'

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

/**
 * 主题偏好。
 *
 * `'system'` 是**第三个值，不是「没存过」**。把它折算成读到的实际亮暗再存回去，等于
 * 存了一个瞬间的快照而不是一条规则：用户在系统里改了深浅，界面不会跟着变，因为他
 * 选的是「跟随系统」，而库里躺着的却是当时那个具体值。所以这里读什么存什么。
 */
export type ThemePreference = 'light' | 'dark' | 'system'

/** 主题偏好。值为 `'light'` / `'dark'` / `'system'`。 */
const THEME_KEY = 'fanhe-work.ui.theme'

/**
 * 判断一个值是不是合法的主题偏好。
 *
 * 合法值只有这一处定义，读侧（`readThemePreference`）与写侧（菜单的选中回调）都用它。
 * 两处各写一遍的话，将来加一档（比如「高对比度」）会漏改其中之一，而漏改的那一侧
 * 表现为「选了没反应」—— 回调里的守卫把新值挡掉了，界面上什么都不会发生。
 */
export function isThemePreference(value: string | null): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system'
}

/**
 * 读取主题偏好。
 *
 * 读不懂（旧版本留下的 `'auto'`、手改出来的 `'1'`）一律回落 `'system'`，而不是某个
 * 固定的亮或暗：跟随系统是唯一不会让用户觉得「界面坏了」的默认档 —— 它至少与用户
 * 此刻看到的其它窗口一致。这与侧栏折叠那边「读不懂就展开」是同一条原则，只是默认值
 * 取得不同。
 *
 * 读不出来（隐私模式、存储被禁用）同样按跟随系统处理。
 */
export function readThemePreference(): ThemePreference {
  try {
    const raw = window.localStorage.getItem(THEME_KEY)
    return isThemePreference(raw) ? raw : 'system'
  } catch {
    return 'system'
  }
}

/** 写入主题偏好。写不进去不是致命错误：本次会话内界面照常切换，只是下次打开回到默认。 */
export function writeThemePreference(preference: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_KEY, preference)
  } catch {
    // 见上。
  }
}
