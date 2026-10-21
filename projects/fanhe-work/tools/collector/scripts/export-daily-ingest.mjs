/**
 * 日增原始响应 → 入库契约（ops-ingest.v1）。
 *
 * 为什么要有这个脚本
 *   采集器（`collect-daily.mjs`）只负责把生意参谋当天的接口响应原样落盘到
 *   `data/daily/<日期>/<页面>/`，不解析、不合并。而看板只认契约。少这一层，
 *   「跑完 run-daily」并不等于「看板有今天的数据」—— 中间断在这里。
 *
 * 与 `export-ingest.mjs` 的分工
 *   `export-ingest.mjs` 读 `data/csv30`，产出的是**历史回填**（30 天整段，一次灌完）。
 *   本脚本读 `data/daily/<日期>`，产出的是**当天这一格**（窗口 = 那一天）。
 *   两者共用同一份契约，因此入库侧不需要区分来源，`trigger` 字段负责留痕。
 *
 * 三条纪律
 *   1. **缺就是缺。** 页面没采到、字段没回、请求没发（日志里 `thin: true`），
 *      一律写 null 或不写这一行，绝不补 0。「当天成交为零」与「当天没采到」在
 *      经营上是两件事，补 0 会把后者伪装成前者，而且从数字上看不出来。
 *   2. **不猜结构。** 只解析这里逐个验证过的文件名与字段。线上接口换个壳子，
 *      脚本宁可报「这个文件没认出来」，也不去递归找「名字里带 uv 的字段」——
 *      猜出来的数最危险，因为它看起来是对的。
 *   3. **一个数只认一个来源。** 支付金额以 flow-overview 的 `payAmt` 为准
 *      （30 天窗口下它与交易明细逐日求和完全相等，108,000 元，实测过）；
 *      `getTendency` 若同时存在，只用来对账，不一致就报警，不静默取其一。
 *
 * 用法
 *   node scripts/export-daily-ingest.mjs                     取 data/daily 下最新一天
 *   node scripts/export-daily-ingest.mjs --date 2026-10-19
 *   node scripts/export-daily-ingest.mjs --dir <目录> --out <文件>
 *   node scripts/export-daily-ingest.mjs --shop s2 --date 2026-10-19   某一家店
 *   node scripts/export-daily-ingest.mjs --stdout            只打印，不落盘
 *   node scripts/export-daily-ingest.mjs --strict            数据不全时以 2 退出
 *
 * 退出码
 *   0 产出完成，核心指标齐全
 *   1 无法产出（目录不存在、认不出任何响应、店铺身份缺失、--shop 与目录指向的店不一致）
 *   2 产出完成但数据不全（核心指标缺、或清单里有偏薄页面），需要人看一眼
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveShop as resolveShopSlot, shopFromPath } from './lib/shops.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/* ── 参数 ─────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)

function flag(name) {
  return argv.includes(`--${name}`)
}

function option(name, fallback = null) {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

const IS_DATE = /^\d{4}-\d{2}-\d{2}$/

/** 某个采集根目录下最新一天。目录名就是业务日，不读文件时间。
 *  多店铺下根目录是 data/daily/<code>，单店老结构是 data/daily。 */
function latestDayDir(base) {
  if (!fs.existsSync(base)) return null
  const days = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && IS_DATE.test(entry.name))
    .map((entry) => entry.name)
    .sort()
  const last = days[days.length - 1]
  return last === undefined ? null : { date: last, dir: path.join(base, last) }
}

const explicitDir = option('dir')
const explicitDate = option('date')
const shopArg = option('shop')

/* 店铺槽位要先于目录计算解析：它决定去哪找日期目录。
   给了 --shop 却查不到时直接退，因为「拼错 code」和「配置里没这家店」
   修法相同，继续跑只会写出一份身份错误的契约。 */
let shopSlot = null
if (shopArg !== null) {
  try {
    shopSlot = resolveShopSlot(shopArg)
  } catch (e) {
    console.error(e.message)
    process.exit(1)
  }
}

const BASE_DAILY = shopSlot === null ? path.join(ROOT, 'data', 'daily') : shopSlot.outRoot

let targetDate = explicitDate
let dayDir = explicitDir === null ? null : path.resolve(explicitDir)

