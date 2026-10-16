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

import {
  detectLaunchPaths,
  knownExecutableCandidates,
  normalizeProfile,
  runShellLaunchProfile,
  runShellLaunchProfiles,
  windowsProgramFilesRoots,
} from '../src/agent.ts'

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

// ---------------------------------------------------------------- 批量启动（2.2）

/** 按调用下标返回不同结果的假 agent，用来构造「部分成功」的批量场景。 */
function spyAgentMany(results) {
  let index = 0
  return {
    module: {
      runLaunchProfile(_profile, _logger) {
        const result = results[index] ?? {
          ok: true,
          data: { profileId: 'x', pid: 1, startedAt: '', deduplicated: false },
        }
        index += 1
        return Promise.resolve(result)
      },
    },
  }
}

test('全部成功时汇总 success 等于条数，每条带 pid', async () => {
  const { module } = spyAgentMany([])
  const raws = [validProfile({ id: 'a' }), validProfile({ id: 'b' }), validProfile({ id: 'c' })]
  const result = await runShellLaunchProfiles(raws, module)
  assert.equal(result.summary.total, 3)
  assert.equal(result.summary.success, 3)
  assert.equal(result.summary.failed, 0)
  assert.deepEqual(
    result.results.map((item) => item.profileId),
    ['a', 'b', 'c'],
  )
  assert.equal(
    result.results.every((item) => item.ok && typeof item.pid === 'number'),
    true,
  )
})

test('单条形态不合法只落在自己那一项，其余照常', async () => {
  const { module } = spyAgentMany([])
  // 中间那条缺绝对路径，归一化会拒。
  const raws = [validProfile({ id: 'a' }), { executablePath: 'app.exe' }, validProfile({ id: 'c' })]
  const result = await runShellLaunchProfiles(raws, module)
  assert.equal(result.summary.success, 2)
  assert.equal(result.summary.failed, 1)
  const bad = result.results.find((item) => item.profileId === '')
  assert.equal(bad?.ok, false)
  assert.equal(bad?.reason, 'invalid_profile')
})

test('agent 抛错被兜底成 spawn_failed，不影响其余', async () => {
  let index = 0
  const { module } = {
    module: {
      runLaunchProfile(_profile, _logger) {
        index += 1
        if (index === 2) return Promise.reject(new Error('boom'))
        return Promise.resolve({
          ok: true,
          data: { profileId: 'x', pid: 1, startedAt: '', deduplicated: false },
        })
      },
    },
  }
  const raws = [validProfile({ id: 'a' }), validProfile({ id: 'b' }), validProfile({ id: 'c' })]
  const result = await runShellLaunchProfiles(raws, module)
  assert.equal(result.summary.success, 2)
  assert.equal(result.summary.failed, 1)
  const failed = result.results.find((item) => item.profileId === 'b')
  assert.equal(failed?.ok, false)
  assert.equal(failed?.reason, 'spawn_failed')
})

test('空数组直接返回空汇总，不碰进程', async () => {
  let calls = 0
  const { module } = {
    module: {
      runLaunchProfile() {
        calls += 1
        return Promise.resolve({
          ok: true,
          data: { profileId: 'x', pid: 1, startedAt: '', deduplicated: false },
        })
      },
    },
  }
  const result = await runShellLaunchProfiles([], module)
  assert.equal(result.summary.total, 0)
  assert.equal(calls, 0, '空批量不该创建任何进程')
})

// ---------------------------------------------------------------- 一键检测（2.5）

/** 一份假环境变量，让候选枚举结果可断言、不依赖真实机器。 */
const DETECT_FAKE_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
}

test('knownExecutableCandidates 枚举已知软件的全部根目录×相对路径', () => {
  const result = knownExecutableCandidates('wechat', DETECT_FAKE_ENV)
  // 微信两条相对路径：旧版 WeChat.exe 在前，4.x 的 Weixin.exe 在后；
  // 每个根目录内先展开完这两条，再进入下一个根。
  assert.deepEqual(result, [
    'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
    'C:\\Program Files\\Tencent\\Weixin\\Weixin.exe',
    'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe',
    'C:\\Program Files (x86)\\Tencent\\Weixin\\Weixin.exe',
    'C:\\Users\\x\\AppData\\Local\\Tencent\\WeChat\\WeChat.exe',
    'C:\\Users\\x\\AppData\\Local\\Tencent\\Weixin\\Weixin.exe',
  ])
})

