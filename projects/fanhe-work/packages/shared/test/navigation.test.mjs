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
 *
 * UI 二次改造后（与原型对齐）清单为十八项，并引入三条新约定，本文件把它们钉住：
 * 分组头不再可路由、子项路径是两层的、预留槽位是有编号的真项。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  NAV_CODES,
  NAV_FOOTER_CODES,
  PERMISSIONS,
  NAV_GROUPS,
  NAV_ITEMS,
  ROLE_PERMISSIONS,
  buildNavSections,
  canAccessModule,
  canSeeNavItem,
  filterNavigation,
  navCodeFromPath,
  navPath,
  resolveActiveNav,
} from '../dist/index.js'

const codesOf = (items) => items.map((item) => item.code)

/** 清单里全部十八项，顺序与 `NAV_ITEMS` 的定义一致。 */
const ALL_CODES = [
  NAV_CODES.WORKBENCH,
  NAV_CODES.ASSETS,
  NAV_CODES.SEARCH,
  NAV_CODES.CUSTOMER_OVERVIEW,
  NAV_CODES.CUSTOMER_PROGRESS,
  NAV_CODES.CUSTOMER_SLOT_1,
  NAV_CODES.CUSTOMER_SLOT_2,
  NAV_CODES.DASHBOARD,
  NAV_CODES.OPS_SLOT_1,
  NAV_CODES.OPS_SLOT_2,
  NAV_CODES.OPS_SLOT_3,
  NAV_CODES.DESIGN_SLOT_1,
  NAV_CODES.DESIGN_SLOT_2,
  NAV_CODES.DESIGN_SLOT_3,
  NAV_CODES.OTHERS_SLOT_1,
  NAV_CODES.OTHERS_SLOT_2,
  NAV_CODES.OTHERS_SLOT_3,
  NAV_CODES.SYSTEM_SETTINGS,
]

/** 清单里每一项的路径，顺序与 `NAV_ITEMS` 一致。层级由 group + slug 拼出。 */
const ALL_PATHS = [
  '/workbench',
  '/assets',
  '/search',
  '/customer/overview',
  '/customer/progress',
  '/customer/slot-1',
  '/customer/slot-2',
  '/ops/dashboard',
  '/ops/slot-1',
  '/ops/slot-2',
  '/ops/slot-3',
  '/design/slot-1',
  '/design/slot-2',
  '/design/slot-3',
  '/others/slot-1',
  '/others/slot-2',
  '/others/slot-3',
  '/system-settings',
]

/**
 * 不设权限门槛的十五项（`module === null`），对已认证用户一律可见。
 *
 * 清单里有三项带门槛：首页绑 `personal`、系统设置绑 `system`、数据看板绑 `ops`
 * （2026-10-20 接入千牛运营数据后从占位项转正，店铺金额不再对全体成员开放）。
 */
const UNGATED_CODES = ALL_CODES.filter(
  (code) =>
    code !== NAV_CODES.WORKBENCH &&
    code !== NAV_CODES.SYSTEM_SETTINGS &&
    code !== NAV_CODES.DASHBOARD,
)

/** 除系统设置与数据看板外的十六项。member 与 viewer 的可见范围就是它。 */
const WITHOUT_SYSTEM_SETTINGS = ALL_CODES.filter(
  (code) => code !== NAV_CODES.SYSTEM_SETTINGS && code !== NAV_CODES.DASHBOARD,
)

test('导航清单为十八项，编号唯一且顺序稳定', () => {
  assert.equal(NAV_ITEMS.length, 18)
  assert.deepEqual(codesOf(NAV_ITEMS), ALL_CODES)
  assert.equal(new Set(ALL_CODES).size, 18)
})

test('owner 可见全部十八项', () => {
  assert.deepEqual(codesOf(filterNavigation(ROLE_PERMISSIONS.owner)), ALL_CODES)
})

test('admin 可见全部十八项：有 personal 全权，也有 system.user.read', () => {
  assert.deepEqual(codesOf(filterNavigation(ROLE_PERMISSIONS.admin)), ALL_CODES)
})

