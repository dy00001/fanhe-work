/**
 * 唤起客户端之后的窗口侧后置动作。
 *
 * 三样东西：**等登录窗出现、按软件决定要不要点登录、以及把多开的登录窗排开**。
 * 后置动作全部 best-effort —— 失败只进日志，绝不改启动结果。
 *
 * ## 它不进 `agent.ts` 的零依赖内核
 *
 * `agent.ts` 那份 spawn 核心被 192 项集成测试钉着，必须能原样打包随投、一处不动。
 * 而这里做的事是**外壳侧**的体验增强：依赖平台（Windows 的 `user32`）、依赖外部
 * 客户端的窗口，且本质上 best-effort。把它单独放一个文件、由 `main.ts` 在 spawn 成功后
 * 按需调用，内核那份就不会因为要照顾这些动作而引入跨平台依赖、也不会被它们的失败
 * 路径污染。
 *
 * ## 本文件为什么把「窗口原语」与「按软件决策」放在一起
 *
 * `apps/desktop` 的单测是 `node --experimental-strip-types --test "test/*.test.mjs"`。
 * 那条加载链路**只按字面解析 import 说明符**，而 CJS 产出的 TypeScript 要求相对导入
 * 写成 `./foo.js`。于是「一个 `.ts` import 另一个 `.ts` 且用 `.js` 后缀」这一生产正确
 * 的写法，会让单测在运行期找不到文件而整个文件报模块缺失。已验证：`main.ts` 用了整整
 * 十章 `.js` 后缀相对导入，而它恰恰是不被单测加载的那个文件；所有**被测**的 src 模块
 * （`launch-icon.ts`、`launch-registry.ts`、`brand-icon.ts`）都是零相对导入、自包含。
 *
 * 因此本文件遵循同一条约定：**窗口原语与按软件的决策合并在一个自包含模块里**，
 * 两者由空行与明确的注释分段，而不是按目录结构拆开。拆开的代价不只是多一个文件，
 * 而是「拆开后立刻无法被单测覆盖」。
 *
 * ## 与 `@fanhe/shared` / `agent.ts` 的分工
 *
 * 共享包只放传输形态与取值规则，不放行为（见 `packages/shared/src/launch.ts` 文件头）。
 * 「哪些软件该自动点登录」是行为，因此留在这里；进程创建的形态复核与 spawn 在
 * `agent.ts`，本文件只消费它给出的 pid。
 *
 * ## 一条 PowerShell 通道的统一约束
 *
 * 四项操作（等窗口、敲 Enter、取窗口句柄、平铺）各自拼一段脚本、各自 `execFile`，共用
 * 同一份 P/Invoke 源码。**必须兼容 Windows PowerShell 5.1**（真机踩坑）：不用
 * `0u` / `0ul` 无符号字面量后缀、不用 `??`、不用三元 `?:`、不用 `-Parallel`。无符号
 * 初值一律写成 `[uint32]$x = 0`。拼脚本时有单测钉着这几条，改之前先看测试文件。
 */

import { execFile, spawn } from 'node:child_process'
import { platform } from 'node:os'

import { supportsAccountLogin } from '@fanhe/shared'

/* ------------------------------------------------------------------ *
 * 一、共享的 user32 P/Invoke 声明
 * ------------------------------------------------------------------ */

/**
 * 共享的 user32 P/Invoke 声明。
 *
 * **抽成常量而不是各脚本各写一份**：四项操作的 `Add-Type` 内容本来就该一致，分成四份
 * 之后「改了 EnumWindows 的回调签名却忘了改平铺那段」会成为一类只在真机上暴露的错误。
 *
 * ## 前后两个换行不能 trim
 *
 * PowerShell 的 here-string 要求 `@"` 之后紧跟换行、`"@` 独占一行。把这段内容
 * `.trim()` 掉首尾换行，插进 `Add-Type @"${WIN32_PINVOKE_SOURCE}"@` 之后，
 * `@"` 直接顶上 `using System;`，解析立即失败 —— 而失败发生在真机的 PowerShell 里，
 * 本机单测看不到。因此这里显式**不 trim**，并让每个使用它的脚本都以换行开头。
 */
const WIN32_PINVOKE_SOURCE = `
using System;
using System.Runtime.InteropServices;
public class Win32LoginClick {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, ref RECT pvParam, uint fWinIni);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
`

/**
 * `SPI_GETWORKAREA`。返回的是「除任务栏与停靠窗口之外的可用桌面区域」。
 *
 * 写成十六进制**字符串**而不是数字：数字插进脚本会变成十进制 `48`，读脚本的人对不上
 * Windows SDK 文档里的 `0x0030`。PowerShell 5.1 认十六进制字面量，因此没有兼容代价。
 */
const SPI_GETWORKAREA = '0x0030'

/**
 * `SWP_NOZORDER | SWP_NOACTIVATE`：只改位置与大小，不动 z 序、不抢焦点。
 *
 * 同上，以字面量进脚本：`0x0014` 比十进制 `20` 更能看出是哪两个标志位的组合。
 */
const SWP_MOVE_RESIZE_ONLY = '0x0014'

/* ------------------------------------------------------------------ *
 * 二、平铺布局（纯函数）
 * ------------------------------------------------------------------ */

/**
 * 一个矩形区域（屏幕坐标）。
 *
 * 与 CSS 意义上的 rect 不同：这里是**物理像素**，而多屏 + DPI 缩放下「物理像素」与
 * 「逻辑像素」的换算不在我们的控制之内。平铺只求「窗口不叠在一起」，不追求精确铺满，
 * 因此直接用工作区原值即可。
 */
