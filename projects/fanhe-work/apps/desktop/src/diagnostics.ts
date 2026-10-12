/**
 * 启动自检（T4-04）。
 *
 * ## 解决的是哪个真实问题
 *
 * 换了机器、插了 U 盘、搬了家之后，启动配置里那些**绝对路径**大概率已经失效 ——
 * 软件装在另一个位置、共享挂载不上、目录改名了。这类失效有一个共同点：
 * **点「启动」之前毫无征兆，点了才失败**，而失败现场只有一句「路径失效」。
 *
 * 自检要把这件事从「点击后才知」搬到「打开外壳就知道」，并且**说清该做什么**。
 * 因此这个模块的重点不是「检查」，而是**给每类失效配一句能照着做的引导** ——
 * 一份说「有问题」但不说「怎么办」的检查，界面上就没法用。
 *
 * ## 三类原因必须分开
 *
 * 沿用 T4-03 的那条判断（见 `agent.ts` 的 `ShellLaunchFailureReason`）：
 *
 * - `agent_unavailable` —— **代理本身**不可用（工作区不完整、源码缺失）。这时一条
 *   配置都验不了，于是整份报告都是它，且引导是「检查工作区」而不是「改路径」。
 * - `invalid_profile` —— 送来的东西**不像一条配置**（形态复核没过）。引导是「这条
 *   配置有问题，请重新编辑」，**绝不该让用户去改路径** —— 路径根本没被看过。
 * - `path_unavailable` —— 配置没问题，但**文件不在**。引导是去确认那个路径，必要时
 *   重新指定。
 *
 * 合成一类看起来省事，代价是其中两类的引导文案必然有一份是错的，而用户分辨不出来。
 *
 * ## 为什么检查逻辑不在这里实现
 *
 * **路径检查必须用 `apps/api/src/launch/agent.ts` 的 `inspectExecutablePath`**，
 * 也就是启动时用的那一个。自检说「可用」而点击却失败，是这类功能最坏的失效 ——
 * 它会让用户开始不信任自检，进而不再看它。
 *
 * 汇总的口径也刻意与 `apps/api/src/launch/status.ts` 的 `listProfileStatuses` 一致：
 * **索引取不到时兜底按 `missing` 处理**，因为让用户去确认路径，好过让他点了才收到
 * 失败（同一个理由，同一个方向）。
 *
 * ## 不查库
 *
 * 配置由渲染进程经 `GET /api/launch/profiles` 取来后送进来，外壳不连数据库
 * （T4-01 定下的形态）。api 侧的 `listProfileStatuses` 要 `userId` 且走两次分组
 * 查询查启动记录，**不能也不该**在这里复用 —— 复用了外壳就得变成一个连库的服务。
 * 可复用的只有 `inspectExecutablePath` 本身。
 *
 * ## 为什么形态复核是注入的
 *
 * `normalizeProfile` 由调用方传进来，而不是在这里 `import`。
 *
 * 起因是个具体问题：`apps/desktop` **刻意产出 CommonJS**（保住沙箱化预加载，见
 * `tsconfig.json`），于是模块间的相对 import 必须写 `.js` 后缀 —— 那是产物里的文件名。
 * 但单测走 Node 的类型剥离、直接加载 `src/*.ts`，那里**没有 `.js` 文件**，于是单跑
 * 这一层就会 `ERR_MODULE_NOT_FOUND`（指向 `src/agent.js`）。这是本包第一次出现模块间
 * import 撞上双路径，`main.ts` 的 import 只在构建产物里跑过、从没被单测加载。
 *
 * 与其为这个模块配一套「.js 优先、.ts 兜底」的条件导出（那是每个模块都要背上的
 * 复杂度），不如让**依赖由调用方给**。附带的好处是测试能直接断言「注入的复核函数被
 * 调用了几次」，而这件事用真实实现反而难验。
 */
import type { LaunchPathState, LaunchProfile } from '@fanhe/shared'

/**
 * 自检发现的问题。
 *
 * `profileId` 与 `name` 在形态复核失败时可能是空串 —— 那条对象压根不是一条配置，
 * 它的 `id` 不可信。**这时界面该按「位置」而不是按名字指认它**（第几条），而不是
 * 拿一个空名字去列表里找，找不到会让用户以为自检在说别的配置。
 */
