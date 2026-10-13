/**
 * 更新通道的状态机（T6-03b）。
 *
 * ## 为什么状态机单独一个文件
 *
 * 同 `diagnostics.ts` 的理由：真正会出错的是**「一串事件过来之后，界面该说什么」**，
 * 而那件事与 Electron 无关。把它写成不 import `electron` 的纯函数，就能在 Node 里
 * 直接喂事件序列断言结果 —— 否则验证「下载完之后又来一次检查，会不会把已下载的
 * 状态冲掉」这种问题，只能靠真的发一版再等一台机器慢慢更新。
 *
 * `main.ts` 那一侧只负责把 `electron-updater` 的回调翻译成这里的事件，再把结果
 * 通过 IPC 交出去。**翻译层刻意做得很薄**，因为它是唯一跑不了单测的部分。
 *
 * ## 三条不变量（下面每条都有对应用例）
 *
 * 1. **`downloaded` 一旦到达就不会被后续的 `checking` / `not-available` / `error`
 *    抹掉。** 这是本文件存在的首要理由：`autoUpdater` 的 `autoInstallOnAppQuit`
 *    依赖这个状态，而它在一次会话里可能检查很多次；某次检查失败就把「新版已就绪」
 *    清掉，会让用户点「重启更新」时什么也不发生 —— 且他刚刚才看到过那条提示。
 *
 * 2. **`error` 保留已知的 `version`。** 报错的是「这次动作失败了」，不是「我们都
 *    不知道有哪个版本」。把已知道的信息一起丢掉，会让日志与界面同时失去线索。
 *
 * 3. **`available` 之后的 `progress` 把阶段推进到 `downloading`，反之不成立。**
 *    `electron-updater` 在 `autoDownload` 为真时会在 `update-available` 之后立刻
 *    开始下载，两个事件之间没有中间态可等；而只收到 `progress` 却没收到
 *    `available` 时，`version` 仍是未知 —— 那种情况下不要把 `version` 编出来。
 *
 * ## 为什么不用 `null` 表示「已是最新」而专门给一个 `up-to-date`
 *
 * 因为这两件事在排障时完全不同：「检查过且没有新版」与「还没检查过」。前者是结论，
 * 后者是初始态。用一个 `idle` 兼表两者，日志里就分不出「检查没生效」和「确实没有
 * 新版」—— 而这两者的下一步动作完全相反。
 */

/** 更新通道的即时状态。 */
export type UpdatePhase =
  /** 还没检查过。 */
  | 'idle'
  /** 正在检查。 */
  | 'checking'
  /** 服务端有新版，尚未下载完。 */
  | 'available'
  /** 正在下载。 */
  | 'downloading'
  /** 已下载完，等待安装（点提示或退出应用时生效）。 */
  | 'downloaded'
  /** 检查过，没有新版。 */
  | 'up-to-date'
  /** 这条通道在本形态下不可用（开发态、冒烟、或平台不支持）。 */
  | 'unsupported'
  /** 出错。 */
  | 'error'

export type UpdateStatus = {
  phase: UpdatePhase
  /**
   * 与本状态相关的那一版。
   *
   * `null` 表示「当前没有已知的版本号」—— 初始态、没查到新版、以及只收到进度却
   * 不知道在下载哪一版时会是这样。**不要用空串**：空串在界面上与「版本号是空」
   * 无法区分，而 `null` 能被 `===` 明确判出来。
   */
  version: string | null
  /** 下载进度，0~1。非 `downloading` 阶段为 `null`。 */
  percent: number | null
  /** 一句话说明，给日志与排障用；界面不直接显示它。 */
  detail: string
}

/**
 * 把 `electron-updater` 的回调翻译成的事件。
 *
 * **刻意与它的回调名解耦**：那边叫 `update-available` / `update-downloaded`，
 * 这里用的是动词化的 `available` / `downloaded`。多一层映射的价值是状态机的用例
 * 不必知道上游的事件名 —— 上游改名时只改 `main.ts` 里的一处翻译。
 */
