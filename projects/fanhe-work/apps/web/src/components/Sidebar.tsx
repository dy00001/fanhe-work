import {
  NAV_FOOTER_CODES,
  buildNavSections,
  navPath,
  type NavItem,
  type NavSection,
} from '@fanhe/shared'
import { Bell, ChevronDown, Monitor, Moon, PanelLeft, Sun, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { NavLink, type NavLinkRenderProps } from 'react-router'

import { NAV_GROUP_ICONS, NAV_ICONS } from '../lib/nav-icons'
import { type ThemePreference } from '../lib/preferences'
import { useTheme } from '../lib/theme'
import { cn } from '../lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip'

type SidebarProps = {
  /** 已按当前权限过滤后的导航项，顺序即界面顺序。 */
  items: readonly NavItem[]
  collapsed: boolean
  onToggleCollapsed: () => void
}

/** 主题三档。顺序即界面顺序：默认档在最前。 */
const THEME_OPTIONS: readonly { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
  { value: 'system', label: '跟随系统', Icon: Monitor },
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'dark', label: '深色', Icon: Moon },
]

/**
 * 左侧主导航。
 *
 * 结构与 `UI合并方案/梵禾Work-首页改造预览.html` 的侧栏逐条对齐，四段：
 *
 *   1. 品牌行（编号 1）：logo + 名称，高 72px —— 与顶栏同高，两条下边缘接成一条线；
 *   2. 主列表（编号 2~6）：顶层项「首页 / 资产 / 搜索」+ 四个分组；
 *   3. 底部图标行（编号 7）：外观三档 + 系统设置 + 通知；
 *   4. 折叠按钮：**刻意渲染在 `<aside>` 之外**。
 *
 * 尺寸取原型实测值：展开 240px、折叠 72px。
 *
 * **分组头是纯折叠开关，不是链接。** 原型里它就是 `<button>`，没有 href，点了只
 * 展开/收起。上一版为了不丢入口，给分组头保留了同名占位页，于是一个分组头要同时
 * 承载「跳转」与「折叠」两件事 —— 一行里塞两个可点元素，既不好点也不好读。这次
 * 按原型收敛：分组头只折叠，页面入口交给子项。连带的两条：`NAV_GROUPS` 的编号不再
 * 是导航项编号（见 `navigation.ts`），子项被权限全部过滤掉的分组整组不渲染。
 *
 * **折叠按钮为什么在 `aside` 外面。** `<aside>` 需要 `overflow-hidden` 之外的滚动
 * 容器才能让折叠浮层溢出，而按钮要骑在侧栏右缘上（折叠态左移 16px 压住边线），
 * 两者放在同一个盒子里必然互相裁剪。原型把它提成 `.app` 的直接子级、用绝对定位
 * 控制位置，本实现照此办理 —— 因此本组件返回的是 `<aside>` + `<button>` 两段，
 * 调用方的容器需要有 `position: relative`（见 `AppShell`）。
 *
 * **导航项用 `NavLink` 而不是受控按钮。** 激活态由 URL 判定，不再由上层传一个
 * `activeCode` 下来：受控写法要求「点按钮改状态」与「地址变化」两条路径都去同步
 * 那个状态，而其中一条（浏览器前进后退、直接输入地址）很容易被漏掉，表现为
 * 「地址变了但高亮没变」。`NavLink` 顺带写入 `aria-current="page"`。
 *
 * 折叠态下只留图标，导航项名称改由气泡提示给出；分组改为「图标 + 点击弹出的浮层」，
 * 让子项仍有入口。
 */
