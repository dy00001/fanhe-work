/**
 * 公共池归类的判定引擎。
 *
 * 纯函数，输入是「证据」，输出是「结论 + 依据」。把引擎放在共享包而不是 API 里，
 * 有两个具体理由：
 *
 *   1. 结论要能被单测固定。判定规则一旦写进服务层，验证方式就只剩「拿 58 个客户
 *      跑一遍看像不像」，而「像不像」不是断言；
 *   2. 同一份规则要同时被批量脚本（`db:pool-classify`）与接口
 *      （`POST /api/customers/pool/classify`）使用。两处各写一遍的结果是
 *      同一位客户在两条入口上被判成不同角色，而界面上只会看到「怎么又变了」。
 *
 * ## 为什么是规则而不是模型
 *
 * 归类要回答的只是「这位客户现在该由销售跟还是设计师跟」，业务上由两个信号决定：
 * 聊的是钱还是聊的是尺寸，以及处在流水线哪一档。这两件事都能用词频与阶段先验
 * 算清楚，且**每一条结论都能给出人话依据** —— 复核的人要看的正是依据。
 * 换成模型，结论会变成一句「置信度 0.83」，复核无从下手，也无法解释为什么把
 * 一位老客户从设计师名下划走。
 *
 * ## 分数的含义
 *
 * 分数是「证据强度」，不是概率。0 分表示没有任何信号，100 分封顶表示证据已经很足。
 * 两个分数接近时置信度自然低，界面据此提示人工判断，而不会假装算得很准。
 */

import type { CustomerRole, PoolReason } from './customer-api.js'
import type { CustomerStage } from './customer.js'

/**
 * 销售类词。权重按「这个词出现时，这位客户有多大可能在谈钱」排：
 * 4 分是「只有销售会说的话」（定金、签单、复尺除外），1 分是弱相关。
 */
export const SALES_TERMS: Readonly<Record<string, number>> = {
  报价: 3,
  价格: 3,
  多少钱: 3,
  优惠: 3,
  折扣: 2,
  活动: 2,
  定金: 4,
  订金: 4,
  合同: 3,
  付款: 3,
  转账: 2,
  签单: 4,
  预算: 2,
  尾款: 3,
  首付: 2,
  分期: 2,
  团购: 2,
  套餐: 1,
  成交: 3,
}

/**
 * 设计类词。`量尺`/`复尺`/`图纸`/`拆单` 给 4 分：这四个词出现时，客户已经进入
 * 设计履约阶段，几乎不可能还在由销售主跟。
 *
 * `安装` 只给 3 分：它同时出现在「约安装时间」这种销售话术里，但绝大多数语境
 * 是设计端在对接现场。
 */
export const DESIGNER_TERMS: Readonly<Record<string, number>> = {
  量尺: 4,
  复尺: 4,
  测量: 4,
  尺寸: 3,
  设计: 3,
  图纸: 4,
  方案: 3,
  效果图: 4,
  柜体: 2,
  板材: 3,
  颜色: 1,
  五金: 2,
  拆单: 4,
  安装: 3,
  收口: 2,
  见光板: 3,
  层板: 2,
  柜门: 2,
  背板: 2,
  封边: 2,
}

/**
 * 阶段先验。含义是「走到这一档，通常谁在跟」。
 *
 * `deposited`（已下定）判给设计师：钱已经收了，接下来是量尺与方案，销售的任务
 * 已经完成。这一档最容易判错 —— 定金是销售类词，若不叠加先验，一条只聊定金的
 * 记录会把客户留在销售名下，而实际上下一步就该拉设计师进群了。
 *
 * 旁支两档（退款、流失）判给销售：这两种情况要谈钱、谈责任，是销售的活。
 */
const STAGE_PRIOR: Readonly<Record<CustomerStage, { role: CustomerRole; weight: number }>> = {
  consulting: { role: 'sales', weight: 12 },
  deposited: { role: 'designer', weight: 6 },
  measured: { role: 'designer', weight: 14 },
  designing: { role: 'designer', weight: 16 },
  design_done: { role: 'designer', weight: 16 },
  quoted: { role: 'designer', weight: 8 },
  contracted: { role: 'designer', weight: 14 },
  producing: { role: 'designer', weight: 16 },
  shipped: { role: 'designer', weight: 14 },
  installed: { role: 'designer', weight: 14 },
  after_sales: { role: 'designer', weight: 12 },
  closed: { role: 'designer', weight: 8 },
  refunding: { role: 'sales', weight: 16 },
  lost: { role: 'sales', weight: 8 },
}

/** 一个词的命中次数。`recentCount` 是最近窗口内的次数，计分时额外加权。 */
export type PoolKeywordHit = {
  term: string
  count: number
  recentCount: number
}

/**
 * 判定引擎的输入。**不含客户 id、不查库**：这一段只做判断，取数在调用方。
 *
 * `hasTranscript` 决定置信度上限。读不到群文件时，只剩阶段与档案字段可用，
 * 那种结论不该以高置信度进入复核队列 —— 它看起来和「算得很准」一模一样。
 */
