/**
 * 把 data/csv30 导出成入库契约 JSON（ops-ingest.v1）。
 *
 * 为什么要有这一步：采集器与平台之间只认一份契约，不认 CSV。CSV 是给人看的中间产物，
 * 列名随接口变化，单位是元；契约是给机器看的，列名固定，金额统一为分。把「读哪个
 * CSV、取哪一列」集中在这个文件里，将来接口字段改名只需要改这里，API 侧一行不动。
 *
 * 取数复用 lib/preview-source.mjs 的 derive()：那份逻辑同时被页面常量生成与对账脚本
 * 使用，是「csv30 长什么样」的唯一事实来源。这里再写一套解析，就会出现「页面显示的
 * 数与入库的数按两套规则算出来」这种最难查的不一致。
 *
 * 用法：
 *   node scripts/export-ingest.mjs           写到 data/ingest/ops-ingest.json
 *   node scripts/export-ingest.mjs --stdout   只打印，不落盘
 */
import fs from 'node:fs'
import path from 'node:path';

import { ROOT, derive } from './lib/preview-source.mjs'

/** 元 → 分。整数分是入库单位，换算只在这里发生一次。 */
const fen = (v) => (v === null || v === undefined ? null : Math.round(v * 100))

/** 契约里的日期只接受 YYYY-MM-DD，其余一律当无效值。 */
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

const d = derive()

/* ── 逐日 ────────────────────────────────────────────────────────────────
   支付金额来自 trade-detail 的逐日倾向表，访客 / 买家 / 商品访客来自
   flow-overview 的逐日多指标表。两份表的日期集合不一定完全相同，按日期左连接，
   缺失的那一侧留 null 而不是补 0 —— 补 0 会被下游当成「当天确实是零」。 */
const flowByDate = new Map(d.DAILY_FLOW.map((r) => [r.d, r]))
const daily = d.DAILY.filter((r) => isDate(r.d)).map((r) => {
  const flow = flowByDate.get(r.d)
  return {
    date: r.d,
    payAmountFen: fen(r.amt),
    visitors: flow ? flow.uv : null,
    payBuyers: flow ? flow.byr : null,
    itemVisitors: flow ? flow.itmUv : null,
  }
})

const dates = daily.map((r) => r.date).sort()
const from = dates[0]
const to = dates[dates.length - 1]

/* ── 维度快照 ────────────────────────────────────────────────────────────
   这些是「整段口径」：接口只给了 30 天合计，没有逐日序列。因此它们必须带着
   自己的窗口入库（statFrom / statTo），不能被当成某一天的数。 */
const dimensions = []

for (const c of d.CHANNELS) {
  dimensions.push({
    type: 'channel',
    key: c.name,
    label: c.name,
    metrics: {
      visitors: c.uv,
      ratio: c.ratio,
      cycleCrc: c.crc,
      rivalAvg: c.avg,
      rivalGood: c.good,
      payBuyers: c.byr,
      payRate: c.rate,
      payAmountFen: fen(c.amt),
    },
  })
}

for (const it of d.ITEMS) {
  dimensions.push({
    type: 'item',
    key: it.id,
    label: it.title,
    metrics: {
      visitors: it.uv,
      payAmountFen: fen(it.amt),
      payBuyers: it.byr,
      payRate: it.rate,
      cartFen: fen(it.cart),
      favorites: it.clt,
    },
  })
}

for (const a of d.AREAS) {
  dimensions.push({
    type: 'area',
    key: a.name,
    label: a.name,
    metrics: { visitors: a.uv, ratio: a.ratio, orderRate: a.rate },
  })
}

for (const [word, uv] of d.KEYWORDS) {
  if (!word) continue
  dimensions.push({ type: 'keyword', key: word, label: word, metrics: { visitors: uv } })
}

for (const c of d.CONTENT) {
  dimensions.push({
    type: 'content',
    key: c.k,
    label: c.k,
    metrics: { visitors: c.uv, cycleCrc: c.crc, note: c.note },
  })
}

/* ── 整段指标（summary） ──────────────────────────────────────────────────
   比率、时长、客单价这类不能相加的量单独一档。它们与逐日表的区别写在
   ops-display 的「四档口径」里，前端据此给徽标，不允许默默混用。

   **键名与 KPI 的 key 一致**（payAmount / visitors / payRate …），这样接口取
   整段值时不必再维护一张翻译表。金额类的值一律换成「分」，与逐日表同单位 ——
   同一份响应里出现两种金额单位，是这类对接最容易留下的坑。 */
const SUMMARY_CELLS = [
  ['payAmount', d.AGG.payAmt, true],
  ['payBuyers', d.AGG.payByrCnt, false],
  ['visitors', d.AGG.uv, false],
  ['itemVisitors', d.AGG.itmUv, false],
  ['payRate', d.AGG.payRate, false],
  ['orderValue', d.AGG.payPct, true],
  ['bounceRate', d.AGG.bounceRate, false],
  ['stayTime', d.AGG.stayTime, false],
  ['pv', d.AGG.pv, false],
  ['cartByrCnt', d.AGG.cartByrCnt, false],
  ['itmAvgPv', d.AGG.itmAvgpv, false],
]

for (const [key, cell, isMoney] of SUMMARY_CELLS) {
  if (!cell || cell.v === null || cell.v === undefined) continue
  dimensions.push({
    type: 'summary',
    key,
    label: key,
    metrics: { value: isMoney ? fen(cell.v) : cell.v, cycleCrc: cell.c },
  })
}

dimensions.push(
  {
    type: 'summary',
    key: 'newPayByrCnt',
    label: 'newPayByrCnt',
    metrics: { value: d.BUYERS.newCnt, cycleCrc: d.BUYERS.newCrc },
  },
  {
    type: 'summary',
    key: 'payOldByrCnt',
    label: 'payOldByrCnt',
    metrics: { value: d.BUYERS.oldCnt, cycleCrc: d.BUYERS.oldCrc },
  },
  {
    type: 'summary',
    key: 'flowRecommendUv',
    label: 'flowRecommendUv',
    metrics: { value: d.FLOW_SPLIT.rec, cycleCrc: null },
  },
  {
    type: 'summary',
    key: 'flowSearchUv',
    label: 'flowSearchUv',
    metrics: { value: d.FLOW_SPLIT.search, cycleCrc: null },
  },
)

const payload = {
  contractVersion: 1,
  shop: {
    code: 'fanhe-main',
    name: '梵禾',
    platform: 'taobao',
    sellerNick: null,
  },
  window: { from, to },
  source: 'report',
  trigger: 'backfill',
  rawPath: 'tools/collector/data/csv30',
  daily,
  dimensions,
}

const json = JSON.stringify(payload, null, 2)

if (process.argv.includes('--stdout')) {
  console.log(json)
} else {
  const outDir = path.join(ROOT, 'data', 'ingest')
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, 'ops-ingest.json')
  fs.writeFileSync(outFile, json, 'utf8')

  const counts = dimensions.reduce((acc, row) => {
    acc[row.type] = (acc[row.type] ?? 0) + 1
    return acc
  }, {})
  console.log(`窗口 ${from} ~ ${to}`)
  console.log(`逐日 ${daily.length} 行；维度合计 ${dimensions.length} 行 ${JSON.stringify(counts)}`)
  console.log(`已写入 ${path.relative(ROOT, outFile)}`)
}
