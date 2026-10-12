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
import {
  isAbsoluteExecutablePath,
  LAUNCH_PROFILE_LIMITS,
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
 * 代价是这份契约要手写，且与原函数有漂移的风险。**接口收窄到只取用得到的两个成员**，
 * 而 `runLaunchProfile` 的返回类型 `{ok:true, data: RunLaunchProfileResponse} |
 * {ok:false, reason: 'executable_missing' | 'spawn_failed'}` 是窄的：多出的成员不
 * 影响赋值，少掉的成员才会。所以这里只需要保证 `data` 与 `reason` 两个字段对得上，
 * 而那两处都直接引用了共享包的类型 —— 真正的漂移面只有 `LaunchRunOutcome` 那个
 * 判别式，而它在 `apps/api` 侧有 192 项集成测试钉着。
 */
export type LaunchAgentModule = {
  runLaunchProfile: (
    profile: LaunchProfile,
    logger: { error: (context: unknown, message?: string) => void },
  ) => Promise<
    | { ok: true; data: RunLaunchProfileResponse }
    | { ok: false; reason: 'executable_missing' | 'spawn_failed' }
  >
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
