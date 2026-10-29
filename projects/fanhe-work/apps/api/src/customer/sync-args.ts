/**
 * 同步 CLI 的参数解析。
 *
 * 单独成文件而不是留在 `tools/customer-sync.ts` 里，因为那里 `main()` 会在
 * import 时立刻执行，测不了。这个模块只做字符串到配置的映射，纯函数。
 *
 * 为什么命令行之外还要读环境变量
 * ------------------------------
 * 定时任务是经 `tools\crm\sync-daily.cmd` 启动的，而那个脚本必须走
 * `infra\portable\ws-run.cmd` 拿 pnpm 与 node 的路径（裸跑 pnpm 会
 * ERR_PNPM_UNEXPECTED_STORE）。ws-run.cmd 把参数原样交给 ws-run.ps1，后者是
 * `[CmdletBinding()]` 脚本 —— PowerShell 会把任何以短横线开头的令牌当作**它自己**
 * 的参数名去绑定：
 *
 *   `--verbose` 绑到 -Verbose，日志里冒出几十行 "VERBOSE: Exporting function ..."
 *   `--dry-run` 绑不上又没有剩余参数接收，静默消失
 *   单独一个 `--` 直接报 "parameter name '' is ambiguous"
 *
 * 也就是说：`sync-daily.cmd --dry-run` 曾经**照样写库**。命令行参数只对直接调
 * tsx 的场合可靠，批处理那条路必须走环境变量。
 */

import path from 'node:path'

/** 默认指向阿阳机器上的 Obsidian 库；换机用 `--dir` / `FANHE_CHAT_DIR` 覆盖。 */
export const DEFAULT_CHAT_DIR = 'D:\\Obsidian\\个人知识库\\客户聊天记录库'

/** 别名表只在 `data/` 下，已被 .gitignore 排除（含真实群名与客户名）。 */
const DEFAULT_RELATIVE_ALIASES = path.join('..', '..', 'data', 'customer-aliases.json')

export type SyncArgs = {
  chatDir: string
  aliasesFile: string
  dryRun: boolean
  verbose: boolean
}

/** `1` / `true` / `yes` 都算开；空值和 `0` 算关。 */
function envFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

/**
 * 命令行优先、环境变量兜底。
 *
 * 参数不合法直接抛错而不是忽略：这条链路会写数据库，把 `--dryrun`（少一个横线）
 * 当成「没给参数」意味着一次本以为安全的试跑变成了真写。
 */
export function parseSyncArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): SyncArgs {
  let chatDir = env.FANHE_CHAT_DIR?.trim() || DEFAULT_CHAT_DIR
  let aliasesFile = path.resolve(cwd, DEFAULT_RELATIVE_ALIASES)
  let dryRun = envFlag(env, 'FANHE_SYNC_DRY')
  let verbose = envFlag(env, 'FANHE_SYNC_VERBOSE')

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--verbose') {
      verbose = true
      continue
    }
    if (arg === '--dir') {
      const next = argv[i + 1]
      if (next === undefined || next.trim() === '') throw new Error('--dir 后面要跟一个路径')
      chatDir = path.resolve(cwd, next)
      i += 1
      continue
    }
    if (arg === '--aliases') {
      const next = argv[i + 1]
      if (next === undefined || next.trim() === '') throw new Error('--aliases 后面要跟一个路径')
      aliasesFile = path.resolve(cwd, next)
      i += 1
      continue
    }
    throw new Error(`认不出的参数：${arg}`)
  }

  return { chatDir, aliasesFile, dryRun, verbose }
}
