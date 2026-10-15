/**
 * 启动失败的「恢复出口」判定（纯函数，无依赖）。
 *
 * 把 `launchRunRecovery` 与 `LaunchRunError` 放在独立模块，是因为它要被单测直接加载，
 * 而 `lib/launch.ts` 依赖 `./api`（含 `import.meta.env`）与 `./session`，在 Node 测试里
 * 加载会牵出浏览器环境。这一份只认 `code`，不碰任何运行期环境，因而可独立单测。
 *
 * ## 为什么失败分两类
 *
 * 界面拿到启动失败时要给不同出口：「路径失效」（`executable_missing`）唯一的出路是
 * 让用户重新指定可执行文件，重试一万次也是同一条结果；其余失败（进程创建失败、网络
 * 中断、本机代理不可用）重来一次有意义。分界依据是**机器可读的 `code`**，不是文案 ——
 * 文案由各自的环境给出，调用方不该解析它。
 *
 * ## 三类来源共用同一份码域
 *
 * HTTP 失败由服务端给 `code`（`ApiError.code`）；桌面态经 IPC 启动失败由主进程给
 * `reason`（落在 `LaunchRunError.code`）；两者取值域一致（`executable_missing` /
 * `spawn_failed` / `invalid_profile` / `path_unavailable`），于是同一个 `launchRunRecovery`
 * 能处理两种来源的失败，界面不必写两条分支。这正是 2.1 要补的缺口：改之前
 * `launchRunRecovery` 只认 `ApiError`，桌面态路径失效会被误判成「可重试」，用户被引去
 * 反复点一个注定失败的按钮。
 */

/** 启动失败时界面该给哪个出口。 */
export type LaunchRunRecovery = 'relocate' | 'retry'

/**
 * 桌面态经 IPC 启动失败时抛出的错误。
 *
 * `code` 复刻 `ApiError.code`：reason 是主进程给的机器可读码，界面据此分流。把 IPC
 * 失败伪装成 `ApiError` 是多此一举 —— 它只多一个 `status` 字段，而那个字段在「本机
 * 进程创建」语境里没有意义。留一个最小、同码域的错误类型，让 `launchRunRecovery` 用
 * 同一个判据覆盖两种来源即可。
 */
export class LaunchRunError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'LaunchRunError'
    this.code = code
  }
}

/**
 * 决定界面该给哪个出口。
 *
 * 只认 `code`：凡是 `executable_missing` 归 `relocate`（去重新指定路径），其余归
 * `retry`（重试有意义）。接收 `{ code?: string }` 而非 `ApiError` / `LaunchRunError`
 * 的具体类型，是因为两者都只用到 `code` 这一个字段 —— 这样 HTTP 失败与桌面态失败
 * 走同一道判据，且这个函数保持纯净、可在 Node 里直接单测。
 */
export function launchRunRecovery(error: { code?: string }): LaunchRunRecovery {
  return error.code === 'executable_missing' ? 'relocate' : 'retry'
}

/**
 * 批量启动的聚合结果（纯结构，无依赖）。
 *
 * 桌面态由 `launch:runMany` IPC 返回、浏览器态由 `summarizeLaunchMany` 逐条聚合，两者
 * 形状一致，界面用同一套渲染逻辑。把类型放在这里是为了让 web 的单测能直接 load 这一
 * 份纯模块 —— `lib/launch.ts` 依赖 `./api`（含 `import.meta.env`）与 `./session`，在
 * Node 测试里加载会牵出浏览器环境，因此聚合与恢复都收敛到这个纯模块。
 */
export type LaunchRunManyItemResult = {
  profileId: string
  ok: boolean
  /** 成功时才有：子进程 id。 */
  pid?: number
  /** 失败时才有：机器可读码（executable_missing / spawn_failed / invalid_profile / agent_unavailable）。 */
  reason?: string
  /** 失败时才有：可展示文案。 */
  detail?: string
}

export type LaunchRunManyResult = {
  results: LaunchRunManyItemResult[]
  summary: { total: number; success: number; failed: number }
}

/**
 * 浏览器态逐条启动后的聚合（纯函数，便于单测）。
 *
 * `settled` 是 `Promise.allSettled(profiles.map(runLaunchProfile))` 的结果。每条成功取
 * `pid`；失败取 `code` 与 `message`。这里的 `code`/`message` 用**结构化**判定而非
 * `instanceof ApiError` —— 否则这个函数会依赖 `./api`，连带把 `import.meta.env` 牵进
 * 单测。失败来源无论是 HTTP 的 `ApiError` 还是桌面态的 `LaunchRunError`，都带 `code` 与
 * `message` 字段，结构判定足以覆盖，且不引入模块依赖。
 */
export function summarizeLaunchMany(
  profiles: readonly { id: string }[],
  settled: readonly PromiseSettledResult<{ pid: number }>[],
): LaunchRunManyResult {
  const results: LaunchRunManyItemResult[] = settled.map((entry, index) => {
    const profileId = profiles[index]?.id ?? ''
    if (entry.status === 'fulfilled') {
      return { profileId, ok: true, pid: entry.value.pid }
    }
    const error = entry.reason as { code?: unknown; message?: unknown } | null
    // 只有带 `code` 的失败（HTTP 的 ApiError / 桌面态的 LaunchRunError）才放行进 detail，
    // 避免把任意内部错误的原始 message 透给用户。其余回落到受控的「启动失败」。
    const code = typeof error?.code === 'string' ? error.code : 'spawn_failed'
    const detail =
      typeof error?.code === 'string' && typeof error?.message === 'string'
        ? error.message
        : '启动失败'
    return { profileId, ok: false, reason: code, detail }
  })
  const success = results.filter((item) => item.ok).length
  return { results, summary: { total: results.length, success, failed: results.length - success } }
}
