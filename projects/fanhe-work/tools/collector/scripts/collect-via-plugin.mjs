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
/*
 * 服务洞察（csp）接口用的紧凑日期，如 `20261029`。与生意参谋的 `2026-10-29`
 * 不能混用：混用不报错，服务端当成非法区间返回空数组。
 */
const DATE_COMPACT = DATE.replaceAll('-', '')
const ONLY = option('account')
const DRY = flag('dry-run')
/* 只补三条维度探测。用于「主数据已在、只缺渠道/地域/搜索词」的补采，
   把单店耗时从二十分钟压到两三分钟，也避开插件长任务断连的窗口。 */
const ONLY_API = flag('only-api')
/*
 * 回填用的两个开关。
 *
 * --no-switch：跳过切换账号与 65 秒等待。回填时同一家店要连跑好几天，
 *   每天重切一次账号会白白多花一分多钟，而账号本来就没变。
 * --no-item：跳过单品级下钻。历史回填要的是逐日趋势，单品数据只对当天诊断
 *   有用，回填进来既占体积也没有查询场景。
 */
const NO_SWITCH = flag('no-switch')
const MINIMAL = flag('minimal')
/* --minimal 隐含跳过单品：最小集本来就只取逐日、商品榜与四条维度。 */
const NO_ITEM = flag('no-item') || MINIMAL
/*
 * --minimal：只跑能进看板的六条。
 *
 *   1 home-overview   逐日四项与 summary 九项
 *   9 item-list       商品榜
 *  50 channel-tree    渠道
 *  51 area-list       地域
 *  52 keyword-list    搜索词
 *  53 flow-overview   summary 补到十三项、daily 的商品访客
 *
 * 历史回填要的是趋势，订单明细、退款、客服对话这些只对当天诊断有用，回填进来
 * 既占体积又没有查询场景。十八次运行乘六条，十分钟能跑完；跑满三十六条要一小时。
 */
const MINIMAL_KEEP = new Set(['home-overview', 'item-list'])
/*
 * 命令名到固定序号。
 *
 * 序号不能靠自增：--minimal 只跑六条时，item-list 会变成第 2 条、文件叫
 * `02-item-list.json`，而适配器按完整清单的第 9 位找 `09-item-list.json`，
 * 于是商品榜整块读不到，导出显示 item 0 行。序号必须与完整清单的位置绑定。
 *
 * 这两个映射必须定义在 SHOP_CMDS / ITEM_CMDS 之后：顶层 const 会在模块求值时
 * 立即执行 map()，写在清单之前会踩 TDZ（Cannot access before initialization）。
 * 注意 `node --check` 查不出这类问题，它只做语法解析。
 */

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
  /*
   * 服务洞察（客服绩效）的两条汇总接口。
   *
   * `overview/layer` 才是数值来源。它按 `groupType` 返回三行，含义已用交叉验证
   * 确定，不是推断：
   *
   *   base_avg  本店当日实际值   ← 只取这一行
   *   avg       同行同层平均
   *   exc       同行同层优秀
   *
   * 判据（2026-10-29）：base_avg 的 cstUv1d=1、replyUv1d=1，与同一天
   * `reception-list` 只返回 1 条接待明细一致；`overview/list` 默认返回的那一层
   * value 也等于 base_avg 的 1，且它给的环比 mmValue=-50% 与「本期 1、上期 2」
   * 吻合。若误取 avg 行，得到的是同行平均（那天 20 人咨询、响应率 0.9903），
   * 数字像真的、但根本不是本店的。
   *
   * `overview/list` 是同一批指标的「定义 + 本店值」清单（key / name / value），
   * 只用于核对键名与本店值，不进 summary。
   *
   * 参数照抄 `data/csv30/INDEX.csv` 里的请求原文：`dateType=1d` + 紧凑日期。
   * 传 `dateType=day&dateRange=1d` 也返回 200，但 data 是空数组 —— 空数组不报错，
   * 很容易被当成「这天没有咨询」。
   *
   * 踩过的坑：在 Git Bash 里手工探测时，`/csp/api/...` 这种以斜杠开头的参数会被
   * MSYS 当成 Windows 路径改写（实际发出去的是
   * `/csp/api/D:/WorkBuddy/.../csp/api/core/monitor/overview/layer.json`），
   * 服务端 302，看起来像「接口整族下线」。Node 里没有这层转换，本脚本不受影响；
   * 手工复现时要加 `MSYS_NO_PATHCONV=1`。
   */
  [
    'service-layer',
    '/csp/api/core/monitor/overview/layer.json',
    [
      ['dateType', '1d'],
      ['startDate', DATE_COMPACT],
      ['endDate', DATE_COMPACT],
      ['excludeDates', ''],
    ],
  ],
  [
    'service-list',
    '/csp/api/core/monitor/overview/list',
    [
      ['dateType', 'day'],
      ['dateRange', '1d'],
      ['startDate', DATE_COMPACT],
      ['endDate', DATE_COMPACT],
      ['excludeDates', ''],
    ],
  ],
]

