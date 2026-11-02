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
  /*
   * 平局就是 0，如实显示 0。
   *
   * 这里曾断言 `<= 60`，而实现把 0 兜底抬到 20 —— 两个数字都能通过，等于这条用例
   * 从没验过「平局到底给了多少」。钉成 0 才能拦住「又把它抬上去凑个好看的分」：
   * 20 和 0 在界面上长得不像，但在判断上差的是「有两成把握」和「没有结论」。
   */
  assert.equal(verdict.confidence, 0)
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

test('最近 90 天没有新消息只加标记，不压分', () => {
  /*
   * 这条曾经断言 `<= 60`（旧行为：陈旧证据把置信度封在 60）。
   *
   * 封顶的后果在真实数据上看得见：53 条建议里有 13 条的真实证据强度是 92–100 分，
   * 是全表最扎实的结论，却因为群聊停在两年前被压成 60，排在「平局硬填」上面不远。
   * 排序因此和证据强度反向 —— 复核的人按顺序点，先处理的是最不确定的。
   *
   * 现在的口径：置信度只回答「两侧证据有多一致」，新旧由 `stale` 依据码单独标注。
   *
   * 推导（去掉总分封顶后）：图纸 20 次 ×4 分 + 拆单 20 次 ×4 分 = 160；销售侧定金
   * 1 次 ×4 分 = 4；差距 156 / 总量 164 ≈ 95%。先验不进置信度的分母，所以它加在
   * `designerScore` 上但不影响这个数。
   *
   * 旧口径下同一组输入得 92%（designer 被压到 100，总量 104）。两个数都高，
   * 但 95 才是「真实证据比例」—— 92 里混着封顶带来的截断误差。
   */
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'designing',
      messageCount: 200,
      recentMessageCount: 0,
      designerHits: hits({ 图纸: 20, 拆单: 20 }, { 图纸: 0, 拆单: 0 }),
      salesHits: hits({ 定金: 1 }, { 定金: 0 }),
    }),
  )
  assert.equal(verdict.confidence, 95, `陈旧不该压分（旧行为会得 60），实际 ${verdict.confidence}`)
  assert.ok(
    verdict.reasons.some((item) => item.code === 'stale'),
    '标记必须还在',
  )
})

test('零命中但有聊天记录时置信度是 0，不是「默认 20」', () => {
  /*
   * `EMPTY_CONFIDENCE = 20` 只属于「一条消息都没有」那条路径 —— 它表达的是
   * 「新客户默认销售接待」这个流程事实的可信度。
   *
   * 一旦它也去给全表做下限，就会出现「有聊天记录、一个关键词都没命中」的客户
   * 拿着 20 分进队列，看起来像「引擎查过了，有两成把握」，实际是「什么都没读到」。
   */
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'designing',
      messageCount: 8,
      recentMessageCount: 8,
      salesHits: [],
      designerHits: [],
    }),
  )
  assert.equal(verdict.confidence, 0)
  assert.equal(verdict.role, 'designer', '零命中时按阶段先验收口')
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

test('两侧都大量命中时不封顶，差异必须保留', () => {
  /*
   * 守的是 2026-11-02 首轮实跑暴露的缺陷：当时有一道 `SCORE_CAP = 100` 的
   * 总分封顶，两侧同时撞顶后差值恒为 0，53 条建议里 14 条被判成「证据不足」，
   * 而它们的真实比例是 18:82、20:80、37:63 这种悬殊数字。
   *
   * 最坏的表现不是「判错」，是「客户消息越多越判不出来」—— 判得准的只剩
   * 刚加微信、只提过一句「多少钱」的新客户。
   *
   * 推导：设计侧 5 个 4 分词各命中 20 次（单词封顶），每次计 count + recent = 40
   * → 5×4×40 = 800；销售侧 4+4+3 分词各 20 次 → 440。先验 designing 给设计 +16，
   * 但先验不进置信度的分母，所以比例是 800:440 ≈ 29%。
   *
   * 只要总分封顶回来，两个分数都会变成 100，`designerScore > salesScore` 立刻失败。
   */
  const verdict = classifyPoolCustomer(
    emptyEvidence({
      stage: 'designing',
      messageCount: 999,
      recentMessageCount: 999,
      designerHits: hits({ 图纸: 20, 拆单: 20, 量尺: 20, 复尺: 20, 效果图: 20 }),
      salesHits: hits({ 定金: 20, 签单: 20, 报价: 20 }),
    }),
  )
  assert.equal(verdict.role, 'designer')
  assert.ok(verdict.designerScore > 100, `不封顶时应超过 100，实际 ${verdict.designerScore}`)
  assert.ok(
    verdict.designerScore > verdict.salesScore,
    `两侧同时大量命中时差异必须保留，相等即被封顶抹平（实际 ${verdict.designerScore} : ${verdict.salesScore}）`,
  )
  assert.ok(verdict.confidence > 20, `判决由证据决定就该有置信度，实际 ${verdict.confidence}`)
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

test('有记录但零关键词命中时，依据要写明「没有可判定的关键词」', () => {
  /*
   * 这类客户的真值只有几条消息（实测 6 条与 9 条），说的都是「在吗」「发你了」，
   * 词表里一个词都没有。
   *
   * 分数却不是 0 —— 因为阶段先验本身带分（consulting 给销售 12 分）。那是流程
   * 假设，不是证据。判据曾经错用含先验的 `total`：12 ≠ 0，于是走进「由证据决定」
   * 分支，置信度又因关键词总分为 0 而算不出来，最后界面上写着「销售 12 : 设计 0」、
   * 结论 0 分、依据只有一句「阶段先验」—— 那 12 分从哪来的，没人看得出来。
   */
  const verdict = classifyPoolCustomer(
    emptyEvidence({ stage: 'consulting', messageCount: 6, recentMessageCount: 6 }),
  )
  assert.ok(verdict.salesScore > 0, `先验应给销售分，实际 ${verdict.salesScore}`)
  assert.equal(verdict.designerScore, 0)
  assert.equal(verdict.confidence, 0, '先验不算证据，置信度必须是 0')
  assert.ok(
    verdict.reasons.some((item) => item.code === 'no-keyword'),
    '必须有 no-keyword 依据，否则界面上那笔分数无从解释',
  )
  assert.ok(
    !verdict.reasons.some((item) => item.code === 'tie-break'),
    '零命中不是「两侧接近」，不该留 tie-break',
  )
})
