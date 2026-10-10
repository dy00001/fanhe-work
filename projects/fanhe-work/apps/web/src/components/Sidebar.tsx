import { navPath, type NavItem } from '@fanhe/shared'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { NavLink, type NavLinkRenderProps } from 'react-router'

import { NAV_ICONS } from '../lib/nav-icons'
import { cn } from '../lib/utils'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

type SidebarProps = {
  /** 已按当前权限过滤后的导航项，顺序即界面顺序。 */
  items: readonly NavItem[]
  collapsed: boolean
  onToggleCollapsed: () => void
}

/**
 * 左侧主导航。
 *
 * 宽度取实施方案第五章的规格：展开 224px、折叠 64px。这两个值是布局的基准，
 * 顶栏与内容区都相对它对齐，所以写在这里而不是做成可配置项。
 *
 * **导航项用 `NavLink` 而不是受控按钮。** 激活态由 URL 判定，不再由上层传一个
 * `activeCode` 下来：受控写法要求「点按钮改状态」与「地址变化」两条路径都去同步
 * 那个状态，而其中一条（浏览器前进后退、直接输入地址）很容易被漏掉，表现为
 * 「地址变了但高亮没变」。`NavLink` 顺带写入 `aria-current="page"`，无障碍与
 * 测试都省了一件事。
 *
 * 折叠态下只留图标，导航项名称改由气泡提示给出。这不是可选的装饰：文字一没，
 * 图标就成了唯一的信息载体，而图标本身表意模糊（「数据看板」与「运营信息平台」
 * 的图标都是趋势类），少了提示等于让用户靠记忆点菜单。
 *
 * 「可见 N / 共 M 项」那行调试文字在 T2-02 被去掉了。它原本的作用是让阶段一的
 * 可见范围验收有可观察的落点（见 DEVELOPMENT-PLAN 9.19），而那是开发者视角的
 * 信息，不该出现在正式界面上；可见范围的断言改由端到端脚本数导航项数承担。
 */
export function Sidebar({ items, collapsed, onToggleCollapsed }: SidebarProps) {
  return (
    <aside
      className={cn(
        'flex shrink-0 flex-col border-r border-border-soft bg-card transition-[width] duration-200 ease-out',
        collapsed ? 'w-16' : 'w-56',
      )}
    >
      {/* 品牌区高度与顶栏一致（56px），两条横线才能在视觉上接得上。 */}
      <div
        className={cn(
          'flex h-14 shrink-0 items-center gap-2.5',
          collapsed ? 'justify-center' : 'px-4',
        )}
      >
        <img src="/brand/logo.png" alt="" className="h-7 w-auto shrink-0" />
        {!collapsed && (
          <span className="truncate text-sm font-medium text-foreground">梵禾 Work</span>
        )}
      </div>

      <TooltipProvider delayDuration={200}>
        <nav
          className={cn(
            'flex flex-1 flex-col gap-0.5 overflow-y-auto py-2',
            collapsed ? 'px-2' : 'px-2.5',
          )}
        >
          {items.map((item) => {
            const Icon = NAV_ICONS[item.code]

            const link = (
              <NavLink
                to={navPath(item.code)}
                className={({ isActive }: NavLinkRenderProps) =>
                  cn(
                    'flex h-9 w-full items-center gap-2.5 rounded-md text-sm transition-colors',
                    collapsed ? 'justify-center' : 'px-2.5',
                    isActive
                      ? 'bg-accent font-medium text-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                  )
                }
              >
                <Icon className="size-4 shrink-0" />
                {!collapsed && (
                  <>
                    <span className="truncate">{item.label}</span>
                    {item.planned && (
                      <span className="ml-auto shrink-0 text-[10.5px] text-muted-foreground-weak">
                        开发中
                      </span>
                    )}
                  </>
                )}
              </NavLink>
            )

            // 展开态下名称就在链接上，再加气泡是重复；折叠态下它是唯一的名称来源。
            return collapsed ? (
              <Tooltip key={item.code}>
                <TooltipTrigger asChild>{link}</TooltipTrigger>
                <TooltipContent side="right">
                  {item.planned ? `${item.label}（开发中）` : item.label}
                </TooltipContent>
              </Tooltip>
            ) : (
              <div key={item.code}>{link}</div>
            )
          })}
        </nav>
      </TooltipProvider>

      <div className={cn('shrink-0 border-t border-border-soft', collapsed ? 'p-2' : 'p-2.5')}>
        <Button
          type="button"
          variant="ghost"
          size={collapsed ? 'icon' : 'sm'}
          onClick={onToggleCollapsed}
          aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
          title={collapsed ? '展开侧栏' : '收起侧栏'}
          className={cn('text-muted-foreground', !collapsed && 'w-full justify-start')}
        >
          {collapsed ? (
            <ChevronRight className="size-4" />
          ) : (
            <>
              <ChevronLeft className="size-4" />
              收起侧栏
            </>
          )}
        </Button>
      </div>
    </aside>
  )
}
