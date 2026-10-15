/**
 * 本机代理的外壳侧实现（T4-03）。
 *
 * ## 与 `apps/api/src/launch/agent.ts` 的关系
 *
 * **进程创建的核心逻辑没有搬过来，它在那边。** `apps/desktop` 通过 `paths.ts` 的
 * `apiLaunchModule()` 动态 `import` 那份文件，两处跑的是同一份代码。这比复制一份
 * 到 `apps/desktop/src/` 更好：复制之后那条「路径复核在前、创建在后」「等到
 * `spawn` 事件才算成功」「失败不进去重缓存」的逻辑就有了两个可以各自漂移的副本，
 * 而它们一旦漂移，现场表现是「从界面启动正常，从别处启动偶发失败」，极难定位。
 *
 * 代价是这个模块与 `apps/api` 之间有了一条**只在运行时**成立的依赖 ——
 * `import type` 看不出来，构建期也没有任何东西会检查那条路径存在。`paths.ts`
 * 因此在加载前显式检查并给出可读错误，而不是让 `import()` 抛一个指向
 * `node_modules` 的 `MODULE_NOT_FOUND`。
 *
 * ## 这个模块补的是 agent.ts 明确不做的两件事
 *
 * `agent.ts` 的入参是**已经取好的一条 `LaunchProfile`**，它信任调用方完成了取数与
 * 权限判定 —— 在 `apps/api` 里那是「按 userId 查库 + 权限中间件 + 回环来源判定」。
 * 外壳这条路上没有那些：一来配置是**渲染进程送过来的**，二来 IPC 没有 HTTP 那样
 * 的天然来源防线。所以这里必须补上：
 *
 * 1. **形态复核**（`inspectIncomingProfile`）。渲染进程里的任何脚本都能调这条 IPC，
 *    因此主进程**不能只信任传入对象的 `executablePath`**。它按共享包那份
 *    `isAbsoluteExecutablePath` 与 `LAUNCH_PROFILE_LIMITS` 重新校验一遍，形态不合
 *    直接拒绝。**这是「只能启动配置、不能启动命令」那条边界在外壳上的落点** ——
 *    少了它，IPC 就等于一个本机任意命令执行入口。
 * 2. **归一化**（`normalizeProfile`）。只取用得到的字段，丢掉额外属性，避免渲染
 *    进程往主进程塞一个带着别处数据的对象。
 *
 * ## 为什么不查库
 *
 * 外壳主进程不连数据库，这是 T4-01 定下的形态（见 9.41）。配置由渲染进程经现有
 * 的 `GET /api/launch/profiles` 取到再送进来 —— 在远程模式下这条路依然通（配置从
 * 远程 API 取，本机进程由本机外壳起），而外壳不必知道配置存在哪。
 */
import { join } from 'node:path'

import {
  isAbsoluteExecutablePath,
  LAUNCH_PROFILE_LIMITS,
  type LaunchPathState,
  type LaunchProfile,
  type RunLaunchProfileResponse,
} from '@fanhe/shared'

/**
 * `apps/api/src/launch/agent.ts` 的最小契约。
 *
 * **刻意写成结构类型而不是 `typeof import('apps/api/src/launch/agent')`。** 后者在
 * 构建期要求 tsc 能解析到那个路径，而 `apps/desktop` 既没有把 `@fanhe/api` 声明成
 * 依赖、工作区根也没有配路径别名 —— 真写上去会得到一条解析不了的 import
 * （且它只在类型位置出现，运行时一切正常，属于最难查的一类错误）。
 *
 * 代价是这份契约要手写，且与原函数有漂移的风险。**接口收窄到只取用得到的成员**，
 * 而 `runLaunchProfile` 的返回类型 `{ok:true, data: RunLaunchProfileResponse} |
 * {ok:false, reason: 'executable_missing' | 'spawn_failed'}` 是窄的：多出的成员不
 * 影响赋值，少掉的成员才会。所以这里只需要保证 `data` 与 `reason` 两个字段对得上，
 * 而那两处都直接引用了共享包的类型 —— 真正的漂移面只有 `LaunchRunOutcome` 那个
 * 判别式，而它在 `apps/api` 侧有 192 项集成测试钉着。
 *
 * T4-04 又加了 `inspectExecutablePath`：启动自检要查路径可用性，而**路径检查必须与
 * 启动时那次是同一个实现**。若外壳在这里另写一份 `fs.stat`，两份实现会对「目录算不算
 * 存在」「UNC 路径超时怎么办」给出不同答案，于是自检说「可用」而点击启动失败 ——
 * 而自检的全部价值就在于可信。
 */
