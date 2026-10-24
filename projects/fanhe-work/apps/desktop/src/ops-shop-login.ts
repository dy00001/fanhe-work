/**
 * 从工作台打开采集浏览器的登录窗口。
 *
 * ## 为什么这件事只能由桌面壳做
 *
 * 采集器是宿主机上的脚本（`tools/collector/scripts/shop-login.ps1`），它要起一个
 * 带调试端口的 Edge 并等人扫码。API 可能跑在容器里，碰不到宿主机进程；浏览器里
 * 的页面更不可能。桌面壳是唯一同时具备「在本机」与「有 IPC」的宿主。
 *
 * ## 找不到脚本时不要假装成功
 *
 * 安装态的安装目录里**没有** `tools/collector`（它不在打包产物里），所以打包后
 * 这条通道常常不可用。此时返回 `collector_missing` 并带上要手工执行的命令，由
 * 界面显示出来。让按钮点了没反应，比告诉用户「请自己跑这条命令」更糟。
 *
 * ## 只接受合法代号
 *
 * 代号会拼进命令行，必须在主进程再校验一次（前端的校验只是体验，不是边界）。
 * 正则与共享包的 `OPS_SHOP_CODE_PATTERN`、采集器的 `CODE_RE` 三者同源，任何一处
 * 放宽都会让 `-Shop "s2; rm -rf"` 这类输入有缝可钻。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path, { join } from 'node:path'

/** 与 `packages/shared/src/ops.ts` 的 `OPS_SHOP_CODE_PATTERN` 逐字一致。 */
const SHOP_CODE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export type ShopLoginFailureReason =
  'invalid_code' | 'unsupported_platform' | 'collector_missing' | 'spawn_failed'

export type ShopLoginResult =
  | { ok: true; command: string }
  | {
      ok: false
      reason: ShopLoginFailureReason
      message: string
      command: string
      /** 采集器配置文件该放哪。null 表示这台机器上无处可放（连配置目录都没有）。 */
      configPath: string | null
    }

/** 手工执行的命令。无论成功与否都返回，界面在失败时直接展示。 */
export function shopLoginCommand(code: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -File tools\\collector\\scripts\\shop-login.ps1 -Shop ${code}`
}

/**
 * 定位登录脚本。找不到返回 null。
 *
 * 两条来源，按优先级：
 *
 *   1. **配置的采集器根目录**。安装态与工作区不同盘时，向上找 `.ws-root` 必然
 *      断掉（实测本机安装目录在 D 盘、工作区在 E 盘），所以这条是主路。
 *   2. **工作区根 + 固定相对路径**。开发态走这条。
 *
 * 安装包里没有 `tools/collector`，所以第 2 条在安装态无效；不猜 `Program Files`
 * 下的位置，因为脚本本来就不进安装包。
 */
export function resolveShopLoginScript(
  workspaceRoot: string | null,
  collectorRoot?: string | null,
): string | null {
  if (collectorRoot !== undefined && collectorRoot !== null) {
    const base = path.resolve(collectorRoot)
    /* 两种填法都认：指向 tools/collector 本身，或指向仓库根。
       这里自己算而是从别处 import，是为了让本模块能被测试直接加载
       （测试用 node --experimental-strip-types 跑源码，跨模块的 .js 说明符
       解析不到 .ts 文件）。 */
    const candidates = [
      path.join(base, 'scripts', 'shop-login.ps1'),
      path.join(base, 'tools', 'collector', 'scripts', 'shop-login.ps1'),
    ]
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate
    }
  }
  if (workspaceRoot === null) return null
  const script = join(
    workspaceRoot,
    'projects',
    'fanhe-work',
    'tools',
    'collector',
    'scripts',
    'shop-login.ps1',
  )
  return existsSync(script) ? script : null
}

/**
 * 启动登录窗口。**立即返回**，不等扫码完成。
 *
 * 脚本自己会轮询登录态并在成功后退场，把它做成同步等待会让 IPC 挂几分钟，
 * 而界面上只需要「窗口已经弹出来了」这一个事实。
 *
 * `detached` 是有意的：外壳被关掉时不该把正在等待扫码的浏览器一起杀掉 ——
 * 用户可能正是为了登录才打开外壳。
 */
/**
 * 可注入的启动器。
 *
 * 抽出来是为了让测试能在**不真的开浏览器**的前提下验证参数拼装与各条失败分支。
 * 默认用 `child_process.spawn`；生产路径不传它。
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => { unref: () => void }

export async function openShopLogin(
  code: unknown,
  options: {
    workspaceRoot: string | null
    /** 显式配置的采集器根目录。装在别的盘、仓库在别处时靠它。 */
    collectorRoot?: string | null
    /** 采集器配置文件该放哪，用于失败提示。 */
    configPath?: string | null
    platform?: NodeJS.Platform
    spawnImpl?: SpawnLike
  },
): Promise<ShopLoginResult> {
  const normalized = typeof code === 'string' ? code.trim() : ''
  if (!SHOP_CODE_RE.test(normalized)) {
    return {
      ok: false,
      reason: 'invalid_code',
      message: `店铺代号不合法：${normalized === '' ? '(空)' : normalized}`,
      command: '',
      configPath: options.configPath ?? null,
    }
  }

  const command = shopLoginCommand(normalized)
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return {
      ok: false,
      reason: 'unsupported_platform',
      message: '采集浏览器登录只支持 Windows（脚本依赖 Edge 与调试端口）',
      command,
      configPath: options.configPath ?? null,
    }
  }

  const script = resolveShopLoginScript(options.workspaceRoot, options.collectorRoot)
  if (script === null) {
    const where =
      options.collectorRoot === undefined || options.collectorRoot === null
        ? '当前安装里没有采集器脚本（安装包不含 tools/collector）'
        : `配置的采集器根目录下没有 shop-login.ps1：${options.collectorRoot}`
    const hint =
      options.configPath === undefined || options.configPath === null || options.configPath === ''
        ? '在装有本仓库的机器上手工执行下面这条命令。'
        : `写一个 collector.json 到 ${options.configPath}，内容形如 {"root": "E:\\\\工作区路径\\\\projects\\\\fanhe-work\\\\tools\\\\collector"}，或手工执行下面这条命令。`
    return {
      ok: false,
      reason: 'collector_missing',
      message: `${where}。${hint}`,
      command,
      configPath: options.configPath ?? null,
    }
  }

  const spawnImpl: SpawnLike = options.spawnImpl ?? (spawn as unknown as SpawnLike)
  try {
    const child = spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Shop', normalized],
      { detached: true, stdio: 'ignore', windowsHide: false },
    )
    child.unref()
  } catch (error) {
    return {
      ok: false,
      reason: 'spawn_failed',
      message: `启动登录脚本失败：${error instanceof Error ? error.message : String(error)}`,
      command,
      configPath: options.configPath ?? null,
    }
  }

  /* 不返回端口：脚本自己读 shops.config.json 决定。在这里猜一个数字，多店场景下
     很容易给出错的，而界面会把它当事实展示。 */
  return { ok: true, command }
}
