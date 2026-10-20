/**
 * 一级导航的唯一事实来源。
 *
 * 界面上的菜单、路由表，以及「哪些角色能看到哪一项」都从这里派生。
 * 放在共享包而不是前端内部，是因为这份清单回答的是「权限点到界面」的映射，
 * 与 permissions.ts 的权限点清单是同一件事的两面：权限点决定「能做什么」，
 * 导航清单决定「能进哪里」。阶段二引入路由体系（T2-03）时，路由表由这份
 * 清单派生，不再另写一份 —— 两份定义迟早会不一致，而这类不一致只表现为
 * 「菜单里有、点进去 404」，排查方向会先落到路由配置上。
 *
 * 这里只放信息架构：编号、名称、路径段、可见性条件、规划说明。图标、样式与
 * 组件留在前端。分工与 permissions.ts 相同 —— 规则进共享包，表现留在应用内。
 *
 * ## 与原型对齐后的结构（2026-10-11 二次改造）
 *
 * 侧栏由三部分组成，与 `UI合并方案/梵禾Work-首页改造预览.html` 逐条对齐：
 *
 *   1. 顶层项：首页 / 资产 / 搜索；
 *   2. 四个分组：客户信息平台 / 运维信息平台 / 设计信息平台 / 其他，
 *      每个分组头是**纯折叠开关**（原型里就是 `<button>`，没有 href）；
 *   3. 底部图标行：外观三档 + 系统设置 + 通知（系统设置由 `NAV_FOOTER_CODES` 标出）。
 *
 * 三处关键约定，改动前请先读这里：
 *
 *   - **分组头不再可路由。** 上一版为了让每个分组头有个落点，给它们各保留了一个
 *     同名占位页（`/customer` 等），于是 `customer` / `ops` / `design` / `others`
 *     同时出现在 `NAV_CODES` 与 `NAV_GROUP_CODES` 里。原型里分组头是纯折叠按钮，
 *     这次按原型收敛：四个编号**只**留在 `NAV_GROUP_CODES`，不再有同名导航项。
 *   - **子项路径是两层的。** 子项的路径由 `分组段/路径段` 拼成，例如数据看板是
 *     `/ops/dashboard`（上一版是 `/dashboard`）。顶层项的路径仍是单段。
 *   - **预留槽位是真项，不是装饰。** 原型里每组尾部那几行「功能开发中 N」是可以点
 *     的，点了进统一占位页。因此它们**有编号、有路由**，只是 `slot` 为真，让侧栏
 *     用虚线图标与弱化文字把它们与具名项区分开。
 */

import type { PermissionCode, PermissionModule } from './permissions.js'

/**
 * 导航项编号。
 *
 * 用短横线分隔的英文标识而不是序号：序号会在插入新项时全部错位，而编号要写进
 * 路由路径与将来的埋点，必须稳定。命名与实施方案第五章的一级导航表一一对应。
 *
 * **编号不是路径段。** 路径由 `slug` 与 `group` 拼出（见 `navPath`），两者分开是
 * 为了「改地址不改身份」：`code` 是埋点与权限关联用的稳定标识，`slug` 只是 URL 的
 * 一段。上一版把二者混为一谈，代价是「数据看板」从一级降为子项时，地址与标识只能
 * 一起改。
 */
export const NAV_CODES = {
  /** 首页。原「个人工作台」，路由段保持 `workbench` 不变，只改文案。 */
  WORKBENCH: 'workbench',
  /** 资产。新增的一级占位入口。 */
  ASSETS: 'assets',
  /** 搜索。新增的一级占位入口，检索能力待后续阶段。 */
  SEARCH: 'search',
  /** 综合看板。客户信息平台分组的子项。 */
  CUSTOMER_OVERVIEW: 'customer-overview',
  /** 客户进度。客户信息平台分组的子项。 */
  CUSTOMER_PROGRESS: 'customer-progress',
  /** 数据看板。运维信息平台分组的子项。 */
  DASHBOARD: 'dashboard',
  /** 系统设置。不落在主列表里，由 `NAV_FOOTER_CODES` 指到侧栏底部图标行。 */
  SYSTEM_SETTINGS: 'system-settings',

  // ---- 预留槽位。原型每组尾部的「功能开发中 N」，可点击，落到统一占位页。 ----
  /** 客户信息平台的预留槽位 1。 */
  CUSTOMER_SLOT_1: 'customer-slot-1',
  /** 客户信息平台的预留槽位 2。 */
  CUSTOMER_SLOT_2: 'customer-slot-2',
  /** 运维信息平台的预留槽位 1。 */
  OPS_SLOT_1: 'ops-slot-1',
  /** 运维信息平台的预留槽位 2。 */
  OPS_SLOT_2: 'ops-slot-2',
  /** 运维信息平台的预留槽位 3。 */
  OPS_SLOT_3: 'ops-slot-3',
  /** 设计信息平台的预留槽位 1。 */
  DESIGN_SLOT_1: 'design-slot-1',
  /** 设计信息平台的预留槽位 2。 */
  DESIGN_SLOT_2: 'design-slot-2',
  /** 设计信息平台的预留槽位 3。 */
  DESIGN_SLOT_3: 'design-slot-3',
  /** 「其他」分组的预留槽位 1。 */
  OTHERS_SLOT_1: 'others-slot-1',
  /** 「其他」分组的预留槽位 2。 */
  OTHERS_SLOT_2: 'others-slot-2',
  /** 「其他」分组的预留槽位 3。 */
  OTHERS_SLOT_3: 'others-slot-3',
} as const

