import { NAV_CODES, navPath, type AuthenticatedUser } from '@fanhe/shared'
import {
  CircleQuestionMark,
  ImageUp,
  LogOut,
  Monitor,
  Moon,
  Palette,
  RefreshCw,
  Settings,
  Star,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router'

import { type ThemePreference, isThemePreference } from '../lib/preferences'
import { describeUpdateLine, parseDesktopUpdateStatus } from '../lib/desktop-update'
import { currentHost } from '../lib/host'
import { cn } from '../lib/utils'
import { useTheme } from '../lib/theme'
import { useAvatar } from '../lib/use-avatar'
import { useDesktopUpdate } from '../lib/use-desktop-update'
import { useVersionCheck } from '../lib/use-version-check'
import { buildVersionDetail, buildVersionLine } from '../lib/version'
import { type UpdateNotice } from '../lib/version-check'
import { AvatarDialog } from './account/AvatarDialog'
import { Avatar, AvatarFallback, AvatarImage } from './ui/avatar'
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
import { UpdateNotice as UpdateNoticeBar } from './UpdateNotice'

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
 * 在此之上加了第六条「**更换头像**」，排在菜单最前（2026-10-15）。原型里的头像是写死的
 * 首字圆牌，这一条把它变成可自定义：选本机图片、拖动缩放裁剪、保存后立刻生效，实现在
 * `lib/avatar.ts` + `lib/use-avatar.ts` + `components/account/AvatarDialog.tsx`。
 * 放在第一条而不是排在末尾，是因为它改的正是它上面那一行里的东西（头像），与身份信息
 * 同源；排到「退出登录」旁边会让它看起来像一个与账号无关的工具入口。
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
 *
 * 版本号**上面**可能多出一行「有新版」的提示（T6-02）。它不是新增的一级界面，而是
 * 挂在那一行旁边：版本号回答「我现在跑的是哪一版」，而更新提示回答「那一版已经被
 * 换掉了」，两者是同一件事的两个时刻，分开放会让用户以为它们无关。判定与降级规则
 * 见 `lib/version-check.ts`。
 *
 * 那一行**点下去的后果按宿主不同**（T6-03b）：浏览器刷新页面，桌面外壳交给本机更新
 * 通道装完重启。见 `runUpdateNoticeAction`。
 *
 * 另外，**头像左边**还有一条独立的更新提示与更新按钮（T7-02b）。它与菜单里那一行
 * 不是重复：菜单里那行说的是「服务端已经有新版了」（提示），而这一条说的是「本机已经
 * 把它下好了、现在可以装」（动作）—— 只有后者需要用户做一个决定，所以它必须一直在
 * 视野里，不能藏在菜单后面。见 `UpdateNotice.tsx`。
 */

/**
 * 执行更新提示那一行的动作（T6-03b，T7-02b 补了「还没下载好」这一支）。
 *
 * 两个宿主做的是不同的事，**这不是美化而是事实**：
 *
 * - 浏览器态：界面来自服务端，`location.reload()` 会拿到新的前端产物。
 * - 桌面态：界面来自安装目录里的内置产物，刷新不会变。要交给外壳的更新通道 ——
 *   它把已下载的新版装上，然后应用自己退出重启。
 *
 * **`installUpdate` 被拒时不静默，也不再直接放弃。** 最常见的两种拒绝是：
 *
 * - 开发态外壳：那里通道不可用（没有 `app-update.yml`），点什么都不会发生；
 * - 真实但更常见的一种：**新版还没下载完**。菜单里那一行说的是「服务端已经有新版了」，
 *   而更新通道那边可能还在查、还在下，甚至刚失败过一次。
 *
 * 第二种情况下什么都不做，等于给用户一个点了没反应的按钮 —— 而他要做的事（把新版
 * 下下来）其实是被支持的，只是需要先踢一脚。所以这里退回一步去 `checkForUpdates()`，
 * 让下载跑起来；进度由顶栏那条提示显示（`UpdateNotice.tsx`）。
 */
async function runUpdateNoticeAction(notice: UpdateNotice): Promise<void> {
  const bridge = window.fanheDesktop
  if (notice.action === 'reload' || typeof bridge?.installUpdate !== 'function') {
    // 条件里的第二项理论上到不了（`action` 为 `install` 说明宿主判定是桌面），
    // 但它到得了就说明宿主判定与桥不一致，这时刷新是唯一还成立的动作。
    window.location.reload()
    return
  }

  try {
    const result = await bridge.installUpdate()
    if (result.ok) return

    // 还没就绪。见上面那段：把下载踢起来，而不是报一句「没准备好」。
    if (typeof bridge.checkForUpdates !== 'function') {
      console.warn(`[update] 未执行安装（${result.reason}）：${result.detail}`)
      return
    }
    const checked = parseDesktopUpdateStatus(await bridge.checkForUpdates())
    // 检查完仍然什么都没发生（开发态、冒烟态、或网络不通）时留下痕迹。这不是
    // 错误路径上的失败 —— 但那一下点击确实没有生效，日志里要看得出来。
    if (checked === null || checked.phase === 'unsupported' || checked.phase === 'error') {
      console.warn(
        `[update] 更新通道未生效（阶段 ${checked?.phase ?? '未知'}）：${checked?.detail ?? result.detail}`,
      )
    }
  } catch (error) {
    console.warn(
      `[update] 安装通道调用失败：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export function TopBar({ title, user, roleName, onLogout }: TopBarProps) {
  const { preference, setPreference } = useTheme()
  const { notice, refresh } = useVersionCheck()
  const { avatar, save: saveAvatar, remove: removeAvatar } = useAvatar(user.id)
  /* 第二份更新状态。主进程里的检查是单例，读状态走进程内 IPC，
     多一个实例只是多一次内存读取，不会多打一次 GitHub。 */
  const update = useDesktopUpdate()
  const [avatarDialogOpen, setAvatarDialogOpen] = useState(false)

  // 「更换头像」是从账号菜单里点的，而菜单收起时 Radix 会把焦点还给头像按钮 ——
  // 那一下和对话框的焦点陷阱会互相抢，症状是「对话框开着，但焦点在它外面、Esc 关不掉」。
  // 用一个 ref 标记「这次收起是为了开对话框」，在 `onCloseAutoFocus` 里放行即可。
  // 用 ref 而不是 state：它要在同一次事件里被读到，state 要等下一次渲染。
  const suppressMenuRefocus = useRef(false)

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
        {/* 更新提示与更新按钮（T7-02b）。放在头像左边、与它同一行：**只有真有可做的
            事时才出现**，所以它出现本身就是一个信号。

            为什么不放账号菜单里：菜单得先被打开才看得见，而「有新版本」是用户不会
            主动去找的事 —— 桌面工具会被开一整天，没人会为了看看有没有更新去点自己
            的头像。菜单里那一行仍然保留，它回答的是另一个问题（「本机该是什么版本」），
            但**动作**只有这里这一个。判定与轮询见 `lib/use-desktop-update.ts`。 */}
        <UpdateNoticeBar />

        {/* onOpenChange：每次打开菜单都重查一次。Electron 外壳（T6-03）会把应用
              开一整天，期间服务端可能已经发新版；只在挂载时查一次的话，菜单里的
              那一行会一直显示旧结论。挂载时那一次仍然保留（`useVersionCheck` 内部
              做了），因为第一次打开菜单时请求还没回来，用户看到的仍是空值。 */}
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) refresh()
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="账号菜单"
              // 悬停压暗一档（原型 `.avatar:hover{opacity:.88}`），不带过渡 —— 与
              // 「除分段控件外所有悬停瞬时到位」这条设计稿规则一致。
              className="rounded-full outline-none hover:opacity-[0.88] focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <Avatar className="size-8">
                {/* 自定义头像优先。没有、或者图坏掉时（Radix 会在图片加载失败后
                    自动把 Fallback 显示回来）落到首字。 */}
                {avatar !== null && <AvatarImage src={avatar} alt="" />}
                <AvatarFallback className="bg-primary text-xs font-medium text-primary-foreground">
                  {initial}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>

          <DropdownMenuContent
            align="end"
            className="w-56"
            onCloseAutoFocus={(event) => {
              if (!suppressMenuRefocus.current) return
              suppressMenuRefocus.current = false
              event.preventDefault()
            }}
          >
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

            {/* 更换头像。放在菜单第一条：它改的是上面这一行里的东西（头像），
                和身份信息同源，比「设置」更贴近用户点开菜单时想找的东西。 */}
            <DropdownMenuItem
              onSelect={() => {
                suppressMenuRefocus.current = true
                setAvatarDialogOpen(true)
              }}
            >
              <ImageUp className="size-4" />
              更换头像
            </DropdownMenuItem>

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

            {/* 更新提示（T6-02）。位置紧贴版本号行的上方，因为它与版本号是同一件事
                的两个时刻：这一行是「本机是什么」，下面那行是「本机应该是什么」。
                隔开放会让两者看起来无关，而用户看到「有新版」时最想确认的正是
                「我现在这版是多少」。

                **可点而不是纯提示。** 「刷新页面即可更新」这句话本身就是一个动作，
                给一个能按的按钮比让用户自己找刷新键更省事 —— 而它按下去做的事
                （重载当前页）在语义上恰好等于这句话，不存在「点了会发生别的
                什么」的落差。

                **只在 `outdated` 时渲染。** `same` / `ahead` / `unknown` 都返回
                null，理由见 `lib/version-check.ts`：尤其是 `unknown`（拿不到清单）
                —— 把「查不到」显示成「有更新」会让用户去找一个不存在的更新方式。

                用 DropdownMenuItem 而不是 div：它是一个动作，需要悬停底色与
                键盘焦点（可点的行不给焦点，键盘用户就够不着）。与上面「收藏」
                「帮助中心」那种「渲染但不接行为」的做法不同 —— 那是刻意不给行为，
                这里是有行为的。 */}
            {notice !== null && (
              <DropdownMenuItem
                className="flex-col items-start gap-0.5"
                title={notice.title}
                onSelect={() => {
                  // 不做 `await`：Radix 会在选中后收起菜单，而桌面态的安装会让应用
                  // 直接退出 —— 等一个注定不会 resolve 的 Promise 没有意义。
                  void runUpdateNoticeAction(notice)
                }}
              >
                <span className="flex items-center gap-2">
                  <RefreshCw className="size-4" />
                  {notice.text}
                </span>
              </DropdownMenuItem>
            )}

            <DropdownMenuSeparator />
            {/*
              手动检查入口。在这之前，唯一能触发「查一次更新」的办法是重启应用 ——
              桌面工具一开一整天，用户不会去重启，于是「有新版本」永远不出现，
              看起来就像更新功能坏了。这一行把那件事变成一个可点的动作。
            */}
            {currentHost() === 'desktop' && (
              <DropdownMenuItem
                className="flex-col items-start gap-0.5"
                onSelect={() => {
                  void update.check()
                }}
              >
                <span className="flex items-center gap-2">
                  <RefreshCw className={cn('size-4', update.busy && 'animate-spin')} />
                  {update.busy ? '正在检查更新…' : '检查更新'}
                </span>
                <span className="pl-6 text-[11px] text-muted-foreground">
                  {describeUpdateLine(update.view)}
                </span>
              </DropdownMenuItem>
            )}
            <div
              className="px-2 pt-1.5 pb-0.5 font-mono text-xs text-muted-foreground-weak"
              title={buildVersionDetail()}
            >
              {buildVersionLine()}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* 头像裁剪对话框。**渲染在 `<header>` 里、但在下拉菜单之外**：Dialog 自己
          portal 到 body，所以放在哪一层都不影响它的定位；但留在菜单内部的话，菜单
          收起时会把整棵子树一起卸载，对话框刚开就被带走。 */}
      <AvatarDialog
        open={avatarDialogOpen}
        onOpenChange={setAvatarDialogOpen}
        current={avatar}
        onSave={saveAvatar}
        onRemove={removeAvatar}
      />
    </header>
  )
}
