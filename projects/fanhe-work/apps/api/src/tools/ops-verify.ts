/**
 * 入库之后的落库校验：回答「这一天真的进库了吗，进去的数与采集端说的一致吗」。
 *
 * 为什么需要第三道校验：`verify-daily.mjs` 只管到导出契约为止。文件写对了、契约
 * 合法、窗口一致，仍然可能在入库这一步悄悄失真 —— 事务回滚、状态记错、行数对不上、
 * 维度只写了一部分。这些在库里都不会报错，看板只会显示「—」，和「这天没采」长得
 * 一模一样。
 *
 * 三道校验的分工（各守一段，最后一段必须真的读库）：
 *   verify-daily.mjs  采集产物 ↔ 导出契约
 *   ops-import.ts     契约 → 库（写入路径）
 *   本脚本            库里的实际状态 ↔ 契约声明的状态
 *
 * 用法（在 apps/api 下）：
 *   node_modules/.bin/tsx src/tools/ops-verify.ts --date 2026-10-19
 *   node_modules/.bin/tsx src/tools/ops-verify.ts --date 2026-10-19 --shop fanhe-main
 *   node_modules/.bin/tsx src/tools/ops-verify.ts --date 2026-10-19 --contract <契约 JSON>
 *
 * 给了 `--contract` 就逐项比对契约与库；不给就只校验库自身的自洽性。
 * 退出码：0 全部通过；1 有失败项；2 参数错误。
 */
import fs from 'node:fs'
import path from 'node:path'

import { prisma } from '../db/prisma.js'
import { fromDbDate, toDbDate } from '../ops/date.js'

type Contract = {
  shop?: { code?: string }
  window?: { from?: string; to?: string }
  daily?: { date?: string; payAmountFen?: number | null; visitors?: number | null }[]
  dimensions?: { type?: string; key?: string }[]
}

function option(argv: readonly string[], name: string): string | null {
  const index = argv.indexOf(`--${name}`)
  if (index === -1) return null
  const next = argv[index + 1]
  return next === undefined || next.startsWith('--') ? null : next
}

const failures: string[] = []
const warnings: string[] = []
const passes: string[] = []

function ok(message: string): void {
  passes.push(message)
}

function fail(message: string, hint?: string): void {
  failures.push(hint === undefined ? message : `${message} —— ${hint}`)
}

function warn(message: string): void {
  warnings.push(message)
}

