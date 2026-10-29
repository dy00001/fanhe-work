/**
 * 阶段仲裁：看板 > 台账 > AI，三层取最高。
 *
 * 这两张表是**人工判断**，不是推导结果，所以逐字搬迁而不是重写：
 *   - `AI_STAGE_MAP` 的六个取值是实测出来的（53 群全覆盖，无空值）；
 *   - `LEDGER_STAGE_CORRECTIONS` 的六条是阿阳在台账里明确推翻过模型判断的。
 * 搬错一个字的后果是「这个客户的阶段自己变了」，而界面上没有任何异常提示。
 *
 * 与 `tools/crm/rules.mjs` 是同一份规则的运行期版本。那边是建表前的一次性干跑
 * 工具，日常链路只走这里；改任一侧都要同步另一侧并跑 `test/stage-rules.test.ts`。
 */

import type { CustomerStage } from '@fanhe/shared'

/** `ai_stage` 六个实测取值到契约状态的映射。「已下单」按 2026-10-29 确认落 producing。 */
export const AI_STAGE_MAP: Readonly<Record<string, CustomerStage>> = Object.freeze({
  初识: 'consulting',
  需求沟通: 'consulting',
  方案设计: 'designing',
  报价核算: 'quoted',
  已下单: 'producing',
  '已交付(售后)': 'after_sales',
})

/** 台账已明确纠正的 6 处 AI 误判。优先级低于看板环节明细。 */
export const LEDGER_STAGE_CORRECTIONS: Readonly<
  Record<string, { stage: CustomerStage; reason: string }>
> = Object.freeze({
  保定水志艳: { stage: 'after_sales', reason: '纯售后报修，无新订单' },
  嘉兴董舒洁: { stage: 'after_sales', reason: '纯售后报修，无新订单' },
  英国lyra粥粥姐: { stage: 'closed', reason: '仅开发票问题' },
  意大利王晓华: { stage: 'lost', reason: '报价未成交，早期流失' },
  // key 必须与显示名一致。群名是「越南Thanh nhan梅姐」，显示名裁成了「越南梅姐」，
  // 用群名当 key 会匹配不上，这一处曾漏纠正。
  越南梅姐: { stage: 'lost', reason: '报价未成交，早期流失' },
  台湾廖丞婕: { stage: 'refunding', reason: '定金退款悬空' },
})

export type StageSource = 'board' | 'ledger' | 'ai_stage' | 'none'

export type StageArbitration = {
  /** 仲裁得到的阶段。`null` 表示三层都没有证据 —— 调用方应保留库里的原值。 */
  stage: CustomerStage | null
  source: StageSource
  /** 被覆盖的值，用于报告与审计：能回答「哪些群的状态被人工改过」。 */
  conflict: { overridden: CustomerStage; by: StageSource } | null
  aiMapped: CustomerStage | null
  /** AI 值不在映射表里时原样带出，提示契约需要扩表。 */
  unknownKey?: string | null
  correctionReason?: string
}

export type ArbitrateInput = {
  /** 看板环节明细折出的阶段。看板不可读时传 `null` 是错的，见下方说明。 */
  boardStage?: CustomerStage | null | undefined
  aiStage: string | null
  displayName: string | null
  shortName: string | null
}

/**
 * 三层仲裁。
 *
 * **看板不可读与「这单没有看板证据」是两件事，调用方必须分开处理。** 这里把
 * `boardStage` 为 `null` 一律当成「无证据」并继续往下 fallback；如果看板文件
 * 整个读不到，调用方应当直接跳过阶段更新，而不是调这里 —— 否则一个原本
 * `source=board` 的客户会在某天悄悄降级成 `ai_stage`，阶段还可能往回退。
 */
export function arbitrateStage({
  boardStage,
  aiStage,
  displayName,
  shortName,
}: ArbitrateInput): StageArbitration {
  const aiMapped = aiStage === null ? null : (AI_STAGE_MAP[aiStage] ?? null)
  const unknownKey = aiStage !== null && aiMapped === null ? aiStage : null

  // 精确匹配实际上很少命中 —— displayName 带地区前缀（「中国台湾廖丞婕」），
  // 而表里的键不带。真正起作用的是下面这条 includes。保留精确匹配是因为它先命中
  // 时更快，且 shortName 那一路确实会精确匹配上。
  const correction =
    LEDGER_STAGE_CORRECTIONS[displayName ?? ''] ??
    LEDGER_STAGE_CORRECTIONS[shortName ?? ''] ??
    Object.entries(LEDGER_STAGE_CORRECTIONS).find(([key]) =>
      (displayName ?? '').includes(key),
    )?.[1] ??
    null

  if (boardStage != null) {
    const conflict =
      aiMapped !== null && aiMapped !== boardStage
        ? { overridden: aiMapped, by: 'board' as StageSource }
        : null
    return {
      stage: boardStage,
      source: 'board',
      conflict,
      aiMapped,
      unknownKey,
    }
  }

  if (correction !== null) {
    const conflict =
      aiMapped !== null && aiMapped !== correction.stage
        ? { overridden: aiMapped, by: 'ledger' as StageSource }
        : null
    return {
      stage: correction.stage,
      source: 'ledger',
      conflict,
      aiMapped,
      unknownKey,
      correctionReason: correction.reason,
    }
  }

  if (aiMapped !== null) {
    return { stage: aiMapped, source: 'ai_stage', conflict: null, aiMapped, unknownKey }
  }

  return { stage: null, source: 'none', conflict: null, aiMapped: null, unknownKey }
}
