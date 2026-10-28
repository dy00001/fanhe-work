#!/usr/bin/env node
/**
 * 每日叠加。
 *
 * 每天跑一次，检查最近几天里哪些天还没有数据，把缺的补上，然后导出入库。
 * 设计目标只有一个：漏了能自己补回来。
 *
 * 为什么不做「固定采昨天」：插件会断、机器会关机、人会有事。固定采昨天的话，
 * 某天没跑成就永久缺那一天，而且没人会发现。改成「回看 N 天找缺口」之后，
 * 今天没跑，明天那次会顺带把昨天补上。
 *
 * 为什么默认回看 7 天：生意参谋的日维度数据保留期足够长，7 天能覆盖一个长假
 * 的断档，又不会在首次运行时把几十天一次跑完（那要几个小时）。
 *
 * 用法
 *   node scripts/daily-catchup.mjs                 回看 7 天
 *   node scripts/daily-catchup.mjs --days 3        只回看 3 天
 *   node scripts/daily-catchup.mjs --dry-run       只报告缺口，不采集
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const HERE = import.meta.dirname
const REPO = path.resolve(HERE, '..', '..', '..')
const DATA = path.join(REPO, 'tools', 'collector', 'data', 'plugin')
const API_DIR = path.join(REPO, 'apps', 'api')
const COLLECT = path.join(HERE, 'collect-via-plugin.mjs')
const EXPORT = path.join(HERE, 'export-sycm-ingest.mjs')

function option(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback)
}
const DAYS = Number(option('days', '7'))
const DRY = process.argv.includes('--dry-run')

/** 从昨天往前数 N 天。今天不采：生意参谋的当日数据要到次日才稳定。 */
function recentDates(count) {
  const out = []
  const now = new Date()
  for (let i = 1; i <= count; i += 1) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    out.push(`${d.getFullYear()}-${m}-${day}`)
  }
  return out.reverse()
}

/**
 * 某店某天算不算「有数据」。
 *
 * 判据是 home-overview 的输出文件存在且大于 200 字节。不能只看目录在不在：
 * 采集失败时目录也会被创建（mkdir 在取数之前），只看目录会把空壳当成已采。
 */
function hasDay(code, date) {
  const file = path.join(DATA, code, date, '01-home-overview.json')
  try {
    return fs.statSync(file).size > 200
  } catch {
    return false
  }
}

/**
 * 跑一个子进程。
 *
 * useShell 只给 .cmd 用（Windows 上 spawn 不能直接执行 .cmd）。开了 shell 之后
 * 参数不会自动加引号，而本仓库路径含空格（"fanhe Work"），不加引号会被拆成两个
 * 参数，表现是「Cannot find module」而不是路径错误，很难一眼看出。
 */
function run(cmd, args, cwd = REPO, useShell = false) {
  const finalArgs = useShell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args
  const finalCmd = useShell ? `"${cmd}"` : cmd
  return new Promise((resolve) => {
    const child = spawn(finalCmd, finalArgs, { cwd, stdio: 'inherit', shell: useShell })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', () => resolve(1))
  })
}

/* ── 1. 读店铺清单 ───────────────────────────────────────────────────── */

const config = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'collector', 'shops.config.json'), 'utf8'))
const shops = (config.shops ?? []).filter(
  (shop) => shop.collect === true && !String(shop.code).startsWith('zz-'),
)
const dates = recentDates(DAYS)

console.log(`回看 ${DAYS} 天：${dates[0]} ~ ${dates[dates.length - 1]}，${shops.length} 家店`)

/* ── 2. 找缺口 ───────────────────────────────────────────────────────── */

const gaps = []
for (const shop of shops) {
  const missing = dates.filter((date) => !hasDay(shop.code, date))
  if (missing.length > 0) gaps.push({ shop, missing })
  console.log(
    `  ${shop.name}(${shop.code})  缺 ${missing.length} 天${missing.length > 0 ? '：' + missing.join(' ') : ''}`,
  )
}

if (gaps.length === 0) {
  console.log('\n采集产物没有缺口，跳过采集，只核对入库。')
}

const total = gaps.reduce((sum, gap) => sum + gap.missing.length, 0)
if (DRY) {
  console.log(gaps.length === 0 ? '\n--dry-run 不采集。' : `\n共缺 ${total} 个天次。--dry-run 不采集。`)
  process.exit(0)
}

/* ── 3. 逐店补齐 ─────────────────────────────────────────────────────── */

const collected = []
for (const { shop, missing } of gaps) {
  console.log(`\n${'='.repeat(56)}\n${shop.name}(${shop.code})  补 ${missing.length} 天`)
  let first = true
  for (const date of missing) {
    const args = [COLLECT, '--date', date, '--account', shop.code, '--minimal']
    /* 同店连跑多天，只在第一天切换账号，后面复用登录态。 */
    if (!first) args.push('--no-switch')
    first = false
    const code = await run(process.execPath, args)
    if (code === 0 || code === 2) {
      collected.push({ code: shop.code, date })
    } else {
      console.error(`  ${shop.name} ${date} 采集失败（退出码 ${code}），跳过这一天`)
    }
  }
}

/* ── 4. 导出并入库 ───────────────────────────────────────────────────── */

console.log(`\n${'='.repeat(56)}\n导出与入库`)

/*
 * 导出与入库按「最近 N 天里所有有文件的日子」走一遍，不限于本次补采的日期。
 *
 * 为什么：判据 hasDay 只看采集产物在不在，看不到库里有没有。出现过「文件在、
 * 但没入库」的状态（十月二十八日下午采了 10-26 与 10-27，库里只到 10-25）。
 * 只补缺口的话这种日子会被当成已齐，永远不入库。入库本身幂等（revised 为 0），
 * 全量过一遍的成本是每天零点二秒，换的是「文件与库不会脱节」。
 */
const datesWithFiles = dates.filter((date) => shops.some((shop) => hasDay(shop.code, date)))

const tsx = path.join(API_DIR, 'node_modules', '.bin', 'tsx.cmd')
let imported = 0
let failed = 0

for (const date of datesWithFiles) {
  const exportCode = await run(process.execPath, [EXPORT, '--date', date])
  if (exportCode !== 0 && exportCode !== 2) {
    console.error(`  ${date} 导出失败（退出码 ${exportCode}）`)
    failed += 1
    continue
  }
  for (const shop of shops) {
    if (!hasDay(shop.code, date)) continue
    const payload = path.join(REPO, 'tools', 'collector', 'data', 'payload', date, `${shop.code}.json`)
    if (!fs.existsSync(payload)) {
      console.error(`  ${date} ${shop.code} 没有生成 payload`)
      failed += 1
      continue
    }
    /* 空 payload（daily 为空数组）不入库：ingest 会按类型清行，写进去没有意义。 */
    let hasDaily = false
    try {
      hasDaily = (JSON.parse(fs.readFileSync(payload, 'utf8')).daily ?? []).length > 0
    } catch {
      hasDaily = false
    }
    if (!hasDaily) continue
    const importCode = await run(tsx, ['src/tools/ops-import.ts', payload], API_DIR, true)
    if (importCode === 0) imported += 1
    else {
      console.error(`  ${date} ${shop.code} 入库失败（退出码 ${importCode}）`)
      failed += 1
    }
  }
}

console.log(`\n完成：本次补采 ${collected.length} 个天次，核对 ${datesWithFiles.length} 天，入库 ${imported} 份，失败 ${failed} 份。`)
process.exit(failed > 0 ? 2 : 0)