if (dayDir === null) {
  if (explicitDate !== null) {
    dayDir = path.join(BASE_DAILY, explicitDate)
  } else {
    const latest = latestDayDir(BASE_DAILY)
    if (latest === null) {
      console.error(`${path.relative(ROOT, BASE_DAILY)} 下没有任何按日期命名的目录。先跑一次 run-daily.ps1。`)
      process.exit(1)
    }
    targetDate = latest.date
    dayDir = latest.dir
  }
}

if (!fs.existsSync(dayDir)) {
  console.error(`目录不存在：${dayDir}`)
  process.exit(1)
}

// 没给 --date 时以目录名作业务日；给了就必须与目录名一致，否则会把 A 日的数据
// 写成 B 日 —— 这类错位在逐日表上看不出来，只有对账时才会发现。
const dirDate = path.basename(dayDir)
if (targetDate === null) targetDate = dirDate
if (IS_DATE.test(dirDate) && dirDate !== targetDate) {
  console.error(`--date ${targetDate} 与目录名 ${dirDate} 不一致，拒绝产出。`)
  process.exit(1)
}
if (!IS_DATE.test(targetDate)) {
  console.error(`无法确定业务日（目录名 ${dirDate} 不是 YYYY-MM-DD），请用 --date 指定。`)
  process.exit(1)
}

/* ── 读取工具 ─────────────────────────────────────────────────────────── */

/**
 * 每个模块最近一次扫描的结果。用来把「读不到」拆成三种修法完全不同的原因：
 *
 *   1. 目录不存在 / 目录里没有 json —— 采集没落盘，要重采。
 *   2. 有 json 但文件名不匹配 —— 接口换了命名，要改匹配规则，重采没用。
 *   3. 文件匹配上了、读到了，但里面没有可用行 —— 页面结构变了，或这一页确实为空。
 *
 * 原来三种都打印「未采到」，于是看到提示的人一律去重采；第 2、3 种重采一遍还是
 * 同样的结果，白跑一轮，而且会让人以为采集端坏了。
 */
const scanLog = new Map()

/** 读目录下第一个文件名匹配的 JSON。没有返回 null；有但解析失败直接抛。 */
function readFirst(module, pattern) {
  const dir = path.join(dayDir, module)
  if (!fs.existsSync(dir)) {
    scanLog.set(module, { dirExists: false, files: [], pattern, matched: null })
    return null
  }
  const all = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
  const entry = { dirExists: true, files: all, pattern, matched: null }
  scanLog.set(module, entry)
  const files = all.filter((name) => pattern.test(name))
  for (const name of files) {
    const file = path.join(dir, name)
    const raw = fs.readFileSync(file, 'utf8')
    try {
      const json = JSON.parse(raw)
      entry.matched = name
      return { file, name, json }
    } catch (error) {
      throw new Error(`${module}/${name} 不是合法 JSON：${error.message}`)
    }
  }
  return null
}

/** 把「读不到」翻译成一句可执行的原因。 */
function explainMissing(module) {
  const log = scanLog.get(module)
  if (log === undefined) return `${module}/ 未被读取`
  if (!log.dirExists) return `${module}/ 目录不存在`
  if (log.files.length === 0) return `${module}/ 目录里没有 json，采集这一页没落盘`
  if (log.matched === null) {
    const preview = log.files.slice(0, 4).join('、')
    const more = log.files.length > 4 ? ` 等 ${log.files.length} 个` : ''
    return `${module}/ 有 ${preview}${more}，但没有一个匹配 ${log.pattern} —— 这个接口要么没被触发（补采集规则），要么文件名变了（改匹配规则）；原样重采不会产生它`
  }
  return `${module}/${log.matched} 读到了，但里面没有可用行 —— 页面结构变了，或这一页确实为空`
}

/**
 * 取业务字段。生意参谋统一用 `{ value, cycleCrc }` 包一层，少数接口直接给数字。
 * 读不到（缺键、null、非数字）一律 null —— 这就是「空不等于零」的落点。
 */
function value(cell) {
  if (cell === null || cell === undefined) return null
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : null
  if (typeof cell === 'object' && 'value' in cell) {
    const inner = cell.value
    if (typeof inner === 'number') return Number.isFinite(inner) ? inner : null
    if (typeof inner === 'string' && inner.trim() !== '' && Number.isFinite(Number(inner))) {
      return Number(inner)
    }
    return null
  }
  return null
}

