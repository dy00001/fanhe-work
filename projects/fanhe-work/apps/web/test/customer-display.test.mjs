/**
 * 客户平台展示规则的测试。
 *
 * 这一层的错误全都「看起来正常」：金额少两位、进度条因为分母取错永远是 100%、
 * 退款客户显示成已完结。它们在浏览器里都能靠点几下发现，但没人每次改代码都点一遍。
 *
 * 金额那几条是重点：`formatFen` 手写成 `(fen / 100).toFixed(2)` 时，遇到大额会因为
 * 浮点表示误差少一分，而界面上那个数字看不出任何异常。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  activityOf,
  fillStageBuckets,
  formatFen,
  formatWan,
  orderProgress,
  parseYuanToFen,
  reviewLabel,
  scopeLabel,
  splitStepSections,
  stageTone,
} from '../src/lib/customer-display.ts'

const step = (idx, patch = {}) => ({
  idx,
  name: `环节${idx}`,
  reached: false,
  done: false,
  startedAt: null,
  finishedAt: null,
  dateImprecise: false,
  note: null,
  ...patch,
})

test('金额：null 显示「未录入」，0 显示 0 元，两者不能混', () => {
  assert.equal(formatFen(null), '未录入')
  assert.equal(formatFen(0), '0 元')
  // 「录了 0 元」与「还没录」在金额列上如果长得一样，前者就会被当成漏填反复追问。
  assert.notEqual(formatFen(null), formatFen(0))
})

test('金额：分转元带千分位，且大额不因浮点误差少一分', () => {
  assert.equal(formatFen(16_800_000), '168,000 元')
  assert.equal(formatFen(123_456_789), '1,234,567.89 元')
  // 这一条专治 `(fen / 100).toFixed(2)` 那类写法：123456789 分是 1234567.89 元，
  // 浮点除法会算出 1234567.8900000001 或 .8899999999，两位小数就少一分。
  assert.ok(formatFen(123_456_789).endsWith('.89 元'))
  assert.equal(formatFen(1), '0.01 元')
})

test('万元口径：不足一万退回「元」，避免 1200 被读成一万二', () => {
  assert.equal(formatWan(500_000), '5,000 元')
  assert.equal(formatWan(1_200_000), '1.2 万')
  assert.equal(formatWan(null), '未录入')
})

test('元输入转分：接受整数、两位小数、千分位逗号', () => {
  assert.deepEqual(parseYuanToFen('168000'), { ok: true, fen: 16_800_000 })
  assert.deepEqual(parseYuanToFen('168000.5'), { ok: true, fen: 16_800_050 })
  assert.deepEqual(parseYuanToFen('168,000'), { ok: true, fen: 16_800_000 })
})

test('元输入转分：空、非法、负数、超大各返回不同原因', () => {
  assert.deepEqual(parseYuanToFen('   '), { ok: false, reason: 'empty' })
  assert.deepEqual(parseYuanToFen('十万'), { ok: false, reason: 'invalid' })
  // 三位小数不是「差不多」，是有人把厘也算进去了，得让他改。
  assert.deepEqual(parseYuanToFen('100.123'), { ok: false, reason: 'invalid' })
  assert.deepEqual(parseYuanToFen('-1'), { ok: false, reason: 'negative' })
  assert.deepEqual(parseYuanToFen('999999999'), { ok: false, reason: 'too-large' })
})

test('阶段色调：退款与流失单独一档，不混进已完结', () => {
  // 审计里最严重的一类误判：客户正在要求退定金，界面显示已完结。
  assert.equal(stageTone('closed'), 'done')
  assert.equal(stageTone('refunding'), 'danger')
  assert.equal(stageTone('lost'), 'danger')
  assert.notEqual(stageTone('refunding'), stageTone('closed'))
  assert.equal(stageTone('producing'), 'progress')
  assert.equal(stageTone('consulting'), 'neutral')
  assert.equal(stageTone('after_sales'), 'warn')
})

test('地区层级有中文文案，不把英文枚举显示到界面上', () => {
  assert.equal(scopeLabel('special-region'), '港澳台')
  assert.equal(scopeLabel('overseas'), '海外')
  assert.equal(scopeLabel('domestic'), '国内')
})

test('订单进度：分母是全部环节，不是已到达的环节', () => {
  const steps = Array.from({ length: 14 }, (_, index) => step(index + 1, { reached: index < 5 }))
  const progress = orderProgress(steps)
  // 5 个已到达 → 0 个完成。
  assert.equal(progress.reached, 5)
  assert.equal(progress.done, 0)
  assert.equal(progress.total, 14)
  assert.equal(progress.percent, 0)
  // 若分母取成「已到达的环数」，这里会是 0/5，同样为 0 但语义错了；
  // 下面这条才是真正区分两种算法的地方。
  const half = orderProgress(
    Array.from({ length: 14 }, (_, index) => step(index + 1, { done: index < 7, reached: true })),
  )
  assert.equal(half.percent, 50)
})

test('订单进度：全部完成才是 100%', () => {
  const all = Array.from({ length: 14 }, (_, index) =>
    step(index + 1, { done: true, reached: true }),
  )
  assert.equal(orderProgress(all).percent, 100)
})

test('十四环节切成四段，段内序号连续且不重不漏', () => {
  const steps = Array.from({ length: 14 }, (_, index) => step(index + 1))
  const sections = splitStepSections(steps)
  assert.deepEqual(
    sections.map((section) => section.key),
    ['main', 'decision', 'spare', 'close'],
  )
  const flat = sections.flatMap((section) => section.steps.map((item) => item.idx))
  // 不重不漏是这条的意义：切错边界会让某一环在两个段里各出现一次，
  // 而界面上只是「多了一行」，看不出是 bug。
  assert.deepEqual(
    flat,
    Array.from({ length: 14 }, (_, index) => index + 1),
  )
  assert.equal(sections[1].steps.length, 1, '判定节点自成一环')
})

test('阶段分布：缺档补零并按主线顺序排，退款与流失排最后', () => {
  const filled = fillStageBuckets(
    [
      { stage: 'lost', count: 2 },
      { stage: 'producing', count: 3 },
      { stage: 'consulting', count: 5 },
    ],
    ['consulting', 'deposited', 'measured', 'producing', 'closed', 'refunding', 'lost'],
  )
  // 旁支两档（退款中、流失）没有主线序号，`compareStage` 把它们都排到主线之后，
  // 两者之间按 code 字典序 —— 于是 `lost` 在 `refunding` 之前。这个次序由契约
  // 决定，展示层不另立一套：两处各排一次，某天改了一处就会出现「看板与列表顺序不同」。
  assert.deepEqual(
    filled.map((bucket) => bucket.stage),
    ['consulting', 'deposited', 'measured', 'producing', 'closed', 'lost', 'refunding'],
  )
  assert.equal(filled[1].count, 0, '没有数据的档位补 0，而不是缺行导致标签跳位')
  assert.equal(filled[3].count, 3)
})

test('复核标签：已确认不显示，待复核区分高低置信', () => {
  assert.equal(reviewLabel('confirmed', 'high'), null)
  assert.equal(reviewLabel('pending', 'high'), '待复核')
  assert.equal(reviewLabel('pending', 'low'), '待复核 · 低置信')
  assert.equal(reviewLabel('pending', 'none'), '待复核 · 低置信')
  assert.equal(reviewLabel('rejected', 'high'), '已驳回')
})

test('活跃度按自然日算，不按毫秒 —— 昨晚 23:50 是「昨天」而不是「今天」', () => {
  // 2026-10-29 08:00 本地时间
  const now = new Date(2026, 9, 29, 8, 0).getTime()

  // 昨晚 23:50 距今不到 9 小时。按毫秒算会得出「今天」，而人说的今天是日历上的今天。
  const yesterdayLate = new Date(2026, 9, 28, 23, 50).getTime()
  assert.equal(activityOf(new Date(yesterdayLate).toISOString(), now).label, '昨天有消息')

  // 今天凌晨 00:10（哪怕只过了 8 小时）算今天。
  const todayEarly = new Date(2026, 9, 29, 0, 10).getTime()
  assert.equal(activityOf(new Date(todayEarly).toISOString(), now).label, '今天有消息')
})

test('活跃度分档：一周内、一月内、半年内、超过半年', () => {
  const now = new Date(2026, 9, 29, 8, 0).getTime()
  const daysAgo = (n) => new Date(2026, 9, 29 - n, 12, 0).toISOString()

  assert.equal(activityOf(daysAgo(3), now).label, '近一周有消息')
  assert.equal(activityOf(daysAgo(3), now).level, 'active')

  assert.equal(activityOf(daysAgo(12), now).label, '12 天前')
  assert.equal(activityOf(daysAgo(12), now).level, 'warm')

  assert.equal(activityOf(daysAgo(75), now).label, '2 个月前')
  assert.equal(activityOf(daysAgo(75), now).level, 'idle')

  assert.equal(activityOf(daysAgo(300), now).label, '超过半年没动')
  assert.equal(activityOf(daysAgo(300), now).level, 'cold')
})

test('没有消息、时间坏掉、未来时间都不许显示成负数', () => {
  const now = new Date(2026, 9, 29, 8, 0).getTime()
  assert.equal(activityOf(null, now).label, '没有消息')
  assert.equal(activityOf('', now).level, 'unknown')
  assert.equal(activityOf('不是时间', now).level, 'unknown')
  // 时钟不同步或手工改过库时会出现未来时间。显示「-3 天前」比不显示更糟。
  assert.equal(activityOf(new Date(2026, 9, 30, 12, 0).toISOString(), now).label, '今天有消息')
})
