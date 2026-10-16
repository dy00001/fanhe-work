/**
 * 注册表安装提示的回归测试（2.5 增强）。
 *
 * 这一层钉的是**「目录扫描覆盖不了的自定义安装目录，注册表能兜住」**。真机实测里用户把
 * QQ / 微信 / 千牛 全装在 `D:\软件安装目录\` 下，任何「已知路径」清单都猜不到这个目录名；
 * 卸载项里的 `DisplayIcon` / `InstallLocation` 是唯一可靠来源。
 *
 * 直接测 `src/launch-registry.ts`（与 `agent.test.mjs` 同款，靠 Node 的类型剥离加载 TS 源码）。
 * 全部用例都注入 runner / 纯函数入参，**不碰真实注册表、不起 PowerShell**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildRegistryQueryScript,
  normalizeDisplayIcon,
  parseUninstallRecords,
  readRegistryInstallHints,
  registryInstallCandidates,
  stripRegistryValueQuotes,
} from '../src/launch-registry.ts'

/** 真机实测导出的三条卸载记录（QQ / 微信 / 千牛），字段形态各不相同。 */
const REAL_MACHINE_RECORDS = [
  {
    displayName: '千牛工作台',
    installLocation: 'D:\\软件安装目录\\千牛',
    displayIcon: 'D:\\软件安装目录\\千牛\\Uninstall.exe',
  },
  { displayName: 'QQ', installLocation: '', displayIcon: 'D:\\软件安装目录\\QQ\\QQ.exe,0' },
  {
    displayName: '微信',
    installLocation: '"D:\\软件安装目录\\微信\\Weixin"',
    displayIcon: '"D:\\软件安装目录\\微信\\Weixin\\Weixin.exe"',
  },
]

test('stripRegistryValueQuotes：去掉包裹引号与首尾空白', () => {
  assert.equal(stripRegistryValueQuotes('"D:\\x\\a.exe"'), 'D:\\x\\a.exe')
  assert.equal(stripRegistryValueQuotes('  D:\\x\\a.exe  '), 'D:\\x\\a.exe')
  // 只有一侧有引号时不剥（避免把路径本身吃掉）。
  assert.equal(stripRegistryValueQuotes('"D:\\x\\a.exe'), '"D:\\x\\a.exe')
  assert.equal(stripRegistryValueQuotes(''), '')
})

test('normalizeDisplayIcon：剥引号、去尾缀 ,序号，非 exe 返回 null', () => {
  assert.equal(normalizeDisplayIcon('D:\\x\\QQ.exe,0'), 'D:\\x\\QQ.exe')
  assert.equal(normalizeDisplayIcon('"D:\\x\\Weixin.exe"'), 'D:\\x\\Weixin.exe')
  assert.equal(normalizeDisplayIcon('D:\\x\\icon.dll'), null)
  assert.equal(normalizeDisplayIcon(''), null)
  // 逗号后不是纯数字（带逗号的合法路径）时不误切。
  assert.equal(normalizeDisplayIcon('D:\\x\\a,1,b.exe'), 'D:\\x\\a,1,b.exe')
})

test('parseUninstallRecords：数组 / 单对象 / BOM / 空 / 坏 JSON 都能兜住', () => {
  assert.equal(parseUninstallRecords('[{"DisplayName":"A"},{"DisplayName":"B"}]').length, 2)
  // ConvertTo-Json 对单条结果不产出数组，要能吃下单对象。
  assert.deepEqual(parseUninstallRecords('{"DisplayName":"A","InstallLocation":"D:\\\\A"}'), [
    { displayName: 'A', installLocation: 'D:\\A', displayIcon: '' },
  ])
  // UTF-8 BOM 前缀：JSON.parse 遇 BOM 会直接抛，必须先剥。
  assert.equal(parseUninstallRecords('\uFEFF[{"DisplayName":"A"}]').length, 1)
  assert.deepEqual(parseUninstallRecords(''), [])
  assert.deepEqual(parseUninstallRecords('not json'), [])
  // 字段缺失 / 为 null 一律归一成空串，不抛。
  assert.deepEqual(parseUninstallRecords('[{"DisplayName":null,"DisplayIcon":null}]'), [
    { displayName: '', installLocation: '', displayIcon: '' },
  ])
})

test('registryInstallCandidates：QQ 的 InstallLocation 为空，靠 DisplayIcon 命中', () => {
  assert.deepEqual(registryInstallCandidates(REAL_MACHINE_RECORDS, 'qq'), [
    'D:\\软件安装目录\\QQ\\QQ.exe',
    'D:\\软件安装目录\\QQ\\QQNT.exe',
  ])
})

