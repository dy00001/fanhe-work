/**
 * 客户与订单的干跑导入（不写数据库）。
 *
 * 目的：在建表之前，把 53 个客户、56 张订单、金额净化结果、阶段仲裁结果全部
 * 摆出来，逐条可核对。它不碰 Prisma、不碰容器，跑一次几秒钟，随时可以重跑。
 *
 * 用法（在 projects/fanhe-work 下）：
 *   node tools/crm/dryrun.mjs
 *   node tools/crm/dryrun.mjs --aliases data/customer-aliases.json --out data/customer-import-preview.json
 *
 * 输出去向：
 *   明细 JSON 含客户真名与手机号，只能落在 data/ 下（该目录已被 .gitignore 排除）
 *   控制台报告只含统计数字与显示名
 */

import fs from 'node:fs'
import path from 'node:path'

import { loadBoard, parseContractEvidence, stageFromSteps, currentStepOf } from './parse-board.mjs'
import { arbitrateStage, sanitizeAmount, validateNodes, STAFF_PHONES } from './rules.mjs'

const DEFAULTS = {
  aliases: 'data/customer-aliases.json',
  board: 'F:/liaotianjil-fenxi/订单进度看板.md',
  chatDir: 'D:/Obsidian/个人知识库/客户聊天记录库',
  out: 'data/customer-import-preview.json',
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (!key.startsWith('--')) continue
    const name = key.slice(2)
    const value = argv[i + 1]
    if (value && !value.startsWith('--')) {
      opts[name] = value
      i += 1
    }
  }
  return opts
}

/** 消息行固定为 `| YYYY-MM-DD HH:MM | 发送人 | 内容 |`。用 split 过滤而非 match，
 * 因为 match 对同一行只返回一次且会漏掉紧邻的行。 */
function extractMessages(text) {
  return text.split('\n').filter((line) => /^\| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \|/.test(line))
}

/** frontmatter 有两块是常态（44/55），业务字段在 AI 块，身份字段在标准块。 */
function splitFrontmatter(text) {
  const parts = text.split(/^---$/m)
  const blocks = []
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] !== undefined) blocks.push(parts[i])
  }
  return {
    standard: blocks.find((b) => /^username:/m.test(b)) ?? '',
    ai:
      blocks.find((b) => /^ai_schema:/m.test(b)) ?? blocks.find((b) => /^合同金额:/m.test(b)) ?? '',
    count: blocks.length,
  }
}

function getField(block, key) {
  // 必须用 [ \t]* 而不是 \\s*：\\s 含换行，空值字段会把下一行的内容当成自己的值。
  // 实测「合同金额:」为空时，拿到的值是下一行的「已收金额: 0」。
  const m = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  if (!m) return null
  const value = m[1].trim().replace(/^"(.*)"$/, '$1')
  return value === '' ? null : value
}

function analyzeGroup(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const fm = splitFrontmatter(text)
  const messages = extractMessages(text)

  const first = messages[0] ?? ''
  const last = messages[messages.length - 1] ?? ''
  const timeOf = (line) => {
    const m = line.match(/^\| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \|/)
    return m ? m[1] : null
  }

  const skipImg = Number((text.match(/已跳过\s*(\d+)\s*条图片消息/) ?? [])[1] ?? 0)
  const skipVoice = Number((text.match(/语音消息\s*(\d+)\s*条/) ?? [])[1] ?? 0)

  let nodes = null
  const nodesRaw = getField(fm.ai, '节点日期')
  if (nodesRaw) {
    try {
      nodes = JSON.parse(nodesRaw)
    } catch {
      nodes = null
    }
  }

  return {
    chatroom: getField(fm.standard, 'username'),
    msgRows: messages.length,
    declaredMsgCount: Number(getField(fm.standard, 'msg_count') ?? 0) || null,
    firstMessageAt: timeOf(first),
    lastMessageAt: timeOf(last),
    skipImg,
    skipVoice,
    frontmatterBlocks: fm.count,
    aiSchema: getField(fm.ai, 'ai_schema'),
    aiStage: getField(fm.ai, 'ai_stage') ?? getField(fm.ai, '阶段'),
    aiStageConf: Number(getField(fm.ai, 'ai_stage_conf') ?? 0) || null,
    contractRaw: getField(fm.ai, '合同金额'),
    receivedRaw: getField(fm.ai, '已收金额'),
    unpaidRaw: getField(fm.ai, '未收金额'),
    nodes,
  }
}

