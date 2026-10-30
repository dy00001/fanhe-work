/**
 * 插件采集结果 → 入库契约（ops-ingest.v1）。
 *
 * 与 export-daily-ingest.mjs 的分工
 *   那个读 CDP 旁路录制的原始响应（`data/daily/<店铺>/<日期>/<页面>/`），解析 17 个页面。
 *   本脚本读插件采集的命令输出（`<根>/<账号>/<序号>-<命令>.json`），一个命令一个文件。
 *   两者产出同一份契约，入库侧不区分来源，靠 `source` 与 `trigger` 留痕。
 *
 * 三条纪律（与 export-daily-ingest.mjs 一致，不复述理由）
 *   1. 缺就是缺，不补 0。
 *   2. 不猜结构，只解析这里逐个验证过的字段。
 *   3. 一个数只认一个来源。
 *
 * 店铺身份
 *   账号名（梵禾 / 雅素 / 简作）不是店铺代号。代号从 `shops.config.json` 按 name 匹配，
 *   名称也取自那里 —— ingest 的 upsert 会用 payload 的 name 覆盖库里的名字，写错就是静默改名。
 *
 * 用法
 *   node scripts/export-sycm-ingest.mjs --date 2026-10-24
 *   node scripts/export-sycm-ingest.mjs --date 2026-10-24 --root ../../runtime/sycm-cli/.tmp-all-3shop
 *   node scripts/export-sycm-ingest.mjs --date 2026-10-24 --account 梵禾 --out payload.json
 *   node scripts/export-sycm-ingest.mjs --date 2026-10-24 --stdout
 *
 * 退出码
 *   0 产出完成
 *   1 无法产出（目录不存在、店铺身份匹配不到、一个命令都没认出来）
 *   2 产出完成但核心指标缺失（需要人看一眼）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(ROOT, '..', '..')

/* ── 参数 ─────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)

function option(name, fallback = null) {
  const index = argv.indexOf(`--${name}`)
  if (index < 0) return fallback
  const value = argv[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}

function flag(name) {
  return argv.includes(`--${name}`)
}

/*
 * 触发方式，由调用方说明，不能写死。
 *
 * 写死 `manual` 的后果不是「少一个字段」，而是**库里再也分不清定时与人工**：
 * 每天 10:00 的自动化、用户点「立即同步」、开发手跑一条命令，三种来源的批次
 * 记录一模一样，排障时回答不了「昨天 10 点那一轮到底跑没跑」，只能翻日志，
 * 而日志会被下一轮覆盖。
 *
 * 取值限定在 schema 注释里的三种（`trigger` 是 VarChar(20)，故意不用枚举，
 * 但也不该随手造词）。拼错退回 manual，而不是让一个错词进库。
 */
const TRIGGER = (() => {
  const raw = String(option('trigger', 'manual'))
  return ['schedule', 'manual', 'backfill'].includes(raw) ? raw : 'manual'
})()

const DATE = option('date')
if (DATE === null || !/^\d{4}-\d{2}-\d{2}$/.test(DATE)) {
  console.error('必须给 --date YYYY-MM-DD（插件输出目录不带日期，不能靠猜）')
  process.exit(1)
}

const SOURCE_ROOT =
  option('root') ?? path.join(ROOT, 'data', 'plugin')
const ONLY_ACCOUNT = option('account')
const OUT_FILE = option('out')
const TO_STDOUT = flag('stdout')

/* ── 店铺身份 ─────────────────────────────────────────────────────────── */

/* ── 店铺身份 ─────────────────────────────────────────────────────────── */

