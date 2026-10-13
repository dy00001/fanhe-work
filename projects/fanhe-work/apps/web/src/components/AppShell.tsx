import { ROLES, navCodeFromPath, resolveActiveNav } from '@fanhe/shared'
import { useEffect, useRef, useState, type RefObject } from 'react'
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
 * 三条尺寸来自 UI 合并方案对齐原 UI 的实测值：侧栏展开 240px / 折叠 72px、顶栏
 * 72px、内容区通栏铺满。前两条在各自的组件里，第三条在这里 —— 它是外壳的职责，
 * 页面不该各自决定自己的宽度上限。旧版曾用 `max-w-[1080px]` 居中，UI 改造后按原
 * UI 的做法取消居中列，让内容铺满，于是案例展示、一键启动与工作纪要三段落在同
 * 一条栅格上。
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
  const mainRef = useRef<HTMLElement>(null)

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
    // `relative` 是侧栏那个折叠按钮的定位上下文：它刻意渲染在 `<aside>` 之外
    // （要骑在侧栏右缘上，留在 aside 内会被滚动容器裁掉），因此需要一个共同祖先
    // 来承载它的绝对定位。见 `Sidebar` 的顶部注释。
    <div className="relative flex h-screen overflow-hidden bg-background">
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

        {/* 内容区：上 20 / 左右 48 / 下 0，与原 UI 的 main 同度量，且通栏铺满。
            `hide-scrollbar` 与设计稿一致 —— 系统滚动条（Windows 上是 15px 的槽）会
            顶掉内容区右侧那 48px 的留白，因此改由 `ScrollThumb` 自绘一条 6px 的
            指示器。两者的可见性必须一起改，只藏系统滚动条而不给指示器等于砍掉反馈。 */}
        <main ref={mainRef} className="hide-scrollbar flex-1 overflow-y-auto px-12 pt-5">
          <Outlet />
        </main>
      </div>

      {/* 指示器挂在最外层：`.scroll-thumb` 的 `right: 4px` 以窗口右缘为基准，
          与内容区右边界同一条线（系统滚动条已隐藏，两者重合）。 */}
      <ScrollThumb target={mainRef} contentKey={pathname} />
    </div>
  )
}

/**
 * 内容区自绘滚动指示器（设计稿 `.scroll-thumb`）。
 *
 * 复刻原型的四条取值与三条行为：
 *   - 宽 6 / 圆角 999 / `right: 4px` / `top: 72px`（与顶栏下缘对齐）—— 写在
 *     `index.css` 的 `.scroll-thumb` 里，位置走 `translateY` 走上合成层，不触发重排；
 *   - 高度按「可视高 / 内容高」算，最小 32px（内容再长也留一段可抓的视觉长度）；
 *   - **滚到顶部时整个节点不渲染**。原型是把节点从 DOM 里摘掉，而不是 `opacity: 0`
 *     —— 后者会留一条看不见但参与命中的元素。
 *
 * `contentKey` 是路由地址。给它的理由是内容区的**自身尺寸不变但内容换了一整块**：
 * `ResizeObserver` 只认盒子尺寸，路由切换时若新页面恰好和旧页面一样高，观察器一次
 * 都不回调，指示器会停在上一页的比例上。带上地址、让副作用随路由重挂，是这里最省
 * 的一种正确写法。
 */
function ScrollThumb({
  target,
  contentKey,
}: {
  target: RefObject<HTMLElement | null>
  contentKey: string
}) {
  const [thumb, setThumb] = useState<{ height: number; offset: number } | null>(null)

  useEffect(() => {
    const el = target.current
    if (el === null) return

    const measure = () => {
      const view = el.clientHeight
      const total = el.scrollHeight
      // 内容没有溢出时不给指示器：一条占满整个可视区的滚动条没有信息量，还容易被
      // 误读成「还有更多内容」。
      if (total <= view + 1) {
        setThumb(null)
        return
      }
      const height = Math.max(32, (view / total) * view)
      const maxScroll = total - view
      const travel = view - height
      const offset = maxScroll <= 0 ? 0 : (el.scrollTop / maxScroll) * travel
      setThumb({ height, offset })
    }

    measure()
    el.addEventListener('scroll', measure, { passive: true })

    // 两处都要观察：`el` 自己在窗口缩放时变高，它的第一个子节点（页面根元素）在数据
    // 加载完、卡片长高时变高。只观察其中之一会漏掉另一类变化，而症状都是「指示器
    // 的长度不再对得上内容」。
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    const page = el.firstElementChild
    if (page !== null) observer.observe(page)

    return () => {
      el.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [target, contentKey])

  if (thumb === null || thumb.offset <= 0) return null

  return (
    <div
      aria-hidden
      className="scroll-thumb"
      style={{ height: thumb.height, transform: `translateY(${thumb.offset}px)` }}
    />
  )
}