export type LaunchAgentModule = {
  runLaunchProfile: (
    profile: LaunchProfile,
    logger: { error: (context: unknown, message?: string) => void },
  ) => Promise<
    | { ok: true; data: RunLaunchProfileResponse }
    | { ok: false; reason: 'executable_missing' | 'spawn_failed' }
  >
  /**
   * 检查一条路径当前能不能用。
   *
   * 刻意要求它是**这个模块上的方法**而不是一个自由函数：它必须与 `runLaunchProfile`
   * 来自同一份源码。外壳没有理由自己去 `stat`，而真去写了就会引入上面那种分歧。
   */
  inspectExecutablePath: (executablePath: string) => Promise<LaunchPathState>
}

/**
 * 复核失败的原因。
 *
 * `invalid_profile` 是**主进程新增**的一类，在 `apps/api` 侧不存在：那边在拿到这个
 * 对象之前，形态已经由入库时的校验与 schema 各把关一次了。外壳这边对象来自 IPC，
 * 校验是唯一一道关，所以要有一类专门表达「你送来的东西不像一条配置」。
 *
 * 与 agent.ts 的 `executable_missing` 分开：前者是「配置本身不对」，后者是「配置
 * 没问题但文件不在」。界面上要给的动作不一样 —— 前者不该让用户去改路径。
 */
export type ShellLaunchFailureReason = 'invalid_profile' | 'executable_missing' | 'spawn_failed'

export type ShellLaunchOutcome =
  | { ok: true; data: RunLaunchProfileResponse }
  | { ok: false; reason: ShellLaunchFailureReason; detail: string }

export type ShellLaunchLogger = {
  error: (context: unknown, message?: string) => void
}

/**
 * 复核一条从 IPC 送来的配置。
 *
 * **返回新对象而不是就地改** —— 入参来自 `structuredClone`，改它不会影响任何
 * 人，但返回新对象让「原始对象绝不被信任」这件事在代码形状上就看得出来。
 *
 * 逐字段检查的顺序按「最可能出错」排：先看 `executablePath`（用户自己填的，最容易
 * 写错），再看 `args`，最后看那些由服务端生成的字段（`id`、`createdAt`）。
 */
