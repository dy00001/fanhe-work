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
    /** 主动查一次更新（只检查，不下载、不安装）。 */
    checkForUpdates: () => Promise<unknown>
    /** 开始下载已发现的新版；立即返回，进度靠 `getUpdateStatus` 轮询。 */
    downloadUpdate: () => Promise<unknown>
    /** 安装已下载的新版并退出应用；没有就绪的包时返回 `not_ready`。 */
    installUpdate: () => Promise<{ ok: true } | { ok: false; reason: string; detail: string }>
    /**
     * 启动一条配置（传整条 profile）。结构见 `apps/desktop/src/preload.ts` 的
     * `LaunchRunResult`：成功时 `data` 的字段与 HTTP 端点返回的 `RunLaunchProfileResponse`
     * 完全一致，失败时 `reason` 是机器可读码、`detail` 是可展示文案。
     */
    runLaunchProfile: (profile: import('@fanhe/shared').LaunchProfile) => Promise<
      | {
          ok: true
          data: { profileId: string; pid: number; startedAt: string; deduplicated: boolean }
        }
      | { ok: false; reason: string; detail: string }
    >
    /**
     * 批量启动一组配置（桌面态）。结构见 `apps/desktop/src/preload.ts` 的
     * `LaunchRunManyResult`：每条独立成功/失败，汇总给成功数与失败数。
     */
    runLaunchProfiles: (profiles: import('@fanhe/shared').LaunchProfile[]) => Promise<{
      results: { profileId: string; ok: boolean; pid?: number; reason?: string; detail?: string }[]
      summary: { total: number; success: number; failed: number }
    }>
    /**
     * 一键检测本机路径（2.5，桌面态）。结构见 `apps/desktop/src/preload.ts` 的
     * `LaunchPathDetectResult`：返回首选命中 + 候选清单。`extraPath` 是用户已填过、想
     * 顺带校验的路径。浏览器里没有本机文件系统，这条通道只有外壳场景有意义。
     */
    detectLaunchPath: (
      software: string,
      extraPath?: string,
    ) => Promise<{
      software: string
      preferred: string | null
      candidates: string[]
      agentAvailable: boolean
      detail?: string
    }>
    /**
     * 按启动同款实现、批量检查一组配置的路径可用性（桌面态）。结构见
     * `apps/desktop/src/preload.ts` 的 `LaunchDiagnosticsResult`。
     *
     * 桌面态下 `loadLaunchStatuses` 用它覆盖服务端算出来的 `pathState` —— 路径是本机
     * 事实，服务端（容器）看不见本机绝对路径。只取本模块用得到的字段声明。
     */
    checkLaunchProfiles: (profiles: unknown) => Promise<{
      agentAvailable: boolean
      total: number
      okCount: number
      diagnostics: {
        index: number
        profileId: string
        name: string
        executablePath: string
        reason: 'agent_unavailable' | 'invalid_profile' | 'path_unavailable'
        detail: string
      }[]
    }>
    /**
     * 批量取可执行文件的真实图标（§2.9，桌面态）。结构见 `apps/desktop/src/preload.ts`
     * 的 `LaunchIconResult`。传绝对路径；`.lnk` 拿不到目标的图标（那是系统的通用快捷
     * 方式图标），要传快捷方式指向的那个 exe。
     *
     * 浏览器里没有本机文件系统，这条通道只有外壳场景有意义 —— 界面据此回落内置图标。
     */
    getLaunchIcons: (
      paths: string[],
    ) => Promise<{ icons: { path: string; dataUrl: string | null }[] }>
    /**
     * 查一组配置的凭据状态（P1，桌面态）。结构见 `apps/desktop/src/preload.ts` 的
     * `CredentialStatusReply`。
     *
     * **没有读取明文密码的姊妹方法，这是刻意的**：密码只在主进程内解密（P2 自动填表
     * 那一刻），不过 IPC 回传。这里的账号是掩码形式，密码框恒为空，「改没改」由调用方
     * 意图决定。
     *
     * 浏览器里没有本机凭据库，这条通道只有外壳场景有意义 —— 界面对应的输入区在浏览器
     * 态降级成一句提示（见 `lib/credential.ts`）。
     */
    getCredentialStatus: (profileIds: string[]) => Promise<{
      items: {
        profileId: string
        state: 'none' | 'saved' | 'undecryptable'
        accountMasked: string | null
        label: string
      }[]
      /** 本机系统加密是否可用。不可用时保存必然失败，界面据此决定显不显示密码输入区。 */
      encryptionAvailable: boolean
    }>
    /**
     * 保存一条凭据（P1，桌面态）。入参同 `apps/desktop/src/preload.ts` 的
     * `CredentialSaveInput`；同 `profileId` 重复保存是覆盖。加密不可用时返回
     * `reason: 'encryption_unavailable'` 且不落明文。
     */
    saveCredential: (input: {
      profileId: string
      account: string
      password: string
      label?: string | undefined
    }) => Promise<{ ok: true } | { ok: false; reason: string; detail: string }>
    /**
     * 删掉一条凭据（P1，桌面态）。软删除幂等：本来就没有也返回 `ok`。
     */
    deleteCredential: (
      profileId: string,
    ) => Promise<{ ok: true } | { ok: false; reason: string; detail: string }>
    /**
     * 打开采集浏览器的登录窗口（桌面态）。结构见 `apps/desktop/src/ops-shop-login.ts`
     * 的 `ShopLoginResult`。
     *
     * 失败时会带 `command`：安装包不含 `tools/collector`，`collector_missing` 在安装态
     * 是常态，界面要能把手工命令显示出来，而不是给一个点了没反应的按钮。
     */
    openShopLogin: (code: string) => Promise<
      | { ok: true; command: string; note?: string }
      | {
          ok: false
          reason: string
          message: string
          command: string
          /** 采集器配置文件该放哪；界面据此告诉用户写哪个文件。 */
          configPath: string | null
        }
    >
  }
}
