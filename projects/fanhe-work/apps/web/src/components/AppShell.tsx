import type { AuthenticatedUser, NavCode, NavItem } from '@fanhe/shared'
import { useState, type ReactNode } from 'react'

import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'

type AppShellProps = {
  items: readonly NavItem[]
  activeCode: NavCode | null
  /** 当前一级导航名称，用于顶栏面包屑。 */
  activeTitle: string | null
  user: AuthenticatedUser
  roleName: string
  onSelect: (code: NavCode) => void
  onLogout: () => void
  children: ReactNode
}

/**
 * 已登录后的主框架：左侧导航、顶部栏、内容区。
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
 * 折叠状态目前是组件内的 `useState`。T2-06 要做的「记住折叠偏好」只需把这里换成
 * 读写持久化的实现，接口不用变 —— 折叠是外壳自身的状态，上层不需要知道它，所以
 * 没有做成受控属性。
 */
export function AppShell({
  items,
  activeCode,
  activeTitle,
  user,
  roleName,
  onSelect,
  onLogout,
  children,
}: AppShellProps) {
  const [collapsed, setCollapsed] = useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar
        items={items}
        activeCode={activeCode}
        collapsed={collapsed}
        onSelect={onSelect}
        onToggleCollapsed={() => setCollapsed((current) => !current)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar title={activeTitle} user={user} roleName={roleName} onLogout={onLogout} />

        <main className="flex-1 overflow-y-auto px-8 pb-10">
          <div className="mx-auto max-w-[1080px]">{children}</div>
        </main>
      </div>
    </div>
  )
}
