/**
 * 解析 `订单进度看板.md`，把 7 个订单的 14 个环节转成结构化对象。
 *
 * 这份看板是目前唯一经人工核验、不含污染金额的数据集，因此它是阶段判定的
 * 第三层（最高优先级）。解析失败必须显式报错，不得静默降级成「无数据」，
 * 否则下游会把「解析不出来」当成「这单不存在」。
 *
 * 看板有两种表形状，解析器都要认：
 *   单表：| 环节 | 开始 | 完成 | 状态 |
 *   多表：| 环节 | TW-01 首单 | TW-02 复购 1 | TW-03 复购 2 |
 *
 * 难点在第二层：单表有独立的「状态」列，多表只有一列自由文本，状态语义混在
 * 日期旁边。因此判定必须读文本，不能只看有没有日期。看板里这些写法都是陷阱：
 *   「2023-08-01 预安装沟通，完成日期未提及」有日期但环节未完成
 *   「2026-10-14 客户打扫完毕，待确认」有日期但未完结
 *   「2026-07-18 谈妥，07-24 进场」两个日期都只是沟通与进场时间
 */

import fs from 'node:fs'

/** 14 个环节的固定顺序与名称。序号来自看板第一节，不得重排。 */
export const BOARD_STAGES = [
  '客户订单接入',
  '测量',
  '设计',
  '合同',
  '生产',
  '出货',
  '运输',
  '送货',
  '安装',
  '是否有补件',
  '补件生产',
  '补件发货',
  '售后上门',
  '完结',
]

/** 环节序号折成契约状态。契约没有单独的「量尺」档，测量并入设计阶段。 */
const BOARD_STAGE_TO_CUSTOMER_STAGE = [
  'consulting', // 1 客户订单接入
  'designing', // 2 测量
  'designing', // 3 设计
  'contracted', // 4 合同
  'producing', // 5 生产
  'producing', // 6 出货
  'producing', // 7 运输
  'producing', // 8 送货
  'installed', // 9 安装
  'after_sales', // 10 是否有补件
  'after_sales', // 11 补件生产
  'after_sales', // 12 补件发货
  'after_sales', // 13 售后上门
  'closed', // 14 完结
]

/** 「未提及」「未开始」这类占位词不构成任何证据，整格跳过。 */
const NO_DATA = /^(未提及|未开始|无|未成交|未签约|—|-|\/|)$/

/**
 * 表明环节未完成的词。命中即判 `done: false`，即使旁边有日期。
 *
 * 「谈妥」是看板 TW-03 安装环节的原话，只表示安装方谈定报价，未代表完工。
 * 「未签」来自 BT-01 的「仅 2026-07-13 开定金收据，合同未签」：这行有日期，
 * 若不识别「未签」就会把只开了定金收据的单判成已签合同，阶段直接跳两档。
 */
const NOT_DONE_HINT =
  /未提及|未开始|未完结|未完成|未签|未付|未定|未确认|未闭环|未到货|尚未|待确认|进行中|待执行|待上门|谈妥/

/** 明确表明完成的词。命中即判 `done: true`。与上一条冲突时以否定词为准。 */
const DONE_HINT = /已完成|已完结|已收尾|已到货|已确认|已签约|完成|完工/

/** 完整日期 YYYY-MM-DD。 */
const FULL_DATE = /\d{4}-\d{2}-\d{2}/g

/** 弱日期 YYYY-MM，仅在「2026-02 起客户自装」这类记录里出现。 */
const WEAK_DATE = /\d{4}-\d{2}(?!-\d{2})/g

const EMPTY = Object.freeze({
  reached: false,
  done: false,
  start: null,
  end: null,
  imprecise: false,
  note: null,
})

/**
 * 判定单个环节的进展。单表把三列拼成一段文本传进来，多表直接传那一格。
 *
 * 返回值语义：
 *   `reached` 该环节已有动作，可据此认为客户走到了这里
 *   `done`    该环节已完成，可据此推进客户状态
 *   `imprecise` 只有年月没有日，日期不可直接入库，需要人工补
 */
