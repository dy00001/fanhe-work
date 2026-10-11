/**
 * 纪要草稿暂存的回归测试。
 *
 * 用 Node 内置测试器直接测源码（与 `relative-time.test.mjs` 同款：前端构建会把它打进
 * 浏览器 bundle，不能像共享包一样导入独立的 dist 模块）。
 *
 * **存储用内存假实现注入，不给 `window` 打补丁。** 打补丁会让用例之间共享同一份全局
 * 状态，失败顺序还依赖执行顺序；而 `note-draft` 的接口正是为了这个才把 storage 抽出来。
 *
 * 这里覆盖的全是「不靠界面就能判定」的规则：槽名、序列化与版本校验、过期与容量清理、
 * 前缀隔离、写失败重试与回调次数。**「提交成功后卸载 flush 会把已提交内容写回去」
 * 那个坑不在这里** —— 它由时序构成，只有浏览器 e2e 拦得住（见 `e2e-auth.mjs` 第 9h 段）。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clearNoteDraft,
  draftKey,
  isSameDraftValues,
  readNoteDraft,
  writeNoteDraft,
} from '../src/lib/note-draft.ts'

const PREFIX = 'fanhe-work.draft.note.'
const NEW_KEY = `${PREFIX}new`

/** 内存版存储。`map` 暴露出来只为断言「键到底有没有落下去」。 */
function createStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null
    },
    setItem(key, value) {
      map.set(key, value)
    },
    removeItem(key) {
      map.delete(key)
    },
    keysWithPrefix(prefix) {
      return [...map.keys()].filter((key) => key.startsWith(prefix))
    },
  }
}

function draft(overrides = {}) {
  return {
    v: 1,
    title: '标题',
    content: '正文',
    tags: [],
    savedAt: new Date().toISOString(),
    ...overrides,
  }
}

const isoDaysAgo = (days) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()

test('槽名：有 id 用 id，新建用 new', () => {
  assert.equal(draftKey('abc'), `${PREFIX}abc`)
  assert.equal(draftKey(null), NEW_KEY)
})

test('往返：写进去再读出来，值与保存时刻一致', () => {
  const storage = createStorage()
  writeNoteDraft('note-1', { title: '甲', content: '# 乙', tags: ['a', 'b'] }, { storage })

  const restored = readNoteDraft('note-1', storage)
  assert.notEqual(restored, null)
  assert.equal(restored.title, '甲')
  assert.equal(restored.content, '# 乙')
  assert.deepEqual(restored.tags, ['a', 'b'])
  assert.equal(Number.isNaN(Date.parse(restored.savedAt)), false)
  assert.deepEqual(storage.keysWithPrefix(PREFIX), [`${PREFIX}note-1`])
})

test('版本不认识：读出来是 null，且不抛异常', () => {
  const storage = createStorage({ [`${PREFIX}x`]: JSON.stringify(draft({ v: 2 })) })
  assert.equal(readNoteDraft('x', storage), null)
})

test('结构损坏：非法 JSON、缺字段、字段类型不对，一律当成没有草稿', () => {
  const broken = [
    'not json at all',
    '[]',
    'null',
    '"字符串"',
    JSON.stringify({ v: 1, title: '甲', content: '乙', tags: [] }), // 缺 savedAt
    JSON.stringify({ v: 1, title: 1, content: '乙', tags: [], savedAt: 'x' }),
    JSON.stringify({ v: 1, title: '甲', content: 2, tags: [], savedAt: 'x' }),
    JSON.stringify({ v: 1, title: '甲', content: '乙', tags: '标签', savedAt: 'x' }),
    JSON.stringify({ v: 1, title: '甲', content: '乙', tags: [1], savedAt: 'x' }),
  ]
  for (const raw of broken) {
    const storage = createStorage({ [`${PREFIX}x`]: raw })
    assert.equal(readNoteDraft('x', storage), null, raw)
  }
})

test('空内容不落盘：三个字段全空时清槽，而不是留一条空草稿', () => {
  const storage = createStorage()

  writeNoteDraft(null, { title: '  ', content: '\n', tags: [] }, { storage })
  assert.equal(storage.map.size, 0)
  assert.equal(readNoteDraft(null, storage), null)

  // 先有内容再清空：槽要被删掉，读数随之回到「没有草稿」。
  writeNoteDraft(null, { title: '甲', content: '', tags: [] }, { storage })
  assert.equal(storage.map.size, 1)
  writeNoteDraft(null, { title: '', content: '', tags: [] }, { storage })
  assert.equal(storage.map.size, 0)
})

