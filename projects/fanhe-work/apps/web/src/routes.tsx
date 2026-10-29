import { NAV_CODES, NAV_ITEMS, navPath, resolveActiveNav, type NavCode } from '@fanhe/shared'
import { Navigate, Route, Routes, useLocation } from 'react-router'

import { useVisibleNavItems } from './auth/useVisibleNavItems'
import { AppShell } from './components/AppShell'
import { CustomerPage } from './pages/CustomerPage'
import { NoAccessPage } from './pages/NoAccessPage'
import { OpsDashboardPage } from './pages/OpsDashboardPage'
import { isOpsNavCode } from './lib/ops-view'
import { NotFoundPage } from './pages/NotFoundPage'
import { PlaceholderPage } from './pages/PlaceholderPage'
import { PreferencesPage } from './pages/PreferencesPage'
import { UsersPage } from './pages/UsersPage'
import { WorkbenchPage } from './pages/WorkbenchPage'

/**
 * 各模块的二级页面路径段。
 *
 * **只有路径段，没有页面。** 页面仍由 `ModuleRoute` 分派 —— 守卫的判据是按模块编号
 * 而不是按路径，因此二级路径天然复用同一层权限守卫，不必为每个子页面再写一遍
 * 「这个角色能不能进」。
 *
 * 之所以需要这张表：一级导航的路径是精确的（`/workbench`、`/customer/overview`），
 * 它匹配自己但**不**匹配更深一层。而共享包的 `navCodeFromPath` 早就写明「更深的段按
 * 前缀归到同一个编号」—— 也就是说这一层是它预期之内的事，这里只是把路由表补齐。
 *
 * 放在这里而不是共享包：它是**路由结构**，属于前端；共享包那份清单回答的是
 * 「有哪些模块、谁看得见」，两者不该混在一起。
 *
 * `workbench` 下面有三段：`launch` 是 UI 改造后新加的 —— 首页占掉了 `/workbench`
 * 本身，启动通道的完整面板需要自己的地址，否则「配置管理」就没有入口了。
 */
const MODULE_SUB_ROUTES: Partial<Record<NavCode, readonly string[]>> = {
  [NAV_CODES.WORKBENCH]: ['launch', 'notes', 'events'],
  // 本机设置（案例图片缓存目录）。挂在系统设置模块下，但它与账号权限无关 ——
  // 它的每一条都是「这台机器」的属性，因此不进导航清单，只占一个二级地址。
  [NAV_CODES.SYSTEM_SETTINGS]: ['preferences'],
}

/**
 * 把共享包给出的完整路径转成路由表要的相对路径。
 *
 * **这一层不能省。** 上一版导航项的路径就是 `/${code}`，于是 `path={item.code}` 恰好
 * 是对的；引入两层路径后，综合看板的地址是 `/customer/overview`，而 `item.code` 仍是
 * `customer-overview` —— 直接拿编号当路径，侧栏点得进去、地址栏却是
 * `/customer-overview`，刷新即 404。路径的唯一事实来源是共享包的 `navPath`，
 * 这里只做「去掉前导斜杠」这一件事。
 *
 * 路由的 `path` 不写前导斜杠（写了会被 React Router 当成绝对路径，反而与父级脱钩）。
 */