export type TileRect = { x: number; y: number; width: number; height: number }

/** 可用桌面区域。`x` / `y` 在副屏挂在主屏左侧或上方时不为 0。 */
export type WorkArea = TileRect

/** 平铺时窗口之间的间隙。8 像素：既看得出是两个窗口，又不至于让 3×3 时每格太窄。 */
export const TILE_GAP_PX = 8

/** 平铺单元格的最小宽高。低于这个值时窗口会小到没法操作，宁可让它略微重叠。 */
export const TILE_MIN_SIZE_PX = 120

/** 平铺时最多排几列。再多则每格过窄，二维码会小到扫不出来。 */
export const TILE_MAX_COLUMNS = 6

/**
 * 计算 N 个窗口的网格平铺位置（纯函数）。
 *
 * ## 列数取「够用的最小平方」
 *
 * N=2 要 2 列 1 行（不是 1 列 2 行，两个登录窗左右并排更符合直觉）；N=5 取 3 列 2 行，
 * 留一格空的。`ceil(sqrt(N))` 正好给出这个结果，只有一处取舍要说明：N=7、8 时它给
 * 3 列 3 行，于是 9 格里空 1~2 格，而取 4 列会让每格窄一圈。二维码的识别面积比
 * 「格子是否填满」重要得多，因此保留 3 列，空几格无所谓。
 *
 * ## 为什么空输入也合法
 *
 * 调用方不知道会拿到几个窗口（有的可能根本没起来），让这个函数自己应对空输入，
 * 比让每处调用点各写一次 `if (count === 0)` 更不容易漏。
 *
 * ## 为什么用 floor 而不是均分
 *
 * 窗口尺寸必须是整数（`SetWindowPos` 的 `cx` / `cy` 是 int）。均分再 floor 会留下
 * 右侧/底部一条越来越大的残带，窗口越多越明显。按 `floor((可用 - 间隙) / 格数)` 算
 * 每格、残带留在最后，多屏上的观感比逐格多给一像素稳定。
 */
export function computeTileLayout(count: number, workArea: WorkArea): TileRect[] {
  if (!Number.isFinite(count) || count <= 0) return []
  if (!Number.isFinite(workArea.width) || !Number.isFinite(workArea.height)) return []
  if (workArea.width <= 0 || workArea.height <= 0) return []

  const columns = Math.min(TILE_MAX_COLUMNS, Math.ceil(Math.sqrt(count)))
  const rows = Math.ceil(count / columns)

  const availableWidth = workArea.width - TILE_GAP_PX * (columns - 1)
  const availableHeight = workArea.height - TILE_GAP_PX * (rows - 1)
  const cellWidth = Math.max(TILE_MIN_SIZE_PX, Math.floor(availableWidth / columns))
  const cellHeight = Math.max(TILE_MIN_SIZE_PX, Math.floor(availableHeight / rows))

  const layout: TileRect[] = []
  for (let index = 0; index < count; index += 1) {
    const column = index % columns
    const row = Math.floor(index / columns)
    layout.push({
      x: workArea.x + column * (cellWidth + TILE_GAP_PX),
      y: workArea.y + row * (cellHeight + TILE_GAP_PX),
      width: cellWidth,
      height: cellHeight,
    })
  }
  return layout
}

/* ------------------------------------------------------------------ *
 * 三、脚本构造（纯函数）
 * ------------------------------------------------------------------ */

/** 等窗口的最长等待。客户端冷启动到登录窗立住，真机上要几秒到十几秒。 */
export const DEFAULT_WINDOW_WAIT_MS = 15000

/** 轮询间隔。200ms：足够快不至于明显迟滞，也不至于把 CPU 全花在枚举窗口上。 */
const DEFAULT_WINDOW_POLL_MS = 200

/** 窗口出现后的稳定期。500ms：覆盖「启动窗闪一下就换成登录窗」这类过渡。 */
const DEFAULT_WINDOW_STABILITY_MS = 500

export type WindowWaitOptions = {
  /** 见 `DEFAULT_WINDOW_WAIT_MS`。 */
  timeoutMs?: number
  /** 见 `DEFAULT_WINDOW_POLL_MS`。 */
  pollMs?: number
  /** 见 `DEFAULT_WINDOW_STABILITY_MS`。 */
  stabilityMs?: number
}

/**
 * 拼「等某 pid 的顶层可见窗口出现并稳定下来」这一段脚本。
 *
 * ## 为什么窗口「出现」之后还要等一轮
 *
 * 窗口可见不等于内部已就绪。Electron 与 CEF 系客户端（QQNT 即此类）在窗口 already
 * painted 之后才把渲染内容与输入事件绑定，此时立刻发按键会落在一个还收不到输入的
 * 界面上，表现是「点了没反应」。因此找到窗口后**再等一个稳定期并复查**：同一 pid 的
 * 可见顶层窗在 `stabilityMs` 后仍然在，才算立住。
 *
 * ## 为什么只按 pid 找、不按窗口标题
 *
 * 标题随语言、版本、登录态变化，而 pid 是 spawn 那一刻就确定的事实。按 pid 找不中时
 * 我们准确知道「它没起来」，按标题找不中时无法区分「没起来」与「标题变了」。
 *
 * 这一段由「敲 Enter」与「只取窗口」两条脚本共用：抽成一段字符串而不是各自拼一遍，
 * 否则两边的判据迟早会不一致，表现是偶发地等一个已经关掉的窗口。调用方在这一段之后
 * 自行决定「要不要发按键」。
 */
