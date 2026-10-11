import { NAV_CODES, navPath, type NavItem } from '@fanhe/shared'
import { useLocation } from 'react-router'

import { ModuleHeader } from '../components/ModuleHeader'
import { EventsPanel } from '../components/events/EventsPanel'
import { LaunchPanel } from '../components/launch/LaunchPanel'
import { NotesPanel } from '../components/notes/NotesPanel'
import { HomePage } from './HomePage'

/**
 * `workbench` 这个模块下四个地址的分派。
 *
 * UI 改造后首页换成了三段式（`HomePage`），而三个功能面板各自需要自己的地址 ——
 * 它们的增删改查是完整的业务能力，不能因为首页换了形态就没有入口：
 *
 *   `/workbench`          三段式首页（原型编号 9 / 10 / 11）
 *   `/workbench/launch`   一键登录通道的完整面板（新增 / 编辑 / 排序 / 删除 / 启动）
 *   `/workbench/notes`    工作纪要面板
 *   `/workbench/events`   事件记录面板
 *
 * **`launch` 这一段是本次改造新增的。** 改造前 `/workbench` 本身就是启动通道面板，
 * 首页占了那个地址之后，不给它一个地址就等于把「配置管理」整个砍掉。三个子地址都
 * 保留是因为用户明确要求「替换为三段式，但保留子路由」。
 *
 * **分派读地址而不是用一个状态。** 地址栏能表达「我在哪」意味着刷新不丢位置、地址
 * 可以直接发给别人 —— 这条理由与 `ModuleRoute` 那条「重定向而不是就地渲染，是为了
 * 让地址栏与内容始终一致」同源。因此这里读 `useLocation`，不存 `useState`。
 *
 * 末尾斜杠要先归一：`/workbench/notes/` 与 `/workbench/notes` 在路由上匹配同一个页面，
 * 不归一的话手输一个尾斜杠就会落回首页。
 */
export function WorkbenchPage({ item }: { item: NavItem }) {
  const { pathname } = useLocation()
  const base = navPath(NAV_CODES.WORKBENCH)
  const normalized = pathname.replace(/\/+$/, '')

  if (normalized === `${base}/launch`) {
    return (
      <div className="flex flex-col gap-4">
        <ModuleHeader item={item} />
        <LaunchPanel />
      </div>
    )
  }

  if (normalized === `${base}/notes`) {
    return (
      <div className="flex flex-col gap-4">
        <ModuleHeader item={item} />
        <NotesPanel />
      </div>
    )
  }

  if (normalized === `${base}/events`) {
    return (
      <div className="flex flex-col gap-4">
        <ModuleHeader item={item} />
        <EventsPanel />
      </div>
    )
  }

  return <HomePage />
}