export type NavCode = (typeof NAV_CODES)[keyof typeof NAV_CODES]

/**
 * 分组编号。
 *
 * 与 `NavCode` 完全分开：分组本身回答的是「侧栏里这一段叫什么」，它**不承担路由
 * 职责**。原型里分组头是纯折叠按钮，点了只展开/收起，不改地址。因此这里没有任何
 * 一个编号同时出现在两份清单里 —— 上一版因为给分组头保留了占位页，`customer` 等
 * 四个编号在两边各出现一次，读代码时很难说清某个 `'customer'` 到底指哪一份。
 */
export const NAV_GROUP_CODES = {
  CUSTOMER: 'customer',
  OPS: 'ops',
  DESIGN: 'design',
  OTHERS: 'others',
} as const

export type NavGroupCode = (typeof NAV_GROUP_CODES)[keyof typeof NAV_GROUP_CODES]

/**
 * 侧栏分组。
 *
 * 只有编号与名称，**没有 summary**：分组头不可路由，也就没有「规划范围」可展示。
 * 将来某个分组真的要有落地页，做法是给它加一个导航项（`group` 仍为 `null`），
 * 而不是往这里加字段 —— 那样分组就又会变成半路由的中间态。
 */
export type NavGroup = {
  code: NavGroupCode
  label: string
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { code: NAV_GROUP_CODES.CUSTOMER, label: '客户信息平台' },
  { code: NAV_GROUP_CODES.OPS, label: '运维信息平台' },
  { code: NAV_GROUP_CODES.DESIGN, label: '设计信息平台' },
  { code: NAV_GROUP_CODES.OTHERS, label: '其他' },
]

export type NavItem = {
  code: NavCode
  label: string
  /**
   * URL 路径段。与 `group` 一起由 `navPath` 拼成完整路径。
   *
   * 顶层项（`group === null`）的路径是 `/${slug}`，子项是 `/${group}/${slug}`。
   * 之所以不直接用 `code` 当路径段：`code` 是身份，`slug` 是地址，两者的变更理由
   * 完全不同。首页的 `code` 至今仍是 `workbench`（埋点与旧地址都认它），而它显示的
   * 名称早就改成了「首页」—— 如果把两者绑死，这种「只改展示不改地址」就做不到了。
   */
  slug: string
  /**
   * 所属分组。`null` 表示它直接位于侧栏顶层。
   *
   * 分组只影响侧栏的呈现，不影响路由与权限：`NAV_ITEMS` 始终是扁平且可路由的
   * 清单，路由表按它逐个生成，因此新增或调整分组时 `routes.tsx` 一行都不用改。
   * 这条设计正是为了避免「分组」把路由表也一起搅进去。
   */
  group: NavGroupCode | null
  /**
   * 可见性条件：持有该模块下的任意一个权限点即可见。
   *
   * 用模块而不是具体的权限点，是因为导航项的粒度就是模块。若绑一个具体权限点
   * （例如首页绑 `personal.launch.read`），那么一个只被授予 `personal.note.read`
   * 的角色将看不到首页，尽管它确实拥有这个模块的权限。这种失效不会报错，只表现为
   * 「菜单少了一项」，排查时很容易被当成前端过滤写错。
   *
   * `null` 表示该项尚无权限点可绑，对所有已认证用户可见。当前除首页（`personal`）
   * 与系统设置（`system`）外，其余项都是这种情况，理由见下方 `NAV_ITEMS` 的注释。
   */
  module: PermissionModule | null
  /**
   * 是否为占位项。占位项在界面上标注「功能开发中」，进入后显示规划范围。
   *
   * 与 `module` 正交，不要用 `module === null` 代替它：占位项将来定义了权限点
   * 后仍属占位，而可见性条件那时已经不再是 null。
   */
  planned: boolean
  /**
   * 是否为**预留槽位**（原型里那几行「功能开发中 N」）。
   *
   * 与 `planned` 正交，虽然当前槽位项的 `planned` 也都为真。两者的区别在渲染：
   * 具名占位项（资产、搜索、综合看板…）用各自的图标、名称后面跟一个「开发中」标签；
   * 槽位项没有名字，用虚线图标与弱化文字，且**不带**标签 —— 名称本身就是「功能开发中
   * N」，再加一个「开发中」是重复。原型对这两种用了不同的视觉（`.sub.ghost` 与
   * `.tag`），这个字段就是把那个区别带到数据层。
   */
  slot: boolean
  /** 规划范围说明。占位项在内容区展示，让「预留占位」有明确的落位点。 */
  summary: string
}