function buildWindowWaitBody(pid: number, options: WindowWaitOptions): string {
  const timeoutMs = Math.max(0, Math.floor(options.timeoutMs ?? DEFAULT_WINDOW_WAIT_MS))
  const pollMs = Math.max(1, Math.floor(options.pollMs ?? DEFAULT_WINDOW_POLL_MS))
  const stabilityMs = Math.max(0, Math.floor(options.stabilityMs ?? DEFAULT_WINDOW_STABILITY_MS))
  const pidLiteral = String(pid)

  return `
$ErrorActionPreference = 'Stop'
Add-Type @"${WIN32_PINVOKE_SOURCE}"@

$targetPid = ${pidLiteral}
$timeoutMs = ${timeoutMs}
$pollMs = ${pollMs}
$stabilityMs = ${stabilityMs}
$enterVK = 0x0D

$findWindow = {
  $script:found = [IntPtr]::Zero
  $callback = {
    param($hwnd, $lParam)
    [uint32]$seenPid = 0
    [Win32LoginClick]::GetWindowThreadProcessId($hwnd, [ref]$seenPid) | Out-Null
    if ($seenPid -eq $targetPid -and [Win32LoginClick]::IsWindowVisible($hwnd)) {
      $script:found = $hwnd
      return $false
    }
    return $true
  }
  [Win32LoginClick]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
  return $script:found
}

$startedAt = [DateTime]::UtcNow
$deadline = $startedAt.AddMilliseconds($timeoutMs)
$found = [IntPtr]::Zero
while ($true) {
  $found = & $findWindow
  if ($found -eq [IntPtr]::Zero) {
    if ([DateTime]::UtcNow -ge $deadline) {
      $waited = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
      Write-Output ('{"sent":false,"reason":"no-window","waitedMs":' + $waited + '}')
      exit 0
    }
    Start-Sleep -Milliseconds $pollMs
    continue
  }
  # 窗口刚出现可能立刻消失（部分客户端先闪一个启动窗再开登录窗），
  # 等一个稳定期复查，只认「等完之后还在」的那一个。
  Start-Sleep -Milliseconds $stabilityMs
  $stable = & $findWindow
  if ($stable -eq [IntPtr]::Zero) {
    if ([DateTime]::UtcNow -ge $deadline) {
      $waited = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
      Write-Output ('{"sent":false,"reason":"no-window","waitedMs":' + $waited + '}')
      exit 0
    }
    Start-Sleep -Milliseconds $pollMs
    continue
  }
  $found = $stable
  break
}

$waited = [int](([DateTime]::UtcNow - $startedAt).TotalMilliseconds)
`.trim()
}

/**
 * 等登录窗立住后把它带到前台并敲一个 Enter。
 *
 * 这是 §2.4 的主路径。等待与稳定期复查在 `buildWindowWaitBody` 里，这里只负责
 * 「怎么按键」：先 `AttachThreadInput` 到目标窗口的输入线程以绕开前台锁，再
 * `ShowWindow(SW_RESTORE)` 恢复最小化，再 `SetForegroundWindow`，最后敲一次
 * `VK_RETURN` 的按下与抬起。
 */
export function buildPressEnterScript(pid: number, options: WindowWaitOptions = {}): string {
  return `${buildWindowWaitBody(pid, options)}

[uint32]$threadId = 0
[Win32LoginClick]::GetWindowThreadProcessId($found, [ref]$threadId) | Out-Null
[Win32LoginClick]::AttachThreadInput($threadId, [Win32LoginClick]::GetCurrentThreadId(), $true) | Out-Null
[Win32LoginClick]::ShowWindow($found, 9) | Out-Null
[Win32LoginClick]::SetForegroundWindow($found) | Out-Null
[Win32LoginClick]::AttachThreadInput($threadId, [Win32LoginClick]::GetCurrentThreadId(), $false) | Out-Null

Start-Sleep -Milliseconds 300
[Win32LoginClick]::keybd_event($enterVK, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[Win32LoginClick]::keybd_event($enterVK, 0, 2, [UIntPtr]::Zero)

Write-Output ('{"sent":true,"hwnd":' + $found.ToInt64() + ',"waitedMs":' + $waited + '}')
`.trim()
}

/**
 * 等登录窗立住，只把窗口句柄取回来，一个键都不敲。
 *
 * 微信多开用这一条：拉起 N 个实例后要拿到 N 个登录窗的句柄才能排布它们，而此时**不
 * 该发任何按键**（微信是扫码登录，敲 Enter 要么无意义，要么把焦点从二维码上挪走）。
 * 与「敲 Enter」共用同一段等待逻辑，于是两者的「窗口算不算立住」判据完全一致。
 */
export function buildFindWindowScript(pid: number, options: WindowWaitOptions = {}): string {
  return `${buildWindowWaitBody(pid, options)}

Write-Output ('{"sent":true,"hwnd":' + $found.ToInt64() + ',"waitedMs":' + $waited + '}')
`.trim()
}

/**
 * 读取主屏工作区（不含任务栏）。
 *
 * 单独一次调用而不是顺带返回在平铺脚本里：平铺需要 JS 侧算好的坐标，而算坐标要先知道
 * 工作区。把「读工作区」与「定位窗口」分成两步，`computeTileLayout` 才是一个能被
 * 单测直接驱动的纯函数。
 */
