import type { NavCode } from '@fanhe/shared'
import { ChartPie, LayoutGrid, Settings, TrendingUp, Users, type LucideIcon } from 'lucide-react'

/**
 * 导航项的图标。
 *
 * 放在 `lib` 而不是侧栏组件内部，是因为从 T2-04 起它有两个消费方：侧栏（展开态与
 * 折叠态）与统一占位页的页头。两处各写一份的话，新增模块时漏改一处，表现是「侧栏
 * 有图标而占位页没有」或两处图标不一致，都属看得见但很容易被忽略的那类偏差。
 *
 * 类型写成 `Record<NavCode, LucideIcon>` 而不是 `Partial<...>`，是为了让新增导航项时
 * **编译期**就报错。图标留在前端、不进共享包，与 `navigation.ts` 的分工一致：共享包
 * 放信息架构（编号、名称、可见性），表现层的东西放应用内。
 */
export const NAV_ICONS: Record<NavCode, LucideIcon> = {
  workbench: LayoutGrid,
  customer: Users,
  ops: TrendingUp,
  dashboard: ChartPie,
  'system-settings': Settings,
}
