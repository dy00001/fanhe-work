/**
 * 桌面更新通道的状态 → 界面该显示什么（T7-02b）。
 *
 * ## 与 `version-check.ts` 的分工
 *
 * 那一条问的是「**服务端**的版本比我这份前端新吗」，靠 `GET /api/version`，两侧都是
 * 我们自己部署的东西。这一条问的是「**本机装的应用**有没有可装的新版」，靠
 * `electron-updater` 去 GitHub Releases 查，答案是「有没有一个已经下载好的安装包」。
 *
 * 两者都可能为真，而**只有后者能真的把新版装上**。所以桌面态里更新这件事以本模块
 * 为准：`version-check.ts` 那一行是提示，这里这一条是**动作**。
 *
 * ## 为什么把判定抽成纯函数
 *
 * 与 `version-check.ts` 同一个理由，再加一条：真正会出错的是「一串事件过来之后，
 * 界面上那个按钮该不该能按、按了会发生什么」，而那件事与 React 无关。抽出来之后
 * `test/desktop-update.test.mjs` 能直接把一串状态喂进来断言视图，不必真的发一版、
 * 装一台机器、等一次下载。
 *
 * ## 本模块不 import 任何相对路径模块
 *
 * 理由与 `version-check.ts` 文件头那节完全一样：本项目的**前端模块之间一律用无扩展名
 * 的相对引用**，而 Node 的 ESM 解析要求写全扩展名 —— 一旦在模块顶层 import 任何一个，
 * `test/*.test.mjs` 就会在**加载阶段**报 `ERR_MODULE_NOT_FOUND`，连这里的纯函数用例
 * 都跑不了。所以宿主与版本标签这两个小东西在这里内联一份，由测试钉住它们与
 * `host.ts` / `version.ts` 的一致（见测试里喂 `detectHost(...)` 的返回值那几条）。
 */

/**
 * 更新通道的阶段。
 *
 * **取值必须与 `apps/desktop/src/update.ts` 的 `UpdatePhase` 一字不差。** 两侧是
 * 两个包，web 不依赖 desktop（壳反过来依赖 web 的构建产物），没有可以共享的类型
 * 来源；所以这里只能抄一份，而抄错了不会报错 —— 只会让某个阶段落进「不认识」的
 * 分支、界面上少一条提示。`test/desktop-update.test.mjs` 里逐个阶段断言了视图，
 * 任何一侧新增阶段都会让那条用例红。
 */
export type DesktopUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'unsupported'
  | 'error'

/**
 * 已知阶段的**运行期**清单。
 *
 * 与上面的类型是同一份事实的两种写法，而两者都必须存在：类型在运行期会被擦掉，
 * 而校验一个从 IPC 拿回来的字符串需要的是一个**值**。
 *
 * 导出它是为了 `test/desktop-update.test.mjs` 能拿它去比对
 * `apps/desktop/src/update.ts` 里那个 `UpdatePhase` 联合 —— 两侧漂移的症状是
 * 「某个阶段落进不认识的分支、界面上少一条提示」，**不报错**，所以必须钉住。
 */
export const DESKTOP_UPDATE_PHASES: readonly DesktopUpdatePhase[] = [
  'idle',
  'checking',
  'available',
  'downloading',
  'downloaded',
  'up-to-date',
  'unsupported',
  'error',
]

/** 主进程那一侧的状态。字段含义见 `apps/desktop/src/update.ts` 的 `UpdateStatus`。 */
export type DesktopUpdateStatus = {
  phase: DesktopUpdatePhase
  version: string | null
  percent: number | null
  /** 字节级事实。没有在下载时为 `null`。 */
  transfer: DesktopUpdateTransfer | null
  detail: string
}

/** 与 `apps/desktop/src/update.ts` 的 `UpdateTransfer` 一一对应（同样是抄一份）。 */
export type DesktopUpdateTransfer = {
  transferred: number
  total: number | null
  bytesPerSecond: number | null
  startedAt: number | null
  updatedAt: number | null
}

