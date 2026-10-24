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
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'

/** 与 `packages/shared/src/ops.ts` 的 `OPS_SHOP_CODE_PATTERN` 逐字一致。 */
const SHOP_CODE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

export type ShopLoginFailureReason =
  'invalid_code' | 'unsupported_platform' | 'collector_missing' | 'spawn_failed'

export type ShopLoginResult =
  | {
      ok: true
      command: string
      /** 给人看的一句结果说明，例如「浏览器已打开，请登录」。 */
      note?: string
    }
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

/** PowerShell 单引号字符串：内部单引号要写成两个。 */
function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** 读脚本日志的最后一段，用于失败提示。读不到就给空串。 */
function readLogTail(logPath: string): string {
  try {
    const text = readFileSync(logPath, 'utf8').trim()
    if (text === '') return ''
    return `：${text.slice(-300)}`
  } catch {
    return ''
  }
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
 * **绝不能 detach。** 实测（2026-10-24）：`detached: true` 时 PowerShell 在 Windows
 * 上会立刻以退出码 0 结束，一个字都不执行 —— 没有日志、没有浏览器，界面看起来
 * 就是「点了没反应」。同一份命令改成 `detached: false` 立刻正常（退出码 3、Edge
 * 起来）。0.3.2 与 0.3.3 都带着这个错，当时把原因误记成「`-File` 配隐藏窗口」。
 *
 * 原先 detach 的理由是「外壳关掉不该杀掉等待扫码的浏览器」，这个担心不成立：
 * 脚本本身十几秒就退场，浏览器是它另起的独立进程；Windows 上非 detach 的子进程
 * 也不会随父进程退出而被杀（Electron 没有把子进程放进 job object）。
 */
/**
 * 可注入的启动器。
 *
 * 抽出来是为了让测试能在**不真的开浏览器**的前提下验证参数拼装与各条失败分支。
 * 默认用 `child_process.spawn`；生产路径不传它。
 */
/**
 * spawn 的最小接口。
 *
 * 要能挂 `error` 与 `exit` 两个事件，因为**启动失败是异步的**：命令不存在时
 * `spawn` 不抛异常，而是在下一个事件循环里发 `error`。首版只 try/catch 了同步
 * 异常就返回成功，于是「脚本根本没起来」被当成「已打开」，界面上点了没反应 ——
 * 这正是用户 2026-10-24 报的那个现象。
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: 'ignore'; windowsHide: boolean },
) => {
  unref: () => void
  on?: (event: 'error' | 'exit', listener: (payload: unknown) => void) => void
  stderr?: { on: (event: 'data', listener: (chunk: unknown) => void) => void } | null
}

export async function openShopLogin(
  code: unknown,
  options: {
    workspaceRoot: string | null
    /** 显式配置的采集器根目录。装在别的盘、仓库在别处时靠它。 */
    collectorRoot?: string | null
    /** 采集器配置文件该放哪，用于失败提示。 */
    configPath?: string | null
    /** 判定「启动成功」的等待窗口。测试传很小的值，生产用默认四秒。 */
    settleMs?: number
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

  /* 等一小段时间再判定成败。
   *
   * 不能等进程结束：脚本会在登录页等你扫码，可能挂十分钟。也不能立刻返回成功：
   * 命令找不到、脚本语法错、权限被拦这几种情况都在几十毫秒内以 `error` 或非零
   * 退出码结束，立刻返回成功就等于把它们全部吞掉。
   *
   * 四秒的取法：正常启动到 Edge 出窗口约 1 到 2 秒，四秒足够覆盖失败路径，又不会
   * 让按钮迟迟不给反馈。超时未退出即视为成功。 */
  /* 为什么用 -Command 而不是 -File。
   *
   * 实测（2026-10-24）：`-File` 配合 `stdio: 'ignore'` 与 `windowsHide: true` 时，
   * 脚本会在第一个 `Write-Host` 处静默结束，退出码 0、没有任何输出、Edge 也没起来。
   * 换成一个带控制台的调用就正常（退出码 3、浏览器弹出）。也就是说「隐藏窗口」
   * 与「-File」这个组合本身不可靠，而不是脚本有 bug。
   *
   * `-Command` 里先把所有输出重定向到日志文件再执行，脚本就不依赖控制台；
   * 退出码用 `exit $LASTEXITCODE` 透传出来。失败时把日志尾巴放进提示，
   * 用户不必去猜。 */
  const logPath = join(tmpdir(), `fanhe-shop-login-${normalized}.log`)
  const inner =
    `& ${psQuote(script)} -Shop ${normalized} -Keep -NoPrompt ` +
    `*>&1 | Out-File -FilePath ${psQuote(logPath)} -Encoding UTF8; ` +
    `exit $LASTEXITCODE`

  /**
   * 等待窗口。
   *
   * 脚本自己的最坏情况是：等调试端口 40 秒 + 等 profile 目录 10 秒 + 一次登录态
   * 检查，合计五十多秒。窗口必须比它长，否则永远是「桌面端先超时、脚本后报错」，
   * 用户拿不到脚本真正的原因。正常情况（已登录过的店）16 秒左右返回。
   */
  const SETTLE_MS = options.settleMs ?? 70000

  try {
    const child = spawnImpl(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', inner],
      /* detached 必须是 false：见上方注释，true 会让脚本一个字都不执行。 */
      { detached: false, stdio: 'ignore', windowsHide: true },
    )

    const outcome = await new Promise<{ ok: boolean; message: string }>((resolve) => {
      let settled = false
      const finish = (result: { ok: boolean; message: string }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      /* 脚本自己不会挂住（-Keep 只是不关窗口），正常情况下十几秒内退出：
         退出码 0 表示本来就是登录态，3 表示需要登录、窗口已经打开。
         超时则视为「卡住了」而不是「大概成功了」：真成功的话它早就退出了。
         误判的代价是给出一句多余的提示，比报成功却什么都没发生要好。 */
      const timer = setTimeout(
        () =>
          finish({
            ok: false,
            message:
              '登录脚本超过一分多钟仍未结束。多数情况是调试端口没起来：安全软件拦截、Edge 正在更新，或端口被别的进程占用。若窗口其实已经出现，忽略这条提示即可；否则用下面的命令在仓库根手工执行，它会打印卡在哪一步。',
          }),
        SETTLE_MS,
      )

      child.on?.('error', (payload) => {
        const detail = payload instanceof Error ? payload.message : String(payload)
        finish({ ok: false, message: `启动登录脚本失败：${detail}` })
      })

      child.on?.('exit', (payload) => {
        const code = typeof payload === 'number' ? payload : -1
        if (code === 0) {
          finish({ ok: true, message: '这家店当前是登录态，浏览器已打开，可以直接用。' })
          return
        }
        if (code === 3) {
          finish({ ok: true, message: '浏览器已打开，请在窗口里登录这家店的账号。' })
          return
        }
        finish({
          ok: false,
          message: `登录脚本失败（退出码 ${String(code)}）${readLogTail(logPath)}`,
        })
      })
    })

    if (!outcome.ok) {
      return {
        ok: false,
        reason: 'spawn_failed',
        message: outcome.message,
        command,
        configPath: options.configPath ?? null,
      }
    }

    child.unref()
    return { ok: true, command, note: outcome.message }
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
