/**
 * 外壳侧本机代理的回归测试（T4-03）。
 *
 * 这一层钉的是**「只能启动配置、不能启动命令」那条边界在外壳上仍然成立**。
 *
 * 为什么必须单独测：HTTP 那条路上，配置的形态在入库时校验过一次、路由 schema 又把
 * 一次、权限中间件和回环来源判定各管一段，所以 `agent.ts` 收到的一定是一条像样的
 * 配置，**它信任调用方是安全的**。外壳这条路上没有那些 —— 对象来自 IPC，渲染进程里
 * 的任何脚本都能调。主进程这次复核是该链路上唯一的关卡，因此它的每个分支都要有
 * 用例，少一条就等于漏开一个口子。
 *
 * 直接测 `src/agent.ts`（与 `config.test.mjs` 同款，靠 Node 的类型剥离直接加载 TS
 * 源码），因此不需要先构建。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeProfile, runShellLaunchProfile } from '../src/agent.ts'

/**
 * 一条合法的配置。逐个用例只改要验的那一个字段，其余保持合法 ——
 * 这样失败时能一眼看出是哪个字段在起作用，而不是「不知道哪个改动破坏了整体」。
 */
function validProfile(overrides = {}) {
  return {
    id: 'p-1',
    software: 'custom',
    name: '测试程序',
    executablePath: 'C:/Program Files/test/app.exe',
    args: ['--flag'],
    icon: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

/** 记录调用次数的假 agent 模块，用来验「复核没过就不该碰进程」。 */
function spyAgent(result) {
  const calls = []
  return {
    calls,
    module: {
      runLaunchProfile(profile) {
        calls.push(profile)
        return Promise.resolve(result)
      },
    },
  }
}

// ---------------------------------------------------------------- 形态复核

test('合法配置被接受，且返回的是新对象', () => {
  const input = validProfile()
  const output = normalizeProfile(input)
  assert.notEqual(output, null)
  assert.notEqual(output, input, '不该把传入对象原样返回')
  assert.deepEqual(output, input)
})

test('args 是数组时被复制，外部改动不影响结果', () => {
  const args = ['--a']
  const output = normalizeProfile(validProfile({ args }))
  args.push('--b')
  assert.deepEqual(output.args, ['--a'])
})

test('非对象、空值、数组都被拒', () => {
  for (const bad of [null, undefined, 'str', 42, [], true]) {
    assert.equal(normalizeProfile(bad), null, `「${JSON.stringify(bad)}」本该被拒`)
  }
})

test('缺字段的都被拒', () => {
  for (const key of [
    'id',
    'software',
    'name',
    'executablePath',
    'args',
    'icon',
    'sortOrder',
    'createdAt',
    'updatedAt',
  ]) {
    const incomplete = validProfile()
    delete incomplete[key]
    assert.equal(normalizeProfile(incomplete), null, `缺 ${key} 本该被拒`)
  }
})

// ---------------------------------------------------------------- 路径形态（安全边界的核心）

test('相对路径被拒 —— 这是那条边界的核心', () => {
  for (const bad of ['app.exe', './app.exe', '../app.exe', 'sub/dir/app.exe', '\\app.exe']) {
    assert.equal(
      normalizeProfile(validProfile({ executablePath: bad })),
      null,
      `「${bad}」本该被拒`,
    )
  }
})

test('三种绝对路径形态都被认，与共享包一致', () => {
  for (const good of [
    'C:\\Program Files\\app.exe',
    'C:/Program Files/app.exe',
    '\\\\server\\share\\app.exe',
    '/usr/bin/app',
  ]) {
    assert.notEqual(
      normalizeProfile(validProfile({ executablePath: good })),
      null,
      `「${good}」本该被接受`,
    )
  }
})

test('空路径与超长路径被拒', () => {
  assert.equal(normalizeProfile(validProfile({ executablePath: '' })), null)
  assert.equal(normalizeProfile(validProfile({ executablePath: 'C:/' + 'x'.repeat(1100) })), null)
})

// ---------------------------------------------------------------- 参数形态

test('args 必须是数组，且逐项是字符串', () => {
  assert.equal(normalizeProfile(validProfile({ args: 'not-array' })), null)
  assert.equal(normalizeProfile(validProfile({ args: [1, 2] })), null)
  assert.equal(normalizeProfile(validProfile({ args: [{ a: 1 }] })), null)
  assert.equal(normalizeProfile(validProfile({ args: [null] })), null)
  // 空数组是合法的：很多客户端不需要参数。
  assert.notEqual(normalizeProfile(validProfile({ args: [] })), null)
})

test('参数个数超限被拒', () => {
  const tooMany = Array.from({ length: 33 }, (_, i) => `--arg-${i}`)
  assert.equal(normalizeProfile(validProfile({ args: tooMany })), null)
})

test('单个参数超长被拒', () => {
  assert.equal(normalizeProfile(validProfile({ args: ['x'.repeat(513)] })), null)
})

test('icon 只能是 null 或字符串', () => {
  // icon 是「图标标识，为空时前端按 software 取默认图标」，因此 null 合法（见共享包
  // LaunchProfile 的注释），而 undefined 不合法 —— 后者是字段缺失，不是「为空」。
  assert.equal(normalizeProfile(validProfile({ icon: 42 })), null)
  assert.notEqual(normalizeProfile(validProfile({ icon: 'wechat' })), null)
  assert.notEqual(normalizeProfile(validProfile({ icon: null })), null)
  assert.equal(normalizeProfile(validProfile({ icon: undefined })), null)
})

test('sortOrder 必须是有限数', () => {
  assert.equal(normalizeProfile(validProfile({ sortOrder: '1' })), null)
  assert.equal(normalizeProfile(validProfile({ sortOrder: Number.NaN })), null)
  assert.equal(normalizeProfile(validProfile({ sortOrder: Number.POSITIVE_INFINITY })), null)
  assert.notEqual(normalizeProfile(validProfile({ sortOrder: 3 })), null)
})

// ---------------------------------------------------------------- 启动路径

test('复核没过时根本不碰进程创建', async () => {
  const { calls, module } = spyAgent({
    ok: true,
    data: { profileId: 'p', pid: 1, startedAt: '', deduplicated: false },
  })
  const outcome = await runShellLaunchProfile({ executablePath: 'app.exe' }, module)
  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'invalid_profile')
  assert.equal(calls.length, 0, '复核没过就不该创建进程')
})

test('复核通过后参数原样交给 agent，且是归一后的对象', async () => {
  const { calls, module } = spyAgent({
    ok: true,
    data: {
      profileId: 'p-1',
      pid: 4242,
      startedAt: '2026-01-01T00:00:00.000Z',
      deduplicated: false,
    },
  })
  const outcome = await runShellLaunchProfile(validProfile(), module)
  assert.equal(outcome.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].executablePath, 'C:/Program Files/test/app.exe')
  assert.deepEqual(calls[0].args, ['--flag'])
  assert.equal(outcome.ok && outcome.data.pid, 4242)
})

