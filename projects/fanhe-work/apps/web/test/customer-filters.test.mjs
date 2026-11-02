/**
 * 客户平台筛选层的测试。
 *
 * 这一层的错法全都很安静：「本周」从周日算起会少一天，「本季」按月份整除算错会
 * 落进上一个季度，自定义区间的终点少加一天会让最后一天的客户整批消失。它们在
 * 浏览器里都表现为「列表少了几个人」，而没人知道应该是几个人。
 *
 * 「现在」一律由测试注入，所以这些断言在任何一天跑都是同一个结果。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  CUSTOMER_RANGE_OPTIONS,
  activeFilterCount,
  clearFilter,
  customInputs,
  customRange,
  filtersFromParams,
  filtersKey,
  filtersToParams,
  hourRange,
  isCustomerRangeKey,
  overlapsActivity,
  parseRangeParam,
  presetRange,
  rangeLabel,
  rangeQuery,
  resolveCustomerRange,
} from '../src/lib/customer-filters.ts'

/** 2026-10-30 是周五。选它是因为「本周」要往前跨 4 天，能验出偏移量。 */
const NOW = new Date(2026, 9, 30, 15, 7)
const DAY = 24 * 60 * 60 * 1000

const iso = (date) => date.toISOString()
const local = (y, m, d, h = 0, min = 0) => new Date(y, m - 1, d, h, min)

test('预设区间：日 / 周 / 月 / 季 / 年都按本地日历切，且是半开区间', () => {
  assert.deepEqual(presetRange('day', NOW), {
    from: local(2026, 10, 30),
    to: local(2026, 10, 31),
  })
  // 2026-10-30 是周五，本周一应当是 10-26，下周一 11-02。
  assert.deepEqual(presetRange('week', NOW), {
    from: local(2026, 10, 26),
    to: local(2026, 11, 2),
  })
  assert.deepEqual(presetRange('month', NOW), {
    from: local(2026, 10, 1),
    to: local(2026, 11, 1),
  })
  assert.deepEqual(presetRange('quarter', NOW), {
    from: local(2026, 10, 1),
    to: local(2027, 1, 1),
  })
  assert.deepEqual(presetRange('year', NOW), {
    from: local(2026, 1, 1),
    to: local(2027, 1, 1),
  })
})

test('周从周一起算：周日不能算成下一周的第一天', () => {
  // 2026-11-01 是周日。按 `getDay()` 直接用 0 会让「本周」从 11-01 开始，
  // 于是周一到周六的客户全被排除在「本周」之外。
  const sunday = new Date(2026, 10, 1, 10, 0)
  const range = presetRange('week', sunday)
  assert.equal(range.from.getDay(), 1, '起点必须是周一')
  assert.deepEqual(range.from, local(2026, 10, 26))
  assert.deepEqual(range.to, local(2026, 11, 2))
})

test('季度按自然季度切：10 月属于第四季度，起点是 10-01', () => {
  const q4 = presetRange('quarter', local(2026, 10, 1))
  assert.deepEqual(q4.from, local(2026, 10, 1))
  const q1 = presetRange('quarter', local(2026, 3, 31, 23, 59))
  assert.deepEqual(q1.from, local(2026, 1, 1))
  assert.deepEqual(q1.to, local(2026, 4, 1))
})

test('同一天内的不同时刻算出的预设区间完全相同（否则筛选会反复重取）', () => {
  const morning = presetRange('month', local(2026, 10, 30, 0, 1))
  const night = presetRange('month', local(2026, 10, 30, 23, 59))
  assert.equal(iso(morning.from), iso(night.from))
  assert.equal(iso(morning.to), iso(night.to))
})

test('自定义区间：输入框两端都含，地址里的终点是次日零点', () => {
  const range = customRange('2026-10-01', '2026-10-15')
  assert.ok(range)
  assert.equal(iso(range.from), iso(local(2026, 10, 1)))
  // 选到 10-15，终点必须是 10-16 的零点，否则 15 日当天的客户全部落在区间外。
  assert.equal(iso(range.to), iso(local(2026, 10, 16)))
  assert.equal(range.label, '10-01 ~ 10-15')
  assert.equal(range.fromParam, '2026-10-01')
  assert.equal(range.toParam, '2026-10-16')
  // 再折回输入框，应当原样回到用户填的那两天。
  assert.deepEqual(customInputs(range), { from: '2026-10-01', to: '2026-10-15' })
})

test('自定义区间：同一天起止是合法的「只看这一天」', () => {
  const range = customRange('2026-10-30', '2026-10-30')
  assert.ok(range)
  assert.equal(range.label, '10-30')
  assert.equal(range.to.getTime() - range.from.getTime(), DAY)
})

