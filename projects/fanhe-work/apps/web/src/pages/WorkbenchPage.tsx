import { NAV_CODES, navPath, type NavItem } from '@fanhe/shared'
import { NavLink, useLocation, type NavLinkRenderProps } from 'react-router'

import { ModuleHeader } from '../components/ModuleHeader'
import { EventsPanel } from '../components/events/EventsPanel'
import { LaunchPanel } from '../components/launch/LaunchPanel'
import { NotesPanel } from '../components/notes/NotesPanel'
import { cn } from '../lib/utils'

/**
 * 个人工作台的落地内容。
 *
 * 三个板块（一键登录通道、工作纪要、事件记录）在阶段三逐个落地：T3-03 落启动通道，
 * T3-06 落工作纪要，T3-10 落事件记录的列表视图。本页从阶段二起承担的两项诊断内容
 * （当前账号、展开后的权限点）在 T3-03 那一版移除 —— 它们当初的存在理由就是「随三
 * 板块落地后移除」。
 *
 * **板块由 URL 决定，不由组件状态决定。** 这不是风格偏好：地址栏能表达「我在哪」
 * 意味着刷新不丢位置、地址可以直接发给别人，也与 `ModuleRoute` 那条「重定向而不是
 * 就地渲染，是为了让地址栏与内容始终一致」的原则同源。因此这里读 `NavLink` 的激活
 * 态而不是自己存一个 `useState` 的当前板块。
 *
 * 板块切换放在页头之下而不是每个板块卡片自己的头部：它是页面级的导航，属于「我在
 * 工作台的哪一页」，与卡片内部那些「筛选 / 新建」不是一层。
 *
 * **本页不读认证上下文。** 板块自己按权限决定露出哪些入口，页头只认导航项 —— 页面
 * 层拿不到 `user` 就不必写那句「类型上不可能为空」的收窄判断，也就少一个只有渲染期
 * 才会暴露的空值分支。
 */

/** 已落地的板块。顺序即界面顺序，与实施方案第五章的一级导航表一致。 */
const WORKBENCH_SECTIONS = [
  {
    path: navPath(NAV_CODES.WORKBENCH),
    label: '一键登录通道',
    summary: '本机客户端的启动配置',
    // 需要 `end`：不加它，这个链接在 `/workbench/notes` 下也会被判为激活，
    // 于是两个标签同时高亮。
    end: true,
  },
  {
    path: `${navPath(NAV_CODES.WORKBENCH)}/notes`,
    label: '工作纪要',
    summary: 'Markdown 记录的与标签分类',
    end: false,
  },
  {
    path: `${navPath(NAV_CODES.WORKBENCH)}/events`,
    label: '事件记录',
    summary: '未完成与已完成分组的待办',
    end: false,
  },
] as const

export function WorkbenchPage({ item }: { item: NavItem }) {
  return (
    <div className="flex flex-col gap-4">
      <ModuleHeader item={item} />

      <nav aria-label="工作台板块" className="flex flex-wrap items-center gap-1">
        {WORKBENCH_SECTIONS.map((section) => (
          <NavLink
            key={section.path}
            to={section.path}
            end={section.end}
            className={({ isActive }: NavLinkRenderProps) =>
              cn(
                'rounded-lg border border-solid px-3 py-1.5 text-sm transition-colors',
                isActive
                  ? 'border-border bg-accent font-medium text-accent-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )
            }
          >
            {section.label}
          </NavLink>
        ))}
      </nav>

      {/* 板块由路由分派，不用一个数组 + 索引去取组件 —— 组件与路径的对应关系写在
          路由表（`routes.tsx` 的 `MODULE_SUB_ROUTES`）里，这里只按地址分支，避免
          同一件事有两处定义。 */}
      <SectionBody />
    </div>
  )
}

/**
 * 按当前地址渲染对应的板块。
 *
 * 读 `useLocation` 而不是 `useParams`：子路由的路径段是静态字符串（`notes`），不是
 * 参数，拿不到有意义的 params。而地址最后一段与 `WORKBENCH_SECTIONS` 的对应关系只有
 * 两处，直接判断比再抽一层映射更清楚。
 */
function SectionBody() {
  const { pathname } = useLocation()
  const base = navPath(NAV_CODES.WORKBENCH)

  // 末尾斜杠归一。`/workbench/notes/` 与 `/workbench/notes` 在路由上匹配同一个页面，
  // 若不归一，手输地址带一个尾斜杠就会落回启动通道那一板块 —— 而且地址栏与内容不一致。
  const normalized = pathname.replace(/\/+$/, '')

  if (normalized === `${base}/notes`) return <NotesPanel />
  if (normalized === `${base}/events`) return <EventsPanel />
  return <LaunchPanel />
}
