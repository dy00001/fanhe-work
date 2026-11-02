/**
 * 公共池归类引擎的回归测试。
 *
 * 这个文件守的是**判定规则本身**，不是「58 个客户跑出来像不像」。规则里每一条
 * 都是可被悄悄改坏的常量，而改坏之后界面上完全看不出来 —— 归类结果照样有值，
 * 只是把设计师的活派给了销售。所以每条规则都用构造出来的证据钉住：
 *
 *   1. **没聊天记录判销售、置信度 20。** 这是流程起点，不是推断。把它改成
 *      「按阶段判」的后果是老客户批量被划到设计名下，而复核的人只看到
 *      「置信度 45」，看不出这是个默认值。
 *   2. **`deposited` 判设计师。** 最容易被判错的一档：定金是销售类词，
 *      一条只聊定金的记录会把已下定客户留在销售名下。先验必须压过关键词。
 *   3. **置信度两道封顶（45 / 60）。** 低于 60 的条目界面提示「需要人工判断」，
 *      封顶失效的表现是「读不到群文件的客户」看起来和「算得很准」一模一样。
 *   4. **单字计数上限 20。** 不封顶时一个反复出现的词会淹没阶段先验，
 *      判定退化成「谁刷屏谁赢」。
 *   5. **词表按不重叠子串计数。** 换成分词会让「见光板」被拆开而漏算。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DESIGNER_TERMS,
  SALES_TERMS,
  classifyPoolCustomer,
  collectKeywordHits,
} from '../dist/index.js'

/** 一条证据都不给：没有记录、没有命中、没有金额。 */
function emptyEvidence(overrides = {}) {
  return {
    stage: 'consulting',
    messageCount: 0,
    recentMessageCount: 0,
    salesHits: [],
    designerHits: [],
    hasContractAmount: false,
    hasTranscript: true,
    ...overrides,
  }
}

/**
 * 造一组命中：`{ 报价: 3 }` → `[{ term: '报价', count: 3, recentCount: 3 }]`。
 *
 * `recent` 里显式写 0 才代表「窗口内没有命中」，不写则视为全部落在窗口内 ——
 * 用 `??` 取默认值会让 `{ 图纸: 0 }` 被当成「没指定」，于是「聊天都是旧的」这种
 * 场景永远造不出来。
 */
function hits(map, recent) {
  return Object.entries(map).map(([term, count]) => ({
    term,
    count,
    recentCount: recent !== undefined && term in recent ? recent[term] : count,
  }))
}

test('没有聊天记录时判销售，置信度 20，且明确说明这是默认值', () => {
  const verdict = classifyPoolCustomer(emptyEvidence())
  assert.equal(verdict.role, 'sales')
  assert.equal(verdict.confidence, 20)
  assert.equal(verdict.reasons[0]?.code, 'no-history')
})

test('已下定（deposited）判设计师 —— 定金是销售词，先验必须压过它', () => {
  // 聊天里只提过一次定金：4 分权重 ×（1 + 最近窗口 1）= 8，阶段先验 6 分。
  // 差距 2 分落在 20% 阈值内，交给先验收口 → 设计师。
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'deposited',
      messageCount: 12,
      recentMessageCount: 12,
      salesHits: hits({ 定金: 1 }),
    }),
  )
  assert.equal(verdict.role, 'designer')
})

test('先验不是绝对的：反复谈定金仍判销售', () => {
  // 上一条守「先验能压过一句定金」，这一条守「先验不会压过一通定金」。
  // 没有这条，把 deposited 的权重从 6 一路加大会让所有已下定客户都被划给设计师，
  // 而上面的用例照样绿。
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'deposited',
      messageCount: 30,
      recentMessageCount: 30,
      salesHits: hits({ 定金: 3 }),
    }),
  )
  assert.equal(verdict.role, 'sales')
})

test('退款（refunding）判销售 —— 这是唯一压过设计履约阶段先验的旁支', () => {
  const verdict = classifyPoolCustomer(
    emptyEvidence({ stage: 'refunding', messageCount: 5, recentMessageCount: 5 }),
  )
  assert.equal(verdict.role, 'sales')
})

test('谈尺寸与图纸远多于谈钱时判设计师', () => {
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'measured',
      messageCount: 60,
      recentMessageCount: 30,
      salesHits: hits({ 报价: 1 }),
      designerHits: hits({ 量尺: 4, 图纸: 3, 复尺: 2 }),
    }),
  )
  assert.equal(verdict.role, 'designer')
  assert.ok(
    verdict.designerScore > verdict.salesScore,
    `设计师分数应更高，实际 ${verdict.designerScore} vs ${verdict.salesScore}`,
  )
})

test('两边证据接近时按阶段收口，并留下 tie-break 依据', () => {
  /*
   * 用 `quoted`（先验 8 分）而不是 `designing`（16 分）来构造。
   *
   * 这条分支比读起来窄：比对的是含先验的最终分数，先验越大差距越难落在 20% 内。
   * 拿 `designing` 写的话两侧差距被先验拉到 16 分，永远进不了平局分支 ——
   * 用例会红，而红的原因是构造错了，不是引擎坏了。
   *
   * 这里：报价 3 分权 ×2 = 6，设计师先验 8，合计 14 分，差距 2 分 ≤ max(4, 2.8)。
   */
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'quoted',
      messageCount: 10,
      recentMessageCount: 10,
      salesHits: hits({ 报价: 1 }),
    }),
  )
  assert.equal(verdict.role, 'designer')
  assert.ok(
    verdict.reasons.some((item) => item.code === 'tie-break'),
    '平局必须留下 tie-break 依据，否则复核的人看不到为什么不按分数判',
  )
  // 平局意味着格局为 0，置信度只由下限兜底，不能高。
  assert.ok(verdict.confidence <= 60, `平局置信度不应高，实际 ${verdict.confidence}`)
})

