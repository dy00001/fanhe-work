/**
 * 主进程与预加载脚本之间传「运行期应用版本号」的约定（T7-05）。
 *
 * ## 为什么单独一个模块，而不是把常量放 `preload.ts` 里导出
 *
 * 两端都要用到那个参数前缀，看起来放 `preload.ts` 里 `export` 最省事。**不行**：
 * 主进程一旦 `import` 那个模块，预加载脚本的模块体就会在**主进程**里执行一遍 ——
 * 包括末尾那句 `contextBridge.exposeInMainWorld('fanheDesktop', …)`。那是渲染进程
 * 才有的 API，在主进程里调用会抛错或静默变成另一个东西，而报错的位置离真正的
 * 起因很远（「主进程启动失败」，而不是「你 import 错了模块」）。
 *
 * 抽成独立模块之后，两端的依赖方向都是「→ 本模块」，谁也不会捎带上对方的副作用。
 *
 * ## 为什么走 `additionalArguments` 而不是 IPC
 *
 * 预加载脚本要在**页面脚本之前**把这个值摆到 `window.fanheDesktop` 上。IPC 是异步的，
 * 用它就得让界面先渲染一版没有版本号、再补一版 —— 而那正是这个字段要消除的
 * 「先显示一个不对的值」。
 *
 * ## 为什么这个值值得专门开一条通道
 *
 * 前端产物里那个版本号是**构建期**从仓库根 `package.json` 文本替换进去的，它回答的是
 * 「这份前端是什么时候构建的」，**不是**「用户装的是哪一版」。两者在打包链路漏掉一次
 * 重建之后就会分叉：`v0.1.2` 实测就是包里烧着 `0.1.1`，界面显示成旧版本，用户以为
 * 更新失败。而 `app.getVersion()` 读的是被打包的那份 `package.json`，**恒等于用户装的
 * 那一版**，不受构建顺序影响。
 */

/**
 * 主进程送版本号用的参数前缀。
 *
 * 没有类型系统保护这条通道（跨进程边界走的是字符串数组），所以只在这一处写字面量，
 * 两端都引用它。
 */
export const APP_VERSION_ARG_PREFIX = '--fanhe-app-version='

/** 主进程侧：把版本号拼成 `additionalArguments` 里的一项。 */
export function appVersionArg(version: string): string {
  return `${APP_VERSION_ARG_PREFIX}${version}`
}

/**
 * 预加载侧：从 `argv` 里取回版本号。
 *
 * **取不到时给空串，而不是猜一个值。** 空串会让前端回落到构建期常量 —— 那是它在
 * 浏览器态本来就要用的值。而猜一个（例如 `0.0.0`）会在界面上显示一个看起来正常、
 * 实际错误的版本号，正是这个字段要消除的东西。
 *
 * 只取**第一个**匹配项：前缀在命令行上出现两次属于配置错误，此时取先出现的那个与
 * 「谁写的在前面」一致，比取最后一个更不容易让人意外。
 */
export function readAppVersionArg(argv: readonly string[]): string {
  const found = argv.find((arg) => arg.startsWith(APP_VERSION_ARG_PREFIX))
  return found === undefined ? '' : found.slice(APP_VERSION_ARG_PREFIX.length)
}
