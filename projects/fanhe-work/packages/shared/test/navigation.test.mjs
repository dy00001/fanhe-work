/**
 * 导航可见范围的回归测试。
 *
 * 直接跑构建产物 dist，理由与 permissions.test.mjs 相同：前端拿到的就是 dist
 * 里那份清单，测源码等于测了一份没上线的代码。
 *
 * 存在的原因有两层。
 *
 * 第一层是**兑现一条欠账**。阶段一验收清单里的「四种角色登录后可见范围符合
 * 预期」一直没勾选，因为「可见范围」依赖前端按权限过滤菜单，而过滤这一步到
 * T1-11 才落地（见 DEVELOPMENT-PLAN 9.14 末段与 9.2 待办第 6 项）。本文件就是
 * 当时承诺补上的那条断言。
 *
 * 第二层是**这类错误不会自己暴露**。过滤写错的后果是某个角色的菜单里少一项
 * 或多一项：界面照常渲染、接口照常返回、控制台一声不吭。四个人里有一个人看不到
 * 该看到的入口，可能要等到他本人报上来才发现。把四种角色的结果逐个钉死，
 * 是唯一能在提交前拦住它的办法。
 *
 * 输入用 `ROLE_PERMISSIONS` 而不是手写的权限数组。它是种子阶段展开后真正写进
 * `role_permissions` 的那份结果，运行期 `/api/auth/me` 返回的权限与它同源。
 * 手写一份「角色应有的权限」等于把被测对象换成了测试自己的假设。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  NAV_CODES,
  NAV_ITEMS,
  ROLE_PERMISSIONS,
  canAccessModule,
  canSeeNavItem,
  filterNavigation,
  navCodeFromPath,
  navPath,
  resolveActiveNav,
} from '../dist/index.js'

const codesOf = (items) => items.map((item) => item.code)

/** 三个尚无权限点可绑的占位项。对已认证用户一律可见。 */
const PLACEHOLDER_CODES = [NAV_CODES.CUSTOMER, NAV_CODES.OPS, NAV_CODES.DASHBOARD]

/** 除系统设置外的四项。member 与 viewer 的可见范围就是它。 */
const WITHOUT_SYSTEM_SETTINGS = [NAV_CODES.WORKBENCH, ...PLACEHOLDER_CODES]

const ALL_CODES = [
  NAV_CODES.WORKBENCH,
  NAV_CODES.CUSTOMER,
  NAV_CODES.OPS,
  NAV_CODES.DASHBOARD,
  NAV_CODES.SYSTEM_SETTINGS,
]

test('导航清单为五项，编号唯一且顺序与实施方案第五章一致', () => {
  assert.equal(NAV_ITEMS.length, 5)
  assert.deepEqual(codesOf(NAV_ITEMS), ALL_CODES)
  assert.equal(new Set(ALL_CODES).size, 5)
})

test('owner 可见全部五项', () => {
  assert.deepEqual(codesOf(filterNavigation(ROLE_PERMISSIONS.owner)), ALL_CODES)
})

test('admin 可见全部五项：有 personal 全权，也有 system.user.read', () => {
  assert.deepEqual(codesOf(filterNavigation(ROLE_PERMISSIONS.admin)), ALL_CODES)
})

test('member 看不到系统设置，其余四项可见', () => {
  const visible = codesOf(filterNavigation(ROLE_PERMISSIONS.member))
  assert.deepEqual(visible, WITHOUT_SYSTEM_SETTINGS)
  assert.ok(!visible.includes(NAV_CODES.SYSTEM_SETTINGS))
})

test('viewer 看不到系统设置，其余四项可见', () => {
  const visible = codesOf(filterNavigation(ROLE_PERMISSIONS.viewer))
  assert.deepEqual(visible, WITHOUT_SYSTEM_SETTINGS)
  assert.ok(!visible.includes(NAV_CODES.SYSTEM_SETTINGS))
})

test('个人工作台对四种角色都可见', () => {
  for (const role of ['owner', 'admin', 'member', 'viewer']) {
    const visible = codesOf(filterNavigation(ROLE_PERMISSIONS[role]))
    assert.ok(
      visible.includes(NAV_CODES.WORKBENCH),
      `${role} 应当能看到个人工作台，实际可见 ${visible.join(', ')}`,
    )
  }
})