test('过期清理：8 天前的丢弃并顺手删键，6 天前的保留', () => {
  const storage = createStorage({
    [`${PREFIX}old`]: JSON.stringify(draft({ savedAt: isoDaysAgo(8) })),
    [`${PREFIX}fresh`]: JSON.stringify(draft({ savedAt: isoDaysAgo(6) })),
  })

  assert.equal(readNoteDraft('old', storage), null)
  assert.equal(storage.getItem(`${PREFIX}old`), null)
  assert.notEqual(readNoteDraft('fresh', storage), null)
})

test('容量清理：写第 22 条时最旧的让位，总数回到上限', () => {
  const storage = createStorage()
  const start = Date.now() - 60 * 60 * 1000
  for (let index = 0; index < 21; index += 1) {
    storage.setItem(
      `${PREFIX}${index}`,
      JSON.stringify(draft({ savedAt: new Date(start + index * 1000).toISOString() })),
    )
  }

  writeNoteDraft('newest', { title: '甲', content: '乙', tags: [] }, { storage })

  const keys = storage.keysWithPrefix(PREFIX)
  assert.equal(keys.length, 20)
  assert.equal(keys.includes(`${PREFIX}0`), false)
  assert.equal(keys.includes(`${PREFIX}newest`), true)
})

test('前缀隔离：清理只碰草稿键，界面偏好与其它键一根不动', () => {
  const storage = createStorage({
    'fanhe-work.ui.theme': 'dark',
    'fanhe-work.refresh-token': 'token',
    unrelated: 'x',
    [`${PREFIX}old`]: JSON.stringify(draft({ savedAt: isoDaysAgo(8) })),
  })

  writeNoteDraft(null, { title: '甲', content: '', tags: [] }, { storage })

  assert.equal(storage.getItem('fanhe-work.ui.theme'), 'dark')
  assert.equal(storage.getItem('fanhe-work.refresh-token'), 'token')
  assert.equal(storage.getItem('unrelated'), 'x')
  assert.equal(storage.getItem(`${PREFIX}old`), null)
})

test('写失败：先让掉一条最旧草稿再试一次，仍然失败只回调一次', () => {
  const storage = createStorage({ [`${PREFIX}old`]: JSON.stringify(draft()) })
  let attempts = 0
  storage.setItem = () => {
    attempts += 1
    throw new Error('QuotaExceededError')
  }

  let reported = 0
  writeNoteDraft(
    null,
    { title: '甲', content: '乙', tags: [] },
    {
      storage,
      onWriteError: () => {
        reported += 1
      },
    },
  )

  assert.equal(attempts, 2)
  assert.equal(reported, 1)
  assert.equal(storage.getItem(`${PREFIX}old`), null)
})

test('写失败且没有草稿可让位：不重试，回调仍只有一次', () => {
  const storage = createStorage()
  storage.setItem = () => {
    throw new Error('QuotaExceededError')
  }

  let reported = 0
  writeNoteDraft(
    null,
    { title: '甲', content: '', tags: [] },
    {
      storage,
      onWriteError: () => {
        reported += 1
      },
    },
  )

  assert.equal(reported, 1)
})

test('读失败：getItem 抛异常时按「没有草稿」处理，不往外抛', () => {
  const storage = createStorage()
  storage.getItem = () => {
    throw new Error('SecurityError')
  }

  assert.equal(readNoteDraft('x', storage), null)
  assert.equal(readNoteDraft(null, storage), null)
})

test('与已保存值一致：标题按 trim 后比较，正文与标签原样', () => {
  const saved = { title: '甲', content: '正文', tags: ['a', 'b'] }

  assert.equal(isSameDraftValues(saved, { title: '甲  ', content: '正文', tags: ['a', 'b'] }), true)
  assert.equal(isSameDraftValues(saved, { title: '甲', content: '正文 ', tags: ['a', 'b'] }), false)
  assert.equal(isSameDraftValues(saved, { title: '甲', content: '正文', tags: ['b', 'a'] }), false)
  assert.equal(isSameDraftValues(saved, { title: '甲', content: '正文', tags: ['a'] }), false)
})

test('清除：只删目标槽，别的槽不受影响', () => {
  const storage = createStorage()
  writeNoteDraft('a', { title: '甲', content: '', tags: [] }, { storage })
  writeNoteDraft('b', { title: '乙', content: '', tags: [] }, { storage })

  clearNoteDraft('a', storage)

  assert.equal(readNoteDraft('a', storage), null)
  assert.notEqual(readNoteDraft('b', storage), null)
  assert.deepEqual(storage.keysWithPrefix(PREFIX), [`${PREFIX}b`])
})
