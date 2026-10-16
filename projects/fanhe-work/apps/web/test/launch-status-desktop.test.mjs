/**
 * 桌面态路径状态覆盖：把外壳自检报告翻译成每条的 pathState（纯函数）。
 *
 * 钉的是「服务端（容器）看不见本机路径 → 恒判失效」这个真机 bug 的修法：桌面态改用
 * 启动同款的本机自检结果覆盖 pathState，且代理不可用时**不做判断**（退回服务端原值），
 * 而不是把每条都误标成失效。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { pathStatesFromDiagnostics } from '../src/lib/launch-status-desktop.ts'

function profile(id) {
  return {
    id,
    software: 'custom',
    name: id,
    executablePath: `D:\\软件安装目录\\${id}\\${id}.exe`,
    args: [],
    icon: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  }
}

function pathUnavailable(profileId) {
  return { profileId, reason: 'path_unavailable' }
}

test('代理可用、无诊断：每条都判 ok（自检只报不 ok 的条目）', () => {
  const profiles = [profile('p1'), profile('p2')]
  const states = pathStatesFromDiagnostics(profiles, { agentAvailable: true, diagnostics: [] })
  assert.deepEqual(states, { p1: 'ok', p2: 'ok' })
})

test('path_unavailable 的那条被标 missing，其余仍 ok', () => {
  const profiles = [profile('p1'), profile('p2')]
  const states = pathStatesFromDiagnostics(profiles, {
    agentAvailable: true,
    diagnostics: [pathUnavailable('p2')],
  })
  assert.deepEqual(states, { p1: 'ok', p2: 'missing' })
})

test('代理不可用时返回空表（不判断，交调用方保留服务端原值）', () => {
  const profiles = [profile('p1')]
  const states = pathStatesFromDiagnostics(profiles, {
    agentAvailable: false,
    diagnostics: [{ profileId: '', reason: 'agent_unavailable' }],
  })
  assert.deepEqual(states, {})
})

test('invalid_profile（profileId 为空）不参与路径状态归位', () => {
  const profiles = [profile('p1')]
  const states = pathStatesFromDiagnostics(profiles, {
    agentAvailable: true,
    diagnostics: [{ profileId: '', reason: 'invalid_profile' }],
  })
  assert.deepEqual(states, { p1: 'ok' })
})

test('诊断里出现未知 profileId 时不凭空造键', () => {
  const profiles = [profile('p1')]
  const states = pathStatesFromDiagnostics(profiles, {
    agentAvailable: true,
    diagnostics: [pathUnavailable('ghost')],
  })
  assert.deepEqual(Object.keys(states), ['p1'])
  assert.equal(states.p1, 'ok')
})