test('自定义区间：终点早于起点返回 null，不静默产出空区间', () => {
  assert.equal(customRange('2026-10-15', '2026-10-01'), null)
  assert.equal(customRange('', '2026-10-01'), null)
  assert.equal(customRange('2026-10-01', ''), null)
})

test('日期参数：非法日期不被静默滚到下个月', () => {
  assert.equal(parseRangeParam('2026-02-31'), null)
  assert.equal(parseRangeParam('2026-13-01'), null)
  assert.equal(parseRangeParam('abc'), null)
  assert.equal(parseRangeParam(null), null)
  assert.ok(parseRangeParam('2026-02-28'))
  assert.ok(parseRangeParam('2026-10-30T14:00'))
})

test('按小时的区间：地址里带时刻，标签精确到小时', () => {
  const hour = hourRange(local(2026, 10, 30, 14).toISOString())
  assert.ok(hour)
  assert.equal(hour.fromParam, '2026-10-30T14:00')
  assert.equal(hour.toParam, '2026-10-30T15:00')
  assert.equal(hour.label, '10-30 14:00 ~ 15:00')
  assert.equal(hour.to.getTime() - hour.from.getTime(), 60 * 60 * 1000)
})

test('区间文案：按天与按小时分开写，避免把一小时读成一整天', () => {
  assert.equal(rangeLabel(null, null), '全部时间')
  assert.equal(rangeLabel(local(2026, 10, 1), local(2026, 10, 31)), '10-01 ~ 10-30')
  assert.equal(rangeLabel(local(2026, 10, 30, 14), local(2026, 10, 30, 15)), '10-30 14:00 ~ 15:00')
})

test('预设档位带上档位名，界面上一眼能看出筛的是哪一档', () => {
  const range = resolveCustomerRange({ preset: 'month', from: null, to: null }, NOW)
  assert.equal(range.key, 'month')
  assert.equal(range.label, '本月（10-01 ~ 10-31）')
  // 预设档位不把日期写进地址：只写 p=month，换一天打开会自动落到新的「本月」。
  assert.equal(range.fromParam, null)
  assert.equal(range.toParam, null)
})

test('地址里缺了自定义参数时回落到全部，并标记 degraded', () => {
  const range = resolveCustomerRange({ preset: 'custom', from: '2026-10-01', to: null }, NOW)
  assert.equal(range.key, 'all')
  assert.equal(range.degraded, true)
  // 认不出的档位同样回到全部，但不算 degraded（那是拼错的旧链接，不是缺参数）。
  assert.equal(resolveCustomerRange({ preset: 'xyz', from: null, to: null }, NOW).key, 'all')
})

test('地址编解码：默认值不写进地址，自定义区间带上两端', () => {
  const empty = filtersFromParams(new URLSearchParams(), NOW)
  assert.equal(filtersToParams(empty).toString(), '')
  assert.equal(activeFilterCount(empty), 0)

  const custom = {
    ...empty,
    range: customRange('2026-10-01', '2026-10-15'),
    scope: 'overseas',
    stage: 'designing',
    q: '李',
    pendingReview: true,
  }
  const params = filtersToParams(custom)
  assert.equal(params.get('p'), 'custom')
  assert.equal(params.get('from'), '2026-10-01')
  assert.equal(params.get('to'), '2026-10-16')
  assert.equal(params.get('scope'), 'overseas')
  assert.equal(params.get('stage'), 'designing')
  assert.equal(params.get('q'), '李')
  assert.equal(params.get('review'), 'pending')
  assert.equal(activeFilterCount(custom), 5)

  // 折回对象后必须与原来等价，否则「跳转带上筛选」这条约定就是空的。
  const back = filtersFromParams(params, NOW)
  assert.equal(filtersKey(back), filtersKey(custom))
})

test('清除单个条件只影响那一项，其余筛选保持原样', () => {
  const base = filtersFromParams(new URLSearchParams(), NOW)
  const filled = {
    ...base,
    range: customRange('2026-10-01', '2026-10-15'),
    scope: 'overseas',
    stage: 'designing',
  }
  const cleared = clearFilter(filled, 'scope')
  assert.equal(cleared.scope, '')
  assert.equal(cleared.stage, 'designing')
  assert.equal(cleared.range.key, 'custom')
  // 清掉时间条件后必须回到「全部」，不能残留 from/to。
  const noRange = clearFilter(filled, 'range')
  assert.equal(noRange.range.key, 'all')
  assert.equal(noRange.range.from, null)
  assert.equal(filtersToParams(noRange).get('from'), null)
})

