import { spawn } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { dirname, extname } from 'node:path'

import type { LaunchPathState, LaunchProfile, RunLaunchProfileResponse } from '@fanhe/shared'

/**
 * 本机代理的核心：把一条启动配置变成一个真实运行的进程。
 *
 * **这个模块是「代理形态」的落点，而形态必须一次定对** —— 它是 T3-03（管理界面）
 * 与 T4-03（代理并入 Electron 主进程）的共同前置。因此这里有两条硬性约束：
 *
 * 一是**不认识数据库、认证与 HTTP**。它的入参是已经取好的一条 `LaunchProfile`，
 * 出参是一次进程创建的结果。阶段三由 `apps/api` 挂一条路由把它暴露出去（实验版
 * 里本机服务就是本机代理），阶段四把这个文件原样 import 进外壳主进程、把路由换成
 * IPC 即可，核心逻辑一行不改。若在这里查库或读请求上下文，阶段四就得把它拆开重写。
 *
 * 二是**只能启动「配置」，不能启动「命令」**。接口只接受配置 id，路径与参数都来自
 * 数据库里用户自己存下的那一行。反过来做（接受路径与参数）就等于对外提供一个本机
 * 任意命令执行入口，任何拿到会话的人都能运行任意程序 —— 那不是功能，那是漏洞。
 *
 * 本模块不做审计、不写启动记录。启动历史由调用方在拿到结果之后自行落库（见
 * `src/launch/history.ts`）：进程创建这件事本身不应该依赖数据库可用，把它塞进这里
 * 会让「数据库抖一下」变成「客户端起不来」。
 */

/**
 * 去重窗口，单位毫秒。
 *
 * 同一条配置在这个窗口内被重复请求时，不再创建第二个进程，直接沿用上一次的结果。
 * 存在的理由是**连点**：界面上的「启动」按钮点下去到进程真正出现之间有几百毫秒的
 * 空档，用户在这个空档里会再点一次，而每次点击都是一次真实的进程创建 —— 结果是
 * 任务管理器里躺着五个微信。
 *
 * 窗口取 3 秒而不是更长：它要盖住的是「手抖连点」，不是「用户有意再来一次」。
 * 同一软件要开多个实例，本来就该配多条配置（多账号场景正是这么设计的），而不是
 * 靠重复点同一条 —— 后者在微信这类有互斥量的客户端上只会激活已有窗口，用户看到
 * 的是「点了没反应」，比明确失败更难理解。
 *
 * 这个值不做成环境变量。它不由部署环境决定，做成配置只会多出一处可以配错的地方，
 * 而配错的表现（点了没反应 / 起了五个进程）都不会指向配置。
 */
export const RUN_DEDUPE_WINDOW_MS = 3000

/** 去重缓存的条目上限。超过就清掉过期项，仍超则淘汰最早的一条。 */
const RECENT_RUNS_MAX = 256

/** 进程创建阶段的失败原因。与配置读写阶段的失败分开，因为它们的状态码不同。 */
export type LaunchRunFailureReason = 'executable_missing' | 'spawn_failed'

export type LaunchRunOutcome =
  { ok: true; data: RunLaunchProfileResponse } | { ok: false; reason: LaunchRunFailureReason }

/**
 * 结构化的最小日志接口。console 与 Fastify 的 logger 都满足它。
 *
 * 与 audit.ts 里 `AuditLogger` 同一个形状，理由也相同：本模块要在两种宿主里运行
 * （api 进程与将来的外壳主进程），不能依赖某一种日志实现。
 */
export type LaunchLogger = {
  error: (context: unknown, message?: string) => void
}

/** 交给 `spawn` 的三样东西。抽成纯函数是为了能在测试里直接断言它。 */
export type LaunchCommand = {
  command: string
  args: string[]
  cwd: string
}

/**
 * 检查一条路径时的等待上限，单位毫秒。
 *
 * 存在的理由是**网络共享**：路径可以是 `\\server\share\...`（共享包里明确支持这种
 * 写法），而那台机器关机或掉线时，`stat` 不会立刻失败，而是要等 SMB 的超时 —— 在
 * 某些环境里那是几十秒。没有这一层，一次列表状态检查就会被一条死掉的共享拖住，
 * 界面上的表现是「路径状态一直不出来」，而原因在另一个进程之外。
 *
 * 取 5 秒而不是更短：它要区分的是「慢但活着的共享」与「已经不可达的共享」。冷启动
 * 的网络共享首次访问确实可能花上一两秒，判成失效会让用户去改一条本来正确的配置。
 * 多条路径并发检查，不把等待上限逐条累加；数据库查询与事件循环调度仍会增加总耗时。
 * 超时只结束等待，不取消底层 stat：Node 的文件状态查询没有取消接口。
 */
