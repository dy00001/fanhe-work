#!/usr/bin/env node
/**
 * 日增链路的跨环节校验：采集产物 ↔ 导出契约。
 *
 * 为什么需要这个脚本：现有三道检查各守一段，段与段之间无人守。
 *
 *   collect-daily.mjs   只知道「这一页回了几个接口」，不知道这些响应能不能被认出来
 *   export-daily-ingest 只知道「这份目录里能不能凑出契约」，不知道采集端是否认为齐全
 *   check_daily.mjs     复核的是文件层面，不碰契约
 *
 * 于是「采集说齐全、导出说没有」这种断裂谁都不报。10-19 的渠道就是活例子：采集端
 * 2 个文件、字节数够、判定不薄；导出端找不到渠道树，渠道维度 0 行；看板渠道一片
 * 「—」，而三道检查全绿。
 *
 * 本脚本只做一件事：拿 manifest 与导出契约做**交叉断言**。它不重采、不写库、不改
 * 任何文件，只回答「这一天的三段接得上吗」。
 *
 * 三级严重度 —— 这一层划分是整个脚本的关键：
 *
 *   阻断  会让「错的数据」进库。窗口错位、逐日日期不符、维度 0 行。入库之后每一层
 *         校验都会通过，只有对着生意参谋原始页面才看得出不对，所以必须在入库前拦住。
 *   缺口  数据少了一块，但剩下的都是对的。偏薄页、关键接口没触发、采集说拿到了导出
 *         却认不出。这些进库只是让某个维度显示「—」，不影响其它数据，也不影响历史
 *         （同窗口未上报的类型会保留旧行）。挡下来只会让日增永远跑不完。
 *   提示  已知缺口，看一眼即可。
 *
 * 用法：
 *   node scripts/verify-daily.mjs                    # 校验最新一天
 *   node scripts/verify-daily.mjs --date 2026-10-19
 *   node scripts/verify-daily.mjs --date 2026-10-19 --ingest path/to/ops-daily.json
 *
 * 退出码：0 干净；2 有缺口但可入库；1 有阻断项，不许入库。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { missingEndpoints } from './lib/required-endpoints.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const DAILY_DIR = path.join(ROOT, 'data', 'daily')
const INGEST_DIR = path.join(ROOT, 'data', 'ingest')

const IS_DATE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 页面 → 它应该产出哪种维度。
 *
 * 这张表是「跨段一致性」的判据：采集端说这一页拿到了东西，导出端就必须有对应维度
 * 的行。没有这张表，两段各自都能自证清白。
 */
const PAGE_TO_DIMENSION = {
  'item-rank': 'item',
  'flow-visitor': 'area',
  'flow-keyword': 'keyword',
  'flow-shopsource': 'channel',
}

/* 已知缺口：这些接口在当前页面结构下不会触发，缺了不算失败，但要报出来。
   依据见 docs/ops/PIPELINE-2026-10-21.md 第三节。 */
const KNOWN_GAPS = {
  'flow-shopsource': 'tree_platform_support',
}

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return null
  const next = process.argv[index + 1]
  return next === undefined || next.startsWith('--') ? '' : next
}

function latestDay() {
  if (!fs.existsSync(DAILY_DIR)) return null
  const days = fs
    .readdirSync(DAILY_DIR)
    .filter((name) => IS_DATE.test(name))
    .sort()
  return days.length === 0 ? null : days[days.length - 1]
}

const date = option('date') ?? latestDay()
if (date === null || !IS_DATE.test(date)) {
  console.error('用法：node scripts/verify-daily.mjs [--date YYYY-MM-DD] [--ingest 文件]')
  console.error(date === null ? 'data/daily 下没有任何按日期命名的目录。' : `日期不合法：${date}`)
  process.exit(2)
}

const blocking = []
const degraded = []
const notes = []
const passes = []

function ok(message) {
  passes.push(message)
}

/** 会让错的数据进库。 */
function block(message, hint) {
  blocking.push(hint === undefined ? message : `${message} —— ${hint}`)
}

/** 数据有缺口但都是对的。 */
function degrade(message) {
  degraded.push(message)
}