/*
 * 千牛（卖家中心）的两条待办计数。走 `tb qianniu`，**不是** `tb sycm`：
 * 两者是不同的平台描述（不同 host、不同会话钩子），命令不能混发。
 *
 * 为什么这两条必须单独取：它们是「此刻还欠着多少事」的快照，生意参谋里没有对应
 * 口径 —— 评价管理、问大家都不在 sycm 的菜单里（`35-menu.json` 只有「问大家分析」，
 * 那是同行声量，不是待办数）。
 *
 * 序号 56/57，接在六条裸探测（50~55）之后。写死而不自增：加命令时插在中间会让
 * 适配器按旧序号读错文件，而且**不报错**（读到隔壁那条，字段全空）。
 *
 * 耗时：`review-pending` 一次请求；`ask-pending` 要翻页把 104 条数完（六次请求），
 * 单店约 10 到 15 秒。比 36 条主命令便宜得多，所以不放进 `--minimal` 的开关里。
 */
const QIANNIU_CMDS = [
  ['qianniu-review-pending', ['--limit', '20'], 'raw'],
  ['qianniu-ask-pending', ['--page-size', '20', '--max-pages', '30', '--limit', '20'], 'raw'],
]
/** 千牛两条的起始序号。见上，固定在 55 之后。 */
const QIANNIU_BASE = SHOP_CMDS.length + ITEM_CMDS.length + API_CMDS.length

/* 命令名到完整清单位置。见上方注释，必须放在清单定义之后。 */
const SHOP_SEQ = new Map(SHOP_CMDS.map((entry, i) => [entry[0], i + 1]))
/** 单品级同理，接在店铺级之后，从 37 起。 */
const ITEM_SEQ = new Map(ITEM_CMDS.map((entry, i) => [entry[0], SHOP_CMDS.length + i + 1]))

/* 日志里的分母。序号本身固定（探测永远是 50 到 55、千牛 56 到 57，文件命名要稳定），
   这里只影响「[3/6]」这类显示。千牛两条两种模式都跑，所以加在括号外面。 */
const TOTAL =
  (ONLY_API
    ? API_CMDS.length
    : (MINIMAL ? MINIMAL_KEEP.size : SHOP_CMDS.length + (NO_ITEM ? 0 : ITEM_CMDS.length)) +
      API_CMDS.length) + QIANNIU_CMDS.length
/* 日志里的分母要的是「清单总长度」，不是「这一轮要跑几条」。`--only-api` 只跑 8 条
   但序号从 50 起（文件名必须固定），用 TOTAL 当分母会打成 `[50/8]`，看着像越界。 */
const SEQ_TOTAL = QIANNIU_BASE + QIANNIU_CMDS.length
const SWITCH_WAIT_MS = 65_000

/*
 * 断连自愈的判据与阈值。
 *
 * 只对「连接类」失败自愈。登录失效（5810）、日期窗口不合法（1003）、参数错误
 * 这些重连也没用，重试只是把同一句话多打几遍。实测插件在跑到 45 到 50 条、
 * 约二十分钟时会断连，表现为「没有连上浏览器插件」或「30 秒内没有返回结果」。
 */