export function buildWorkAreaScript(): string {
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"${WIN32_PINVOKE_SOURCE}"@

$rect = New-Object Win32LoginClick+RECT
[Win32LoginClick]::SystemParametersInfo(${SPI_GETWORKAREA}, 0, [ref]$rect, 0) | Out-Null
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
Write-Output ('{"left":' + $rect.Left + ',"top":' + $rect.Top + ',"width":' + $width + ',"height":' + $height + '}')
`.trim()
}

/** 一个待平铺的窗口：句柄 + 目标位置。 */
export type TileTarget = { hwnd: number } & TileRect

/**
 * 按 JS 算好的坐标平铺一组窗口（纯函数产物，便于单测）。
 *
 * 窗口按传入顺序与坐标一一对应。`uFlags` 用 `SWP_MOVE_RESIZE_ONLY`：**不动 z 序、
 * 不抢焦点**。抢焦点会让「排布」这个动作本身打断用户正在做的事，而这里只是把 N 个
 * 登录窗排开，没有任何理由需要把它们带到前台。
 *
 * 宽高为 0 或负数的条目直接跳过：那意味着 `computeTileLayout` 给出了退化的格子
 * （工作区异常小），硬传给 `SetWindowPos` 只会得到一堆 0×0 的不可见窗口。
 */
export function buildTileWindowsScript(targets: readonly TileTarget[]): string {
  if (targets.length === 0) {
    return `
$ErrorActionPreference = 'Stop'
Add-Type @"${WIN32_PINVOKE_SOURCE}"@
Write-Output '{"moved":0}'
`.trim()
  }

  const rows = targets
    .map(
      (target) =>
        `  @(${String(target.hwnd)}, ${String(target.x)}, ${String(target.y)}, ${String(target.width)}, ${String(target.height)})`,
    )
    .join(',\n')
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"${WIN32_PINVOKE_SOURCE}"@

$targets = @(
${rows}
)

$moved = 0
foreach ($target in $targets) {
  $hwnd = [IntPtr]$target[0]
  $x = [int]$target[1]
  $y = [int]$target[2]
  $cx = [int]$target[3]
  $cy = [int]$target[4]
  if ($cx -le 0 -or $cy -le 0) { continue }
  if ([Win32LoginClick]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $cx, $cy, ${SWP_MOVE_RESIZE_ONLY})) {
    $moved = $moved + 1
  }
}
Write-Output ('{"moved":' + $moved + '}')
`.trim()
}

/* ------------------------------------------------------------------ *
 * 四、脚本输出的解析（纯函数）
 * ------------------------------------------------------------------ */

/** 一次等待/发送的结果。调用方只记录，不据此改变启动结果。 */
export type WindowSendOutcome = {
  /** 是否走到了发送按键那一步（平台不支持、窗口缺失都不算）。 */
  sent: boolean
  /** 机器可读原因。`sent` 为 true 时只表示 Enter 已发出，不保证登录一定成功。 */
  reason: 'unsupported-platform' | 'no-window' | 'sent' | 'failed'
  /** 从开始到窗口立住（或判定失败）等了多久，毫秒。 */
  waitedMs?: number
  /** 可排障的附言；成功路径一般为空。 */
  detail?: string
}

/** 解析脚本回传的 JSON 行。格式非法时按 `failed` 处理，不抛。 */
export function parseWindowSendOutput(stdout: string): WindowSendOutcome {
  const text = stdout.trim()
  if (text === '') return { sent: false, reason: 'failed', detail: '脚本无输出' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { sent: false, reason: 'failed', detail: text }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { sent: false, reason: 'failed', detail: text }
  }

  const value = parsed as { sent?: unknown; reason?: unknown; waitedMs?: unknown }
  const waitedMs = typeof value.waitedMs === 'number' ? value.waitedMs : undefined
  // **失败原因优先于 `sent`。** 一段自相矛盾的负载（`sent:true` 却说 `no-window`）
  // 必须按失败处理：把它判成「已发送」正是「报成功而没做事」那一类错误，而它比明确
  // 失败难查得多（`agent.ts` 里同一条判断）。脚本自己不会产出这种负载，但解析器
  // 不能假设上游永远自洽。
  if (value.reason === 'no-window') {
    return waitedMs === undefined
      ? { sent: false, reason: 'no-window' }
      : { sent: false, reason: 'no-window', waitedMs }
  }
  if (value.sent === true) {
    // `detail` 是可选属性（`exactOptionalPropertyTypes`），空时省略而不是给 undefined。
    return waitedMs === undefined
      ? { sent: true, reason: 'sent' }
      : { sent: true, reason: 'sent', waitedMs }
  }
  return { sent: false, reason: 'failed', detail: text }
}

/** 一次「等并取窗口」的结果。 */
export type FindWindowOutcome = {
  /** 窗口句柄；没等到时为 null。 */
  hwnd: number | null
  /** 等待用了多久，毫秒。 */
  waitedMs?: number
  /** 机器可读原因。`hwnd` 非空时恒为 `found`。 */
  reason: 'unsupported-platform' | 'found' | 'no-window' | 'failed'
  /** 可排障的附言。 */
  detail?: string
}

