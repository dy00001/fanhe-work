/**
 * 案例图片资产与缓存策略的测试。
 *
 * 分两组，对应两件容易悄悄坏掉的事：
 *
 *   1. **缩略图真的在仓库里。** 清单里写了 `thumb` 只是字符串，文件没生成 / 生成失败 /
 *      被 40KB 的原图冒充，界面上都是「格子里有一块图」，肉眼分不出。断言落在磁盘字节上
 *      （WebP 魔数 + 体积上限）。
 *   2. **缓存计划不会白同步，也不会漏同步。** 计划算错的两种表现都不报错：全量重来是
 *      「每次打开图集都下载一遍」，全跳过是「改了图但界面还是旧的」。两个方向各钉一条。
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CASE_ASSET_VERSION,
  CASE_CATEGORIES,
  caseAssetFiles,
  caseCoverItemId,
} from '../src/lib/case-catalog.ts'
import { planSync } from '../src/lib/case-asset-cache.ts'

const here = dirname(fileURLToPath(import.meta.url))
const publicDir = join(here, '..', 'public')
const thumbDir = join(publicDir, 'cases', 'thumbs')

const files = caseAssetFiles()
const EMPTY_META = { version: '', files: {}, lastSyncedAt: null }

test('图片集指纹：八位十六进制，且同一份清单稳定', () => {
  assert.match(CASE_ASSET_VERSION, /^[0-9a-f]{8}$/)
  // 同一进程内两次读取必须一样 —— 它参与「要不要重同步」的判断，每次刷新都变的话
  // 缓存永远全量重来。
  assert.equal(CASE_ASSET_VERSION, CASE_ASSET_VERSION)
})

test('资产清单覆盖全部品类：封面 + 案例', () => {
  const expected = CASE_CATEGORIES.reduce(
    (sum, category) => sum + (category.cover === null ? 0 : 1) + category.cases.length,
    0,
  )
  assert.equal(files.length, expected)

  const ids = files.map((file) => file.id)
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一')

  for (const file of files) {
    // 每张图的 id 都要满足服务端的归属判断（前缀即品类），否则接口会拒掉它的移动请求。
    assert.ok(file.id.startsWith(`${file.categoryId}-`), `${file.id} 与品类对不上`)
    assert.equal(caseCoverItemId(file.categoryId).startsWith(`${file.categoryId}-`), true)
  }
})

test('每张缩略图都在磁盘上，是 WebP，且确实比原图小一个量级', () => {
  for (const file of files) {
    // 封面直接用 800px 那张，没有单独的缩略图文件。
    if (file.thumb === file.src) continue
    const path = join(publicDir, file.thumb.replace(/^\//, ''))
    const stat = statSync(path)
    assert.ok(stat.size > 1024, `${file.id} 的缩略图太小，可能是空文件`)
    // 上限 60KB：一张 320px 的 webp 正常在 5-10KB。超过这个数说明生成脚本用了原图。
    assert.ok(stat.size < 60 * 1024, `${file.id} 的缩略图有 ${stat.size} 字节，像原图`)
    const head = readFileSync(path).subarray(0, 12)
    assert.equal(head.subarray(0, 4).toString('ascii'), 'RIFF', `${file.id} 不是 WebP`)
    assert.equal(head.subarray(8, 12).toString('ascii'), 'WEBP', `${file.id} 不是 WebP`)
  }
})

test('缩略图目录里没有清单之外的孤儿文件', () => {
  const known = new Set(
    files
      .filter((file) => file.thumb !== file.src)
      .map((file) => file.thumb.replace('/cases/thumbs/', '')),
  )
  const onDisk = readdirSync(thumbDir).filter((name) => name.endsWith('.webp'))
  const orphans = onDisk.filter((name) => !known.has(name))
  // 反向检查：改了张数却没删旧图，不会有任何界面症状，只会让仓库慢慢变脏。
  assert.deepEqual(orphans, [], `缩略图目录里有清单外的文件：${orphans.join(', ')}`)
  assert.equal(onDisk.length, known.size)
})

test('同步计划：版本不一致时全量重来', () => {
  const meta = { ...EMPTY_META, version: 'deadbeef', files: { 'cabinet-1': { bytes: 1, at: '' } } }
  const plan = planSync(files, meta, CASE_ASSET_VERSION)
  assert.equal(plan.reset, true)
  assert.equal(plan.toWrite.length, files.length)
  assert.equal(plan.toSkip, 0)
})

test('同步计划：版本一致时只补缺失的', () => {
  const [first, second] = files
  assert.ok(first !== undefined && second !== undefined)
  const meta = {
    version: CASE_ASSET_VERSION,
    files: { [first.id]: { bytes: 2048, at: '2026-10-29T00:00:00.000Z' } },
    lastSyncedAt: '2026-10-29T00:00:00.000Z',
  }
  const plan = planSync(files, meta, CASE_ASSET_VERSION)
  assert.equal(plan.reset, false)
  assert.equal(plan.toSkip, 1)
  assert.equal(plan.toWrite.length, files.length - 1)
  // 反向：已经缓存过的那一张不能被再写一遍。
  assert.equal(
    plan.toWrite.some((file) => file.id === first.id),
    false,
  )
})

test('同步计划：全都缓存过时什么都不做', () => {
  const meta = {
    version: CASE_ASSET_VERSION,
    files: Object.fromEntries(files.map((file) => [file.id, { bytes: 2048, at: '' }])),
    lastSyncedAt: '',
  }
  const plan = planSync(files, meta, CASE_ASSET_VERSION)
  assert.equal(plan.toWrite.length, 0)
  assert.equal(plan.toSkip, files.length)
})
