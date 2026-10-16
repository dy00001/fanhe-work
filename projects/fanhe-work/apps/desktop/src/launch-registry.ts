/**
 * 从 Windows 注册表 Uninstall 键读「自定义安装位置」的安装提示（2.5 增强）。
 *
 * ## 为什么需要它
 *
 * §2.5 的目录扫描只认 `%ProgramFiles%` / `%ProgramFiles(x86)%` / `%LOCALAPPDATA%`
 * 以及「所有盘的 Program Files」这些**惯用**位置。真机实测里，用户把 QQ / 微信 / 千牛
 * 统统装在自选的 `D:\软件安装目录\` 下 —— 任何「已知路径」清单都猜不到这种目录名，
 * 于是「软件明明装了，一键检测却说没找到」。设计文档 §2.5 早就把「读注册表 Uninstall 键」
 * 列为**后续可选增强**（当时的权衡是怕为检测引入跨平台依赖、污染 `agent.ts`）；这里补上它，
 * 且刻意落在**外壳侧**的独立模块里，内核那份零依赖的 `agent.ts` 一处不动。
 *
 * ## 数据来源与形态（真机实测）
 *
 * 卸载项里三个字段够用：
 * - `DisplayName` —— 用来认「这是哪个软件的卸载项」（如 `QQ` / `微信` / `千牛工作台`）。
 * - `DisplayIcon` —— 常直接指向主程序（`D:\...\QQ\QQ.exe,0`、`"D:\...\Weixin\Weixin.exe"`），
 *   但也可能指向卸载器（千牛是 `D:\...\千牛\Uninstall.exe`），所以要按主程序名过滤。
 * - `InstallLocation` —— 安装根目录（千牛有值、QQ 为空），拿来拼「根 + 主程序名」。
 *
 * 三种情况合起来：主程序名直接命中 `DisplayIcon` 的（QQ / 微信），或落在 `InstallLocation`
 * 根下的（千牛），都能推出来。
 *
 * ## 边界
 *
 * - **只读、best-effort**：读不到、起不来、解析失败，一律返回空数组，绝不抛异常 —— 检测
 *   是锦上添花，不能因为它失败而让整个 `launch:detect` 报错。
 * - **不在这里判存在**：这里宁可多给候选，存在性交给调用方注入的 `inspect` 复核（与
 *   `agent.ts` 的 `detectLaunchPaths` 同一套判断），误报会被自然过滤。
 * - **非 Windows 直接空**：注册表是 Windows 专有。
 */

import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** 一条卸载记录里我们关心的三个字段（缺失的一律归一成空串）。 */
export type UninstallRecord = {
  displayName: string
  installLocation: string
  displayIcon: string
}

/**
 * 某软件在注册表里怎么认。
 *
 * `displayName` 用来挑出属于该软件的卸载项；`exeNames` 是它的主程序文件名，用来从
 * `DisplayIcon` / 安装根里挑出真正的可执行文件，避开卸载器（`Uninstall.exe`）之类。
 * 比较一律小写进行，但**回填时用这里写的原样大小写**（注册表不告诉我们磁盘上的真实大小写，
 * 用惯用写法至少让回填出来的路径看起来是对的；Windows 文件系统大小写不敏感，能启动）。
 */
export type RegistrySoftwareMatcher = {
  displayName: RegExp
  exeNames: readonly string[]
}

/**
 * 各软件在注册表里的识别规则。
 *
 * `displayName` 刻意给得宽松（宁可多认几条，反正 `exeNames` + 存在性复核会兜底），
 * 但 `exeNames` 必须精确 —— 它决定从安装根里挑哪个文件，错了就回填一条错路径。
 * 未列出的 software（含 `custom`）没有「已知行为」，返回空数组。
 */
export const REGISTRY_SOFTWARE_MATCHERS: Readonly<Record<string, RegistrySoftwareMatcher>> = {
  qq: { displayName: /QQ/i, exeNames: ['QQ.exe', 'QQNT.exe'] },
  wechat: { displayName: /微信|WeChat|Weixin/i, exeNames: ['WeChat.exe', 'Weixin.exe'] },
  qianniu: {
    displayName: /千牛|旺旺|AliWang/i,
    exeNames: ['AliWorkbench.exe', 'AliWangWang.exe', 'aliim.exe'],
  },
}

/** 去掉注册表值里常见的包裹引号与首尾空白。 */
export function stripRegistryValueQuotes(value: string): string {
  let text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1)
  }
  return text.trim()
}

/**
 * 把 `DisplayIcon` 归一成可执行文件路径（纯函数）。
 *
 * 常见形态：`D:\...\Weixin.exe`、`D:\...\QQ.exe,0`、`"D:\...\Weixin.exe"`、
 * `D:\...\Uninstall.exe`（卸载器）。返回去掉包裹引号与尾部 `,<序号>` 后的路径；
 * 不是 `.exe` 结尾则返回 null（可能是个图标 dll、或空值）。
 */
export function normalizeDisplayIcon(value: string): string | null {
  let text = stripRegistryValueQuotes(value)
  if (text === '') return null
  // 去掉 `,<图标序号>` 后缀：只在最后一个逗号后是纯数字时才切，避免误伤带逗号的路径。
  const comma = text.lastIndexOf(',')
  if (comma !== -1 && /^\d+$/.test(text.slice(comma + 1).trim())) {
    text = stripRegistryValueQuotes(text.slice(0, comma))
  }
  return text.toLowerCase().endsWith('.exe') ? text : null
}