test('agent 的两类失败原样带出，且各自带一句可显示的话', async () => {
  for (const [reason, expect] of [
    ['executable_missing', '重新指定'],
    ['spawn_failed', '进程创建失败'],
  ]) {
    const { module } = spyAgent({ ok: false, reason })
    const outcome = await runShellLaunchProfile(validProfile(), module)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.ok === false && outcome.reason, reason)
    assert.match(outcome.ok === false ? outcome.detail : '', new RegExp(expect))
  }
})

test('invalid_profile 与 executable_missing 是两类，界面动作不同', async () => {
  // 前者不该让用户去改路径 —— 配置本身就不合法。
  const bad = await runShellLaunchProfile(
    { executablePath: 'app.exe' },
    spyAgent({ ok: true }).module,
  )
  // 后者才该提示改路径。
  const missing = await runShellLaunchProfile(
    validProfile(),
    spyAgent({ ok: false, reason: 'executable_missing' }).module,
  )
  assert.equal(bad.ok === false && bad.reason, 'invalid_profile')
  assert.equal(missing.ok === false && missing.reason, 'executable_missing')
  assert.notEqual(bad.ok === false && bad.detail, missing.ok === false && missing.detail)
})

test('额外的未知字段被丢掉，不带进进程创建', async () => {
  const { calls, module } = spyAgent({
    ok: true,
    data: { profileId: 'p-1', pid: 1, startedAt: '', deduplicated: false },
  })
  const outcome = await runShellLaunchProfile(
    { ...validProfile(), 恶意字段: 'should not survive', __proto__polluted: true },
    module,
  )
  assert.equal(outcome.ok, true)
  assert.equal('恶意字段' in calls[0], false)
})
