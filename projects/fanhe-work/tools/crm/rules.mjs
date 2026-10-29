/**
 * 导入规则的可测部分：金额净化（D1）与阶段仲裁（D2）。
 *
 * 之所以单独成文件而不写进主流程，是因为这两段是「错一次就会把 39 个污染字段
 * 固化成正式数据」的地方，必须能脱离文件系统单测。判据来源：
 * docs/CUSTOMER-CRM-IDENTITY-RULES-2026-10-29.md 的 D1、D2 两节。
 */

/** 5 个内部号码。命中任一个即判为污染，不做进一步解释。 */
export const STAFF_PHONES = Object.freeze({
  13281029802: '乐乐 客服销售',
  13438910518: '小阳 设计师',
  15892814560: '黄毅 设计师',
  17380118852: '梵禾安装售后部',
  17364074468: '梵禾设计师小杰',
})

const CN_MOBILE = /^1[3-9]\d{9}$/

/** 合同金额可信下限。低于此值判为面积、尺寸或定金。 */
const LOW_CONTRACT_THRESHOLD = 3000

/** 合同与已收相等时的防重复填写上限。 */
const DUPLICATE_AMOUNT_THRESHOLD = 10000

function toNumber(value) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/[,，\s"']/g, '')
  if (text === '') return null
  const n = Number(text)
  return Number.isFinite(n) ? n : null
}

/**
 * 金额五级净化。任一层级命中即整组置空。
 *
 * 为什么整组置空而不是只清命中的那个字段：三个字段互相约束（合同减已收应等于
 * 未收），清掉一个另外两个就失去了校验基准，留下来反而是错的。
 *
 * 返回 `{ usable, contract, received, unpaid, level, reason, raw }`。
 * `raw` 保留原值，供导入报告追溯，不入正式表。
 */
export function sanitizeAmount(rawContract, rawReceived, rawUnpaid) {
  const raw = {
    contract: rawContract ?? null,
    received: rawReceived ?? null,
    unpaid: rawUnpaid ?? null,
  }
  const cleared = (level, reason) => ({
    usable: false,
    contract: null,
    received: null,
    unpaid: null,
    level,
    reason,
    raw,
  })

  const fields = [
    ['合同金额', rawContract],
    ['已收金额', rawReceived],
    ['未收金额', rawUnpaid],
  ]

  // D1.1 内部号码。这是最重要的一条，24 个字段靠它拦下。
  for (const [label, value] of fields) {
    const text = String(value ?? '').replace(/[^\d]/g, '')
    if (text && STAFF_PHONES[text])
      return cleared('D1.1', `${label} 为内部号码 ${text}（${STAFF_PHONES[text]}）`)
  }

  // D1.2 中国大陆手机号
  for (const [label, value] of fields) {
    const text = String(value ?? '').replace(/[^\d]/g, '')
    if (CN_MOBILE.test(text)) return cleared('D1.2', `${label} 为手机号 ${text}`)
  }

  const contract = toNumber(rawContract)
  const received = toNumber(rawReceived)
  const unpaid = toNumber(rawUnpaid)

  // 合同金额缺失即不可用。已收有值也不够，因为无法判断这个已收对应哪一单。
  if (contract === null) {
    return {
      usable: false,
      contract: null,
      received: null,
      unpaid: null,
      level: 'none',
      reason: received === null ? '合同金额为空' : `合同金额为空，已收 ${received} 无对应合同`,
      raw,
    }
  }

  // D1.3 百万以上。定制家具不存在这个量级，一律视为误填。
  for (const [label, value] of [
    ['合同金额', contract],
    ['已收金额', received],
  ]) {
    if (value !== null && value > 1_000_000) return cleared('D1.3', `${label} ${value} 超过 100 万`)
  }

  // D1.4 三千元以下一律不可信。定制家具不存在这个量级的合同，实测落在这里的值
  // 全是别的东西：40 与 9 是投影面积，45 是面积且与已收填了同一个数，
  // 2345 是柜体高度毫米数，1379 与 1180 是定金。阈值原定 1000，挡不住 2345。
  if (contract !== null && contract > 0 && contract < LOW_CONTRACT_THRESHOLD) {
    return cleared(
      'D1.4',
      `合同金额 ${contract} 低于 ${LOW_CONTRACT_THRESHOLD}，判为面积、尺寸或定金`,
    )
  }

  // D1.4b 合同与已收完全相等且都低于一万，判为同一个数重复填了两遍。
  // 现有 53 群里这一条被上面的阈值覆盖，保留它防未来数据：一笔真实的全款付清
  // 不会恰好落在 45 元这种量级上。
  if (
    contract !== null &&
    received !== null &&
    contract === received &&
    contract < DUPLICATE_AMOUNT_THRESHOLD
  ) {
    return cleared('D1.4b', `合同与已收同为 ${contract}，判为同一个数重复填写`)
  }

  // D1.5 不平账。
  if (contract !== null && received !== null && received > contract) {
    return cleared('D1.5', `已收 ${received} 大于合同 ${contract}`)
  }
  if (
    contract !== null &&
    received !== null &&
    unpaid !== null &&
    Math.abs(contract - received - unpaid) > 1
  ) {
    return cleared('D1.5', `合同 ${contract} 减已收 ${received} 与未收 ${unpaid} 之差不平`)
  }

  // 合同与已收都没问题但未收缺失：可用，未收由前端按公式算
  const normalizedUnpaid =
    unpaid ?? (contract !== null && received !== null ? contract - received : null)
  return {
    usable: true,
    contract,
    received,
    unpaid: normalizedUnpaid,
    level: 'ok',
    reason: '五级判据全部通过',
    raw,
  }
}