export function normalizeProfile(raw: unknown): LaunchProfile | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>

  const id = value['id']
  if (typeof id !== 'string' || id === '' || id.length > LAUNCH_PROFILE_LIMITS.NAME_MAX) return null

  const name = value['name']
  if (typeof name !== 'string' || name.length > LAUNCH_PROFILE_LIMITS.NAME_MAX) return null

  const executablePath = value['executablePath']
  if (typeof executablePath !== 'string') return null
  if (
    executablePath.length === 0 ||
    executablePath.length > LAUNCH_PROFILE_LIMITS.EXECUTABLE_PATH_MAX
  ) {
    return null
  }
  // 绝对路径是这一层的核心：相对路径在任何机器上都启动不了，而失败点会远到用户
  // 点击那一刻，且那时已经看不出是当初填错了。用共享包那个函数而不是自己写正则，
  // 是为了让形态判断只有一份实现 —— 网络共享（`\\server\share`）那种写法尤其
  // 容易在两份实现里跑偏。
  if (!isAbsoluteExecutablePath(executablePath)) return null

  const argsRaw = value['args']
  if (!Array.isArray(argsRaw)) return null
  if (argsRaw.length > LAUNCH_PROFILE_LIMITS.ARGS_MAX_COUNT) return null
  const args: string[] = []
  for (const item of argsRaw) {
    // 参数必须逐个是字符串。不做这个检查的话，一个含对象的数组会一路传到
    // `spawn`，而那里的类型断言拦不住运行期的实际内容。
    if (typeof item !== 'string') return null
    if (item.length > LAUNCH_PROFILE_LIMITS.ARG_MAX) return null
    args.push(item)
  }

  const icon = value['icon']
  if (icon !== null && typeof icon !== 'string') return null
  if (typeof icon === 'string' && icon.length > LAUNCH_PROFILE_LIMITS.ICON_MAX) return null

  const software = value['software']
  if (typeof software !== 'string' || software === '') return null

  const sortOrder = value['sortOrder']
  if (typeof sortOrder !== 'number' || !Number.isFinite(sortOrder)) return null

  const createdAt = value['createdAt']
  if (typeof createdAt !== 'string') return null
  const updatedAt = value['updatedAt']
  if (typeof updatedAt !== 'string') return null

  return { id, software, name, executablePath, args, icon, sortOrder, createdAt, updatedAt }
}

/**
 * 启动一条从 IPC 送来的配置。
 *
 * 形状与 `agent.ts` 的 `runLaunchProfile` 一致（先走去重与复核，再创建进程），
 * 但多了一步**主进程侧的形态复核**。
 */
export async function runShellLaunchProfile(
  raw: unknown,
  agentModule: LaunchAgentModule,
  logger: ShellLaunchLogger = console,
): Promise<ShellLaunchOutcome> {
  const profile = normalizeProfile(raw)
  if (profile === null) {
    logger.error({ raw: typeof raw }, '启动配置未通过主进程侧形态复核')
    return { ok: false, reason: 'invalid_profile', detail: '配置格式不合法' }
  }

  const outcome = await agentModule.runLaunchProfile(profile, logger)
  if (!outcome.ok) {
    // agent.ts 的两类失败原样往上带，detail 给一句能直接显示的话。它那边刻意不把
    // errno 之类进响应体（见它的注释），所以这里也不自己拼。
    const detail =
      outcome.reason === 'executable_missing'
        ? '路径失效，请在启动配置里重新指定可执行文件'
        : '进程创建失败，请检查路径与权限'
    return { ok: false, reason: outcome.reason, detail }
  }
  return { ok: true, data: outcome.data }
}

/**
 * 批量启动一组从 IPC 送来的配置。
 *
 * 每条独立走 `runShellLaunchProfile`，因此**单条失败不影响其余** —— 某条路径失效只落在
 * 自己那一项上，其余照常。用 `Promise.allSettled` 并发发起：各条的 3 秒去重按
 * `profile.id` 各算（见 `apps/api/src/launch/agent.ts` 的 `RUN_DEDUPE_WINDOW_MS`），
 * 不同配置互不干扰；批量接口**不把整批当一个去重单位**，否则连点两次批量会把第二次
 * 全判成 deduplicated，用户误以为「都已启动」。
 *
 * `agent_unavailable` 不在这里产生：本函数只在代理已加载时被调用。代理加载不出来时，
 * 主进程在 `launch:runMany` handler 里直接给每条报同一个 `agent_unavailable`，让界面
 * 去查工作区而不是逐条重配。
 */
export type LaunchRunManyItemResult = {
  profileId: string
  ok: boolean
  /** 成功时才有：子进程 id。 */
  pid?: number
  /** 失败时才有：机器可读码（invalid_profile / executable_missing / spawn_failed /
   *  agent_unavailable）。`agent_unavailable` 只由主进程在代理加载失败时给出，逐条同因。 */
  reason?: ShellLaunchFailureReason | 'agent_unavailable'
  /** 失败时才有：可展示文案。 */
  detail?: string
}

