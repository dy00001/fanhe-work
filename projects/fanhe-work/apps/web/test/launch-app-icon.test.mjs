/**
 * §2.9 真实程序图标与品牌色的纯函数测试。
 *
 * 钉三件事：
 *
 * 1. **品牌色解析**：四个软件标识各给一色，认不出的标识回落中性色（库里可能留着旧值）。
 * 2. **查找表归一**：键统一小写（Windows 路径大小写不敏感，同一份安装被两条配置指向时
 *    用户填的大小写很可能不同），取不到的条目不入表。
 * 3. **查询不踩原型链**：路径长得像 `constructor` 时不能取到一个函数。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  indexLaunchIconUrls,
  LAUNCH_BRAND_HUES,
  LAUNCH_APP_ICON_SIZE,
  pickLaunchIconUrl,
  resolveLaunchBrandHue,
} from '../src/lib/launch-app-icon.ts'

const PNG = 'data:image/png;base64,AAAA'

test('resolveLaunchBrandHue：四个已知软件各一色，互不相同', () => {
  assert.equal(resolveLaunchBrandHue({ software: 'wechat' }), LAUNCH_BRAND_HUES.wechat)
  assert.equal(resolveLaunchBrandHue({ software: 'qq' }), LAUNCH_BRAND_HUES.qq)
  assert.equal(resolveLaunchBrandHue({ software: 'qianniu' }), LAUNCH_BRAND_HUES.qianniu)
  assert.equal(resolveLaunchBrandHue({ software: 'custom' }), LAUNCH_BRAND_HUES.custom)

  const values = Object.values(LAUNCH_BRAND_HUES)
  assert.equal(new Set(values).size, values.length, '四个品牌色不该有重复')
  for (const value of values) assert.match(value, /^#[0-9a-f]{6}$/)
})

test('resolveLaunchBrandHue：认不出的标识回落中性色，不抛错', () => {
  // 标识清单在前端、会随版本演进；库里可能留着早先选中过的旧标识。
  assert.equal(resolveLaunchBrandHue({ software: 'sketchup' }), LAUNCH_BRAND_HUES.custom)
  assert.equal(resolveLaunchBrandHue({ software: '' }), LAUNCH_BRAND_HUES.custom)
})

test('indexLaunchIconUrls：键统一小写，取不到的条目不入表', () => {
  const index = indexLaunchIconUrls([
    { path: 'D:\\软件安装目录\\QQ\\QQ.exe', dataUrl: PNG },
    { path: 'C:\\a\\b.exe', dataUrl: null },
    { path: 'C:\\a\\c.exe', dataUrl: '' },
  ])
  assert.deepEqual(Object.keys(index), ['d:\\软件安装目录\\qq\\qq.exe'])
  assert.equal(index['d:\\软件安装目录\\qq\\qq.exe'], PNG)
})

test('indexLaunchIconUrls：同一路径重复出现时以先出现的为准', () => {
  const index = indexLaunchIconUrls([
    { path: 'C:\\a\\b.exe', dataUrl: 'first' },
    { path: 'C:\\A\\B.EXE', dataUrl: 'second' },
  ])
  assert.equal(index['c:\\a\\b.exe'], 'first')
})

test('indexLaunchIconUrls：空数组与畸形条目都不炸', () => {
  assert.deepEqual(indexLaunchIconUrls([]), {})
  const index = indexLaunchIconUrls([
    { path: '', dataUrl: PNG },
    { path: 'C:\\a\\b.exe', dataUrl: undefined },
  ])
  assert.deepEqual(index, {})
})

test('pickLaunchIconUrl：大小写与首尾空白不敏感', () => {
  const index = indexLaunchIconUrls([{ path: 'D:\\软件安装目录\\QQ\\QQ.exe', dataUrl: PNG }])
  assert.equal(pickLaunchIconUrl({ executablePath: 'D:\\软件安装目录\\QQ\\QQ.exe' }, index), PNG)
  assert.equal(pickLaunchIconUrl({ executablePath: 'd:\\软件安装目录\\qq\\qq.EXE' }, index), PNG)
  assert.equal(
    pickLaunchIconUrl({ executablePath: '  D:\\软件安装目录\\QQ\\QQ.exe  ' }, index),
    PNG,
  )
})

test('pickLaunchIconUrl：没有这条路径时返回 null（调用方回落内置图标）', () => {
  const index = indexLaunchIconUrls([{ path: 'C:\\a\\b.exe', dataUrl: PNG }])
  assert.equal(pickLaunchIconUrl({ executablePath: 'C:\\a\\zzz.exe' }, index), null)
  assert.equal(pickLaunchIconUrl({ executablePath: '' }, index), null)
  assert.equal(pickLaunchIconUrl({ executablePath: 'C:\\a\\b.exe' }, {}), null)
})

test('pickLaunchIconUrl：路径长得像原型链上的键时不能取到函数', () => {
  // 直接索引 `index['constructor']` 会拿到 Object 的构造函数（真值），
  // 渲染处会把它当图片地址塞进 <img src> —— 所以必须用 hasOwn 判存在。
  assert.equal(pickLaunchIconUrl({ executablePath: 'constructor' }, {}), null)
  assert.equal(pickLaunchIconUrl({ executablePath: 'toString' }, {}), null)
  assert.equal(pickLaunchIconUrl({ executablePath: 'hasOwnProperty' }, {}), null)
})

test('LAUNCH_APP_ICON_SIZE：24 落在 36 的图标盒内且留出边距', () => {
  assert.equal(LAUNCH_APP_ICON_SIZE, 24)
})