export const PATH_INSPECT_TIMEOUT_MS = 5000

/**
 * 检查一条可执行文件路径现在能不能用。
 *
 * **这是「路径是否失效」的唯一判断点。** 启动前的复核与列表上的状态标记都走它，
 * 两者用同一条规则（存在且是文件）才有意义 —— 各写一份的话迟早出现「列表说没问题，
 * 点启动说找不到」这种自相矛盾的界面。
 *
 * 超时按 `missing` 处理。合并的理由见共享包 `LaunchPathState` 的注释：两者给用户的
 * 动作完全一样，而分开表达要在界面上多一种渲染分支，那个分支的文案与「路径失效」
 * 几乎无法区分。
 *
 * 用 `stat` 而不是 `access`：只有 `stat` 能区分「不存在」与「存在但是个目录」，而
 * 用户复制路径时选到文件夹是很常见的错误。
 */
export async function inspectExecutablePath(executablePath: string): Promise<LaunchPathState> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), PATH_INSPECT_TIMEOUT_MS)
  })

  try {
    // 两种落空都归到 null：stat 抛错（不存在、权限不足）与等待超时。
    const info = await Promise.race([stat(executablePath).catch(() => null), timeout])
    if (info === null || !info.isFile()) return 'missing'
    return 'ok'
  } finally {
    // 必须清掉。留着它会让一个已经返回的检查继续占着一个定时器，而进程退出前
    // 每个未清理的定时器都会让事件循环多转一圈。
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 把一条配置翻译成 `spawn` 的参数。
 *
 * 这里只有三行，但每一行都有取舍。
 *
 * **参数原样透传，不拼接、不转义。** `args` 从库里读出来就是数组，直接交给
 * `spawn` 的第二个参数。拼成命令行字符串再交给 shell 是最常见的写法，也是把
 * 参数里的 `&`、`|`、`"` 变成注入点的写法 —— 用户填的参数会变成 shell 语法。
 *
 * **`cwd` 取可执行文件所在目录。** 与双击快捷方式启动的行为对齐。不设的话子进程
 * 继承 api 进程的工作目录，也就是项目目录，于是「在工作台里启动一次客户端，项目
 * 目录里多出几个日志文件」这种事就会发生。目录不存在的情况不必单独处理：路径复核
 * 已经确认过可执行文件存在，它的父目录自然存在。
 */
export function buildLaunchCommand(profile: LaunchProfile): LaunchCommand {
  return {
    command: profile.executablePath,
    args: [...profile.args],
    cwd: dirname(profile.executablePath),
  }
}

/**
 * 启动外部客户端时，**从继承的环境里剔掉**的变量名（精确匹配）。
 *
 * ## 为什么必须剔（真机事故）
 *
 * 这几项不是「传给子进程的普通配置」，而是**会改变子进程运行方式、甚至注入代码**的开关：
 * 它们由「启动方自己的运行时」设置，对启动方有意义，对被启动的客户端毫无意义、只会出事。
 *
 * 事故现场：本机跑在 WorkBuddy 宿主里，宿主给进程注入了
 * `NODE_OPTIONS=--require=<宿主自己的 fs 劫持 shim>`。工作台照搬 `process.env` 去
 * `spawn` 客户端，而 **QQNT 本身就是 Electron 应用** —— Electron 主进程会执行
 * `NODE_OPTIONS` 里的 `--require`，于是 QQ 在自己进程里加载了宿主的 shim，启动即崩
 * （QQ 自带的错误报告，模块 `QQNT.dll`）。实测对照：同一 Electron 二进制，不带
 * `NODE_OPTIONS` 时 `shimLoaded=undefined`、带它时 `shimLoaded=true`。微信是原生程序、
 * 不读 `NODE_OPTIONS`，所以同一套启动机制下它没事 —— 这正是「只有部分客户端崩」的来源。
 *
 * ## 取舍：黑名单，不是白名单
 *
 * 没做成「只传一份最小环境」的白名单：客户端千奇百怪，`PATH` / `APPDATA` / `TEMP` /
 * `SystemRoot` 之类少一个都可能起不来，白名单要穷举的系统变量太多、漏一个就是「某些机器
 * 上点启动没反应」。黑名单只针对**已知会注入代码或改变运行模式**的那几项，改错的面小、
 * 且每一条都能说清它坏在哪。
 */
const LAUNCH_ENV_STRIP_NAMES: ReadonlySet<string> = new Set([
  // Node 的代码注入与模块解析入口：`--require` 会在子进程里执行任意脚本。
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
])

/** 前缀匹配的剔除项。`ELECTRON_*` 都是 Electron 自己的运行控制开关（`ELECTRON_RUN_AS_NODE` 等）。 */
const LAUNCH_ENV_STRIP_PREFIXES: readonly string[] = ['ELECTRON_']

/**
 * 该环境变量是否不该传给被启动的客户端（纯函数，便于单测）。
 */
export function shouldStripFromLaunchEnv(name: string): boolean {
  if (LAUNCH_ENV_STRIP_NAMES.has(name)) return true
  return LAUNCH_ENV_STRIP_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * 造一份「交给被启动客户端」的环境：继承启动方的环境，但剔掉会改变子进程运行方式的那些
 * （见 `LAUNCH_ENV_STRIP_NAMES` / `LAUNCH_ENV_STRIP_PREFIXES`）。
 *
 * 纯函数、入参可注入，便于单测在不依赖真实 `process.env` 的前提下断言剔了哪些、留了哪些。
 */
export function buildLaunchEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (shouldStripFromLaunchEnv(name)) continue
    env[name] = value
  }
  return env
}

