/**
 * 插件采集器：调 sycm-cli 取数，落盘到 `data/plugin/<店铺代号>/<日期>/`。
 *
 * 为什么要有这个脚本
 *   原链路 `collect-daily.mjs` 靠 Edge 每店独立 profile + CDP 旁路录制 17 个页面，
 *   每页等 60 秒，单店 17 到 25 分钟。插件链路改用 sycm-cli 的命令面，单条 2 到 10 秒。
 *
 * 与 export-sycm-ingest.mjs 的分工
 *   本脚本只负责「把平台的响应拿下来并落盘」，不解析、不换算。
 *   转换与入库交给 `export-sycm-ingest.mjs`，两者用同一份序号表。
 *
 * 三条必须守住的约束（都是实测踩出来的）
 *   1. **每店只切一次账号，切换后等 65 秒。** 逐条带 `--account` 会让单条从 5 秒变成 16 秒；
 *      不等 65 秒，插件会复用上一个账号的发射台页面，请求前后账号不一致，整批作废。
 *   2. **单品级命令用各店自己的热销第一名的 itemId。** 跨店复用会取到别家店的商品数据。
 *   3. **按命令区分输出模式。** `fetch-recent` 只认 `--out`，`list` 只认 `--raw`，
 *      `excel-tasks` 两个都不认。传错就是 exit=2 加一屏 usage。
 *
 * 用法
 *   node scripts/collect-via-plugin.mjs --date 2026-10-24
 *   node scripts/collect-via-plugin.mjs --date 2026-10-24 --account 梵禾
 *   node scripts/collect-via-plugin.mjs --date 2026-10-24 --dry-run
 *
 * 退出码
 *   0 全部店铺采完
 *   2 至少一家店有命令失败（数据已落盘，可用 export-sycm-ingest 复核）
 *   3 前置不满足：sycm-cli 不可用、插件离线
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(ROOT, '..', '..')
const SYCM_ROOT = process.env.SYCM_CLI_ROOT ?? path.join(REPO, '..', '..', 'runtime', 'sycm-cli')
const PYTHON = path.join(SYCM_ROOT, '.venv', 'Scripts', 'python.exe')

/* ── 参数 ─────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
const option = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const val = argv[index + 1]
  return val === undefined || val.startsWith('--') ? fallback : val
}
const flag = (name) => argv.includes(`--${name}`)

const DATE = option('date')
if (DATE === null || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error('必须给 --date YYYY-MM-DD')
  process.exit(1)
}
const ONLY = option('account')
const DRY = flag('dry-run')
/* 只补三条维度探测。用于「主数据已在、只缺渠道/地域/搜索词」的补采，
   把单店耗时从二十分钟压到两三分钟，也避开插件长任务断连的窗口。 */
const ONLY_API = flag('only-api')

const D1 = ['--date', DATE]
// 7 天窗口：服务端按含首尾算，10-24 往前推 6 天正好 7 天
const start = (() => {
  const d = new Date(DATE + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() - 6)
  return d.toISOString().slice(0, 10)
})()
const D7 = ['--date', start, '--end-date', DATE]

/* ── 命令清单 ─────────────────────────────────────────────────────────── */

/**
 * 序号必须与 `export-sycm-ingest.mjs` 的 CMD 表一致。
 * 模式：raw = `--raw --out`，out = `--out`，stdout = 抓标准输出。
 */
const SHOP_CMDS = [
  ['home-overview', D1, 'raw'],
  ['home-trend', D1, 'raw'],
  ['home-table', D7, 'raw'],
  ['grow-factor', D1, 'raw'],
  ['order-overview', D1, 'raw'],
  ['order-trend', D1, 'raw'],
  ['order-distribution', D1, 'raw'],
  ['order-recommend', D1, 'raw'],
  ['item-list', D1.concat(['--limit', '20']), 'raw'],
  ['cate-list', D1.concat(['--limit', '10']), 'raw'],
  ['spu-list', D1, 'raw'],
  ['interval-analysis', D1, 'raw'],
  ['macro-monitor', [], 'raw'],
  ['problem-alarm', [], 'raw'],
  ['item-relate', D7.concat(['--limit', '10']), 'raw'],
  ['video-list', D7.concat(['--limit', '30']), 'raw'],
  ['new-product-overview', D1, 'raw'],
  ['new-product-list', D1.concat(['--limit', '20']), 'raw'],
  ['new-product-trend', D1, 'raw'],
  ['sale-shop-list', D1.concat(['--limit', '20']), 'raw'],
  ['sale-item-list', D1.concat(['--limit', '20']), 'raw'],
  ['refund-item-list', D1.concat(['--limit', '20']), 'raw'],
  ['refund-all-list', D1.concat(['--limit', '20']), 'raw'],
  ['refund-origin-analysis', D1, 'raw'],
  ['reception-list', D1.concat(['--limit', '20']), 'raw'],
  ['evaluation-list', D1.concat(['--limit', '20']), 'raw'],
  ['sale-cs-list', D1.concat(['--limit', '20']), 'raw'],
  ['inquiry-loss-list', D1.concat(['--limit', '20']), 'raw'],
  ['slow-rsps-list', D1.concat(['--limit', '20']), 'raw'],
  ['list', D1.concat(['--size', '10']), 'stdout'],
  ['fetch-recent', D1.concat(['--limit', '5']), 'out'],
  ['live-guide-overview', [], 'raw'],
  ['live-guide-trend', [], 'raw'],
  ['preheating-metrics', [], 'raw'],
  ['menu', [], 'raw'],
  ['excel-tasks', [], 'stdout'],
]