/**
 * 取文本字段。与 `value()` 分开：生意参谋的字符串字段同样是 `{ value: '橱柜' }` 的形状，
 * 用数字读取器去读会静默得到 null —— 那会表现为「关键词一条都没有」，看起来像平台没给。
 */
function text(cell) {
  if (typeof cell === 'string') return cell.trim() === '' ? null : cell
  if (typeof cell === 'object' && cell !== null && 'value' in cell) {
    return typeof cell.value === 'string' && cell.value.trim() !== '' ? cell.value : null
  }
  return null
}

/** 元 → 分。契约里所有金额都是整数分，换算只发生在这里。 */
function fen(yuan) {
  return yuan === null ? null : Math.round(yuan * 100)
}

/** 毫秒时间戳 → 东八区业务日。生意参谋的「日」按东八区切，不能用 UTC。 */
function dateFromEpochMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null
  return new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

const clipped = (text, max) => (typeof text === 'string' ? text.slice(0, max) : '')

/** 采集结果清单。用来解释「为什么这块没有数据」，读不到就当没有。 */
let manifest = null
try {
  const file = path.join(dayDir, '_manifest.json')
  if (fs.existsSync(file)) manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
} catch {
  manifest = null
}

function pageNote(module) {
  if (manifest === null || !Array.isArray(manifest.pages)) return null
  const page = manifest.pages.find((entry) => entry.name === module)
  // 清单只记本轮跑过的页面，没记到不代表没采到，因此不出声。
  if (page === undefined) return null
  const saved = Array.isArray(page.saved) ? page.saved.length : 0
  if (page.thin === true) return `清单标为偏薄（${saved} 个响应）`
  return null
}

/* ── 1. 逐日与整段：flow-overview ─────────────────────────────────────── */

const overview = readFirst('flow-overview', /overview\.json$/i)
const overviewData = overview === null ? null : (overview.json.data ?? null)
const overviewDate =
  overviewData === null ? null : dateFromEpochMs(value(overviewData.statDate))

const dailyMetrics = {
  payAmountFen: overviewData === null ? null : fen(value(overviewData.payAmt)),
  visitors: overviewData === null ? null : value(overviewData.uv),
  payBuyers: overviewData === null ? null : value(overviewData.payByrCnt),
  itemVisitors: overviewData === null ? null : value(overviewData.itmUv),
}

const daily = []
if (Object.values(dailyMetrics).some((metric) => metric !== null)) {
  daily.push({ date: targetDate, ...dailyMetrics })
}

/* ── 2. 支付金额对账：trade-detail/getTendency ────────────────────────── */

const tendency = readFirst('trade-detail', /gettendency\.json$/i)
let tendencyFen = null
if (tendency !== null) {
  const self = tendency.json.data?.self
  const series = Array.isArray(self) && Array.isArray(self[0]?.payAmt) ? self[0].payAmt : null
  // 请求区间就是那一天时数组只有一格；多格说明这页被按 30 天打开了，末尾才是当天。
  const last = series === null ? null : series[series.length - 1]
  tendencyFen = typeof last === 'number' && Number.isFinite(last) ? fen(last) : null
}

const amountMismatch =
  tendencyFen !== null &&
  dailyMetrics.payAmountFen !== null &&
  tendencyFen !== dailyMetrics.payAmountFen

/* ── 3. 维度 ──────────────────────────────────────────────────────────── */

const dimensions = []
const groups = []

/**
 * 收一组维度行。
 *
 * `source` 由扫描记录派生，不再由调用处手写 —— 手写时「未采到 xxx」与实际读到的
 * 文件名容易走偏，而这一列是报告里唯一能指出「这份数据来自哪个文件」的地方。
 */
function group(name, module, rows, note) {
  const log = scanLog.get(module)
  groups.push({ name, module, source: log?.matched ?? '未采到', rows: rows.length, note: note ?? null })
  dimensions.push(...rows)
}

