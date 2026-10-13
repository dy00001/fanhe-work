/**
 * 外壳来源（端口）判定的回归测试（T7-02a）。
 *
 * ## 为什么这一组值得单独钉住
 *
 * 端口 → origin → localStorage / IndexedDB 的分区。这三步里**没有任何一步会报错**：
 * 选错端口的结果只是「界面上看不到上次的设置」，而日志里一切正常。所以它必须靠
 * 断言钉住，不能靠跑起来看一眼 —— 一眼看不出「这次是哪个分区」。
 *
 * 直接测 `src/shell-origin.ts`（与 `server.test.mjs` 同款，靠 Node 的类型剥离直接
 * 加载 TS 源码），因此不需要先构建、也不需要 Electron。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  SHELL_PORT_BASE,
  SHELL_PORT_SPAN,
  isFreshOrigin,
  isValidPort,
  orderLegacyPorts,
  parseOriginDirName,
  parseOriginPortsInText,
  parseStoredPort,
  shellPortCandidates,
} from '../src/shell-origin.ts'

// ── 从磁盘上认出来源 ────────────────────────────────────────────────────

test('从 IndexedDB 分片目录名里读出端口', () => {
  // 这是本机 `%APPDATA%\梵禾 Work\IndexedDB` 下的真实名字（实测）。
  assert.equal(parseOriginDirName('http_127.0.0.1_49901.indexeddb.leveldb'), 49901)
  assert.equal(parseOriginDirName('http_127.0.0.1_57352.indexeddb.leveldb'), 57352)
})

test('不是回环来源的目录名一律不认', () => {
  for (const name of [
    // 别的来源：扫进来会让候选链里混进一个永远连不上的端口。
    'https_127.0.0.1_49901.indexeddb.leveldb',
    'http_localhost_49901.indexeddb.leveldb',
    'http_127.0.0.1_49901.indexeddb', // 少了后缀，不是 Chromium 的命名
    'http_127.0.0.1_.indexeddb.leveldb', // 没端口
    'file__0.indexeddb.leveldb',
    'random-directory',
    '',
  ]) {
    assert.equal(parseOriginDirName(name), null, `${name} 不该被认成来源`)
  }
})

test('端口号超出范围时不认（避免拿一个非法值去 listen）', () => {
  assert.equal(parseOriginDirName('http_127.0.0.1_0.indexeddb.leveldb'), null)
  assert.equal(parseOriginDirName('http_127.0.0.1_65536.indexeddb.leveldb'), null)
  assert.equal(parseOriginDirName('http_127.0.0.1_99999.indexeddb.leveldb'), null)
})

test('从 leveldb 内容里扫出回环来源的端口，去重', () => {
  // localStorage 是单库，来源名写在键里（`_http://127.0.0.1:49901\0\1<键名>`），
  // 那串来源名在 .log / .ldb 里是明文，所以一次正则扫描就够。
  const chunk =
    '_http://127.0.0.1:49901\u0000\u0001fanhe.theme' +
    'META:http://127.0.0.1:49901' +
    '_http://127.0.0.1:57352\u0000\u0001fanhe.sidebar-collapsed' +
    '_http://127.0.0.1:49901\u0000\u0001fanhe.device-id'
  assert.deepEqual(
    parseOriginPortsInText(chunk).sort((a, b) => a - b),
    [49901, 57352],
  )
})

test('扫不出东西时返回空数组，不抛错（新机器本来就没有来源）', () => {
  assert.deepEqual(parseOriginPortsInText(''), [])
  assert.deepEqual(parseOriginPortsInText('META:https://example.com'), [])
})

// ── 偏好文件 ────────────────────────────────────────────────────────────

test('偏好文件里的端口要逐个字段校验', () => {
  assert.equal(parseStoredPort({ port: 41873 }), 41873)
  for (const bad of [
    null,
    undefined,
    [],
    '41873',
    {},
    { port: '41873' },
    { port: 0 }, // 0 表示「交给系统」，不是一个可记住的端口
    { port: 1.5 },
    { port: 70000 },
    { port: -1 },
  ]) {
    assert.equal(parseStoredPort(bad), null, `${JSON.stringify(bad)} 不该被接受`)
  }
})

// ── 候选顺序：这一条就是「设置不丢」的判据 ──────────────────────────────

test('候选顺序是 偏好 → 旧来源 → 固定段 → 系统分配', () => {
  // 偏好与旧来源都刻意取**固定段之外**的号：撞进固定段会被去重掉，
  // 那样下面按位置断言的固定段就会整体前移一格，看起来像顺序错了。
  const candidates = shellPortCandidates(50001, [57352, 49901])

  assert.equal(candidates[0], 50001, '偏好端口必须排第一：那是上次实际用的分区')
  assert.deepEqual(candidates.slice(1, 3), [57352, 49901], '旧来源按传入顺序（最近使用倒序）')
  assert.deepEqual(
    candidates.slice(3, 3 + SHELL_PORT_SPAN),
    Array.from({ length: SHELL_PORT_SPAN }, (_, i) => SHELL_PORT_BASE + i),
  )
  assert.equal(candidates[candidates.length - 1], 0, '末尾必须是系统分配，否则端口全占时起不来')
})

test('🔴 首次升级时旧来源排在固定段之前（否则旧数据找不着）', () => {
  // 这是本模块存在的首要理由。用户机器上此刻的数据躺在上一版随机分配的端口分区里；
  // 若固定段排在前面，外壳会稳定地开在一个**空分区**上 —— 稳定，但数据没了。
  const candidates = shellPortCandidates(null, [57352, 49901])
  assert.deepEqual(candidates.slice(0, 2), [57352, 49901])
  assert.ok(
    candidates.indexOf(SHELL_PORT_BASE) > candidates.indexOf(49901),
    '固定段排到了旧来源前面 —— 首次升级会看不到旧设置',
  )
})

test('没有偏好也没有旧来源时，直接落到固定段', () => {
  const candidates = shellPortCandidates(null, [])
  assert.equal(candidates[0], SHELL_PORT_BASE)
  assert.equal(candidates[candidates.length - 1], 0)
})

test('候选里不出现重复端口，且过滤掉非法值', () => {
  const candidates = shellPortCandidates(49901, [49901, 0, -5, 1.5, 49901])
  assert.equal(new Set(candidates).size, candidates.length, '候选里有重复项')

  assert.equal(candidates[0], 49901)
  assert.deepEqual(
    candidates.slice(1, 1 + SHELL_PORT_SPAN),
    Array.from({ length: SHELL_PORT_SPAN }, (_, i) => SHELL_PORT_BASE + i),
  )
  assert.equal(candidates[candidates.length - 1], 0)
})

test('旧来源恰好落在固定段里时不产生重复项', () => {
  // 两个来源（旧端口、固定段）在数学上可能撞号。撞了不去重的话，那个端口会被
  // 试两次 —— 第一次失败、第二次仍然失败，白多一轮 EADDRINUSE。
  const candidates = shellPortCandidates(null, [SHELL_PORT_BASE + 2])
  assert.equal(new Set(candidates).size, candidates.length)
  assert.equal(candidates[0], SHELL_PORT_BASE + 2)
  assert.equal(candidates.filter((port) => port === SHELL_PORT_BASE + 2).length, 1)
})

test('偏好端口与旧来源相同的时候只留一个', () => {
  // 常见情形：上次记下的偏好就是旧来源里最新的那一个。
  const candidates = shellPortCandidates(57352, [57352, 49901])
  assert.deepEqual(candidates.slice(0, 2), [57352, 49901])
})

// ── 换分区的告警判据 ────────────────────────────────────────────────────

test('落在旧来源之外的端口才算「换了分区」', () => {
  assert.equal(isFreshOrigin(SHELL_PORT_BASE, [49901, 57352]), true)
  assert.equal(isFreshOrigin(49901, [49901, 57352]), false)
})

test('一台全新的机器上不算「换了分区」（否则这条告警会被所有人忽略）', () => {
  assert.equal(isFreshOrigin(SHELL_PORT_BASE, []), false)
})

// ── 旧来源的排序 ────────────────────────────────────────────────────────

test('旧来源按最近被写的时刻倒序', () => {
  const seen = new Map([
    [57352, 1000],
    [49901, 2000],
  ])
  assert.deepEqual(orderLegacyPorts(seen), [49901, 57352])
})

test('🔴 时刻并列时的顺序必须确定（不能取决于目录枚举顺序）', () => {
  // 两个来源的时间戳一模一样是**常态**而不是边界：localStorage 是单库，所有来源的
  // 键都写在同一个文件里，那个文件的 mtime 对所有来源都是同一个值。并列时若按 Map
  // 插入顺序排，而插入顺序来自 NTFS 的目录枚举（不保证字典序），同一台机器上两次
  // 运行就可能挑中不同的旧来源 —— 那正是本模块要消灭的那类不确定性。
  const forward = new Map([
    [49901, 5000],
    [57352, 5000],
  ])
  const backward = new Map([
    [57352, 5000],
    [49901, 5000],
  ])
  assert.deepEqual(orderLegacyPorts(forward), orderLegacyPorts(backward))
  assert.deepEqual(orderLegacyPorts(forward), [57352, 49901])
})

test('排序时把非法端口挡在外面', () => {
  const seen = new Map([
    [0, 9999],
    [-1, 9999],
    [70000, 9999],
    [49901, 1000],
  ])
  assert.deepEqual(orderLegacyPorts(seen), [49901])
})

test('空输入给出空数组', () => {
  assert.deepEqual(orderLegacyPorts(new Map()), [])
})

test('端口校验：0 与越界都不是有效端口', () => {
  assert.equal(isValidPort(41873), true)
  assert.equal(isValidPort(65535), true)
  assert.equal(isValidPort(0), false)
  assert.equal(isValidPort(65536), false)
  assert.equal(isValidPort('41873'), false)
})