test('knownExecutableCandidates 多相对路径软件按「根×相对」顺序展开', () => {
  const result = knownExecutableCandidates('qq', DETECT_FAKE_ENV)
  // 顺序：先遍历每个根目录，根内再按相对路径顺序。ProgramFiles 在前、LOCALAPPDATA 在后。
  // QQ 四条相对路径：旧版 QQ\Bin、QQ\、新版 QQNT\Bin、QQNT\。
  assert.deepEqual(result, [
    'C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe',
    'C:\\Program Files\\Tencent\\QQ\\QQ.exe',
    'C:\\Program Files\\Tencent\\QQNT\\Bin\\QQ.exe',
    'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQ\\Bin\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQ\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\Bin\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe',
    'C:\\Users\\x\\AppData\\Local\\Tencent\\QQ\\Bin\\QQ.exe',
    'C:\\Users\\x\\AppData\\Local\\Tencent\\QQ\\QQ.exe',
    'C:\\Users\\x\\AppData\\Local\\Tencent\\QQNT\\Bin\\QQ.exe',
    'C:\\Users\\x\\AppData\\Local\\Tencent\\QQNT\\QQ.exe',
  ])
})

test('custom 与未知 software 返回空数组（无已知位置）', () => {
  assert.deepEqual(knownExecutableCandidates('custom', DETECT_FAKE_ENV), [])
  assert.deepEqual(knownExecutableCandidates('not-a-software', DETECT_FAKE_ENV), [])
})

test('根目录环境变量缺失时不贡献坏路径，而是跳过该根', () => {
  // 三个根都没给有效值 → 空；不是塞一个「undefined/...」的坏路径。
  assert.deepEqual(knownExecutableCandidates('wechat', { ProgramFiles: '' }), [])
})

test('detectLaunchPaths：extraPath 绝对且存在时成为首选', async () => {
  const result = await detectLaunchPaths('wechat', {
    extraPath: 'D:\\my\\WeChat.exe',
    inspect: async (p) => (p === 'D:\\my\\WeChat.exe' ? 'ok' : 'missing'),
    env: DETECT_FAKE_ENV,
  })
  assert.equal(result.preferred, 'D:\\my\\WeChat.exe')
  assert.deepEqual(result.candidates, ['D:\\my\\WeChat.exe'])
})

test('detectLaunchPaths：无 extraPath 时返回首个命中已知候选', async () => {
  const result = await detectLaunchPaths('wechat', {
    inspect: async (p) =>
      p === 'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe' ? 'ok' : 'missing',
    env: DETECT_FAKE_ENV,
  })
  assert.equal(result.preferred, 'C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe')
  assert.deepEqual(result.candidates, ['C:\\Program Files (x86)\\Tencent\\WeChat\\WeChat.exe'])
})

test('detectLaunchPaths：全部缺失返回空', async () => {
  const result = await detectLaunchPaths('wechat', {
    inspect: async () => 'missing',
    env: DETECT_FAKE_ENV,
  })
  assert.equal(result.preferred, null)
  assert.deepEqual(result.candidates, [])
})