const SLOTS = (() => {
  const file = path.join(ROOT, 'shops.config.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  return Array.isArray(raw.shops) ? raw.shops : []
})()

/**
 * 目录名到店铺槽位。
 *
 * 两种命名都支持：`collect-via-plugin.mjs` 落盘用 code（`fanhe-main`），
 * 早期手工脚本用账号名（`梵禾`）。先按 code 精确匹配，再按 name 匹配。
 * 不做模糊匹配：写错一个代号，数据会顶着别家店的名字入库，而且不报错。
 */
function slotFor(dirName) {
  return (
    SLOTS.find((slot) => slot.code === dirName) ??
    SLOTS.find((slot) => slot.name === dirName) ??
    null
  )
}

/**
 * 店铺目录。两种层级都支持：
 *   <root>/<店铺>/<序号>-<命令>.json            手工脚本的结构
 *   <root>/<店铺>/<日期>/<序号>-<命令>.json     采集器的结构
 */
function resolveShopDir(root, key) {
  const base = path.join(root, key)
  if (!fs.existsSync(base)) return null
  const dated = path.join(base, DATE)
  try {
    if (fs.statSync(dated).isDirectory()) return dated
  } catch {
    /* 没有日期子目录，按扁平结构处理 */
  }
  return base
}

/* ── 读取工具 ─────────────────────────────────────────────────────────── */

/** 按序号前缀找文件。命令名可能带后缀（item-sku-list-live），所以只认序号。 */
function readCommand(dir, index) {
  const prefix = String(index).padStart(2, '0') + '-'
  let names
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
  } catch {
    return null
  }
  if (names.length === 0) return null
  const file = path.join(dir, names[0])
  try {
    return { file: names[0], json: JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (error) {
    console.error(`  ${names[0]} 解析失败：${error.message}`)
    return null
  }
}

/** 生意参谋的字段值多为 {value, cycleCrc, syncCrc}。取 value，null 原样返回。 */
function value(cell) {
  if (cell === null || cell === undefined) return null
  if (typeof cell === 'object' && !Array.isArray(cell)) {
    return cell.value === undefined ? null : cell.value
  }
  return cell
}

/** 元转分。只在生产者一侧做一次，避免重复换算。 */
function fen(cell) {
  const raw = value(cell)
  if (raw === null || raw === undefined) return null
  const num = Number(raw)
  if (!Number.isFinite(num)) return null
  return Math.round(num * 100)
}

function int(cell) {
  const raw = value(cell)
  if (raw === null || raw === undefined) return null
  const num = Number(raw)
  return Number.isFinite(num) ? Math.round(num) : null
}

function num(cell) {
  const raw = value(cell)
  if (raw === null || raw === undefined) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function text(cell, limit) {
  const raw = value(cell)
  if (raw === null || raw === undefined) return ''
  return String(raw).slice(0, limit)
}

/* ── 命令序号表（与 .tmp-pull-3shop.py 的清单一致） ─────────────────────── */

const CMD = {
  homeOverview: 1,
  itemList: 9,
  /* 服务洞察的序号接在四条维度探测（50~53）之后。见 collect-via-plugin.mjs 的 API_CMDS。 */
  serviceLayer: 54,
  /* 千牛两条接在六条裸探测（50~55）之后，见 collect-via-plugin.mjs 的 QIANNIU_CMDS。 */
  reviewPending: 56,
  askPending: 57,
}

/**
 * summary 指标。键名与 api 侧 KPI 的 key 同构，接口取整段值时不必再维护翻译表。
 * 第三个元素为 true 表示金额，要转分。
 */
const SUMMARY_MAP = [
  ['payAmount', 'payAmt', true],
  ['payBuyers', 'payByrCnt', false],
  ['visitors', 'uv', false],
  ['itemVisitors', 'itmUv', false],
  ['payRate', 'payRate', false],
  ['orderValue', 'payPct', true],
  ['bounceRate', 'bounceRate', false],
  ['stayTime', 'stayTime', false],
  ['pv', 'pv', false],
  ['cartByrCnt', 'cartByrCnt', false],
  ['itmAvgPv', 'itmAvgPv', false],
  ['newPayByrCnt', 'newPayByrCnt', false],
  ['payOldByrCnt', 'payOldByrCnt', false],
]

/**
 * 客服洞察 `layer.json` 的 `base_avg` 行 → summary 键。
 *
 * 键名必须与 `packages/shared/src/ops.ts` 的 `OPS_SUMMARY_METRICS` 逐字一致：
 * 拼错不会报错，只会让界面一直显示「待接入」。四项都是单日口径，已列进
 * `OPS_DAILY_ONLY_SUMMARY_KEYS`。
 *
 * 响应时长是**秒**（实测 23.380952），不是分钟 —— 契约里 unit 也写成 `second`。
 */
const SERVICE_LAYER_FIELDS = [
  ['csThreeMinRate', 'manReplyRate3Min'],
  ['csAvgReplySec', 'avgReplyDur1d'],
  ['csConsultUv', 'cstUv1d'],
  ['csReplyUv', 'replyUv1d'],
]

/* ── 千牛待办计数 ─────────────────────────────────────────────────────── */

/**
 * 东八区的某一天（0 = 今天，-1 = 昨天）。用 `sv-SE` 而不是自己拼 `getMonth()+1`：
 * 那个格式恰好是 `YYYY-MM-DD`，且 `timeZone` 走的是 ICU 时区数据库，不受机器本地时区影响。
 */
function shanghaiDate(offsetDays = 0) {
  return new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString('sv-SE', {
    timeZone: 'Asia/Shanghai',
  })
}

/**
 * 评价待回复 / 问大家待回答 → summary 两行。
 *
 * **两条口径决定，都不能省：**
 *
 *   1. **只允许「今天或昨天」这两个窗口，再往前一律跳过。**
 *      这两个是**采集那一刻的待办快照**，平台没有历史口径（不能问「10-24 那天还欠
 *      多少条」）。日常这一轮窗口是 T-1（`run-daily.ps1` 默认 `AddDays(-1)`），把快照
 *      记在 T-1 上可以接受 —— 服务页整页本来就是 T-1 口径，多标一天反而不一致。
 *      要挡的是**回填**：`--date 2026-10-01` 时照填，会让半个月前的窗口突然冒出
 *      「今天欠 48 条」，数字看着正常但它是假的，页面上还分不出来。
 *      偏差最多一天，是有意的取舍，不是没想过。
 *
 *   2. **登录账号对不上就不入库。** 千牛接口只认「浏览器里现在登录的是谁」，不认
 *      调用方以为是谁。多店采集是一个循环里逐店切账号，切失败时甲店的 48 条会顶着
 *      乙店的名字入库，**全程不报错**。模块的 `--raw` 落盘里带了 `account.nick`，
 *      这里逐条比对槽位的 `pluginAccount`；对不上就丢弃并写进 notes。
 */
function appendQianniu({ dir, slot, notes, dimensions }) {
  const today = shanghaiDate(0)
  const yesterday = shanghaiDate(-1)
  if (DATE !== today && DATE !== yesterday) {
    notes.push(
      `千牛待办是采集时刻的快照，只记在今天（${today}）或昨天（${yesterday}）的窗口，` +
        `回填 ${DATE} 跳过`,
    )
    return
  }

  const expected = String(slot.pluginAccount ?? slot.name ?? '')
  const wanted = [
    ['rateUnrepliedCnt', CMD.reviewPending, 'total', '评价待回复'],
    ['wendaPendingCnt', CMD.askPending, 'pending', '问大家待回答'],
  ]

  for (const [key, index, field, label] of wanted) {
    const file = readCommand(dir, index)
    if (file === null) {
      notes.push(`缺 ${label}（第 ${index} 号文件），${key} 为空`)
      continue
    }
    const nick = String(file.json?.account?.nick ?? '')
    if (nick === '') {
      /* 老版本模块不写 account。不能因此丢数据，但要把「这份数没经过串店校验」
         说出来 —— 事后对不上数时，这条 note 是唯一的线索。 */
      notes.push(`${label} 的文件里没有登录账号，无法校验是否串店（运行时可能是旧版模块）`)
    } else if (expected !== '' && nick !== expected) {
      notes.push(`${label} 的登录账号是「${nick}」，与槽位「${expected}」不一致，丢弃不入库`)
      continue
    }

    const value = Number(file.json?.[field])
    if (!Number.isFinite(value)) {
      notes.push(`${label} 的回包里没有可用的 ${field}`)
      continue
    }
    dimensions.push({ type: 'summary', key, label: key, metrics: { value } })
  }
}

/* ── 单店转换 ─────────────────────────────────────────────────────────── */

function buildPayload(account) {
  const dir = resolveShopDir(SOURCE_ROOT, account)
  if (dir === null) {
    console.error(`  ${account}: 目录不存在 ${path.join(SOURCE_ROOT, account)}`)
    return null
  }
  const slot = slotFor(account)
  if (slot === null) {
    console.error(`  ${account}: shops.config.json 里没有 code 或 name 等于「${account}」的槽位，跳过`)
    return null
  }

  const notes = []
  const daily = []
  const dimensions = []

  /* 1. 逐日与 summary：同一个 home-overview 响应 */
  const home = readCommand(dir, CMD.homeOverview)
  if (home === null) {
    notes.push('缺 home-overview，逐日与 summary 全部为空')
  } else {
    const self = home.json?.content?.data?.self
    if (self === undefined || self === null) {
      notes.push('home-overview 响应里没有 content.data.self')
    } else {
      daily.push({
        date: DATE,
        payAmountFen: fen(self.payAmt),
        visitors: int(self.uv),
        payBuyers: int(self.payByrCnt),
        itemVisitors: int(self.itmUv), // 该接口不提供，保持 null
      })

      for (const [key, field, isMoney] of SUMMARY_MAP) {
        if (self[field] === undefined) {
          notes.push(`summary 缺字段 ${field}`)
          continue
        }
        const cell = self[field]
        const out = isMoney ? fen(cell) : key === 'payRate' ? num(cell) : int(cell)
        if (out === null) {
          notes.push(`summary ${key} 为空值，跳过`)
          continue
        }
        dimensions.push({ type: 'summary', key, label: key, metrics: { value: out } })
      }
    }
  }

  /* 2. item 维度：item-list，与现有 CDP 方案的 item_view_top 是同一接口 */
  const items = readCommand(dir, CMD.itemList)
  if (items === null) {
    notes.push('缺 item-list，商品维度为空')
  } else {
    const rows = items.json?.data?.data
    if (!Array.isArray(rows)) {
      notes.push('item-list 响应里没有 data.data 数组')
    } else {
      for (const entry of rows) {
        const item = entry?.item ?? {}
        const key = text(entry?.itemId, 120) || text(item.itemId, 120)
        if (key === '') continue
        const label = text(item.title, 300) || key
        dimensions.push({
          type: 'item',
          key,
          label,
          metrics: {
            visitors: int(entry.itmUv),
            payAmountFen: fen(entry.payAmt),
            payBuyers: int(entry.payByrCnt),
            payRate: num(entry.payRate),
            cartFen: fen(entry.crtAmt),
            favorites: int(entry.itemCltByrCnt),
          },
        })
      }
    }
  }

  /* 3. channel：渠道树，递归展开 children。只收有 pageName 且有 uv 的节点，
        没有 uv 的多是分组标题，收进来会在榜上显示成一堆 0 访客的空行。 */
  const channelFile = readCommand(dir, 50)
  if (channelFile === null) {
    notes.push('缺 channel-tree 探测，渠道维度为空')
  } else {
    const tree = channelFile.json?.data
    let depthLimit = 0
    const walkTree = (nodes, depth) => {
      if (!Array.isArray(nodes) || depth > 4) return
      depthLimit = Math.max(depthLimit, depth)
      for (const node of nodes) {
        const name = text(node?.pageName, 120)
        const uv = int(node?.uv)
        if (name !== '' && uv !== null) {
          dimensions.push({
            type: 'channel',
            key: name,
            label: name,
            metrics: {
              visitors: uv,
              payBuyers: int(node?.payByrCnt),
              payRate: num(node?.payRate),
              payAmountFen: fen(node?.payAmt),
            },
          })
        }
        walkTree(node?.children, depth + 1)
      }
    }
    walkTree(tree, 0)
    if (dimensions.filter((dim) => dim.type === 'channel').length === 0) {
      notes.push('channel-tree 响应里没有可用节点')
    }
  }

  /* 4. area：地域分布 */
  const areaFile = readCommand(dir, 51)
  const areaRows = areaFile?.json?.data?.areaUv
  if (!Array.isArray(areaRows)) {
    notes.push('缺 area-list 探测或结构不符，地域维度为空')
  } else {
    for (const row of areaRows) {
      const name = text(row?.name, 120)
      if (name === '') continue
      dimensions.push({
        type: 'area',
        key: name,
        label: name,
        metrics: {
          visitors: int(row?.uv),
          ratio: num(row?.ratio),
          orderRate: num(row?.orderRate),
          payBuyers: int(row?.orderBuyerCnt),
        },
      })
    }
  }

  /* 5. keyword：搜索引流词 */
  const keywordFile = readCommand(dir, 52)
  const keywordRows = keywordFile?.json?.data?.data
  if (!Array.isArray(keywordRows)) {
    notes.push('缺 keyword-list 探测或结构不符，搜索词维度为空')
  } else {
    for (const row of keywordRows) {
      const word = text(row?.seKeyword, 120)
      if (word === '') continue
      dimensions.push({
        type: 'keyword',
        key: word,
        label: word,
        metrics: {
          visitors: int(row?.uv),
          payBuyers: int(row?.payOrderUserCnt),
        },
      })
    }
  }

  /*
   * 6. 流量总览补 summary 缺的四项，顺带补 daily 的商品访客。
   *
   * home-overview 走的是 /portal/ 系列，不返回 itmUv / bounceRate / itmAvgPv /
   * newPayByrCnt。这四项只有 /flow/new/guide/trend/overview.json 有。
   *
   * 两个接口对 uv / payAmt 的口径相同（实测三家都一致），所以这里做一次对账：
   * 不一致就写进 notes 让人看，但保留 home-overview 的值，不静默覆盖。
   */
  const flowFile = readCommand(dir, 53)
  if (flowFile === null) {
    notes.push('缺 flow-overview 探测，summary 只能到 9 项')
  } else {
    const flow = flowFile.json?.data
    if (flow === null || typeof flow !== 'object') {
      notes.push('flow-overview 响应里没有 data 对象')
    } else {
      if (daily.length > 0) {
        const flowUv = int(flow.uv)
        const homeUv = daily[0].visitors
        if (flowUv !== null && homeUv !== null && flowUv !== homeUv) {
          notes.push(`访客口径不一致：home-overview ${homeUv} 对 flow-overview ${flowUv}，保留前者`)
        }
        const flowPay = fen(flow.payAmt)
        const homePay = daily[0].payAmountFen
        if (flowPay !== null && homePay !== null && flowPay !== homePay) {
          notes.push(`支付金额口径不一致：home-overview ${homePay} 对 flow-overview ${flowPay}，保留前者`)
        }
        if (daily[0].itemVisitors === null) {
          const itmUv = int(flow.itmUv)
          if (itmUv !== null) daily[0].itemVisitors = itmUv
        }
      }

      const have = new Set(
        dimensions.filter((dim) => dim.type === 'summary').map((dim) => dim.key),
      )
      const EXTRA = [
        ['itemVisitors', 'itmUv'],
        ['bounceRate', 'bounceRate'],
        ['itmAvgPv', 'itmAvgPv'],
        ['newPayByrCnt', 'newPayByrCnt'],
      ]
      for (const [key, field] of EXTRA) {
        if (have.has(key)) continue
        if (flow[field] === undefined) {
          notes.push(`flow-overview 缺字段 ${field}`)
          continue
        }
        const out = key === 'bounceRate' ? num(flow[field]) : int(flow[field])
        if (out === null) {
          notes.push(`flow-overview 的 ${field} 为空值`)
          continue
        }
        dimensions.push({ type: 'summary', key, label: key, metrics: { value: out } })
        /* 从 flow 补上了，就把 home 段留下的「缺字段」提示撤掉，否则日志里
           一边说补齐了 13 项，一边还在报四个字段缺失。 */
        const stale = notes.indexOf(`summary 缺字段 ${field}`)
        if (stale >= 0) notes.splice(stale, 1)
      }
    }
  }

  /*
   * 7. 服务洞察（客服绩效）。三分钟响应率只有这一个来源。
   *
   * 接口按 `groupType` 返回三行：`base_avg` 是本店当日实际值，`avg` 与 `exc` 是
   * 同行同层平均与优秀。**只取 base_avg**，取错行不会报错，只会把同行的
   * 响应率当成自己的显示出来。
   *
   * 判据（2026-10-29 实测）：base_avg 的 cstUv1d=1、replyUv1d=1，与同一天
   * reception-list 只有 1 条接待明细一致；overview/list 默认那层的 value 也是 1，
   * 且它给的环比 -50% 与「本期 1、上期 2」吻合。而 avg 行那天是 20 人咨询、
   * 响应率 0.9903 —— 与本店实际完全不是一回事。
   *
   * 比率按 0~1 存（`formatPercent` 会乘 100），不做百分数换算。
   */
  const svcFile = readCommand(dir, CMD.serviceLayer)
  if (svcFile === null) {
    notes.push('缺 service-layer 探测，summary 少 4 项客服指标')
  } else {
    const rows = svcFile.json?.data
    if (!Array.isArray(rows)) {
      notes.push('service-layer 响应里没有 data 数组')
    } else {
      const self = rows.find((row) => row?.groupType === 'base_avg')
      if (self === undefined) {
        /* 三行都不在、或者只有 avg/exc，说明接口语义变了。此时宁可缺这几项，
           也不能退回取 avg —— 那是别人的数。 */
        notes.push('service-layer 里没有 base_avg 行，不取 avg/exc')
      } else {
        /* 一行 base_avg 里同时带着四个本店指标，逐项取。缺哪项就只缺哪项，
           不因为一个字段没了就整块放弃 —— 响应率在、响应时长不在是可能的。 */
        for (const [key, field] of SERVICE_LAYER_FIELDS) {
          const value = num(self[field])
          if (value === null) {
            notes.push(`service-layer 的 base_avg 行没有 ${field}`)
            continue
          }
          dimensions.push({ type: 'summary', key, label: key, metrics: { value } })
        }
      }
    }
  }

  /* 8. 千牛的待办计数。排在最后：它读的是第 56/57 号文件，与上面各段互不影响，
        失败只留 note，不会让逐日或 17 项核心指标跟着断。 */
  appendQianniu({ dir, slot, notes, dimensions })

  return {
    payload: {
      contractVersion: 1,
      shop: {
        code: slot.code,
        name: slot.name,
        platform: slot.platform ?? 'taobao',
        sellerNick: null,
      },
      window: { from: DATE, to: DATE },
      source: 'api',
      trigger: TRIGGER,
      rawPath: path.relative(REPO, dir).replace(/\\/g, '/').slice(0, 300),
      daily,
      dimensions,
    },
    notes,
  }
}
/* ── 主流程 ───────────────────────────────────────────────────────────── */

if (!fs.existsSync(SOURCE_ROOT)) {
  console.error(`采集根目录不存在：${SOURCE_ROOT}`)
  process.exit(1)
}

const accounts = fs
  .readdirSync(SOURCE_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => {
    if (ONLY_ACCOUNT === null) return true
    if (name === ONLY_ACCOUNT) return true
    const slot = slotFor(name)
    return slot !== null && slot.name === ONLY_ACCOUNT
  })
  .sort()

if (accounts.length === 0) {
  console.error(`在 ${SOURCE_ROOT} 下没有找到任何店铺目录`)
  process.exit(1)
}

const produced = []
let missingCore = false

for (const account of accounts) {
  console.log(`\n${account}`)
  const result = buildPayload(account)
  if (result === null) continue
  const { payload, notes } = result
  const itemRows = payload.dimensions.filter((dim) => dim.type === 'item').length
  const summaryRows = payload.dimensions.filter((dim) => dim.type === 'summary').length
  console.log(
    `  店铺 ${payload.shop.code}（${payload.shop.name}）  daily ${payload.daily.length} 行  item ${itemRows} 行  summary ${summaryRows} 项`,
  )
  if (notes.length > 0) {
    for (const note of notes) console.log(`    · ${note}`)
  }
  /* 满配 17 项：home-overview 的 13 项 + 服务洞察 4 项（响应率、响应时长、咨询、接待）。
     少一项就要人看一眼 —— ingest 按类型清行，上报几项就把同窗口清到几项。 */
  if (payload.daily.length === 0 || summaryRows < 17) missingCore = true
  produced.push(payload)
}

if (produced.length === 0) {
  console.error('\n没有任何店铺产出 payload')
  process.exit(1)
}

if (TO_STDOUT) {
  console.log('\n' + JSON.stringify(produced.length === 1 ? produced[0] : produced, null, 2))
} else if (OUT_FILE !== null) {
  const target = path.resolve(OUT_FILE)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, JSON.stringify(produced.length === 1 ? produced[0] : produced, null, 2), 'utf8')
  console.log(`\n已写入 ${target}`)
} else {
  const dir = path.join(ROOT, 'data', 'payload', DATE)
  fs.mkdirSync(dir, { recursive: true })
  for (const payload of produced) {
    const file = path.join(dir, `${payload.shop.code}.json`)
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
  }
  console.log(`\n已写入 ${path.relative(REPO, dir)}/ 共 ${produced.length} 份`)
}

console.log(`\n提示：summary 少于 17 项时不要开自动上报。ingest 按类型清行，`)
console.log(`      上报了几项就把同窗口的 summary 清到几项，缺的那几项会被删掉。`)

process.exit(missingCore ? 2 : 0)
