/**
 * 版本号的展示层。
 *
 * ## 两个来源，各回答一个问题
 *
 * | 来源 | 回答的问题 |
 * | -- | -- |
 * | `__APP_VERSION__` 等**构建期注入**的常量 | 「**这份前端产物**是哪一版、什么时候、从哪个提交构建的」 |
 * | `resolveAppVersion()` 里外壳给的**运行期**值 | 「**用户装的**是哪一版」 |
 *
 * 界面上「本机是哪一版」用第二个。两者在打包链路漏掉一次前端重建之后就会分叉，
 * 而分叉的表现是界面显示一个**旧版本号** —— `v0.1.2` 实测就是这样（包里烧着 `0.1.1`）。
 * 浏览器态没有外壳，回落第一个值；而它在网页端恰好是对的（详见 `resolveAppVersion`）。
 *
 * ## 构建期常量为什么仍然保留
 *
 * 它**不是**被前者取代就完了：它说明「这份产物是哪一版」，排查「用户报的问题在哪次
 * 构建之后出现」时只有它能对上。它也是网页态唯一的版本来源。
 *
 * 三个值都是**构建期注入**的常量（见 `vite.config.ts` 的 `define`），不是运行时读来的：
 * 版本号来自仓库根 `package.json`，构建时刻与提交短号由构建过程当场算出来。这样做的好处
 * 是界面上显示的版本与「这个包是用哪份代码、什么时候构建的」严格对应 —— 运行时去问服务端
 * 或读文件都可能拿到与当前这份 bundle 无关的值。
 *
 * **`typeof` 守卫不是防御性代码。** 这三个标识符由打包器做文本替换而来，而 `src/lib`
 * 下的模块也会被 Node 直接跑（见 `test/*.test.mjs`，前端构建不进 dist，测试直接测源码）。
 * 那种环境下标识符根本不存在，裸引用会抛 `ReferenceError`；`typeof` 对未声明的标识符
 * 返回 `'undefined'` 而不抛错，于是这里退化成占位值，格式化函数照样可以单测。
 *
 * **格式化与取值分开。** 几个 `build*` / `format*` 都是纯函数，入参齐全；默认参数只
 * 负责把注入值喂进去。这样测试可以钉住「空构建时间不留空档」「跨时区日期不串天」
 * 这类边界，而不必去改构建常量。
 */

const INJECTED_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0'
const INJECTED_BUILD_TIME: string = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : ''
const INJECTED_COMMIT_SHA: string = typeof __COMMIT_SHA__ === 'string' ? __COMMIT_SHA__ : ''

/** 产品版本号，裸 semver，与仓库根 `package.json` 的 `version` 同源。 */
export const APP_VERSION = INJECTED_VERSION

/** 构建时刻，ISO 8601（UTC，带 `Z`）。取不到时是空串。 */
export const BUILD_TIME = INJECTED_BUILD_TIME

/** 构建时的提交短号。git 不可用时是 `'unknown'`。 */
export const COMMIT_SHA = INJECTED_COMMIT_SHA

/**
 * 桌面外壳在**运行期**给出的版本号；拿不到时 `null`。
 *
 * ## 为什么需要它 —— `APP_VERSION` 回答的不是这个问题
 *
 * `APP_VERSION` 是**构建期**注入的常量，它回答的是「**这份前端产物**是什么时候、
 * 从哪个版本构建的」。而界面上「本机是哪一版」问的是「**用户装的**是哪一版」。
 * 两者在打包链路漏掉一次前端重建之后就会分叉，而分叉的表现是**界面显示一个旧版本号**：
 *
 *   `v0.1.2` 实测（2026-10-14）—— 前端 22:41 构建（当时版本号还是 `0.1.1`），
 *   版本号 22:57 才提到 `0.1.2`，安装包 22:54 打出。用户从 GitHub 装了 `0.1.2`，
 *   菜单那行显示 `v0.1.1`，看起来像更新失败。
 *
 * 外壳侧的 `app.getVersion()` 读的是**被打包的那份 `package.json`**，恒等于用户装的
 * 那一版，不受构建顺序影响。所以桌面态优先用它。
 *
 * ## 浏览器态为什么必须回落到构建期常量
 *
 * 网页端由 api 或 nginx 提供，没有外壳、也就没有这个桥。那里唯一能拿到的就是
 * 构建期注入的值 —— 而它在网页端恰好是**对的**：网页端没有「安装」这件事，
 * 「这份产物是哪一版」就是它唯一有意义的版本含义。
 *
 * ## 为什么拆成三层
 *
 * 与 `lib/host.ts` 的 `detectHost` / `currentHost` 同款：
 * `readBridgedAppVersion` 收形状、不读全局（因此能在 Node 里直接测）；
 * `runtimeAppVersion` 读全局、只做包装；`pickAppVersion` 只负责取舍。
 */
