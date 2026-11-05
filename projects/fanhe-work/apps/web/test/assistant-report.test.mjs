/**
 * 数据简报展示规则的单元测试。
 *
 * 这三条都是「错了不会报错」的判断：
 *
 *   ① 角色名单写错 → 入口该出现时不出现，或者相反。两种都不会让页面崩，只会让人以为
 *      功能没做。
 *   ② 降级原因映射错 → 界面提示「稍后重试」，而实际是模型端点没配，点一百次也不会好。
 *   ③ 文件名不带区间 → 下载十份之后分不清哪份是哪份。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  canUseAssistantReport,
  reportFailureText,
  reportFileName,
  REPORT_DAY_OPTIONS,
  ASSISTANT_REPORT_ROLES,
} from '../src/lib/assistant-report.ts'

describe('canUseAssistantReport', () => {
  test('只对 owner 与 admin 开放', () => {
    assert.equal(canUseAssistantReport('owner'), true)
    assert.equal(canUseAssistantReport('admin'), true)
  })

  test('其余四个内置角色一律不放行', () => {
    for (const role of ['designer', 'sales', 'member', 'viewer']) {
      assert.equal(canUseAssistantReport(role), false, `${role} 不该拿到入口`)
    }
  })

  test('缺失或异常取值按无权限处理', () => {
    // 认证还没完成时 `user` 是 null，这一支必须走到「不渲染」，而不是抛错。
    assert.equal(canUseAssistantReport(null), false)
    assert.equal(canUseAssistantReport(undefined), false)
    assert.equal(canUseAssistantReport(''), false)
    // 大小写不匹配不算命中：角色 code 由服务端下发，恒为小写。放宽它反而会让
    // 「写错一个字母」这类问题在本地被掩盖。
    assert.equal(canUseAssistantReport('Owner'), false)
  })

  test('名单与服务端保持一致的三项', () => {
    // 加角色时必须同步改 `apps/api/src/assistant/scope.ts` 的 ASSISTANT_DATA_ROLES，
    // 这条断言是提醒：数量变了就回来看一眼那边。
    assert.deepEqual([...ASSISTANT_REPORT_ROLES], ['owner', 'admin'])
  })
})

describe('reportFailureText', () => {
  test('四种原因给出四种不同的处置建议', () => {
    const texts = [
      reportFailureText('model_not_configured'),
      reportFailureText('model_timeout'),
      reportFailureText('model_failed'),
      reportFailureText('no_data'),
    ]
    assert.equal(new Set(texts).size, 4, '四种原因不能共用一句话')
  })

  test('未配置时不说「重试」——重试没有意义', () => {
    assert.match(reportFailureText('model_not_configured'), /未配置/)
    assert.doesNotMatch(reportFailureText('model_not_configured'), /重试/)
  })

  test('超时时明确给出重试建议', () => {
    assert.match(reportFailureText('model_timeout'), /重试/)
  })

  test('原因为空时仍有可读兜底', () => {
    assert.notEqual(reportFailureText(null).trim(), '')
  })
})

describe('reportFileName', () => {
  test('文件名带区间，且是 .md', () => {
    const name = reportFileName({ from: '2026-10-30', to: '2026-11-05' })
    assert.match(name, /2026-10-30/)
    assert.match(name, /2026-11-05/)
    assert.match(name, /\.md$/)
  })
})

describe('REPORT_DAY_OPTIONS', () => {
  test('三档都在服务端允许的 1 到 90 之间', () => {
    for (const option of REPORT_DAY_OPTIONS) {
      assert.ok(option.days >= 1 && option.days <= 90, `${option.days} 超出服务端区间`)
    }
  })
})