/** 已知缺口或提醒。 */
function note(message) {
  notes.push(message)
}

/* ── 1. 采集产物 ─────────────────────────────────────────────────────── */

const dayDir = path.join(DAILY_DIR, date)
const manifestPath = path.join(dayDir, '_manifest.json')

/* 提到外层：第二段的跨段一致性断言要用它。 */
let manifest = null
let manifestPages = null

if (!fs.existsSync(dayDir)) {
  block(`采集目录不存在：${path.relative(ROOT, dayDir)}`, '先跑 collect-daily.mjs')
} else if (!fs.existsSync(manifestPath)) {
  degrade(`缺 manifest：${path.relative(ROOT, manifestPath)}，无法做跨段一致性断言`)
} else {
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    degrade(`manifest 不是合法 JSON：${error.message}`)
  }

  if (manifest !== null) {
    if (manifest.targetDate !== date) {
      block(
        `manifest.targetDate 是 ${manifest.targetDate}，与目录名 ${date} 不一致`,
        '目录被改名或拷错，里面装的是另一天的数据',
      )
    } else {
      ok(`采集：manifest 目标日 ${date}`)
    }

    const pages = Array.isArray(manifest.pages) ? manifest.pages : []
    manifestPages = new Map(pages.map((page) => [page.name, page]))
    const ranThisTime = Array.isArray(manifest.lastRunPages) ? manifest.lastRunPages : []
    if (ranThisTime.length === 0) {
      degrade('manifest 里没有 lastRunPages，分不清这一天采过哪些页')
    } else {
      ok(`采集：本次覆盖 ${ranThisTime.length} 页（${ranThisTime.join('、')}）`)
    }

    /* 偏薄页。已知空页不算 —— 基线同样为空，是账号权限问题不是采集问题。 */
    const thinPages = pages.filter((page) => page.thin === true && page.expectEmpty !== true)
    if (thinPages.length > 0) {
      degrade(
        `采集：${thinPages.length} 页偏薄（${thinPages.map((page) => page.name).join('、')}），对应维度本日不更新`,
      )
    }

    /* 接口缺失。体量够但关键接口没触发，重采不会变。
       不看 manifest 里的 `missing` 字段，直接按落盘记录重算 —— 旧 manifest 没有
       那个字段，而「缺不缺」这件事本来就能从文件名推出来。 */
    for (const page of pages) {
      if (page.expectEmpty === true) continue
      const missing = missingEndpoints(page.name, page.saved)
      if (missing.length === 0) continue
      const known = KNOWN_GAPS[page.name]
      const isKnown = known !== undefined && missing.length === 1 && missing[0].includes(known)
      const text = `${page.name} 缺接口 ${missing.join('、')}`
      if (isKnown) {
        note(`采集：${text}（已知缺口，对应维度本日不会更新）`)
      } else {
        degrade(`采集：${text}，导出层会认不出这个维度`)
      }
    }
  }
}

/* ── 2. 导出契约 ─────────────────────────────────────────────────────── */

const ingestPath = option('ingest') ?? path.join(INGEST_DIR, `ops-daily-${date}.json`)
let payload = null

if (!fs.existsSync(ingestPath)) {
  block(
    `导出产物不存在：${path.relative(ROOT, ingestPath)}`,
    `先跑 node scripts/export-daily-ingest.mjs --dir data/daily/${date}`,
  )
} else {
  try {
    payload = JSON.parse(fs.readFileSync(ingestPath, 'utf8'))
  } catch (error) {
    block(`导出产物不是合法 JSON：${error.message}`)
  }
}

