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

/**
 * 一次下载的字节级事实。
 *
 * `percent` 单独一个字段不够用：界面上要显示「已下载 / 总大小 / 速度 / 剩余时间」，
 * 而这几项都不能由百分比反推（百分比是 0~100 的整数化结果，反推出来的字节数在
 * 小文件上会跳，在断点续传时会错）。
 */
export type UpdateTransfer = {
  /** 已下载字节数。 */
  transferred: number
  /** 总字节数。上游拿不到时为 `null`（那时只能显示已下载量）。 */
  total: number | null
  /** 平滑后的速度（字节/秒）。拿不到任何样本时为 `null`，**不要写成 0** —— 0 在界面上是「停了」。 */
  bytesPerSecond: number | null
  /** 本轮下载开始的时间戳（毫秒）。界面用它算「已用时间」。 */
  startedAt: number | null
  /** 最后一次收到进度的时间戳（毫秒）。界面用它判断「是不是停了」。 */
  updatedAt: number | null
}

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
  /** 下载的字节级事实。没有在下载、或上游一个字节都没报过时为 `null`。 */
  transfer: UpdateTransfer | null
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
  /** 下载进度。`percent` 是上游给的 0~100 的原始值；其余字段是同一事件的字节级事实。 */
  | {
      type: 'progress'
      percent: number
      /** 已下载字节数。上游没给时不传。 */
      transferred?: number
      /** 总字节数。上游没给时不传。 */
      total?: number
      /** 上游自报的瞬时速度（字节/秒），只在没有本地样本时作为初值。 */
      bytesPerSecond?: number
      /** 事件时间戳（毫秒）。由翻译层传入，纯函数不读时钟。 */
      at?: number
    }
  /** 下载完成，可以安装了。 */
  | { type: 'downloaded'; version: string; at?: number }
  /** 这条通道在本形态下不可用。 */
  | { type: 'unsupported'; detail: string }
  /** 出错。 */
  | { type: 'error'; detail: string }

export function initialUpdateStatus(): UpdateStatus {
  return { phase: 'idle', version: null, percent: null, transfer: null, detail: '' }
}

/**
 * 速度平滑系数。
 *
 * 上游的 `bytesPerSecond` 是它自己那段窗口的均值，而界面要每秒刷新一次 —— 直接拿
 * 单次样本去显示，速度会在 800 KB/s 与 3 MB/s 之间来回跳，读起来像网络在抖。
 * 用指数滑动平均把噪声压掉，同时保留「真的掉速了」时的可见下降。
 *
 * 0.35 是取舍：太大（如 0.8）压不住抖，太小（如 0.1）在断流时要好几秒才归零，
 * 那几秒里界面会显示一个不存在的速度。
 */
const SPEED_SMOOTHING = 0.35

/**
 * 小于这个间隔不重算瞬时速度。
 *
 * 上游在极端情况下会连发两条进度（间隔几十毫秒），那时 `Δ字节/Δ时间` 会被分母
 * 放大成一个荒谬的数字（几十 MB/s），而它只活一帧就消失 —— 不值得让用户看到。
 */
const MIN_SPEED_SAMPLE_MS = 200

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 从「上一个字节数 + 现在这个」算出平滑速度。
 *
 * 三个输入都可能是 `null`，各自的含义不同：
 * - 没有上一笔：用上游自报的速度起个头；它也没有就返回 `null`（不编造）。
 * - 字节数没涨（`Δ = 0`）：瞬时速度是 0，但**不直接归零**，让 EMA 衰减几拍 ——
 *   否则一次卡顿就会把速度打到 0 再弹回来，比不显示更难看。
 * - 时间没前进：保留上一拍的速度，这次样本作废。
 */
function nextSpeed(
  previous: UpdateTransfer | null,
  transferred: number,
  at: number | null,
  upstream: number | null,
): number | null {
  const previousSpeed = previous === null ? null : previous.bytesPerSecond
  if (previous === null) return upstream
  if (at === null || previous.updatedAt === null) return previousSpeed ?? upstream

  const elapsedMs = at - previous.updatedAt
  if (elapsedMs < MIN_SPEED_SAMPLE_MS) return previousSpeed ?? upstream

  const deltaBytes = transferred - previous.transferred
  if (deltaBytes < 0) return upstream
  const instant = deltaBytes / (elapsedMs / 1000)
  if (previousSpeed === null) return instant
  return previousSpeed * (1 - SPEED_SMOOTHING) + instant * SPEED_SMOOTHING
}

