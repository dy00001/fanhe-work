/**
 * 唤起后「点一下登录」的后置步骤（2.4）。
 *
 * ## 它不进 `agent.ts` 的零依赖内核
 *
 * `agent.ts` 那份 spawn 核心被 192 项集成测试钉着，必须能原样打包随投、一处不动。
 * 而「点登录」是**外壳侧**的体验增强：它依赖平台（Windows 的 `user32`）、依赖外部
 * 客户端的窗口，且本质上 best-effort。把它单独放在这里，由 `main.ts` 在 spawn 成功后
 * 「按需加载」，内核那份就不会因为要照顾这个动作而引入跨平台依赖、也不会被它的失败
 * 路径污染。
 *
 * ## 边界（与 §2.4 决策一致）
 *
 * - **只唤起 + 点一下登录，全程不碰凭据**：不向客户端输入账号密码、不读登录态、不后台
 *   静默注入。工作台从头到尾不持有机密，于是没有云端密文、没有本机密钥库、不触发账号
 *   风控。
 * - **首选手段是把刚起来的登录窗带到前台，敲一个 Enter**：多数登录窗的「登录」按钮正
 *   是默认按钮，Enter 等效于点它。这条不依赖坐标、不依赖按钮文字，最能抗客户端改版。
 * - **按软件开关**：qq / qianniu 唤起后点登录；wechat 只唤起（扫码登录，多点无益）；
 *   自定义程序默认只唤起。
 * - **best-effort，失败即静默退回「用户手动点」**：绝不阻断启动结果、绝不抛异常。即便
 *   某次失效，后果仅是用户多点一下，动摇不了任何账号安全。
 *
 * ## 为什么 fire-and-forget
 *
 * 调用方（`launch:run` / `launch:runMany` 的 handler）在 spawn 成功后 `void` 掉它，
 * 不等它返回。登录点击是「锦上添花」，它的快慢与成败都不该影响启动通道已经给出的结果，
 * 更不该因为 PowerShell 偶发卡住而把整个 IPC 拖住。
 */

import { execFile } from 'node:child_process'
import { platform } from 'node:os'

/**
 * 各软件是否默认在唤起后自动点一下「登录」。
 *
 * `true` 的软件：qq、qianniu（唤起后默认窗口在登录态，敲 Enter 即登录，凭据由客户端
 * 自带「记住账号密码」保存）。`false`：wechat（扫码登录，多点无益）、custom（没有
 * 「已知行为」，默认不点，交由运维按需另开）。
 *
 * 未知 software 一律按 custom 处理（`shouldClickLogin` 兜底返回 false）。
 */
const CLICK_LOGIN_ENABLED_BY_SOFTWARE: Readonly<Record<string, boolean>> = {
  qq: true,
  qianniu: true,
  wechat: false,
  custom: false,
}

/**
 * 该软件是否应在唤起后自动点登录（纯函数，便于单测）。
 *
 * 它是「按软件开关」这一决策的唯一入口：将来若要把开关下放到单条配置（设计文档提到
 * 自定义程序「用户可按需自行开启」），只改这一个函数、让它同时读 `LaunchProfile` 上的
 * 标志即可，调用方与窗口操作逻辑都不用动。
 */
export function shouldClickLogin(software: string): boolean {
  return CLICK_LOGIN_ENABLED_BY_SOFTWARE[software] === true
}

/** 一次点登录尝试的结果。调用方只记录，不据此改变启动结果。 */
export type ClickLoginAttempt = {
  /** 是否真的尝试了（false 表示被平台或开关拦下，连窗口操作都没发生）。 */
  attempted: boolean
  reason: 'unsupported-platform' | 'disabled' | 'launched' | 'failed'
  /** 可排障的附言；成功路径一般为空。 */
  detail?: string
}

/**
 * 唤起后 best-effort 点一下登录。
 *
 * - 非 Windows：直接 `unsupported-platform`，不做事（macOS / Linux 没有这些客户端，
 *   也没有 `user32`）。
 * - 该软件未开：直接 `disabled`，不做事。
 * - 其余：把进程的首个可见窗口带到前台并敲 Enter；任何异常都吞掉，回报 `failed`
 *   而不是抛出 —— 绝不能让一条「登录没点成」上升到「启动失败」。
 */