export function judgeCell(raw) {
  const text = String(raw ?? '').trim()
  if (NO_DATA.test(text)) return { ...EMPTY }

  const full = [...text.matchAll(FULL_DATE)].map((m) => m[0])
  const weak = [...text.matchAll(WEAK_DATE)].map((m) => m[0])

  const hasFull = full.length > 0
  const hasWeak = weak.length > 0
  if (!hasFull && !hasWeak) {
    // 只有状态词，没有任何日期：视为未到达，但把原话留下供人工判断
    return { ...EMPTY, note: text }
  }

  const notDone = NOT_DONE_HINT.test(text)
  const doneHint = DONE_HINT.test(text)
  const start = hasFull ? full[0] : weak[0]
  const end = hasFull ? full[full.length - 1] : weak[weak.length - 1]

  return {
    reached: true,
    // 否定词优先：有「待确认」就不算完成，哪怕同时出现「已完成」
    done: notDone ? false : doneHint || !notDone,
    start,
    end,
    imprecise: !hasFull && hasWeak,
    note: text,
  }
}

/** 单表三列合并成一段文本再判定，保留「开始有日期、完成未提及、状态进行中」的全部线索。 */
function judgeSingleRow(startCell, endCell, statusCell) {
  const parts = [startCell, endCell, statusCell]
    .map((c) => String(c ?? '').trim())
    .filter((c) => !NO_DATA.test(c))
  return judgeCell(parts.join(' '))
}

/** 从表头里抽订单编号，例如「TW-01 首单」→ TW-01。抽不到时用传入的兜底值。 */
function orderCodeFromHeader(header, fallback) {
  const m = String(header).match(/\b([A-Z]{2,3}-\d{2})\b/)
  return m ? m[1] : fallback
}

/**
 * 解析整份看板。返回 `{ orders: Map<订单号, 订单>, customerOrders: Map<客户名, 订单号[]> }`。
 *
 * 以二级标题切段，每段一个客户。段内第一条表格若是单表形状，就是一单一节；
 * 若是多表形状，表头里的每一列各是一单。
 */
