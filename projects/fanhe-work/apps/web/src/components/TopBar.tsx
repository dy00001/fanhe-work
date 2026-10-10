import type { AuthenticatedUser } from '@fanhe/shared'
import { LogOut, Monitor, Moon, Sun, type LucideIcon } from 'lucide-react'

import { type ThemePreference, isThemePreference } from '../lib/preferences'
import { useTheme } from '../lib/theme'
import { Avatar, AvatarFallback } from './ui/avatar'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from './ui/breadcrumb'
import { Button } from './ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'

/**
 * 主题档位对应的图标，用在切换按钮上。
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
  /**
   * 当前位置的一级导航名称。
   *
   * 面包屑目前只有一级，因为内容区还没有子页面。等 T2-03 引入路由、阶段三落地
   * 二级导航之后，这里会变成一串（一级项 / 二级项 / 当前页）。现在就把结构留成
   * `BreadcrumbList` 加单个 `BreadcrumbItem`，是为了那时只加元素、不改外层。
   */
  title: string | null
  user: AuthenticatedUser
  roleName: string
  onLogout: () => void
}

/**
 * 顶部栏。
 *
 * 高度 56px，与侧栏的品牌区同高 —— 两者的下边缘对齐，视线扫过去才是一条直线。
 * 背景取 `background` 而不是 `card`：侧栏是卡片色、顶栏与内容区同色，整块背景色
 * 构成 L 形，侧栏因此从背景里浮出来。这是方案 B 的分层方式，不用阴影。暗色下
 * 侧栏同样比背景亮（#141414 对 #0a0a0a），这个关系是刻意保持的。
 *
 * 全局搜索框**刻意保持禁用**。搜索覆盖纪要、事件与账号，是阶段三的能力；现在
 * 放一个能输入却什么都不发生的框，比放一个明确不可用的框更糟 —— 后者至少诚实地
 * 说明了当前状态。`title` 给出原因，避免用户以为界面坏了。
 *
 * 主题切换也放在这里：它是顶栏里唯一一个「改了立刻全局可见」的控件，得在常驻位置
 * 才容易被找到。配色本身由 `lib/theme.ts` 落到 `<html>` 上，组件只负责表达偏好 ——
 * 令牌怎么变是 `index.css` 的事，这里一行颜色都没写。
 */
export function TopBar({ title, user, roleName, onLogout }: TopBarProps) {
  const { preference, setPreference } = useTheme()
  const ThemeIcon = THEME_ICONS[preference]

  // 中文取首字、英文取首字母，两种都是「一个字」。不用 split 处理多字节，
  // 展开运算符按码点切分，不会把中文截成半个字符。
  const initial = [...user.displayName][0] ?? user.username.slice(0, 1).toUpperCase()

  return (
    <header className="flex h-14 shrink-0 items-center gap-4 px-6">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>{title ?? '梵禾 Work'}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="ml-auto flex items-center gap-3">
        <Input
          disabled
          placeholder="搜索纪要、事件、账号"
          title="搜索功能在阶段三实现"
          aria-label="全局搜索（阶段三实现）"
          className="h-8 w-56"
        />

        {/* 主题切换放在这里而不是账号菜单里：账号菜单里是「身份」相关的操作（看角色、
            退出登录），主题是「观感」，两者混在一起会让每次换主题都先打开一个看起来
            与主题无关的菜单。三档用单选菜单而不是「点一下切一下」的按钮：循环切换的
            按钮看不出有「跟随系统」这一档，用户只能靠反复点击去猜。 */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground"
              aria-label="切换主题"
              title="切换主题"
            >
              <ThemeIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuRadioGroup
              value={preference}
              onValueChange={(value) => {
                // Radix 给的是 string。守卫而不是断言：多一个 `as` 就少一次编译期检查，
                // 而这里的取值直接决定写进存储的内容。
                if (isThemePreference(value)) setPreference(value)
              }}
            >
              {THEME_OPTIONS.map((option) => (
                <DropdownMenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="账号菜单"
              className="rounded-full outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Avatar>
                <AvatarFallback className="bg-primary text-xs font-medium text-primary-foreground">
                  {initial}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col gap-0.5">
                <span className="truncate text-sm font-medium text-foreground">
                  {user.displayName}
                </span>
                <span className="truncate text-xs text-muted-foreground">{roleName}</span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => onLogout()}>
              <LogOut className="size-4" />
              退出登录
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