/** `window` 里我们要看的那一部分。写成独立类型，测试才能传一个普通对象进来。 */
export type AppVersionProbeTarget = {
  fanheDesktop?: { appVersion?: unknown } | undefined
}

/**
 * 从桥的形状里取版本号；取不到（字段缺失、不是非空字符串）返回 `null`。
 *
 * **只认非空字符串。** 环境变量式的注入在前端是常见做法，而 `'0'` / `0` 这类值
 * 会静默变成一个看起来正常的版本号。`null` 让调用方走回落，而回落值是浏览器态
 * 本来就要显示的东西，不会更糟。
 */
export function readBridgedAppVersion(
  target: AppVersionProbeTarget | undefined | null,
): string | null {
  if (target === undefined || target === null) return null
  const bridge = target.fanheDesktop
  if (typeof bridge !== 'object' || bridge === null) return null
  const value = bridge.appVersion
  if (typeof value !== 'string' || value === '') return null
  return value
}

/**
 * 从全局 `window` 读外壳给的版本号。拿不到（浏览器态、Node 测试）时返回 `null`。
 *
 * 与 `lib/host.ts` 的 `currentHost()` 同款：**读全局只是薄薄一层包装**，判断在
 * `readBridgedAppVersion` 里做。这样「`appVersion` 不是字符串时回落」这条不用改
 * 全局环境就能测。
 */
export function runtimeAppVersion(): string | null {
  // Node 下没有 `window`，直接读会抛 ReferenceError，而 `src/lib` 下的模块会被
  // 测试进程直接加载（见文件头关于 `typeof` 守卫的说明）。
  if (typeof window === 'undefined') return null
  return readBridgedAppVersion(window as unknown as AppVersionProbeTarget)
}

/**
 * 取舍：有运行期值就用它，否则回落构建期常量。
 *
 * 单独一个纯函数，是为了让「什么情况下该回落」这件事可测 —— 它是**判定**，
 * 不是装饰。
 */
export function pickAppVersion(runtime: string | null, built: string = APP_VERSION): string {
  // 空串与 `null` 同等对待：外壳取不到版本号时给的是空串（见 `app-version.ts`），
  // 而一个空的版本号显示出来比回落更糟 —— 那一行会变成 `v · 2026-10-14 · dd4e9e6`。
  return runtime === null || runtime === '' ? built : runtime
}

/**
 * 界面上该显示的「本机版本」：桌面态用运行期值，其余回落构建期常量。
 *
 * **所有面向用户的版本展示都必须走这里**，不要直接用 `APP_VERSION` ——
 * 那个值只说明这份产物是怎么构建的。
 */
export function resolveAppVersion(): string {
  return pickAppVersion(runtimeAppVersion())
}

/**
 * 提交短号。
 *
 * 构建期已经用 `git rev-parse --short` 取过，这里再截一次是为了兜住手工注入完整
 * 40 位哈希的情形 —— 界面上放 40 个字符会把菜单撑开，而排查时前 7 位就够了。
 */
export function shortCommit(commit: string = COMMIT_SHA): string {
  if (commit === '') return 'unknown'
  return commit.slice(0, 7)
}

/**
 * 版本标签：`v0.1.0`。
 *
 * 带 `v` 前缀是刻意的：界面上的版本号是给人看的产品标识，而 `package.json` 里的裸
 * semver 是给工具链看的。两者格式不同，转换只在这一处做 —— 各调用点自己拼 `v` 的话，
 * 迟早会有一处漏掉或写成 `version 0.1.0`。
 */
export function formatVersionLabel(version: string = APP_VERSION): string {
  return `v${version}`
}

/** 运行环境的时区偏移（分钟），含义与 `Date#getTimezoneOffset` 一致。 */
function runtimeOffsetMinutes(): number {
  return new Date().getTimezoneOffset()
}