test('registryInstallCandidates：微信的 DisplayIcon 与 InstallLocation 都带引号', () => {
  assert.deepEqual(registryInstallCandidates(REAL_MACHINE_RECORDS, 'wechat'), [
    'D:\\软件安装目录\\微信\\Weixin\\Weixin.exe',
    'D:\\软件安装目录\\微信\\Weixin\\WeChat.exe',
  ])
})

test('registryInstallCandidates：千牛的 DisplayIcon 指向卸载器，靠 InstallLocation 拼主程序', () => {
  assert.deepEqual(registryInstallCandidates(REAL_MACHINE_RECORDS, 'qianniu'), [
    'D:\\软件安装目录\\千牛\\AliWorkbench.exe',
    'D:\\软件安装目录\\千牛\\AliWangWang.exe',
    'D:\\软件安装目录\\千牛\\aliim.exe',
  ])
})

test('registryInstallCandidates：DisplayName 不匹配的记录不贡献候选', () => {
  const records = [
    { displayName: '某无关软件', installLocation: 'D:\\x', displayIcon: 'D:\\x\\QQ.exe' },
  ]
  assert.deepEqual(registryInstallCandidates(records, 'qq'), [])
})

test('registryInstallCandidates：custom 与未知 software 一律空（无已知行为）', () => {
  assert.deepEqual(registryInstallCandidates(REAL_MACHINE_RECORDS, 'custom'), [])
  assert.deepEqual(registryInstallCandidates(REAL_MACHINE_RECORDS, 'not-a-software'), [])
})

test('registryInstallCandidates：同一路径不重复（大小写不敏感）', () => {
  const records = [
    {
      displayName: 'QQ',
      installLocation: 'D:\\QQ',
      displayIcon: 'D:\\QQ\\QQ.exe',
    },
  ]
  // DisplayIcon 的 QQ.exe 与 InstallLocation 根下平铺的 QQ.exe 是同一条，只应出现一次。
  const result = registryInstallCandidates(records, 'qq')
  const hits = result.filter((p) => p.toLowerCase() === 'd:\\qq\\qq.exe')
  assert.equal(hits.length, 1)
})

/**
 * 把测试用的 camelCase 记录转成 PowerShell `Select-Object DisplayName,...` 会产出的
 * PascalCase JSON —— 解析器按 PascalCase 读字段，这里必须对齐，否则整条链路会「解析成空」。
 */
function asRegistryJson(records) {
  return JSON.stringify(
    records.map((r) => ({
      DisplayName: r.displayName,
      InstallLocation: r.installLocation,
      DisplayIcon: r.displayIcon,
    })),
  )
}

test('buildRegistryQueryScript：查三个 hive 且强制 UTF-8 输出', () => {
  const script = buildRegistryQueryScript()
  assert.match(script, /HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall/)
  assert.match(script, /WOW6432Node/)
  assert.match(script, /HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall/)
  assert.match(script, /OutputEncoding/)
  assert.match(script, /ConvertTo-Json/)
})

test('readRegistryInstallHints：注入 runner，从真实形态 JSON 推出候选', async () => {
  const json = asRegistryJson(REAL_MACHINE_RECORDS)
  const hints = await readRegistryInstallHints('wechat', {
    run: async () => json,
  })
  assert.deepEqual(hints, [
    'D:\\软件安装目录\\微信\\Weixin\\Weixin.exe',
    'D:\\软件安装目录\\微信\\Weixin\\WeChat.exe',
  ])
})

test('readRegistryInstallHints：runner 抛错时返回空数组，绝不抛异常', async () => {
  const hints = await readRegistryInstallHints('qq', {
    run: async () => {
      throw new Error('powershell 起不来')
    },
  })
  assert.deepEqual(hints, [])
})

test('readRegistryInstallHints：未知 software 直接空，连 runner 都不调', async () => {
  let called = 0
  const hints = await readRegistryInstallHints('custom', {
    run: async () => {
      called += 1
      return '[]'
    },
  })
  assert.deepEqual(hints, [])
  assert.equal(called, 0, '没有已知行为的 software 不该去读注册表')
})

test('readRegistryInstallHints：坏输出（非 JSON）退回空数组', async () => {
  const hints = await readRegistryInstallHints('qq', { run: async () => '这不是 JSON' })
  assert.deepEqual(hints, [])
})