export type LaunchRunManyResult = {
  results: LaunchRunManyItemResult[]
  summary: { total: number; success: number; failed: number }
}

export async function runShellLaunchProfiles(
  raws: readonly unknown[],
  agentModule: LaunchAgentModule,
  logger: ShellLaunchLogger = console,
): Promise<LaunchRunManyResult> {
  if (raws.length === 0) {
    return { results: [], summary: { total: 0, success: 0, failed: 0 } }
  }
  // 并发发起、各自独立：一条的去重窗口或失败不会牵连其它条。
  const settled = await Promise.allSettled(
    raws.map((raw) => runShellLaunchProfile(raw, agentModule, logger)),
  )
  const results: LaunchRunManyItemResult[] = settled.map((settled, index) => {
    const raw = raws[index]
    const profileId = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : ''
    if (settled.status === 'rejected') {
      // `runShellLaunchProfile` 自身不该抛，但防御性地兜底成「进程创建失败」。
      return { profileId, ok: false, reason: 'spawn_failed', detail: String(settled.reason) }
    }
    const outcome = settled.value
    if (outcome.ok) {
      return { profileId, ok: true, pid: outcome.data.pid }
    }
    return { profileId, ok: false, reason: outcome.reason, detail: outcome.detail }
  })
  const success = results.filter((result) => result.ok).length
  return { results, summary: { total: results.length, success, failed: results.length - success } }
}

/**
 * 各软件在本机的已知安装相对路径（2.5）。
 *
 * 只列默认安装位置最常见的那一条（或几条）。注册表 / 自定义安装位置不在覆盖范围内 ——
 * 设计文档 §2.5 明确先不上注册表，用目录扫描覆盖绝大多数默认安装，注册表作为后续
 * 可选增强，避免为检测引入跨平台依赖污染本文件。
 *
 * 相对路径用正斜杠写，下方用 `node:path` 的 `join` 拼到候选根目录上，于是 Windows 上
 * 自动变成反斜杠、不影响可读。每条软件对应一组「根目录无关」的相对片段，根目录由
 * `%ProgramFiles%` / `%ProgramFiles(x86)%` / `%LOCALAPPDATA%` 提供。
 *
 * - wechat：`Tencent\WeChat\WeChat.exe`（微信默认装进 Program Files）。
 * - qq：`Tencent\QQ\Bin\QQ.exe` 为主，`Tencent\QQ\QQ.exe` 兜底不同版本布局。
 * - qianniu：旧名 `AliWangWang\AliWangWang.exe` 与现代 `aliim\aliim.exe` 两条都扫。
 * - custom：没有「已知位置」，它的路径完全由用户填，检测只能靠传入的 `extraPath`。
 */
const KNOWN_EXECUTABLE_RELATIVE_PATHS: Record<string, readonly string[]> = {
  wechat: ['Tencent/WeChat/WeChat.exe'],
  qq: ['Tencent/QQ/Bin/QQ.exe', 'Tencent/QQ/QQ.exe'],
  qianniu: ['AliWangWang/AliWangWang.exe', 'aliim/aliim.exe'],
  // 与未知 software 同处理：返回空数组，无已知候选。
  custom: [],
}

/**
 * 候选根目录的环境变量名（按优先级）。
 *
 * `%ProgramFiles%` 与 `%ProgramFiles(x86)%` 覆盖绝大多数 64 / 32 位默认安装；
 * `%LOCALAPPDATA%` 兜底一些装进用户目录的客户端（如微信的用户态安装）。
 */
const DETECT_ROOT_ENV_VARS = ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA'] as const

