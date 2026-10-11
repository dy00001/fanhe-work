import type { NavCode, NavGroupCode } from '@fanhe/shared'
import {
  Box,
  ChartLine,
  ChartPie,
  CircleDashed,
  Ellipsis,
  Folder,
  LayoutGrid,
  ListChecks,
  Search,
  Settings,
  TrendingUp,
  Users,
  type LucideIcon,
} from 'lucide-react'

/**
 * 导航项的图标。
 *
 * 放在 `lib` 而不是侧栏组件内部，是因为它有两个消费方：侧栏（展开态、折叠态与
 * 折叠浮层）与统一占位页的页头。两处各写一份的话，新增模块时漏改一处，表现是
 * 「侧栏有图标而占位页没有」或两处图标不一致，都属看得见但很容易被忽略的那类偏差。
 *
 * 类型写成 `Record<NavCode, LucideIcon>` 而不是 `Partial<...>`，是为了让新增导航项时
 * **编译期**就报错。图标留在前端、不进共享包，与 `navigation.ts` 的分工一致：共享包
 * 放信息架构（编号、名称、可见性），表现层的东西放应用内。
 *
 * 取值全部对齐 `UI合并方案/梵禾Work-首页改造预览.html` 的侧栏图标：
 * 首页 `#i-home`（四宫格）→ `LayoutGrid`、资产 `#i-folder` → `Folder`、
 * 搜索 `#i-search` → `Search`、综合看板 `#i-chart-pie` → `ChartPie`、
 * 客户进度 `#i-checklist` → `ListChecks`、数据看板 `#i-chart-line` → `ChartLine`、
 * 系统设置 `#i-settings` → `Settings`、预留槽位 `#i-dashed` → `CircleDashed`。
 *
 * 十一个预留槽位共用同一个虚线图标 —— 它们本来就没有各自的语义，原型里也一律用
 * `#i-dashed`。这里逐个写出来而不是用一个通配，是为了保住「新增编号必须补图标」
 * 这条编译期约束：真模块落地时把那一条改成它自己的图标，正是改动该发生的地方。
 */
export const NAV_ICONS: Record<NavCode, LucideIcon> = {
  workbench: LayoutGrid,
  assets: Folder,
  search: Search,
  'customer-overview': ChartPie,
  'customer-progress': ListChecks,
  dashboard: ChartLine,
  'system-settings': Settings,
  'customer-slot-1': CircleDashed,
  'customer-slot-2': CircleDashed,
  'ops-slot-1': CircleDashed,
  'ops-slot-2': CircleDashed,
  'ops-slot-3': CircleDashed,
  'design-slot-1': CircleDashed,
  'design-slot-2': CircleDashed,
  'design-slot-3': CircleDashed,
  'others-slot-1': CircleDashed,
  'others-slot-2': CircleDashed,
  'others-slot-3': CircleDashed,
}

/**
 * 分组头的图标。
 *
 * 与 `NAV_ICONS` 分开，而不是并成一张 `Record<NavCode | NavGroupCode, ...>`：
 * 分组编号与导航编号是两份**互不相交**的清单（分组头不可路由，见 `navigation.ts`），
 * 并在一起会让人以为某个编号可以在两处出现。分开后各自仍是完备的 `Record`，
 * 漏一个照样编译期报错。
 *
 * 取值对齐原型：客户信息平台 `#i-users` → `Users`、运维信息平台 `#i-trend`
 * → `TrendingUp`、设计信息平台 `#i-box` → `Box`、「其他」`#i-more` → `Ellipsis`。
 */
export const NAV_GROUP_ICONS: Record<NavGroupCode, LucideIcon> = {
  customer: Users,
  ops: TrendingUp,
  design: Box,
  others: Ellipsis,
}