/** 解析「等并取窗口」的输出。hwnd 不是正整数时按失败处理。 */
export function parseFindWindowOutput(stdout: string): FindWindowOutcome {
  const text = stdout.trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { hwnd: null, reason: 'failed', detail: text }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { hwnd: null, reason: 'failed', detail: text }
  }

  const value = parsed as { sent?: unknown; hwnd?: unknown; reason?: unknown; waitedMs?: unknown }
  const waitedMs = typeof value.waitedMs === 'number' ? value.waitedMs : undefined
  const withWaited = <T extends object>(outcome: T): T =>
    waitedMs === undefined ? outcome : { ...outcome, waitedMs }

  // 与 `parseWindowSendOutput` 同一条纪律：失败原因优先。hwnd 必须是非零整数，
  // 否则「拿到句柄 0」会被后面的平铺当成一个真实窗口去移动。
  if (value.reason === 'no-window') {
    return withWaited({ hwnd: null, reason: 'no-window' as const })
  }
  if (
    value.sent === true &&
    typeof value.hwnd === 'number' &&
    Number.isInteger(value.hwnd) &&
    value.hwnd > 0
  ) {
    return withWaited({ hwnd: value.hwnd, reason: 'found' as const })
  }
  return withWaited({ hwnd: null, reason: 'failed' as const, detail: text })
}

/** 解析工作区输出。任何不合法的值都归 null，绝不返回一个可疑的区域。 */
export function parseWorkAreaOutput(stdout: string): WorkArea | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null

  const value = parsed as { left?: unknown; top?: unknown; width?: unknown; height?: unknown }
  if (
    typeof value.left !== 'number' ||
    typeof value.top !== 'number' ||
    typeof value.width !== 'number' ||
    typeof value.height !== 'number'
  ) {
    return null
  }
  if (value.width <= 0 || value.height <= 0) return null
  return { x: value.left, y: value.top, width: value.width, height: value.height }
}

/** 平铺结果。`reason` 为空表示成功。 */
export type TileOutcome = { moved: number; reason?: 'unsupported-platform' | 'failed' }

/** 解析平铺输出。失败也返回 `moved: 0` 而不是抛：排不开只是不好看，不是错误。 */
export function parseTileOutput(stdout: string): TileOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim())
  } catch {
    return { moved: 0, reason: 'failed' }
  }
  if (typeof parsed !== 'object' || parsed === null) return { moved: 0, reason: 'failed' }

  const value = parsed as { moved?: unknown }
  if (typeof value.moved !== 'number' || value.moved < 0) return { moved: 0, reason: 'failed' }
  return { moved: Math.floor(value.moved) }
}

/* ------------------------------------------------------------------ *
 * 五、执行侧
 * ------------------------------------------------------------------ */

/** `execFile` 的公共选项：不弹控制台、超时后由调用方判定。 */
const POWERSHELL_BASE_OPTIONS = { windowsHide: true } as const

/**
 * 跑一段 PowerShell，把 stdout 交出去，任何异常都收敛成 failure。
 *
 * **`child.unref()` 是必须的**：等待最长可达十几秒，不 unref 的话用户在这段时间里点
 * 「退出」会被一个 best-effort 的 PowerShell 拖住。
 */
function runPowerShell(
  script: string,
  timeoutMs: number,
  onOutput: (stdout: string) => void,
  onFailure: (detail: string) => void,
): void {
  try {
    const child = execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { ...POWERSHELL_BASE_OPTIONS, timeout: timeoutMs },
      (error, stdout) => {
        if (error !== null) {
          onFailure(error.message)
          return
        }
        onOutput(stdout)
      },
    )
    child.unref()
  } catch (error) {
    onFailure(error instanceof Error ? error.message : String(error))
  }
}

/** 等待的空档上限再加 6 秒：PowerShell 启动与 `Add-Type` 编译要几百毫秒到一秒多。 */
const POWERSHELL_STARTUP_SLACK_MS = 6000

/**
 * 等 pid 的登录窗立住，把它带到前台并敲一个 Enter。
 *
 * **任何异常都吞掉、回报 `failed`**。这条与 §2.4 的既有取舍一致：登录窗点不上只是用户
 * 多动一下手，绝不能让一个 best-effort 动作上升到「启动失败」。
 */
export async function waitAndPressEnter(
  pid: number,
  options: WindowWaitOptions = {},
): Promise<WindowSendOutcome> {
  if (platform() !== 'win32') {
    return { sent: false, reason: 'unsupported-platform' }
  }

  const timeout = options.timeoutMs ?? DEFAULT_WINDOW_WAIT_MS
  const stability = options.stabilityMs ?? DEFAULT_WINDOW_STABILITY_MS

  return new Promise<WindowSendOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: WindowSendOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    runPowerShell(
      buildPressEnterScript(pid, options),
      timeout + stability + POWERSHELL_STARTUP_SLACK_MS,
      (stdout) => finish(parseWindowSendOutput(stdout)),
      (detail) => finish({ sent: false, reason: 'failed', detail }),
    )
  })
}

/**
 * 等 pid 的顶层可见窗口立住，把句柄取回来（不按键、不置前台）。
 *
 * 只用于「需要知道窗口在哪」的场合，典型是微信多开后的平铺。真正的按键走
 * `waitAndPressEnter`：那条会顺带把窗口带到前台，而平铺前的取窗口**不该**抢焦点
 * （见 `buildTileWindowsScript` 的 `uFlags` 取舍）。
 */