export type LaunchDiagnostic = {
  /** 该配置在传入列表中的下标。形态复核失败时它是唯一可靠的指认依据。 */
  index: number
  profileId: string
  name: string
  executablePath: string
  reason: LaunchDiagnosticReason
  /** 一句能直接显示、且带上下文的引导。 */
  detail: string
}

export type LaunchDiagnosticReason = 'agent_unavailable' | 'invalid_profile' | 'path_unavailable'

export type LaunchDiagnosticsReport = {
  /** 代理本身能不能用。为false 时 `diagnostics` 一定只有一条 `agent_unavailable`。 */
  agentAvailable: boolean
  /** 收到的配置条数。 */
  total: number
  /** 路径可用、无需处理的条数。 */
  okCount: number
  diagnostics: LaunchDiagnostic[]
}

/** 自检需要的最小形状。两个函数都必填，理由见文件头。 */
export type LaunchDiagnosticsInput = {
  /** 原始对象数组，通常是界面从 `GET /api/launch/profiles` 取到的那份。 */
  profiles: unknown
  /**
   * 形态复核。**必填而不是在本模块里 `import`**（`.js` 后缀与类型剥离的冲突，见文件
   * 头）。实践中由 `main.ts` 传 `normalizeProfile`，因此用的是同一份实现 —— 自检与
   * 启动对「什么算合法配置」的判断不会分叉。
   */
  normalize: (raw: unknown) => LaunchProfile | null
  /**
   * 单条路径检查。同样必填，实践中传 `agentModule.inspectExecutablePath`。
   *
   * 用注入换来的是**单测不必真的 stat**，而 `PATH_INSPECT_TIMEOUT_MS` 是 5 秒，
   * 不注掉就没有任何单测愿意等它 —— 超时那条路径因此也能被测到。
   */
  inspect: (executablePath: string) => Promise<LaunchPathState>
}

/**
 * 按原因给出引导文案。
 *
 * **抽成纯函数是因为这三句话是最需要被审的东西** —— 它们会被用户看到，而「提示该做
 * 什么」写错了比不写更糟。单独抽出来便于单测逐条钉住，也便于日后改一处而不是散在
 * 组件里各写一遍。
 */
function guidanceFor(
  reason: LaunchDiagnosticReason,
  context: { index: number; name: string; executablePath: string },
): string {
  const label = context.name === '' ? `第 ${context.index + 1} 条配置` : `「${context.name}」`
  switch (reason) {
    case 'agent_unavailable':
      return '本机代理不可用，无法检查启动配置。请确认工作区完整（.ws-root 与 apps/api/src 均在）。'
    case 'invalid_profile':
      return `${label}的字段不完整或格式不正确，无法启动。请重新编辑这条配置。`
    case 'path_unavailable':
      return (
        `${label}指向的可执行文件不存在：${context.executablePath}。` +
        '若软件换了位置请重新指定；若指向网络共享，请确认那台机器在线。'
      )
  }
}

/**
 * 跑一遍启动自检。
 *
 * **不抛。** 自检是给人看的引导，凡是它自己出错的地方都要变成一条可显示的诊断 ——
 * 一个「自检崩了」的界面比一个「检查失败」的界面更没用，而用户无从区分两者。
 * 因此内部对每条配置单独兜底，单条出问题只让那一条变成诊断。
 */