/* 3.1 商品：item-rank 的商品访客 Top N。金额列是元。 */
{
  const file = readFirst('item-rank', /item_view_top\.json$/i)
  const rows = []
  if (file !== null) {
    const list = file.json.data?.data
    if (Array.isArray(list)) {
      for (const entry of list) {
        const key = clipped(entry?.item?.itemId ?? text(entry?.itemId), 120)
        if (key === '') continue
        rows.push({
          type: 'item',
          key,
          label: clipped(entry?.item?.title, 300) || key,
          metrics: {
            visitors: value(entry?.itmUv),
            payAmountFen: fen(value(entry?.payAmt)),
            payBuyers: value(entry?.payByrCnt),
            payRate: value(entry?.payRate),
            cartFen: fen(value(entry?.crtAmt)),
            favorites: value(entry?.itemCltByrCnt),
          },
        })
      }
    }
  }
  group('商品', 'item-rank', rows, pageNote('item-rank'))
}

/* 3.2 地域：flow-visitor/listAreas。 */
{
  const file = readFirst('flow-visitor', /listareas\.json$/i)
  const rows = []
  if (file !== null) {
    const list = file.json.data?.areaUv
    if (Array.isArray(list)) {
      for (const entry of list) {
        const key = clipped(text(entry?.name), 120)
        if (key === '') continue
        rows.push({
          type: 'area',
          key,
          label: key,
          metrics: {
            visitors: value(entry?.uv),
            ratio: value(entry?.ratio),
            orderRate: value(entry?.orderRate),
            payBuyers: value(entry?.orderBuyerCnt),
          },
        })
      }
    }
  }
  group('地域', 'flow-visitor', rows, pageNote('flow-visitor'))
}

/* 3.3 搜索词：flow-keyword/drainageSearch。 */
{
  const file = readFirst('flow-keyword', /drainagesearch\.json$/i)
  const rows = []
  if (file !== null) {
    const list = file.json.data?.data
    if (Array.isArray(list)) {
      for (const entry of list) {
        const key = clipped(text(entry?.seKeyword), 120)
        if (key === '') continue
        rows.push({
          type: 'keyword',
          key,
          label: key,
          metrics: { visitors: value(entry?.uv), payBuyers: value(entry?.payOrderUserCnt) },
        })
      }
    }
  }
  group('搜索词', 'flow-keyword', rows, pageNote('flow-keyword'))
}

/* 3.4 渠道：flow-shopsource 的渠道树（children 是被序列化的数组）。 */
{
  const file = readFirst('flow-shopsource', /tree_platform_support\.json$/i)
  const rows = []
  let note = null
  if (file !== null) {
    const tree = file.json.data
    const collect = (nodes) => {
      if (!Array.isArray(nodes)) return
      for (const node of nodes) {
        const name = clipped(text(node?.pageName), 120)
        const uv = value(node?.uv)
        if (name !== '' && uv !== null) {
          rows.push({
            type: 'channel',
            key: name,
            label: name,
            metrics: {
              visitors: uv,
              payBuyers: value(node?.payByrCnt),
              payRate: value(node?.payRate),
              payAmountFen: fen(value(node?.payAmt)),
            },
          })
        }
        collect(node?.children)
      }
    }
    collect(tree)
    if (rows.length === 0) note = `${file.name} 里没有可解析的渠道节点`
  } else {
    note = '未采到渠道树（本日只采到总览）'
  }
  group('渠道', 'flow-shopsource', rows, note)
}

/* 3.5 整段结构指标：来自 flow-overview 的同一份响应，窗口 = 当天。 */
{
  const rows = []
  if (overviewData !== null) {
    const mapping = [
      // 键名与 api 侧 KPI 的 key 一致，接口取整段值时不必再维护翻译表。
      ['payAmount', overviewData.payAmt, true],
      ['payBuyers', overviewData.payByrCnt, false],
      ['visitors', overviewData.uv, false],
      ['itemVisitors', overviewData.itmUv, false],
      ['payRate', overviewData.payRate, false],
      ['orderValue', overviewData.payPct, true],
      ['bounceRate', overviewData.bounceRate, false],
      ['stayTime', overviewData.stayTime, false],
      ['pv', overviewData.pv, false],
      ['cartByrCnt', overviewData.cartByrCnt, false],
      ['itmAvgPv', overviewData.itmAvgPv, false],
      ['newPayByrCnt', overviewData.newPayByrCnt, false],
      ['payOldByrCnt', overviewData.payOldByrCnt, false],
    ]
    for (const [key, cell, isMoney] of mapping) {
      const raw = value(cell)
      if (raw === null) continue
      rows.push({
        type: 'summary',
        key,
        label: key,
        metrics: { value: isMoney ? fen(raw) : raw },
      })
    }
  }
  group('结构指标', 'flow-overview', rows, pageNote('flow-overview'))
}