test('detectLaunchPaths：extraPath 是相对路径时不进候选', async () => {
  const result = await detectLaunchPaths('wechat', {
    extraPath: 'relative/app.exe',
    inspect: async (p) => (p.endsWith('WeChat.exe') ? 'ok' : 'missing'),
    env: DETECT_FAKE_ENV,
  })
  // extraPath 被拒（相对路径在任何机器都启不动），已知候选中只有一个命中。
  assert.equal(result.preferred, 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe')
  assert.equal(result.candidates.includes('relative/app.exe'), false)
})

test('detectLaunchPaths：extraPath 与已知候选重复时只出现一次', async () => {
  const result = await detectLaunchPaths('wechat', {
    extraPath: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
    inspect: async () => 'ok',
    env: DETECT_FAKE_ENV,
  })
  assert.equal(
    result.candidates.filter((p) => p === 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe').length,
    1,
    'extraPath 与第一条已知候选是同一路径时不该重复',
  )
})

test('windowsProgramFilesRoots：枚举存在盘符上的 Program Files 两个目录', () => {
  const existing = new Set([
    'C:\\',
    'D:\\',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'D:\\Program Files',
  ])
  const roots = windowsProgramFilesRoots({
    drives: ['C', 'D', 'E'],
    exists: (p) => existing.has(p),
  })
  assert.deepEqual(roots, ['C:\\Program Files', 'C:\\Program Files (x86)', 'D:\\Program Files'])
})

test('windowsProgramFilesRoots：不存在的盘符与目录都不贡献根', () => {
  const roots = windowsProgramFilesRoots({ drives: ['Z'], exists: () => false })
  assert.deepEqual(roots, [])
})

test('knownExecutableCandidates：extraRoots 让装在 D 盘的软件也能枚举到', () => {
  const paths = knownExecutableCandidates('qq', DETECT_FAKE_ENV, {
    extraRoots: ['D:\\Program Files'],
  })
  assert.ok(
    paths.includes('D:\\Program Files\\Tencent\\QQNT\\Bin\\QQ.exe'),
    '应包含 D 盘的 QQNT 候选',
  )
})

test('knownExecutableCandidates：新版 QQ 的 QQNT 布局在候选里', () => {
  const paths = knownExecutableCandidates('qq', DETECT_FAKE_ENV)
  assert.ok(paths.includes('C:\\Program Files\\Tencent\\QQNT\\Bin\\QQ.exe'))
  assert.ok(paths.includes('C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe'))
})

test('knownExecutableCandidates：微信 4.x 的 Weixin 布局在候选里', () => {
  const paths = knownExecutableCandidates('wechat', DETECT_FAKE_ENV)
  assert.ok(paths.includes('C:\\Program Files\\Tencent\\Weixin\\Weixin.exe'))
})

test('knownExecutableCandidates：env 根与 extraRoots 重复时去重', () => {
  const paths = knownExecutableCandidates('wechat', DETECT_FAKE_ENV, {
    extraRoots: ['C:\\Program Files'],
  })
  const dup = paths.filter((p) => p === 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe')
  assert.equal(dup.length, 1)
})

test('detectLaunchPaths：extraRoots 命中 D 盘安装即可回填', async () => {
  const target = 'D:\\Program Files\\Tencent\\QQNT\\Bin\\QQ.exe'
  const result = await detectLaunchPaths('qq', {
    inspect: async (p) => (p === target ? 'ok' : 'missing'),
    env: DETECT_FAKE_ENV,
    extraRoots: ['D:\\Program Files'],
  })
  assert.equal(result.preferred, target)
})

// ---------------------------------------------------------- 注册表候选（2.5 增强）

test('detectLaunchPaths：extraCandidates（注册表）能命中自定义安装目录', async () => {
  // 真机场景：QQ 装在 D:\软件安装目录\QQ\QQ.exe，目录扫描永远找不到。
  const target = 'D:\\软件安装目录\\QQ\\QQ.exe'
  const result = await detectLaunchPaths('qq', {
    extraCandidates: [target],
    inspect: async (p) => (p === target ? 'ok' : 'missing'),
    env: DETECT_FAKE_ENV,
  })
  assert.equal(result.preferred, target)
  assert.deepEqual(result.candidates, [target])
})

test('detectLaunchPaths：extraCandidates 排在 extraPath 之后、已知候选之前', async () => {
  // 三路来源都存在时，顺序应为：extraPath > extraCandidates > 已知候选（后者还有一长串）。
  const userPath = 'E:\\user\\QQ.exe'
  const registryPath = 'D:\\软件安装目录\\QQ\\QQ.exe'
  const knownPath = 'C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe'
  const result = await detectLaunchPaths('qq', {
    extraPath: userPath,
    extraCandidates: [registryPath],
    inspect: async () => 'ok',
    env: DETECT_FAKE_ENV,
  })
  assert.deepEqual(result.candidates.slice(0, 3), [userPath, registryPath, knownPath])
  assert.ok(result.candidates.length > 3, '已知候选应排在后面一并带出')
})

test('detectLaunchPaths：extraCandidates 里的相对路径被拒（不该被当成命中）', async () => {
  const result = await detectLaunchPaths('qq', {
    extraCandidates: ['relative\\QQ.exe'],
    inspect: async () => 'ok',
    env: DETECT_FAKE_ENV,
  })
  assert.equal(result.candidates.includes('relative\\QQ.exe'), false)
})

test('detectLaunchPaths：extraCandidates 与已知候选重复时只出现一次', async () => {
  const knownPath = 'C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe'
  const result = await detectLaunchPaths('qq', {
    extraCandidates: [knownPath],
    inspect: async () => 'ok',
    env: DETECT_FAKE_ENV,
  })
  assert.equal(result.candidates.filter((p) => p === knownPath).length, 1)
})
