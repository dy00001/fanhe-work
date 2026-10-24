/**
 * 采集器根目录配置的回归测试。
 *
 * 这一层存在的理由很具体：2026-10-24 那次「当前安装没有采集器脚本」的横幅，
 * 根因就是主进程只沿自己的安装目录向上找 `.ws-root`，而本机安装目录在 D 盘、
 * 工作区在 E 盘，跨盘必然找不到。修法是给一个显式配置，所以这段解析逻辑
 * 必须自己站得住。
 *
 * 测的全是「错了会静默」的形态：路径拼错、JSON 写错、写成对象以外的类型、
 * 环境变量给空串。**每种错都要有明确的失败形态**，不能一律当成「没配置」。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  collectorConfigPath,
  collectorScriptCandidates,
  parseCollectorConfig,
  resolveCollectorRoot,
} from '../src/collector-config.ts'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'fanhe-collector-cfg-'))
}

test('配置文件解析：只接受非空字符串的 root', () => {
  assert.deepEqual(parseCollectorConfig('{"root":"E:/fanhe"}'), { ok: true, root: 'E:/fanhe' })
  assert.deepEqual(parseCollectorConfig('{"root":"  E:/fanhe  "}'), { ok: true, root: 'E:/fanhe' })

  const bad = ['不是 JSON', '[]', '{"root":123}', '{"root":""}', '{}', 'null']
  for (const raw of bad) {
    const result = parseCollectorConfig(raw)
    assert.equal(result.ok, false, `应拒绝：${raw}`)
    if (result.ok) continue
    assert.ok(result.error.length > 0, '失败必须带原因，不能只给一个 false')
  }
})

test('配置文件路径：安装态用配置目录，开发态用工作区', () => {
  assert.equal(
    collectorConfigPath({ configDir: 'C:/Users/dy/AppData/Roaming/梵禾 Work' }),
    join('C:/Users/dy/AppData/Roaming/梵禾 Work', 'collector.json'),
  )
  assert.equal(
    collectorConfigPath({ workspaceRoot: 'E:/fanhe' }),
    join('E:/fanhe', '.config', 'fanhe-work', 'collector.json'),
  )
  assert.equal(collectorConfigPath({ workspaceRoot: null }), null)
})

test('环境变量优先于配置文件', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'collector.json'), '{"root":"E:/from-file"}', 'utf8')
    const result = resolveCollectorRoot({
      configDir: dir,
      env: { FANHE_COLLECTOR_ROOT: 'E:/from-env' },
    })
    assert.equal(result.root, 'E:/from-env')
    assert.equal(result.source, 'environment')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('环境变量给空串时不算配置', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'collector.json'), '{"root":"E:/from-file"}', 'utf8')
    const result = resolveCollectorRoot({ configDir: dir, env: { FANHE_COLLECTOR_ROOT: '   ' } })
    assert.equal(result.root, 'E:/from-file', '空串应落到配置文件，而不是当成「配了空路径」')
    assert.equal(result.source, 'file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置文件读不到时返回 null 加说明，不抛错', () => {
  const dir = tempDir()
  try {
    const result = resolveCollectorRoot({ configDir: dir, env: {} })
    assert.equal(result.root, null)
    assert.equal(result.source, 'none')
    assert.match(String(result.warning), /未找到采集器配置/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('配置文件坏了时说明原因，不静默当成没配', () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'collector.json'), '{"root":123}', 'utf8')
    const result = resolveCollectorRoot({ configDir: dir, env: {} })
    assert.equal(result.root, null)
    assert.equal(result.source, 'file')
    assert.match(String(result.warning), /root 必须是字符串/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('脚本候选路径同时覆盖「指向采集器目录」与「指向仓库根」', () => {
  const dir = tempDir()
  try {
    const collectorDir = join(dir, 'tools', 'collector', 'scripts')
    mkdirSync(collectorDir, { recursive: true })
    const candidates = collectorScriptCandidates(dir)
    assert.equal(candidates.length, 2)
    assert.ok(
      candidates.some((item) =>
        item.endsWith(join('tools', 'collector', 'scripts', 'shop-login.ps1')),
      ),
    )
    assert.ok(candidates.some((item) => item.endsWith(join('scripts', 'shop-login.ps1'))))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
