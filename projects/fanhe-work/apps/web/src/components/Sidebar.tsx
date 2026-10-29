import {
  NAV_FOOTER_CODES,
  buildNavSections,
  navPath,
  type NavItem,
  type NavSection,
} from '@fanhe/shared'
import { Bell, ChevronDown, Monitor, Moon, PanelLeft, Sun, type LucideIcon } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
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
 * 当前档位匹配不到时的兜底。
 *
 * 三个合法值与 `THEME_OPTIONS` 一一对应，正常路径永远走不到这里；它能存在，是为了
 * 在类型上收住 `find()` 的 `undefined`，而不是靠 `!` 断言 ——
 * `noUncheckedIndexedAccess` 生效后，断言会把「两处定义不同步」这种真实缺陷一直
 * 藏到运行时。
 */
const THEME_FALLBACK: (typeof THEME_OPTIONS)[number] = {
  value: 'system',
  label: '跟随系统',
  Icon: Monitor,
}

/**
 * 左侧主导航。
 *
 * 结构与 `UI合并方案/梵禾Work-首页改造预览.html` 的侧栏逐条对齐，四段：
 *
 *   1. 品牌行（编号 1）：logo + 名称，高 72px —— 与顶栏同高，两条下边缘接成一条线；
 *   2. 主列表（编号 2~6）：顶层项「首页 / 资产 / 搜索」+ 四个分组；
 *   3. 底部图标行（编号 7）：外观主按钮（三档收进浮层）+ 系统设置 + 通知；
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
          // 折叠态与底部工具栏采用相同的居中布局，图标共用侧栏水平中线。
          'flex h-8 w-full shrink-0 items-center gap-2.5 rounded-xl transition-[padding] duration-200 ease-out',
          collapsed ? 'justify-center px-0' : indent ? 'pr-2.5 pl-[38px]' : 'px-2.5',
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
      {/* Radix Slot 不能直接合并 NavLink 的 className 回调，会把函数转成 DOM class 文本。
          用外层盒子承接 Tooltip 属性，让 NavLink 自己处理当前路由样式。 */}
      <TooltipTrigger asChild>
        <div className="w-full">{link}</div>
      </TooltipTrigger>
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
          className={cn(
            'flex h-8 w-full items-center justify-center rounded-xl px-0 transition-[padding] duration-200 ease-out',
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
 * 侧栏底部：外观主按钮 + 系统设置 + 通知（编号 7）。
 *
 * **外观为什么收成一个按钮。** 上一版把「跟随系统 / 浅色 / 深色」三个图标平铺在
 * 底部，轨道用 `flex-1` 吃掉整行剩余宽度：三个同等重量的图标并列，读起来像三个
 * 并列的快捷入口，而它们其实是**同一个**互斥选项的三档；同时视觉重心压向左侧，
 * 设置与通知被推到行尾。这一版收成单个主按钮，图标跟着当前档位走（当前是哪档
 * 一眼可见），三档改在浮层里展开。
 *
 * **没有退回「点一下切一下」的循环按钮。** 循环切换看不出存在「跟随系统」这一档，
 * 用户只能靠反复点击去猜。浮层保住了「一次看全三档」这个优点，只是把它收进一个
 * 动作之后。
 *
 * **浮层手写，没有引入 Radix Popover。** 依赖表里没有 `@radix-ui/react-popover`，
 * 而这里需要的东西只有三样：定位、点外部收起、进出场过渡。同样的三样在
 * `NavGroupBlock` 的折叠态浮层里已经用「透明全屏遮罩 + 绝对定位面板」实现过一遍，
 * 为省这十几行再加一个依赖不划算。
 *
 * **面板常驻 DOM，用 `inert` 切换，不靠条件渲染。** 条件渲染没有退场动画：节点在
 * 类名变化之前就被摘掉了，收起只能是硬切，而要求里明确要「收起也要过渡」。常驻的
 * 反面风险是「看不见但 Tab 得到」——`opacity-0` 的按钮依然在焦点序列里；`inert`
 * 一次解决焦点与读屏两件事（React 19 原生支持该属性），不必再叠 `aria-hidden`。
 *
 * **展开方向随侧栏状态变。** 展开态从主按钮向上展开：上方是导航区，遮住一两行
 * 导航，好过被窗口下缘截断。折叠态（72px）放不下约 124px 宽的面板，改为向右展开，
 * 与分组浮层同向。两种方向的右边界都在 210px 以内，窄视口同样不会溢出。
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
  const [appearanceOpen, setAppearanceOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelId = useId()

  // 当前档位的图标与名称。`??` 落到兜底对象而不是 `THEME_OPTIONS[0]`：
  // `noUncheckedIndexedAccess` 下下标取值是 `T | undefined`，兜底比断言干净。
  const current = THEME_OPTIONS.find((option) => option.value === preference) ?? THEME_FALLBACK
  const CurrentIcon = current.Icon

  /**
   * 收起并把焦点交还主按钮。
   *
   * 面板一 `inert`，焦点若还停在里面的某个档位上就会被浏览器丢掉（落到 `body`），
   * 键盘用户的下一次 Tab 得从头开始 —— 而他们并不知道自己「在哪」。焦点回到主按钮，
   * 位置才继续可预测。鼠标点击时这条同样跑，但按钮的焦点环走 `:focus-visible`，
   * 鼠标触发不会画出来。
   */
  const closeAppearance = () => {
    setAppearanceOpen(false)
    triggerRef.current?.focus()
  }

  // Esc 收起，并把焦点还给主按钮 —— 面板收起后焦点若停在面板里的按钮上，
  // 用户的下一次 Tab 会从一处看不见的位置开始。只在展开时挂监听：收起后它没有
  // 任何职责，留着会让每次按键都空转一次。
  useEffect(() => {
    if (!appearanceOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setAppearanceOpen(false)
      triggerRef.current?.focus()
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [appearanceOpen])

  return (
    <div
      className={cn(
        'flex shrink-0 gap-2 border-t border-border-soft p-3',
        // 折叠态：底部所有图标仍收在与导航同一的 x=36 中轴上 —— `flex-col
        // items-center` 让主按钮与 32px 设置/通知在 72px 里居中（原型侧栏底部此处
        // 未居中，是它的一处不一致，这里按「一条中轴」收敛补齐）；`px-0` 去掉
        // 左右内边距，上下留白取自 p-3。
        collapsed ? 'flex-col items-center gap-2 px-0' : 'items-center',
      )}
    >
      {/* `relative z-40` 承担两件事：浮层与遮罩的定位上下文；让主按钮压在遮罩
          之上 —— 否则展开后再点主按钮，命中的是全屏遮罩（结果同样是收起，但按钮
          的悬停反馈会先消失一帧，看起来像点空了）。 */}
      <div className="relative z-40">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => {
            setAppearanceOpen((open) => !open)
          }}
          aria-label={`外观（当前：${current.label}）`}
          aria-expanded={appearanceOpen}
          aria-controls={panelId}
          title={`外观：${current.label}`}
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-xl transition-[background,color,box-shadow] duration-200',
            // 展开态额外加一圈描边。浅色下 `--accent` 与 `--secondary` 同值
            // （#f4f4f5），只换底色区分不开「悬停在按钮上」与「面板已展开」，
            // 描边是这里唯一稳定的差异。
            appearanceOpen
              ? 'bg-secondary text-foreground ring-1 ring-border'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}
        >
          <CurrentIcon className="size-[18px]" />
        </button>

        {appearanceOpen && (
          // 透明遮罩：点面板以外的任何位置都收起，与分组浮层同一手法。不用全局
          // click 监听，是因为「面板内部点击不关闭」那条判断得逐个事件做冒泡比对，
          // 而遮罩把这层判断交给了布局本身。
          <div className="fixed inset-0 z-30" onClick={closeAppearance} aria-hidden />
        )}

        <div
          id={panelId}
          role="group"
          aria-label="外观"
          // 收起的浮层整块 inert：不可聚焦、不进无障碍树。视觉上由 `opacity-0`
          // 加 `pointer-events-none` 双重兜底。
          inert={!appearanceOpen}
          className={cn(
            // 过渡属性里写 `scale` 而不是 `transform`：Tailwind 4 把 `scale-95`
            // 编译成独立的 `scale` 属性（不是 `transform: scale()`），写错名字的
            // 后果是透明度在淡、尺寸却硬跳 —— 只测颜色和终值断言看不出来。
            'absolute z-40 flex gap-1 rounded-xl border border-border bg-popover p-1 shadow-[var(--shadow-pop)] transition-[opacity,scale] duration-150 ease-out',
            collapsed
              ? 'bottom-0 left-[calc(100%+10px)] origin-left'
              : 'bottom-[calc(100%+8px)] left-0 origin-bottom-left',
            appearanceOpen ? 'scale-100 opacity-100' : 'scale-95 opacity-0',
          )}
        >
          {/* 轨道沿用原三档的观感：底槽 + 选中档抬起成一块白。悬停与选中因此分得
              很开 —— 悬停只换图标颜色，选中是整块浮起，两者不会互相冒充。三档
              等宽（size-8）、间距统一为 4px，与主按钮同级，排列不挤不叠。 */}
          <div className="flex gap-1 rounded-lg bg-secondary p-1">
            {THEME_OPTIONS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setPreference(value)
                  // 选完即收：面板停在底部会压住导航，而这里也没有第二个待改项。
                  closeAppearance()
                }}
                aria-label={label}
                aria-pressed={preference === value}
                title={label}
                className={cn(
                  // `box-shadow` 一并过渡：选中档的「抬起」是靠阴影表达的，不带上
                  // 它，切换档位时底色滑过去而阴影是硬切的。
                  'grid size-8 place-items-center rounded-lg transition-[background,color,box-shadow] duration-150',
                  preference === value
                    ? 'bg-card text-foreground shadow-[var(--shadow-pop)]'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-[18px]" />
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* 设置与通知紧接在主按钮右侧，不再用 `ml-auto` 推到行尾。
          上一版把它们推到右侧是为了填满「三个外观按钮平铺」时的整行宽度；外观收成
          一个 32px 按钮后，这份推力在中间留下近百像素的空洞，三个图标被拆成左右两
          摊，读起来像两组无关的控件。现在三项共用父级 `gap-2`，从左依次排开，间距
          与图标尺寸都一致。折叠态本来就是 `flex-col` 一列居中，不需要额外处理。 */}
      <div className={cn('flex items-center gap-2', collapsed && 'flex-col')}>
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
    </div>
  )
}