export function Sidebar({ items, collapsed, onToggleCollapsed }: SidebarProps) {
  const sections = buildNavSections(items)
  const footerItems = items.filter((item) => NAV_FOOTER_CODES.includes(item.code))

  // 被收起的分组编号。默认空集，即所有分组默认展开 —— 与编号 3/4/5/6 的
  // 「默认打开」一致。用数组而不是 Set：Set 的引用相等在 React 里更难推理。
  const [closedGroups, setClosedGroups] = useState<readonly string[]>([])
  const toggleGroup = (code: string) => {
    setClosedGroups((current) =>
      current.includes(code) ? current.filter((item) => item !== code) : [...current, code],
    )
  }

  return (
    <>
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r border-border-soft bg-card transition-[width] duration-200 ease-out',
          collapsed ? 'w-[72px]' : 'w-60',
        )}
      >
        {/* 品牌行。内容 36 高、上下 16/20 —— 与原型一致。
            **图标对齐（按原型折叠态 logo 居中）**：折叠态 30px logo 中心落 x=36
            —— 与折叠态导航/分组/底部图标的 x=36 中轴同线。这里用 `pl-[21px]`
            （30px 在 72px 的精确居中值）而非 `justify-center` 是刻意的：宽度动画
            期间 `justify-center` 会让 logo 先在 240px 里跳到 x≈105 再滑回，而
            `transition-[padding]` 让 logo 屏幕 x 平滑走 16→21，切换不甩位。展开态
            回左缘 16px + 名称（原型 `padding:16px 16px 20px`）。 */}
        <div
          className={cn(
            'flex h-[72px] shrink-0 items-center gap-2.5 pt-4 pb-5 transition-[padding] duration-200 ease-out',
            collapsed ? 'pr-0 pl-[21px]' : 'px-4',
          )}
        >
          <img
            src="/brand/logo.png"
            alt=""
            className="block size-[30px] shrink-0 rounded-lg object-contain"
          />
          {!collapsed && (
            <span className="truncate text-base font-medium text-foreground">梵禾 Work</span>
          )}
        </div>

        <TooltipProvider delayDuration={200}>
          <nav
            className={cn(
              // 两态都保留 px-3（12px）水平内边距 —— 与原型 `.nav{padding:0 12px 12px}`
              // 一致：折叠态图标在 (72−24)=48px 内容区里居中，中心落 x=36；展开态条目
              // 从这里左起 10px（px-2.5），图标左缘 x=22。
              'flex flex-1 flex-col gap-3 px-3 pb-3',
              // 折叠态的子项浮层要溢出侧栏，`nav` 的裁剪必须放行，否则浮层被直接切掉。
              collapsed ? 'overflow-visible' : 'overflow-x-hidden overflow-y-auto',
            )}
          >
            {sections.map((section) =>
              section.kind === 'item' ? (
                <NavEntry key={section.item.code} item={section.item} collapsed={collapsed} />
              ) : (
                <NavGroupBlock
                  key={section.group.code}
                  section={section}
                  collapsed={collapsed}
                  closed={closedGroups.includes(section.group.code)}
                  onToggle={() => toggleGroup(section.group.code)}
                />
              ),
            )}
          </nav>
        </TooltipProvider>

        <SideFoot collapsed={collapsed} footerItems={footerItems} />
      </aside>

      {/* 折叠 / 展开按钮。两种状态是同一个按钮滑到两个坐标：展开时停在品牌行右端
          （left 192 = 240 − 16 右内边距 − 32 按钮宽），折叠时滑到 72px 侧栏的右缘上
          骑边（left 56，中心正好压在 72 上）。left 与侧栏 width 同为 200ms ease-out，
          位移与宽度变化同步，不会脱节。
          必须移出 `<aside>`：它需要骑边，而 `<aside>` 内的滚动容器会裁掉那一半。 */}
      <button
        type="button"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
        aria-expanded={!collapsed}
        title={collapsed ? '展开侧栏' : '收起侧栏'}
        className={cn(
          'absolute top-[18px] z-[45] grid size-8 place-items-center transition-[left] duration-200 ease-out',
          collapsed
            ? 'left-[56px] rounded-full border border-border bg-card text-foreground shadow-[var(--shadow-pop)] hover:bg-accent'
            : 'left-[192px] rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground',
        )}
      >
        <PanelLeft className="size-[15px]" />
      </button>
    </>
  )
}

/**
 * 导航项的一行：图标 + 名称 +（顶层占位项的「开发中」标注）。
 *
 * 三种视觉由数据决定，不由调用方临时判断：
 *   - 顶层占位项（资产、搜索）名称后跟一个「开发中」标签，对齐原型的 `.tag`；
 *   - 具名子项（综合看板、客户进度、数据看板）只有图标与名称；
 *   - 预留槽位（`slot`）用虚线图标与弱化文字，**不带**标签 —— 它的名称本身就是
 *     「功能开发中 N」，再加一个「开发中」是重复。这是原型里 `.sub.ghost` 与
 *     `.tag` 的区别，`slot` 字段就是把它带到数据层的那一位。
 */