/**
 * 已启动的配置。只记成功的结果。
 *
 * **失败不进缓存**，这一点是刻意的：用户看到「路径不存在」之后最自然的动作就是
 * 去改路径、然后立刻再点一次。若把失败也缓存下来，那个窗口内的重试会拿到同一条
 * 旧错误，用户会以为「改了没用」。失败路径也没有「起多个进程」的风险 —— 它压根
 * 没创建进程，缓存它换不来任何东西。
 */
const recentRuns = new Map<string, { at: number; data: RunLaunchProfileResponse }>()

function rememberRun(profileId: string, data: RunLaunchProfileResponse, at: number): void {
  if (recentRuns.size >= RECENT_RUNS_MAX) {
    for (const [id, entry] of recentRuns) {
      if (at - entry.at >= RUN_DEDUPE_WINDOW_MS) recentRuns.delete(id)
    }
    // 清完过期项仍然满，说明窗口内启动过的配置比上限还多。这时淘汰最早的一条，
    // 保证 Map 有硬上界 —— 无上界的缓存会变成一个慢性内存泄漏。
    if (recentRuns.size >= RECENT_RUNS_MAX) {
      const oldest = recentRuns.keys().next()
      if (!oldest.done) recentRuns.delete(oldest.value)
    }
  }
  recentRuns.set(profileId, { at, data })
}

/**
 * 启动一条配置。
 *
 * 顺序是「先复核路径、再创建进程」。复核不能省，也不能退回给配置创建时做：T3-01
 * 入库时只校验了路径的**形态**（是不是绝对路径），因为文件在不在是运行期的事 ——
 * 配置建好三个月后软件被卸载，那时只有真正要启动的这一刻才知道。少了这一步，
 * 失败会以 `ENOENT` 的形式出现，用户看到的是「启动失败」而不是「路径失效了，去改
 * 一下」。
 */
export async function runLaunchProfile(
  profile: LaunchProfile,
  logger: LaunchLogger = console,
): Promise<LaunchRunOutcome> {
  const now = Date.now()
  const recent = recentRuns.get(profile.id)
  if (recent !== undefined && now - recent.at < RUN_DEDUPE_WINDOW_MS) {
    return { ok: true, data: { ...recent.data, deduplicated: true } }
  }

  const outcome = await startProcess(profile, logger)
  if (outcome.ok) rememberRun(profile.id, outcome.data, now)
  return outcome
}

