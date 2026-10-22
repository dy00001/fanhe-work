/**
 * 采集链路自检：一条命令回答「为什么看板没有数」。
 *
 * ## 它把五段拼成一张表
 *
 * 「没有数」有五种可能，分布在两处：
 *
 *   库这一侧：没绑定、待办没人拉、入库失败 → `tsx src/tools/ops-doctor.ts`
 *   机器这一侧：槽位表没有这家店、Edge 没起来、登录态失效 → 本脚本自己查
 *
 * 分开查会得到两份互相对不上的结论，所以这里先取库的事实，再逐个对照槽位与
 * 端口，最后给出一句「现在该做什么」。
 *
 * ## 为什么不做成自动修复
 *
 * 每一项的可行动作都不一样（补槽位、起浏览器、重新登录、重启常驻任务），而
 * 猜错一次就会掩盖真实原因。这里只诊断，动作由人决定。
 *
 * 用法
 *   node scripts/doctor.mjs              给人看的表格
 *   node scripts/doctor.mjs --json       给脚本看的合并结果
 *
 * 两级判定，而不是「有问题 / 没问题」
 *
 *   阻断：会让「已请求的同步」永远等不到结果，或让数据安静地错。退出码 1。
 *         例：有待办但浏览器没开、端口与库不一致、库里没有这家店。
 *   提示：下次采集前需要处理，但现在不阻塞。退出码仍是 0。
 *         例：夜间浏览器没开且没有人请求同步、数据超过一天未更新。
 *
 * 这条区分是必要的：采集浏览器的开关由人决定，凌晨没开是完全正常的。若把它当
 * 阻断，这个工具每天晚上都在报警，几次之后就被无视了 —— 一个总是报错的检查
 * 等于没有检查。
 *
 * 退出码
 *   0 没有阻断项（可能有提示）
 *   1 有阻断项
 *   2 前置不可用：读不到槽位表，或数据库侧 CLI 跑不起来
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadShops } from './lib/shops.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const API_DIR = path.resolve(ROOT, '..', '..', 'apps', 'api')
const TSX = path.join(API_DIR, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
const JSON_OUT = process.argv.includes('--json')

/** 采集成功超过这么多小时算「陈旧」。日增是 T+1，26 小时与看板的新鲜度口径一致。 */
const STALE_HOURS = 26

/** 显示宽度：汉字占两格。表格对不齐时最难读，所以按显示宽度补空格。 */
function widthOf(text) {
  let width = 0
  for (const char of String(text)) {
    width += /[\u4e00-\u9fa5\uff00-\uffef]/.test(char) ? 2 : 1
  }
  return width
}

function pad(text, target) {
  const value = String(text ?? '')
  return value + ' '.repeat(Math.max(0, target - widthOf(value)))
}

function runTsx(args) {
  const line = [TSX, ...args].map((item) => `"${item}"`).join(' ')
  return new Promise((resolve) => {
    const child = spawn(line, [], {
      cwd: API_DIR,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      /* tsx.cmd 内部调的是裸 node，PATH 里没有它时会在计划任务里失败。
         与 sync-shops.mjs 同一条修法，这里也前置一份。 */
      env: {
        ...process.env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: error.message }))
    child.on('exit', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}

async function portAlive(port) {
  if (!Number.isInteger(port) || port <= 0) return false
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: controller.signal })
      return response.ok
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return false
  }
}

function hoursSince(iso, nowMs) {
  if (iso === null) return null
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return null
  return (nowMs - at) / 3_600_000
}

const blocking = []
const warnings = []
const notes = []

/* ---- 1. 槽位表 ------------------------------------------------------------ */
let config = null
try {
  config = loadShops()
} catch (error) {
  blocking.push(`槽位表不可用：${error instanceof Error ? error.message : String(error)}`)
}

/* ---- 2. 库这一侧 ---------------------------------------------------------- */
const doctorRun = await runTsx([path.join('src', 'tools', 'ops-doctor.ts')])
if (doctorRun.code !== 0) {
  blocking.push(`数据库自检失败：${doctorRun.stderr.trim().slice(0, 300) || '没有输出'}`)
}

let snapshot = null
if (doctorRun.code === 0) {
  const line = doctorRun.stdout.trim().split(/\r?\n/).pop() ?? ''
  try {
    snapshot = JSON.parse(line)
  } catch {
    blocking.push(`数据库自检输出无法解析：${line.slice(0, 200)}`)
  }
}

const nowMs = Date.now()
const byCode = new Map((snapshot?.shops ?? []).map((shop) => [shop.code, shop]))
const pending = new Set(snapshot?.pending ?? [])
const slots = config?.shops ?? []