export async function clickLoginAfterLaunch(
  software: string,
  pid: number,
): Promise<ClickLoginAttempt> {
  if (platform() !== 'win32') {
    return { attempted: false, reason: 'unsupported-platform' }
  }
  if (!shouldClickLogin(software)) {
    return { attempted: false, reason: 'disabled' }
  }
  try {
    return await sendEnterToProcessWindow(pid)
  } catch (error) {
    return {
      attempted: true,
      reason: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 把「敲 Enter 到某 pid 的首个可见窗口」这段 PowerShell 拼出来（纯函数，便于单测）。
 *
 * 不在此执行：执行只在 Windows 上、且只在确实要点的软件上发生。单测只断言产物包含
 * 目标 pid、Enter 的虚拟键码与带到前台的 P/Invoke，不真正调起 PowerShell。
 *
 * ## 手段说明
 * - `EnumWindows` + `GetWindowThreadProcessId` 枚举顶层窗口，挑出属于该 pid 且可见的第一扇。
 * - `AttachThreadInput` + `SetForegroundWindow` 绕开 Windows 的前台锁：直接
 *   `SetForegroundWindow` 在非前台线程调用时经常被忽略，先把自己的输入线程挂到目标窗口
 *   的线程上再置前台，成功率更高。
 * - `ShowWindow(SW_RESTORE)` 先把最小化/隐藏的窗口恢复，否则置前台对隐藏窗口无效。
 * - `keybd_event(0x0D)`：VK_RETURN 的按下与抬起。它发到当前前台窗口，于是落在登录窗的
 *   默认按钮上。
 */
export function buildLoginClickScript(pid: number): string {
  const pidLiteral = String(pid)
  return `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32LoginClick {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
  [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@

$targetPid = ${pidLiteral}
$found = [IntPtr]::Zero
$callback = {
  param($hwnd, $lParam)
  $pidOut = 0u
  [Win32LoginClick]::GetWindowThreadProcessId($hwnd, [ref]$pidOut) | Out-Null
  if ($pidOut -eq $targetPid -and [Win32LoginClick]::IsWindowVisible($hwnd)) {
    $script:found = $hwnd
    return $false
  }
  return $true
}
[Win32LoginClick]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null

if ($found -eq [IntPtr]::Zero) {
  Write-Output '{"sent":false,"reason":"no-window"}'
  exit 0
}

$threadId = 0u
[Win32LoginClick]::GetWindowThreadProcessId($found, [ref]$threadId) | Out-Null
[Win32LoginClick]::AttachThreadInput($threadId, [Win32LoginClick]::GetCurrentThreadId(), $true) | Out-Null
[Win32LoginClick]::ShowWindow($found, 9) | Out-Null
[Win32LoginClick]::SetForegroundWindow($found) | Out-Null
[Win32LoginClick]::AttachThreadInput($threadId, [Win32LoginClick]::GetCurrentThreadId(), $false) | Out-Null

Start-Sleep -Milliseconds 300
[Win32LoginClick]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[Win32LoginClick]::keybd_event(0x0D, 0, 2, [UIntPtr]::Zero)

Write-Output '{"sent":true}'
`.trim()
}

/**
 * 真正执行那段 PowerShell（只在 Windows + 已开软件时走到这里）。
 *
 * 用 `-EncodedCommand` 传 base64(UTF-16LE)，避开一层层引号转义。超时 5 秒：PowerShell
 * 启动与窗口操作本应远快于此，超时说明环境异常，kill 掉并回报 `failed`，不该卡住调用方。
 */
function sendEnterToProcessWindow(pid: number): Promise<ClickLoginAttempt> {
  const script = buildLoginClickScript(pid)
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          resolve({ attempted: true, reason: 'failed', detail: error.message })
          return
        }
        const text = stdout.trim()
        // `detail` 是可选属性（`exactOptionalPropertyTypes`），空时省略而非给 undefined。
        resolve(text === '' ? { attempted: true, reason: 'launched' } : { attempted: true, reason: 'launched', detail: text })
      },
    )
  })
}
