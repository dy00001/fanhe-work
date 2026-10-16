import { isLaunchSoftware, type LaunchProfile, type LaunchSoftware } from '@fanhe/shared'

/**
 * 实例卡的「真实程序图标」与品牌色（§2.9）。
 *
 * ## 这一版推翻了原先的取舍
 *
 * `lib/launch-icons.ts` 里那套通用 lucide 图标（`MessagesSquare` 代表 QQ、`MessageCircle`
 * 代表微信……）当年的理由是「不引品牌图标：商标有额外约束」。代价是**每枚图标都认不出是
 * 哪个软件** —— 配了 7 条就是 7 枚形状各异的通用图标，只有下面那行小字能区分。
 * 用户已拍板改为取程序自己的图标：与桌面快捷方式同源（同一套 `app.getFileIcon`），
 * 图形元素与配色天然一致，而且**自定义程序也有图可出** —— 不依赖我们预先认识它，
 * 这是通用图标方案给不了的。
 *
 * 通用图标仍然保留，但降级为**回落**：外壳没起来（浏览器态）、图标没取到（路径失效、
 * 文件被占用）时用它。`launch-icons.ts` 的解析优先级与那份查找表因此一处不动。
 *
 * ## 品牌色为什么在这里、而不是从图标里算
 *
 * 「按品牌色配浅底」需要知道每枚图标的主色。从取回的位图里统计主色当然更通用，但
 * 结果不稳定（QQ 图标里白底占比最大，算出来会是白），而且要在渲染进程里过一遍 canvas。
 * 已知的四个软件标识在共享包里是**封闭枚举**，直接给一张表更准、更便宜，也能单测。
 * 认不出的标识（库里可能留着旧值）回落到中性色 —— 与 `resolveLaunchIconKey` 的
 * 「认不出就退回默认」同一条取舍：不报错、不空白，整行仍然可读。
 */

/**
 * 品牌色。取值是把各家官方色压深到与 `--m-teal` / `--m-blue` 同一明度档的结果 ——
 * 它同时承担两件事：`color-mix` 里那层浅底的色相，以及**回落图标的前景色**。
 * 直接用官方原色（如微信 `#07c160`）在浅色主题下当文字色对比度不够。
 *
 * `custom` 没有品牌色，给中性灰蓝：它是「认不出是什么程序」的兜底，不该假装有品牌。
 */
export const LAUNCH_BRAND_HUES: Record<LaunchSoftware, string> = {
  wechat: '#0b7a43',
  qq: '#0d6ea8',
  qianniu: '#a8500a',
  custom: '#5b6472',
}

/**
 * 解析一条配置的品牌色（纯函数）。
 *
 * 认不出的软件标识按 `custom` 处理 —— 与 `resolveLaunchIconKey` 同一条理由：
 * 标识清单随版本演进，早先写进库里的旧值不该让这一行渲染不出来。
 */
export function resolveLaunchBrandHue(profile: Pick<LaunchProfile, 'software'>): string {
  const software = profile.software
  return isLaunchSoftware(software) ? LAUNCH_BRAND_HUES[software] : LAUNCH_BRAND_HUES.custom
}

/** 桥回传的一条图标。与 `apps/desktop/src/preload.ts` 的 `LaunchIconEntry` 同形。 */
export type LaunchIconEntry = {
  path: string
  dataUrl: string | null
}

/**
 * 把桥回传的条目表编成「小写路径 → dataUrl」的查找表（纯函数）。
 *
 * **键用小写**：Windows 路径大小写不敏感，而同一份安装被两条配置指向时（QQ 与 QQ2），
 * 用户填的两条路径大小写很可能不同 —— 不归一就会有一条查不到、白白回落。
 *
 * 取不到（null / 空串）的条目直接不入表，让查询侧统一走 `?? null`，不必在每次渲染里
 * 判两次空。重复路径以**先出现**的为准：桥侧已按路径去重，真出现重复只会是同一份图，
 * 谁先谁后没有区别。
 */
export function indexLaunchIconUrls(entries: readonly LaunchIconEntry[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || entry.path === '') continue
    if (typeof entry.dataUrl !== 'string' || entry.dataUrl === '') continue
    const key = entry.path.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(out, key)) continue
    out[key] = entry.dataUrl
  }
  return out
}

/**
 * 从查找表里取一条配置的图标（纯函数）。没有则 null，调用方回落内置图标。
 *
 * 用 `Object.hasOwn` 而不是直接索引：路径可能长得像原型链上的键名，直接索引会取出
 * 一个函数而不是图片地址（与 `launch-icons.ts` 里 `resolveLaunchIconKey` 同一条防范）。
 */
export function pickLaunchIconUrl(
  profile: Pick<LaunchProfile, 'executablePath'>,
  index: Readonly<Record<string, string>>,
): string | null {
  const key = profile.executablePath.trim().toLowerCase()
  if (key === '') return null
  return Object.prototype.hasOwnProperty.call(index, key) ? (index[key] ?? null) : null
}

/**
 * 托盘里那一排卡的图标位尺寸（CSS 像素）。
 *
 * 图标盒 36（`size-9`，与右侧模块卡同度量），真图标在里面留 6 一圈 —— 24 正好。
 * 取回的源图是 48×48（外壳侧 `size: 'large'`），2 倍屏下 48 设备像素**正好一对一**，
 * 不放大也不缩小。用 `<img>` + `object-contain` 而不是当背景图：前者在长宽比不是 1:1
 * 的图标上会按比例缩放并居中，**不会拉伸**（用户明确要求「保持原始长宽比不失真」）。
 */
export const LAUNCH_APP_ICON_SIZE = 24
