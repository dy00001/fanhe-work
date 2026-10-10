import type { AuthenticatedUser } from '@fanhe/shared'
import { LogOut } from 'lucide-react'

import { Avatar, AvatarFallback } from './ui/avatar'
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage } from './ui/breadcrumb'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'
import { Input } from './ui/input'

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
 * 背景取 `background` 而不是 `card`：侧栏是白色的，顶栏与内容区同色，整块浅灰
 * 构成 L 形，白色侧栏因此从背景里浮出来。这是方案 B 的分层方式，不用阴影。
 *
 * 全局搜索框**刻意保持禁用**。搜索覆盖纪要、事件与账号，是阶段三的能力；现在
 * 放一个能输入却什么都不发生的框，比放一个明确不可用的框更糟 —— 后者至少诚实地
 * 说明了当前状态。`title` 给出原因，避免用户以为界面坏了。
 */
export function TopBar({ title, user, roleName, onLogout }: TopBarProps) {
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
