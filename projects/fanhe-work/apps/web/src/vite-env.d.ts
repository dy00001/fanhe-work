/// <reference types="vite/client" />

/**
 * 构建期注入的常量，取值见 `vite.config.ts` 的 `define`。
 *
 * 在这里声明而不是在 `lib/version.ts` 里就地声明：它们是**全局**标识符（`define`
 * 做的是源码文本替换，不是模块导入），声明放在模块里会让人以为要从那个模块导入。
 *
 * 类型都是 `string` 而不是字面量联合：取值来自构建过程，编译器不可能知道具体是什么。
 * 运行时缺值（例如直接把 `src/lib` 拿给 Node 跑测试）由 `lib/version.ts` 兜底，
 * 不在这里声明成可选 —— 声明成可选会让每个使用点都要写一次判空。
 */
declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
declare const __COMMIT_SHA__: string

/**
 * 桌面外壳暴露的桥（T6-03b）。
 *
 * **权威定义在 `apps/desktop/src/preload.ts` 的 `desktopBridge`。** 这里只声明 web
 * 真正用到的那几个方法，而不是把对方整个类型搬过来：web 与 desktop 是两个包，
 * web 不依赖 desktop（壳反过来依赖 web 的构建产物），所以没有可以共享的类型来源。
 *
 * 只声明子集是刻意的：桥多几个方法对 web 没有影响，而**少**一个会在编译期就报错 ——
 * 那正是我们要的失败方向。若哪天这里与 preload 对不上，症状是类型检查报某个方法
 * 不存在，而不是运行时才发现调用了一个 undefined。
 *
 * `isDesktopShell` 是必填的 `true`：它存在的意义就是让页面能回答「我在外壳里吗」，
 * 而判定逻辑（`lib/host.ts`）要求它必须是布尔真值 —— 声明成 `boolean` 会让
 * `=== true` 那个判断看起来多余。
 */
interface Window {
  fanheDesktop?: {
    isDesktopShell: true
    /** 更新通道当前状态。结构见 `apps/desktop/src/update.ts` 的 `UpdateStatus`。 */
    getUpdateStatus: () => Promise<unknown>
    /** 主动查一次更新（只检查并下载，不安装）。 */
    checkForUpdates: () => Promise<unknown>
    /** 安装已下载的新版并退出应用；没有就绪的包时返回 `not_ready`。 */
    installUpdate: () => Promise<{ ok: true } | { ok: false; reason: string; detail: string }>
  }
}