function NavEntry({
  item,
  collapsed,
  indent = false,
}: {
  item: NavItem
  collapsed: boolean
  indent?: boolean
}) {
  const Icon = NAV_ICONS[item.code]

  const link = (
    <NavLink
      to={navPath(item.code)}
      className={({ isActive }: NavLinkRenderProps) =>
        cn(
          // 悬停「一帧到位」、不带类型 transition —— 设计稿（原型 §5 规则①）里原 UI
          // 除分段控件外所有悬停都是瞬时的，导航项是其中最典型的一处。
          // **图标对齐（按原型 `.app.collapsed .item{justify-content:center;padding:0}`）**：
          // 展开态图标左缘 x=22（nav 的 px-3 + 条目 px-2.5）；折叠态图标在 48px
          // 内容区居中，`pl-[15px]` → 18px 图标中心落 x=36。这里用 `pl-[15px]` 而
          // 不是 `justify-center`：宽度动画期间后者会让图标瞬间甩到远端再滑回，而
          // `transition-[padding]` 让图标屏幕 x 平滑走 22→27（中心 31→36），不跳位。
          'flex h-8 w-full shrink-0 items-center gap-2.5 rounded-xl transition-[padding] duration-200 ease-out',
          collapsed ? 'pr-0 pl-[15px]' : indent ? 'pr-2.5 pl-[38px]' : 'px-2.5',
          // 当前项按原型是「加 2px 字号」而不是加粗（16/400）。
          isActive
            ? 'bg-accent text-base font-normal text-foreground'
            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          !isActive && item.slot && 'text-muted-foreground-weak',
        )
      }
    >
      <Icon className={cn('size-[18px] shrink-0', indent && !item.slot && 'opacity-90')} />
      {!collapsed && (
        <>
          <span className="truncate">{item.label}</span>
          {item.planned && !item.slot && !indent && (
            <em className="ml-auto shrink-0 text-xs font-normal text-muted-foreground-weak not-italic">
              开发中
            </em>
          )}
        </>
      )}
    </NavLink>
  )

  // 展开态下名称就在链接上，再加气泡是重复；折叠态下它是唯一的名称来源。
  return collapsed ? (
    <Tooltip>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">
        {item.planned ? `${item.label}（开发中）` : item.label}
      </TooltipContent>
    </Tooltip>
  ) : (
    link
  )
}

/**
 * 一个分组：纯折叠的分组头与其子项。
 *
 * 折叠用 `grid-template-rows` 从 1fr 到 0fr，不需要预先知道内容高度。箭头是
 * 向下的 `ChevronDown`，收起时旋转 −90°（原型 `.group.closed .chev{rotate(-90deg)}`）。
 *
 * 折叠态（侧栏 72px）下子项改为浮层：点击分组头的图标弹出，顶部带一行分组名 ——
 * 浮层从侧栏「飞出」而不带标题，用户没法确认它是哪个分组的。同时只允许一个浮层
 * 打开：多个同时开着会互相压住，而且「我点的是哪一个」会变得难以判断。
 */