/* ── 4. 店铺身份 ──────────────────────────────────────────────────────── */
// 名称必须与库里一致：ingest 的 upsert 会把 name 覆盖成 payload 里的值，随手
// 写一个「梵禾」就会把店铺改名。所以名称只认两个来源：槽位表 shops.config.json，
// 或显式 --shop-name。
//
// 优先级（2026-10-21 修正）：命令行 / 目录路径 > 回填基线。
// 原来基线优先，四家店导出时会被全部写成主店 fanhe-main —— 这件事不报错，
// 只会在看板上表现为「其他店永远没数据、主店数字异常翻倍」。
function resolveShopIdentity() {
  const nameArg = option('shop-name')
  const fromPath = shopFromPath(dayDir)

  // ① 显式 --shop：以槽位表为准，并拒绝与目录所属店铺冲突的组合
  if (shopSlot !== null) {
    if (fromPath !== null && fromPath.code !== shopSlot.code) {
      console.error(
        `--shop ${shopSlot.code} 与数据目录所属店铺 ${fromPath.code} 不一致，拒绝产出。\n` +
          `  目录：${path.relative(ROOT, dayDir)}\n` +
          `  串店入库不会报错，只会把 ${fromPath.code} 的数据写成 ${shopSlot.code}。`,
      )
      process.exit(1)
    }
    return {
      code: shopSlot.code,
      name: nameArg ?? shopSlot.name,
      platform: shopSlot.platform,
      sellerNick: null,
    }
  }

  // ② 从目录路径反推（data/daily/<code>/<日期>）。忘了传 --shop 时靠这一层兜住。
  if (fromPath !== null) {
    return {
      code: fromPath.code,
      name: fromPath.name,
      platform: fromPath.platform,
      sellerNick: null,
    }
  }

  // ③ 老结构 data/daily/<日期>：主店单店时代的数据，沿用回填契约里的身份
  const baseline = path.join(ROOT, 'data', 'ingest', 'ops-ingest.json')
  if (fs.existsSync(baseline)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(baseline, 'utf8'))
      if (parsed?.shop?.code && parsed?.shop?.name) return parsed.shop
    } catch {
      // 回填契约坏了不该挡住日增：落到下面的报错分支。
    }
  }

  return null
}

const shop = resolveShopIdentity()

/* ── 5. 产出 ──────────────────────────────────────────────────────────── */

/*
 * 原始目录只记相对路径 —— 工作区在可移动介质上，盘符会变，写死路径等于写死一台机器。
 * 但用 `--dir` 指到采集器之外时，相对路径会退化成 `../../..`。那种情况不记这条
 * 相对路径，改记它「本该在」的位置：入库之后人要找的是原始响应，而不是这次跑在
 * 哪台机器上。
 */
const relativeRawPath = path.relative(ROOT, dayDir).split(path.sep).join('/')
const storedRawPath =
  relativeRawPath.startsWith('..') || path.isAbsolute(relativeRawPath)
    ? `data/daily/${shop === null ? '' : shop.code + '/'}${targetDate}`
    : relativeRawPath

const payload = {
  contractVersion: 1,
  shop,
  window: { from: targetDate, to: targetDate },
  source: 'api',
  trigger: 'schedule',
  rawPath: `tools/collector/${storedRawPath}`.slice(0, 300),
  daily,
  dimensions,
}

if (shop === null) {
  console.error('店铺身份缺失：目录不在 data/daily/<店铺>/<日期> 结构下，也没有给 --shop。')
  console.error('  先在 shops.config.json 里登记这家店，再传 --shop <code>。')
  process.exit(1)
}

if (daily.length === 0) {
  console.error(`没有可入库的逐日数据：${path.relative(ROOT, dayDir)} 里认不出 flow-overview 总览。`)
  console.error(`  ${explainMissing('flow-overview')}`)
  console.error('先看清单里这一页是否偏薄，或跑 check_daily.mjs 复核。')
  process.exit(1)
}

