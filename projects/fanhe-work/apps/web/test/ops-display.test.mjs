/**
 * 运营看板展示规则的回归测试。
 *
 * 这个模块承担了四件容易出错、又不容易被肉眼发现的事：
 *
 *   1. 分 → 元只在这里除一次 100；
 *   2. 涨红跌绿（中国电商惯例，与欧美相反）；
 *   3. 比率是 0~1 的比例，不是百分点；
 *   4. 空值不等于 0，也不等于「无权限」。
 *
 * 四件事写错都不会报错，只会让读数系统性偏移。因此这里对每个函数都取**边界值**
 * 而不是取一个「看起来对」的中间值：0、null、负涨跌、恰好一万、恰好 26 小时。
 *
 * 时间类断言全部传固定的 `now`，不读系统时钟 —— 否则「26 小时」这类边界会在
 * 运行当天的时间点附近随机通过或失败。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  chineseDate,
  collectStatusLabel,
  collectStatusTone,
  deltaTone,
  formatCollectedAt,
  formatCount,
  formatDelta,
  formatDuration,
  formatFen,
  formatFenExact,
  formatPercent,
  formatSummary,
  freshnessOf,
  maxMetric,
  metricOf,
  peakIndex,
  seriesCeiling,
  shareOf,
  shortDate,
  sortByMetric,
  sourceLabel,
} from '../src/lib/ops-display.ts'

test('金额：分转元，一万以上收成「万」', () => {
  assert.equal(formatFen(0), '¥0')
  // 108,000 元 = 10,800,000 分
  assert.equal(formatFen(10_800_000), '¥108,000')
  assert.equal(formatFen(10_800_000, { compact: true }), '¥10.8万')
  assert.equal(formatFen(118_681, { compact: true }), '¥1,186.81')
  // null 不显示成 0 —— 没采到与没成交是两件事。
  assert.equal(formatFen(null), '—')
  assert.equal(formatFen(null, { compact: true }), '—')
})

test('金额：整元不带小数，非整元保留两位', () => {
  assert.equal(formatFenExact(389_000), '¥3,890.00')
  assert.equal(formatFenExact(1), '¥0.01')
  assert.equal(formatFenExact(null), '—')
})

test('计数：千分位，null 显示破折号', () => {
  assert.equal(formatCount(3890), '3,890')
  assert.equal(formatCount(0), '0')
  assert.equal(formatCount(null), '—')
})

test('比率：0~1 的比例转百分比，两位小数', () => {
  assert.equal(formatPercent(0.0234), '2.34%')
  assert.equal(formatPercent(0), '0.00%')
  assert.equal(formatPercent(1), '100.00%')
  assert.equal(formatPercent(null), '—')
  assert.equal(formatPercent(0.0234, 1), '2.3%')
})

test('时长：秒与分秒两种形态', () => {
  assert.equal(formatDuration(14.24), '14.2 秒')
  assert.equal(formatDuration(130), '2 分 10 秒')
  assert.equal(formatDuration(null), '—')
})

test('涨跌方向：正为 up（红），负为 down（绿），零与 null 为 flat', () => {
  assert.equal(deltaTone(0.701), 'up')
  assert.equal(deltaTone(-0.562), 'down')
  assert.equal(deltaTone(0), 'flat')
  // 没有基线时不能染色 —— 颜色本身就是一个结论。
  assert.equal(deltaTone(null), 'flat')
})

test('涨跌文案：带号、不可比、零值', () => {
  assert.equal(formatDelta(0.701), '+70.1%')
  assert.equal(formatDelta(-0.562), '-56.2%')
  assert.equal(formatDelta(0), '0.0%')
  assert.equal(formatDelta(null), '不可比')
})

test('口径徽标：三档各有中文名', () => {
  assert.equal(sourceLabel('daily'), '逐日')
  assert.equal(sourceLabel('derived'), '推算')
  assert.equal(sourceLabel('period'), '整段')
})

test('新鲜度：26 小时内为新鲜，26 至 48 小时转黄，超过 48 小时转红', () => {
  const now = new Date('2026-10-20T12:00:00.000Z')
  const at = (hours) => new Date(now.getTime() - hours * 3_600_000).toISOString()

  assert.equal(freshnessOf(at(1), now).level, 'fresh')
  // 边界取「等于 26 小时」仍算新鲜：采集在早上跑，到第二天同一时刻之前都算正常。
  assert.equal(freshnessOf(at(26), now).level, 'fresh')
  assert.equal(freshnessOf(at(27), now).level, 'stale')
  assert.equal(freshnessOf(at(48), now).level, 'stale')
  assert.equal(freshnessOf(at(49), now).level, 'old')
  assert.equal(freshnessOf(null, now).level, 'none')
  assert.equal(freshnessOf('不是时间', now).level, 'none')
})

test('新鲜度：小时数用于展示，null 时不编造', () => {
  const now = new Date('2026-10-20T12:00:00.000Z')
  const hours = freshnessOf(new Date(now.getTime() - 30 * 3_600_000).toISOString(), now).hours
  assert.equal(Math.round(hours ?? -1), 30)
  assert.equal(freshnessOf(null, now).hours, null)
})

test('日期文案：短格式与中文格式都从字符串直接切，不做时区换算', () => {
  assert.equal(shortDate('2026-09-19'), '09-19')
  assert.equal(chineseDate('2026-09-19'), '9月19日')
  assert.equal(chineseDate('2026-10-01'), '10月1日')
  // 非法输入原样返回，不抛错、不产出 NaN 月日。
  assert.equal(shortDate('2026/09/19'), '2026/09/19')
  assert.equal(chineseDate('bad'), 'bad')
})

test('占比：分母为零或缺失时为 null，不是 0', () => {
  assert.equal(shareOf(100, 400), 0.25)
  assert.equal(shareOf(0, 400), 0)
  assert.equal(shareOf(100, 0), null)
  assert.equal(shareOf(null, 100), null)
  assert.equal(shareOf(100, null), null)
})

test('采集状态：四态文案与色档', () => {
  assert.equal(collectStatusLabel('succeeded'), '成功')
  assert.equal(collectStatusLabel('partial'), '部分成功')
  assert.equal(collectStatusLabel('failed'), '失败')
  assert.equal(collectStatusLabel('running'), '采集中')
  assert.equal(collectStatusLabel(null), '无记录')
  assert.equal(collectStatusTone('succeeded'), 'ok')
  assert.equal(collectStatusTone('partial'), 'warn')
  assert.equal(collectStatusTone('failed'), 'bad')
  assert.equal(collectStatusTone(null), 'idle')
})

test('采集状态：超时的 running 显示「采集中断」，色档降为 bad', () => {
  // 服务端判好 stale 后传下来，前端只负责文案与色档 —— 不在这里重算阈值。
  assert.equal(collectStatusLabel('running', true), '采集中断')
  assert.equal(collectStatusTone('running', true), 'bad')
  // 未超时仍是「采集中」+ warn，两者必须能区分开，否则挂死的记录会被当成正在跑。
  assert.equal(collectStatusLabel('running', false), '采集中')
  assert.equal(collectStatusTone('running', false), 'warn')
  // stale 只对 running 有意义；别的状态带了这个标记也不能被改写成「中断」，
  // 否则一条成功批次的记录会变成故障提示。
  assert.equal(collectStatusLabel('succeeded', true), '成功')
  assert.equal(collectStatusTone('succeeded', true), 'ok')
})

test('维度读数：数字、数字字符串、null、缺失一律收敛成数或 null', () => {
  const row = { metrics: { visitors: 12, payRate: '0.5', note: 'abc', missing: null } }
  assert.equal(metricOf(row, 'visitors'), 12)
  assert.equal(metricOf(row, 'payRate'), 0.5)
  // 非数字字符串不能变成 0，否则「文本字段」会显示成 0。
  assert.equal(metricOf(row, 'note'), null)
  assert.equal(metricOf(row, 'missing'), null)
  assert.equal(metricOf(row, 'absent'), null)
})

test('排序：降序、升序，空值永远垫底', () => {
  const rows = [
    { key: 'a', metrics: { v: 10 } },
    { key: 'b', metrics: { v: null } },
    { key: 'c', metrics: { v: 30 } },
  ]
  assert.deepEqual(
    sortByMetric(rows, 'v', 'desc').map((row) => row.key),
    ['c', 'a', 'b'],
  )
  assert.deepEqual(
    sortByMetric(rows, 'v', 'asc').map((row) => row.key),
    ['a', 'c', 'b'],
  )
  // 原数组不被修改。
  assert.deepEqual(
    rows.map((row) => row.key),
    ['a', 'b', 'c'],
  )
})

test('最大值与峰值：全零或全空时不返回 NaN / 负数下标', () => {
  assert.equal(maxMetric([{ metrics: { v: 3 } }, { metrics: { v: 9 } }], 'v'), 9)
  assert.equal(maxMetric([{ metrics: { v: null } }], 'v'), 0)
  assert.equal(seriesCeiling([0, 0, 0]), 1)
  assert.equal(seriesCeiling([0, 5, 2]), 5)
  assert.equal(peakIndex([0, 5, 2]), 1)
  // 全是空值时没有峰值日，界面据此不渲染「峰值为 …」那一句。
  assert.equal(peakIndex([null, null]), -1)
})

test('整段指标：认识的键按单位格式化，不认识的返回 null', () => {
  assert.equal(formatSummary('bounceRate', 0.699), '69.9%')
  assert.equal(formatSummary('stayTime', 14.24), '14.2 秒')
  assert.equal(formatSummary('pv', 6891), '6,891')
  assert.equal(formatSummary('unknownKey', 1), null)
})

test('采集时刻：本地 MM-DD HH:mm，非法输入给破折号', () => {
  // 用固定时刻但按本地时区读回，因此只断言形状而不是具体数字 —— 断言具体数字
  // 会让这个用例在东八区之外的机器上失败。
  const formatted = formatCollectedAt('2026-10-19T00:31:00.000Z')
  assert.match(formatted, /^\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatCollectedAt(null), '—')
  assert.equal(formatCollectedAt('not-a-date'), '—')
})