function routePath(code: NavCode): string {
  return navPath(code).replace(/^\//, '')
}

/**
 * 已登录后的路由表。
 *
 * **路由表由 `NAV_ITEMS` 派生，不另写一份。** 导航清单的注释已经写明这条约定：
 * 两份定义迟早会不一致，而这类不一致只表现为「菜单里有、点进去落回首页」，
 * 排查方向会先落到路由配置上。这里用 `NAV_ITEMS.map` 生成子路由，新增模块时
 * 只改共享包一处。
 *
 * 结构上分两层：无路径的外壳路由承担侧栏与顶栏，清单里的每个模块作为它的子路由
 * 渲染进内容区。这正是「嵌套路由」的用处 —— 切换模块时外壳不重新挂载，侧栏的折叠
 * 状态与滚动位置因此不会丢。若把模块写成平级路由、各自再包一层外壳，切一次模块就
 * 重挂一次外壳，折叠状态会被重置回展开。
 *
 * 未匹配的路径渲染 404 页，不重定向。重定向会把地址栏改写成落地页的地址，用户
 * 看不出自己输错了什么，而保留原地址能让「复制给别人看」得到同样的结果。404 页
 * 在外壳之内，侧栏与顶栏照常在位，用户可以直接切到别的模块。
 *
 * **模块内部还有一层。** 每个模块的路径是一个父路由，模块自身的页面挂 `index`，
 * 二级页面挂各自的路径段（清单见 `MODULE_SUB_ROUTES`）。这样 `/workbench` 与
 * `/workbench/notes` 是不重挂外壳的两个地址，切换板块时侧栏的折叠状态与滚动位置
 * 都不会丢 —— 而这一点正是当初把模块写成子路由而不是平级路由的原因。
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
          <Route key={item.code} path={routePath(item.code)}>
            {/* 模块自身的页面挂在 `index` 上，二级页面挂在各自的子路由上。父路由不写
                `element`，默认渲染 `Outlet`，因此这一层只是路径的容器。 */}
            <Route index element={<ModuleRoute code={item.code} />} />
            {(MODULE_SUB_ROUTES[item.code] ?? []).map((sub) => (
              <Route key={sub} path={sub} element={<ModuleRoute code={item.code} />} />
            ))}
          </Route>
        ))}

        {/*
          已登录却停在登录页的地址上，必须导回首页。

          登录页与初始化页由 `AuthGate` 按状态渲染，**不在路由表里**；因此登录成功后
          地址栏仍然是进入前的 `/login`，而 `AppRoutes` 找不到这个路径，会落进下面的
          404 —— 表现为「登录成功了，界面却显示『页面不存在』」。这条坑只在有人
          直接打开 `/login`（书签、深链接、桌面壳恢复上一次地址）时出现，从根路径
          进入时地址是 `/`，index 会正常重定向。

          用 `replace` 而不是普通导航：这两条路径是过渡态，不该留在历史里，否则
          用户按后退又回到一个已经不存在的登录页。
        */}
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="setup" element={<Navigate to="/" replace />} />

        <Route path="*" element={<NotFoundPage />} />
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
/**
 * 客户平台的两个编号。
 *
 * 写成函数而不是在 `ModuleRoute` 里串两个 `===`：新增第三个客户入口时只改这一处，
 * 而漏改的表现是「点进去看到占位页」—— 界面不报错，只是内容不对，与运营看板那边
 * `isOpsNavCode` 要防的是同一种错。
 */
function isCustomerNavCode(code: NavCode): boolean {
  return code === NAV_CODES.CUSTOMER_OVERVIEW || code === NAV_CODES.CUSTOMER_PROGRESS
}

function ModuleRoute({ code }: { code: NavCode }) {
  const visibleItems = useVisibleNavItems()
  const { pathname } = useLocation()
  const target = resolveActiveNav(visibleItems, code)

  if (target === null) return <NoAccessPage />
  if (target.code !== code) return <Navigate to={navPath(target.code)} replace />

  // 占位模块统一走 PlaceholderPage。分派按 `planned` 而不是按「是否等于 workbench」：
  // 将来某个模块落地时，只需把共享包里的 `planned` 置为 false 并在这里补一条已落地
  // 分支，占位这一侧不必再动。
  if (target.planned) return <PlaceholderPage item={target} />

  if (target.code === NAV_CODES.WORKBENCH) return <WorkbenchPage item={target} />

  // 运营看板（千牛 / 生意参谋）的七个入口共用同一个页面。
  //
  // 判据用 `isOpsNavCode` 而不是逐个 `===`：七项写成一串 if 之后，新增第八个入口时
  // 很容易漏掉一支，而漏掉的表现是「点进去看到占位页」—— 界面不报错，只是内容不对。
  if (isOpsNavCode(target.code)) return <OpsDashboardPage item={target} />

  // 客户信息平台的两个入口共用同一个页面（`CustomerPage`），由编号决定是「综合看板」
  // 还是「客户进度」。与上面七个运营入口同一条做法，理由也一样：两块看的是同一份
  // 数据、同一套筛选，拆成两个组件就等于把筛选条件维护两遍。
  if (isCustomerNavCode(target.code)) return <CustomerPage item={target} />

  // 账号与权限管理（T7-01）。放在 planned 判断之后、分派表末尾的兜底之前 ——
  // 这两处都不能省：planned 拦掉未落地的模块，兜底则接住清单里新增却还没写页面的
  // 那一档。
  // 系统设置模块下有两个页面：默认是账号与权限，`/preferences` 是本机设置。
  // 判据用地址而不是给模块再加一个 NavCode —— 导航清单回答的是「有哪些模块」，
  // 而「本机设置」不是一个模块，它是系统设置的一个页签。
  if (target.code === NAV_CODES.SYSTEM_SETTINGS) {
    return pathname.endsWith('/preferences') ? <PreferencesPage /> : <UsersPage item={target} />
  }

  // 共享包新增了 `planned` 为 false 却还没有对应页面的模块时的兜底。渲染占位页而不是
  // 抛错：界面保持可用，且「功能开发中」的标注比一片空白更容易被注意到。
  return <PlaceholderPage item={target} />
}