export type PoolEvidence = {
  stage: CustomerStage
  /** 群文件里的消息总条数。0 表示没有聊天记录。 */
  messageCount: number
  /** 最近窗口（默认 90 天）内的条数。 */
  recentMessageCount: number
  salesHits: readonly PoolKeywordHit[]
  designerHits: readonly PoolKeywordHit[]
  /** 是否有合同额。有金额意味着至少谈过价，弱支持「已在履约」。 */
  hasContractAmount: boolean
  /** 是否读到了群文件原文。 */
  hasTranscript: boolean
}

export type PoolVerdict = {
  role: CustomerRole
  /** 0–100。两个分数接近时低，证据缺失时被上限压住。 */
  confidence: number
  salesScore: number
  designerScore: number
  reasons: PoolReason[]
}

/**
 * 单个词的次数上限。
 *
 * 一位客户可以说三十次「多少钱」，但那不意味着「销售倾向」是三十倍 ——
 * 不设上限时，一个反复出现的词会把阶段先验与其余证据全部淹没，判定退化成
 * 「谁刷屏谁赢」。20 这个值取的是「足够表达强度，又不至于让单字主导」。
 */
const TERM_COUNT_CAP = 20
/** 最近窗口内的命中额外算一次。它是「现在在聊什么」，比半年前聊过什么更重要。 */
const RECENT_MULTIPLIER = 1
/** 分数上限。超过之后边际信息为零，反而会让置信度算得虚高。 */
const SCORE_CAP = 100
/** 读不到群文件时置信度上限。低于 60 的条目界面会提示「需要人工判断」。 */
const NO_TRANSCRIPT_CONFIDENCE_CAP = 45
/** 完全没有证据时的默认置信度。 */
const EMPTY_CONFIDENCE = 20
/** 最近窗口内没有新消息时的置信度上限。 */
const STALE_CONFIDENCE_CAP = 60

function clampScore(value: number): number {
  return Math.min(SCORE_CAP, Math.max(0, Math.round(value)))
}

/**
 * 按词表计分，并给出命中最多的前五个词作为证据明细。
 *
 * 计数用「不重叠子串出现次数」而不是分词：中文分词需要词典，而这里的关键词
 * 都是两到四个字的固定词，`split(term).length - 1` 足够准确，也不会把
 * 「量尺」拆成「量」「尺」而漏掉组合词。
 */
function scoreTerms(
  hits: readonly PoolKeywordHit[],
  weights: Readonly<Record<string, number>>,
): { score: number; top: { term: string; count: number }[] } {
  let score = 0
  const counted: { term: string; count: number; weight: number }[] = []
  for (const hit of hits) {
    const weight = weights[hit.term]
    if (weight === undefined) continue
    const count = Math.min(TERM_COUNT_CAP, Math.max(0, hit.count))
    if (count === 0) continue
    const recent = Math.min(count, Math.max(0, hit.recentCount))
    score += weight * (count + RECENT_MULTIPLIER * recent)
    counted.push({ term: hit.term, count, weight })
  }
  counted.sort((left, right) => right.count * right.weight - left.count * left.weight)
  return {
    score: clampScore(score),
    top: counted.slice(0, 5).map((item) => ({ term: item.term, count: item.count })),
  }
}

function formatTop(top: { term: string; count: number }[]): string {
  return top.map((item) => `${item.term}×${item.count}`).join('、')
}

/**
 * 判定。
 *
 * 三条规则按顺序生效：
 *   1. 没有任何聊天记录时直接判销售，置信度最低。理由是咨询期的客户默认由销售
 *      接待 —— 这不是推断，是流程起点，所以不假装有依据。
 *   2. 两边**最终分数**（关键词 + 先验 + 金额）差距不足 20% 时按阶段先验收口。
 *      注意这里比的是含先验的分数，不是纯关键词分：先验本身也是证据，把它排除在
 *      比对之外会让「阶段说设计师、聊天说销售」的客户永远按聊天判，等于先验白配。
 *      **因此这条分支比读起来要窄**：先验权重到 12–16 时，只有关键词分几乎相等
 *      才会落进来（例如 `quoted` 8 分档、两侧差 2 分）。写用例验证这条分支时，
 *      别拿 `designing`（16 分）去构造 —— 那样差距永远够大，用例会以为分支坏了。
 *   3. 否则按分数高的一方。
 */
