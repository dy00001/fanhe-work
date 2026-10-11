/**
 * 事件取值规则的回归测试。
 *
 * 直接跑构建产物 dist，不跑源码，与 note.test.mjs / launch.test.mjs 的理由一致：
 * 服务端校验用的是 dist 里的那份代码，测它才是测真实生效的那份。
 *
 * 这里测的都不是「函数算得对不对」，而是**取值域本身没被悄悄改动**。事件的状态与
 * 优先级是产品定义的一部分：多一档、改一个拼写都不会让任何地方报错，只会让某一组
 * 数据在界面上落进「认不出来」的分支 —— 而那种现象看起来像渲染问题，不像数据问题。
 * 用一条会失败的测试把当前取值钉住，改的时候就必须是有意为之。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  EVENT_LIMITS,
  EVENT_LOG_ACTIONS,
  EVENT_PRIORITIES,
  EVENT_STATUSES,
  NOTE_LIMITS,
  isEventLogAction,
} from '../dist/index.js'

test('状态只有未完成与已完成两档，顺序也是界面分组的顺序', () => {
  assert.deepEqual([...EVENT_STATUSES], ['todo', 'done'])
})

test('优先级是三档，默认档是 normal', () => {
  assert.deepEqual([...EVENT_PRIORITIES], ['low', 'normal', 'high'])
})

test('状态变更日志的动作码', () => {
  // 创建、完成、撤销。撤销是再追加一行而不是删掉「完成」那一行，因此这里没有
  // 与 completed 配对的「取消完成」动作需要单独表示。
  assert.deepEqual([...EVENT_LOG_ACTIONS], ['created', 'completed', 'reopened'])
})

test('动作码的收窄只认精确取值', () => {
  assert.equal(isEventLogAction('created'), true)
  assert.equal(isEventLogAction('completed'), true)
  assert.equal(isEventLogAction('reopened'), true)

  // 大小写不折叠：动作码是代码里写死的常量，不是用户输入，接受大小写变体只会让
  // 「库里有两种写法」这件事不被发现。
  assert.equal(isEventLogAction('Created'), false)
  assert.equal(isEventLogAction('COMPLETED'), false)
  assert.equal(isEventLogAction(''), false)
  // 将来加的动作在旧版本代码里认不出 —— 这正是这个函数存在的意义，由调用方决定
  // 怎么展示，而不是在这里抛错。
  assert.equal(isEventLogAction('assigned'), false)
})

test('长度上限的完整取值', () => {
  // 逐项列出来而不是只测一两个：漏掉的那一项恰恰是最可能被改动的。
  assert.deepEqual(
    { ...EVENT_LIMITS },
    {
      TITLE_MAX: 200,
      DESCRIPTION_MAX: 100_000,
      TAG_MAX: 32,
      TAGS_MAX_COUNT: 20,
      SEARCH_MAX: 64,
      COMMENT_MAX: 200,
    },
  )
})

test('与纪要共用的那几个上限保持一致', () => {
  // 这几个值刻意与 NOTE_LIMITS 相同：用户在两个板块看到的是同一套标签与同一个
  // 搜索框。两人各改一边时不会有任何报错，只表现为「事件这边多打两个字就存不下」。
  //
  // 若将来两者确实需要分开，删掉这条测试是正确做法，但要在 DEVELOPMENT-PLAN 里
  // 写明为什么分开 —— 不要因为这条测试碍事就把它注释掉。
  assert.equal(EVENT_LIMITS.TAG_MAX, NOTE_LIMITS.TAG_MAX)
  assert.equal(EVENT_LIMITS.TAGS_MAX_COUNT, NOTE_LIMITS.TAGS_MAX_COUNT)
  assert.equal(EVENT_LIMITS.SEARCH_MAX, NOTE_LIMITS.SEARCH_MAX)
  assert.equal(EVENT_LIMITS.TITLE_MAX, NOTE_LIMITS.TITLE_MAX)
  assert.equal(EVENT_LIMITS.DESCRIPTION_MAX, NOTE_LIMITS.CONTENT_MAX)
})
