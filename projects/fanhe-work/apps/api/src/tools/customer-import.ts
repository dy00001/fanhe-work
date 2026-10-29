/**
 * 把 `tools/crm/dryrun.mjs` 的预览 JSON 灌进客户平台三张表。
 *
 * 与 `db:ops-import` 同一类工具：绕过 HTTP 直接调服务层，因为导入是一次性动作。
 * 校验与派生全部复用 `customer/customers.ts`，保证「导入进来的行」与「人工录入的行」
 * 算出同一份显示名、同一套十四环模板。
 *
 * 用法（在 apps/api 下）：
 *   node_modules/.bin/tsx src/tools/customer-import.ts                # 写库
 *   node_modules/.bin/tsx src/tools/customer-import.ts --dry-run      # 只校验
 *   node_modules/.bin/tsx src/tools/customer-import.ts --file <路径>   # 换一份文件
 *
 * 幂等：客户按 `chatroom`、订单按编号判重，已存在的跳过。中断后直接重跑，不必先清库。
 *
 * 退出码：有失败项退 1，全部成功（含「全部跳过」）退 0。
 */
import fs from 'node:fs'
import path from 'node:path'

import { prisma } from '../db/prisma.js'
import { importPreview, type PreviewFile } from '../customer/import.js'

const DEFAULT_RELATIVE = path.join('..', '..', 'data', 'customer-import-preview.json')

type Args = { file: string; dryRun: boolean; verbose: boolean }

function parseArgs(argv: readonly string[]): Args {
  let file = path.resolve(process.cwd(), DEFAULT_RELATIVE)
  let dryRun = false
  let verbose = false
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
    if (arg === '--file') {
      const next = argv[i + 1]
      if (next === undefined || next.trim() === '') {
        throw new Error('--file 后面要跟一个路径')
      }
      file = path.resolve(next)
      i += 1
      continue
    }
    throw new Error(`认不出的参数：${arg}`)
  }
  return { file, dryRun, verbose }
}

/**
 * 只挡「这根本不是预览文件」。
 *
 * 字段级的校验在服务层：`normalizeCustomerInput` 逐条判真名长度、地区、阶段，
 * 订单金额判非负整数。这里若再写一遍，两处规则迟早不一致，而不一致时的表现是
 * 「文件能读进来，但 53 条全部 invalid」，看不出到底是谁在拒绝。
 */
function readPreview(file: string): PreviewFile {
  if (!fs.existsSync(file)) throw new Error(`找不到文件：${file}`)
  const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error(`${file} 不是一个 JSON 对象`)
  const candidate = parsed as Partial<PreviewFile>
  if (!Array.isArray(candidate.customers)) throw new Error(`${file} 缺少 customers 数组`)
  if (!Array.isArray(candidate.orders)) throw new Error(`${file} 缺少 orders 数组`)
  return candidate as PreviewFile
}

function printReport(report: Awaited<ReturnType<typeof importPreview>>, verbose: boolean): void {
  const { customers, orders, issues } = report
  console.log(
    '客户：',
    `新建 ${customers.created}`,
    `跳过 ${customers.skipped}`,
    `连复购 ${customers.linked}`,
    `失败 ${customers.failed}`,
  )
  console.log(
    '订单：',
    `新建 ${orders.created}`,
    `跳过 ${orders.skipped}`,
    `失败 ${orders.failed}`,
    `环节行 ${orders.steps}`,
  )

  if (issues.length === 0) {
    console.log('没有失败项。')
    return
  }

  console.log(`\n失败项 ${issues.length} 条：`)
  const shown = verbose ? issues : issues.slice(0, 20)
  for (const issue of shown) console.log(`  ${issue.key}  ${issue.reason}`)
  if (!verbose && issues.length > shown.length) {
    console.log(`  …… 还有 ${issues.length - shown.length} 条，加 --verbose 看全`)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const preview = readPreview(args.file)

  console.log(`文件：${args.file}`)
  console.log(`内容：客户 ${preview.customers.length} 条，订单 ${preview.orders.length} 条`)
  console.log(args.dryRun ? '模式：干跑（只校验，不写库）\n' : '模式：写库\n')

  const report = await importPreview(preview, { dryRun: args.dryRun })
  printReport(report, args.verbose)

  const failed = report.customers.failed + report.orders.failed
  if (failed > 0) {
    process.exitCode = 1
    console.log(`\n有 ${failed} 项失败，退出码 1。修完数据可直接重跑（幂等）。`)
  } else if (args.dryRun) {
    console.log('\n干跑通过。去掉 --dry-run 即写入。')
  }
}

main()
  .catch((error: unknown) => {
    console.error('导入中止：', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