test('活跃度窗口与当前时间筛选取交集：上月区间必然与最近 24 小时不相交', () => {
  assert.equal(
    overlapsActivity(resolveCustomerRange({ preset: 'day', from: null, to: null }, NOW), NOW),
    true,
  )
  const lastMonth = {
    key: 'custom',
    from: local(2026, 9, 1),
    to: local(2026, 10, 1),
    label: '',
    fromParam: null,
    toParam: null,
    degraded: false,
  }
  assert.equal(overlapsActivity(lastMonth, NOW), false)
  // 全部时间与任何窗口都有交集。
  assert.equal(
    overlapsActivity(resolveCustomerRange({ preset: 'all', from: null, to: null }, NOW), NOW),
    true,
  )
})

test('档位清单与识别函数一致：界面上每个按钮都能被地址参数认出来', () => {
  for (const option of CUSTOMER_RANGE_OPTIONS) {
    assert.equal(isCustomerRangeKey(option.key), true, `${option.key} 应当是合法档位`)
  }
  assert.equal(isCustomerRangeKey('7d'), false)
})

/**
 * 请求参数必须是接口认得的短格式。
 *
 * 这条断言来自一次真实故障：页面拿 `Date.toISOString()` 直接拼参数，产出
 * `2026-10-01T00:00:00.000Z`，服务端的 pattern 校验当场回 400
 * 「querystring/from must match pattern」，界面显示「加载失败」，而筛选按钮
 * 看起来完全正常 —— 除「全部」以外的每一档都点不动。
 *
 * 顺带挡住第二个更安静的问题：完整 ISO 末尾的 `Z` 是 UTC。就算接口放宽了
 * 校验，东八区的「本月」也会被解释成上月最后一天的 16:00。
 */
const SERVER_PATTERN = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/

test('请求参数：每一档时间筛选都产出接口认得的短格式', () => {
  const cases = [
    ['year', resolveCustomerRange({ preset: 'year', from: null, to: null }, NOW)],
    ['quarter', resolveCustomerRange({ preset: 'quarter', from: null, to: null }, NOW)],
    ['month', resolveCustomerRange({ preset: 'month', from: null, to: null }, NOW)],
    ['week', resolveCustomerRange({ preset: 'week', from: null, to: null }, NOW)],
    ['day', resolveCustomerRange({ preset: 'day', from: null, to: null }, NOW)],
    ['custom 按天', customRange('2026-10-01', '2026-10-15')],
    ['custom 按小时', hourRange(local(2026, 10, 30, 14).toISOString())],
  ]

  for (const [name, range] of cases) {
    assert.notEqual(range, null, `${name} 应当构造成功`)
    const { from, to } = rangeQuery(range)
    assert.match(from, SERVER_PATTERN, `${name} 的 from 不符合接口 pattern：${from}`)
    assert.match(to, SERVER_PATTERN, `${name} 的 to 不符合接口 pattern：${to}`)
    // 反向对照：完整 ISO 必须被判为不合规，否则上面两条断言等于没写。
    assert.equal(
      SERVER_PATTERN.test(range.from.toISOString()),
      false,
      `${name} 的完整 ISO 不该通过`,
    )
  }

  // 「全部」不传参数，由页面按空字符串省掉，而不是传空串上去。
  assert.deepEqual(rangeQuery(resolveCustomerRange({ preset: 'all', from: null, to: null }, NOW)), {
    from: '',
    to: '',
  })
})

test('请求参数：本季的起点是本地零点，不能被 UTC 挪走', () => {
  const { from, to } = rangeQuery(
    resolveCustomerRange({ preset: 'quarter', from: null, to: null }, NOW),
  )
  // 2026-10-30 属于第四季度，区间是 [10-01, 次年 01-01)。
  assert.equal(from, '2026-10-01')
  assert.equal(to, '2027-01-01')
})

test('页面必须经 rangeQuery 取参数，不能自己拿 Date 拼', () => {
  const source = readFileSync(new URL('../src/pages/CustomerPage.tsx', import.meta.url), 'utf8')
  assert.ok(
    source.includes('rangeQuery(filters.range)'),
    '页面应当调用 rangeQuery(filters.range) 构造请求参数',
  )
  // 这一条才是真正拦住回归的：`range.from?.toISOString()` 写法一旦回潮，接口就 400。
  assert.equal(
    /range\.(from|to)[^\n]*toISOString\(\)/.test(source),
    false,
    '不能对区间端点调 toISOString()：接口 pattern 会拒收，且带 Z 是 UTC',
  )
})