/**
 * 把 IPC 拿到的未知值校验成状态，形状不对返回 `null`。
 *
 * 逐个字段查而不是直接断言：桥的那一头是另一个进程，返回 `undefined` 也是可能的
 * （通道没注册、主进程还没跑到注册那一步）。拿 `undefined.phase` 去比较会抛
 * `TypeError`，而那条链路的正确反应只是「不显示更新提示」。
 *
 * `percent` 只在 `0 <= x <= 1` 时保留，其余归 `null`：进度条拿一个 `NaN` 或 `7`
 * 去算宽度会得到一个看起来正常、实际毫无意义的宽度 —— 那比不显示进度更难发现。
 */
export function parseDesktopUpdateStatus(payload: unknown): DesktopUpdateStatus | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null

  const candidate = payload as Partial<DesktopUpdateStatus>
  const { phase, version, percent, detail, transfer } = candidate

  if (typeof phase !== 'string' || !DESKTOP_UPDATE_PHASES.includes(phase as DesktopUpdatePhase)) {
    return null
  }

  const safeVersion = typeof version === 'string' && version !== '' ? version : null
  const safePercent =
    typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 1
      ? percent
      : null

  return {
    phase: phase as DesktopUpdatePhase,
    version: safeVersion,
    percent: safePercent,
    transfer: parseTransfer(transfer),
    detail: typeof detail === 'string' ? detail : '',
  }
}

/**
 * 字节级事实的校验。
 *
 * 任何一个必需字段不合法就整体归 `null`，而不是「能读几个算几个」：半份数据会让
 * 界面显示「0 B / — · 速度 —」，看起来像下载卡住了，而真实原因只是字段没传对。
 * `transferred` 是唯一必需项 —— 没有它，其余几项都算不出来。
 */
function parseTransfer(raw: unknown): DesktopUpdateTransfer | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const candidate = raw as Partial<DesktopUpdateTransfer>
  const transferred = nonNegative(candidate.transferred)
  if (transferred === null) return null
  return {
    transferred,
    total: nonNegative(candidate.total),
    // 速度允许为 0（真的停了），但不允许负数或非有限值。
    bytesPerSecond: nonNegative(candidate.bytesPerSecond),
    startedAt: nonNegative(candidate.startedAt),
    updatedAt: nonNegative(candidate.updatedAt),
  }
}

function nonNegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/**
 * 宿主。内联而不是从 `lib/host.ts` import，理由见文件头。
 *
 * 取值与 `HostKind` / `UpdateNoticeHost` 必须一致；测试里喂 `detectHost(...)` 的
 * 返回值进来，所以三者一旦分叉就会红。
 */
export type UpdateHost = 'browser' | 'desktop'

/** 版本标签：`v0.1.2`。内联理由同上（`lib/version.ts` 的同名函数是另一份）。 */
function formatVersionLabel(version: string): string {
  return `v${version}`
}

/**
 * 两个状态是不是同一个（四个字段逐个比）。
 *
 * 用途只有一个，但它承重：轮询每 30 秒拿到一个**内容相同的新对象**时，若直接
 * `setStatus`，React 会因为引用变了而重渲染，而重渲染又会重建那个轮询定时器 ——
 * 于是「每 30 秒查一次」变成「每 30 秒重置一次计时」，永远不会真的推进。
 * 比出相等就保留旧引用，这条链就断了。
 */
export function isSameUpdateStatus(
  a: DesktopUpdateStatus | null,
  b: DesktopUpdateStatus | null,
): boolean {
  if (a === null || b === null) return a === b
  return (
    a.phase === b.phase &&
    a.version === b.version &&
    a.percent === b.percent &&
    a.detail === b.detail &&
    isSameTransfer(a.transfer ?? null, b.transfer ?? null)
  )
}

function isSameTransfer(a: DesktopUpdateTransfer | null, b: DesktopUpdateTransfer | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.transferred === b.transferred &&
    a.total === b.total &&
    a.bytesPerSecond === b.bytesPerSecond &&
    a.startedAt === b.startedAt &&
    a.updatedAt === b.updatedAt
  )
}