/**
 * 侧栏底部图标行里的导航项编号。
 *
 * 系统设置是 owner / admin 目前唯一的管理入口，但原型的主列表里没有它 —— 编号文档
 * 的 11 条并未覆盖到它。裁决结果是放进侧栏底部图标行（编号 7 那一行），因此它
 * **仍是可路由的导航项**（有编号、有页面、有权限门槛），只是渲染位置不在主列表里。
 *
 * 用清单而不是给 `NavItem` 加一个 `footer: boolean` 字段：这是「渲染在哪儿」的
 * 表现层决策，与项本身的信息架构无关，放进 `NavItem` 会让每个项都多一个几乎总是
 * `false` 的字段。
 */
export const NAV_FOOTER_CODES: readonly NavCode[] = [NAV_CODES.SYSTEM_SETTINGS]

/**
 * 导航清单。**扁平、可路由**，顺序即侧栏从上到下的顺序（分组内亦然）。
 *
 * 结构分三层：`group` 为 `null` 且不在 `NAV_FOOTER_CODES` 里的项落在主列表顶层；
 * `group` 指向某个分组的项由侧栏渲染到该分组之下；系统设置落在底部图标行。
 *
 * **占位项的 `module` 为什么是 null。** 客户、运维、设计三段权限点目前不存在，
 * 它们的对象清单尚未确定（见 permissions.ts 顶部注释）。若在这里编造一个
 * `customer.read` 之类并不存在的权限点，判定结果对**所有**角色都是不可见，包括
 * owner，那等于把「预留占位」做成了「永远隐藏」，与实施方案「采用置灰加标签的
 * 方式」的意图相反。因此占位项暂时对所有已认证用户可见，等对象清单确定、追加
 * 权限点后，再把这里的 `module` 改成对应取值。
 *
 * 这条路径已经走过一次：运维信息平台下的「数据看板」（`dashboard`）在接入千牛
 * 运营数据时补了 `ops` 段的三个权限点，于是 `module` 从 null 改成 `ops`、
 * `planned` 置为 false。后续任一占位项落地照此办理即可，改动只涉及本文件与
 * `permissions.ts` 两处。
 */
