/**
 * 启动自检的回归测试（T4-04）。
 *
 * 这个模块的重点不是「检查」，而是**给每类失效配一句能照着做的引导**。因此用例
 * 钉的不只是「有没有发现问题」，还有「**问题分类对不对、引导说的是不是该做的事**」——
 * 一份说「有问题」但说错了方向的检查比没有更糟：用户会照着那个错误提示去做无用功。
 *
 * **`inspect` 一律注入，不真的去 stat。两个原因**：一是路径检查该由 agent 的实现
 * 负责，测试里自己写一个等于把「两份实现会不会分歧」这个真问题绕过去；二是
 * `PATH_INSPECT_TIMEOUT_MS` 是 5 秒，注入后才能把超时那条路径也测到。
 *
 * **`normalize` 同样是注入的**，因此这里用的是一份**独立的简版复核**而不是
 * `src/agent.ts` 的 `normalizeProfile`（`.mjs` 测试文件 import `.ts` 源文件会撞上
 * desktop 那个 CJS/类型剥离双路径问题，见 `src/diagnostics.ts` 文件头）。
 *
 * **那「自检与启动对形态的判断一致」怎么保证？** 由真机验收断言那条覆盖 ——
 * 它同时调用真实的 `normalizeProfile` 与自检，确认同一批配置在两侧得到同一个结论。
 * 单测在这里验证的是**自检自身的逻辑**（分类、引导、索引、异常兜底）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { agentUnavailableReport, checkLaunchDiagnostics } from '../src/diagnostics.ts'

/** 一条合法配置。只改要验的那一个字段，其余保持合法。 */
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

/**
 * 简版形态复核。
 *
 * **只判「能不能启动」这一件事，不做全字段校验** —— 那是 `normalizeProfile` 的职责，
 * 而它由真机验收断言去比对。这里只要求「通得过」与「通不过」的分界与真实实现一致到
 * 足以验证自检的分类逻辑：对象、绝对路径、字符串型 args。
 */
function stubNormalize(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const path = raw.executablePath
  const args = raw.args
  if (typeof path !== 'string' || !/^([a-zA-Z]:[\\/]|\\\\)/.test(path)) return null
  if (!Array.isArray(args) || args.some((item) => typeof item !== 'string')) return null
  return raw
}

/** 两个必填依赖的便捷组合：`normalize` 用简版，`inspect` 恒定状态。 */
function deps(state) {
  return {
    normalize: stubNormalize,
    inspect: () => Promise.resolve(state),
  }
}

/** 逐路径查表式的假检查，便于逐条指定结果或抛错。 */
function stubInspect(byPath) {
  const seen = []
  const inspect = (executablePath) => {
    seen.push(executablePath)
    const next = byPath[executablePath]
    if (next instanceof Error) return Promise.reject(next)
    return Promise.resolve(next ?? 'ok')
  }
  return inspect
}

/** 组一份完整的入参，省得每条用例重复写两个必填依赖。 */
function input(profiles, overrides = {}) {
  return { profiles, ...deps('ok'), ...overrides }
}

// ------------------------------------------------------------- 代理不可用

test('代理不可用时给出一份可直接显示的报告', () => {
  const report = agentUnavailableReport('未找到工作区根')
  assert.equal(report.agentAvailable, false)
  assert.equal(report.diagnostics.length, 1)
  assert.equal(report.diagnostics[0].reason, 'agent_unavailable')
})

test('代理不可用的引导指向工作区，而不是让用户改路径', () => {
  // 这是分类的意义所在：代理不可用时一条配置都没验过，让用户去改路径是纯粹的误导。
  const { detail } = agentUnavailableReport('缺少 .ws-root').diagnostics[0]
  assert.match(detail, /工作区/)
  assert.doesNotMatch(detail, /可执行文件不存在/)
})

test('代理不可用时把原因附在引导里', () => {
  const { detail } = agentUnavailableReport('apps/api/src 缺失').diagnostics[0]
  assert.match(detail, /apps\/api\/src 缺失/)
})

test('代理不可用时 total 为 0（那不是「有 N 条配置全坏了」）', () => {
  // total 说的是「收到几条配置」，而这条路径上一条都没收到。报成 N 会让界面显示
  //「10 条配置全部失效」，而真相是连配置都没送到。
  assert.equal(agentUnavailableReport('x').total, 0)
})

// ------------------------------------------------------------- 空与非法入参

test('配置为空时不报任何问题', async () => {
  const report = await checkLaunchDiagnostics(input([]))
  assert.deepEqual(
    {
      agentAvailable: report.agentAvailable,
      total: report.total,
      okCount: report.okCount,
      n: report.diagnostics.length,
    },
    { agentAvailable: true, total: 0, okCount: 0, n: 0 },
  )
})