/**
 * `ai_stage` 六个实测取值到契约状态的映射。六个值覆盖 53 群，无空值。
 * 「已下单」按阿阳 2026-10-29 的确认落 `producing`。
 */
export const AI_STAGE_MAP = Object.freeze({
  初识: 'consulting',
  需求沟通: 'consulting',
  方案设计: 'designing',
  报价核算: 'quoted',
  已下单: 'producing',
  '已交付(售后)': 'after_sales',
})

/**
 * 台账已明确纠正的 6 处 `ai_stage` 误判。这些群的实际状态与模型推断不同，
 * 以人工台账为准，优先级高于 `ai_stage`、低于看板环节明细。
 */
export const LEDGER_STAGE_CORRECTIONS = Object.freeze({
  保定水志艳: { stage: 'after_sales', reason: '纯售后报修，无新订单' },
  嘉兴董舒洁: { stage: 'after_sales', reason: '纯售后报修，无新订单' },
  英国lyra粥粥姐: { stage: 'closed', reason: '仅开发票问题' },
  意大利王晓华: { stage: 'lost', reason: '报价未成交，早期流失' },
  // key 必须与显示名一致。群名是「越南Thanh nhan梅姐」，显示名裁成了「越南梅姐」，
  // 用群名当 key 会匹配不上，这一处曾漏纠正。
  越南梅姐: { stage: 'lost', reason: '报价未成交，早期流失' },
  台湾廖丞婕: { stage: 'refunding', reason: '定金退款悬空' },
})

/**
 * 三级仲裁。优先级从高到低：
 *   1. 看板环节明细（7 单，人工核验到环节）
 *   2. 台账纠正（6 处，人工推翻模型判断）
 *   3. `ai_stage`（53 群全覆盖，模型推断）
 *
 * 返回 `{ stage, source, conflict }`。`conflict` 记录被覆盖的值，进导入报告，
 * 不静默丢弃，否则无法审计「哪些群的状态被人工改过」。
 */
export function arbitrateStage({ boardStage, aiStage, displayName, shortName }) {
  const aiMapped = aiStage ? (AI_STAGE_MAP[aiStage] ?? null) : null
  const unknownKey = aiStage && !aiMapped ? aiStage : null

  const correction =
    LEDGER_STAGE_CORRECTIONS[displayName] ??
    LEDGER_STAGE_CORRECTIONS[shortName ?? ''] ??
    Object.entries(LEDGER_STAGE_CORRECTIONS).find(([key]) =>
      (displayName ?? '').includes(key),
    )?.[1] ??
    null

  if (boardStage) {
    const conflict =
      aiMapped && aiMapped !== boardStage ? { overridden: aiMapped, by: 'board' } : null
    return {
      stage: boardStage,
      source: 'board',
      conflict,
      aiMapped,
      correction: correction?.stage ?? null,
    }
  }
  if (correction) {
    const conflict =
      aiMapped && aiMapped !== correction.stage ? { overridden: aiMapped, by: 'ledger' } : null
    return {
      stage: correction.stage,
      source: 'ledger',
      conflict,
      aiMapped,
      correctionReason: correction.reason,
    }
  }
  if (aiMapped) return { stage: aiMapped, source: 'ai_stage', conflict: null, aiMapped }
  return { stage: null, source: 'none', conflict: null, aiMapped: null, unknownKey }
}

/**
 * 节点日期顺序校验（D3）。8 组相邻环节须递增，`install` 不得早于 `production`。
 * 返回违规列表，空数组表示通过。
 */
const NODE_SEQUENCE = [
  ['access', 'needs'],
  ['needs', 'design'],
  ['design', 'quote'],
  ['quote', 'payment'],
  ['payment', 'order'],
  ['order', 'production'],
  ['production', 'install'],
  ['install', 'service'],
]

export function validateNodes(nodes) {
  if (!nodes || typeof nodes !== 'object') return []
  const violations = []
  for (const [a, b] of NODE_SEQUENCE) {
    const da = nodes[a]
    const db = nodes[b]
    if (!da || !db) continue
    const ta = new Date(da).getTime()
    const tb = new Date(db).getTime()
    if (!Number.isFinite(ta) || !Number.isFinite(tb)) continue
    if (tb < ta) violations.push({ from: a, to: b, fromDate: da, toDate: db })
  }
  return violations
}