/**
 * 启动这一条时要不要让 Windows 隐藏控制台窗口。
 *
 * 两件事同时成立，所以判据只能按目标类型分：
 *   ① 目标是 `.exe`（GUI 客户端）时**不能隐藏**。隐藏启动标记会让部分客户端把主窗口
 *      创建成隐藏状态，`spawn` 照样返回成功，用户看到的是「点了没反应」；
 *   ② 目标是 `.cmd` / `.bat` / 脚本时**必须隐藏**。它们是控制台程序，不隐藏就会闪一个
 *      黑框 —— 0.1.4 之前一直是隐藏的，改成一律 `false` 等于把这个行为还回去。
 *
 * 判据刻意用扩展名而不是「猜它是不是 GUI」：扩展名是用户填在配置里的、可复核的事实，
 * 而「这个 exe 有没有窗口」要执行起来才知道。
 */
export function needsHiddenConsole(executablePath: string): boolean {
  return extname(executablePath).toLowerCase() !== '.exe'
}

async function startProcess(
  profile: LaunchProfile,
  logger: LaunchLogger,
): Promise<LaunchRunOutcome> {
  // 复核走的是与列表状态标记同一个函数，见 `inspectExecutablePath` 的注释。权限不足
  // 导致的失败在这里也会落到 executable_missing，可接受 —— 那种情况在本机自用的
  // 场景里几乎不出现，而把它单独分成一类会让失败原因表多出一项长期没人命中的分支。
  if ((await inspectExecutablePath(profile.executablePath)) === 'missing') {
    return { ok: false, reason: 'executable_missing' }
  }

  const { command, args, cwd } = buildLaunchCommand(profile)

  return await new Promise<LaunchRunOutcome>((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, {
        cwd,
        // 显式写出。Node 的默认值就是 false，但这一行是安全边界，不该靠默认值
        // 承担 —— 将来有人为了「支持通配符」把它改成 true，这里会先被看到。
        shell: false,
        // 控制台窗口的显隐按目标类型分：`.exe` 不能隐藏（部分 GUI 客户端会连主窗口
        // 一起藏起来，spawn 仍报成功），脚本类必须隐藏（否则闪黑框）。见
        // `needsHiddenConsole` 的注释。
        windowsHide: needsHiddenConsole(command),
        // 丢弃子进程的三路标准流。用管道的话，工作台退出后管道关闭，子进程再往
        // stdout 写就会拿到 EPIPE；而且没人读的管道写满之后会阻塞子进程本身。
        stdio: 'ignore',
        // 继承环境，但剔掉会改变子进程运行方式的变量（见 `buildLaunchEnv` 的注释：
        // 不剔的话，`NODE_OPTIONS` 会被 Electron 系的客户端执行，直接把它启动崩）。
        env: buildLaunchEnv(),
      })
    } catch (error) {
      logger.error({ err: error, profileId: profile.id }, '启动配置的进程创建调用失败')
      resolve({ ok: false, reason: 'spawn_failed' })
      return
    }

    /**
     * 等到 `spawn` 事件才算成功，而不是 `spawn()` 一返回就返回。
     *
     * `spawn()` 是同步返回的，它返回时进程还没创建。真正的失败（可执行格式不对、
     * 句柄耗尽）通过 `error` 事件异步到达。若不等待，接口会在进程根本没起来的情况下
     * 回一个「已启动」，用户看到成功提示却什么都没发生 —— 这种「报成功而没做事」
     * 比明确失败难查得多。
     *
     * `spawn` 事件是操作系统创建进程成功后触发的，正常在几毫秒内到达，不会拖慢接口。
     */
    child.once('spawn', () => {
      // unref 让子进程不再阻止父进程退出。少了它，工作台会一直等到微信关闭才能
      // 退出 —— 而这正是「工作台不是进程管理器」这条定位要避免的。
      child.unref()

      const pid = child.pid
      if (pid === undefined) {
        // 理论上到不了这里：spawn 事件触发时 pid 已经分配。留着是为了不把
        // 「pid 未知」硬编成一个数字混进响应里。
        resolve({ ok: false, reason: 'spawn_failed' })
        return
      }

      resolve({
        ok: true,
        data: {
          profileId: profile.id,
          pid,
          startedAt: new Date().toISOString(),
          deduplicated: false,
        },
      })
    })

    child.once('error', (error) => {
      // 走到这里说明进程没创建成功。错误码对排查有用（EACCES 是权限、EMFILE 是
      // 句柄耗尽），但它不适合直接给用户看，所以进日志、不进响应体。
      logger.error({ err: error, profileId: profile.id }, '启动配置的进程创建失败')
      resolve({ ok: false, reason: 'spawn_failed' })
    })
  })
}