/**
 * 把 UTC 的构建时刻换算成**本地墙钟时间**的 ISO 形态。
 *
 * 做法是「减去偏移再按 UTC 读」：`getTimezoneOffset` 返回的是「本地时间加上多少分钟
 * 得到 UTC」，所以 `utc - offset` 就是本地墙钟。这样得到的日期段与 `Date` 的各个
 * `get*` 方法一致，但可以**把偏移当参数传进来** —— 直接调 `getFullYear()` 之类会
 * 把时区钉死在运行环境上，测试只能在构建机上通过，换一台机器就红。
 *
 * **为什么不用 UTC 日期。** 构建时间戳本身是 UTC 的（`toISOString`），显示 UTC 与它
 * 同源、也省一次换算，但代价是东八区凌晨构建出来会显示成「昨天」—— 用户看到的是
 * 一个读起来像过期的日期，而它其实刚刚生成。界面上这一行是给人读的，按本地时间显示
 * 才符合直觉；精确到秒的 UTC 时刻留在 `title` 里，需要对齐构建日志时看它。
 */
function toLocalIso(buildTime: string, offsetMinutes: number): string | null {
  // 先卡形状再解析。`Date.parse` 对 `'2026-10-12'` 这种只有日期的串是**合法**的
  // （按 UTC 午夜解释），所以光靠 `Number.isNaN` 拦不住它 —— 而那正是要拦的值：
  // 构建注入的是 `toISOString()` 的完整形态，任何别的形状都说明取到的是别的东西，
  // 按日期硬解释只会得到一个看起来正常、实际来路不明的日期。
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(buildTime)) return null
  const ms = Date.parse(buildTime)
  if (Number.isNaN(ms)) return null
  return new Date(ms - offsetMinutes * 60_000).toISOString()
}

/**
 * 构建日期，本地的 `YYYY-MM-DD`。取不到时返回 `null`（调用方据此不渲染这一段）。
 *
 * 返回 `null` 而不是空串是承重的：调用方靠 `null` 决定「这一段不渲染」，返回空串
 * 会在界面上留下一个空档，看起来像渲染坏了，而它只是那段信息本来就没有。
 */
export function formatBuildDate(
  buildTime: string = BUILD_TIME,
  offsetMinutes: number = runtimeOffsetMinutes(),
): string | null {
  return toLocalIso(buildTime, offsetMinutes)?.slice(0, 10) ?? null
}

/** 构建时刻，本地的 `YYYY-MM-DD HH:mm`。取不到时返回 `null`。 */
export function formatBuildStamp(
  buildTime: string = BUILD_TIME,
  offsetMinutes: number = runtimeOffsetMinutes(),
): string | null {
  const iso = toLocalIso(buildTime, offsetMinutes)
  if (iso === null) return null
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

/**
 * 菜单里那一行：`v0.1.0 · 2026-10-12 · a1b2c3d`。
 *
 * 缺失的段直接省掉而不是留一个空档（`v0.1.0 ·  · a1b2c3d`）—— 构建时间取不到时
 * 界面上出现一个空档，看起来像是渲染坏了，而它其实只是那段信息本来就没有。
 */
export function buildVersionLine(
  version: string = resolveAppVersion(),
  buildTime: string = BUILD_TIME,
  commit: string = COMMIT_SHA,
  offsetMinutes: number = runtimeOffsetMinutes(),
): string {
  const parts = [formatVersionLabel(version)]
  const date = formatBuildDate(buildTime, offsetMinutes)
  if (date !== null) parts.push(date)
  parts.push(shortCommit(commit))
  return parts.join(' · ')
}

/**
 * 悬停时的完整说明。
 *
 * 比那一行多两样：时刻精确到分钟（那一行只到天），以及「提交」这个词 —— 单看
 * `a1b2c3d` 认不出它是提交号还是构建号。末尾再附上原始的 UTC 时刻，需要与构建日志
 * 逐秒对齐时用它；平时不必看。
 */
export function buildVersionDetail(
  version: string = resolveAppVersion(),
  buildTime: string = BUILD_TIME,
  commit: string = COMMIT_SHA,
  offsetMinutes: number = runtimeOffsetMinutes(),
): string {
  const parts = [`版本 ${version}`]
  const stamp = formatBuildStamp(buildTime, offsetMinutes)
  if (stamp !== null) {
    parts.push(`构建于 ${stamp}`)
    if (buildTime !== '') parts.push(`UTC ${buildTime}`)
  }
  parts.push(`提交 ${shortCommit(commit)}`)
  return parts.join(' · ')
}
