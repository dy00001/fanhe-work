/**
 * §2.5 持久化与复用：每个软件「最近有效路径」反查表的纯函数测试。
 *
 * 钉的是选取规则：同软件优先 ok、同状态取 updatedAt 最新、全 missing 时退回最近一条
 * （best-effort）、不同软件各自独立。表单只消费结果，规则在这里一处定义、一处测。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildSuggestedPaths } from '../src/lib/launch-suggest.ts'

function profile(id, software, executablePath, updatedAt) {
  return {
    id,
    software,
    name: id,
    executablePath,
    args: [],
    icon: null,
    sortOrder: 0,
    createdAt: updatedAt,
    updatedAt,
  }
}

function status(profileId, pathState) {
  return { profileId, pathState, lastRun: null }
}

test('null 配置返回空表', () => {
  assert.deepEqual(buildSuggestedPaths(null, {}), {})
})

test('单条 ok 即带出该软件路径', () => {
  const profiles = [profile('p1', 'wechat', 'C:\\WeChat\\WeChat.exe', '2026-01-01T00:00:00Z')]
  const statuses = { p1: status('p1', 'ok') }
  assert.deepEqual(buildSuggestedPaths(profiles, statuses), { wechat: 'C:\\WeChat\\WeChat.exe' })
})

test('同软件优先取 ok，而非更新的 missing', () => {
  const profiles = [
    profile('ok1', 'qq', 'C:\\QQ\\ok.exe', '2026-01-01T00:00:00Z'),
    profile('miss1', 'qq', 'C:\\QQ\\miss.exe', '2026-06-01T00:00:00Z'),
  ]
  const statuses = { ok1: status('ok1', 'ok'), miss1: status('miss1', 'missing') }
  assert.deepEqual(buildSuggestedPaths(profiles, statuses), { qq: 'C:\\QQ\\ok.exe' })
})

test('同状态取 updatedAt 最新', () => {
  const profiles = [
    profile('a', 'qianniu', 'C:\\old.exe', '2026-01-01T00:00:00Z'),
    profile('b', 'qianniu', 'C:\\new.exe', '2026-05-01T00:00:00Z'),
  ]
  const statuses = { a: status('a', 'ok'), b: status('b', 'ok') }
  assert.deepEqual(buildSuggestedPaths(profiles, statuses), { qianniu: 'C:\\new.exe' })
})

test('全部 missing 时退回最近一条路径（best-effort）', () => {
  const profiles = [
    profile('x', 'wechat', 'C:\\first.exe', '2026-01-01T00:00:00Z'),
    profile('y', 'wechat', 'C:\\second.exe', '2026-03-01T00:00:00Z'),
  ]
  const statuses = { x: status('x', 'missing'), y: status('y', 'missing') }
  assert.deepEqual(buildSuggestedPaths(profiles, statuses), { wechat: 'C:\\second.exe' })
})

test('不同软件各自独立', () => {
  const profiles = [
    profile('w', 'wechat', 'C:\\w.exe', '2026-01-01T00:00:00Z'),
    profile('q', 'qq', 'C:\\q.exe', '2026-02-01T00:00:00Z'),
  ]
  const statuses = { w: status('w', 'ok'), q: status('q', 'ok') }
  assert.deepEqual(buildSuggestedPaths(profiles, statuses), {
    wechat: 'C:\\w.exe',
    qq: 'C:\\q.exe',
  })
})