export async function findProcessWindow(
  pid: number,
  options: WindowWaitOptions = {},
): Promise<FindWindowOutcome> {
  if (platform() !== 'win32') {
    return { hwnd: null, reason: 'unsupported-platform' }
  }

  const timeout = options.timeoutMs ?? DEFAULT_WINDOW_WAIT_MS
  const stability = options.stabilityMs ?? DEFAULT_WINDOW_STABILITY_MS

  return new Promise<FindWindowOutcome>((resolve) => {
    let settled = false
    const finish = (outcome: FindWindowOutcome): void => {
      if (settled) return
      settled = true
      resolve(outcome)
    }
    runPowerShell(
      buildFindWindowScript(pid, options),
      timeout + stability + POWERSHELL_STARTUP_SLACK_MS,
      (stdout) => finish(parseFindWindowOutput(stdout)),
      (detail) => finish({ hwnd: null, reason: 'failed', detail }),
    )
  })
}

export type FillLoginFieldsResult =
  | { ok: true; hwnd: number }
  | {
      ok: false
      reason: 'unsupported-platform' | 'no-window' | 'window-mismatch' | 'failed'
      detail?: string
    }

/**
 * 拼「在登录窗里填账号密码」那段 PowerShell。
 *
 * 单独抽出来是为了让它可被单测钉住。这段脚本有三条不能破的性质，而它们在真机上
 * 坏了只会表现为「有时登不上去」：
 *   ① 凭据只从 **stdin** 进来，脚本正文里不含任何账号密码（否则会进命令行、进
 *      进程列表、进日志）；
 *   ② 填之前必须核对窗口宽高比，不匹配就**不输入**（登录页改版后坐标会指到别处）；
 *   ③ 只有目标窗口确实在前台才继续（否则密码会被敲进别的窗口）。
 *
 * `hwnd` 只用于拼 `[IntPtr]` 字面量，不参与任何字符串插值以外的用途。
 */
export function buildFillLoginScript(software: string, hwnd: number): string {
  const isQq = software === 'qq'
  const expectedRatio = isQq ? 320 / 460 : 760 / 540
  return `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$credential = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class Win32CredentialInput {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public UIntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION U; }
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool attachState);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void Click(IntPtr hWnd, int x, int y) {
    POINT p = new POINT { X=x, Y=y };
    if (!ClientToScreen(hWnd, ref p)) throw new Exception("ClientToScreen failed");
    SetCursorPos(p.X, p.Y); mouse_event(2, 0, 0, 0, UIntPtr.Zero); mouse_event(4, 0, 0, 0, UIntPtr.Zero);
  }
  static void Key(ushort vk, ushort scan, uint flags) {
    INPUT item = new INPUT { type=1, U=new INPUTUNION { ki=new KEYBDINPUT { wVk=vk, wScan=scan, dwFlags=flags, dwExtraInfo=UIntPtr.Zero } } };
    if (SendInput(1, new INPUT[] { item }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("SendInput failed");
  }
  public static void ClearField() { Key(0x11, 0, 0); Key(0x41, 0, 0); Key(0x41, 0, 2); Key(0x11, 0, 2); }
  public static void TypeText(string text) { foreach (char c in text) { Key(0, c, 4); Key(0, c, 6); } }
}
"@
$hwnd = [IntPtr]${String(hwnd)}
$rect = New-Object Win32CredentialInput+RECT
if (-not [Win32CredentialInput]::GetClientRect($hwnd, [ref]$rect)) { throw '无法读取登录窗口尺寸' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$ratio = $width / [double]$height
$expectedRatio = ${String(expectedRatio)}
if ($width -lt 250 -or $height -lt 350 -or [Math]::Abs($ratio - $expectedRatio) -gt 0.18) {
  Write-Output ('{"ok":false,"reason":"window-mismatch","width":' + $width + ',"height":' + $height + '}')
  exit 0
}
[uint32]$targetProcess = 0
$targetThread = [Win32CredentialInput]::GetWindowThreadProcessId($hwnd, [ref]$targetProcess)
$currentThread = [Win32CredentialInput]::GetCurrentThreadId()
[Win32CredentialInput]::AttachThreadInput($targetThread, $currentThread, $true) | Out-Null
[Win32CredentialInput]::ShowWindow($hwnd, 9) | Out-Null
[Win32CredentialInput]::SetForegroundWindow($hwnd) | Out-Null
[Win32CredentialInput]::AttachThreadInput($targetThread, $currentThread, $false) | Out-Null
if ([Win32CredentialInput]::GetForegroundWindow() -ne $hwnd) { throw '登录窗口无法置于前台，为避免把密码发往其他窗口，已停止输入' }
Start-Sleep -Milliseconds 300
function Click-Ratio([double]$x, [double]$y) {
  [Win32CredentialInput]::Click($hwnd, [int]($width * $x), [int]($height * $y))
  Start-Sleep -Milliseconds 180
}
function Fill-Ratio([double]$x, [double]$y, [string]$value) {
  Click-Ratio $x $y
  [Win32CredentialInput]::ClearField()
  [Win32CredentialInput]::TypeText($value)
  Start-Sleep -Milliseconds 160
}
if (${String(isQq ? '$true' : '$false')}) {
  # QQ 初始页需先切到账号登录。协议复选框由用户自行确认，不由程序代勾。
  Click-Ratio 0.375 0.918
  Start-Sleep -Milliseconds 700
  Fill-Ratio 0.50 0.378 ([string]$credential.account)
  Fill-Ratio 0.50 0.490 ([string]$credential.password)
  Click-Ratio 0.50 0.713
} else {
  # 千牛登录页直接显示账号、密码与登录按钮。
  Fill-Ratio 0.70 0.465 ([string]$credential.account)
  Fill-Ratio 0.70 0.565 ([string]$credential.password)
  Click-Ratio 0.70 0.750
}
Write-Output ('{"ok":true,"width":' + $width + ',"height":' + $height + ',"submitted":true}')
`.trim()
}

