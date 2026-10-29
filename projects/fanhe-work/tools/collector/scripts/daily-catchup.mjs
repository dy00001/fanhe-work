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

/*
 * 把 node 所在目录补进 PATH。
 *
 * 计划任务的最小环境里没有 node，而入库要调 `tsx.cmd`，它内部又会去调 `node`。
 * 不补这一句，采集和导出都正常，只有入库那一步报
 * `'node' is not recognized`，从日志上看像是入库逻辑坏了。
 */
process.env.PATH = `${path.dirname(process.execPath)};${process.env.PATH ?? ''}`

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

/* ── 0. 前置：取数桥必须在线 ─────────────────────────────────────────── */

/*
 * 为什么要有这一段
 *
 * 取数桥是浏览器里的插件，它轮询 sycm-cli 在 127.0.0.1:47831-47840 开的端口。
 * 浏览器没开就没有任何东西去连那些端口，doctor 直接判「插件离线」，采集每条都
 * 退 3。计划任务没有控制台，这件事只会表现为「任务跑了，日志一行 exit=3」。
 *
 * 实测最常见的原因就是 Edge 根本没开（这台机器上每天第一次跑都是这样）。
 * 于是这里补一步：doctor 不通就先尝试把 Edge 拉起来，再等它把插件连上。
 *
 * 关掉这一步设 FANHE_AUTO_EDGE=0：有人不希望自动化弹浏览器窗口。
 */
const SYCM_ROOT = process.env.SYCM_CLI_ROOT ?? path.join(REPO, '..', '..', 'runtime', 'sycm-cli')
const SYCM_PY = path.join(SYCM_ROOT, '.venv', 'Scripts', 'python.exe')

/**
 * 跑一条命令并收下输出。
 *
 * 与上面的 run 分开写：run 用 stdio inherit 把输出直接交给终端，而计划任务没有
 * 终端，doctor 失败的那行原因会消失在日志之外，只剩一个退出码。
 */
function capture(cmd, args, env) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    child.on('error', (error) => resolve({ code: 1, stdout: '', stderr: error.message }))
  })
}

/** 最后一行非空输出。doctor 的原因在最后一行。 */
function lastLine(text) {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.length === 0 ? '' : lines[lines.length - 1]
}

function sycmDoctor() {
  return capture(SYCM_PY, ['-m', 'tb', 'sycm', 'doctor'], {
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONPATH: SYCM_ROOT,
    TB_STATE_ROOT: path.join(SYCM_ROOT, '.runtime'),
  })
}

/** Edge 的可执行文件。候选表而不是单个路径：Program Files 与 (x86) 两种装法都有。 */
function findEdge() {
  const candidates = [
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['LOCALAPPDATA'] ?? '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ]
  return candidates.find((file) => file !== '' && fs.existsSync(file)) ?? null
}

/**
 * 确保取数桥在线。返回 true 表示可以开始采集。
 *
 * 等待窗口取 90 秒：Edge 冷启动到插件 service worker 醒来要十几秒，而 doctor
 * 自身一次也要十秒上下，窗口给短了会在「其实马上就通了」的时候判死。
 */
async function ensureBridge() {
  if (!fs.existsSync(SYCM_PY)) {
    console.log(`取数桥检查跳过：找不到 ${SYCM_PY}`)
    return false
  }

  const first = await sycmDoctor()
  if (first.code === 0) {
    console.log('取数桥在线')
    return true
  }
  console.log(`取数桥未就绪：${lastLine(first.stderr) || lastLine(first.stdout) || 'doctor 退出码 ' + first.code}`)

  if (process.env.FANHE_AUTO_EDGE === '0') {
    console.log('FANHE_AUTO_EDGE=0，不自动启动浏览器')
    return false
  }

  const edge = findEdge()
  if (edge === null) {
    console.log('找不到 msedge.exe，无法自动启动浏览器')
    return false
  }

  /*
   * detached 是必需的：本脚本跑完就退出，而浏览器要继续留着给下一次采集用。
   * 不 detach 的话 Edge 会跟着父进程一起被收掉，表现为「刚启动就被杀」。
   */
  console.log(`启动浏览器唤醒取数桥：${edge}`)
  try {
    const child = spawn(edge, ['https://sycm.taobao.com'], { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    console.log(`启动浏览器失败：${error.message}`)
    return false
  }

  const deadline = Date.now() + 90_000
  let attempt = 0
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    attempt += 1
    const probe = await sycmDoctor()
    if (probe.code === 0) {
      console.log(`取数桥已连通（第 ${attempt} 次探测）`)
      return true
    }
    console.log(`  第 ${attempt} 次探测未通：${lastLine(probe.stderr) || lastLine(probe.stdout)}`)
  }
  console.log('等待超时，取数桥仍未连通')
  return false
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

/* ── 2.5 取数桥就绪检查 ──────────────────────────────────────────────── */

/*
 * 没有缺口就不必碰浏览器：下面的入库核对只读本地文件与数据库。
 * 有缺口但桥不通时把 gaps 清空，让流程继续走完导出与入库 —— 已经落盘的日子
 * 仍然要被核对，不能因为今天采不到就把历史一起跳过。
 */
if (gaps.length > 0) {
  const bridgeReady = await ensureBridge()
  if (!bridgeReady) {
    console.error('\n取数桥不可用，本次跳过采集，只做入库核对。')
    gaps.length = 0
  }
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
  /* 这个脚本就是「定时任务」那个入口（计划任务与 WorkBuddy 自动化都调它），
     所以批次记 schedule。不显式传的话，`export-sycm-ingest.mjs` 的默认值
     manual 会让定时轮次与人工补采在库里长得一模一样。 */
  const exportCode = await run(process.execPath, [EXPORT, '--date', date, '--trigger', 'schedule'])
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