test('读不到群文件时置信度封顶 45', () => {
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'producing',
      messageCount: 200,
      recentMessageCount: 200,
      hasTranscript: false,
      designerHits: hits({ 图纸: 20, 拆单: 20 }),
      salesHits: hits({ 定金: 1 }),
    }),
  )
  assert.equal(verdict.role, 'designer')
  assert.ok(verdict.confidence <= 45, `应封顶 45，实际 ${verdict.confidence}`)
  assert.ok(verdict.reasons.some((item) => item.code === 'no-transcript'))
})

test('最近 90 天没有新消息时置信度封顶 60', () => {
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'designing',
      messageCount: 200,
      recentMessageCount: 0,
      designerHits: hits({ 图纸: 20, 拆单: 20 }, { 图纸: 0, 拆单: 0 }),
      salesHits: hits({ 定金: 1 }, { 定金: 0 }),
    }),
  )
  assert.ok(verdict.confidence <= 60, `应封顶 60，实际 ${verdict.confidence}`)
  assert.ok(verdict.reasons.some((item) => item.code === 'stale'))
})

test('单字计数上限 20：刷屏不放大权重', () => {
  const once = classifyPoolCustomer(
    emptyEvidence({
      stage: 'measured',
      messageCount: 5,
      recentMessageCount: 5,
      designerHits: hits({ 量尺: 20 }),
    }),
  )
  const flooded = classifyPoolCustomer(
    emptyEvidence({
      stage: 'measured',
      messageCount: 5,
      recentMessageCount: 5,
      designerHits: hits({ 量尺: 500 }),
    }),
  )
  assert.equal(flooded.designerScore, once.designerScore)
})

test('分数封顶 100，不会因为命中太多而虚高', () => {
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'designing',
      messageCount: 999,
      recentMessageCount: 999,
      designerHits: hits({ 图纸: 20, 拆单: 20, 量尺: 20, 复尺: 20, 效果图: 20 }),
      salesHits: hits({ 定金: 20, 签单: 20, 报价: 20 }),
    }),
  )
  assert.ok(verdict.designerScore <= 100)
  assert.ok(verdict.salesScore <= 100)
})

test('每条依据都带权重，界面才能按说服力排序', () => {
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'measured',
      messageCount: 40,
      recentMessageCount: 40,
      designerHits: hits({ 图纸: 5 }),
      salesHits: hits({ 报价: 1 }),
      hasContractAmount: true,
    }),
  )
  // 排序由 pool.ts 的界面层做，这里只要求 reasons 里确实带出了权重。
  for (const reason of verdict.reasons) {
    assert.equal(typeof reason.weight, 'number')
  }
  assert.ok(verdict.reasons.some((item) => item.code === 'amount'))
})

test('有记录但一个关键词都没命中时按阶段收口', () => {
  const verdict = classifyPoolCustomer(
    emptyEvidence({ stage: 'installed', messageCount: 3, recentMessageCount: 3 }),
  )
  assert.equal(verdict.role, 'designer')
})

test('collectKeywordHits 按不重叠子串计数，不拆词', () => {
  const messages = [
    { content: '这个见光板要 20mm', at: '2026-10-01T10:00:00+08:00' },
    { content: '见光板见光板', at: '2026-10-02T10:00:00+08:00' },
  ]
  const found = collectKeywordHits(messages, DESIGNER_TERMS, null)
  const board = found.find((item) => item.term === '见光板')
  assert.ok(board, '「见光板」必须被当做一个词命中')
  assert.equal(board.count, 3)
})

test('collectKeywordHits 的 recentCount 只算窗口内的命中', () => {
  const messages = [
    { content: '复尺', at: '2026-01-01T10:00:00+08:00' },
    { content: '复尺', at: '2026-10-01T10:00:00+08:00' },
  ]
  const found = collectKeywordHits(messages, DESIGNER_TERMS, '2026-09-01T00:00:00+08:00')
  const hit = found.find((item) => item.term === '复尺')
  assert.ok(hit)
  assert.equal(hit.count, 2)
  assert.equal(hit.recentCount, 1)
})

test('recentSince 传 null 时全部计入最近窗口', () => {
  const found = collectKeywordHits(
    [{ content: '定金', at: '2020-01-01T10:00:00+08:00' }],
    SALES_TERMS,
    null,
  )
  const hit = found.find((item) => item.term === '定金')
  assert.ok(hit)
  assert.equal(hit.recentCount, hit.count)
})

test('关键词表不含重复分值以外的空词', () => {
  for (const table of [SALES_TERMS, DESIGNER_TERMS]) {
    for (const [term, weight] of Object.entries(table)) {
      assert.ok(term.length >= 2, `词「${term}」太短，单字会误命中`)
      assert.ok(weight >= 1 && weight <= 4, `词「${term}」权重 ${weight} 超出 1–4`)
    }
  }
})
