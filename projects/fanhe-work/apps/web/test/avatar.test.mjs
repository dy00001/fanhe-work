/**
 * 自定义头像存储的回归测试。
 *
 * 存储层最容易被当成「没什么可测的」，但它有两条只在**特定环境**下才暴露的分支，
 * 而它们恰好是用户会遇到的：
 *   - 隐私模式 / 存储被禁用 → `localStorage` 取不到，`setItem` 会抛；
 *   - 存满 → `setItem` 抛 `QuotaExceededError`。
 *
 * 两种都不该让「换头像」把界面带崩，也不该让用户以为「换成功了」。所以这里用假存储
 * 把这几条逐个钉住 —— 真机上想复现它们要先清配额或者开无痕窗口，成本高得多。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  AVATAR_MAX_CHARS,
  avatarStorageKey,
  clearAvatar,
  isAcceptableAvatar,
  readAvatar,
  writeAvatar,
} from '../src/lib/avatar.ts'

/** 一份最小可用的假 localStorage。 */
function memoryStorage() {
  const map = new Map()
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
    /** 测试用：直接看底层表，断言「没写进去」时不必绕一圈读。 */
    raw: map,
  }
}

/** 一张最小的合法 PNG data URL（内容不必是真图，校验只看前缀与长度）。 */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='

test('存储键按用户分开，且带版本段', () => {
  assert.equal(avatarStorageKey('u-1'), 'fanhe-work.avatar.v1.u-1')
  assert.notEqual(avatarStorageKey('u-1'), avatarStorageKey('u-2'))
})

test('写入后读得回来', () => {
  const storage = memoryStorage()
  assert.deepEqual(writeAvatar('u-1', PNG, storage), { ok: true })
  assert.equal(readAvatar('u-1', storage), PNG)
})

test('两个账号的头像互不覆盖', () => {
  const storage = memoryStorage()
  const other = 'data:image/jpeg;base64,/9j/4AAQ'
  writeAvatar('u-1', PNG, storage)
  writeAvatar('u-2', other, storage)
  assert.equal(readAvatar('u-1', storage), PNG)
  assert.equal(readAvatar('u-2', storage), other)
})

test('没设过头像时读出来是 null，不是空串', () => {
  assert.equal(readAvatar('u-1', memoryStorage()), null)
})

test('非图片 data URL 一律不写，原因是 invalid', () => {
  const storage = memoryStorage()
  for (const bad of [
    '',
    'javascript:alert(1)',
    'https://example.com/a.png',
    'data:text/plain;base64,QQ==',
  ]) {
    assert.deepEqual(writeAvatar('u-1', bad, storage), { ok: false, reason: 'invalid' }, bad)
  }
  assert.equal(storage.raw.size, 0, '不合法的值一个都不该落进存储')
})

test('超过长度上限的值不写，原因是 too_large', () => {
  const storage = memoryStorage()
  const huge = `data:image/png;base64,${'A'.repeat(AVATAR_MAX_CHARS)}`
  assert.deepEqual(writeAvatar('u-1', huge, storage), { ok: false, reason: 'too_large' })
  assert.equal(storage.raw.size, 0)
})

test('存储不可用时写入报 unavailable，读取回落 null（不抛）', () => {
  assert.deepEqual(writeAvatar('u-1', PNG, null), { ok: false, reason: 'unavailable' })
  assert.equal(readAvatar('u-1', null), null)
  assert.doesNotThrow(() => clearAvatar('u-1', null))
})

test('setItem 抛（配额满 / 被禁用）时报 unavailable 而不是把异常抛给调用方', () => {
  const storage = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
    removeItem: () => {},
  }
  assert.deepEqual(writeAvatar('u-1', PNG, storage), { ok: false, reason: 'unavailable' })
})

test('getItem 抛时读取回落 null', () => {
  const storage = {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => {},
    removeItem: () => {},
  }
  assert.equal(readAvatar('u-1', storage), null)
})

test('存储里躺着一个不合法值（手改 / 旧版本留下的）时当没有处理', () => {
  const storage = memoryStorage()
  storage.setItem(avatarStorageKey('u-1'), 'not-a-data-url')
  assert.equal(readAvatar('u-1', storage), null)
})

test('清除后回到 null，且重复清除不报错', () => {
  const storage = memoryStorage()
  writeAvatar('u-1', PNG, storage)
  clearAvatar('u-1', storage)
  assert.equal(readAvatar('u-1', storage), null)
  assert.doesNotThrow(() => clearAvatar('u-1', storage))
})

test('isAcceptableAvatar 只认三种图片前缀', () => {
  assert.equal(isAcceptableAvatar('data:image/png;base64,AA'), true)
  assert.equal(isAcceptableAvatar('data:image/jpeg;base64,AA'), true)
  assert.equal(isAcceptableAvatar('data:image/webp;base64,AA'), true)
  assert.equal(isAcceptableAvatar('data:image/gif;base64,AA'), false)
  assert.equal(isAcceptableAvatar('data:image/svg+xml;base64,AA'), false)
})
