/**
 * 阶段仲裁的测试。
 *
 * 两张表都是**人工判断**，不是推导结果：`AI_STAGE_MAP` 是实测出来的六个 AI 取值，
 * `LEDGER_STAGE_CORRECTIONS` 是阿阳在台账里明确推翻过模型判断的六处。它们在
 * `tools/crm/rules.mjs`（一次性干跑工具）与 `src/customer/stage-rules.ts`（日常
 * 链路）各存一份，两份漂移的后果是「同一个客户在干跑报告里是售后、在工作台里是
 * 已下单」，而且没有任何地方会报错。
 *
 * 因此除了行为断言，这里还有一条**源码对账**：直接读 `rules.mjs`，逐条确认每个
 * 键值都在 TS 版里存在。改任一侧而忘了另一侧，这条会红。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, test } from 'node:test'

import {
  AI_STAGE_MAP,
  LEDGER_STAGE_CORRECTIONS,
  arbitrateStage,
} from '../src/customer/stage-rules.js'

/** 仓库根下的干跑规则文件。取不到就跳过对账，不让测试因为路径问题假红。 */
const RULES_PATH = path.resolve(process.cwd(), '..', '..', 'tools', 'crm', 'rules.mjs')

describe('阶段仲裁', () => {
  test('三层优先级：看板 > 台账 > AI', () => {
    const aiOnly = arbitrateStage({
      boardStage: null,
      aiStage: '方案设计',
      displayName: '某客户',
      shortName: '某客户',
    })
    assert.equal(aiOnly.stage, 'designing')
    assert.equal(aiOnly.source, 'ai_stage')

    // 台账纠正压过 AI。
    const ledger = arbitrateStage({
      boardStage: null,
      aiStage: '已下单',
      displayName: '保定水志艳',
      shortName: '水志艳',
    })
    assert.equal(ledger.stage, 'after_sales')
    assert.equal(ledger.source, 'ledger')
    assert.notEqual(ledger.conflict, null)

    // 看板压过一切。
    const board = arbitrateStage({
      boardStage: 'shipped',
      aiStage: '已下单',
      displayName: '保定水志艳',
      shortName: '水志艳',
    })
    assert.equal(board.stage, 'shipped')
    assert.equal(board.source, 'board')
  })

  test('显示名带地区前缀时，台账纠正仍要命中', () => {
    // 这是真踩过的坑：表里的键是「台湾廖丞婕」，而显示名是「中国台湾廖丞婕」，
    // 精确匹配落空。若只保留精确匹配，这一处的退款状态会被 AI 的「已下单」盖掉。
    const result = arbitrateStage({
      boardStage: null,
      aiStage: '已下单',
      displayName: '中国台湾廖丞婕',
      shortName: '廖丞婕',
    })
    assert.equal(result.stage, 'refunding')
    assert.equal(result.source, 'ledger')
  })

  test('三层都没有证据时返回 null，由调用方保留原值', () => {
    const result = arbitrateStage({
      boardStage: null,
      aiStage: null,
      displayName: '某客户',
      shortName: '某客户',
    })
    assert.equal(result.stage, null)
    assert.equal(result.source, 'none')
  })

  test('AI 取值不在映射表里：不猜，如实带出未知键', () => {
    const result = arbitrateStage({
      boardStage: null,
      aiStage: '某个新标签',
      displayName: '某客户',
      shortName: '某客户',
    })
    // 猜一个默认值的后果是全库客户被悄悄归到「咨询中」，所以这里是 null + 未知键。
    assert.equal(result.stage, null)
    assert.equal(result.unknownKey, '某个新标签')
  })

  test('与 tools/crm/rules.mjs 逐条对账，两份表不许漂移', (t) => {
    if (!fs.existsSync(RULES_PATH)) {
      t.skip(`找不到 ${RULES_PATH}`)
      return
    }
    const source = fs.readFileSync(RULES_PATH, 'utf8')

    for (const [key, stage] of Object.entries(AI_STAGE_MAP)) {
      const literal = key.includes('(') ? `'${key}': '${stage}'` : `${key}: '${stage}'`
      assert.equal(
        source.includes(literal),
        true,
        `AI_STAGE_MAP 的「${key} → ${stage}」在 tools/crm/rules.mjs 里不存在`,
      )
    }

    for (const [key, fix] of Object.entries(LEDGER_STAGE_CORRECTIONS)) {
      assert.equal(
        source.includes(`${key}: { stage: '${fix.stage}'`),
        true,
        `LEDGER_STAGE_CORRECTIONS 的「${key} → ${fix.stage}」在 tools/crm/rules.mjs 里不存在`,
      )
    }
  })
})