/**
 * 在目标进程自己的登录窗中填账号和密码。
 * 凭据通过子进程 stdin 传递，不放进 PowerShell 命令行、日志或临时文件。
 * 根据截图中确认的 QQ 与千牛登录页布局定位输入框。
 */
export async function fillLoginFieldsAfterLaunch(
  software: string,
  pid: number,
  account: string,
  password: string,
  options: WindowWaitOptions = {},
): Promise<FillLoginFieldsResult> {
  if (platform() !== 'win32') return { ok: false, reason: 'unsupported-platform' }
  const window = await findProcessWindow(pid, options)
  if (window.hwnd === null) {
    return {
      ok: false,
      reason: 'no-window',
      ...(window.detail === undefined ? {} : { detail: window.detail }),
    }
  }

  const script = buildFillLoginScript(software, window.hwnd)

  return new Promise<FillLoginFieldsResult>((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    // 计时器要等 spawn 成功才能建，而 `finish` 又要能清掉它 —— 顺序上没法用 `const`
    // 直接持有，因此用一个不可重绑定的容器持可变字段（`let` 在「只赋值一次」时会被
    // `prefer-const` 判红）。
    const deadline: { id?: ReturnType<typeof setTimeout> } = {}
    const finish = (result: FillLoginFieldsResult): void => {
      if (settled) return
      settled = true
      if (deadline.id !== undefined) clearTimeout(deadline.id)
      resolve(result)
    }
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      return finish({
        ok: false,
        reason: 'failed',
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', (error) => finish({ ok: false, reason: 'failed', detail: error.message }))
    child.on('close', (code) => {
      let parsed: { ok?: unknown; reason?: unknown; width?: unknown; height?: unknown }
      try {
        parsed = JSON.parse(stdout.trim()) as typeof parsed
      } catch {
        return finish({
          ok: false,
          reason: 'failed',
          detail: stderr.trim() || `PowerShell exit ${code}`,
        })
      }
      if (parsed.ok === true) return finish({ ok: true, hwnd: window.hwnd as number })
      if (parsed.reason === 'window-mismatch') {
        return finish({
          ok: false,
          reason: 'window-mismatch',
          detail: `窗口尺寸 ${String(parsed.width ?? '?')}×${String(parsed.height ?? '?')} 与 ${software} 登录页布局不匹配`,
        })
      }
      finish({ ok: false, reason: 'failed', detail: stderr.trim() || `PowerShell exit ${code}` })
    })
    deadline.id = setTimeout(() => {
      child.kill()
      finish({ ok: false, reason: 'failed', detail: '填写登录框超时' })
    }, 38000)
    child.stdin.end(JSON.stringify({ account, password }), 'utf8')
  })
}

/**
 * 读取主屏工作区。
 *
 * 读不到时返回 null，由调用方决定降级（跳过平铺）。**不猜一个 1920×1080 顶上**：
 * 猜错的后果是把窗口排到屏幕外，用户看到的是「微信起来了但找不到」，比不平铺更难解释。
 */
export async function readWorkArea(): Promise<WorkArea | null> {
  if (platform() !== 'win32') return null
  return new Promise<WorkArea | null>((resolve) => {
    let settled = false
    const finish = (value: WorkArea | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    runPowerShell(
      buildWorkAreaScript(),
      POWERSHELL_STARTUP_SLACK_MS,
      (stdout) => finish(parseWorkAreaOutput(stdout)),
      () => finish(null),
    )
  })
}

/**
 * 平铺一组窗口。
 *
 * `workArea` 缺省时先读一次主屏工作区。**少于两个窗口直接跳过**：单个窗口没有排布
 * 可言，它本就该在默认位置，跳过也省掉一次无意义的 PowerShell 调用。
 */
export async function tileWindows(
  hwnds: readonly number[],
  options: { workArea?: WorkArea } = {},
): Promise<TileOutcome> {
  if (platform() !== 'win32') return { moved: 0, reason: 'unsupported-platform' }
  if (hwnds.length < 2) return { moved: 0 }

  const workArea = options.workArea ?? (await readWorkArea())
  if (workArea === null) return { moved: 0, reason: 'failed' }

  const layout = computeTileLayout(hwnds.length, workArea)
  const targets: TileTarget[] = []
  for (let index = 0; index < hwnds.length; index += 1) {
    const rect = layout[index]
    const hwnd = hwnds[index]
    if (rect === undefined || hwnd === undefined) continue
    targets.push({ hwnd, ...rect })
  }
  if (targets.length < 2) return { moved: 0 }

  return new Promise<TileOutcome>((resolve) => {
    let settled = false
    const finish = (value: TileOutcome): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    runPowerShell(
      buildTileWindowsScript(targets),
      POWERSHELL_STARTUP_SLACK_MS,
      (stdout) => finish(parseTileOutput(stdout)),
      () => finish({ moved: 0, reason: 'failed' }),
    )
  })
}

/* ------------------------------------------------------------------ *
 * 六、按软件的决策与「点一下登录」
 * ------------------------------------------------------------------ */

/**
 * 该软件是否应在唤起后自动点登录（纯函数，便于单测）。
 *
 * 它是「按软件开关」这一决策的唯一入口：将来若要把开关下放到单条配置（设计文档提到
 * 自定义程序「用户可按需自行开启」），只改这一个函数、让它同时读 `LaunchProfile` 上的
 * 标志即可，调用方与窗口操作逻辑都不用动。
 *
 * **开关本体在共享包的 `LAUNCH_ACCOUNT_SOFTWARES`**，这里不做第二份清单：配置页的
 * 账号密码字段也按同一份判断，两份清单各自漂移的后果是「外壳替微信敲 Enter，而界面上
 * 根本不显示账号密码框」—— 那种不一致在真机上表现为「多账号第二个没登录」，两侧单独
 * review 都看不出问题。共享包的注释里有完整的取舍。
 */
export function shouldClickLogin(software: string): boolean {
  return supportsAccountLogin(software)
}

/** 一次点登录尝试的结果。调用方只记录，不据此改变启动结果。 */
export type ClickLoginAttempt = {
  /** 是否真的尝试了（false 表示被平台或开关拦下，连窗口操作都没发生）。 */
  attempted: boolean
  /** 平台/开关拦下、已发送按键、等不到窗口、执行异常。 */
  reason: 'unsupported-platform' | 'disabled' | 'launched' | 'no-window' | 'failed'
  /** 等待窗口用了多久，毫秒。没等到时也有值，排障时最有用的一列。 */
  waitedMs?: number
  /** 可排障的附言；成功路径一般为空。 */
  detail?: string
}

/** 点登录的等待参数。默认值见本文件顶部的三个常量。 */
export type ClickLoginOptions = WindowWaitOptions

/**
 * 唤起后 best-effort 点一下登录。
 *
 * ## 边界（与 §2.4 决策一致）
 *
 * - **只唤起 + 点一下登录，全程不碰凭据**：不向客户端输入账号密码、不读登录态、不后台
 *   静默注入。工作台从头到尾不持有机密，于是没有云端密文、没有本机密钥库、不触发账号
 *   风控。自动填表落地时这条会改，届时凭据的存取另有一套方案（见
 *   `docs/LAUNCH-LOGIN-DESIGN-2026-10-15.md`），不会从这条路悄悄加进去。
 * - **首选手段是把刚起来的登录窗带到前台，敲一个 Enter**：多数登录窗的「登录」按钮正是
 *   默认按钮，Enter 等效于点它。这条不依赖坐标、不依赖按钮文字，最能抗客户端改版。
 * - **按软件开关**：见 `shouldClickLogin`。
 * - **best-effort，失败即静默退回「用户手动点」**：绝不阻断启动结果、绝不抛异常。即便
 *   某次失效，后果仅是用户多点一下，动摇不了任何账号安全。
 *
 * ## 2026-10-15 修：spawn 后立刻点，窗口根本还没出现
 *
 * 原实现在 spawn 成功的那一刻就去找窗口、找不到就报 `no-window`。客户端冷启动到
 * 登录窗立住在真机上要几秒到十几秒，于是这一步**实测恒 `no-window`**，等于从来没生效
 * 过。修法是让等待发生在窗口操作内部（本文件 `buildWindowWaitBody` 里的轮询循环与
 * 稳定期复查），而不是在调用方 sleep 一下：后者会把「等多久」这个假设摊到每处调用
 * 点上，而各处的客户端冷启动时长并不一样。
 *
 * `options.timeoutMs` 默认 15 秒，覆盖客户端冷启动。调用方若已知某个客户端特别慢
 * （或特别快），可以显式传一个更合适的值，不必改这里的默认。
 */
export async function clickLoginAfterLaunch(
  software: string,
  pid: number,
  options: ClickLoginOptions = {},
): Promise<ClickLoginAttempt> {
  if (platform() !== 'win32') {
    return { attempted: false, reason: 'unsupported-platform' }
  }
  if (!shouldClickLogin(software)) {
    return { attempted: false, reason: 'disabled' }
  }

  let outcome: WindowSendOutcome
  try {
    outcome = await waitAndPressEnter(pid, options)
  } catch (error) {
    // 双保险：`waitAndPressEnter` 自己已吞异常，这里再兜一层是为了「将来的改动
    // 引入了一个会抛的路径」时不至于把 fire-and-forget 变成 unhandled rejection。
    return {
      attempted: true,
      reason: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }

  switch (outcome.reason) {
    case 'sent':
      return outcome.waitedMs === undefined
        ? { attempted: true, reason: 'launched' }
        : { attempted: true, reason: 'launched', waitedMs: outcome.waitedMs }
    case 'no-window':
      return outcome.waitedMs === undefined
        ? { attempted: true, reason: 'no-window' }
        : { attempted: true, reason: 'no-window', waitedMs: outcome.waitedMs }
    default:
      return {
        attempted: true,
        reason: 'failed',
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      }
  }
}

/**
 * 点登录的默认等待时长，转发出来供日志与测试引用。
 *
 * 单独导出而不是让调用方各写一个数字：日志里要打「等了多久」，而「多久算正常」必须
 * 在两处用同一个参照，否则排障时说好的 15 秒在另一处变成了 5 秒。
 */
export { DEFAULT_WINDOW_WAIT_MS as CLICK_LOGIN_WAIT_MS }
