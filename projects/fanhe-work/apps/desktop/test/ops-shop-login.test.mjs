/**
 * 「打开采集浏览器登录」这条通道的回归测试。
 *
 * 这条通道有两处必须钉住，都是「写错不会报错」的类型：
 *
 *   1. **代号会拼进命令行。** 主进程的校验是这条链路上唯一有效的关卡（渲染进程里
 *      任何脚本都能调 IPC，前端校验只算体验）。所以注入形状的输入必须逐个被拒，
 *      而且要断言**没有启动任何进程** —— 只断言返回 `ok:false` 的话，一个「先
 *      启动再返回错误」的实现也会全绿。
 *   2. **找不到脚本时不能假装成功。** 安装包不含 `tools/collector`，这在安装态是
 *      常态；此时必须返回 `collector_missing` 并带上手工命令，界面才有东西可显示。
 *
 * 用注入的 `spawnImpl` 记录调用参数，测试全程不真的开浏览器。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { openShopLogin, resolveShopLoginScript, shopLoginCommand } from '../src/ops-shop-login.ts'

/** 造一个「工作区根」，按需放入脚本。 */
function makeWorkspace(withScript) {
  const root = mkdtempSync(join(tmpdir(), 'fanhe-ws-'))
  if (withScript) {
    /* 两种形状都造：工作区根的相对路径（projects/fanhe-work/...）与
       仓库根的形状（tools/collector/...）。使用者的 collector.json 可能填
       任意一种，测试要覆盖到。 */
    for (const dir of [
      join(root, 'projects', 'fanhe-work', 'tools', 'collector', 'scripts'),
      join(root, 'tools', 'collector', 'scripts'),
    ]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'shop-login.ps1'), '# stub', 'utf8')
    }
  }
  return root
}

function recordingSpawn() {
  const calls = []
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options })
    return { unref() {} }
  }
  return { calls, spawnImpl }
}

test('非法代号一律拒绝，且不启动任何进程', async () => {
  const { calls, spawnImpl } = recordingSpawn()
  const bad = ['', 'Fanhe', 'fanhe_main', '-s2', 's2; calc', 'a'.repeat(33), '店铺']

  for (const code of bad) {
    const result = await openShopLogin(code, {
      workspaceRoot: 'C:/whatever',
      platform: 'win32',
      spawnImpl,
    })
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(code)}`)
    if (result.ok) continue
    assert.equal(result.reason, 'invalid_code')
  }

  assert.equal(calls.length, 0, '被拒的输入绝不能走到启动那一步')
})

test('非 Windows 返回 unsupported_platform，并带上可手工执行的命令', async () => {
  const { calls, spawnImpl } = recordingSpawn()
  const result = await openShopLogin('s2', { workspaceRoot: null, platform: 'darwin', spawnImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'unsupported_platform')
  assert.match(result.command, /shop-login\.ps1 -Shop s2/)
  assert.equal(calls.length, 0)
})

test('没有工作区根时返回 collector_missing，命令仍可展示', async () => {
  const { calls, spawnImpl } = recordingSpawn()
  const result = await openShopLogin('s2', { workspaceRoot: null, platform: 'win32', spawnImpl })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'collector_missing')
  assert.match(result.message, /没有采集器脚本/)
  assert.equal(result.command, shopLoginCommand('s2'))
  assert.equal(calls.length, 0)
})

test('工作区在但脚本不在（安装态）同样是 collector_missing', async () => {
  const root = makeWorkspace(false)
  const { calls, spawnImpl } = recordingSpawn()
  try {
    const result = await openShopLogin('s2', { workspaceRoot: root, platform: 'win32', spawnImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.reason, 'collector_missing')
    assert.equal(calls.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('脚本存在时按固定参数启动，代号作为独立实参传入', async () => {
  const root = makeWorkspace(true)
  const { calls, spawnImpl } = recordingSpawn()
  try {
    const result = await openShopLogin('fanhe-main', {
      workspaceRoot: root,
      platform: 'win32',
      spawnImpl,
    })
    assert.equal(result.ok, true)
    assert.equal(calls.length, 1)

    const call = calls[0]
    assert.equal(call.command, 'powershell.exe')
    /* 代号必须是**独立实参**而不是拼进一个字符串：拼串时 `-Shop "a b"` 这类输入
       会被 cmd 拆成两个参数，而这里传的是数组，不存在拆分。 */
    assert.deepEqual(call.args.slice(-2), ['-Shop', 'fanhe-main'])
    assert.equal(call.options.detached, true, '外壳退出不该杀掉等待扫码的浏览器')
    assert.equal(call.options.stdio, 'ignore')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('脚本路径解析只认工作区根下的固定位置', () => {
  const root = makeWorkspace(true)
  try {
    const script = resolveShopLoginScript(root)
    assert.ok(script !== null)
    assert.match(
      String(script).replaceAll('\\', '/'),
      /projects\/fanhe-work\/tools\/collector\/scripts\/shop-login\.ps1$/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  assert.equal(resolveShopLoginScript(null), null)
})

test('配置的采集器根目录能替代工作区：跨盘安装就靠它', async () => {
  /* 这条对应 2026-10-24 的真实故障：安装目录在 D 盘、工作区在 E 盘，
     沿安装目录向上找 .ws-root 必然断，界面只能显示「当前安装没有采集器脚本」。 */
  const root = makeWorkspace(true)
  const { calls, spawnImpl } = recordingSpawn()
  try {
    const result = await openShopLogin('s2', {
      workspaceRoot: null,
      collectorRoot: join(root, 'projects', 'fanhe-work', 'tools', 'collector'),
      platform: 'win32',
      spawnImpl,
    })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(calls.length, 1)

    /* root 指向仓库根时也要认 —— 使用者填的大概率是仓库路径。 */
    const byRepoRoot = await openShopLogin('s2', {
      workspaceRoot: null,
      collectorRoot: root,
      platform: 'win32',
      spawnImpl,
    })
    assert.equal(byRepoRoot.ok, true, '指向仓库根也要能找到脚本')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('脚本缺失时，提示里带采集器配置文件的落位', async () => {
  const { calls, spawnImpl } = recordingSpawn()
  const result = await openShopLogin('s2', {
    workspaceRoot: null,
    collectorRoot: 'E:/not-a-collector',
    configPath: 'C:/Users/dy/AppData/Roaming/梵禾 Work/collector.json',
    platform: 'win32',
    spawnImpl,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.reason, 'collector_missing')
  assert.match(result.message, /collector\.json/)
  assert.match(result.message, /AppData/)
  assert.equal(result.configPath, 'C:/Users/dy/AppData/Roaming/梵禾 Work/collector.json')
  assert.equal(calls.length, 0)
})
