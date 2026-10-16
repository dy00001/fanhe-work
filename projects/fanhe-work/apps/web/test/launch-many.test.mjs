/**
 * 批量启动聚合的回归测试（2.2）。
 *
 * `summarizeLaunchMany` 是浏览器态逐条启动后把 `Promise.allSettled` 结果聚合成
 * `LaunchRunManyResult` 的纯函数。桌面态 IPC 返回的是同一份形状，界面用同一套渲染逻辑。
 *
 * 设计要点要靠用例钉住：单条失败只落在自己那一项、成功数/失败数算对、非
 * `ApiError`/`LaunchRunError` 的失败回落到 `spawn_failed`（而不是抛错或误判成 relocate）。
 *
 * 这里不依赖 `lib/launch.ts` 本身（它牵出 `./api` 的 `import.meta.env` 与 `./session`），
 * 只测纯模块 `lib/launch-recovery.ts`，因此可在 Node 里直接 load。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { summarizeLaunchMany } from '../src/lib/launch-recovery.ts'

function profile(id) {
  return {
    id,
    software: 'custom',
    name: id,
    executablePath: 'C:/x.exe',
    args: [],
    icon: null,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
  }
}

test('全部成功 → success 等于条数，每条带 pid', () => {
  const profiles = [profile('a'), profile('b')]
  const settled = [
    { status: 'fulfilled', value: { profileId: 'a', pid: 1, startedAt: '', deduplicated: false } },
    { status: 'fulfilled', value: { profileId: 'b', pid: 2, startedAt: '', deduplicated: false } },
  ]
  const result = summarizeLaunchMany(profiles, settled)
  assert.equal(result.summary.success, 2)
  assert.equal(result.summary.failed, 0)
  assert.deepEqual(
    result.results.map((item) => item.pid),
    [1, 2],
  )
})

test('单条失败只落在自己那一项，且带 code', () => {
  const profiles = [profile('a'), profile('b'), profile('c')]
  const settled = [
    { status: 'fulfilled', value: { profileId: 'a', pid: 1, startedAt: '', deduplicated: false } },
    { status: 'rejected', reason: { code: 'executable_missing', message: '路径失效' } },
    { status: 'rejected', reason: { code: 'spawn_failed', message: '创建失败' } },
  ]
  const result = summarizeLaunchMany(profiles, settled)
  assert.equal(result.summary.success, 1)
  assert.equal(result.summary.failed, 2)
  const b = result.results.find((item) => item.profileId === 'b')
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'executable_missing')
  assert.equal(b.detail, '路径失效')
})

test('非 ApiError/LaunchRunError 的失败回落到 spawn_failed', () => {
  const profiles = [profile('a')]
  const settled = [{ status: 'rejected', reason: new Error('network') }]
  const result = summarizeLaunchMany(profiles, settled)
  assert.equal(result.results[0].reason, 'spawn_failed')
  assert.equal(result.results[0].detail, '启动失败')
})

test('空数组 → 空汇总', () => {
  const result = summarizeLaunchMany([], [])
  assert.equal(result.summary.total, 0)
  assert.deepEqual(result.results, [])
})
