/**
 * 公共池归类：批量给「未分配」的客户判一个应归销售还是设计师。
 *
 * 用法（在 apps/api 下）：
 *   node_modules/.bin/tsx src/tools/customer-pool-classify.ts              # 写库
 *   node_modules/.bin/tsx src/tools/customer-pool-classify.ts --dry-run    # 只算不写
 *   node_modules/.bin/tsx src/tools/customer-pool-classify.ts --force      # 已复核的也重算
 *   node_modules/.bin/tsx src/tools/customer-pool-classify.ts --dir <路径>  # 换聊天库目录
 *
 * **必须在宿主机上跑。** 归类要读 Obsidian 群文件原文，而 compose 里的 api 容器
 * 没有任何卷挂载 —— 在容器内跑会扫到 0 个文件，退化成「只按阶段猜」，而置信度
 * 封顶 45 之后界面上看起来仍然有结论。这条与 `db:customer-sync` 是同一类限制。
 *
 * 退出码：目录读不到、或一条都没算成时退 1；其余退 0。**「0 条」不当作成功** ——
 * 它通常意味着公共池已经清空，也可能是路径写错，两者要靠输出里的 `source` 区分。
 */
import path from 'node:path'

import { prisma } from '../db/prisma.js'
import { classifyPool } from '../customer/pool.js'
import { SYSTEM_VIEWER } from '../customer/scope.js'
import { DEFAULT_CHAT_DIR } from '../customer/sync-args.js'

type Args = {
  chatDir: string
  dryRun: boolean
  force: boolean
}

function parseArgs(argv: readonly string[]): Args {
  let chatDir = process.env.FANHE_CHAT_DIR ?? DEFAULT_CHAT_DIR
  let dryRun = false
  let force = false

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') {
      dryRun = true
      continue
    }
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--dir') {
      const next = argv[index + 1]
      if (next === undefined || next.trim() === '') throw new Error('--dir 后面要跟一个路径')
      chatDir = path.resolve(next)
      index += 1
      continue
    }
    throw new Error(`认不出的参数：${arg}`)
  }

  return { chatDir, dryRun, force }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)

  const report = await classifyPool({
    // 命令行没有请求上下文，用系统观察者：全库范围、金额可见。
    viewer: SYSTEM_VIEWER,
    chatDir: args.chatDir,
    force: args.force,
    dryRun: args.dryRun,
  })

  console.log(
    args.dryRun ? '【干跑】' : '【写库】',
    `分析 ${report.analyzed} 位`,
    `| 跳过 ${report.skipped} 位（已复核）`,
    `| 失败 ${report.failed} 位`,
  )
  console.log(`建议：设计师 ${report.byRole.designer} 位，销售 ${report.byRole.sales} 位`)
  console.log(
    `证据来源：${report.source === 'archive' ? '群文件原文' : '仅库里汇总字段（读不到聊天库）'}`,
  )

  if (report.source === 'stored') {
    console.warn(
      `\n读不到聊天库：${args.chatDir}\n` +
        '所有结论的置信度已封顶 45，依据里会写「没有读到群文件」。' +
        '请在宿主机上核对路径，或换 --dir 重跑。',
    )
  }

  if (report.analyzed === 0 && report.skipped === 0) {
    throw new Error('公共池为空，或过滤条件把全部客户都排除了')
  }
}

main()
  .then(async () => {
    await prisma.$disconnect()
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    await prisma.$disconnect()
    process.exitCode = 1
  })