export function parseBoard(markdown) {
  const lines = markdown.split('\n')
  const orders = new Map()
  const customerOrders = new Map()

  let sectionTitle = null
  let sectionLines = []
  const flush = () => {
    if (!sectionTitle || sectionLines.length === 0) return
    for (const [code, order] of parseSection(sectionTitle, sectionLines)) {
      if (orders.has(code)) throw new Error(`看板里出现重复订单号 ${code}，解析器无法区分`)
      orders.set(code, order)
      const list = customerOrders.get(order.customerName) ?? []
      list.push(code)
      customerOrders.set(order.customerName, list)
    }
  }

  for (const line of lines) {
    const h2 = line.match(/^##\s+([一二三四五六七八九十]+)、\s*(.+)$/)
    if (h2) {
      flush()
      sectionTitle = h2[2].trim()
      sectionLines = []
      continue
    }
    if (sectionTitle) sectionLines.push(line)
  }
  flush()

  return { orders, customerOrders }
}

/**
 * 解析单个客户小节。返回 `Map<订单号, 订单>`。
 *
 * 客户名取自二级标题，形如「台湾 蔣文增（TW-01 首单 / TW-02 复购 1）」，
 * 括号前是「地区 姓名」，括号里是订单号与单次说明。
 */
function parseSection(title, lines) {
  const result = new Map()

  const head = title.match(/^(.+?)（(.+)）\s*$/)
  const namePart = (head ? head[1] : title).trim()
  const codePart = head ? head[2] : ''
  const knownCodes = [...codePart.matchAll(/\b([A-Z]{2,3}-\d{2})\b/g)].map((m) => m[1])

  const spaceIdx = namePart.indexOf(' ')
  const region = spaceIdx > 0 ? namePart.slice(0, spaceIdx) : ''
  const customerName = spaceIdx > 0 ? namePart.slice(spaceIdx + 1) : namePart

  const tables = []
  let current = null
  for (const line of lines) {
    if (/^\|/.test(line)) {
      if (!current) {
        current = []
        tables.push(current)
      }
      current.push(line)
    } else if (current) {
      current = null
    }
  }

  for (const table of tables) {
    const rows = table.map((r) =>
      r
        .split('|')
        .slice(1, -1)
        .map((c) => c.trim()),
    )
    if (rows.length < 2) continue
    const [header, ...body] = rows

    // 只认第一列是「1 客户订单接入」这种编号环节名的表
    if (!body.some((r) => /^\d+\s/.test(r[0] ?? ''))) continue

    const isSingle = header.length === 4 && /开始/.test(header[1]) && /完成/.test(header[2])
    const stageRows = body.filter((r) => /^\d+\s/.test(r[0]))

    if (isSingle) {
      const code =
        knownCodes[0] ?? orderCodeFromHeader(title, `${region.slice(0, 2).toUpperCase()}-01`)
      const steps = stageRows.map((r, idx) => ({
        index: Number(r[0].split(/\s/)[0]),
        name: BOARD_STAGES[idx] ?? r[0].replace(/^\d+\s*/, ''),
        ...judgeSingleRow(r[1], r[2], r[3]),
      }))
      result.set(code, { code, customerName, region, steps, shape: 'single' })
    } else {
      const cols = header.slice(1)
      knownCodes.forEach((known, colIdx) => {
        const code =
          known ?? orderCodeFromHeader(cols[colIdx], `${region.slice(0, 2).toUpperCase()}-01`)
        const steps = stageRows.map((r, idx) => ({
          index: Number(r[0].split(/\s/)[0]),
          name: BOARD_STAGES[idx] ?? r[0].replace(/^\d+\s*/, ''),
          ...judgeCell(r[colIdx + 1]),
        }))
        result.set(code, { code, customerName, region, steps, shape: 'multi' })
      })
    }
  }
  return result
}

/** 由已完成的环节推出客户当前状态。取最后一个「已完成」环节，映射到契约状态。 */
export function stageFromSteps(steps) {
  let stage = null
  for (const step of steps) {
    if (!step.done) continue
    const mapped = BOARD_STAGE_TO_CUSTOMER_STAGE[step.index - 1]
    if (mapped) stage = mapped
  }
  return stage
}

/** 最后一个有动作的环节，用于前端展示「当前进行到哪」。 */
export function currentStepOf(steps) {
  let last = null
  for (const step of steps) {
    if (step.reached) last = step
  }
  return last
}

export function loadBoard(filePath) {
  return parseBoard(fs.readFileSync(filePath, 'utf8'))
}

/**
 * 解析「复购判定依据」里的合同证据表，得到每单的真实合同额。
 *
 * 这是全库唯一可靠到订单级的金额来源。它的价值在糖糖姐身上最明显：
 * 首批 75000 加第二批 288000 得 363000，正好等于 `ai_schema` 记录的客户级
 * 已收金额。这说明客户级那个数本身没错，错的是把它和单次合同额相减。
 *
 * 返回 `Map<客户名, Map<序号, { amount, date, batch, note }>>`，序号从 1 开始。
 */
export function parseContractEvidence(markdown) {
  const lines = markdown.split('\n')
  const result = new Map()

  let inSection = false
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      inSection = /复购/.test(line)
      continue
    }
    if (!inSection || !/^\|/.test(line)) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim())
    if (cells.length < 3) continue
    const [customer, evidence, amountText] = cells
    if (!/合同/.test(evidence)) continue
    if (/^客户$/.test(customer)) continue

    const dateMatch = evidence.match(/(\d{4}-\d{2}-\d{2})/)
    const batchMatch = evidence.match(/(首|第一|第二|第三|第四|第五)批/)
    const seqMap = { 首: 1, 第一: 1, 第二: 2, 第三: 3, 第四: 4, 第五: 5 }
    const seq = batchMatch ? (seqMap[batchMatch[1]] ?? null) : null
    if (!seq) continue

    // 取第一个「N 元」作为合同额。「抹零后」「折美元」是补充口径，不进主字段。
    const amountMatch = amountText.match(/(\d+(?:\.\d+)?)\s*元/)
    if (!amountMatch) continue
    const amount = Number(amountMatch[1])

    const byCustomer = result.get(customer) ?? new Map()
    byCustomer.set(seq, {
      amount,
      date: dateMatch ? dateMatch[1] : null,
      batch: batchMatch[1],
      note: amountText,
    })
    result.set(customer, byCustomer)
  }
  return result
}
