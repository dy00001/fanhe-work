/**
 * T4-04 的验收脚本：验证「启动自检能在换机后把失效配置明确报出来」。
 *
 * ## 验的是哪一件事
 *
 * T4-04 的价值只有一句话：**失效要在点击之前被报出来，并说清该做什么**。因此判据
 * 不是「函数返回了」，而是三件事同时成立：
 *
 * 1. 用**真实的** `normalizeProfile` 与**真实的** `inspectExecutablePath`（从 api 的
 *    agent 源码动态加载），走通整条路径 —— 单测里那两个是注入的简版替身。
 * 2. 一条真实存在的文件被报成可用，一条真实缺失的文件被报成 `path_unavailable`，
 *    **两者必须来自同一个检查实现**（否则自检与启动会对不上）。
 * 3. 三类原因各配一句**方向正确**的引导。这是最容易做坏的部分 —— 一份说「有问题」
 *    但说错方向的检查比没有更糟，用户会照着错误提示做无用功。
 *
 * ## 为什么用真文件而不是全靠注入
 *
 * `PATH_INSPECT_TIMEOUT_MS` 是 5 秒，本机 stat 是毫秒级，所以真跑不慢。全用替身
 * 的话，「路径检查与启动用的是同一份实现」这条就没人验了 —— 而那恰恰是这类功能最坏
 * 的失效方式：自检说可用、点击启动失败，用户从此不再看自检。
 *
 * **它不是单测**，所以不放 `test/*.test.mjs`（那是 node --test 的 glob）。跑法：
 *
 *     node --experimental-strip-types test/acceptance/t404-diagnostics.mjs
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { normalizeProfile } from '../../src/agent.ts'
import { agentUnavailableReport, checkLaunchDiagnostics } from '../../src/diagnostics.ts'
import { apiLaunchModule } from '../../src/paths.ts'

/**
 * 干净暂存根。落点与理由见 `../scratch.mjs` 的文件头 —— 一句话是：
 * **不能用 `os.tmpdir()`**（入口下它指向工作区的 `.tmp`，而那在 `.ws-root` 底下，
 * 会让「配置/产物落在工作区外」这类断言失去意义），也不能写死某个账户名。
 */
import { SYSTEM_SCRATCH } from '../scratch.mjs'

let failures = 0

function report(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures += 1
}

const scratch = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-t404-'))

try {
  // ---- 准备：一条真存在的可执行文件 + 一条指向缺失路径的配置
  const realExe = join(scratch, 'real.exe')
  await writeFile(realExe, 'MZ', 'utf8')
  const missingExe = join(scratch, 'not-installed.exe')

  const base = {
    software: 'custom',
    args: [],
    icon: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }
  const goodProfile = { ...base, id: 'acc-ok', name: '真实存在的程序', executablePath: realExe }
  const lostProfile = {
    ...base,
    id: 'acc-lost',
    name: '换机后失效的程序',
    executablePath: missingExe,
  }
  // 相对路径：形态复核就该挡下，不该走到 stat那一步。
  const relativeProfile = {
    ...base,
    id: 'acc-rel',
    name: '相对路径配置',
    executablePath: '微信.exe',
  }

  // ---- 第一段：加载的是 api 的真实 agent 核心
  const agentModule = await apiLaunchModule(process.cwd())
  report('加载到 api 的 agent 核心', typeof agentModule.inspectExecutablePath === 'function')

  // ---- 第二段：真实检查 —— 一条 ok、一条 missing
  const result = await checkLaunchDiagnostics({
    profiles: [goodProfile, lostProfile, relativeProfile],
    normalize: normalizeProfile,
    inspect: agentModule.inspectExecutablePath,
  })

  report('三条配置全部被计入', result.total === 3, `total=${result.total}`)
  report('代理可用', result.agentAvailable === true)
  report('恰好一条可用（真实存在的那条）', result.okCount === 1, `okCount=${result.okCount}`)
  report(
    '恰好两条有问题',
    result.diagnostics.length === 2,
    `diagnostics=${result.diagnostics.length}`,
  )

  // ---- 第三段：分类必须分开，且索引对得上
  const byIndex = new Map(result.diagnostics.map((item) => [item.index, item]))
  const lost = byIndex.get(1)
  const relative = byIndex.get(2)

  report(
    '失效那条被归为 path_unavailable',
    lost?.reason === 'path_unavailable',
    String(lost?.reason),
  )
  report(
    '相对路径那条被归为 invalid_profile（不是路径不存在）',
    relative?.reason === 'invalid_profile',
    String(relative?.reason),
  )
  report('相对路径那条不给 profileId（它不可信）', relative?.profileId === '')
  report(
    '诊断按配置顺序排列',
    result.diagnostics.map((item) => item.index).join(',') === '1,2',
    result.diagnostics.map((item) => item.index).join(','),
  )

  // ---- 第四段：引导的方向必须正确（最容易被做坏的部分）
  const lostDetail = lost?.detail ?? ''
  report('路径失效的引导写了那个具体路径', lostDetail.includes(missingExe), lostDetail.slice(0, 60))
  report('路径失效的引导提到重新指定', /重新指定/.test(lostDetail))
  report('路径失效的引导提到网络共享', /共享/.test(lostDetail))
  report('路径失效的引导没有让用户去改配置本身', !/字段不完整|重新编辑/.test(lostDetail))

  const relativeDetail = relative?.detail ?? ''
  report('形态不合法的引导让用户重新编辑', /重新编辑/.test(relativeDetail))
  report(
    '形态不合法的引导不提「文件不存在」（路径根本没被看过）',
    !/可执行文件不存在/.test(relativeDetail),
  )

  // ---- 第五段：自检与启动对形态的判断一致（两侧都用同一个 normalizeProfile）
  // 分别问一次：自检说不合法的，启动时也必须拒绝。
  for (const item of result.diagnostics.filter((one) => one.reason === 'invalid_profile')) {
    const raw = [goodProfile, lostProfile, relativeProfile][item.index]
    report(`形态判定一致：第 ${item.index + 1} 条`, normalizeProfile(raw) === null)
  }

  // ---- 第六段：代理不可用时给的不是错误而是一份可显示的报告
  const unavailable = agentUnavailableReport('未找到工作区根')
  report('代理不可用时 agentAvailable 为 false', unavailable.agentAvailable === false)
  report('代理不可用时给了一条诊断', unavailable.diagnostics.length === 1)
  report(
    '代理不可用的引导指向工作区',
    /工作区/.test(unavailable.diagnostics[0].detail),
    unavailable.diagnostics[0].detail,
  )
  report('代理不可用时不谎报配置条数', unavailable.total === 0, `total=${unavailable.total}`)

  // ---- 第七段：空配置不是问题
  const empty = await checkLaunchDiagnostics({
    profiles: [],
    normalize: normalizeProfile,
    inspect: agentModule.inspectExecutablePath,
  })
  report('空配置不报问题', empty.total === 0 && empty.diagnostics.length === 0)
} finally {
  await rm(scratch, { recursive: true, force: true })
  console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
  process.exitCode = failures === 0 ? 0 : 1
}