/**
 * 从一批卸载记录里，为某软件推出「可能的主程序绝对路径」（纯函数）。
 *
 * 对每条**命中该软件 `displayName`**的记录，取两个安装根：
 *   - `DisplayIcon` 指向的 exe 所在目录；
 *   - `InstallLocation`（非空时）。
 * 每个根下按主程序名平铺展开 `根 + <exeName>` —— 自定义安装目录里主程序常直接躺在
 * 安装根下（`D:\软件安装目录\千牛\AliWorkbench.exe` 正是如此）。另外 `DisplayIcon`
 * 本身若就是该软件主程序，直接作为候选（QQ 的 `InstallLocation` 为空，只能靠它）。
 *
 * 不在这里判存在：误报由调用方的 `inspect` 复核过滤，所以宁可多给、不可漏给。
 * 返回值去重（大小写不敏感），保持首次出现顺序。
 */
export function registryInstallCandidates(
  records: readonly UninstallRecord[],
  software: string,
): string[] {
  const matcher = REGISTRY_SOFTWARE_MATCHERS[software]
  if (matcher === undefined) return []

  const out: string[] = []
  const seen = new Set<string>()
  const push = (candidate: string): void => {
    if (candidate === '') return
    const key = candidate.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(candidate)
  }
  const lowerExeNames = matcher.exeNames.map((name) => name.toLowerCase())

  for (const record of records) {
    if (!matcher.displayName.test(record.displayName)) continue

    const iconExe = normalizeDisplayIcon(record.displayIcon)
    if (iconExe !== null && lowerExeNames.includes(basename(iconExe).toLowerCase())) {
      push(iconExe)
    }

    const roots: string[] = []
    if (iconExe !== null) roots.push(dirname(iconExe))
    const installLocation = stripRegistryValueQuotes(record.installLocation)
    if (installLocation !== '') roots.push(installLocation)

    for (const root of roots) {
      for (const exeName of matcher.exeNames) push(join(root, exeName))
    }
  }
  return out
}

/**
 * 解析 PowerShell `ConvertTo-Json` 出来的卸载记录（纯函数）。
 *
 * 容忍：空串、单个对象（`ConvertTo-Json` 对单条结果不产出数组）、字段缺失或为 null、
 * 以及 UTF-8 BOM 前缀（`JSON.parse` 遇 BOM 会直接抛）。任何解析失败返回空数组。
 */
export function parseUninstallRecords(json: string): UninstallRecord[] {
  const text = json.replace(/^\uFEFF/, '').trim()
  if (text === '') return []

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return []
  }

  const list = Array.isArray(parsed) ? parsed : [parsed]
  const out: UninstallRecord[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const record = item as Record<string, unknown>
    out.push({
      displayName: typeof record.DisplayName === 'string' ? record.DisplayName : '',
      installLocation: typeof record.InstallLocation === 'string' ? record.InstallLocation : '',
      displayIcon: typeof record.DisplayIcon === 'string' ? record.DisplayIcon : '',
    })
  }
  return out
}

/**
 * 拼出「读三个卸载 hive、把关心的三个字段导成 JSON」那段 PowerShell（纯函数，便于单测）。
 *
 * 三个 hive 覆盖：64 位系统级、32 位（WOW6432Node）系统级、当前用户级。中文 `DisplayName`
 * 与中文安装路径都可能有，故强制 stdout 走 UTF-8，Node 侧按 utf8 读回。
 *
 * 不在脚本里按软件过滤：过滤逻辑留在可单测的 `registryInstallCandidates` 里，脚本只管
 * 把数据原样倒出来。
 */
export function buildRegistryQueryScript(): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$paths = @(
  'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
)
$items = Get-ItemProperty -Path $paths | Select-Object DisplayName, InstallLocation, DisplayIcon
$json = $items | ConvertTo-Json -Compress -Depth 3
if ($null -eq $json) { $json = '[]' }
Write-Output $json
`.trim()
}

/** 注入点：执行一段 PowerShell、拿回 stdout。默认起真实 `powershell.exe`。 */
export type RegistryScriptRunner = (script: string) => Promise<string>

const defaultRunner: RegistryScriptRunner = (script) => {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      { timeout: 8000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve(stdout)
      },
    )
  })
}

/**
 * 读本机注册表，给出某软件「自定义安装位置」下的候选主程序路径（2.5 增强）。
 *
 * best-effort：非 Windows、未知 software、注册表读不到、PowerShell 起不来、解析失败
 * —— 一律返回空数组，绝不抛异常。
 *
 * `run` 可注入，便于单测在不碰真实注册表的前提下驱动整条链路。
 */
export async function readRegistryInstallHints(
  software: string,
  options: { run?: RegistryScriptRunner } = {},
): Promise<string[]> {
  if (REGISTRY_SOFTWARE_MATCHERS[software] === undefined) return []
  // 非 Windows 且没注入 runner（真实调用）时直接空；注入 runner 的单测不受平台限制。
  if (options.run === undefined && platform() !== 'win32') return []

  const run = options.run ?? defaultRunner
  try {
    const stdout = await run(buildRegistryQueryScript())
    return registryInstallCandidates(parseUninstallRecords(stdout), software)
  } catch {
    return []
  }
}