function NavGroupBlock({
  section,
  collapsed,
  closed,
  onToggle,
}: {
  section: Extract<NavSection, { kind: 'group' }>
  collapsed: boolean
  closed: boolean
  onToggle: () => void
}) {
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  const { group, items } = section
  const HeadIcon = NAV_GROUP_ICONS[group.code]

  if (collapsed) {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setFlyoutOpen((open) => !open)}
          aria-expanded={flyoutOpen}
          aria-label={group.label}
          title={group.label}
          // **图标对齐（按原型）**：折叠态分组图标在 48px 内容区居中，`pl-[15px]`
          // → 中心 x=36，与导航条目/底部图标同一条 x=36 垂直中轴；展开态 `px-2.5`
          // → 左缘 x=22。用 padding 过渡而非 justify-center，切换不跳位。
          className={cn(
            'flex h-8 w-full items-center rounded-xl pr-0 pl-[15px] transition-[padding] duration-200 ease-out',
            flyoutOpen
              ? 'bg-accent text-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <HeadIcon className="size-[18px]" />
        </button>
        {flyoutOpen && (
          <>
            {/* 透明遮罩：点空白处收起浮层，与原型「点外部关闭」一致。 */}
            <div className="fixed inset-0 z-30" onClick={() => setFlyoutOpen(false)} aria-hidden />
            <div className="absolute -top-1.5 left-[calc(100%+20px)] z-40 w-[190px] rounded-xl border border-border bg-popover p-1.5 shadow-[var(--shadow-pop)]">
              <div className="border-b border-border-soft px-2.5 pt-1 pb-2 text-xs text-muted-foreground">
                {group.label}
              </div>
              <div className="mt-1 flex flex-col gap-0.5">
                {items.map((item) => {
                  const Icon = NAV_ICONS[item.code]
                  return (
                    <NavLink
                      key={item.code}
                      to={navPath(item.code)}
                      onClick={() => setFlyoutOpen(false)}
                      className={({ isActive }: NavLinkRenderProps) =>
                        cn(
                          'flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm',
                          isActive
                            ? 'bg-accent text-foreground'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                          !isActive && item.slot && 'text-muted-foreground-weak',
                        )
                      }
                    >
                      <Icon className="size-[18px] shrink-0 opacity-90" />
                      <span className="truncate">{item.label}</span>
                    </NavLink>
                  )
                })}
              </div>
            </div>
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex shrink-0 flex-col gap-1">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!closed}
        aria-label={`${closed ? '展开' : '收起'}${group.label}`}
        title={`${closed ? '展开' : '收起'}${group.label}`}
        className="flex h-8 w-full shrink-0 items-center gap-2.5 rounded-xl px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <HeadIcon className="size-[18px] shrink-0" />
        <span className="truncate">{group.label}</span>
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 transition-transform duration-[180ms]',
            closed && '-rotate-90',
          )}
        />
      </button>

      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-[180ms] ease-out',
          closed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        )}
      >
        <div className="flex min-h-0 flex-col gap-1 overflow-hidden">
          {items.map((item) => (
            <NavEntry key={item.code} item={item} collapsed={false} indent />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * 侧栏底部：外观三档 + 系统设置 + 通知（编号 7）。
 *
 * 三档做成同组单选而不是「点一下切一下」的按钮：循环切换看不出有「跟随系统」
 * 这一档，用户只能靠反复点击去猜。
 *
 * **系统设置按裁决落在这里，排在通知左侧。** 它是 owner / admin 唯一的管理入口，
 * 而原型的主列表里没有它（编号文档的 11 条未覆盖到）。放在底部图标行而不是某个
 * 分组里，是为了不让「管理」看起来像「业务模块」。它仍是可路由的导航项，
 * 由 `NAV_FOOTER_CODES` 标出，因此这里不是写死一个按钮，而是按清单渲染 ——
 * 将来若把更多项移到底部，改共享包一处即可。
 */
function SideFoot({
  collapsed,
  footerItems,
}: {
  collapsed: boolean
  footerItems: readonly NavItem[]
}) {
  const { preference, setPreference } = useTheme()

  return (
    <div
      className={cn(
        'flex shrink-0 gap-2 border-t border-border-soft p-3',
        // 折叠态：底部所有图标与导航/分组同一条 x=36 垂直中轴 —— `flex-col
        // items-center` 让 48px 主题组与 32px 设置/通知整体在 72px 里居中，各自
        // 组件的图标都收在 x=36 上（原型侧栏底部此处未居中，是它的一处不一致，
        // 这里按「一条中轴」收敛补齐）；`px-0` 去掉左右内边距，上下留白取自 p-3。
        collapsed ? 'flex-col items-center gap-2 px-0' : 'items-center',
      )}
    >
      <div
        role="group"
        aria-label="外观"
        className={cn(
          'flex flex-1 gap-0.5 rounded-xl bg-secondary p-0.5',
          // 折叠态：w-12 定宽 + 父级 `items-center` 把整个分组居中（盒 [12,60]），
          // 三档按钮各自 `place-items-center` → 图标都收在 x=36，与设置/通知同线。
          collapsed && 'w-12 flex-none flex-col',
        )}
      >
        {THEME_OPTIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            type="button"
            onClick={() => setPreference(value)}
            aria-label={label}
            aria-pressed={preference === value}
            title={label}
            className={cn(
              'grid h-7 flex-1 place-items-center rounded-lg transition-[background,color] duration-200',
              collapsed && 'flex-none',
              preference === value
                ? 'bg-card text-foreground shadow-[var(--shadow-pop)]'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className="size-4" />
          </button>
        ))}
      </div>

      {footerItems.map((item) => {
        const Icon = NAV_ICONS[item.code]
        return (
          <NavLink
            key={item.code}
            to={navPath(item.code)}
            aria-label={item.label}
            title={item.label}
            className={({ isActive }: NavLinkRenderProps) =>
              cn(
                'grid size-8 shrink-0 place-items-center rounded-xl',
                isActive
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )
            }
          >
            <Icon className="size-[18px]" />
          </NavLink>
        )
      })}

      <button
        type="button"
        aria-label="通知"
        title="通知"
        className="grid size-8 shrink-0 place-items-center rounded-xl text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <span className="relative grid place-items-center">
          <Bell className="size-[18px]" />
          <span className="absolute top-1 right-[5px] size-1.5 rounded-full bg-foreground ring-[1.5px] ring-card dark:bg-m-amber" />
        </span>
      </button>
    </div>
  )
}