test('入参不是数组时按空列表处理，不抛', async () => {
  for (const bad of [null, undefined, 'x', 42, {}]) {
    const report = await checkLaunchDiagnostics(input(bad))
    assert.equal(report.total, 0, `入参 ${String(bad)} 应被当成空列表`)
    assert.equal(report.diagnostics.length, 0)
  }
})

test('配置为空时不必调用路径检查', async () => {
  // 空列表是「没有要检查的」，不该为此付出一次 stat（含最坏 5 秒的共享超时）。
  let called = 0
  await checkLaunchDiagnostics(input([], { inspect: () => ((called += 1), Promise.resolve('ok')) }))
  assert.equal(called, 0)
})

// ------------------------------------------------------------- 路径可用

test('全部可用时不报问题，可用量等于总数', async () => {
  const report = await checkLaunchDiagnostics(
    input([validProfile({ id: 'a' }), validProfile({ id: 'b' })]),
  )
  assert.equal(report.total, 2)
  assert.equal(report.okCount, 2)
  assert.equal(report.diagnostics.length, 0)
})

// ------------------------------------------------------------- 路径不在

test('路径不存在报 path_unavailable，并把路径写进引导', async () => {
  const report = await checkLaunchDiagnostics(input([validProfile()], deps('missing')))
  assert.equal(report.diagnostics.length, 1)
  assert.equal(report.diagnostics[0].reason, 'path_unavailable')
  assert.match(report.diagnostics[0].detail, /app\.exe/)
})

test('path_unavailable 的引导要提「重新指定」与网络共享两种可能', async () => {
  // 失效的两种典型成因（换位置、共享离线）给的动作不同，两句都要在。
  const report = await checkLaunchDiagnostics(input([validProfile()], deps('missing')))
  const { detail } = report.diagnostics[0]
  assert.match(detail, /重新指定/)
  assert.match(detail, /共享/)
})

test('路径不在时保留 profileId 与名字，便于界面指认', async () => {
  const report = await checkLaunchDiagnostics(
    input([validProfile({ id: 'p-9', name: '微信' })], deps('missing')),
  )
  assert.equal(report.diagnostics[0].profileId, 'p-9')
  assert.equal(report.diagnostics[0].name, '微信')
  assert.match(report.diagnostics[0].detail, /「微信」/)
})

test('路径检查用的就是配置里的那条路径', async () => {
  // 检查错路径的自检比没有更糟：它会对着不存在的文件报「可用」。
  const seen = []
  const report = await checkLaunchDiagnostics(
    input([validProfile({ executablePath: 'C:/x/y.exe' })], {
      inspect: (p) => (seen.push(p), Promise.resolve('missing')),
    }),
  )
  assert.deepEqual(seen, ['C:/x/y.exe'])
  assert.equal(report.diagnostics[0].executablePath, 'C:/x/y.exe')
})

// ------------------------------------------------------------- 形态不合法

test('形态复核失败报 invalid_profile，且不查路径', async () => {
  // 这是最需要钉住的一条：不可信路径去 stat 既没意义，又可能白等一次共享超时。
  const seen = []
  const report = await checkLaunchDiagnostics(
    input([validProfile({ executablePath: 'node.exe' })], {
      inspect: (p) => (seen.push(p), Promise.resolve('ok')),
    }),
  )
  assert.deepEqual(seen, [], '形态没过就不该碰文件系统')
  assert.equal(report.diagnostics[0].reason, 'invalid_profile')
})

test('invalid_profile 的引导不该让用户去改路径', async () => {
  const report = await checkLaunchDiagnostics(input([validProfile({ args: '不是数组' })]))
  const { detail } = report.diagnostics[0]
  assert.doesNotMatch(detail, /可执行文件不存在/)
  assert.match(detail, /重新编辑/)
})

test('形态失败的那条不给 profileId（它不可信），靠下标指认', async () => {
  const report = await checkLaunchDiagnostics(input([validProfile(), { 垃圾: true }]))
  assert.equal(report.diagnostics[0].index, 1)
  assert.equal(report.diagnostics[0].profileId, '')
})

test('不可信对象里取名字取不到时按「第 N 条配置」指认', async () => {
  // 名字不可信时若拿空串去列表里找，用户会以为自检在说别的配置。
  const report = await checkLaunchDiagnostics(input([null]))
  assert.match(report.diagnostics[0].detail, /第 1 条配置/)
})

test('从不可信对象里读字符串字段不会抛', async () => {
  const hostile = [null, undefined, 42, 'str', [], { name: 123, executablePath: {} }]
  const report = await checkLaunchDiagnostics(input(hostile))
  assert.equal(report.total, hostile.length)
  assert.equal(report.diagnostics.length, hostile.length)
})

// ------------------------------------------------------------- 混合与异常