const ITEM_CMDS = [
  ['item-360', D1, 'raw'],
  ['item-sku-list', D7, 'raw'],
  ['item-sku-list-live', ['--live'], 'raw'],
  ['item-flow-source', D1, 'raw'],
  ['item-refund', D7, 'raw'],
  ['item-profile', D1, 'raw'],
  ['item-loss-risk', D1, 'raw'],
  ['item-detail', D1, 'raw'],
  ['item-price', D1, 'raw'],
  ['item-title', D1, 'raw'],
  ['item-bundle', D1, 'raw'],
  ['item-content', D7, 'raw'],
  ['item-service', D7, 'raw'],
]

/**
 * 三条裸探测。sycm-cli 没有封装这三个页面的命令，但接口本身在
 * `sycm.taobao.com` 域下，插件的白名单放行，用 `api` 命令可以直接调。
 *
 * 路径与参数取自旧 CDP 链路录到的真实请求（`data/daily/<店铺>/<日期>/_manifest.json`），
 * 不是猜的。改动时优先对照那份记录，不要凭页面路径推。
 */
const API_CMDS = [
  [
    'channel-tree',
    '/flow/shop/source/tree/platform/support.json',
    [
      ['dateRange', `${DATE}|${DATE}`],
      ['dateType', 'day'],
      ['order', 'desc'],
      ['orderBy', 'uv'],
      ['flowBizType', 'all'],
      ['pageType', 'all'],
      ['needCate', 'true'],
      ['indexCode', 'uv,cartByrCnt,payByrCnt,payAmt,payRate'],
    ],
  ],
  [
    'area-list',
    '/bda/visitor/distribution/listAreas.json',
    [
      ['dateType', 'day'],
      ['dateRange', `${DATE}|${DATE}`],
      ['device', '0'],
    ],
  ],
  [
    'keyword-list',
    '/flow/v4/shop/wordAide/drainageSearch.json',
    [
      ['dateRange', `${DATE}|${DATE}`],
      ['dateType', 'day'],
      ['pageSize', '50'],
      ['page', '1'],
      ['order', 'desc'],
      ['orderBy', 'uv'],
      ['device', '2'],
      ['kwType', 'se_keyword'],
      ['indexCode', 'uv,goodsCartByrCnt,goodsCltByrCnt,payOrderUserCnt,payConvertRate'],
    ],
  ],
  /*
   * 流量总览。补 summary 缺的四项（itmUv / bounceRate / itmAvgPv / newPayByrCnt），
   * 顺带补 daily 的 itemVisitors。
   *
   * 旧导出脚本里这个接口是按「内容」认的，不是按文件名：同一个页面还会出现
   * 「实时退款总览」，它的 data 里嵌一层且全是 null。这里路径写死，不存在歧义。
   *
   * indexCode 只传了四个值，但实测服务端返回全部 30 个字段，筛选参数不生效。
   */
  [
    'flow-overview',
    '/flow/new/guide/trend/overview.json',
    [
      ['dateRange', `${DATE}|${DATE}`],
      ['dateType', 'day'],
      ['device', '0'],
      ['indexCode', 'uv,itmUv,payByrCnt,payAmt'],
    ],
  ],
]

const TOTAL = SHOP_CMDS.length + ITEM_CMDS.length + API_CMDS.length
const SWITCH_WAIT_MS = 65_000

/* ── 执行工具 ─────────────────────────────────────────────────────────── */

const ENV = {
  ...process.env,
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
  PYTHONWARNINGS: 'ignore::SyntaxWarning',
  TB_STATE_ROOT: path.join(SYCM_ROOT, '.runtime'),
  PYTHONPATH: SYCM_ROOT,
}

