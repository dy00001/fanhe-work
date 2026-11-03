/**
 * 批量导入的展示规则：文件校验、两段进度、文案。
 *
 * 单独钉这一组纯函数的理由很实际：这些判断在组件里只能靠「真的选一个 12MB 的文件、
 * 真的等它传一半」来验，而这台机器上跑一次要几十秒。放在这里，0 字节、刚好等于
 * 上限、上限加一字节、总量未知、阶段未开始这些边界一个 `node --test` 全走完。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  elapsedSeconds,
  formatMegabytes,
  importProgressLabel,
  uploadPercent,
  validateImportFile,
} from '../src/lib/quote-import-display.ts'
import { QUOTE_LIMITS } from '@fanhe/shared'

const LIMIT = QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX

test('文件校验：扩展名、空文件、超上限三种都在发请求之前拦下', () => {
  assert.equal(validateImportFile({ name: '台账.xlsx', size: 1024 }), null)
  assert.equal(validateImportFile({ name: 'LEDGER.CSV', size: 1024 }), null, '大写扩展名也要认')
  assert.equal(validateImportFile({ name: '报价单.pdf', size: 1024 }), null)

  // 旧版 .xls 是另一套二进制格式，没有实现解析路径。放过去只会在服务端变成
  // 「只认 Excel（.xlsx）、CSV 与 PDF」，而那句话在选完文件之后才出现。
  const legacy = validateImportFile({ name: '台账.xls', size: 1024 })
  assert.ok(legacy !== null && legacy.includes('.xls'), '.xls 没有在选文件时被拦下')

  assert.ok(validateImportFile({ name: '空.csv', size: 0 }) !== null, '空文件没有提示')

  // 边界：正好等于上限必须放行，多一个字节必须拒。
  assert.equal(validateImportFile({ name: '刚好.xlsx', size: LIMIT }), null, '等于上限被误拒')
  const over = validateImportFile({ name: '超了.xlsx', size: LIMIT + 1 })
  assert.ok(over !== null, '超过上限没有拦下 —— 那 12MB 的文件会被照传一遍再失败')
  // 提示里要带上真实大小与上限：只说「文件太大」，人还是不知道要拆到多小。
  assert.ok(over.includes('MB'), '超限提示没有写上限')
  assert.ok(over.includes(formatMegabytes(LIMIT + 1)), '超限提示没有写文件的实际大小')
})

test('上传进度：只有上传阶段给百分比，总量未知时给 null', () => {
  const base = { phase: 'uploading', fileBytes: 1000, uploadedBytes: 0, phaseStartedAt: 0 }
  assert.equal(uploadPercent(base), 0)
  assert.equal(uploadPercent({ ...base, uploadedBytes: 250 }), 25)
  assert.equal(uploadPercent({ ...base, uploadedBytes: 1000 }), 100)

  // 向下取整，不到 100 就不显示 100：99.6% 显示成 100% 会让人以为传完了，
  // 然后盯着一个不动 100% 的条等识别。
  assert.equal(uploadPercent({ ...base, uploadedBytes: 996 }), 99)

  // 总量未知（`lengthComputable` 为假）时不画确定态。
  assert.equal(uploadPercent({ ...base, fileBytes: 0 }), null)

  // 识别 / 写入阶段已经过了上传，一律 100。
  assert.equal(uploadPercent({ ...base, phase: 'analyzing' }), 100)
  assert.equal(uploadPercent({ ...base, phase: 'applying' }), 100)
})

test('已用秒数：阶段没开始算 0，不为负数，向下取整', () => {
  const view = { phase: 'analyzing', fileBytes: 0, uploadedBytes: 0, phaseStartedAt: 1_000 }
  assert.equal(elapsedSeconds({ ...view, phaseStartedAt: null }, 60_000), 0)
  assert.equal(elapsedSeconds(view, 1_000), 0)
  assert.equal(elapsedSeconds(view, 4_900), 3)
  // 时钟回拨（系统时间被改）不该显示一个负的秒数。
  assert.equal(elapsedSeconds(view, 500), 0)
})

test('进度文案：识别阶段不给百分比，只给秒数', () => {
  assert.equal(importProgressLabel('uploading', 42, 0), '正在上传 42%')
  assert.equal(importProgressLabel('uploading', null, 0), '正在上传')
  assert.ok(importProgressLabel('analyzing', 100, 7).includes('7'))
  // 关键：识别阶段把 100 传进来也不会拼成「100%」。
  assert.ok(
    !importProgressLabel('analyzing', 100, 7).includes('%'),
    '识别阶段显示了百分比。那一段服务端一次完成，没有刻度，编出来就是假进度。',
  )
  assert.ok(importProgressLabel('applying', 100, 3).includes('3'))
  assert.equal(importProgressLabel('idle', null, 0), '')
})

test('文件大小：小于 1MB 用 KB，避免出现「0.0MB」', () => {
  assert.equal(formatMegabytes(0), '0KB')
  assert.equal(formatMegabytes(512 * 1024), '512KB')
  assert.equal(formatMegabytes(1.5 * 1024 * 1024), '1.5MB')
  assert.equal(formatMegabytes(12.25 * 1024 * 1024), '12MB')
})