test('多条配置时索引对得上，可用量只数路径可用的', async () => {
  const report = await checkLaunchDiagnostics(
    input(
      [
        validProfile({ id: 'a', executablePath: 'C:/a.exe' }),
        validProfile({ id: 'b', executablePath: 'C:/b.exe' }),
        { 垃圾: true },
        validProfile({ id: 'd', executablePath: 'C:/d.exe' }),
      ],
      {
        inspect: stubInspect({ 'C:/b.exe': 'missing' }),
      },
    ),
  )
  assert.equal(report.total, 4)
  assert.equal(report.okCount, 2)
  assert.deepEqual(
    report.diagnostics.map((item) => [item.index, item.reason]),
    [
      [1, 'path_unavailable'],
      [2, 'invalid_profile'],
    ],
  )
})

test('单条检查抛错不中断整轮，且按不可用处理', async () => {
  // 「一条查不了不代表其余查不了」。兜底方向与 api 侧 listProfileStatuses 一致：
  // 让用户去确认路径，好过让他点了才收到失败。
  const report = await checkLaunchDiagnostics(
    input(
      [
        validProfile({ id: 'a', executablePath: 'C:/a.exe' }),
        validProfile({ id: 'b', executablePath: 'C:/b.exe' }),
      ],
      {
        inspect: stubInspect({ 'C:/b.exe': new Error('stat 炸了') }),
      },
    ),
  )
  assert.equal(report.diagnostics.length, 1)
  assert.equal(report.diagnostics[0].reason, 'path_unavailable')
  assert.equal(report.okCount, 1)
})

test('检查返回的不是已知状态时按不可用处理', async () => {
  // 不做白名单校验以外的事：只认 `ok` 为可用，其余一律不可用。宁可误报不可用
  // （用户去确认一下，代价很小），不可误报可用（用户点了才失败，且开始不信任自检）。
  const report = await checkLaunchDiagnostics(
    input([validProfile()], { inspect: () => Promise.resolve('unknown') }),
  )
  assert.equal(report.diagnostics[0].reason, 'path_unavailable')
})

test('复核函数被调用的次数等于配置条数（不重复解析）', async () => {
  // 早先那版实现每条配置要调三次 normalize，形态一变就可能前后不一致。
  let calls = 0
  const report = await checkLaunchDiagnostics(
    input([validProfile({ id: 'a' }), validProfile({ id: 'b' }), { 垃圾: true }], {
      normalize: (raw) => {
        calls += 1
        return stubNormalize(raw)
      },
    }),
  )
  assert.equal(calls, 3)
  assert.equal(report.total, 3)
})

test('自检全程不启动任何进程', async () => {
  // 入参里没有 agent 模块，签名上就够不到 runLaunchProfile；这条用例是提醒
  // 后续改动别把启动能力引进来 —— 自检只读文件系统，不该有副作用。
  const report = await checkLaunchDiagnostics(input([validProfile()], deps('missing')))
  assert.equal(report.diagnostics.length, 1)
})

test('多条路径是并发检查的，总耗时与条数无关', async () => {
  // 这条不是性能优化，是正确性问题：`PATH_INSPECT_TIMEOUT_MS` 是 5 秒，而失效配置的
  // 典型成因正是指向网络共享 —— 那台机器关机时 stat 不会立刻失败。逐条 await 的话，
  // 10 条指向同一台关机机器的配置就是 50 秒，而自检恰恰是「用户已经等着了」的场合。
  //
  // 用**耗时**而不是「并发计数」来判：实现完全可能并发发起却仍然串行 await，
  // 而那种写法在计数上看起来是对的。
  const slowInspect = () => new Promise((resolve) => setTimeout(() => resolve('missing'), 60))
  const profiles = Array.from({ length: 10 }, (unused, i) =>
    validProfile({ id: `p-${i}`, executablePath: `C:/slow/${i}.exe` }),
  )

  const started = process.hrtime.bigint()
  const report = await checkLaunchDiagnostics(input(profiles, { inspect: slowInspect }))
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6

  assert.equal(report.diagnostics.length, 10)
  // 串行是 600ms 以上。留足余量取 400ms：慢机器上不至于误判，并发也绝不会超。
  assert.ok(elapsedMs < 400, `串行了，耗时 ${elapsedMs.toFixed(0)}ms`)
})

test('全部形态不合法时不必做路径检查', async () => {
  // 与「空配置不检查」同理：没有一条值得查的路径就别付那个代价。
  const seen = []
  const report = await checkLaunchDiagnostics(
    input([{ 垃圾: 1 }, null, { name: 1 }], {
      inspect: (p) => (seen.push(p), Promise.resolve('ok')),
    }),
  )
  assert.deepEqual(seen, [])
  assert.equal(report.diagnostics.length, 3)
})
