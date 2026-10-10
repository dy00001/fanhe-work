/**
 * 相对时间展示的回归测试。
 *
 * 用 Node 内置测试器直接测源码：前端构建会把它打进浏览器 bundle，不能像共享包一样
 * 导入独立的 dist 模块。运行时启用 Node 的类型擦除即可，不需要新增依赖或重写实现。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { formatRelativeTime } from '../src/lib/relative-time.ts'

// 固定基准，避免测试随着执行时间变化，也避免跨日边界让结果漂移。
const NOW = Date.parse('2026-06-15T12:00:00.000Z')

function isoAt(diff) {
  return new Date(NOW + diff).toISOString()
}

const UNITS = [
  {
    name: '秒',
    ms: 1000,
    past: '1秒钟前',
    future: '1秒钟后',
    belowPast: '现在',
    belowFuture: '现在',
  },
  {
    name: '分钟',
    ms: 60 * 1000,
    past: '1分钟前',
    future: '1分钟后',
    belowPast: '59秒钟前',
    belowFuture: '59秒钟后',
  },
  {
    name: '小时',
    ms: 60 * 60 * 1000,
    past: '1小时前',
    future: '1小时后',
    belowPast: '59分钟前',
    belowFuture: '59分钟后',
  },
  {
    name: '天',
    ms: 24 * 60 * 60 * 1000,
    past: '昨天',
    future: '明天',
    belowPast: '23小时前',
    belowFuture: '23小时后',
  },
  {
    name: '月',
    ms: 30 * 24 * 60 * 60 * 1000,
    past: '上个月',
    future: '下个月',
    belowPast: '29天前',
    belowFuture: '29天后',
  },
  {
    name: '年',
    ms: 365 * 24 * 60 * 60 * 1000,
    past: '去年',
    future: '明年',
    belowPast: '12个月前',
    belowFuture: '12个月后',
  },
]

for (const { name, ms, past, future, belowPast, belowFuture } of UNITS) {
  test(`${name}按最大完整单位展示，过去与未来均截去小数`, () => {
    assert.equal(formatRelativeTime(isoAt(-ms), NOW), past)
    assert.equal(formatRelativeTime(isoAt(ms), NOW), future)
    // 差一毫秒不能提前切换单位；1.9 个单位不能四舍五入成两个单位。
    assert.equal(formatRelativeTime(isoAt(-(ms - 1)), NOW), belowPast)
    assert.equal(formatRelativeTime(isoAt(ms - 1), NOW), belowFuture)
    assert.equal(formatRelativeTime(isoAt(-1.9 * ms), NOW), past)
    assert.equal(formatRelativeTime(isoAt(1.9 * ms), NOW), future)
  })
}

test('相同时间及不足一秒的双向偏差都显示「现在」', () => {
  for (const diff of [-999, -1, 0, 1, 999]) {
    assert.equal(formatRelativeTime(isoAt(diff), NOW), '现在')
  }
})

test('无法解析的时间戳原样返回，不阻断界面展示', () => {
  for (const value of ['', 'not-a-date', '2026-99-99T00:00:00Z']) {
    assert.equal(formatRelativeTime(value, NOW), value)
  }
})

test('ISO 时区偏移按同一时刻处理，不按字符串上的日期判断', () => {
  assert.equal(formatRelativeTime('2026-06-15T20:00:00.000+08:00', NOW), '现在')
  assert.equal(formatRelativeTime('2026-06-15T19:00:00.000+08:00', NOW), '1小时前')
})

test('省略 now 时以 Date.now 为基准，保留现有调用方式', (context) => {
  // 只在本条测试内固定时钟，避免真实时间流逝造成默认参数用例偶发失败。
  context.mock.method(Date, 'now', () => NOW)
  assert.equal(formatRelativeTime(isoAt(-60 * 1000)), '1分钟前')
})