/**
 * 界面视图。`hidden` 表示「这一块不渲染」。
 *
 * 分成四态而不是「有 / 没有」两态，因为**这四件事该让用户做的事完全不同**：
 * 下载中什么也不用做（等），已就绪要点一下，失败可以重试，检查中什么都不该按。
 * 合成一态就只能靠文案区分，而文案是会被改的。
 */
export type DesktopUpdateView =
  /** 不渲染。 */
  | { kind: 'hidden' }
  /** 正在检查。只在用户主动触发时显示（见 `use-desktop-update.ts`）。 */
  | { kind: 'checking'; text: string }
  /** 正在下载。**不可点** —— 这时候没有能做的动作。 */
  | {
      kind: 'downloading'
      version: string | null
      percent: number | null
      /** 已下载字节数；拿不到字节级事实时为 `null`。 */
      transferred: number | null
      /** 总字节数。 */
      total: number | null
      /** 平滑速度（字节/秒）。 */
      speed: number | null
      /** 已用时间（毫秒）。 */
      elapsedMs: number | null
      /** 预计剩余时间（毫秒）；速度未知或总大小未知时为 `null`。 */
      etaMs: number | null
      /** 进度停住超过阈值：网断了、被限速、或对端不发了。 */
      stalled: boolean
      /** 顶栏那一行（窄）：`正在下载 v0.1.5 · 38%`。 */
      text: string
      /** 面板第一行：`42.3 MB / 112.4 MB`。 */
      sizeText: string
      /** 面板第二行：`2.4 MB/s · 已用 00:18 · 剩余 00:29`。 */
      metaText: string
      title: string
    }
  /** 已下载完，点一下就装并重启。 */
  | {
      kind: 'ready'
      version: string
      text: string
      actionLabel: string
      title: string
      /** 安装包大小，用于在面板里给出「下完了」的实证。 */
      sizeText: string | null
    }
  /** 检查或下载失败，可以重试。 */
  | {
      kind: 'failed'
      text: string
      actionLabel: string
      title: string
      detail: string
      /** 失败时已经下到的量；检查阶段失败时为 `null`。 */
      progressText: string | null
    }

/**
 * 状态 → 视图。**只有桌面宿主才可能不是 `hidden`。**
 *
 * 浏览器里没有更新通道（页面来自服务端，刷新即最新），把它显示出来只会让人去找一个
 * 不存在的按钮。这条判据放在纯函数里而不是组件里：组件里的一句 `if` 无法被断言，
 * 而「浏览器里不该出现更新按钮」正是一条值得钉住的规则。
 *
 * `null`（拿不到状态）与 `unsupported`（开发态 / 冒烟态）都归 `hidden`：前者是
 * 「问不到」，后者是「这条通道在本形态下不存在」，对用户而言都是「没有更新这回事」。
 */
