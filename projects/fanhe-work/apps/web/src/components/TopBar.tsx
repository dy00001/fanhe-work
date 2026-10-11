import { NAV_CODES, navPath, type AuthenticatedUser } from '@fanhe/shared'
import {
  CircleQuestionMark,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Settings,
  Star,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router'

import { type ThemePreference, isThemePreference } from '../lib/preferences'
import { useTheme } from '../lib/theme'
import { buildVersionDetail, buildVersionLine } from '../lib/version'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from './ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

/**
 * 主题档位对应的图标。
 *
 * 按**偏好**而不是按当前生效的配色取图标：选了「跟随系统」就一直是那个显示器图标，
 * 即便此刻系统是深色。若让图标跟着实际配色走，「跟随系统」与「深色」两个档位会显示
 * 同一个图标，用户看不出自己选的是哪一个。
 */
const THEME_ICONS: Record<ThemePreference, LucideIcon> = {
  system: Monitor,
  light: Sun,
  dark: Moon,
}

/** 档位名称。顺序即菜单顺序：默认档在最前。 */
const THEME_OPTIONS: readonly { value: ThemePreference; label: string }[] = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
]

type TopBarProps = {
  /** 当前位置的一级导航名称。未匹配到导航时传 null，回落为应用名。 */
  title: string | null
  user: AuthenticatedUser
  roleName: string
  onLogout: () => void
}

/**
 * 顶部栏。
 *
 * 高度 72px，与侧栏的品牌行同高 —— 两者的下边缘对齐，视线扫过去才是一条直线。
 * 背景取 `background` 而不是 `card`：侧栏是卡片色、顶栏与内容区同色，整块背景色
 * 构成 L 形，侧栏因此从背景里浮出来。这是方案 B 的分层方式，不用阴影。暗色下
 * 侧栏同样比背景亮（#141414 对 #0a0a0a），这个关系是刻意保持的。
 *
 * 顶栏只留面包屑与头像（编号 8）：左侧面包屑、右侧头像，中间不承载内容。全局搜索
 * 框移到了侧栏（成为一级导航项「搜索」），主题切换移到了侧栏底部（编号 7）。
 *
 * **头像菜单按原型补齐为五项**：设置 / 收藏 / 外观（二级三档）/ 帮助中心 / 退出登录。
 * 上一版只有「外观 + 退出登录」，是自作的收敛，与原型不符，这次还原。
 *
 * 三处行为差别是刻意的，不是漏做：
 *   - **设置**指向系统设置页。本项目里它真实存在（`/system-settings`），原型只是个
 *     静态按钮；能接上的就接上，不去发明一个空按钮。
 *   - **收藏 / 帮助中心**保持原型的样子：渲染出来，点了不响应。它们在项目里没有
 *     对应页面，凭空指向一个地址比不响应更糟 —— 那会让人以为功能已经存在。
 *   - **外观**是二级菜单，与侧栏底部的三档是**同一份状态**，改哪边另一边都跟着变。
 *
 * 菜单最底部还有一行**版本号**（`v0.1.0 · 2026-10-12 · a1b2c3d`），不可点，悬停给出
 * 完整说明。取值与更新方式见 `lib/version.ts` 顶部注释 —— 一句话是：改仓库根
 * `package.json` 的 `version` 一处，重新构建即生效，提交号与构建时刻自动跟随。
 */
export function TopBar({ title, user, roleName, onLogout }: TopBarProps) {
  const { preference, setPreference } = useTheme()

  // 中文取首字、英文取首字母，两种都是「一个字」。不用 split 处理多字节，
  // 展开运算符按码点切分，不会把中文截成半个字符。
  const initial = [...user.displayName][0] ?? user.username.slice(0, 1).toUpperCase()

  return (
    <header className="flex h-[72px] shrink-0 items-center gap-4 px-5">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage className="text-base font-medium">
              {title ?? '梵禾 Work'}
            </BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="账号菜单"
              className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Avatar className="size-8">
                <AvatarFallback className="bg-primary text-xs font-medium text-primary-foreground">
                  {initial}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">
                  {user.displayName}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {roleName} · {user.username}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />

            <DropdownMenuItem asChild>
              <Link to={navPath(NAV_CODES.SYSTEM_SETTINGS)}>
                <Settings className="size-4" />
                设置
              </Link>
            </DropdownMenuItem>

            {/* 原型里「收藏」是一个静态按钮，本项目尚无对应页面。保留原样渲染、
                不接任何行为：凭空指向一个地址会让人以为功能已经存在。 */}
            <DropdownMenuItem>
              <Star className="size-4" />
              收藏
            </DropdownMenuItem>

            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Palette className="size-4" />
                外观
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup
                  value={preference}
                  onValueChange={(value) => {
                    // Radix 给的是 string。守卫而不是断言：多一个 `as` 就少一次编译期
                    // 检查，而这里的取值直接决定写进存储的内容。
                    if (isThemePreference(value)) setPreference(value)
                  }}
                >
                  {THEME_OPTIONS.map((option) => {
                    const Icon = THEME_ICONS[option.value]
                    return (
                      <DropdownMenuRadioItem key={option.value} value={option.value}>
                        <Icon className="size-4" />
                        {option.label}
                      </DropdownMenuRadioItem>
                    )
                  })}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* 同「收藏」：原型有、项目无，保持渲染不接行为。 */}
            <DropdownMenuItem>
              <CircleQuestionMark className="size-4" />
              帮助中心
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onLogout()}>
              <LogOut className="size-4" />
              退出登录
            </DropdownMenuItem>

            {/* 版本号。放菜单最底部：它属于「我是谁 / 我在哪一版」这类账号元信息，
                与上一条身份信息同源；而它需要被随时查到、又不需要被随时看到，
                菜单是这两条的交点。
                不可点，因此用 div 而不是 DropdownMenuItem —— 后者带悬停底色与
                键盘焦点，会让一行纯信息看起来像一个能按的按钮。
                `title` 给出完整说明（含 UTC 标注与提交号），菜单里那一行保持短。 */}
            <DropdownMenuSeparator />
            <div
              className="px-2 pt-1.5 pb-0.5 font-mono text-xs text-muted-foreground-weak"
              title={buildVersionDetail()}
            >
              {buildVersionLine()}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
