import { NAV_CODES, NAV_ITEMS, navPath, resolveActiveNav, type NavCode } from '@fanhe/shared'
import { Navigate, Route, Routes } from 'react-router'

import { useVisibleNavItems } from './auth/useVisibleNavItems'
import { AppShell } from './components/AppShell'
import { ModulePage } from './pages/ModulePage'
import { NoAccessPage } from './pages/NoAccessPage'
import { WorkbenchPage } from './pages/WorkbenchPage'

/**
 * 已登录后的路由表。
 *
 * **路由表由 `NAV_ITEMS` 派生，不另写一份。** 导航清单的注释已经写明这条约定：
 * 两份定义迟早会不一致，而这类不一致只表现为「菜单里有、点进去落回首页」，
 * 排查方向会先落到路由配置上。这里用 `NAV_ITEMS.map` 生成子路由，新增模块时
 * 只改共享包一处。
 *
 * 结构上分两层：无路径的外壳路由承担侧栏与顶栏，五个模块作为它的子路由渲染进
 * 内容区。这正是「嵌套路由」的用处 —— 切换模块时外壳不重新挂载，侧栏的折叠
 * 状态与滚动位置因此不会丢。若把五个模块写成平级路由、各自再包一层外壳，切一次
 * 模块就重挂一次外壳，折叠状态会被重置回展开。
 *
 * 未匹配的路径统一回到落地页。真正的 404 页面属 T2-05，届时把这条 catch-all
 * 换成它即可。
 */
export function AppRoutes() {
  const visibleItems = useVisibleNavItems()
  const landing = visibleItems[0] ?? null

  return (
    <Routes>
      <Route element={<AppShell />}>
        {/* 落地页：访问根路径时导向第一个可见模块，而不是另造一个首页。 */}
        <Route
          index
          element={landing ? <Navigate to={navPath(landing.code)} replace /> : <NoAccessPage />}
        />

        {NAV_ITEMS.map((item) => (
          <Route key={item.code} path={item.code} element={<ModuleRoute code={item.code} />} />
        ))}

        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}

/**
 * 模块路由的守卫。
 *
 * 判据复用共享包的 `resolveActiveNav`，与阶段一的组件状态版本是同一个函数 ——
 * T2-03 换掉的只是「请求项从哪里来」（从组件状态改成 URL），判断本身一字未动。
 *
 * 三种情形：
 *   1. 请求的模块在可见清单里 —— 渲染它。
 *   2. 请求的模块不可见（例如 member 直接访问 `/system-settings`）—— 重定向到
 *      回退项，而不是在原路径下渲染别人的内容。**重定向而不是就地渲染，是为了
 *      让地址栏与内容始终一致**；否则刷新一次，地址栏还写着 `/system-settings`
 *      而内容已经是个人工作台，用户复制这个地址给别人会得到误导性的结果。
 *   3. 可见清单为空 —— 渲染兜底界面。
 *
 * 这一层只承担体验职责。真正的访问控制在服务端的 `requirePermission`，绕过它
 * 只会让请求返回 403，不会拿到数据。
 */
function ModuleRoute({ code }: { code: NavCode }) {
  const visibleItems = useVisibleNavItems()
  const target = resolveActiveNav(visibleItems, code)

  if (target === null) return <NoAccessPage />
  if (target.code !== code) return <Navigate to={navPath(target.code)} replace />

  // 个人工作台是本期在做的模块，其余四项仍是占位。两者的差别只是页面内容，
  // 路由与守卫完全一致。
  return target.code === NAV_CODES.WORKBENCH ? (
    <WorkbenchPage item={target} />
  ) : (
    <ModulePage item={target} />
  )
}