export const NAV_ITEMS: readonly NavItem[] = [
  {
    code: NAV_CODES.WORKBENCH,
    label: '首页',
    slug: 'workbench',
    group: null,
    module: 'personal',
    planned: false,
    slot: false,
    summary: '案例展示、一键启动、工作纪要及事件记录三个板块。',
  },
  {
    code: NAV_CODES.ASSETS,
    label: '资产',
    slug: 'assets',
    group: null,
    module: null,
    planned: true,
    slot: false,
    summary: '客户资产、方案文件与素材库的统一入口。对象清单与权限点尚未确定。',
  },
  {
    code: NAV_CODES.SEARCH,
    label: '搜索',
    slug: 'search',
    group: null,
    module: null,
    planned: true,
    slot: false,
    summary: '跨纪要、事件与客户档案的全局检索。依赖前三段数据落库，排在其后。',
  },

  // ---- 分组一：客户信息平台。两个具名子项 + 两个预留槽位（原型编号 3）。 ----
  {
    code: NAV_CODES.CUSTOMER_OVERVIEW,
    label: '综合看板',
    slug: 'overview',
    group: NAV_GROUP_CODES.CUSTOMER,
    module: null,
    planned: true,
    slot: false,
    summary: '客户总量、跟进状态与近期活动的汇总视图。数据来源为下方客户进度记录。',
  },
  {
    code: NAV_CODES.CUSTOMER_PROGRESS,
    label: '客户进度',
    slug: 'progress',
    group: NAV_GROUP_CODES.CUSTOMER,
    module: null,
    planned: true,
    slot: false,
    summary: '按客户记录方案进度：初测、复尺、出图、报价、确认、下单、安装。',
  },
  {
    code: NAV_CODES.CUSTOMER_SLOT_1,
    label: '功能开发中 1',
    slug: 'slot-1',
    group: NAV_GROUP_CODES.CUSTOMER,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },
  {
    code: NAV_CODES.CUSTOMER_SLOT_2,
    label: '功能开发中 2',
    slug: 'slot-2',
    group: NAV_GROUP_CODES.CUSTOMER,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },

  // ---- 分组二：运维信息平台。一个具名子项 + 三个预留槽位（原型编号 4）。 ----
  {
    code: NAV_CODES.DASHBOARD,
    label: '数据看板',
    slug: 'dashboard',
    group: NAV_GROUP_CODES.OPS,
    // 绑定 ops 模块。这是本项与其余占位项的唯一区别：它现在有真实的权限点了，
    // 于是 member / viewer 默认看不到 —— 店铺金额属于经营机密，不该按「占位项
    // 对所有登录用户可见」那条临时规则放行。
    module: 'ops',
    // 2026-10-20 接入千牛运营数据后置为 false。路由分派在 routes.tsx 的 ModuleRoute 里。
    planned: false,
    slot: false,
    summary: '千牛 / 生意参谋口径的店铺经营数据：成交与流量趋势、商品结构、渠道分解与数据新鲜度。',
  },
  {
    code: NAV_CODES.OPS_SLOT_1,
    label: '功能开发中 1',
    slug: 'slot-1',
    group: NAV_GROUP_CODES.OPS,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },
  {
    code: NAV_CODES.OPS_SLOT_2,
    label: '功能开发中 2',
    slug: 'slot-2',
    group: NAV_GROUP_CODES.OPS,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },
  {
    code: NAV_CODES.OPS_SLOT_3,
    label: '功能开发中 3',
    slug: 'slot-3',
    group: NAV_GROUP_CODES.OPS,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },

  // ---- 分组三：设计信息平台。三个预留槽位（原型编号 5）。 ----
  {
    code: NAV_CODES.DESIGN_SLOT_1,
    label: '功能开发中 1',
    slug: 'slot-1',
    group: NAV_GROUP_CODES.DESIGN,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },
  {
    code: NAV_CODES.DESIGN_SLOT_2,
    label: '功能开发中 2',
    slug: 'slot-2',
    group: NAV_GROUP_CODES.DESIGN,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },
  {
    code: NAV_CODES.DESIGN_SLOT_3,
    label: '功能开发中 3',
    slug: 'slot-3',
    group: NAV_GROUP_CODES.DESIGN,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },

  // ---- 分组四：其他。三个预留槽位（原型编号 6）。 ----
  {
    code: NAV_CODES.OTHERS_SLOT_1,
    label: '功能开发中 1',
    slug: 'slot-1',
    group: NAV_GROUP_CODES.OTHERS,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },
  {
    code: NAV_CODES.OTHERS_SLOT_2,
    label: '功能开发中 2',
    slug: 'slot-2',
    group: NAV_GROUP_CODES.OTHERS,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },
  {
    code: NAV_CODES.OTHERS_SLOT_3,
    label: '功能开发中 3',
    slug: 'slot-3',
    group: NAV_GROUP_CODES.OTHERS,
    module: null,
    planned: true,
    slot: true,
    summary: '该子项尚未定义。',
  },

  // ---- 底部图标行。不参与主列表渲染，见 NAV_FOOTER_CODES。 ----
  {
    code: NAV_CODES.SYSTEM_SETTINGS,
    label: '系统设置',
    slug: 'system-settings',
    group: null,
    module: 'system',
    // 账号与权限管理已落地（T7-01），`planned` 置为 false 让路由分派到真实页面。
    // 角色与审计日志仍未做，将来接上时在 ModuleRoute 里补分支即可，这一侧不用动。
    planned: false,
    slot: false,
    summary: '账号、角色与审计日志管理。仅持有 system 段权限的账号可见。',
  },
]