async function main(): Promise<number> {
  const date = option(process.argv, 'date')
  if (date === null || toDbDate(date) === null) {
    console.error(
      '用法：tsx src/tools/ops-verify.ts --date YYYY-MM-DD [--shop 店铺码] [--contract 契约JSON]',
    )
    return 2
  }
  const statDate = toDbDate(date)
  if (statDate === null) return 2

  const contractPath = option(process.argv, 'contract')
  let contract: Contract | null = null
  if (contractPath !== null) {
    try {
      contract = JSON.parse(fs.readFileSync(path.resolve(contractPath), 'utf8')) as Contract
    } catch (error) {
      console.error(`契约文件读不出来：${error instanceof Error ? error.message : String(error)}`)
      return 2
    }
  }

  const shopCode = option(process.argv, 'shop') ?? contract?.shop?.code ?? 'fanhe-main'
  const shop = await prisma.ecomShop.findUnique({
    where: { code: shopCode },
    select: { id: true, code: true, name: true, lastCollectedAt: true },
  })
  if (shop === null) {
    fail(`店铺 ${shopCode} 不存在`, '先跑 pnpm db:ops-shops 建店铺，或确认 --shop 写对了')
    return report(date)
  }
  ok(`店铺 ${shop.code}（${shop.name}）`)

  /* ── 1. 运行记录 ──────────────────────────────────────────────────── */

  const run = await prisma.ecomCollectRun.findFirst({
    where: { shopId: shop.id, statTo: statDate },
    orderBy: { startedAt: 'desc' },
    select: {
      id: true,
      status: true,
      trigger: true,
      statFrom: true,
      statTo: true,
      dailyRows: true,
      dimensionRows: true,
      errorMessage: true,
      finishedAt: true,
      durationMs: true,
    },
  })

  if (run === null) {
    fail(`没有覆盖 ${date} 的采集批次`, '这一天的数据没进过库，先跑导入')
    return report(date)
  }

  const from = fromDbDate(run.statFrom)
  const to = fromDbDate(run.statTo)
  ok(`批次 ${run.id.slice(0, 8)}  状态 ${run.status}  窗口 ${from}~${to}  触发 ${run.trigger}`)

  if (run.status === 'failed') {
    fail(`批次状态是 failed（${run.errorMessage ?? '无错误信息'}）`, '库里没有这一天的有效数据')
  } else if (run.status === 'running') {
    /* 停在 running 说明写入中断且补写也失败了。没有过期判定，只能人工看。 */
    fail('批次停在 running，说明写入中断且补写 failed 也失败了', '查 API 日志，必要时手工改状态')
  } else if (run.status === 'partial') {
    warn(`批次状态是 partial（${run.errorMessage ?? '无错误信息'}），看板会有一部分「—」`)
  }

  /* ── 2. 逐日数据 ──────────────────────────────────────────────────── */

  const daily = await prisma.ecomDailyMetric.findUnique({
    where: { shopId_statDate: { shopId: shop.id, statDate } },
    select: { payAmountFen: true, visitors: true, payBuyers: true, collectedAt: true },
  })

  if (daily === null) {
    fail(`${date} 没有逐日行`, 'KPI 与趋势图都会是空的')
    if (run.dailyRows > 0) {
      /* 报成功但没写进去：这是「状态与库不一致」里最隐蔽的一种。 */
      fail('批次声明写了逐日数据，但库里查不到')
    }
  } else {
    /* 四个指标都可空：契约约定「缺块写 null，不补 0」。所以「缺」是一个合法值，
       打印时要说「缺」而不是 0 —— 显示成 0 元与「这天没成交」是两件事。 */
    const amountText =
      daily.payAmountFen === null ? '缺' : `${(daily.payAmountFen / 100).toFixed(2)} 元`
    ok(
      `逐日行：金额 ${amountText}  访客 ${daily.visitors ?? '缺'}  买家 ${daily.payBuyers ?? '缺'}`,
    )
    if (contract !== null) {
      const expected = contract.daily?.[0]
      if (expected !== undefined) {
        /*
         * 用 `!== undefined` 判「契约里有没有这一项」，不用 `typeof === 'number'`。
         * 后者会把契约里的 `null`（明确表示缺失）当成"没声明"，于是「契约 null、
         * 库里 0」这种最该报的失真恰好被跳过 —— 而 0 元与「没成交」是两件事。
         */
        const diffs: string[] = []
        if (expected.payAmountFen !== undefined && expected.payAmountFen !== daily.payAmountFen) {
          diffs.push(
            `金额：契约 ${expected.payAmountFen ?? '缺'} 分，库里 ${daily.payAmountFen ?? '缺'} 分`,
          )
        }
        if (expected.visitors !== undefined && expected.visitors !== daily.visitors) {
          diffs.push(`访客：契约 ${expected.visitors ?? '缺'}，库里 ${daily.visitors ?? '缺'}`)
        }
        if (diffs.length > 0) {
          fail(
            `逐日字段与契约不一致（${diffs.join('；')}）`,
            '入库路径改了数，或同一天被另一批数据覆盖过',
          )
        } else {
          ok('逐日字段与契约一致')
        }
      }
    }
  }

  /* ── 3. 维度快照 ──────────────────────────────────────────────────── */

  const dims = await prisma.ecomDimensionSnapshot.groupBy({
    by: ['dimType'],
    where: { shopId: shop.id, statFrom: statDate, statTo: statDate },
    _count: { _all: true },
  })
  const dimTotal = dims.reduce((sum, row) => sum + row._count._all, 0)

  if (run.dimensionRows > 0 && dimTotal === 0) {
    fail('批次声明写了维度数据，但库里该窗口一条都没有', '写入被回滚或窗口算错了')
  } else if (dimTotal === 0) {
    warn('该窗口没有维度快照，看板除 KPI 外都会是「—」')
  } else {
    const summary = dims
      .map((row) => `${row.dimType} ${row._count._all}`)
      .sort()
      .join(' / ')
    ok(`维度快照 ${dimTotal} 行（${summary}）`)
    if (dimTotal !== run.dimensionRows) {
      /* 两者不必相等：同窗口重跑会 upsert 同一批键，行数不增；而「本次没上报的
         类型保留旧行」这条修复也会让库里比批次多。差异只提示，不判失败。 */
      warn(
        `批次记了 ${run.dimensionRows} 行维度，库里该窗口有 ${dimTotal} 行（差异属正常，仅提示）`,
      )
    }
  }

  if (contract !== null && Array.isArray(contract.dimensions)) {
    const expectedKeys = new Set(
      contract.dimensions
        .filter((row) => typeof row.key === 'string')
        .map((row) => `${row.type ?? ''}:${row.key ?? ''}`),
    )
    if (expectedKeys.size > 0) {
      const rows = await prisma.ecomDimensionSnapshot.findMany({
        where: { shopId: shop.id, statFrom: statDate, statTo: statDate },
        select: { dimType: true, dimKey: true },
      })
      const actual = new Set(rows.map((row) => `${row.dimType}:${row.dimKey}`))
      const missing = [...expectedKeys].filter((key) => !actual.has(key))
      if (missing.length > 0) {
        fail(
          `契约里有 ${missing.length} 个维度键在库里找不到（例：${missing.slice(0, 3).join('、')}）`,
          '入库丢了行',
        )
      } else {
        ok(`契约里的 ${expectedKeys.size} 个维度键全部在库`)
      }
    }
  }

  /* ── 4. 采集时间 ──────────────────────────────────────────────────── */

  if (shop.lastCollectedAt === null) {
    fail('店铺的 lastCollectedAt 为空', '界面会显示「待接入」，尽管数据已经在库里')
  } else {
    const lagMinutes = Math.round((Date.now() - shop.lastCollectedAt.getTime()) / 60000)
    ok(`lastCollectedAt ${shop.lastCollectedAt.toISOString()}（${lagMinutes} 分钟前）`)
    if (lagMinutes > 60 * 36) {
      warn(`采集时间距今 ${Math.round(lagMinutes / 60)} 小时，界面会显示「数据偏旧」`)
    }
  }

  return report(date)
}

function report(date: string): number {
  console.log(`落库校验  业务日 ${date}`)
  console.log('')
  for (const line of passes) console.log(`  ok    ${line}`)
  for (const line of warnings) console.log(`  警告  ${line}`)
  for (const line of failures) console.log(`  失败  ${line}`)
  console.log('')
  console.log(`  合计 通过 ${passes.length} / 警告 ${warnings.length} / 失败 ${failures.length}`)
  return failures.length > 0 ? 1 : 0
}

main()
  .then(async (code) => {
    await prisma.$disconnect()
    process.exit(code)
  })
  .catch(async (error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error))
    await prisma.$disconnect()
    process.exit(1)
  })
