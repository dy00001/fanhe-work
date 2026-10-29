/**
 * 每日同步：把 Obsidian「客户聊天记录库」的最新状态搬进客户平台。
 *
 * 与 `db:customer-import` 的分工：那个是**一次性**把历史预览灌进来（按 chatroom
 * 和订单编号判重，已存在就跳过）；这个是**每天**把已有客户的活动情况刷新一遍。
 * 两者共用 `customer/customers.ts` 的校验与派生，所以显示名不会一套一个样。
 *
 * 用法（在 apps/api 下）：
 *   node_modules/.bin/tsx src/tools/customer-sync.ts                # 写库
 *   node_modules/.bin/tsx src/tools/customer-sync.ts --dry-run      # 只算不写
 *   node_modules/.bin/tsx src/tools/customer-sync.ts --verbose      # 列出每个变化
 *   node_modules/.bin/tsx src/tools/customer-sync.ts --dir <路径>    # 换一个聊天库目录
 *
 * 经批处理（定时任务）启动时改用环境变量，因为 ws-run.ps1 会把以短横线开头的参数
 * 当成自己的参数吃掉：`FANHE_SYNC_DRY=1` / `FANHE_SYNC_VERBOSE=1` / `FANHE_CHAT_DIR`。
 * 细节见 `customer/sync-args.ts` 的文件头。
 *
 * **必须在宿主机上跑，不能在容器里跑。** compose 里 api 服务没有任何卷挂载，
 * 容器看不到 D 盘；容器内跑会扫出 0 个文件并且「成功退出」，这类失败不留痕迹。
 *
 * 退出码：目录读不到、或出现未入库的群却被判为 invalid 时退 1；其余（含「没有任何
 * 变化」）退 0。**「0 个文件」不当作成功** —— 那通常意味着路径写错或盘没挂上。
 */
import fs from 'node:fs'

import { prisma } from '../db/prisma.js'
import { parseSyncArgs } from '../customer/sync-args.js'
import { syncCustomersFromArchive, type SyncReport } from '../customer/sync.js'

const HELD_LABEL: Record<keyof SyncReport['stageHeld'], string> = {
  reviewed: '已复核，阶段不动',
  manual_authority: '人工/手工来源，阶段不动',
  board_authority: '看板来源，阶段不动',
  no_evidence: '没有阶段证据',
  unchanged: '仲裁结果与库里一致',
  empty_file: '空文件（抓取可能失败）',
}

const SKIP_LABEL: Record<SyncReport['skippedNew'][number]['reason'], string> = {
  excluded: '在排除清单里',
  unreadable: '读不出来',
  invalid: '字段不合法',
  empty_file: '空文件，不建',
}

function printReport(report: SyncReport, verbose: boolean): void {
  console.log(
    '扫描：',
    `${report.scanned} 个文件，其中群文件 ${report.groups} 个`,
    `| 命中客户 ${report.matched}`,
  )
  console.log(
    report.dryRun ? '将会：' : '结果：',
    `更新 ${report.updated}`,
    `无变化 ${report.unchanged}`,
    `新建 ${report.created}`,
    `阶段变更 ${report.stageChanged}`,
  )

  const held = Object.entries(report.stageHeld).filter(([, n]) => n > 0)
  if (held.length > 0) {
    console.log('阶段未跟：')
    for (const [reason, count] of held) {
      console.log(
        `  ${String(count).padStart(3)}  ${HELD_LABEL[reason as keyof typeof HELD_LABEL]}`,
      )
    }
  }

  if (report.createdNames.length > 0) {
    console.log(`新建的待复核客户 ${report.createdNames.length} 个：`)
    const shown = verbose ? report.createdNames : report.createdNames.slice(0, 20)
    for (const name of shown) console.log(`  ${name}`)
    if (!verbose && report.createdNames.length > shown.length) {
      console.log(`  …… 还有 ${report.createdNames.length - shown.length} 个，加 --verbose 看全`)
    }
  }

  if (report.skippedNew.length > 0) {
    console.log(`未入库的群 ${report.skippedNew.length} 个：`)
    for (const item of report.skippedNew) {
      console.log(`  ${item.file}  ${SKIP_LABEL[item.reason]}`)
    }
  }

  if (report.missingFile.length > 0) {
    console.log(`库里有、目录里找不到文件 ${report.missingFile.length} 个（不会删除）：`)
    for (const name of report.missingFile.slice(0, verbose ? undefined : 10))
      console.log(`  ${name}`)
    if (!verbose && report.missingFile.length > 10) console.log('  …… 加 --verbose 看全')
  }

  if (report.duplicateChatrooms.length > 0) {
    console.log(`同一个群出现在多个文件里 ${report.duplicateChatrooms.length} 组：`)
    for (const dup of report.duplicateChatrooms) {
      console.log(`  ${dup.chatroom}  ${dup.files.join(' + ')}`)
    }
  }

  if (report.failures.length > 0) {
    // `no_chatroom` 不是错误：同目录下还放着客户关注点总结、订单进度台账这类汇总文档。
    const real = report.failures.filter((f) => f.reason === 'unreadable')
    const summaries = report.failures.length - real.length
    if (summaries > 0) console.log(`跳过非客户群文档 ${summaries} 个（没有 @chatroom）。`)
    for (const failure of real) console.log(`  读不出来：${failure.file}`)
  }

  if (verbose && report.changes.length > 0) {
    console.log(`\n逐条变化 ${report.changes.length} 条：`)
    for (const change of report.changes) {
      const tail = change.stage === undefined ? '' : `  阶段 ${change.stage}`
      console.log(`  ${change.displayName.padEnd(20)} ${change.fields.join(', ')}${tail}`)
    }
  }
}

async function main(): Promise<void> {
  const args = parseSyncArgs(process.argv)

  if (!fs.existsSync(args.chatDir)) {
    throw new Error(`聊天记录库目录不存在：${args.chatDir}`)
  }
  if (!fs.existsSync(args.aliasesFile)) {
    // 不是致命错误：排除清单读不到时新群照建，但「展厅设计群」这类广告/内部群
    // 也会被自动建进库。要让它显眼，而不是悄悄退化成另一种行为。
    console.log(`注意：别名表不存在（${args.aliasesFile}），本轮没有排除清单。\n`)
  }

  console.log(`聊天库：${args.chatDir}`)
  console.log(args.dryRun ? '模式：干跑（只算不写）\n' : '模式：写库\n')

  const report = await syncCustomersFromArchive({
    chatDir: args.chatDir,
    aliasesFile: args.aliasesFile,
    dryRun: args.dryRun,
  })

  if (report.scanned === 0) {
    // 「读完了，一个文件都没有」几乎总是路径错或盘没挂上。按成功退出会让每日
    // 定时任务连续几周安静地什么都不做，而报表上一切正常。
    throw new Error(`目录里没有 .md 文件：${args.chatDir}`)
  }

  printReport(report, args.verbose)

  const invalid = report.skippedNew.filter((s) => s.reason === 'invalid').length
  const unreadable = report.failures.filter((f) => f.reason === 'unreadable').length
  if (invalid > 0) {
    process.exitCode = 1
    console.log(`\n有 ${invalid} 个群字段不合法，未入库。退出码 1。`)
  } else if (unreadable > 0) {
    console.log(`\n有 ${unreadable} 个文件读不出来，其余已同步。下次重跑会重试。`)
  } else if (args.dryRun) {
    console.log('\n干跑结束。去掉 --dry-run 即写入。')
  }
}

main()
  .catch((error: unknown) => {
    console.error('同步中止：', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