/** 跑一条 tb 命令。返回 {code, stdout, stderr, seconds}。 */
function runTb(args, timeoutMs = 240_000) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(PYTHON, ['-m', 'tb', ...args], {
      cwd: SYCM_ROOT,
      env: ENV,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ code: 'timeout', stdout, stderr, seconds: 240 })
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: 'spawn_error', stdout, stderr: String(error), seconds: 0 })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr, seconds: Math.round((Date.now() - started) / 100) / 10 })
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function lastLine(text) {
  const lines = String(text).trim().split(/\r?\n/).filter(Boolean)
  return lines.length === 0 ? '' : lines[lines.length - 1].slice(0, 160)
}

/* ── 店铺槽位 ─────────────────────────────────────────────────────────── */

const slotsFile = path.join(ROOT, 'shops.config.json')
const SLOTS = JSON.parse(fs.readFileSync(slotsFile, 'utf8')).shops ?? []
/** 账号名就是槽位的 name。采哪几家由 collect=true 决定，测试残留（zz- 前缀）排除。
 *  --account 同时接受 name（梵禾）与 code（fanhe-main）：run-daily.ps1 的 -Shop
 *  传的是 code，两个脚本对接时不该要求调用方先做一次翻译。 */
const TARGETS = SLOTS.filter(
  (slot) =>
    slot.collect === true &&
    !String(slot.code).startsWith('zz-') &&
    (ONLY === null || slot.name === ONLY || slot.code === ONLY),
)

if (TARGETS.length === 0) {
  console.error(`没有可采集的店铺（collect=true 且名称匹配 ${ONLY ?? '任意'}）`)
  process.exit(3)
}

if (!fs.existsSync(PYTHON)) {
  console.error(`找不到 sycm-cli 的 Python：${PYTHON}`)
  console.error('先按 docs/ops/PLUGIN-COLLECTOR-PLAN-2026-10-25.md 装好 runtime/sycm-cli')
  process.exit(3)
}

/* ── 前置检查 ─────────────────────────────────────────────────────────── */

console.log(`目标日期 ${DATE}，7 天窗口 ${start} ~ ${DATE}`)
console.log(`店铺 ${TARGETS.map((slot) => `${slot.name}(${slot.code})`).join('、')}`)
console.log(`命令 ${TOTAL} 条/店，共 ${TOTAL * TARGETS.length} 次调用\n`)

if (DRY) {
  for (const slot of TARGETS) {
    console.log(`${slot.name}(${slot.code})`)
    for (const [name] of SHOP_CMDS) console.log(`  · ${name}`)
    for (const [name] of ITEM_CMDS) console.log(`  · ${name}（用本店热销第一名）`)
  }
  process.exit(0)
}

const doctor = await runTb(['sycm', 'doctor'], 120_000)
if (doctor.code !== 0) {
  console.error('插件或登录态不可用：')
  console.error(lastLine(doctor.stderr) || lastLine(doctor.stdout))
  console.error('处理：打开 Chrome，点一下取数桥图标唤醒插件，再确认已登录生意参谋')
  process.exit(3)
}
console.log('前置检查通过\n')

/* ── 主循环 ───────────────────────────────────────────────────────────── */

const results = []