const RECOVERABLE = /没有连上浏览器插件|30 秒内没有返回|等浏览器返回|127\.0\.0\.1/
/** 连续几条连接类失败才触发恢复。单条失败可能只是某个接口慢，不必立刻重连。 */
const FAIL_BEFORE_RECOVER = 2
/** 一家店最多恢复几次。超过就认为插件真的不行了，落盘退出，别无限重试。 */
const MAX_RECOVERIES = 4

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
    (ONLY === null || slot.name === ONLY || slot.code === ONLY || slot.pluginAccount === ONLY),
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
    if (ONLY_API) {
      console.log('  （只跑维度与汇总探测）')
    } else {
      const shopCmds = MINIMAL ? SHOP_CMDS.filter((entry) => MINIMAL_KEEP.has(entry[0])) : SHOP_CMDS
      for (const [name] of shopCmds) console.log(`  · ${name}`)
      if (!NO_ITEM) {
        for (const [name] of ITEM_CMDS) console.log(`  · ${name}（用本店热销第一名）`)
      }
    }
    for (const [name] of API_CMDS) console.log(`  · ${name}（裸探测）`)
    for (const [name] of QIANNIU_CMDS) console.log(`  · ${name}（千牛 ${QIANNIU_BASE + 1} 起）`)
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
  /* 插件里存的账号名是登录后的昵称（如「梵禾定制家具:小阳」），与店铺显示名（梵禾）
     不是一回事。用显示名去 `account use` 会精确匹配失败，所以优先读 pluginAccount。 */
  const account = slot.pluginAccount ?? slot.name
  const dayDir = path.join(ROOT, 'data', 'plugin', slot.code, DATE)
  fs.mkdirSync(dayDir, { recursive: true })

  console.log('='.repeat(56))
  console.log(`${account}（${slot.code}） -> ${path.relative(REPO, dayDir)}`)

  if (NO_SWITCH) {
    console.log('  跳过账号切换（--no-switch），假定当前就是该账号')
  } else {
    const switched = await runTb(['account', 'use', account], 180_000)
    if (switched.code !== 0) {
      console.error(`  切换账号失败：${lastLine(switched.stderr)}`)
      results.push({ shop: slot.code, name: 'switch', exit: switched.code, error: '切换账号失败' })
      continue
    }
    console.log(`  已切换到 ${account}，等 ${SWITCH_WAIT_MS / 1000} 秒让发射台页面重建`)
    await sleep(SWITCH_WAIT_MS)
  }

  /*
   * 真实取数探测。两种模式都要跑。
   *
   * 为什么不能只信 `account check`：它探的是卖家后台首页，与生意参谋的 session
   * 可能不同步。账号列表显示「上次检查还在」，实际取数却报 code=5810 未登录，
   * 这种不一致已经踩过两次，每次都是跑完几十条才发现第一条就挂。
   *
   * --no-switch 同样要探测：回填时同一家店连跑多天，某一天插件中途断连，下一天
   * 会直接撞上离线状态白跑六条。探测只要三秒，比白跑六条便宜得多。
   */
  const probeFile = path.join(dayDir, '_probe.json')
  const probe = await runTb(['sycm', 'home-overview', '--date', DATE, '--raw', '--out', probeFile])
  if (probe.code !== 0) {
    const reason = lastLine(probe.stderr) || lastLine(probe.stdout)
    console.error(`  ✗ 账号 ${account} 在 ${DATE} 取数失败，跳过这一天：${reason}`)
    if (reason.includes('5810') || reason.includes('login')) {
      console.error(`    处理：在浏览器里重新登录 ${account}，再运行 account save ${account}`)
    }
    results.push({ shop: slot.code, account, index: 0, name: 'probe', exit: probe.code, seconds: probe.seconds, bytes: 0, error: reason })
    continue
  }
  console.log(`  探测通过（${probe.seconds}s），开始 ${TOTAL} 条命令`)

  let index = 0
  let itemId = null
  /* 自愈状态：aborted 非空后本店剩余命令全部跳过，但已落盘的文件保留。 */
  let aborted = null
  let consecutiveFail = 0
  let recoveries = 0

  const exec = async (name, args, mode, seq = null, platform = 'sycm') => {
    if (aborted !== null) {
      return { result: { code: 'skipped', seconds: 0, stdout: '', stderr: '' }, outFile: null, skipped: true }
    }
    /* 序号可以由调用方指定：单品级命令可能整段跳过，靠自增会让后面三条探测错位。 */
    index = seq === null ? index + 1 : seq
    /* 千牛的 `qianniu-` 前缀只用于文件与日志 —— `tb qianniu` 的子命令本身不带它
       （review-pending / ask-pending），带过去会被 argparse 判成非法选择、exit=2。 */
    const realName =
      platform === 'qianniu'
        ? name.replace(/^qianniu-/, '')
        : name === 'item-sku-list-live'
          ? 'item-sku-list'
          : name
    const outFile = path.join(dayDir, `${String(index).padStart(2, '0')}-${name}.json`)
    let cmd
    if (mode === 'api') {
      const [apiPath, pairs] = args
      cmd = [platform, 'api', apiPath]
      for (const [key, val] of pairs) cmd.push('--param', `${key}=${val}`)
    } else {
      cmd = [platform, realName, ...args]
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
      `  [${String(index).padStart(2, '0')}/${SEQ_TOTAL}] ${name.padEnd(22)} exit=${result.code} ${String(result.seconds).padStart(5)}s ${String(size).padStart(7)}B${tag}`,
    )
    results.push({
      shop: slot.code, account, index, name, platform, exit: result.code,
      seconds: result.seconds, bytes: size, error: result.code === 0 ? '' : lastLine(result.stderr),
    })

    /* ---- 断连自愈 ---- */
    if (result.code === 0) {
      consecutiveFail = 0
      return { result, outFile }
    }
    /* 千牛不参与断连自愈：它排在最后，恢复成功也没有下一条要跑；而且它失败最常见
       的原因是卖家中心没登录，重连一百次也一样。让它只记一笔失败就够。 */
    if (platform === 'qianniu') return { result, outFile }
    const failureText = `${lastLine(result.stderr)} ${lastLine(result.stdout)}`
    if (!RECOVERABLE.test(failureText)) return { result, outFile }

    consecutiveFail += 1
    if (consecutiveFail < FAIL_BEFORE_RECOVER) return { result, outFile }

    if (recoveries >= MAX_RECOVERIES) {
      aborted = `连续 ${consecutiveFail} 条连接失败，已尝试 ${recoveries} 次恢复仍未通`
      console.error(`  ✗ ${aborted}`)
      console.error('    处理：打开浏览器，点一下取数桥图标唤醒插件，再重跑本店')
      return { result, outFile }
    }

    recoveries += 1
    consecutiveFail = 0
    console.log(`  连续失败，第 ${recoveries}/${MAX_RECOVERIES} 次尝试恢复连接…`)
    /* doctor 本身也要重试一次。2026-10-30 撞上过：桥其实活着（三十秒后手跑 doctor
       就全绿），但 doctor 那一次读回包时抛了 UnicodeDecodeError，一次偶发就把整店
       判死 —— 后面 13 条单品级 + 6 条探测 + 2 条千牛全部跳过，比插件的故障本身贵
       得多。偶发解码错误与「真断线」在 doctor 的退出码上分不出来，所以一律给两次。 */
    let doctor = null
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      doctor = await runTb(['sycm', 'doctor'], 150_000)
      if (doctor.code === 0) break
      const why = lastLine(doctor.stderr) || lastLine(doctor.stdout)
      console.error(`  doctor 第 ${attempt} 次失败：${why}`)
      if (attempt === 1) await sleep(5_000)
    }
    if (doctor?.code === 0) {
      console.log('  连接已恢复，继续')
      return { result, outFile }
    }
    aborted = `恢复失败：${lastLine(doctor?.stderr) || lastLine(doctor?.stdout) || 'doctor 无输出'}`
    console.error(`  ✗ ${aborted}`)
    console.error('    处理：打开浏览器，点一下取数桥图标唤醒插件，再重跑本店')
    return { result, outFile }
  }

  const shopCmds = ONLY_API
    ? []
    : MINIMAL
      ? SHOP_CMDS.filter((entry) => MINIMAL_KEEP.has(entry[0]))
      : SHOP_CMDS

  for (const [name, args, mode] of shopCmds) {
    /* 用完整清单里的位置作序号，--minimal 时文件仍然叫 09-item-list.json。 */
    const { outFile } = await exec(name, args, mode, SHOP_SEQ.get(name) ?? null)
    if (name === 'item-list' && outFile !== null) {
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
  } else if (NO_ITEM) {
    console.log('  跳过单品级下钻（--no-item），只取店铺级与维度')
  } else if (!itemId) {
    /* 判空用 `!itemId` 而不是 `=== ''`：`item-list` 空榜时（当天数据还没结算就是这种，
       回 `data.data: []`、recordCount 0）上面的解析走不到赋值，itemId 仍是初始的
       `null`，与 `''` 不相等 —— 于是 13 条单品级命令会带着 `--item-id null` 白跑一遍，
       每条都在服务端报错，最后整轮以 exit=2 收场。2026-10-30 实际撞上：那天 09:26 采
       当天，商品榜 0 行，白跑 13 条。 */
    console.log('  没有 itemId，跳过单品级命令')
  } else {
    for (const [name, args, mode] of ITEM_CMDS) {
      await exec(name, ['--item-id', itemId, ...args], mode, ITEM_SEQ.get(name) ?? null)
    }
  }

  /* 三条裸探测放在最后：它们不依赖 itemId，单品级失败时也要跑。序号固定，避免错位。 */
  const apiBase = SHOP_CMDS.length + ITEM_CMDS.length
  for (const [offset, [name, apiPath, pairs]] of API_CMDS.entries()) {
    await exec(name, [apiPath, pairs], 'api', apiBase + offset + 1)
  }

  /* 千牛两条待办计数。**失败不中断本店**：它们只喂服务板块两格，缺了照旧上报，
     不该因为卖家中心没登录就把 36 条主命令已经采到的数一起作废（落盘的文件仍在，
     但整店会被记成中断，看板上会显示成采集失败）。 */
  for (const [offset, [name, args, mode]] of QIANNIU_CMDS.entries()) {
    await exec(name, args, mode, QIANNIU_BASE + offset + 1, 'qianniu')
  }

  if (aborted !== null) {
    console.error(`  ${account} 中断：${aborted}`)
    results.push({
      shop: slot.code, account, index, name: 'abort', exit: 'abort',
      seconds: 0, bytes: 0, error: aborted,
    })
  } else if (recoveries > 0) {
    console.log(`  ${account} 完成，中途恢复过 ${recoveries} 次连接`)
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

/*
 * 千牛两条单独统计，**不计入退出码**。
 *
 * 理由：它们依赖的是「这个浏览器登录了卖家中心」，与生意参谋的登录态是两回事。
 * 二三店的卖家中心还没登过，如果混进 bad，每天都会以 exit=2 收场，而实际上
 * 36 条主命令全都采到了 —— 结果是「天天红，红到没人看」。所以：记录进
 * `_runs-<date>.json`、在终端单独打一行，但不改退出码。
 */
const ok = results.filter((row) => row.exit === 0).length
const qianniuRows = results.filter((row) => row.platform === 'qianniu')
const bad = results.filter((row) => row.platform !== 'qianniu' && row.exit !== 0).length
const badQianniu = qianniuRows.filter((row) => row.exit !== 0).length
console.log('\n' + '='.repeat(56))
console.log(`完成：成功 ${ok} / 失败 ${bad} / 共 ${results.length}`)
for (const slot of TARGETS) {
  const rows = results.filter((row) => row.shop === slot.code)
  const good = rows.filter((row) => row.exit === 0).length
  console.log(`  ${slot.name}(${slot.code}): ${good}/${rows.length}`)
}
if (qianniuRows.length > 0) {
  console.log(
    `千牛待办（评价待回复 / 问大家待回答）：成功 ${qianniuRows.length - badQianniu} / 失败 ${badQianniu}`,
  )
  for (const row of qianniuRows.filter((entry) => entry.exit !== 0)) {
    console.log(`  ${row.shop} ${row.name} ${row.error.slice(0, 100)}`)
    console.log('    处理：在采集浏览器里登录一次卖家中心（myseller.taobao.com）再重跑')
  }
}
if (bad > 0) {
  console.log('\n失败明细：')
  for (const row of results.filter((entry) => entry.platform !== 'qianniu' && entry.exit !== 0)) {
    console.log(`  ${row.shop} ${String(row.index).padStart(2, '0')} ${row.name.padEnd(22)} ${row.error.slice(0, 100)}`)
  }
}

process.exit(bad > 0 ? 2 : 0)