/**
 * 按别名表里的各种名字形态去查看板证据。看板写「蔣文增」，别名表的姓名是
 * 「蔣文增先生」，直接用 customerName 查会漏掉整个客户的三张订单。
 */
function lookupEvidence(evidenceMap, alias) {
  for (const key of [alias.customerName, alias.shortName, alias.displayName]) {
    if (key && evidenceMap.has(key)) return evidenceMap.get(key)
  }
  for (const [key, value] of evidenceMap) {
    if (alias.customerName && alias.customerName.includes(key)) return value
    if (alias.shortName && key.includes(alias.shortName)) return value
  }
  return null
}

/** 看板的客户名与别名表的短名做包含匹配。繁简一致时可直接命中。 */
function matchBoardCustomer(boardCustomerName, aliases) {
  return (
    aliases.find((a) => a.shortName === boardCustomerName) ??
    aliases.find((a) => (a.shortName ?? '').includes(boardCustomerName)) ??
    aliases.find((a) => boardCustomerName.includes(a.shortName ?? '@@')) ??
    null
  )
}

function main() {
  const opts = parseArgs(process.argv.slice(2))

  const aliasDoc = JSON.parse(fs.readFileSync(opts.aliases, 'utf8'))
  const aliases = aliasDoc.aliases
  const board = loadBoard(opts.board)
  const boardMarkdown = fs.readFileSync(opts.board, 'utf8')
  const contractEvidence = parseContractEvidence(boardMarkdown)

  // 看板 7 单按客户名挂到别名表
  const boardByChatroom = new Map()
  const boardUnmatched = []
  for (const [customerName, codes] of board.customerOrders) {
    const alias = matchBoardCustomer(customerName, aliases)
    if (!alias) {
      boardUnmatched.push({ customerName, codes })
      continue
    }
    boardByChatroom.set(
      alias.chatroom,
      codes.map((code) => board.orders.get(code)),
    )
  }

  const customers = []
  const orders = []
  const issues = []

  for (const alias of aliases) {
    // 别名表里的 group 存的是不带后缀的文件基名，这里统一补齐，两种形态都认
    const fileName = alias.group.endsWith('.md') ? alias.group : `${alias.group}.md`
    const filePath = path.join(opts.chatDir, fileName)
    if (!fs.existsSync(filePath)) {
      issues.push({ type: 'missing-group-file', displayName: alias.displayName, file: fileName })
      continue
    }
    const stats = analyzeGroup(filePath)
    const amount = sanitizeAmount(stats.contractRaw, stats.receivedRaw, stats.unpaidRaw)
    const boardOrders = boardByChatroom.get(alias.chatroom) ?? []
    const primaryOrder = boardOrders[0] ?? null
    const boardStage = primaryOrder ? stageFromSteps(primaryOrder.steps) : null

    const arbitration = arbitrateStage({
      boardStage,
      aiStage: stats.aiStage,
      displayName: alias.displayName,
      shortName: alias.shortName,
    })

    const nodeViolations = validateNodes(stats.nodes)

    customers.push({
      chatroom: alias.chatroom,
      displayName: alias.displayName,
      shortName: alias.shortName,
      region: alias.region,
      regionScope: alias.regionScope,
      customerName: alias.customerName,
      phone: alias.phone,
      nameSource: alias.nameSource,
      primaryNickname: alias.primaryNickname,
      familyNicknames: alias.familyNicknames ?? [],
      confidence: alias.confidence,
      reviewStatus: alias.reviewStatus,
      repeatOf: alias.repeatOf ?? null,
      project: alias.project ?? null,
      groupFile: fileName,
      msgRows: stats.msgRows,
      firstMessageAt: stats.firstMessageAt,
      lastMessageAt: stats.lastMessageAt,
      skipImg: stats.skipImg,
      skipVoice: stats.skipVoice,
      aiSchema: stats.aiSchema,
      aiStageRaw: stats.aiStage,
      aiStageConf: stats.aiStageConf,
      stage: arbitration.stage,
      stageSource: arbitration.source,
      stageConflict: arbitration.conflict,
      stageCorrectionReason: arbitration.correctionReason ?? null,
      amount,
      nodeViolations,
      boardOrderCodes: boardOrders.map((o) => o.code),
    })

    // 有看板明细的客户，一单一条订单记录，环节逐条落
    if (boardOrders.length > 0) {
      boardOrders.forEach((order, idx) => {
        const stepStage = stageFromSteps(order.steps)
        const current = currentStepOf(order.steps)
        // 订单级金额只认看板的合同证据。客户级净化结果即使可用也不下放，
        // 因为无法确定它属于哪一单，下放等于凭空分配。
        const evidence = lookupEvidence(contractEvidence, alias)?.get(idx + 1) ?? null
        orders.push({
          code: order.code,
          chatroom: alias.chatroom,
          displayName: alias.displayName,
          seq: idx + 1,
          isRepeat: idx > 0,
          stage: stepStage,
          stageSource: 'board',
          currentStep: current
            ? {
                index: current.index,
                name: current.name,
                start: current.start,
                end: current.end,
                done: current.done,
              }
            : null,
          steps: order.steps,
          amount: evidence
            ? {
                contract: evidence.amount,
                received: null,
                unpaid: null,
                source: 'board-evidence',
                confidence: 'high',
                evidenceDate: evidence.date,
                evidenceNote: evidence.note,
              }
            : {
                contract: null,
                received: null,
                unpaid: null,
                source: 'none',
                confidence: 'none',
                evidenceDate: null,
                evidenceNote: '看板合同证据表未收录本单金额',
              },
        })
      })
    } else {
      orders.push({
        code: `ORD-${String(customers.length).padStart(3, '0')}`,
        chatroom: alias.chatroom,
        displayName: alias.displayName,
        seq: 1,
        isRepeat: false,
        stage: arbitration.stage,
        stageSource: arbitration.source,
        currentStep: null,
        steps: [],
        // 只有五级净化通过才下放到订单，且标低置信。净化不通过一律留空，
        // 宁可少一个数字，不要一个错数字进正式表。
        amount: amount.usable
          ? {
              contract: amount.contract,
              received: amount.received,
              unpaid: amount.unpaid,
              source: 'ai_schema-sanitized',
              confidence: 'low',
              evidenceDate: null,
              evidenceNote: amount.reason,
            }
          : {
              contract: null,
              received: null,
              unpaid: null,
              source: 'cleared',
              confidence: 'none',
              evidenceDate: null,
              evidenceNote: `${amount.level} ${amount.reason}`,
            },
      })
    }
  }

  // 客户级金额只做派生汇总，不再承载原始值。原始净化记录留在 customer.amount 供审计。
  const summaryByChatroom = new Map()
  for (const order of orders) {
    const acc = summaryByChatroom.get(order.chatroom) ?? {
      contractTotal: 0,
      ordersWithAmount: 0,
      orders: 0,
      sources: {},
    }
    acc.orders += 1
    if (order.amount.contract !== null) {
      acc.contractTotal += order.amount.contract
      acc.ordersWithAmount += 1
    }
    acc.sources[order.amount.source] = (acc.sources[order.amount.source] ?? 0) + 1
    summaryByChatroom.set(order.chatroom, acc)
  }
  for (const customer of customers) {
    const acc = summaryByChatroom.get(customer.chatroom) ?? {
      contractTotal: 0,
      ordersWithAmount: 0,
      orders: 0,
      sources: {},
    }
    customer.amountSummary = {
      contractTotal: acc.ordersWithAmount > 0 ? acc.contractTotal : null,
      ordersWithAmount: acc.ordersWithAmount,
      orders: acc.orders,
      sources: acc.sources,
    }
  }

  const stats = buildStats(customers, orders, issues, boardUnmatched, board)
  const preview = {
    generatedAt: new Date().toISOString(),
    sources: {
      aliases: opts.aliases,
      board: opts.board,
      chatDir: opts.chatDir,
    },
    staffPhones: STAFF_PHONES,
    stats,
    issues,
    boardUnmatched,
    customers,
    orders,
  }

  fs.mkdirSync(path.dirname(opts.out), { recursive: true })
  fs.writeFileSync(opts.out, JSON.stringify(preview, null, 2), 'utf8')

  printReport(preview, opts.out)
}