for (const slot of TARGETS) {
  const account = slot.name
  const dayDir = path.join(ROOT, 'data', 'plugin', slot.code, DATE)
  fs.mkdirSync(dayDir, { recursive: true })

  console.log('='.repeat(56))
  console.log(`${account}（${slot.code}） -> ${path.relative(REPO, dayDir)}`)

  const switched = await runTb(['account', 'use', account], 180_000)
  if (switched.code !== 0) {
    console.error(`  切换账号失败：${lastLine(switched.stderr)}`)
    results.push({ shop: slot.code, name: 'switch', exit: switched.code, error: '切换账号失败' })
    continue
  }
  console.log(`  已切换到 ${account}，等 ${SWITCH_WAIT_MS / 1000} 秒让发射台页面重建`)
  await sleep(SWITCH_WAIT_MS)

  /*
   * 真实取数探测。
   *
   * 为什么不能只信 `account check`：它探的是卖家后台首页，与生意参谋的 session
   * 可能不同步。账号列表显示「上次检查还在」，实际取数却报 code=5810 未登录，
   * 这种不一致已经踩过两次，每次都是跑完 49 条才发现第一条就挂。
   * 这里用最轻的一条 home-overview 当探针，失败就跳过整家店。
   */
  const probeFile = path.join(dayDir, '_probe.json')
  const probe = await runTb(['sycm', 'home-overview', '--date', DATE, '--raw', '--out', probeFile])
  if (probe.code !== 0) {
    const reason = lastLine(probe.stderr) || lastLine(probe.stdout)
    console.error(`  ✗ 账号 ${account} 取数失败，跳过整家店：${reason}`)
    if (reason.includes('5810') || reason.includes('login')) {
      console.error(`    处理：在浏览器里重新登录 ${account}，再运行 account save ${account}`)
    }
    results.push({ shop: slot.code, account, index: 0, name: 'probe', exit: probe.code, seconds: probe.seconds, bytes: 0, error: reason })
    continue
  }
  console.log(`  探测通过（${probe.seconds}s），开始 ${TOTAL} 条命令`)

  let index = 0
  let itemId = null

  const exec = async (name, args, mode, seq = null) => {
    /* 序号可以由调用方指定：单品级命令可能整段跳过，靠自增会让后面三条探测错位。 */
    index = seq === null ? index + 1 : seq
    const realName = name === 'item-sku-list-live' ? 'item-sku-list' : name
    const outFile = path.join(dayDir, `${String(index).padStart(2, '0')}-${name}.json`)
    let cmd
    if (mode === 'api') {
      const [apiPath, pairs] = args
      cmd = ['sycm', 'api', apiPath]
      for (const [key, val] of pairs) cmd.push('--param', `${key}=${val}`)
    } else {
      cmd = ['sycm', realName, ...args]
      if (mode === 'raw') cmd.push('--raw', '--out', outFile)
      else if (mode === 'out') cmd.push('--out', outFile)
      else if (mode === 'stdout' && realName === 'list') cmd.push('--raw')
    }

    const result = await runTb(cmd)
    if ((mode === 'stdout' || mode === 'api') && result.stdout.trim() !== '') {
      fs.writeFileSync(outFile, result.stdout, 'utf8')
    }
    const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0
    const tag = result.code === 0 ? '' : ` ← ${lastLine(result.stderr)}`
    console.log(
      `  [${String(index).padStart(2, '0')}/${TOTAL}] ${name.padEnd(22)} exit=${result.code} ${String(result.seconds).padStart(5)}s ${String(size).padStart(7)}B${tag}`,
    )
    results.push({
      shop: slot.code, account, index, name, exit: result.code,
      seconds: result.seconds, bytes: size, error: result.code === 0 ? '' : lastLine(result.stderr),
    })
    return { result, outFile }
  }

  for (const [name, args, mode] of ONLY_API ? [] : SHOP_CMDS) {
    const { outFile } = await exec(name, args, mode)
    if (name === 'item-list') {
      try {
        const rows = JSON.parse(fs.readFileSync(outFile, 'utf8'))?.data?.data
        if (Array.isArray(rows) && rows.length > 0) {
          const first = rows[0]
          itemId = String(first?.item?.itemId ?? first?.itemId?.value ?? '')
        }
      } catch {
        /* 取不到 itemId 就跳过单品级命令 */
      }
      console.log(`        本店热销商品 ${itemId || '（没取到）'}`)
    }
  }

  if (ONLY_API) {
    console.log('  只补维度探测，跳过店铺级与单品级命令')
  } else if (itemId === '') {
    console.log('  没有 itemId，跳过单品级命令')
  } else {
    for (const [name, args, mode] of ITEM_CMDS) {
      await exec(name, ['--item-id', itemId, ...args], mode)
    }
  }

  /* 三条裸探测放在最后：它们不依赖 itemId，单品级失败时也要跑。序号固定，避免错位。 */
  const apiBase = SHOP_CMDS.length + ITEM_CMDS.length
  for (const [offset, [name, apiPath, pairs]] of API_CMDS.entries()) {
    await exec(name, [apiPath, pairs], 'api', apiBase + offset + 1)
  }
}

/* ── 汇总 ─────────────────────────────────────────────────────────────── */

const summaryDir = path.join(ROOT, 'data', 'plugin')
fs.mkdirSync(summaryDir, { recursive: true })
fs.writeFileSync(
  path.join(summaryDir, `_runs-${DATE}.json`),
  JSON.stringify({ date: DATE, window: { from: start, to: DATE }, runs: results }, null, 2),
  'utf8',
)

const ok = results.filter((row) => row.exit === 0).length
const bad = results.length - ok
console.log('\n' + '='.repeat(56))
console.log(`完成：成功 ${ok} / 失败 ${bad} / 共 ${results.length}`)
for (const slot of TARGETS) {
  const rows = results.filter((row) => row.shop === slot.code)
  const good = rows.filter((row) => row.exit === 0).length
  console.log(`  ${slot.name}(${slot.code}): ${good}/${rows.length}`)
}
if (bad > 0) {
  console.log('\n失败明细：')
  for (const row of results.filter((entry) => entry.exit !== 0)) {
    console.log(`  ${row.shop} ${String(row.index).padStart(2, '0')} ${row.name.padEnd(22)} ${row.error.slice(0, 100)}`)
  }
}

process.exit(bad > 0 ? 2 : 0)
