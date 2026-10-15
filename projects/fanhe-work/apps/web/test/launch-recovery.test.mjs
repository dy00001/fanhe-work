/**
 * 启动失败恢复出口的回归测试（2.1）。
 *
 * 2.1 让桌面态经 IPC 启动失败也能走 `launchRunRecovery` 分流。这个函数只认 `code`、
 * 不认来源，因此 HTTP 失败（`ApiError.code`）与本机失败（`LaunchRunError.code`）必须
 * 得到同样的出口。如果哪天有人把它改回只认 `ApiError`，桌面态的路径失效就会被误判成
 * 「可重试」，用户被引去反复点一个注定失败的按钮 —— 这正是设计文档点名要防的现场。
 *
 * 这里不依赖 `lib/launch.ts` 本身（它牵出 `./api` 的 `import.meta.env` 与 `./session`），
 * 只测纯模块 `lib/launch-recovery.ts`，因此可在 Node 里直接 load。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LaunchRunError, launchRunRecovery } from '../src/lib/launch-recovery.ts'

/** 模拟 HTTP 失败：服务端给的 ApiError 形状（本函数只用到 code 字段）。 */
function httpError(code) {
  return { code, message: `server says ${code}` }
}

test('路径失效归 relocate，与失败来源无关', () => {
  assert.equal(launchRunRecovery(httpError('executable_missing')), 'relocate')
  assert.equal(launchRunRecovery(new LaunchRunError('executable_missing', '本地路径不在了')), 'relocate')
})

test('其余失败归 retry', () => {
  assert.equal(launchRunRecovery(httpError('spawn_failed')), 'retry')
  assert.equal(launchRunRecovery(httpError('invalid_profile')), 'retry')
  assert.equal(launchRunRecovery(new LaunchRunError('spawn_failed', 'd')), 'retry')
})

test('code 缺失时回落到 retry，而不是抛错', () => {
  assert.equal(launchRunRecovery({}), 'retry')
  assert.equal(launchRunRecovery({ code: undefined }), 'retry')
})

test('LaunchRunError 携带 reason 作为 code，供上层分流', () => {
  const error = new LaunchRunError('path_unavailable', '网络共享离线')
  assert.equal(error.code, 'path_unavailable')
  assert.equal(error.message, '网络共享离线')
  assert.equal(error.name, 'LaunchRunError')
  assert.equal(launchRunRecovery(error), 'retry')
})
