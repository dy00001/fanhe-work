/**
 * 程序图标读取的回归测试（§2.9）。
 *
 * 这一层钉的是三件事：
 *
 * 1. **入参归一**：只收绝对路径、去重、限长。这条通道对渲染进程里的任何脚本开放，
 *    虽然读图标本身无害，但相对路径的解析基准是外壳进程的 cwd，结果不可预期。
 * 2. **回落语义**：取不到（抛错 / 空串）一律归成 `dataUrl: null`，绝不抛异常 ——
 *    图标是锦上添花，不能因为它失败而让界面渲染不出来。
 * 3. **缓存语义**：成功才进缓存、命中刷新使用顺序、超限按最久未用淘汰。
 *    「`null` 不进缓存」是有意的：一次瞬时失败（文件被占用、盘刚拔）不该被钉死。
 *
 * 全部用例注入假的 `fetchIcon`，**不碰真实文件系统、不调 Electron**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  createLaunchIconReader,
  MAX_ICON_PATHS,
  normalizeIconPath,
  normalizeIconPaths,
} from '../src/launch-icon.ts'

const EXE = 'D:\\软件安装目录\\QQ\\QQ.exe'

test('normalizeIconPath：只认非空绝对路径，其余一律 null', () => {
  assert.equal(normalizeIconPath(EXE), EXE)
  assert.equal(normalizeIconPath(`  ${EXE}  `), EXE)
  assert.equal(normalizeIconPath('QQ.exe'), null)
  assert.equal(normalizeIconPath(''), null)
  assert.equal(normalizeIconPath('   '), null)
  assert.equal(normalizeIconPath(null), null)
  assert.equal(normalizeIconPath(42), null)
  assert.equal(normalizeIconPath({ path: EXE }), null)
})

test('normalizeIconPaths：去重（大小写不敏感）、保序、丢非法项', () => {
  assert.deepEqual(normalizeIconPaths([EXE, 'C:\\a\\b.exe', 'QQ.exe', '', null]), [
    EXE,
    'C:\\a\\b.exe',
  ])
  // 同一条 exe 被两条配置指向（QQ 与 QQ2 同一份安装）时只取一次。
  assert.deepEqual(normalizeIconPaths(['C:\\a\\b.exe', 'c:\\A\\B.EXE']), ['C:\\a\\b.exe'])
  // 非数组一律空。
  assert.deepEqual(normalizeIconPaths('C:\\a\\b.exe'), [])
  assert.deepEqual(normalizeIconPaths(undefined), [])
})

test('normalizeIconPaths：按 limit 截断，默认上限是 MAX_ICON_PATHS', () => {
  const many = Array.from({ length: 100 }, (_, i) => `C:\\p\\${i}.exe`)
  assert.equal(normalizeIconPaths(many).length, MAX_ICON_PATHS)
  assert.deepEqual(normalizeIconPaths(many, 3), ['C:\\p\\0.exe', 'C:\\p\\1.exe', 'C:\\p\\2.exe'])
})

test('createLaunchIconReader：取到的结果进缓存，同一路径只取一次', async () => {
  const calls = []
  const reader = createLaunchIconReader({
    fetchIcon: async (path) => {
      calls.push(path)
      return `data:image/png;base64,${path}`
    },
  })

  const first = await reader.read([EXE])
  const second = await reader.read([EXE])

  assert.deepEqual(calls, [EXE])
  assert.equal(first[0].path, EXE)
  assert.equal(first[0].dataUrl, `data:image/png;base64,${EXE}`)
  assert.deepEqual(second, first)
})

test('createLaunchIconReader：大小写不同的同一路径共用缓存，回传原样大小写', async () => {
  const calls = []
  const reader = createLaunchIconReader({
    fetchIcon: async (path) => {
      calls.push(path)
      return 'data:image/png;base64,AAAA'
    },
  })

  const a = await reader.read(['C:\\a\\b.exe'])
  const b = await reader.read(['C:\\A\\B.EXE'])

  assert.deepEqual(calls, ['C:\\a\\b.exe'])
  assert.equal(a[0].path, 'C:\\a\\b.exe')
  // 回传的是**请求里那一条**的写法，便于界面按路径把结果配回去。
  assert.equal(b[0].path, 'C:\\A\\B.EXE')
  assert.equal(b[0].dataUrl, 'data:image/png;base64,AAAA')
})

test('createLaunchIconReader：抛错与空串归成 null，且不抛出去', async () => {
  const calls = []
  const reader = createLaunchIconReader({
    fetchIcon: async (path) => {
      calls.push(path)
      if (path === 'C:\\bad.exe') throw new Error('getFileIcon 炸了')
      return ''
    },
  })

  const entries = await reader.read(['C:\\bad.exe', 'C:\\empty.exe'])
  assert.deepEqual(entries, [
    { path: 'C:\\bad.exe', dataUrl: null },
    { path: 'C:\\empty.exe', dataUrl: null },
  ])
  assert.deepEqual(calls, ['C:\\bad.exe', 'C:\\empty.exe'])
})

test('createLaunchIconReader：null 不进缓存，下次还会再试', async () => {
  let calls = 0
  const reader = createLaunchIconReader({
    fetchIcon: async () => {
      calls += 1
      return null
    },
  })

  await reader.read([EXE])
  await reader.read([EXE])
  // 一次瞬时失败（文件被占用、盘刚拔）不该被钉死到进程退出。
  assert.equal(calls, 2)
})

test('createLaunchIconReader：超限按「最久未用」淘汰，命中会刷新使用顺序', async () => {
  const calls = []
  const reader = createLaunchIconReader({
    cacheLimit: 2,
    fetchIcon: async (path) => {
      calls.push(path)
      return `data:image/png;base64,${path}`
    },
  })
  const A = 'C:\\a.exe'
  const B = 'C:\\b.exe'
  const C = 'C:\\c.exe'

  await reader.read([A])
  await reader.read([B])
  await reader.read([A]) // 命中 → A 变成最近使用
  await reader.read([C]) // 超限 → 淘汰最久未用的 B
  assert.deepEqual(calls, [A, B, C])

  await reader.read([A]) // A 还在缓存里
  assert.deepEqual(calls, [A, B, C])

  await reader.read([B]) // B 已被淘汰 → 重新取
  assert.deepEqual(calls, [A, B, C, B])
})

test('createLaunchIconReader：一次 read 的入参已去重，不会重复取', async () => {
  const calls = []
  const reader = createLaunchIconReader({
    fetchIcon: async (path) => {
      calls.push(path)
      return 'data:image/png;base64,AAAA'
    },
  })

  // 调用方通常先过 normalizeIconPaths，这里直接喂原始数组验证 reader 也不放大请求。
  const entries = await reader.read(normalizeIconPaths([EXE, 'd:\\软件安装目录\\QQ\\qq.EXE']))
  assert.equal(entries.length, 1)
  assert.deepEqual(calls, [EXE])
})

test('createLaunchIconReader：空入参返回空数组，不调 fetchIcon', async () => {
  let calls = 0
  const reader = createLaunchIconReader({
    fetchIcon: async () => {
      calls += 1
      return 'data:image/png;base64,AAAA'
    },
  })

  assert.deepEqual(await reader.read([]), [])
  assert.equal(calls, 0)
})
