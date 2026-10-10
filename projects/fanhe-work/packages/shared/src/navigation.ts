/**
 * 一级导航的唯一事实来源。
 *
 * 界面上的菜单、将来的路由表，以及「哪些角色能看到哪一项」都从这里派生。
 * 放在共享包而不是前端内部，是因为这份清单回答的是「权限点到界面」的映射，
 * 与 permissions.ts 的权限点清单是同一件事的两面：权限点决定「能做什么」，
 * 导航清单决定「能进哪里」。阶段二引入路由体系（T2-03）时，路由表由这份
 * 清单派生，不再另写一份 —— 两份定义迟早会不一致，而这类不一致只表现为
 * 「菜单里有、点进去 404」，排查方向会先落到路由配置上。
 *
 * 这里只放信息架构：编号、名称、可见性条件、规划说明。图标、样式与组件留在
 * 前端。分工与 permissions.ts 相同 —— 规则进共享包，表现留在应用内。
 */

import type { PermissionCode, PermissionModule } from './permissions.js'

/**
 * 导航项编号。
 *
 * 用短横线分隔的英文标识而不是序号：序号会在插入新项时全部错位，而编号要写进
 * 路由路径与将来的埋点，必须稳定。命名与实施方案第五章的一级导航表一一对应。
 */
export const NAV_CODES = {
  WORKBENCH: 'workbench',
  CUSTOMER: 'customer',
  OPS: 'ops',
  DASHBOARD: 'dashboard',
  SYSTEM_SETTINGS: 'system-settings',
} as const

export type NavCode = (typeof NAV_CODES)[keyof typeof NAV_CODES]

export type NavItem = {
  code: NavCode
  label: string
  /**
   * 可见性条件：持有该模块下的任意一个权限点即可见。
   *
   * 用模块而不是具体的权限点，是因为导航项的粒度就是模块。若绑一个具体权限点
   * （例如个人工作台绑 `personal.launch.read`），那么一个只被授予
   * `personal.note.read` 的角色将看不到个人工作台，尽管它确实拥有这个模块的
   * 权限。这种失效不会报错，只表现为「菜单少了一项」，排查时很容易被当成
   * 前端过滤写错。
   *
   * `null` 表示该项尚无权限点可绑，对所有已认证用户可见。当前只有三个占位项
   * 属于这种情况，理由见下方 `NAV_ITEMS` 的注释。
   */
  module: PermissionModule | null
  /**
   * 是否为占位项。占位项在界面上标注「功能开发中」，进入后显示规划范围。
   *
   * 与 `module` 正交，不要用 `module === null` 代替它：占位项将来定义了权限点
   * 后仍属占位，而可见性条件那时已经不再是 null。
   */
  planned: boolean
  /** 规划范围说明。占位项在内容区展示，让「预留占位」有明确的落位点。 */
  summary: string
}

/**
 * 一级导航五项。
 *
 * 顺序即界面顺序，与实施方案第五章的表格一致：个人工作台（本期开发），
 * 客户信息平台、运营信息平台、数据看板（占位），系统设置（占位，仅管理员可见）。
 *
 * **三个占位项的 `module` 为什么是 null。** 客户、运营、数据看板三段权限点
 * 目前不存在，它们的对象清单尚未确定（见 permissions.ts 顶部注释）。若在这里
 * 编造一个 `customer.read` 之类并不存在的权限点，判定结果对**所有**角色都是
 * 不可见，包括 owner —— 那等于把「预留占位」做成了「永远隐藏」，与实施方案
 * 「采用置灰加标签的方式」的意图相反。因此占位项暂时对所有已认证用户可见，
 * 等阶段三确定对象清单、追加权限点后，再把这里的 `module` 改成对应取值。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    code: NAV_CODES.WORKBENCH,
    label: '个人工作台',
    module: 'personal',
    planned: false,
    summary: '一键登录软件通道、工作纪要、事件记录三个板块。',
  },
  {
    code: NAV_CODES.CUSTOMER,
    label: '客户信息平台',
    module: null,
    planned: true,
    summary: '客户档案、跟进记录与信息检索。对象清单与权限点尚未确定。',
  },
  {
    code: NAV_CODES.OPS,
    label: '运营信息平台',
    module: null,
    planned: true,
    summary: '运营数据与流程管理。对象清单与权限点尚未确定。',
  },
  {
    code: NAV_CODES.DASHBOARD,
    label: '数据看板',
    module: null,
    planned: true,
    summary: '汇总指标与图表展示。数据来源依赖前两个平台，排在它们之后。',
  },
  {
    code: NAV_CODES.SYSTEM_SETTINGS,
    label: '系统设置',
    module: 'system',
    planned: true,
    summary: '账号、角色与审计日志管理。仅持有 system 段权限的账号可见。',
  },
]

/**
 * 判断一组权限点是否覆盖某个模块。
 *
 * **这是可见性判定，不是授权判定。** 两者必须分开：授权只看精确匹配的
 * `hasPermission`，且只能发生在服务端；这里只回答「要不要把入口画出来」。
 * 前端按此隐藏菜单，任何人改一个请求就能绕过，因此它的失效后果是「界面多画了
 * 一个入口」，而不是「越权」。
 *
 * 用前缀加分隔符匹配而不是裸 `startsWith(module)`：后者会让 `personal` 命中
 * `personalized.xxx`。权限点固定为三段式，加上 `.` 之后不存在误配的可能。
 */
export function canAccessModule(
  permissions: readonly PermissionCode[],
  module: PermissionModule,
): boolean {
  const prefix = `${module}.`
  return permissions.some((code) => code.startsWith(prefix))
}

/** 判断单个导航项对一组权限点是否可见。 */
export function canSeeNavItem(item: NavItem, permissions: readonly PermissionCode[]): boolean {
  if (item.module === null) return true
  return canAccessModule(permissions, item.module)
}

/**
 * 过滤出当前权限下可见的导航项。顺序保持 `NAV_ITEMS` 的定义顺序。
 *
 * 不返回「被隐藏的项」：调用方拿到隐藏清单的唯一用途是把它画出来，而那正是
 * 要避免的事。需要诊断可见范围时，比较可见项数与 `NAV_ITEMS.length` 即可。
 */
export function filterNavigation(permissions: readonly PermissionCode[]): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => canSeeNavItem(item, permissions))
}

/**
 * 解析应当激活的导航项，即前端这一侧的守卫。
 *
 * 三种情形在这里收敛成同一个结果：
 *
 *   1. 请求的项在可见清单里 —— 直接用它。
 *   2. 请求的项不在可见清单里 —— 回退到第一个可见项。发生的原因是权限在会话
 *      存续期间被改动（owner 调整了角色授权，前端重新拉了 `/me`），此时继续
 *      渲染原项的内容，界面会停在一个已经没有权限的模块上。
 *   3. 可见清单为空 —— 返回 null，由调用方渲染兜底界面。当前四个内置角色都
 *      至少持有 personal 段权限，走不到这一支，但判空不能省：返回 undefined
 *      会让调用方在解引用时才炸，而那时已经离原因很远了。
 *
 * `requested` 允许为 null，表示「还没有选过」，此时取第一项作为落地页。
 *
 * 这一层只承担体验职责。真正的访问控制在服务端的 `requirePermission`，绕过它
 * 只会让请求返回 403，不会拿到数据。
 */
export function resolveActiveNav(
  visible: readonly NavItem[],
  requested: NavCode | null,
): NavItem | null {
  const requestedItem = visible.find((item) => item.code === requested)
  if (requestedItem !== undefined) return requestedItem
  return visible[0] ?? null
}