export function buildDesktopUpdateView(
  status: DesktopUpdateStatus | null,
  host: UpdateHost,
  /** 判定「停住」用的当前时间。默认取真实时钟；测试传固定值。 */
  now: number = Date.now(),
): DesktopUpdateView {
  if (host !== 'desktop' || status === null) return { kind: 'hidden' }

  switch (status.phase) {
    case 'available':
    case 'downloading': {
      const transfer = status.transfer ?? null
      const transferred = transfer === null ? null : transfer.transferred
      const total = transfer === null ? null : transfer.total
      const speed = transfer === null ? null : transfer.bytesPerSecond
      const elapsedMs =
        transfer === null || transfer.startedAt === null
          ? null
          : Math.max(0, now - transfer.startedAt)
      const etaMs = computeEtaMs(transferred, total, speed)
      // 总大小已知且已经下满时不算「停住」：那一刻上游可能只是还没发 downloaded 事件。
      const incomplete = total === null || transferred === null || transferred < total
      const stalled = incomplete && isStalled(transfer, now)
      return {
        kind: 'downloading',
        version: status.version,
        percent: status.percent,
        transferred,
        total,
        speed,
        elapsedMs,
        etaMs,
        stalled,
        text: describeDownload(status),
        sizeText: describeSize(transferred, total),
        metaText: describeMeta(speed, elapsedMs, etaMs, stalled),
        title:
          status.version === null
            ? '新版安装包正在下载，完成后会提示重启更新'
            : `${formatVersionLabel(status.version)} 的安装包正在下载，完成后会提示重启更新`,
      }
    }

    case 'downloaded': {
      // `version` 为 `null` 时不该走到这里（主进程的 `isReadyToInstall` 也这么要求），
      // 但它是外部输入，兜一下：没有版本号就退回检查中，而不是渲染一个「更新到 null」。
      if (status.version === null) return { kind: 'checking', text: '正在准备更新…' }
      const total = status.transfer?.total ?? null
      return {
        kind: 'ready',
        version: status.version,
        text: `新版本 ${formatVersionLabel(status.version)} 已就绪`,
        // 按钮上带版本号：顶栏位置很窄，只写「重启更新」的话用户无从确认装的是哪一版，
        // 而「我刚看到有 0.1.3，怎么装完还是 0.1.2」是一个很自然的疑问。
        actionLabel: `重启更新到 ${formatVersionLabel(status.version)}`,
        title: `${formatVersionLabel(status.version)} 的安装包已下载完成。点一下会退出应用、装上新版并自动重新打开 —— 本地设置与数据都保留。`,
        sizeText: total === null ? null : formatBytes(total),
      }
    }

    case 'error': {
      const transfer = status.transfer ?? null
      const progressText =
        transfer === null ? null : describeSize(transfer.transferred, transfer.total)
      return {
        kind: 'failed',
        // 有字节数说明是「下载到一半断了」，没有则是「连检查都没成」—— 两者的下一步
        // 不一样（前者可以续传，后者要先能连上），文案必须分开。
        text: transfer === null ? '更新检查失败' : '下载中断',
        actionLabel: '重试',
        title: `没能完成更新。${status.detail === '' ? '' : `原因：${status.detail}`}点一下重新检查。`,
        detail: status.detail,
        progressText,
      }
    }

    case 'checking':
      return { kind: 'checking', text: '正在检查更新…' }

    // `idle` 是「还没查过」、`up-to-date` 是「查过且没有新版」，两者在界面上是同一件事。
    case 'idle':
    case 'up-to-date':
    case 'unsupported':
      return { kind: 'hidden' }
  }
}

/**
 * 进度多久没动就算「停住」。
 *
 * 主进程的进度事件大约一秒一条，所以 3 秒意味着**至少漏了两拍**。取 3 而不是 1：
 * 网络抖一下是常态，每抖一次就把界面切成「已暂停」会让人以为下载坏了。
 */
export const UPDATE_STALL_MS = 3000

function isStalled(transfer: DesktopUpdateTransfer | null, now: number): boolean {
  if (transfer === null || transfer.updatedAt === null) return false
  return now - transfer.updatedAt >= UPDATE_STALL_MS
}

/** 下载中那一行（窄）：有版本号就写出来，有进度就带上百分比。 */
function describeDownload(status: DesktopUpdateStatus): string {
  const label = status.version === null ? '新版本' : formatVersionLabel(status.version)
  if (status.percent === null) return `正在下载 ${label}…`
  return `正在下载 ${label} · ${Math.round(status.percent * 100)}%`
}

/** `42.3 MB / 112.4 MB`；总大小未知时退成 `已下载 42.3 MB`。 */
function describeSize(transferred: number | null, total: number | null): string {
  if (transferred === null) return '正在获取大小…'
  if (total === null) return `已下载 ${formatBytes(transferred)}`
  return `${formatBytes(transferred)} / ${formatBytes(total)}`
}

/** `2.4 MB/s · 已用 00:18 · 剩余 00:29`；停住时换成明确的状态词。 */
function describeMeta(
  speed: number | null,
  elapsedMs: number | null,
  etaMs: number | null,
  stalled: boolean,
): string {
  const elapsed = `已用 ${formatDuration(elapsedMs)}`
  if (stalled) return `已暂停 · ${elapsed} · 等待网络恢复`
  const speedText = speed === null ? '速度 —' : `${formatBytes(speed)}/s`
  const etaText = etaMs === null ? '剩余 —' : `剩余 ${formatDuration(etaMs)}`
  return `${speedText} · ${elapsed} · ${etaText}`
}