/*
 * 响应日期与目标日不一致，直接拒绝产出，不写文件。
 *
 * 这条原来只是 push 进 failures、把退出码降成 2 —— 文件照写。而文件里的
 * `window.from/to` 用的是 targetDate，`daily[0].date` 也是 targetDate，装进去的
 * 数值却属于 overviewDate 那一天。紧接着打印的 `pnpm db:ops-import <这个文件>`
 * 会把这批数入库到**错误的日期**，而且入库之后没有任何地方能看出错位：窗口合法、
 * 行数正常、状态 succeeded、金额看着也合理。
 *
 * 结构性问题不能降级成「待确认」，因为它的下游动作是不可逆的写入。
 */
if (overviewDate !== null && overviewDate !== targetDate) {
  console.error(`响应里的 statDate 是 ${overviewDate}，与目标日 ${targetDate} 不一致。`)
  console.error('这批数据不能入库：文件里的 window 会写成目标日，而数值属于另一天。')
  console.error('先确认报表页的日期是否真的切到了目标日（dateType 与日期参数），再重跑。')
  process.exit(1)
}

const json = JSON.stringify(payload, null, 2)

/* 覆盖率报告。存在的意义是让「少了一块」当场可见，而不是等看板上一片「—」才去猜。 */
const failures = []

if (dailyMetrics.visitors === null) failures.push('访客数缺失（flow-overview 未回 uv）')
if (dailyMetrics.payAmountFen === null) failures.push('支付金额缺失（flow-overview 未回 payAmt）')
if (amountMismatch) {
  failures.push(
    `两处支付金额不一致：总览 ${dailyMetrics.payAmountFen} 分，交易明细 ${tendencyFen} 分（以总览为准）`,
  )
}
for (const entry of groups) {
  if (entry.rows > 0) continue
  failures.push(
    `${entry.name}无数据${entry.note === null ? '' : `：${entry.note}`} —— ${explainMissing(entry.module)}`,
  )
}

if (flag('stdout')) {
  console.log(json)
} else {
  const outFile = path.resolve(option('out') ?? path.join(ROOT, 'data', 'ingest', `ops-daily-${targetDate}.json`))
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, json, 'utf8')

  console.log(`业务日 ${targetDate}  店铺 ${shop.code}（${shop.name}）`)
  console.log(`原始目录 ${payload.rawPath}`)
  console.log('')

  // 中文按两列宽补齐，否则报告会参差不齐 —— 这张表的用途就是扫一眼看哪行是「无」。
  const widthOf = (value) => [...value].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  const width = Math.max(...groups.map((entry) => widthOf(entry.name)), 8)
  for (const entry of groups) {
    const state = entry.rows > 0 ? `${entry.rows} 行` : '无'
    const pad = ' '.repeat(width - widthOf(entry.name))
    console.log(
      `  ${entry.name}${pad}  ${state.padStart(5, ' ')}  ${entry.source}${entry.note === null ? '' : `  ← ${entry.note}`}`,
    )
  }

  console.log('')
  console.log(
    `  逐日  ${daily.length} 行  金额 ${dailyMetrics.payAmountFen === null ? '缺' : `${(dailyMetrics.payAmountFen / 100).toFixed(2)} 元`}  访客 ${dailyMetrics.visitors ?? '缺'}  买家 ${dailyMetrics.payBuyers ?? '缺'}`,
  )
  console.log(`  维度  ${dimensions.length} 行`)
  console.log(`  写入  ${path.relative(ROOT, outFile)}`)
  // 下一步直接给出可直接粘贴的命令。入库脚本在 apps/api 下运行，相对路径会被解析到
  // 那个目录，所以这里给绝对路径 —— 少一次「为什么找不到文件」的排查。
  console.log('')
  console.log('  下一步（在 projects/fanhe-work 下）：')
  console.log(`    pnpm db:ops-import "${outFile}"`)

  if (failures.length > 0) {
    console.log('')
    console.log(`  待确认 ${failures.length} 项：`)
    for (const failure of failures) console.log(`    · ${failure}`)
  }
}

if (failures.length > 0) {
  process.exitCode = 2
  if (flag('strict')) console.error('--strict：数据不完整，按失败处理。')
}
