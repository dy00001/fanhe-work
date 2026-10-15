/**
 * 一键检测的主机分流测试（2.5）。
 *
 * 与 `launch-many.test.mjs` 同款，直接加载纯模块 `src/lib/launch-detect.ts`（它只依赖
 * `src/lib/host.ts`，不含 `import.meta.env` / 网络层），因此不需要先构建 web。
 *
 * 验的是「桌面态转给桥、浏览器态回落空结果」这一层分流，不重复桌面侧对枚举与复核的
 * 单测——那边已经钉住了核心逻辑，这里只钉住界面会走的两条路。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { detectLaunchPath } from '../src/lib/launch-detect.ts'

/** 装一个桌面桥。`globalThis.window` 是 node:test 隔离进程里的临时全局。 */
function withDesktopBridge(handler) {
  globalThis.window = {
    fanheDesktop: {
      isDesktopShell: true,
      detectLaunchPath: handler,
    },
  }
}

test('桌面态把请求转给桥 detectLaunchPath 并原样返回', async () => {
  const captured = { software: '', extraPath: undefined }
  withDesktopBridge(async (software, extraPath) => {
    captured.software = software
    captured.extraPath = extraPath
    return {
      software,
      preferred: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
      candidates: ['C:\\Program Files\\Tencent\\WeChat\\WeChat.exe'],
      agentAvailable: true,
    }
  })

  const result = await detectLaunchPath('wechat', 'C:\\existing\\WeChat.exe')
  assert.equal(captured.software, 'wechat')
  assert.equal(captured.extraPath, 'C:\\existing\\WeChat.exe')
  assert.equal(result.software, 'wechat')
  assert.equal(result.preferred, 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe')
  assert.equal(result.agentAvailable, true)
})

test('桌面态不传 extraPath 时桥收到 undefined', async () => {
  let received = 'NOT_CALLED'
  withDesktopBridge(async (_software, extraPath) => {
    received = extraPath
    return { software: 'wechat', preferred: null, candidates: [], agentAvailable: true }
  })
  await detectLaunchPath('wechat')
  assert.equal(received, undefined, '没给 extraPath 时应当传 undefined，而不是空串')
})

test('浏览器态（isDesktopShell 为假）回落为空结果，不抛错', async () => {
  globalThis.window = { fanheDesktop: { isDesktopShell: false, detectLaunchPath: async () => {
    throw new Error('浏览器态不应调用桥')
  } } }
  const result = await detectLaunchPath('wechat')
  assert.deepEqual(result, {
    software: 'wechat',
    preferred: null,
    candidates: [],
    agentAvailable: false,
  })
})

test('无桥对象时同样回落为空结果', async () => {
  globalThis.window = {}
  const result = await detectLaunchPath('wechat')
  assert.deepEqual(result, {
    software: 'wechat',
    preferred: null,
    candidates: [],
    agentAvailable: false,
  })
})

test('window 全局不存在时回落为空结果', async () => {
  delete globalThis.window
  const result = await detectLaunchPath('wechat')
  assert.deepEqual(result, {
    software: 'wechat',
    preferred: null,
    candidates: [],
    agentAvailable: false,
  })
})