if (payload !== null) {
  /* 2.1 窗口。窗口与目标日不一致是最危险的错位：入库之后每一层都合法。 */
  const from = payload.window?.from ?? null
  const to = payload.window?.to ?? null
  if (from !== date || to !== date) {
    block(
      `导出：窗口是 ${from}~${to}，与目标日 ${date} 不一致`,
      '入库会把数值写到错误的日期，且事后看不出来',
    )
  } else {
    ok(`导出：窗口 ${from}~${to}`)
  }

  /* 2.2 逐日。日增契约的窗口恒为一天，所以 daily 只该有 1 行。
     字段是平铺的（date / payAmountFen / visitors …），不是嵌套的 values。 */
  const daily = Array.isArray(payload.daily) ? payload.daily : []
  if (daily.length !== 1) {
    block(`导出：逐日行数 ${daily.length}，日增契约应为 1 行`, '多行说明采到的是区间口径')
  } else if (daily[0].date !== date) {
    block(`导出：逐日行的日期是 ${daily[0].date}，与目标日 ${date} 不一致`)
  } else {
    const amount = daily[0].payAmountFen
    const visitors = daily[0].visitors
    if (typeof amount !== 'number') {
      degrade('导出：支付金额缺失（flow-overview 未回 payAmt），看板金额会显示为「—」')
    }
    if (typeof visitors !== 'number') {
      degrade('导出：访客数缺失（flow-overview 未回 uv）')
    }
    if (typeof amount === 'number' && typeof visitors === 'number') {
      ok(`导出：逐日 1 行，金额 ${(amount / 100).toFixed(2)} 元，访客 ${visitors}`)
    } else {
      ok('导出：逐日 1 行（金额或访客缺项，已单列缺口）')
    }
  }

  /* 2.3 维度。 */
  const dimensions = Array.isArray(payload.dimensions) ? payload.dimensions : []
  if (dimensions.length === 0) {
    block('导出：维度 0 行', '看板除 KPI 外全部会显示「—」，等于这一天的维度白采')
  } else {
    const byType = new Map()
    for (const row of dimensions) {
      byType.set(row.type, (byType.get(row.type) ?? 0) + 1)
    }
    const summary = [...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type} ${count}`)
      .join(' / ')
    ok(`导出：维度 ${dimensions.length} 行（${summary}）`)

    /* 2.4 跨段一致性：采集端说拿到了，导出端就必须有。
       这是本脚本存在的主要理由 —— 两段各自都能自证清白，只有交叉看才看得见断裂。 */
    if (manifestPages !== null) {
      for (const [page, dimType] of Object.entries(PAGE_TO_DIMENSION)) {
        const entry = manifestPages.get(page)
        if (entry === undefined || entry.expectEmpty === true) continue
        const exported = byType.get(dimType) ?? 0
        if (exported > 0) continue

        const savedCount = Array.isArray(entry.saved) ? entry.saved.length : 0
        if (savedCount === 0) {
          degrade(`一致性：${page} 本日没有落盘，${dimType} 维度不更新`)
          continue
        }
        const missing = missingEndpoints(page, entry.saved)
        const knownGap = KNOWN_GAPS[page]
        if (knownGap !== undefined && missing.length === 1 && missing[0].includes(knownGap)) {
          note(
            `一致性：${page} 落盘 ${savedCount} 个接口，但 ${dimType} 维度 0 行（已知缺口：缺 ${knownGap}）`,
          )
        } else {
          degrade(
            `一致性：${page} 落盘 ${savedCount} 个接口，导出后 ${dimType} 维度却是 0 行（接口在但认不出）`,
          )
        }
      }
    }
  }
}

/* ── 3. 汇报 ─────────────────────────────────────────────────────────── */

console.log(`日增链路校验  业务日 ${date}`)
console.log('')
for (const line of passes) console.log(`  ok    ${line}`)
for (const line of notes) console.log(`  提示  ${line}`)
for (const line of degraded) console.log(`  缺口  ${line}`)
for (const line of blocking) console.log(`  阻断  ${line}`)
console.log('')
console.log(
  `  合计 通过 ${passes.length} / 提示 ${notes.length} / 缺口 ${degraded.length} / 阻断 ${blocking.length}`,
)

if (blocking.length > 0) {
  console.log('')
  console.log('  不许入库：阻断项会让错的数据进库，而入库之后每一层校验都会通过，')
  console.log('  只有对着生意参谋的原始页面才看得出不对。')
  process.exit(1)
}

if (degraded.length > 0) {
  console.log('')
  console.log('  可以入库，但有缺口：缺失的维度会显示「—」，同窗口未上报的类型保留旧行。')
  process.exit(2)
}
