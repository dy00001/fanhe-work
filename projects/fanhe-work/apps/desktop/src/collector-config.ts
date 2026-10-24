/**
 * 采集器根目录的配置。
 *
 * ## 为什么需要它
 *
 * 桌面端要起采集浏览器的登录窗口，就得找到 `shop-login.ps1`。原先只有一条找法：
 * 从自己的安装目录向上找 `.ws-root` 标记文件，再拼出
 * `<工作区>/projects/fanhe-work/tools/collector/scripts/shop-login.ps1`。
 *
 * 这条路在安装态下几乎必然断：安装目录与工作区不同盘（实测本机安装目录在
 * `D:\fanhe work\@fanhedesktop`，工作区在 `E:\fanhe Work`），向上找的链条走到
 * `D:\` 就断了，脚本定位失败，界面只能显示「当前安装没有采集器脚本」加一条
 * 手工命令。
 *
 * 于是给一个显式配置：`<配置目录>/collector.json` 写
 * `{"root": "E:\\fanhe Work\\projects\\fanhe-work\\tools\\collector"}`。
 * 配置文件每次调用现读，改完不用重启外壳。
 *
 * ## 两条路径来源
 *
 *   1. 环境变量 `FANHE_COLLECTOR_ROOT` —— 一次性覆盖，与 `FANHE_SERVICE_URL` 同款
 *   2. 配置文件 —— 安装态在 `%APPDATA%\梵禾 Work\collector.json`，开发态在工作区
 *      的 `.config/fanhe-work/collector.json`
 *
 * `root` 既可以指向 `tools/collector` 本身，也可以指向仓库根，两种都认：前者
 * 更贴近使用者填的路径，后者更贴近「我知道仓库在哪」。
 */
import fs from 'node:fs'
import path from 'node:path'

export type CollectorConfigSource = 'environment' | 'file' | 'none'

export type CollectorConfig = {
  /** 采集器根目录；没配或配错时为 null。 */
  root: string | null
  /** 配置文件路径。来源是环境变量时为空串。 */
  path: string
  source: CollectorConfigSource
  /** 读到了但没成的原因，用于界面提示。 */
  warning: string | null
}

const CONFIG_FILE_NAME = 'collector.json'

/**
 * 解析配置文件内容。
 *
 * 只接受一个非空字符串。`root` 指向哪由调用方决定（两种都认），这里不猜。
 */
export function parseCollectorConfig(
  raw: string,
): { ok: true; root: string } | { ok: false; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      ok: false,
      error: `不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: '根节点必须是对象' }
  const value = (parsed as Record<string, unknown>)['root']
  if (typeof value !== 'string') return { ok: false, error: 'root 必须是字符串' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, error: 'root 不能为空' }
  return { ok: true, root: trimmed }
}

/** 配置文件路径。安装态给 `configDir`，开发态给工作区根。 */
export function collectorConfigPath(options: {
  configDir?: string
  workspaceRoot?: string | null
}): string | null {
  if (options.configDir !== undefined) return path.join(options.configDir, CONFIG_FILE_NAME)
  if (options.workspaceRoot === null || options.workspaceRoot === undefined) return null
  return path.join(options.workspaceRoot, '.config', 'fanhe-work', CONFIG_FILE_NAME)
}

/**
 * 读采集器根目录。
 *
 * 找不到文件不算错：那台机器上可能根本不需要起登录窗口。所以返回 `root: null`
 * 加一句说明，由调用方决定怎么告诉用户。
 */
export function resolveCollectorRoot(options: {
  configDir?: string
  workspaceRoot?: string | null
  env?: NodeJS.ProcessEnv
}): CollectorConfig {
  const env = options.env ?? process.env

  const fromEnv = (env['FANHE_COLLECTOR_ROOT'] ?? '').trim()
  if (fromEnv !== '') {
    return { root: fromEnv, path: '', source: 'environment', warning: null }
  }

  const configPath = collectorConfigPath(options)
  if (configPath === null) {
    return {
      root: null,
      path: '',
      source: 'none',
      warning: '既没有配置目录也没有工作区根，无处可读采集器配置。',
    }
  }

  let raw: string
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch {
    return {
      root: null,
      path: configPath,
      source: 'none',
      warning: `未找到采集器配置（${configPath}）。`,
    }
  }

  const parsed = parseCollectorConfig(raw)
  if (!parsed.ok) {
    return {
      root: null,
      path: configPath,
      source: 'file',
      warning: `采集器配置不可用：${parsed.error}`,
    }
  }
  return { root: parsed.root, path: configPath, source: 'file', warning: null }
}

/**
 * 采集器脚本的候选路径。
 *
 * `root` 指向 `tools/collector` 或指向仓库根都试一遍，返回存在的那个。
 * 两个都不存在时返回候选列表，供错误信息展示。
 */
export function collectorScriptCandidates(root: string): string[] {
  const normalized = path.resolve(root)
  return [
    path.join(normalized, 'scripts', 'shop-login.ps1'),
    path.join(normalized, 'tools', 'collector', 'scripts', 'shop-login.ps1'),
  ]
}
