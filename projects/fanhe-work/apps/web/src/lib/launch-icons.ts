import { isLaunchSoftware, type LaunchProfile, type LaunchSoftware } from '@fanhe/shared'
import {
  AppWindow,
  Briefcase,
  Globe,
  MessageCircle,
  MessagesSquare,
  SquareTerminal,
  Store,
  type LucideIcon,
} from 'lucide-react'

/**
 * 启动配置的表现层：图标与软件名称。
 *
 * 放在 `lib` 而不是组件内部，与 `nav-icons.ts` 同一条理由：它有两个消费方 —— 列表行
 * 与新增/编辑对话框。两处各写一份的话，加一个软件时漏改一处，表现是「列表里认得出、
 * 下拉框里认不出」，而这只有真正去配一条时才会发现。
 *
 * **软件标识在共享包，显示名与图标在这里。** 与 `navigation.ts` 的分工一致：共享包
 * 放信息架构（有哪些软件、什么算合法标识），表现层的东西放应用内。显示名换个说法
 * 不该牵动服务端校验。
 *
 * **不引品牌图标。** lucide 里没有微信、QQ 的商标图形，也不该为了这几个图标引入
 * 一套品牌资源：商标的使用有额外约束，而这里是内部工具。用语义相近的通用图标代替，
 * 并靠文字标签区分 —— 列表里认得出是哪一条就够了。
 *
 * **对外暴露的是「查找表 + 解析键」，不是「解析出组件」的函数。** 后者写成
 * `const Icon = resolve(profile)` 会被 `react-hooks/static-components` 判为「渲染期
 * 创建组件」（它无法区分「每次返回同一个模块级常量」与「每次新建一个函数」），
 * 而这条规则是对的：那种写法一旦真的返回新组件，整棵子树的状态每次渲染都会重置。
 * 项目里现有的图标消费（`NAV_ICONS[item.code]`）都是索引访问，这里保持一致。
 */

/** 用户可手动指定的图标标识。写进数据库的 `icon` 列，因此取值域要稳定。 */
export const LAUNCH_ICON_IDS = ['chat', 'group', 'shop', 'work', 'browser', 'terminal'] as const

export type LaunchIconId = (typeof LAUNCH_ICON_IDS)[number]

/**
 * 全部图标的查找表。
 *
 * 键同时容纳软件标识与图标标识 —— 两者不会重名，合成一张表之后，解析函数只需回答
 * 「用哪个键」，渲染处一行索引即可，不必在两处各写一次判空与回落。
 *
 * **不引 `Record<string, LucideIcon>`。** 键写成两个联合的并集，索引时才拿得到
 * `LucideIcon` 而不是 `LucideIcon | undefined`（项目开了 `noUncheckedIndexedAccess`），
 * 也就少一处永远走不到的 `??` 兜底。
 */
export const LAUNCH_ICONS: Record<LaunchIconId | LaunchSoftware, LucideIcon> = {
  wechat: MessageCircle,
  qq: MessagesSquare,
  qianniu: Store,
  custom: AppWindow,
  chat: MessageCircle,
  group: MessagesSquare,
  shop: Store,
  work: Briefcase,
  browser: Globe,
  terminal: SquareTerminal,
}

/** 软件的中文名。与 `LAUNCH_SOFTWARES` 一一对应，缺项会在编译期报错。 */
export const LAUNCH_SOFTWARE_LABELS: Record<LaunchSoftware, string> = {
  wechat: '微信',
  qq: 'QQ',
  qianniu: '千牛',
  custom: '自定义程序',
}

/**
 * 用户可选的图标。**用固定的标识字符串而不是让用户挑任意图标**：标识会写进数据库的
 * `icon` 列，让界面存下「某个 lucide 图标名」，等于把前端依赖的取值域固化进数据 ——
 * 升级 lucide 改名或删图标之后，那些行就成了认不出的值。
 */
export const LAUNCH_ICON_CHOICES: readonly { id: LaunchIconId; label: string }[] = [
  { id: 'chat', label: '对话' },
  { id: 'group', label: '群组' },
  { id: 'shop', label: '店铺' },
  { id: 'work', label: '工作' },
  { id: 'browser', label: '浏览器' },
  { id: 'terminal', label: '终端' },
]

const ICON_IDS: readonly string[] = LAUNCH_ICON_IDS

function isLaunchIconId(value: string): value is LaunchIconId {
  return ICON_IDS.includes(value)
}

/** 软件标识转中文名。认不出的标识原样显示，不回落成「未知」—— 原文至少能定位问题。 */
export function launchSoftwareLabel(software: string): string {
  return isLaunchSoftware(software) ? LAUNCH_SOFTWARE_LABELS[software] : software
}

/**
 * 解析一条配置该用哪个图标，返回 `LAUNCH_ICONS` 的键。
 *
 * 优先级：用户指定的图标 → 软件的默认图标 → 通用兜底。
 *
 * **认不出的标识按「没指定」处理，不报错也不显示空白。** 标识清单在前端，它会随版本
 * 演进：删掉某个选项之后，早先选中过它的那些行在库里仍留着旧标识。那时正确的表现是
 * 退回默认图标（信息量少一点，但整行仍然可读），而不是让这一行渲染不出来 —— 后者
 * 会把一个纯表现层的问题升级成「列表用不了」。
 *
 * 用 `Object.hasOwn` 而不是 `in`：后者会沿着原型链查，`'toString'` 之类的字符串会
 * 被当成有效标识，于是索引出一个函数而不是图标。
 *
 * 兜底返回 `'custom'`：它的图标就是通用的程序窗口，与「认不出是什么程序」这个处境
 * 相符，不必再为兜底单独设一个语义重复的键。
 */
export function resolveLaunchIconKey(
  profile: Pick<LaunchProfile, 'software' | 'icon'>,
): LaunchIconId | LaunchSoftware {
  if (profile.icon !== null && isLaunchIconId(profile.icon)) return profile.icon
  return isLaunchSoftware(profile.software) ? profile.software : 'custom'
}