export type UpdateEvent =
  /** 开始检查。 */
  | { type: 'checking' }
  /** 发现有新版。`version` 由上游给出。 */
  | { type: 'available'; version: string }
  /** 检查完成，没有新版。 */
  | { type: 'not-available' }
  /** 下载进度。`percent` 是上游给的 0~100 的原始值。 */
  | { type: 'progress'; percent: number }
  /** 下载完成，可以安装了。 */
  | { type: 'downloaded'; version: string }
  /** 这条通道在本形态下不可用。 */
  | { type: 'unsupported'; detail: string }
  /** 出错。 */
  | { type: 'error'; detail: string }

export function initialUpdateStatus(): UpdateStatus {
  return { phase: 'idle', version: null, percent: null, detail: '' }
}

/**
 * 把上游给的分比收成 0~1，非有限值归 `null`。
 *
 * 归 `null` 而不是 0：`percent: 0` 在界面上是「刚开始下载」，而
 * 「拿不到进度」应当不显示进度。`NaN` 尤其危险 —— `NaN` 参与的任何比较都是 false，
 * 一个 `percent >= 100` 的判断会因此永远不成立，看起来像「进度条卡住」。
 */
function normalizePercent(raw: number): number | null {
  if (!Number.isFinite(raw)) return null
  if (raw < 0) return 0
  if (raw > 100) return 1
  return raw / 100
}

/**
 * 已下载的版本不会被后续事件抹掉。
 *
 * 判据是「当前是否处于 `downloaded`」，而不是「曾经是否 `downloaded` 过」——
 * 装完并重启之后是新进程，状态自然归零，不需要额外记一个历史标志。
 */
function isReady(status: UpdateStatus): boolean {
  return status.phase === 'downloaded'
}

/**
 * 状态转移。纯函数：同样的状态与事件，永远给出同样的下一个状态。
 */
export function applyUpdateEvent(current: UpdateStatus, event: UpdateEvent): UpdateStatus {
  // 不变量 1：已经就绪之后，只有另一份「已下载」能改变它。
  // `checking` / `not-available` / `error` 一律原样返回 —— 包括 `progress`：
  // 一个已下载好的更新不该因为后台又跑了一次下载而退回 downloading。
  if (isReady(current) && event.type !== 'downloaded') return current

  switch (event.type) {
    case 'checking':
      return { phase: 'checking', version: null, percent: null, detail: '' }

    case 'available':
      return { phase: 'available', version: event.version, percent: null, detail: '' }

    case 'not-available':
      // 不变量 3 的推论：没查到新版时不保留上一次的 version，否则界面可能拿着一个
      // 过期的版本号去显示「有新版」。
      return { phase: 'up-to-date', version: null, percent: null, detail: '' }

    case 'progress':
      // 不变量 3：推进到 downloading，但**不编造 version** ——
      // 只收到进度时我们并不知道在下载哪一版，保留当前已知的（可能是 null）。
      return {
        phase: 'downloading',
        version: current.version,
        percent: normalizePercent(event.percent),
        detail: '',
      }

    case 'downloaded':
      return { phase: 'downloaded', version: event.version, percent: 1, detail: '' }

    case 'unsupported':
      return { phase: 'unsupported', version: null, percent: null, detail: event.detail }

    case 'error':
      // 不变量 2：保留 version 与 percent（进度对判断「下载到一半失败」有用）。
      return {
        phase: 'error',
        version: current.version,
        percent: current.percent,
        detail: event.detail,
      }
  }
}

/**
 * 现在点「重启更新」会不会真的装。
 *
 * **它是 `main.ts` 里那个 IPC 处理函数的唯一判据**，抽出来是为了让「什么时候该
 * 拒绝安装」也能被断言 —— 否则那段判断只能靠真的点一次界面来验。
 */
export function isReadyToInstall(status: UpdateStatus): boolean {
  return status.phase === 'downloaded' && status.version !== null
}

/**
 * 一行日志。`main.ts` 打它，验收脚本按前缀匹配它。
 *
 * 版本号与进度**只在有值时才写出来**：`version=null` 这种占位会让人以为版本号真的
 * 叫 null，而这一行的用途正是在没有图形界面时判断「它在做什么」。
 */
export function describeUpdateStatus(status: UpdateStatus): string {
  const parts = [`阶段=${status.phase}`]
  if (status.version !== null) parts.push(`版本=${status.version}`)
  if (status.percent !== null) parts.push(`进度=${Math.round(status.percent * 100)}%`)
  if (status.detail !== '') parts.push(`说明=${status.detail}`)
  return parts.join(' ')
}