test('尚无权限点可绑的三个占位项对已认证用户一律可见', () => {
  for (const role of ['owner', 'admin', 'member', 'viewer']) {
    const visible = codesOf(filterNavigation(ROLE_PERMISSIONS[role]))
    for (const code of PLACEHOLDER_CODES) {
      assert.ok(visible.includes(code), `${role} 应当能看到占位项 ${code}`)
    }
  }
})

test('没有权限点时只剩不设门槛的占位项', () => {
  // 当前四个内置角色都持有 personal 段权限，走不到这一支；断言它存在，是为了
  // 钉住「module 为 null 即不设门槛」这条规则本身。
  assert.deepEqual(codesOf(filterNavigation([])), PLACEHOLDER_CODES)
})

test('模块判定按 `模块.` 前缀匹配，不误伤同前缀的其它模块', () => {
  assert.equal(canAccessModule(ROLE_PERMISSIONS.member, 'personal'), true)
  assert.equal(canAccessModule(ROLE_PERMISSIONS.member, 'system'), false)
  // viewer 只有读权限，但仍然算「持有 personal 段权限」。
  assert.equal(canAccessModule(ROLE_PERMISSIONS.viewer, 'personal'), true)
})

test('canSeeNavItem 对不设门槛的项直接返回 true', () => {
  const customer = NAV_ITEMS.find((item) => item.code === NAV_CODES.CUSTOMER)
  assert.ok(customer)
  assert.equal(customer.module, null)
  assert.equal(canSeeNavItem(customer, []), true)
})

test('激活项解析：请求的是可见项时就用它', () => {
  const visible = filterNavigation(ROLE_PERMISSIONS.member)
  const active = resolveActiveNav(visible, NAV_CODES.DASHBOARD)
  assert.equal(active?.code, NAV_CODES.DASHBOARD)
})

test('激活项解析：请求的是不可见项时回退到第一项', () => {
  // 守卫的核心。模拟「会话存续期间权限被收紧」：owner 把当前账号改成 member，
  // 前端重新拉了 /me，此时原本选中的系统设置已经不在可见清单里。
  const visible = filterNavigation(ROLE_PERMISSIONS.member)
  const active = resolveActiveNav(visible, NAV_CODES.SYSTEM_SETTINGS)
  assert.equal(active?.code, NAV_CODES.WORKBENCH)
})

test('激活项解析：尚未选择时取第一项作为落地页', () => {
  const visible = filterNavigation(ROLE_PERMISSIONS.viewer)
  assert.equal(resolveActiveNav(visible, null)?.code, NAV_CODES.WORKBENCH)
})

test('激活项解析：可见清单为空时返回 null，交给调用方兜底', () => {
  assert.equal(resolveActiveNav([], NAV_CODES.WORKBENCH), null)
})

test('路由路径由编号派生，五项与清单一一对应', () => {
  assert.deepEqual(
    NAV_ITEMS.map((item) => navPath(item.code)),
    ['/workbench', '/customer', '/ops', '/dashboard', '/system-settings'],
  )
})

test('路径解析：首段命中编号时返回它，更深的段被忽略', () => {
  assert.equal(navCodeFromPath('/workbench'), NAV_CODES.WORKBENCH)
  assert.equal(navCodeFromPath('/workbench/notes'), NAV_CODES.WORKBENCH)
  assert.equal(navCodeFromPath('/system-settings/users/1'), NAV_CODES.SYSTEM_SETTINGS)
})

test('路径解析：不认识的路径与空路径都返回 null，不擅自兜底', () => {
  assert.equal(navCodeFromPath('/'), null)
  assert.equal(navCodeFromPath(''), null)
  assert.equal(navCodeFromPath('/nonsense'), null)
  // 只认整段相等，`workbenchX` 不能命中 `workbench`。
  assert.equal(navCodeFromPath('/workbenchX'), null)
})

test('navPath 与 navCodeFromPath 互为逆运算', () => {
  for (const item of NAV_ITEMS) {
    assert.equal(navCodeFromPath(navPath(item.code)), item.code)
  }
})
