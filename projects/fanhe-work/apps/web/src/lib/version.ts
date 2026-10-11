/**
 * 版本号的展示层。
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
  version: string = APP_VERSION,
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
  version: string = APP_VERSION,
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
