/**
 * 纪要取值规则的回归测试。
 *
 * 直接跑构建产物 dist，不跑源码，与 launch.test.mjs 的理由一致：服务端校验用的是
 * dist 里的那份代码，测它才是测真实生效的那份。
 *
 * `normalizeNoteTags` 值得单独测，是因为它的错误不会报错，只会表现为「界面上显示
 * 三个标签、库里存了四个」这类计数对不上。而这类不一致在功能上完全看不出来，只有
 * 人主动去数才会发现。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { NOTE_LIMITS, isValidNoteTag, normalizeNoteTags } from '../dist/index.js'

test('归一去掉首尾空白', () => {
  assert.deepEqual(normalizeNoteTags(['  工作  ', '\t周报 ']), ['工作', '周报'])
})

test('归一丢掉空串与全空白项', () => {
  assert.deepEqual(normalizeNoteTags(['', '   ', '工作']), ['工作'])
})

test('归一按首次出现顺序去重', () => {
  // 顺序要保留：标签的显示顺序应当由用户输入的顺序决定，去重不该顺带重排。
  assert.deepEqual(normalizeNoteTags(['乙', '甲', '乙', '丙', '甲']), ['乙', '甲', '丙'])
})

test('归一在去空白之后才去重', () => {
  // 「工作」与「 工作 」归一后是同一个标签。先去重再trim会让这两条都留下，
  // 而它们在界面上看起来完全一样。
  assert.deepEqual(normalizeNoteTags(['工作', ' 工作 ', '工作  ']), ['工作'])
})

test('归一不做大小写折叠', () => {
  // 英文标签是否区分大小写取决于用户意图，替用户决定会让他失去这个能力。
  assert.deepEqual(normalizeNoteTags(['Work', 'work']), ['Work', 'work'])
})

test('归一保留中文、数字与符号混排', () => {
  assert.deepEqual(normalizeNoteTags(['2026-Q4', '客户:A', '待办/紧急']), [
    '2026-Q4',
    '客户:A',
    '待办/紧急',
  ])
})

test('空数组归一后还是空数组', () => {
  assert.deepEqual(normalizeNoteTags([]), [])
})

test('合法标签的长度边界', () => {
  assert.equal(isValidNoteTag('a'), true)
  assert.equal(isValidNoteTag('中'.repeat(NOTE_LIMITS.TAG_MAX)), true)
})

test('空标签与超长标签都不合法', () => {
  assert.equal(isValidNoteTag(''), false)
  assert.equal(isValidNoteTag('中'.repeat(NOTE_LIMITS.TAG_MAX + 1)), false)
})

test('标签上限是一个正数且不超过 100', () => {
  // 上限本身没有对错，但为 0 或负数会让任何一次提交都被拒，而那种配置错误在
  // 单元测试之外只表现为「标签一个也存不进去」。
  assert.equal(NOTE_LIMITS.TAGS_MAX_COUNT > 0, true)
  assert.equal(NOTE_LIMITS.TAGS_MAX_COUNT <= 100, true)
})