/**
 * 字节 → 人能读的字符串。
 *
 * 阈值取 1024 而不是 1000：这是文件大小，与资源管理器、`latest.yml` 里的 `size`
 * 用同一套进制，否则界面写 112 MB、属性面板写 107 MB，用户会以为下错了包。
 */
export function formatBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  // 一位小数，但去掉末尾的 `.0`：`2.0 MB/s` 比 `2 MB/s` 多读一个字符、不增加信息。
  const oneDecimal = (value: number): string => value.toFixed(1).replace(/\.0$/, '')
  const kb = bytes / 1024
  if (kb < 1024) return `${kb < 10 ? oneDecimal(kb) : Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? oneDecimal(mb) : Math.round(mb)} MB`
  return `${oneDecimal(mb / 1024)} GB`
}

/**
 * 毫秒 → `00:18` / `1:02:03`。
 *
 * 60 秒以内直接写「18 秒」：`00:18` 在这个量级上反而要多读一眼。
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${totalSeconds} 秒`
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}

/**
 * 预计剩余时间。
 *
 * 速度 ≤ 0 或总大小未知时返回 `null`（界面显示「剩余 —」）。**不要用 0 兜底** ——
 * 那会显示成「剩余 0 秒」，是一个比「不知道」糟糕得多的谎。
 *
 * 超过 24 小时的估算一律归 `null`：那不是估算不准，而是这个量级的读数对用户没有
 * 任何决策价值，写出来只会让人以为下载坏了。
 */
export function computeEtaMs(
  transferred: number | null,
  total: number | null,
  speed: number | null,
): number | null {
  if (transferred === null || total === null || speed === null) return null
  if (!Number.isFinite(speed) || speed <= 0) return null
  const remaining = total - transferred
  if (remaining <= 0) return 0
  const etaMs = (remaining / speed) * 1000
  if (!Number.isFinite(etaMs) || etaMs > 24 * 60 * 60 * 1000) return null
  return etaMs
}

/**
 * 轮询间隔（毫秒）。`0` 表示**停止轮询**。
 *
 * 自适应而不是固定一个值，因为两种情形的代价差了两个数量级：
 *
 * - 下载中要让人看到进度在走，1 秒一次；这是几十毫秒级的本机 IPC，可以忽略。
 * - 空闲时 30 秒一次就够 —— 而**不能完全停**：应用会被开一整天，服务端中途发了新版，
 *   界面得自己发现。`unsupported` 则是真的没有可等的（开发态、冒烟态），停掉。
 *
 * 失败后退到 15 秒：失败最常见的原因是网络断了，此时 1 秒一次的轮询换不来任何新
 * 信息，只会把日志刷满。
 */
export function updatePollIntervalMs(status: DesktopUpdateStatus | null): number {
  if (status === null) return UPDATE_POLL_IDLE_MS

  switch (status.phase) {
    case 'available':
    case 'downloading':
    case 'checking':
      return UPDATE_POLL_ACTIVE_MS
    case 'error':
      return UPDATE_POLL_ERROR_MS
    case 'unsupported':
      return 0
    default:
      return UPDATE_POLL_IDLE_MS
  }
}

/** 下载中 / 检查中的轮询间隔。 */
export const UPDATE_POLL_ACTIVE_MS = 1000
/** 出错后的轮询间隔。 */
export const UPDATE_POLL_ERROR_MS = 15_000
/** 空闲时的轮询间隔。 */
export const UPDATE_POLL_IDLE_MS = 30_000

/**
 * 空闲多久主动重查一次更新。
 *
 * 主进程在**启动时**查一次，之后不再自己查 —— 这是刻意的：定时去访问 GitHub 是
 * 一件应当在界面这一层被看见的事，放在主进程里会变成一条谁都注意不到的定时器。
 * 半小时一次对一个会被开一整天的桌面工具来说足够及时，而 GitHub 的匿名 API 限额
 * 是每小时 60 次，两小时四次远远够不着。
 */
export const UPDATE_RECHECK_MS = 30 * 60 * 1000