/* ---- 3. 逐店对照 ---------------------------------------------------------- */
const rows = []
for (const slot of slots) {
  const shop = byCode.get(slot.code)
  const browser = slot.collect ? await portAlive(slot.port) : null

  const blockingHere = []
  const warningHere = []
  const waiting = pending.has(slot.code)

  if (shop === undefined) {
    if (slot.collect) blockingHere.push('库里没有这家店，先在工作台里绑定')
  } else {
    /* 登录态失效一定会让下一次采集失败，与有没有待办无关。 */
    if (shop.loginState === 'needs_login') blockingHere.push('登录态失效，需要重新登录')

    if (slot.collect && browser === false) {
      const where = waiting ? blockingHere : warningHere
      where.push(waiting ? '采集浏览器未启动，这家店已请求同步，等不到结果' : '采集浏览器未启动（下次采集前需要开）')
    }

    /* 端口不一致是「安静地采错」那一类：采集器按槽位走，界面按库显示。 */
    if (slot.port !== null && shop.collectPort !== null && slot.port !== shop.collectPort) {
      blockingHere.push(`端口不一致：槽位 ${slot.port} / 库 ${shop.collectPort}（采集器按槽位走）`)
    }

    if (waiting && browser !== false) warningHere.push('已请求同步，等采集器处理')

    /* 上一次失败的记录会一直留着，不区分新旧就当阻断会让工具长期报警。 */
    if (shop.lastSyncError !== null) warningHere.push(`上次同步失败：${shop.lastSyncError}`)

    const age = hoursSince(shop.lastCollectedAt, nowMs)
    if (slot.collect && age !== null && age > STALE_HOURS) {
      warningHere.push(`数据已 ${Math.floor(age)} 小时未更新`)
    }
  }

  const reasons = [...blockingHere, ...warningHere]
  if (blockingHere.length > 0) blocking.push(`${slot.code}：${blockingHere.join('；')}`)
  if (warningHere.length > 0) warnings.push(`${slot.code}：${warningHere.join('；')}`)
  rows.push({ slot, shop, browser, reasons, blockingHere })
}

/* ---- 4. 库里有、槽位没有 -------------------------------------------------- */
for (const shop of snapshot?.shops ?? []) {
  if (!slots.some((slot) => slot.code === shop.code)) {
    blocking.push(`${shop.code}：库里有这家店但槽位表里没有，采集器永远不会采它`)
  }
}

/* ---- 5. 采集器自身 -------------------------------------------------------- */
if (snapshot !== null) {
  const { collector } = snapshot
  if (!collector.online) {
    const why =
      collector.lastSeenAt === null
        ? '从未启动，按 docs/ops/SHOP-BINDING.md 注册常驻任务'
        : `最后心跳 ${collector.ageSeconds} 秒前，进程可能已退出`
    /* 有待办时离线才是阻断：否则那些请求永远没人处理。没有待办时日常采集走
       run-daily.ps1，常驻任务掉线不影响当天数据。 */
    if (pending.size > 0) blocking.push(`采集器离线：${why}`)
    else warnings.push(`采集器离线：${why}`)
  }
  if (pending.size > 0 && collector.online) {
    notes.push(`有 ${pending.size} 家店在等采集器（${[...pending].join('、')}）`)
  }
}

/* ---- 输出 ----------------------------------------------------------------- */
if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        collector: snapshot?.collector ?? null,
        pending: [...pending],
        shops: rows.map((row) => ({
          code: row.slot.code,
          name: row.slot.name,
          port: row.slot.port,
          collecting: row.slot.collect,
          browserAlive: row.browser,
          loginState: row.shop?.loginState ?? null,
          lastCollectedAt: row.shop?.lastCollectedAt ?? null,
          pending: pending.has(row.slot.code),
          lastSyncError: row.shop?.lastSyncError ?? null,
          reasons: row.reasons,
        })),
        blocking,
        warnings,
        notes,
      },
      null,
      2,
    ),
  )
} else {
  console.log('')
  console.log('采集链路自检')
  console.log('='.repeat(78))
  const collector = snapshot?.collector
  console.log(
    `采集器：${
      collector === null || collector === undefined
        ? '状态未知'
        : collector.online
          ? `在线（${collector.ageSeconds} 秒前心跳）`
          : collector.lastSeenAt === null
            ? '从未启动'
            : `离线（${collector.ageSeconds} 秒前最后一次心跳）`
    }`,
  )
  console.log('')
  console.log(
    `${pad('店铺', 14)}${pad('端口', 7)}${pad('浏览器', 8)}${pad('登录态', 12)}${pad('最近采集', 16)}${pad('待办', 6)}备注`,
  )
  console.log('-'.repeat(78))
  for (const row of rows) {
    const collected = row.shop?.lastCollectedAt
    const collectedText =
      collected === null || collected === undefined
        ? '—'
        : new Date(collected).toLocaleString('zh-CN', { hour12: false })
    const loginText =
      row.shop === undefined
        ? '—'
        : row.shop.loginState === 'authenticated'
          ? '已登录'
          : row.shop.loginState === 'needs_login'
            ? '需重新登录'
            : '未校验'
    console.log(
      `${pad(row.slot.code, 14)}${pad(row.slot.port ?? '—', 7)}${pad(
        row.browser === null ? '不采集' : row.browser ? '可达' : '不可达',
        8,
      )}${pad(loginText, 12)}${pad(collectedText, 16)}${pad(
        pending.has(row.slot.code) ? '是' : '',
        6,
      )}${row.reasons[0] ?? ''}`,
    )
  }
  console.log('')
  if (notes.length > 0) {
    for (const note of notes) console.log(`· ${note}`)
    console.log('')
  }
  if (warnings.length > 0) {
    console.log(`提示 ${warnings.length} 条（不影响当前，下次采集前处理）：`)
    for (const warning of warnings) console.log(`  · ${warning}`)
    console.log('')
  }
  if (blocking.length === 0) {
    console.log('结论：没有阻断项。')
  } else {
    console.log(`结论：${blocking.length} 项需要处理`)
    for (const item of blocking) console.log(`  - ${item}`)
  }
  console.log('')
}

process.exit(blocking.length === 0 ? 0 : 1)