test('member 看不到系统设置与数据看板，其余十六项可见', () => {
  const visible = codesOf(filterNavigation(ROLE_PERMISSIONS.member))
  assert.deepEqual(visible, WITHOUT_SYSTEM_SETTINGS)
  assert.ok(!visible.includes(NAV_CODES.SYSTEM_SETTINGS))
  // 运营数据默认对成员不可见：店铺 GMV 与客单价属于经营机密。
  assert.ok(!visible.includes(NAV_CODES.DASHBOARD))
})

test('viewer 看不到系统设置与数据看板，其余十六项可见', () => {
  const visible = codesOf(filterNavigation(ROLE_PERMISSIONS.viewer))
  assert.deepEqual(visible, WITHOUT_SYSTEM_SETTINGS)
  assert.ok(!visible.includes(NAV_CODES.SYSTEM_SETTINGS))
  assert.ok(!visible.includes(NAV_CODES.DASHBOARD))
})

test('单独授予 ops.shop.read 后成员能看到数据看板', () => {
  // 这是本模块的核心用法：不给角色，给账号。断言权限点与导航项的绑定真的生效，
  // 否则「导航项绑了 module」这件事只是注释里的一句话。
  const granted = [...ROLE_PERMISSIONS.member, PERMISSIONS.OPS_SHOP_READ]
  assert.ok(codesOf(filterNavigation(granted)).includes(NAV_CODES.DASHBOARD))
})

test('首页对四种角色都可见', () => {
  for (const role of ['owner', 'admin', 'member', 'viewer']) {
    const visible = codesOf(filterNavigation(ROLE_PERMISSIONS[role]))
    assert.ok(
      visible.includes(NAV_CODES.WORKBENCH),
      `${role} 应当能看到首页，实际可见 ${visible.join(', ')}`,
    )
  }
})

test('尚无权限点可绑的十五项对已认证用户一律可见', () => {
  for (const role of ['owner', 'admin', 'member', 'viewer']) {
    const visible = codesOf(filterNavigation(ROLE_PERMISSIONS[role]))
    for (const code of UNGATED_CODES) {
      assert.ok(visible.includes(code), `${role} 应当能看到占位项 ${code}`)
    }
  }
})

test('没有权限点时只剩不设门槛的十五项', () => {
  // 当前四个内置角色都持有 personal 段权限，走不到这一支；断言它存在，是为了
  // 钉住「module 为 null 即不设门槛」这条规则本身。
  assert.deepEqual(codesOf(filterNavigation([])), UNGATED_CODES)
})

test('模块判定按 `模块.` 前缀匹配，不误伤同前缀的其它模块', () => {
  assert.equal(canAccessModule(ROLE_PERMISSIONS.member, 'personal'), true)
  assert.equal(canAccessModule(ROLE_PERMISSIONS.member, 'system'), false)
  // viewer 只有读权限，但仍然算「持有 personal 段权限」。
  assert.equal(canAccessModule(ROLE_PERMISSIONS.viewer, 'personal'), true)
})

test('canSeeNavItem 对不设门槛的项直接返回 true', () => {
  const overview = NAV_ITEMS.find((item) => item.code === NAV_CODES.CUSTOMER_OVERVIEW)
  assert.ok(overview)
  assert.equal(overview.module, null)
  assert.equal(canSeeNavItem(overview, []), true)
})