/**
 * 枚举某软件的已知可执行候选路径（纯函数，不做文件检查）。
 *
 * **入参与 `process.env` 解耦**：默认读 `process.env`，但显式传 `env` 让单测能在不碰
 * 真实系统的前提下断言枚举结果。返回的是绝对路径数组（根目录有效时）；根目录缺失时
 * 该根下不贡献任何候选，而不是塞一个「`undefined/...`」之类的坏路径。
 *
 * `custom` 与未知 software 一律返回空数组：它们没有「已知位置」，检测只能靠用户提供的
 * `extraPath`。这一条是「检测只回答配置问题、且只覆盖默认安装」在设计上的落点。
 */
export function knownExecutableCandidates(
  software: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const relatives = KNOWN_EXECUTABLE_RELATIVE_PATHS[software]
  if (relatives === undefined || relatives.length === 0) return []
  const roots = DETECT_ROOT_ENV_VARS.map((name) => env[name]).filter(
    (root): root is string => typeof root === 'string' && root !== '',
  )
  const paths: string[] = []
  for (const root of roots) {
    for (const relative of relatives) {
      paths.push(join(root, relative))
    }
  }
  return paths
}

/**
 * 一键检测的结果（核心类型）。
 *
 * `preferred` 是界面回填用的首选路径：若用户给了待校验的 `extraPath` 且它确实存在，
 * 它优先；否则取第一条命中的已知候选。`candidates` 是所有命中（经 `inspect` 复核存在）
 * 的可选路径，界面可据此给一个下拉让用户从多个安装位置里挑。两者都为空表示本机没找到。
 */
export type LaunchPathDetection = {
  /** 首选可执行路径；一个都没命中为 null。 */
  preferred: string | null
  /** 所有命中（经 inspect 复核存在）的候选路径，可空。 */
  candidates: string[]
}

/**
 * 按 `software` 扫本机已知安装位置、用 `inspect` 复核、返回首选命中 + 其余候选（2.5 核心）。
 *
 * **刻意做成纯函数 + 注入 `inspect`**：`inspectExecutablePath` 来自那个跨包加载的 api
 * agent 模块，外壳不在这里另写一份 `stat`（见 `paths.ts` / `main.ts` 的注释：自检与启动
 * 对「什么算合法路径」必须同一份实现，否则会出现「检测说在、点启动说不在」）。注入让
 * 它能在单测里被直接驱动，不依赖真实文件系统的存在。
 *
 * `extraPath` 是「用户已经填过、想顺带校验一下」的路径：它排在候选最前面，命中即成为
 * `preferred` —— 这样「保留用户上次填的、再帮我看看还有没有别的」这一体验成立。它必须
 * 是绝对路径，否则不进候选（相对路径在任何机器都启不动，不该被当成命中）。
 */
export async function detectLaunchPaths(
  software: string,
  options: {
    extraPath?: string
    inspect: (executablePath: string) => Promise<LaunchPathState>
    env?: Record<string, string | undefined>
  },
): Promise<LaunchPathDetection> {
  const extraPath = options.extraPath
  const ordered: string[] = []
  if (typeof extraPath === 'string' && extraPath !== '' && isAbsoluteExecutablePath(extraPath)) {
    // 用户已填的路径优先校验：它一旦存在就是首选，否则才退到已知候选。
    ordered.push(extraPath)
  }
  for (const candidate of knownExecutableCandidates(software, options.env)) {
    ordered.push(candidate)
  }

  // 去重：同一份路径可能同时是 extraPath 与某条已知候选，或不同根目录恰好同名。
  // 重复只会让用户在下拉里看到两个一模一样的选项，没有信息量。
  const seen = new Set<string>()
  const unique: string[] = []
  for (const path of ordered) {
    if (seen.has(path)) continue
    seen.add(path)
    unique.push(path)
  }

  if (unique.length === 0) return { preferred: null, candidates: [] }

  const states = await Promise.all(unique.map((path) => options.inspect(path)))
  const found: string[] = []
  unique.forEach((path, index) => {
    if (states[index] === 'ok') found.push(path)
  })
  return { preferred: found[0] ?? null, candidates: found }
}