export async function checkLaunchDiagnostics({
  profiles,
  normalize,
  inspect,
}: LaunchDiagnosticsInput): Promise<LaunchDiagnosticsReport> {
  const list = Array.isArray(profiles) ? profiles : []
  const total = list.length

  // 空配置不是问题：一条都没有时自检该说「没有要检查的」，而不是报一条失败。
  // 放在最前面返回，省掉一次无意义的模块能力检查。
  if (total === 0) {
    return { agentAvailable: true, total: 0, okCount: 0, diagnostics: [] }
  }

  const diagnostics: LaunchDiagnostic[] = []

  // 第一趟只做形态复核，把通过的挑出来。**复核是纯计算，不需要并发。**
  const accepted: { index: number; profile: LaunchProfile }[] = []
  for (const [index, raw] of list.entries()) {
    const profile = normalize(raw)
    if (profile === null) {
      // 形态没过就**不查路径**：那条 `executablePath` 本身不可信（可能是相对路径、
      // 空串，或者根本不是字符串），拿它去 stat 得到的结论没有意义，还会白等一次
      // 网络共享的超时。理由因此必须是「配置有问题」而不是「路径不在」。
      const name = readStringField(raw, 'name')
      diagnostics.push({
        index,
        profileId: '',
        name,
        executablePath: readStringField(raw, 'executablePath'),
        reason: 'invalid_profile',
        detail: guidanceFor('invalid_profile', { index, name, executablePath: '' }),
      })
      continue
    }
    accepted.push({ index, profile })
  }

  if (accepted.length === 0) {
    const okCount = total - diagnostics.length
    return { agentAvailable: true, total, okCount, diagnostics }
  }

  // 第二趟**并发**查路径，与 api 侧 `listProfileStatuses` 同一口径（那里明确写了
  // 「串起来等于白等那几秒」）。
  //
  // **为什么这条在这里更要紧**：路径检查最坏要等满 `PATH_INSPECT_TIMEOUT_MS`（5 秒），
  // 而失效配置的典型成因正是指向网络共享（`\\server\share`）—— 那台机器关机时 stat
  // 不会立刻失败。逐条 await 的话，10 条指向同一台关机机器的配置就是 50 秒，而自检
  // 恰恰是那种「用户已经等着了」的场合。并发之后总时长与配置条数无关。
  const states = await Promise.all(
    accepted.map(async ({ profile }) => {
      // 单条检查失败（stat 抛错、agent 侧异常）不得中断整轮 —— 一条查不了不代表其余
      // 查不了。按 `missing` 处理，与 api 侧 `listProfileStatuses` 的兜底同一方向。
      try {
        return await inspect(profile.executablePath)
      } catch {
        return 'missing' as const
      }
    }),
  )

  accepted.forEach(({ index, profile }, position) => {
    const state = states[position]
    // **只认 `ok` 为可用，其余一律按不可用。** 不写成 `state !== 'missing'` ——
    // 那样的话一个没预料到的值（将来 agent 换了取值、或者包装层串了类型）会被
    // 当成「可用」放过去，于是自检说没问题而点击启动失败。
    //
    // 方向是刻意选的：误报不可用，用户去确认一下路径，代价很小；误报可用，用户点了
    // 才收到失败，而且会开始不信任自检 —— 那比自检坏掉更糟，因为没人会去看它了。
    if (state === 'ok') return
    diagnostics.push({
      index,
      profileId: profile.id,
      name: profile.name,
      executablePath: profile.executablePath,
      reason: 'path_unavailable',
      detail: guidanceFor('path_unavailable', {
        index,
        name: profile.name,
        executablePath: profile.executablePath,
      }),
    })
  })

  // 按配置在列表里的位置排序，让界面显示的顺序与用户配置的一致。
  // 不排也能显示，但用户会看到「第 3 条的坏配置」排在「第 2 条的坏配置」前面，
  // 而列表是按 sortOrder / 名称排的 —— 两套顺序叠在一起会让人以为漏了哪一条。
  diagnostics.sort((left, right) => left.index - right.index)

  const okCount = total - diagnostics.length
  return { agentAvailable: true, total, okCount, diagnostics }
}

/**
 * 代理不可用时的那份报告。
 *
 * **与 `checkLaunchDiagnostics` 分开而不是在里面抛/返回null**，是为了让「代理不可用」
 * 这件事在类型上就是一份报告 —— 它是自检的一个**结论**，不是自检没能跑起来。界面因此
 * 不必区分「检查失败」与「没检查成」。
 */
export function agentUnavailableReport(detail: string): LaunchDiagnosticsReport {
  return {
    agentAvailable: false,
    total: 0,
    okCount: 0,
    diagnostics: [
      {
        index: 0,
        profileId: '',
        name: '',
        executablePath: '',
        reason: 'agent_unavailable',
        detail: `${guidanceFor('agent_unavailable', { index: 0, name: '', executablePath: '' })}（${detail}）`,
      },
    ],
  }
}

/**
 * 从一个不可信对象里取字符串字段，取不到返回空串。
 *
 * **只用于「不可信」的场景**：形态复核失败时那条对象什么都可能不是，直接
 * `raw.name` 在 `null` 上会抛，而这里的用途恰恰是给那种情况生成提示。
 */
function readStringField(raw: unknown, field: string): string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return ''
  const value = (raw as Record<string, unknown>)[field]
  return typeof value === 'string' ? value : ''
}