/** 把一条进度事件收成 `UpdateTransfer`。没有字节数就返回 `null`（只有百分比可用）。 */
function buildTransfer(
  previous: UpdateTransfer | null,
  event: Extract<UpdateEvent, { type: 'progress' }>,
): UpdateTransfer | null {
  const transferred = finiteOrNull(event.transferred)
  if (transferred === null) return previous

  const at = finiteOrNull(event.at)
  const total = finiteOrNull(event.total)
  const upstreamSpeed = finiteOrNull(event.bytesPerSecond)
  return {
    transferred,
    // 总大小在一次下载里是常量：上游某次没给就沿用上一次，不要把它冲成 null，
    // 否则「剩余时间」会在一帧里消失又出现。
    total: total ?? previous?.total ?? null,
    bytesPerSecond: nextSpeed(previous, transferred, at, upstreamSpeed),
    startedAt: previous?.startedAt ?? at,
    updatedAt: at ?? previous?.updatedAt ?? null,
  }
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
      return { phase: 'checking', version: null, percent: null, transfer: null, detail: '' }

    case 'available':
      // 新一轮下载即将开始，上一轮的字节数必须清掉 —— 否则界面会先显示上一版的
      // 100%，再跳回 0%。
      return {
        phase: 'available',
        version: event.version,
        percent: null,
        transfer: null,
        detail: '',
      }

    case 'not-available':
      // 不变量 3 的推论：没查到新版时不保留上一次的 version，否则界面可能拿着一个
      // 过期的版本号去显示「有新版」。
      return { phase: 'up-to-date', version: null, percent: null, transfer: null, detail: '' }

    case 'progress':
      // 不变量 3：推进到 downloading，但**不编造 version** ——
      // 只收到进度时我们并不知道在下载哪一版，保留当前已知的（可能是 null）。
      return {
        phase: 'downloading',
        version: current.version,
        percent: normalizePercent(event.percent),
        transfer: buildTransfer(current.transfer, event),
        detail: '',
      }

    case 'downloaded': {
      // 收尾时把「已下载」对齐到总大小：上游最后一次进度常常停在 99.7%，
      // 完成态却显示 99% 会让人以为还差一点。
      const previous = current.transfer
      const total = previous?.total ?? null
      return {
        phase: 'downloaded',
        version: event.version,
        percent: 1,
        transfer:
          previous === null
            ? null
            : {
                ...previous,
                transferred: total ?? previous.transferred,
                bytesPerSecond: null,
                updatedAt: finiteOrNull(event.at) ?? previous.updatedAt,
              },
        detail: '',
      }
    }

    case 'unsupported':
      return {
        phase: 'unsupported',
        version: null,
        percent: null,
        transfer: null,
        detail: event.detail,
      }

    case 'error':
      // 不变量 2：保留 version、percent 与字节数（「下到 42 MB 时失败」是可诊断的）。
      return {
        phase: 'error',
        version: current.version,
        percent: current.percent,
        transfer: current.transfer,
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
  // 字节数与速度只在有值时写出来，理由同上：占位值会让人以为那是一个真实读数。
  const transfer = status.transfer ?? null
  if (transfer !== null) {
    parts.push(
      transfer.total === null
        ? `已下载=${formatMegabytes(transfer.transferred)}MB`
        : `已下载=${formatMegabytes(transfer.transferred)}/${formatMegabytes(transfer.total)}MB`,
    )
    if (transfer.bytesPerSecond !== null) {
      parts.push(`速度=${formatMegabytes(transfer.bytesPerSecond)}MB/s`)
    }
  }
  if (status.detail !== '') parts.push(`说明=${status.detail}`)
  return parts.join(' ')
}

/** 字节 → 兆字节，保留一位小数。日志里不追求精度，只要求能一眼看出量级。 */
function formatMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1)
}
