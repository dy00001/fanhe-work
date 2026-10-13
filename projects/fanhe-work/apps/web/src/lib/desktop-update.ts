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
  detail: string
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
  const { phase, version, percent, detail } = candidate

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
    detail: typeof detail === 'string' ? detail : '',
  }
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
    a.detail === b.detail
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
      text: string
      title: string
    }
  /** 已下载完，点一下就装并重启。 */
  | { kind: 'ready'; version: string; text: string; actionLabel: string; title: string }
  /** 检查或下载失败，可以重试。 */
  | { kind: 'failed'; text: string; actionLabel: string; title: string; detail: string }

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
): DesktopUpdateView {
  if (host !== 'desktop' || status === null) return { kind: 'hidden' }

  switch (status.phase) {
    case 'available':
    case 'downloading':
      return {
        kind: 'downloading',
        version: status.version,
        percent: status.percent,
        text: describeDownload(status),
        title:
          status.version === null
            ? '新版安装包正在下载，完成后会提示重启更新'
            : `${formatVersionLabel(status.version)} 的安装包正在下载，完成后会提示重启更新`,
      }

    case 'downloaded':
      // `version` 为 `null` 时不该走到这里（主进程的 `isReadyToInstall` 也这么要求），
      // 但它是外部输入，兜一下：没有版本号就退回检查中，而不是渲染一个「更新到 null」。
      if (status.version === null) return { kind: 'checking', text: '正在准备更新…' }
      return {
        kind: 'ready',
        version: status.version,
        text: `新版本 ${formatVersionLabel(status.version)} 已就绪`,
        // 按钮上带版本号：顶栏位置很窄，只写「重启更新」的话用户无从确认装的是哪一版，
        // 而「我刚看到有 0.1.3，怎么装完还是 0.1.2」是一个很自然的疑问。
        actionLabel: `重启更新到 ${formatVersionLabel(status.version)}`,
        title: `${formatVersionLabel(status.version)} 的安装包已下载完成。点一下会退出应用、装上新版并自动重新打开 —— 本地设置与数据都保留。`,
      }

    case 'error':
      return {
        kind: 'failed',
        text: '更新检查失败',
        actionLabel: '重试',
        title: `没能连上更新源。${status.detail === '' ? '' : `原因：${status.detail}`}点一下重新检查。`,
        detail: status.detail,
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

/** 下载中那一行：有版本号就写出来，有进度就带上百分比。 */
function describeDownload(status: DesktopUpdateStatus): string {
  const label = status.version === null ? '新版本' : formatVersionLabel(status.version)
  if (status.percent === null) return `正在下载 ${label}…`
  return `正在下载 ${label} · ${Math.round(status.percent * 100)}%`
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