function buildStats(customers, orders, issues, boardUnmatched) {
  const count = (arr, key) => {
    const acc = {}
    for (const item of arr) {
      const k = item[key] ?? '(空)'
      acc[k] = (acc[k] ?? 0) + 1
    }
    return acc
  }

  const amountLevel = {}
  for (const c of customers) {
    const level = c.amount.usable ? 'usable' : c.amount.level
    amountLevel[level] = (amountLevel[level] ?? 0) + 1
  }

  const stageDist = {}
  for (const c of customers) {
    const k = c.stage ?? '(未定)'
    stageDist[k] = (stageDist[k] ?? 0) + 1
  }

  const conflicts = customers.filter((c) => c.stageConflict)
  const nodeBad = customers.filter((c) => c.nodeViolations.length > 0)

  const orderAmount = {}
  for (const order of orders) {
    orderAmount[order.amount.source] = (orderAmount[order.amount.source] ?? 0) + 1
  }
  const contractTotal = orders.reduce((a, o) => a + (o.amount.contract ?? 0), 0)

  return {
    orderAmountSource: orderAmount,
    orderContractTotal: contractTotal,
    ordersWithAmount: orders.filter((o) => o.amount.contract !== null).length,
    customerCount: customers.length,
    orderCount: orders.length,
    orderWithSteps: orders.filter((o) => o.steps.length > 0).length,
    msgRowsTotal: customers.reduce((a, c) => a + c.msgRows, 0),
    skipImgTotal: customers.reduce((a, c) => a + c.skipImg, 0),
    skipVoiceTotal: customers.reduce((a, c) => a + c.skipVoice, 0),
    amountLevel,
    amountUsable: customers.filter((c) => c.amount.usable).length,
    amountUsableRate:
      customers.length > 0
        ? Number(
            ((customers.filter((c) => c.amount.usable).length / customers.length) * 100).toFixed(1),
          )
        : 0,
    stageDist,
    stageSource: count(customers, 'stageSource'),
    stageConflicts: conflicts.length,
    nodeViolationGroups: nodeBad.length,
    reviewStatus: count(customers, 'reviewStatus'),
    confidence: count(customers, 'confidence'),
    regionScope: count(customers, 'regionScope'),
    issues: issues.length,
    boardUnmatched: boardUnmatched.length,
  }
}