test('激活项解析：请求的是可见项时就用它', () => {
  const visible = filterNavigation(ROLE_PERMISSIONS.member)
  const active = resolveActiveNav(visible, NAV_CODES.CUSTOMER_OVERVIEW)
  assert.equal(active?.code, NAV_CODES.CUSTOMER_OVERVIEW)
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

test('路由路径由 group + slug 派生，顶层单段、子项两段', () => {
  assert.deepEqual(
    NAV_ITEMS.map((item) => navPath(item.code)),
    ALL_PATHS,
  )
})

test('顶层项的路径段与编号一致，子项的路径以分组段开头', () => {
  for (const item of NAV_ITEMS) {
    if (item.group === null) {
      assert.equal(navPath(item.code), `/${item.code}`, `顶层项 ${item.code} 的路径段应与编号一致`)
    } else {
      assert.ok(
        navPath(item.code).startsWith(`/${item.group}/`),
        `子项 ${item.code} 的路径应以 /${item.group}/ 开头，实际 ${navPath(item.code)}`,
      )
    }
  }
})

test('路径解析：整段命中导航项时返回它', () => {
  assert.equal(navCodeFromPath('/workbench'), NAV_CODES.WORKBENCH)
  assert.equal(navCodeFromPath('/customer/overview'), NAV_CODES.CUSTOMER_OVERVIEW)
  assert.equal(navCodeFromPath('/ops/dashboard'), NAV_CODES.DASHBOARD)
  assert.equal(navCodeFromPath('/system-settings'), NAV_CODES.SYSTEM_SETTINGS)
})

test('路径解析：模块内部更深的一层按前缀命中', () => {
  assert.equal(navCodeFromPath('/workbench/notes'), NAV_CODES.WORKBENCH)
  assert.equal(navCodeFromPath('/workbench/events/2026'), NAV_CODES.WORKBENCH)
  assert.equal(navCodeFromPath('/system-settings/users/1'), NAV_CODES.SYSTEM_SETTINGS)
})

test('路径解析：末尾斜杠归一，带不带都解析成同一项', () => {
  assert.equal(navCodeFromPath('/ops/dashboard/'), NAV_CODES.DASHBOARD)
  assert.equal(navCodeFromPath('/workbench/notes/'), NAV_CODES.WORKBENCH)
})

test('路径解析：分组段单独出现时不命中任何项（分组头不可路由）', () => {
  // 分组编号 `customer` / `ops` / `design` / `others` 不再是导航项编号，
  // 直接输入 `/customer` 应落到 404，而不是悄悄进到某个子项。
  assert.equal(navCodeFromPath('/customer'), null)
  assert.equal(navCodeFromPath('/ops'), null)
  assert.equal(navCodeFromPath('/design'), null)
  assert.equal(navCodeFromPath('/others'), null)
})

test('路径解析：不认识的路径与空路径都返回 null，不擅自兜底', () => {
  assert.equal(navCodeFromPath('/'), null)
  assert.equal(navCodeFromPath(''), null)
  assert.equal(navCodeFromPath('/nonsense'), null)
  // 前缀匹配要带分隔符，`workbenchX` 不能命中 `workbench`。
  assert.equal(navCodeFromPath('/workbenchX'), null)
})

test('navPath 与 navCodeFromPath 互为逆运算', () => {
  for (const item of NAV_ITEMS) {
    assert.equal(navCodeFromPath(navPath(item.code)), item.code)
  }
})

test('分组清单为四项，编号唯一', () => {
  const codes = NAV_GROUPS.map((group) => group.code)
  assert.equal(codes.length, 4)
  assert.equal(new Set(codes).size, 4)
})

test('分组编号不与任何导航项编号重合（分组头不可路由）', () => {
  const navCodeSet = new Set(ALL_CODES)
  for (const group of NAV_GROUPS) {
    assert.ok(
      !navCodeSet.has(group.code),
      `分组编号 ${group.code} 不应同时是导航项编号 —— 分组头是纯折叠开关，没有页面`,
    )
  }
})

test('顶层项 group 为 null；子项的 group 必须指向一个真实存在的分组', () => {
  const groupCodes = new Set(NAV_GROUPS.map((group) => group.code))
  for (const item of NAV_ITEMS) {
    if (item.group === null) continue
    assert.ok(groupCodes.has(item.group), `${item.code} 的 group=${item.group} 不存在`)
  }
  // 顶层项（含系统设置）共四项。
  assert.equal(NAV_ITEMS.filter((item) => item.group === null).length, 4)
})

test('预留槽位共十一项，每组数量与原型一致', () => {
  const slots = NAV_ITEMS.filter((item) => item.slot)
  assert.equal(slots.length, 11)
  const perGroup = (group) => slots.filter((item) => item.group === group).length
  assert.equal(perGroup('customer'), 2)
  assert.equal(perGroup('ops'), 3)
  assert.equal(perGroup('design'), 3)
  assert.equal(perGroup('others'), 3)
  for (const slot of slots) {
    assert.equal(slot.summary, '该子项尚未定义。')
    assert.equal(slot.planned, true)
    assert.equal(slot.module, null)
  }
})

test('底部图标行只有系统设置一项，且它不出现在主列表里', () => {
  assert.deepEqual(NAV_FOOTER_CODES, [NAV_CODES.SYSTEM_SETTINGS])
  const sections = buildNavSections(NAV_ITEMS)
  const flat = sections.flatMap((section) =>
    section.kind === 'item' ? [section.item.code] : section.items.map((item) => item.code),
  )
  assert.ok(!flat.includes(NAV_CODES.SYSTEM_SETTINGS))
})

test('buildNavSections 把顶层项与分组收成两段，顺序与原型一致', () => {
  const sections = buildNavSections(NAV_ITEMS)
  // 顶层三项 + 四个分组 = 七段。
  assert.equal(sections.length, 7)
  assert.deepEqual(
    sections.map((section) => (section.kind === 'group' ? section.group.code : section.item.code)),
    [
      NAV_CODES.WORKBENCH,
      NAV_CODES.ASSETS,
      NAV_CODES.SEARCH,
      'customer',
      'ops',
      'design',
      'others',
    ],
  )
})

test('每个分组的子项与顺序与原型一致', () => {
  const sections = buildNavSections(NAV_ITEMS)
  const groupItems = (code) => {
    const section = sections.find((entry) => entry.kind === 'group' && entry.group.code === code)
    assert.ok(section && section.kind === 'group', `缺少分组 ${code}`)
    return codesOf(section.items)
  }

  assert.deepEqual(groupItems('customer'), [
    NAV_CODES.CUSTOMER_OVERVIEW,
    NAV_CODES.CUSTOMER_PROGRESS,
    NAV_CODES.CUSTOMER_SLOT_1,
    NAV_CODES.CUSTOMER_SLOT_2,
  ])
  assert.deepEqual(groupItems('ops'), [
    NAV_CODES.DASHBOARD,
    NAV_CODES.OPS_SLOT_1,
    NAV_CODES.OPS_SLOT_2,
    NAV_CODES.OPS_SLOT_3,
  ])
  assert.deepEqual(groupItems('design'), [
    NAV_CODES.DESIGN_SLOT_1,
    NAV_CODES.DESIGN_SLOT_2,
    NAV_CODES.DESIGN_SLOT_3,
  ])
  assert.deepEqual(groupItems('others'), [
    NAV_CODES.OTHERS_SLOT_1,
    NAV_CODES.OTHERS_SLOT_2,
    NAV_CODES.OTHERS_SLOT_3,
  ])
})

test('分组清单决定分组顺序，不随子项在 NAV_ITEMS 里的位置漂移', () => {
  // 把「其他」的子项整体挪到最前，分组顺序仍应按 NAV_GROUPS 排列。
  const reordered = [
    ...NAV_ITEMS.filter((item) => item.group === 'others'),
    ...NAV_ITEMS.filter((item) => item.group !== 'others'),
  ]
  const sections = buildNavSections(reordered)
  assert.deepEqual(
    sections.filter((section) => section.kind === 'group').map((section) => section.group.code),
    ['customer', 'ops', 'design', 'others'],
  )
})

test('buildNavSections 丢弃子项被权限过滤光的空分组', () => {
  // 分组头不可路由，一个空分组点了只会展开一片空白，因此整组不渲染。
  const visible = NAV_ITEMS.filter((item) => item.group !== 'design')
  const sections = buildNavSections(visible)
  assert.ok(
    !sections.some((section) => section.kind === 'group' && section.group.code === 'design'),
    '设计信息平台的子项全被过滤后，该分组不应出现在侧栏里',
  )
})

test('member 的可见清单聚合后仍有四个分组（槽位不设门槛）', () => {
  const sections = buildNavSections(filterNavigation(ROLE_PERMISSIONS.member))
  assert.equal(sections.filter((section) => section.kind === 'group').length, 4)
  assert.equal(sections.filter((section) => section.kind === 'item').length, 3)
})
