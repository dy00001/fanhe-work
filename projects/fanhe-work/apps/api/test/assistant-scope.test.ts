/**
 * 数据桥的准入判定。
 *
 * 这里守的两件事都属于「错了不会报错」：
 *
 *   ① **角色闸门**。多放行一个角色，他不会看到任何异常提示 —— 只是突然能用一份全公司
 *      的经营数据。少放行一个，管理员点不到入口，而报错信息不会出现在任何地方。
 *   ② **模块闸门**。它决定「取不取这个模块」。写反了，汇报会少一块或在正文里写
 *      「无权限」，而两边的数字看起来都正常。
 *
 * 不连库：`viewerForAssistant` 是纯函数，权限点由调用方传入。这也正是把它单独拆出来
 * 的理由 —— 需要起一个带数据库的测试环境才能验权限的地方，最后多半没人验。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { PERMISSIONS, ROLE_PERMISSIONS } from '@fanhe/shared'

import { rangeOfDays } from '../src/assistant/collect.js'
import { scopeNoteOf, viewerForAssistant } from '../src/assistant/scope.js'

function contextOf(roleCode: string, permissions = ROLE_PERMISSIONS.owner) {
  return {
    userId: '0192f0aa-1111-7000-8000-aaaaaaaaaaaa',
    username: 'tester',
    displayName: '测试账号',
    roleCode,
    roleRank: 50,
    permissions,
  }
}

describe('viewerForAssistant', () => {
  test('超级管理员与管理员放行', () => {
    assert.notEqual(viewerForAssistant(contextOf('owner', ROLE_PERMISSIONS.owner)), null)
    assert.notEqual(viewerForAssistant(contextOf('admin', ROLE_PERMISSIONS.admin)), null)
  })

  test('其余四个角色一律拒绝', () => {
    for (const role of ['designer', 'sales', 'member', 'viewer']) {
      const permissionSet =
        ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS] ?? ROLE_PERMISSIONS.viewer
      assert.equal(
        viewerForAssistant(contextOf(role, permissionSet)),
        null,
        `${role} 不该被放行 —— 即使它持有全部权限点`,
      )
    }
  })

  test('角色过关但缺模块权限点时，该模块标记为 no_permission', () => {
    // 模拟「管理员被收回运营读点」：这是第二层闸门唯一会生效的场景。
    // 若这里也跟着返回 null，就把「少看一个模块」放大成「整个功能不可用」。
    const withoutOps = ROLE_PERMISSIONS.admin.filter((code) => code !== PERMISSIONS.OPS_SHOP_READ)
    const viewer = viewerForAssistant(contextOf('admin', withoutOps))
    assert.notEqual(viewer, null)
    assert.equal(viewer?.modules.ops.allowed, false)
    assert.equal(viewer?.modules.ops.reason, 'no_permission')
    // 其余两个模块不受牵连。
    assert.equal(viewer?.modules.customer.allowed, true)
    assert.equal(viewer?.modules.quote.allowed, true)
  })

  test('三个模块的读点分别对应各自的路由守卫', () => {
    const viewer = viewerForAssistant(contextOf('admin', ROLE_PERMISSIONS.admin))
    assert.equal(viewer?.modules.ops.allowed, true)
    assert.equal(viewer?.modules.customer.allowed, true)
    assert.equal(viewer?.modules.quote.allowed, true)
  })
})

describe('scopeNoteOf', () => {
  test('把每个模块的纳入情况写进一句话', () => {
    const viewer = viewerForAssistant(contextOf('owner', ROLE_PERMISSIONS.owner))
    const note = scopeNoteOf(viewer!)
    assert.match(note, /运营信息平台：已纳入/)
    assert.match(note, /客户信息平台：已纳入/)
    assert.match(note, /报价体系：已纳入/)
  })

  test('缺权限的模块写明「未纳入」，而不是悄悄不出现', () => {
    const withoutQuote = ROLE_PERMISSIONS.admin.filter(
      (code) => code !== PERMISSIONS.PERSONAL_QUOTE_READ,
    )
    const note = scopeNoteOf(viewerForAssistant(contextOf('admin', withoutQuote))!)
    assert.match(note, /报价体系：无权限，未纳入/)
  })
})

describe('rangeOfDays', () => {
  test('7 天是含首尾的 7 个自然日', () => {
    // 用固定时刻，避免测试随运行日期漂移。
    const range = rangeOfDays(7, new Date(2026, 10, 5, 14, 30))
    assert.equal(range.from, '2026-10-30')
    assert.equal(range.to, '2026-11-05')
  })

  test('1 天时首尾相同', () => {
    const range = rangeOfDays(1, new Date(2026, 10, 5, 14, 30))
    assert.equal(range.from, '2026-11-05')
    assert.equal(range.to, '2026-11-05')
  })

  test('跨月与跨年都不越界', () => {
    assert.equal(rangeOfDays(3, new Date(2026, 2, 2)).from, '2026-02-28')
    assert.equal(rangeOfDays(2, new Date(2026, 0, 1)).from, '2025-12-31')
  })

  test('非法天数被夹到 1，不产生反向区间', () => {
    const range = rangeOfDays(0, new Date(2026, 10, 5))
    assert.equal(range.from, '2026-11-05')
  })

  test('日期补零，不出现 2026-1-5 这种写法', () => {
    const range = rangeOfDays(5, new Date(2026, 0, 5))
    assert.match(range.from, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(range.from, '2026-01-01')
  })
})
