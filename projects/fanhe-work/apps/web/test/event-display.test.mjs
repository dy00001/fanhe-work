/**
 * 事件展示规则的回归测试。
 *
 * 与 `relative-time.test.mjs` / `note-draft.test.mjs` 同款：用 Node 内置测试器直接测
 * 源码（前端构建会把 `src/lib` 打进浏览器 bundle，不能像共享包那样导入独立的 dist）。
 *
 * 这里覆盖的全是**不靠界面就能判定**的规则：分组、逾期、截止时间的说法、以及时间在
 * 「ISO 时刻」与「`datetime-local` 输入值」之间的往返。**界面本身不在这里** —— 分组
 * 折叠、勾选框、行内四要素由浏览器 e2e 验证（见 `e2e-auth.mjs` 第 10 段）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { EVENT_PRIORITIES, EVENT_STATUSES } from '@fanhe/shared'

import {
  applyEventStatus,
  EVENT_PRIORITY_CLASSES,
  EVENT_PRIORITY_LABELS,
  EVENT_STATUS_LABELS,
  formatDueAt,
  fromDateTimeLocalValue,
  groupEvents,
  isOverdue,
  toDateTimeLocalValue,
} from '../src/lib/event-display.ts'

/** 构造一条最小可用的 Event，只覆盖被测字段。 */
function makeEvent(overrides = {}) {
  return {
    id: 'e1',
    title: '标题',
    description: '',
    status: 'todo',
    priority: 'normal',
    tags: [],
    dueAt: null,
    completedAt: null,
    completedBy: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 取值域到文案与样式的映射
// ---------------------------------------------------------------------------

test('每个优先级都有中文说法与配色，没有漏项', () => {
  for (const priority of EVENT_PRIORITIES) {
    assert.equal(typeof EVENT_PRIORITY_LABELS[priority], 'string', `缺 ${priority} 的说法`)
    assert.equal(typeof EVENT_PRIORITY_CLASSES[priority], 'string', `缺 ${priority} 的配色`)
    assert.notEqual(EVENT_PRIORITY_LABELS[priority], '')
    assert.notEqual(EVENT_PRIORITY_CLASSES[priority], '')
  }
  assert.equal(Object.keys(EVENT_PRIORITY_LABELS).length, EVENT_PRIORITIES.length)
})

test('每个状态都有中文说法，没有漏项', () => {
  for (const status of EVENT_STATUSES) {
    assert.equal(typeof EVENT_STATUS_LABELS[status], 'string', `缺 ${status} 的说法`)
  }
  assert.equal(Object.keys(EVENT_STATUS_LABELS).length, EVENT_STATUSES.length)
})

// ---------------------------------------------------------------------------
// 分组
// ---------------------------------------------------------------------------

test('按状态分组，且两组各自保持传入顺序', () => {
  const events = [
    makeEvent({ id: 'a', status: 'todo' }),
    makeEvent({ id: 'b', status: 'done' }),
    makeEvent({ id: 'c', status: 'todo' }),
    makeEvent({ id: 'd', status: 'done' }),
  ]

  const groups = groupEvents(events)

  assert.deepEqual(
    groups.open.map((item) => item.id),
    ['a', 'c'],
  )
  assert.deepEqual(
    groups.done.map((item) => item.id),
    ['b', 'd'],
  )
})

test('全为未完成时，已完成组是空数组而不是缺省', () => {
  const groups = groupEvents([makeEvent({ id: 'a' }), makeEvent({ id: 'b' })])
  assert.equal(groups.open.length, 2)
  assert.deepEqual(groups.done, [])
})

test('空列表分组后两组都是空数组', () => {
  const groups = groupEvents([])
  assert.deepEqual(groups.open, [])
  assert.deepEqual(groups.done, [])
})

// ---------------------------------------------------------------------------
// 乐观更新（勾选切换时改本地那一条）
// ---------------------------------------------------------------------------

test('改一条的状态，其余条目原样带过去', () => {
  const events = [makeEvent({ id: 'a' }), makeEvent({ id: 'b' }), makeEvent({ id: 'c' })]

  const next = applyEventStatus(events, 'b', 'done')

  assert.equal(next.length, 3)
  assert.equal(next[1].status, 'done')
  assert.equal(next[0].status, 'todo')
  assert.equal(next[2].status, 'todo')
  // 没动的那两条应当是同一个对象，而不是内容相同的新副本 —— 界面靠引用相等省下重画。
  assert.equal(next[0], events[0])
  assert.equal(next[2], events[2])
})

test('只改状态，不伪造完成时刻与完成人', () => {
  // 这两个字段是服务端的时间与身份快照，界面猜不出来；列表这一版也不展示它们。
  // 若这里顺手写一个「本地现在」，界面上会短暂显示一个可能偏掉的时刻，而权威值
  // 紧随其后由重拉覆盖 —— 那个中间值除了误导没有任何作用。
  const next = applyEventStatus([makeEvent({ id: 'a' })], 'a', 'done')
  assert.equal(next[0].completedAt, null)
  assert.equal(next[0].completedBy, null)
})

test('撤销（改回 todo）也能落在本地', () => {
  const events = [makeEvent({ id: 'a', status: 'done', completedAt: '2026-06-02T00:00:00.000Z' })]
  const next = applyEventStatus(events, 'a', 'todo')
  assert.equal(next[0].status, 'todo')
  // 完成信息由服务端在撤销时清空（三列一起），界面这一层不替它做决定 —— 下一个
  // 往返就会把服务端那份权威值取回来。
  assert.equal(next[0].completedAt, '2026-06-02T00:00:00.000Z')
})

test('找不到那条 id 时原样返回，不凭空补一条', () => {
  // 切换可能在「这条已被别处删掉」之后才回到界面。为了「让它有个状态」而补一条进去，
  // 表现是一行凭空出现又消失。
  const events = [makeEvent({ id: 'a' }), makeEvent({ id: 'b' })]
  const next = applyEventStatus(events, '不存在', 'done')
  assert.equal(next.length, 2)
  assert.deepEqual(
    next.map((item) => item.status),
    ['todo', 'todo'],
  )
})

test('不修改传入的数组，返回的是新数组', () => {
  const events = [makeEvent({ id: 'a' })]
  const next = applyEventStatus(events, 'a', 'done')
  assert.notEqual(next, events)
  assert.equal(events[0].status, 'todo')
})

// ---------------------------------------------------------------------------
// 逾期
// ---------------------------------------------------------------------------

const NOW = Date.parse('2026-06-15T12:00:00.000Z')

test('未完成且截止时间已过，算逾期', () => {
  const event = makeEvent({ dueAt: new Date(NOW - 60_000).toISOString() })
  assert.equal(isOverdue(event, NOW), true)
})

test('未完成但截止时间还没到，不算逾期', () => {
  const event = makeEvent({ dueAt: new Date(NOW + 60_000).toISOString() })
  assert.equal(isOverdue(event, NOW), false)
})

test('已完成的事件即便截止时间早过了也不标逾期', () => {
  const event = makeEvent({ status: 'done', dueAt: new Date(NOW - 86_400_000).toISOString() })
  assert.equal(isOverdue(event, NOW), false)
})

test('没有截止时间就不存在逾期', () => {
  assert.equal(isOverdue(makeEvent({ dueAt: null }), NOW), false)
})

test('截止时间解析不了时按「不算逾期」处理，不抛错', () => {
  assert.equal(isOverdue(makeEvent({ dueAt: '不是时间' }), NOW), false)
})

// ---------------------------------------------------------------------------
// 截止时间的说法
// ---------------------------------------------------------------------------

test('今年的截止时间省略年份', () => {
  const iso = new Date(2026, 9, 15, 18, 0).toISOString()
  const text = formatDueAt(iso, new Date(2026, 5, 1).getTime())
  assert.equal(text, '10月15日 18:00')
})

test('跨年的截止时间带上年份，避免「1月3日」产生歧义', () => {
  const iso = new Date(2027, 0, 3, 9, 30).toISOString()
  const text = formatDueAt(iso, new Date(2026, 5, 1).getTime())
  assert.equal(text, '2027年1月3日 09:30')
})

test('截止时间解析不了时原样返回，不抛错', () => {
  assert.equal(formatDueAt('不是时间'), '不是时间')
})

// ---------------------------------------------------------------------------
// ISO 时刻 <-> datetime-local 输入值的往返
// ---------------------------------------------------------------------------

test('往返保持本地墙上时间不变', () => {
  // 生成一个「本地 18:00」的时刻。断言写成「本地字段」而不是某个 UTC 字符串，
  // 因此在任何时区下都成立。
  const local = new Date(2026, 9, 15, 18, 0, 0)

  const value = toDateTimeLocalValue(local.toISOString())
  assert.equal(value, '2026-10-15T18:00')

  // 转回来应当与原时刻完全相等（秒与毫秒本来就是 0）。
  assert.equal(fromDateTimeLocalValue(value), local.toISOString())
})

test('null 与解析不了的值都给出空输入值', () => {
  assert.equal(toDateTimeLocalValue(null), '')
  assert.equal(toDateTimeLocalValue('不是时间'), '')
})

test('空输入值表示清除，返回 null', () => {
  assert.equal(fromDateTimeLocalValue(''), null)
})

test('个位数月份与日期补零', () => {
  const local = new Date(2026, 0, 3, 9, 5, 0)
  assert.equal(toDateTimeLocalValue(local.toISOString()), '2026-01-03T09:05')
})
