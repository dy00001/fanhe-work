import { ROLES, navCodeFromPath, resolveActiveNav } from '@fanhe/shared'
import { useState } from 'react'
import { Outlet, useLocation } from 'react-router'

import { useAuth } from '../auth/useAuth'
import { useVisibleNavItems } from '../auth/useVisibleNavItems'
import { readSidebarCollapsed, writeSidebarCollapsed } from '../lib/preferences'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

/**
 * 已登录后的主框架：左侧导航、顶部栏、内容区。
 *
 * 它是路由表里的**布局路由**（无路径、以 `<Outlet/>` 承载子路由），而不是某个
 * 页面的内部结构。做成布局路由的收益是切换模块时外壳不重新挂载，侧栏的折叠状态
 * 与内容区的滚动位置因此得以保留。若把外壳放进每个页面，切一次模块就重挂一次，
 * 折叠会被重置回展开。
 *
 * 三条尺寸来自实施方案第五章：侧栏展开 224px / 折叠 64px、顶栏 56px、内容区用
 * 最大宽度约束而非通栏铺满。前两条在各自的组件里，第三条在这里 —— 它是外壳的
 * 职责，页面不该各自决定自己的宽度上限，否则不同页面之间的正文左边距会不一致，
 * 而这种不一致在单页上看不出来，只有来回切换时才觉得「页面在跳」。
 *
 * **整页高度锁死、由内容区独立滚动**（`h-screen` 加 `overflow-hidden`），而不是
 * 让整页滚动。侧栏与顶栏因此始终在位，翻长列表时不用回到顶部才能切模块。代价是
 * 内容区的滚动条出现在侧栏右侧而不是窗口最右缘，视觉上略微内收，这是应用式布局
 * 的常规取舍。
 *
 * 折叠状态是外壳自身的状态，不对外暴露，所以没有做成受控属性 —— 上层不需要知道它。
 * 它从 `lib/preferences.ts` 读初值并写回，因此刷新后保持上次的选择。
 *
 * **初值必须走 `useState` 的惰性初始化，不能放在 `useEffect` 里读。** 后者会先用
 * 默认的展开态渲染一帧，再跳到折叠态：用户看到的是每次刷新都闪一下展开的侧栏。
 * 两种写法都能通过「刷新后量一下宽度是 64px」这类事后断言，差别只在首帧，所以
 * 端到端脚本为此专门逐帧采样（见 `test/e2e-auth.mjs` 的 `SIDEBAR_WIDTH_PROBE`）。
 */
export function AppShell() {
  const { user, logout } = useAuth()
  const visibleItems = useVisibleNavItems()
  const { pathname } = useLocation()
  const [collapsed, setCollapsed] = useState(readSidebarCollapsed)

  // 先算再写。不用 `setCollapsed` 的函数式更新把写回塞进去：那样写操作会落在
  // React 的状态更新函数里，而 StrictMode 下更新函数会被调用两次 —— 写入同一个值
  // 虽然幂等、不会出错，但把副作用藏在更新函数里迟早会在别处踩坑。
  const toggleCollapsed = () => {
    const next = !collapsed
    setCollapsed(next)
    writeSidebarCollapsed(next)
  }

  // 激活项从 URL 解析，不再由组件状态驱动。`resolveActiveNav` 在这里只用来取
  // 顶栏面包屑的标题；真正决定渲染哪个模块的是 routes.tsx 里的守卫，两者用的是
  // 同一个函数与同一份可见清单。
  const requested = navCodeFromPath(pathname)
  const activeItem = resolveActiveNav(visibleItems, requested)

  // 未匹配到一级导航的路径由路由渲染 404 页，面包屑此时回落到应用名（传 null），
  // 而不是显示第一个模块的名称 —— 后者会让地址栏写着陌生路径、面包屑却说是个人
  // 工作台。根路径要排除：它是落地页重定向的中转，重定向完成前也会走到这里。
  const breadcrumbTitle =
    requested === null && pathname !== '/' ? null : (activeItem?.label ?? null)

  // 类型上不可能为空：外壳只挂载在 authenticated 状态下。判空是为了收窄类型，
  // 必须放在所有 hook 之后。
  if (user === null) return null

  const roleName = ROLES.find((role) => role.code === user.role)?.name ?? user.role

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar items={visibleItems} collapsed={collapsed} onToggleCollapsed={toggleCollapsed} />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={breadcrumbTitle}
          user={user}
          roleName={roleName}
          onLogout={() => {
            void logout()
          }}
        />

        <main className="flex-1 overflow-y-auto px-8 pt-2 pb-10">
          <div className="mx-auto max-w-[1080px]">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