export function classifyPoolCustomer(evidence: PoolEvidence): PoolVerdict {
  const sales = scoreTerms(evidence.salesHits, SALES_TERMS)
  const designer = scoreTerms(evidence.designerHits, DESIGNER_TERMS)
  const prior = STAGE_PRIOR[evidence.stage]

  let salesScore = sales.score
  let designerScore = designer.score
  const reasons: PoolReason[] = []

  if (evidence.hasTranscript && evidence.messageCount > 0) {
    if (sales.top.length > 0) {
      reasons.push({
        code: 'keyword-sales',
        label: '聊天里在谈钱',
        detail: formatTop(sales.top),
        weight: sales.score,
      })
    }
    if (designer.top.length > 0) {
      reasons.push({
        code: 'keyword-designer',
        label: '聊天里在谈尺寸与图纸',
        detail: formatTop(designer.top),
        weight: designer.score,
      })
    }
  }

  if (prior.weight > 0) {
    if (prior.role === 'designer') designerScore += prior.weight
    else salesScore += prior.weight
    reasons.push({
      code: 'stage',
      label: `阶段先验：当前处于「${evidence.stage}」`,
      detail:
        prior.role === 'designer'
          ? '这一档已进入设计履约，默认由设计师跟进'
          : '这一档还在谈单或收尾，默认由销售跟进',
      weight: prior.weight,
    })
  }

  if (evidence.hasContractAmount) {
    designerScore += 2
    reasons.push({
      code: 'amount',
      label: '已有合同额',
      detail: '合同已成立，后续是履约与交付',
      weight: 2,
    })
  }

  salesScore = clampScore(salesScore)
  designerScore = clampScore(designerScore)

  // 规则 1：完全没有聊天记录。
  if (evidence.messageCount === 0) {
    return {
      role: 'sales',
      confidence: EMPTY_CONFIDENCE,
      salesScore,
      designerScore,
      reasons: [
        {
          code: 'no-history',
          label: '没有聊天记录',
          detail: '新客户默认由销售接待，等有沟通记录后重新判定',
          weight: 0,
        },
        ...reasons,
      ],
    }
  }

  const total = salesScore + designerScore
  let role: CustomerRole
  let margin: number

  if (total === 0) {
    // 有记录但一个关键词都没命中（例如只发了图片与地址）。按阶段收口。
    role = prior.role
    margin = 0
  } else {
    const diff = Math.abs(salesScore - designerScore)
    if (diff <= Math.max(4, total * 0.2)) {
      // 规则 2：证据互相抵消，交给阶段。
      role = prior.role
      margin = 0
      reasons.push({
        code: 'tie-break',
        label: '两侧证据接近',
        detail: '分数差距不足 20%，按阶段先验收口，建议人工确认',
        weight: 0,
      })
    } else {
      role = salesScore > designerScore ? 'sales' : 'designer'
      margin = diff
    }
  }

  // 置信度 = 差距占证据总量的比例。没有差距时为 0，再由证据质量决定下限。
  let confidence = total === 0 ? 0 : Math.round((margin / total) * 100)
  if (!evidence.hasTranscript) {
    confidence = Math.min(confidence, NO_TRANSCRIPT_CONFIDENCE_CAP)
    reasons.push({
      code: 'no-transcript',
      label: '没有读到群文件',
      detail: '只用阶段与档案字段判定，置信度已封顶',
      weight: 0,
    })
  } else if (evidence.recentMessageCount === 0) {
    /*
     * 最近窗口内一条消息都没有：判定基于的是几个月前的对话，而客户可能早已换了
     * 对接人。这类条目仍然给出结论，但置信度压到 60 以下，让复核的人知道
     * 「这个结论来自旧证据」。
     */
    confidence = Math.min(confidence, STALE_CONFIDENCE_CAP)
    reasons.push({
      code: 'stale',
      label: '最近 90 天没有新消息',
      detail: '结论来自较早的聊天记录，可能已经不再适用',
      weight: 0,
    })
  }
  confidence = Math.min(99, Math.max(EMPTY_CONFIDENCE, confidence))

  return { role, confidence, salesScore, designerScore, reasons }
}

/**
 * 关键词命中统计。放在共享包是因为**测试要用它造证据，接口要用它把文本变成证据**，
 * 而两边必须用同一套计数规则 —— 否则单测里算出来的分数与线上不一致，那种偏差
 * 只能人工比对才发现。
 *
 * `recent` 是一段时间字符串（任一经 `Date` 能解析的格式），早于它的命中不计入
 * `recentCount`。
 */
export function collectKeywordHits(
  messages: readonly { content: string; at: string }[],
  terms: Readonly<Record<string, number>>,
  recentSince: string | null,
): PoolKeywordHit[] {
  const hits = new Map<string, { count: number; recentCount: number }>()
  const threshold = recentSince === null ? null : new Date(recentSince).getTime()

  for (const message of messages) {
    const at = new Date(message.at).getTime()
    const isRecent = threshold === null || Number.isNaN(at) ? true : at >= threshold
    for (const term of Object.keys(terms)) {
      const count = message.content.split(term).length - 1
      if (count <= 0) continue
      const entry = hits.get(term) ?? { count: 0, recentCount: 0 }
      entry.count += count
      if (isRecent) entry.recentCount += count
      hits.set(term, entry)
    }
  }

  return [...hits.entries()].map(([term, value]) => ({ term, ...value }))
}