function printReport(preview, outPath) {
  const s = preview.stats
  const lines = []
  const p = (line = '') => lines.push(line)

  p('# 客户与订单干跑导入报告')
  p()
  p(`生成时间 ${preview.generatedAt}`)
  p()
  p('## 一、总量')
  p()
  p('| 项目 | 数值 |')
  p('|---|---|')
  p(`| 客户 | ${s.customerCount} |`)
  p(`| 订单 | ${s.orderCount}（含环节明细 ${s.orderWithSteps}） |`)
  p(`| 消息行合计 | ${s.msgRowsTotal} |`)
  p(`| 被跳过的图片 | ${s.skipImgTotal} |`)
  p(`| 被跳过的语音 | ${s.skipVoiceTotal} |`)
  p(`| 未匹配到别名表的看板客户 | ${s.boardUnmatched} |`)
  p(`| 缺失的群文件 | ${s.issues} |`)
  p()
  p('## 二、金额净化结果')
  p()
  p('| 判据层级 | 群数 |')
  p('|---|---|')
  for (const [level, count] of Object.entries(s.amountLevel).sort((a, b) => b[1] - a[1])) {
    const label =
      {
        usable: '五级通过，可用',
        'D1.1': '内部号码污染',
        'D1.2': '手机号污染',
        'D1.3': '百万以上误填',
        'D1.4': '千元以下判投影面积',
        'D1.5': '不平账',
        none: '无金额字段',
      }[level] ?? level
    p(`| ${label} | ${count} |`)
  }
  p()
  p(`可用率 ${s.amountUsableRate}%。文档预期为 16 群可用、37 群置空，实测若偏离须逐条核对。`)
  p()
  p('## 三、订单级金额')
  p()
  p('金额挂在订单上，客户级只做汇总。来源分布：')
  p()
  p('| 来源 | 订单数 |')
  p('|---|---|')
  for (const [source, count] of Object.entries(s.orderAmountSource).sort((a, b) => b[1] - a[1])) {
    const label =
      {
        'board-evidence': '看板合同证据（高置信）',
        'ai_schema-sanitized': '净化通过后下放（低置信）',
        cleared: '净化不通过，留空',
        none: '看板未收录',
      }[source] ?? source
    p(`| ${label} | ${count} |`)
  }
  p()
  p(`有合同额的订单 ${s.ordersWithAmount} 张，合计 ${s.orderContractTotal} 元。`)
  p()
  p('| 订单 | 客户 | 合同额 | 来源 | 证据日期 |')
  p('|---|---|---|---|---|')
  for (const order of preview.orders.filter((o) => o.amount.contract !== null)) {
    p(
      `| ${order.code} | ${order.displayName} | ${order.amount.contract} | ${order.amount.source} | ${order.amount.evidenceDate ?? '-'} |`,
    )
  }
  p()
  p('## 四、阶段仲裁')
  p()
  p('| 阶段 | 群数 |')
  p('|---|---|')
  for (const [stage, count] of Object.entries(s.stageDist).sort((a, b) => b[1] - a[1])) {
    p(`| ${stage} | ${count} |`)
  }
  p()
  p('| 判定来源 | 群数 |')
  p('|---|---|')
  for (const [source, count] of Object.entries(s.stageSource).sort((a, b) => b[1] - a[1])) {
    const label =
      { board: '看板环节明细', ledger: '台账纠正', ai_stage: 'ai_stage 推断', none: '无来源' }[
        source
      ] ?? source
    p(`| ${label} | ${count} |`)
  }
  p()
  p(`被人工推翻的阶段 ${s.stageConflicts} 处，节点日期乱序 ${s.nodeViolationGroups} 群。`)
  p()
  p('## 五、客户清单')
  p()
  p('| # | 显示名 | 阶段 | 来源 | 金额 | 置信 | 复核 |')
  p('|---|---|---|---|---|---|---|')
  preview.customers.forEach((c, i) => {
    const amt = c.amount.usable
      ? `¥${c.amount.contract}`
      : c.amount.level === 'none'
        ? '-'
        : c.amount.level
    p(
      `| ${i + 1} | ${c.displayName} | ${c.stage ?? '未定'} | ${c.stageSource} | ${amt} | ${c.confidence} | ${c.reviewStatus} |`,
    )
  })
  p()
  if (preview.boardUnmatched.length > 0) {
    p('## 六、看板客户未能挂到别名表')
    p()
    for (const item of preview.boardUnmatched) {
      p(`- ${item.customerName}（${item.codes.join('、')}）：别名表里没有匹配的短名，需人工补一行`)
    }
    p()
  }
  if (preview.issues.length > 0) {
    p('## 七、阻断项')
    p()
    for (const item of preview.issues) {
      p(`- ${item.type}：${item.displayName} → ${item.file}`)
    }
    p()
  }

  const text = lines.join('\n')
  const reportPath = outPath.replace(/\.json$/, '-report.md')
  fs.writeFileSync(reportPath, text, 'utf8')
  console.log(text)
  console.log(`\n明细已写入 ${outPath}`)
  console.log(`报告已写入 ${reportPath}`)
}

main()