/**
 * 侧栏渲染用的聚合结果。
 *
 * 把一个分组与它的子项收成一条，交给侧栏一次性渲染。`group` 是分组的编号与名称
 * （**不是**一个导航项 —— 分组头不可路由），`items` 是 `group` 指向它的项，按
 * `NAV_ITEMS` 的定义顺序排列。
 *
 * 纯函数，不做可见性过滤：可见性由 `filterNavigation` 决定，这里只回答
 * 「结构上谁属于谁」。把两件事分开，侧栏才能在「整组都不可见」时正确地把分组
 * 也一并省掉，而不必自己再判一次权限。
 */
export type NavSection =
  { kind: 'item'; item: NavItem } | { kind: 'group'; group: NavGroup; items: readonly NavItem[] }

/**
 * 把扁平清单聚合成「顶层项 + 分组」两段，顺序与原型一致。
 *
 * 三条规则：
 *
 *   1. 顶层项按 `NAV_ITEMS` 的定义顺序排在最前，`NAV_FOOTER_CODES` 里的项被跳过
 *      （它们渲染在底部图标行，由 `Sidebar` 单独取）。
 *   2. 分组按 `NAV_GROUPS` 的顺序排列 —— 顺序由分组清单决定，不由 `NAV_ITEMS`
 *      里第一个子项的位置决定，否则往某组前面插一个项就会把整组挪走。
 *   3. **子项被权限全部过滤掉的分组整组不渲染。** 分组头不可路由，一个空分组
 *      点了只会展开一片空白，没有任何入口可言。上一版保留空壳是因为分组头自己
 *      就是入口，这次那个理由不成立了。
 */
export function buildNavSections(items: readonly NavItem[]): readonly NavSection[] {
  const sections: NavSection[] = []

  for (const item of items) {
    if (item.group !== null) continue
    if (NAV_FOOTER_CODES.includes(item.code)) continue
    sections.push({ kind: 'item', item })
  }

  for (const group of NAV_GROUPS) {
    const children = items.filter((item) => item.group === group.code)
    if (children.length === 0) continue
    sections.push({ kind: 'group', group, items: children })
  }

  return sections
}

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

/**
 * 导航项对应的路由路径。
 *
 * 顶层项是 `/${slug}`，子项是 `/${group}/${slug}`。**层级由这里唯一决定**，不在
 * 各处拼字符串：侧栏链接、落地页重定向、守卫回退三处各拼一次的话，改动路径规则时
 * 漏掉一处，表现是「菜单点得进去、刷新后却落到别处」，而这类偏差不会报错。
 *
 * 查不到编号时回退到 `/${code}`。这不是兜底设计，而是为了让「清单里没有的编号」
 * 也能生成一个稳定地址 —— 调用方拿到的是一个必然不存在的路径，路由会渲染 404，
 * 比抛错或返回空串更容易定位。
 */
export function navPath(code: NavCode): string {
  const item = NAV_ITEMS.find((entry) => entry.code === code)
  if (item === undefined) return `/${code}`
  return item.group === null ? `/${item.slug}` : `/${item.group}/${item.slug}`
}

/**
 * 从路径解析导航编号。
 *
 * 先整段精确匹配，再按前缀匹配。两步都是必要的：
 *
 *   - 精确匹配覆盖 `/workbench`、`/customer/overview`、`/ops/dashboard` 这些
 *     直接落在某个导航项上的地址。
 *   - 前缀匹配覆盖模块内部的更深一层，例如 `/workbench/notes`。**加上分隔符再比**
 *     （`/workbench/` 而不是 `/workbench`），否则 `/workbenchX` 会命中 `workbench`。
 *
 * 上一版只取首段，是因为路径与编号一一对应；引入两层路径后首段变成了分组名
 * （`customer`），而分组不可路由，首段匹配会全部落空。
 *
 * 认不出来时返回 `null`，不在这里兜底。原因是「路径不认识」与「路径认得但当前
 * 角色无权限」是两回事：前者应由调用方导向落地页，后者应由守卫回退到第一个可见项。
 * 若这里也回退到第一项，调用方就再也分不清自己面对的是哪一种，守卫的回退逻辑
 * 会连带失去意义。
 */
export function navCodeFromPath(pathname: string): NavCode | null {
  // 末尾斜杠归一：`/ops/dashboard/` 与 `/ops/dashboard` 是同一个地址，路由上也是。
  const normalized = pathname.replace(/\/+$/, '') || '/'

  const exact = NAV_ITEMS.find((item) => navPath(item.code) === normalized)
  if (exact !== undefined) return exact.code

  const byPrefix = NAV_ITEMS.find((item) => normalized.startsWith(`${navPath(item.code)}/`))
  return byPrefix?.code ?? null
}
