# 梵禾 Work 桌面端「一键启动」模块适配性改进方案

> 版本草案 v1，2026-10-15。基于 `apps/desktop`、`apps/web`、`apps/api`、`packages/shared` 现有实现撰写，不是泛化建议。
> 阅读顺序建议先读第 1 节现状盘点与第 2.1 端口一节，其余需求按需查阅。

## 0. 结论先行

七条需求里，真正卡住功能的是两条链路判断，其余多为在既有骨架上补肉。

其一，**桌面端的一键启动当前走错了宿主通道**。网页端 `runLaunchProfile` 打的是 HTTP `POST /api/launch/profiles/:id/run`，该端点被 `isLoopbackAddress` 门守（`apps/api/src/routes/launch.ts` 第 334 行）。安装态默认服务地址是云端 `https://work.fanhe.dpdns.org`（`apps/desktop/src/main.ts` 第 111 行），经 Cloudflare Tunnel 进来的连接 `remoteAddress` 非回环，启动必然返回 404。外壳其实另备了一条 `launch:run` IPC 由主进程在本机 spawn（`preload.ts` 第 168 行），但网页端从未调用它。**需求 1「任意端口、桌面端均可调用」的根因就在这里**，修法是把桌面态的启动改走 IPC，启动便与 shell 服务端口、api 服务端口全部解耦。

其二，**凭据这一步最终定为「唤起 + 点击登录」，工作台不存密码。** 用户已拍板（回填见第 5 节）：QQ 与千牛客户端自带「记住账号密码」，工作台只需唤起客户端并点一下「登录」按钮，凭据全交由客户端自己保存；微信只唤起、走扫码，不多做。这比让工作台代管密码再自动输入机密干净得多：云端库零第三方密码，也不碰自动输入机密那层风控，只保留一次轻量的「点登录」动作。第 4 条需求的实现重心因此从「怎么存密码」转成「怎么可靠地点一下登录按钮」，详见 2.4。

把这两条立住，端口兼容、并发启动、多账号、路径检测、首页重构都能在现有模型上增量落地，且不破坏「只启动配置、不启动命令」「远程不能启动本机进程」两条安全边界。

## 1. 现状盘点：这套模块今天已经有什么

避免重复造轮子之前，先把它已有的能力钉在一处，后续每条需求都对照这里判断「补什么、不改什么」。

**数据模型已是「一条一实例」。** `packages/shared/src/launch.ts` 的 `LaunchProfile` 与 `apps/api/prisma/schema.prisma` 的 `LaunchProfile` 表一一对应。一条配置等于「点一下就拉起某个客户端实例」，字段含 `software`、`name`、`executablePath`、`args`（数组，非待分词字符串）、`icon`、`sortOrder`。软件清单是 `LAUNCH_SOFTWARES = ['wechat','qq','qianniu','custom']`，刻意做成共享包常量而非数据库枚举，加软件不改表结构。**这意味着「2 个微信 + 2 个 QQ + 5 个千牛」在数据层就是 9 条记录，多账号的存储天然成立**（需求 3 的地基已就位）。

**启动链路有两种形态，且当前只用了一种。** 进程创建的唯一实现在 `apps/api/src/launch/agent.ts` 的 `runLaunchProfile`，它先复核路径（`inspectExecutablePath`）再 spawn，且必须等到 `spawn` 事件才算成功、`unref()` 交出子进程、3 秒去重窗口防连点。这份代码被两个宿主共用：

- **HTTP 形态**：`apps/api/src/routes/launch.ts` 挂 `POST /api/launch/profiles/:id/run`，请求体只带 id，路径与参数一律取库。权限用 `write`，且 `isLoopbackAddress(request.socket.remoteAddress)` 必须为真。**这是当前网页端唯一在用的路径**（`apps/web/src/lib/launch.ts` 的 `runLaunchProfile` → `runLaunchProfileRequest`）。
- **IPC 形态**：外壳主进程 `launch:run`（`apps/desktop/src/main.ts` 第 457 行）经 `paths.ts` 动态 import 同一份 `agent.ts`，在**本机** spawn。入参是整条配置对象，主进程用 `agent.ts`（desktop 侧）的 `normalizeProfile` 复核形态，防 IPC 变成本机任意命令执行入口。**这条通道已就绪，却没有网页调用方**。

**路径自检已成体系。** IPC `launch:diagnostics`（`main.ts` 第 485 行）经 `diagnostics.ts` 对配置数组逐条 `inspectExecutablePath`，返回的报告连「代理不可用」也编码成一条诊断而非错误。这条链路是需求 5「一键检测」的现成地基。

**端口与存储分区强绑定，这是既有铁律。** 界面托管在 `http://127.0.0.1:<端口>`，而 localStorage 与 IndexedDB 按 origin 分区，origin 含端口。`shell-origin.ts` 的 `shellPortCandidates` 按「偏好端口 → 旧端口（按 IndexedDB 目录 mtime 倒序）→ 固定段 41873..41880 → 0」依次试，`server.ts` 只对 `EADDRINUSE`/`EACCES` 顺延。端口稳定的意义是「更新后设置不丢」。

**凭据能力已预留位置但未实现。** `preload.ts` 注释明言「credential 的 safeStorage 迁移会在这里继续按成对方式追加通道」，`schema.prisma` 与实施方案也把「免密登录走 DPAPI / safeStorage」划为阶段四之后的事。即位置留好了，砖还没搬。

## 2. 逐条适配设计

### 2.1 端口兼容性：启动与端口解耦，走 IPC 而非 HTTP

**结论。** 让桌面态一键启动改走外壳 IPC `launch:run`，它由主进程在本机 spawn，与 shell 前端服务端口、api 服务端口均无关系，由此「任意端口、桌面端均可调用」成立。

**根因。** 现在网页端启动打 HTTP run 端点，而该端点要求来源是回环。三种部署下表现分裂：开发态 api 在 `127.0.0.1:8787`，经外壳反代的请求 `remoteAddress` 是回环，能启动；安装态默认指向云端 Tunnel，`remoteAddress` 非回环，启动必 404，而这恰是交付给用户的默认形态。用户感知是「一键启动按钮在安装版里点不动」，排查会先疑心端口，其实与端口无关，是链路选错。

**为什么不能靠「给 HTTP run 端点开放更多端口」来解。** 那道回环门是安全边界，不是Bug。它挡的是「远程 API 不能启动任何人电脑上的进程」。放开它，等于把本机进程创建能力暴露给任何能连到 api 的人。端口放开解决不了这个边界问题，只会把边界拆掉。

**改造点。** `apps/web/src/lib/launch.ts` 的 `runLaunchProfile` 改为宿主分流：检测 `currentHost()`（`lib/host.ts` 已有，判 `window.fanheDesktop.isDesktopShell`）。desktop 态先从列表取到完整 profile，调 `window.fanheDesktop.runLaunchProfile(profile)`，把返回的 `LaunchRunResult` 映射回现有界面需要的形状，错误码沿用 `launchRunRecovery` 的 `relocate`/`retry` 分流（`executable_missing` 归 relocate，其余归 retry）；browser 态维持 HTTP，且只在 api 处于回环环境时有效，UI 上应给出提示。诊断与路径检测（需求 5）同样优先走 IPC。`launchRunRecovery` 目前只认 `error.code === 'executable_missing'`，IPC 侧返回的是 `{ok:false, reason}`，需把判定扩成同时认 reason，否则桌面态路径失效会被误判成「重试」。

**顺带的正交收益。** 端口机制一行不用改。`shellPortCandidates` 继续保存储分区稳定，启动功能走 IPC 本就不依赖端口，两者各司其职，不再互相牵扯。

### 2.2 多软件并发启动：批量 run，独立 spawn，按需串行

**结论。** 新增「批量启动」能力，一次选多个实例同时拉起；默认并行、互斥量客户端可按序、单条失败不影响其余，汇总结果给明细与重试。

**改造点。** 外壳新增 IPC `launch:runMany`（或 HTTP 侧 `POST /api/launch/profiles/run-many`，同样受众号与回环门约束）。入参是一组配置（或 id 组，desktop 态配完整对象）。实现复用 `agent.ts` 的 `runLaunchProfile`，对每条独立调用、`Promise.allSettled` 收集，每条各自 `unref()`。返回聚合结构，例如 `{ results: [{profileId, ok, pid?, reason?}], summary: { success, failed } }`。

**去重窗口不要误伤批量。** `agent.ts` 的 3 秒去重按 `profile.id` 各算，批量里的不同配置互不影响，这条天然满足。但批量接口不应把「整批」当一个整体去重，否则点两次批量会把第二次全判成 deduplicated。

**启动顺序怎么给。** 多数场景并行即可，微信、QQ、千牛之间没有强依赖。但同一软件的多个实例、或共享单例锁的客户端，并行可能互相顶掉窗口。给两档：默认按 `sortOrder` 升序**发起**（不阻塞，只是排个先后）；对标注了「需串行」的软件（互斥量敏感的），逐条 `await` 前一条成功再起下一条。这一档建议在软件元数据上打标，而非对所有软件串行，否则多开千牛要被无谓拖慢。

**异常兜底。** 每条结果独立，`spawn_failed`、`executable_missing` 只落在自己那条上。汇总层对失败项给出可照做的出口，`executable_missing` 直接链到「重新指定路径」。批量启动同样要落启动记录（`history.ts`），真实尝试的成败都记、去重的不记，与单条规则一致。

**并发稳定性的边界要说清。** 主进程 spawn 的是 GUI 客户端，`stdio:'ignore'`、`windowsHide`、`unref` 已在 `agent.ts` 设好，批量只是把同一动作重复若干次，不引入新的进程管理复杂度。真正的commit是「工作台不是进程管理器」：批量拉起的客户端，其生死此后与工作台无关，关掉工作台不连带关掉它们。

### 2.3 多账号实例：存储已就绪，补「分组勾选启动」

**结论。** 数据模型无需改动即可支撑「2 微信 + 2 QQ + 5 千牛 = 9 条实例」，要补的是界面层的分组、勾选与批量启动即可，版本风险不做额外呈现。

**落地。** 每条 `LaunchProfile` 已是一个独立实例，`name` 负责区分（如「微信 · 工作号」）。需要补的是：

- 按 `software` 分组展示，允许勾选若干实例，一键走 2.2 的批量 run。这是「一键同时启动多个第三方软件」在界面上的落点。
- 是否需要新增 `group` 或 `account` 标签列。权衡是：现在用 `name` 前缀已能管理个位数实例，9 条以内加列的收益不抵一次迁移与校验的成本。建议先不加列，用分组视图 + 命名约定顶住；实例规模上来再议。
- 微信多开实际依赖客户端私有参数，逐版本变化，稳定性由客户端版本决定；QQ 多实例依赖客户端自身的账号切换行为；千牛原生多账号较稳。`args` 字段已留出填参数的位置。按已定决策，版本风险不在界面上额外提醒、不承诺「一定多开成功」，参数按需在运维侧实测后填入即可。

### 2.4 凭据与自动登录：只唤起 + 点登录，工作台不存密码（已定）

**决策已定（用户拍板，见第 5 节）。** 需求 4 收敛为两点：QQ 与千牛唤起客户端后自动点一下「登录」按钮，凭据由客户端自带的「记住账号密码」保存，工作台全程不碰密码；微信只唤起，扫码登录由用户在客户端完成。因此本方案不为任何第三方账号保存密码，也不向客户端输入机密，踩在既有边界（工作台不代管第三方密码，`schema.prisma` 第 350 行、`IMPLEMENTATION-PLAN.md` 1.2 与 6.1）的稳妥一侧。

**实现重心在「可靠地点一下登录」。** 唤起沿用 2.1 的 IPC spawn。登录点击是一个独立的、按软件开关的启动后置步骤，默认 qq / qianniu 开、wechat 关，全程 best-effort，失败即静默退回「用户手动点」，绝不阻断启动结果。这条步骤不进 `agent.ts` 的零依赖内核（那份要能原样打包随投），由外壳在 spawn 成功后按需加载。

**点登录的手段，按鲁棒性排序。**

- 首选：唤起后把刚起来的登录窗带到前台，向它发一个默认动作键（Enter）。多数登录窗的「登录」按钮正是默认按钮，Enter 等效于点它。这一手段不依赖坐标、不依赖按钮文字，最能抗客户端改版。
- 次选：窗口定位 + 受控点击（UIA 或坐标）。能精确点到具体按钮，但随客户端改版与分辨率漂移，鲁棒性差，仅当 Enter 触达不到登录时按软件单独开启。
- 明确不做：不往客户端输入账号密码、不读客户端登录态、不后台静默注入。工作台从头到尾不持有机密。

**按软件分工。** 微信只唤起，不触发登录点击（扫码登录，多点无益）。QQ、千牛走「唤起 + Enter 点登录」。自定义程序默认只唤起，用户可按需自行开启登录点击。

**辩证看待。** 这个决定把「省去每次手动点登录」的体验拿到了，又把风险面压到很小：不存密码，于是没有云端密文、没有本机密钥库要管；不输入机密，于是不触发账号风控；只多发一个按键，即便某次失效，后果仅是用户多点一下，动摇不了任何账号安全。相比早期设想的 safeStorage 存密加自动输入，它让出一点自动化程度，换来了近乎零的安全与合规敞口。

### 2.5 本地路径智能检测：复用自检底层，新增 detect IPC

**结论。** 「一键检测」= 外壳按 `software` 扫本机已知安装位置，命中可执行文件即回填；检测结果写入 `LaunchProfile.executablePath` 入库即长期保存，同类软件新增时从库中带出复用，不必重复检测。

**改造点。** 新增外壳 IPC `launch:detect`（入参 `software`，可选带一个已填路径做校验）。检测逻辑放 `agent.ts` 一侧以便单测，纯用 Node 内建，保持该文件零依赖的现状：

- 扫候选目录：`%ProgramFiles%`、`%ProgramFiles(x86)%`、`%LOCALAPPDATA%`，拼 `Tencent\WeChat\WeChat.exe` 等已知相对路径；对千牛扫 `AliWangWang`/`aliim` 系列目录。
- 用 `inspectExecutablePath` 复核命中项，返回「首选命中 + 其余候选」列表，让界面回填或让用户从候选里选。
- 读 Windows 注册表 Uninstall 键能提高命中率，但要引入 `child_process('reg query')` 或 `node-winreg`。权衡是先不上注册表，用目录扫描覆盖绝大多数默认安装；注册表作为后续可选增强，避免为检测引入跨平台依赖污染 `agent.ts`。

**注册表增强（真机反馈后补上，已实施）。** 真机实测暴露了目录扫描的原理性缺口：用户把 QQ / 微信 / 千牛 全装在自选的 `D:\软件安装目录\` 下，任何「已知路径」清单都猜不到这种目录名，于是「软件明明装了，一键检测却说没找到」。补上当时留作后续的注册表来源，且**刻意落在外壳侧独立模块 `apps/desktop/src/launch-registry.ts`**，`agent.ts` 那份零依赖内核一处不动（与 §2.4 的 `launch-login-click.ts` 同一处置思路）：

- 读三个卸载 hive（`HKLM` / `HKLM\WOW6432Node` / `HKCU` 的 `...\CurrentVersion\Uninstall\*`），取每条记录的 `DisplayName` / `InstallLocation` / `DisplayIcon`（PowerShell `ConvertTo-Json` 导出，强制 UTF-8，兼容中文 `DisplayName` 与中文路径）。
- 按软件识别：`DisplayName` 命中该软件（`QQ` / `微信|WeChat|Weixin` / `千牛|旺旺|AliWang`），主程序名精确匹配（`QQ.exe` / `Weixin.exe` / `AliWorkbench.exe` 等）从 `DisplayIcon`（可能带 `,0` 尾缀或引号）与 `InstallLocation` 根下推出候选。千牛的 `DisplayIcon` 指向卸载器、QQ 的 `InstallLocation` 为空 —— 两种形态都覆盖到。
- `agent.ts` 的 `detectLaunchPaths` 加一个通用入参 `extraCandidates`（外部来源的完整候选路径），排序为 `extraPath > extraCandidates > 目录扫描已知候选`；读注册表那点平台耦合留在外壳，不进内核。
- best-effort：非 Windows、未知 software、读不到、解析失败一律空数组，绝不抛异常，不阻断检测。

**持久化与复用。** 用户点检测、选中候选、保存配置时，命中路径即写入该条 `LaunchProfile.executablePath`，入库即长期生效。所谓「后续直接复用、无需重复检测」，实现为：新增同类 `software` 时，表单的默认路径取该用户库中该 `software` 最近一条有效配置的路径（列表匹配即可，不必另建「检测结果表」）。这样检测只做一次，之后靠库里的历史配置带出。

**与自检的分工。** detect 回答「这个软件大概装在哪、路径填什么」，回答一次配置问题；diagnostics 回答「已存的这条路径此刻还在不在」，回答运行期状态。两者共用 `inspectExecutablePath` 这一条判断，不会出现「检测说在、启动说不在」。

### 2.6 首页 UI 重构：删无效文案，已配置软件改阴影小卡 + 小图标

**结论。** 移除一键启动主卡里对不上真实数据的文案；已配置软件从「chip 选择器」改为「阴影小卡 + 小图标」，图标尺寸与风格对齐现有启动框排版。

**删除的无效文案（`apps/web/src/components/home/LaunchSection.tsx`）：**

- 主卡标题「设计软件一键登录」与副标题「打开软件的同时带过账号与授权，省去每次手动输入。」（约第 179、184 行）。这两句承诺「带过账号与授权」，而项目根本没有第三方授权数据，属于看起来确定的空话，删掉比留着误导好。这与该文件既有取舍一致：拿不到数据处宁可留白。
- 区块头副标题「授权后直接唤起本地设计软件，无需再单独登录」（约第 157 行），同属无据文案，一并清理或改成中性描述。

**已配置软件的呈现（已定，方案 C）。** 用户已拍板：小图标直接做在主卡上，AI 占位卡保持原位。据此重做主卡内部：把现有底部 chip 选择器（约第 210 行）换成一条小图标托盘，每个已配置实例一枚小图标按钮。图标复用 `lib/launch-icons.ts` 的 `LAUNCH_ICONS`（按 `resolveLaunchIconKey` 解析），容器与尺寸对齐现有 `mod-icon`（约 9x9 容器 + size-18 图标，见第 311 行），保证与整体 UI 同一套明度与圆角语言。每枚图标带三件：软件图标、图标下方小字 `name`、右上角一个路径状态点（复用现有绿/红点：`pathOk` 绿、失效红）。托盘用 `flex-wrap`，实例接近 9 条时自动换行，主卡随之增高。

**与 6 张 AI 占位卡的关系（已定）。** bento 主体结构保持不动：主卡仍跨两列、六张「开发中」AI 占位卡仍占其余格。本次只重做主卡内部（海报帧 + 小图标托盘 + 状态行 + 启动按钮），不动 AI 卡、不动栅格。改动面因此收窄到主卡一个组件，AI 卡后续的 roadmap 不受牵连。

### 2.7 交互与新增入口：小卡点击进配置/详情，末尾「+」进新增

**结论。** 每个小图标可点，进入该实例的配置修改或详情查看；区域末尾放一枚视觉一致的「+」卡，进入新增配置流程。

**改造点。**

- 小图标点击：进入该实例的配置修改 / 详情。可复用 `LaunchPanel.tsx` 已有的 `openEdit`/`handleSubmit` 与其 `LaunchProfileDialog`；但首页 `LaunchSection` 目前是只读 + 选一条启动，需把编辑能力接进来。建议把配置的增删改抽成一个共享 hook（列表加载、create/update/delete、状态刷新），首页与工作台面板两处复用，避免两套提交逻辑各自漂移。主卡大「一键启动」按钮启动当前选中（或首个）实例；批量 / 多选启动引导到工作台面板的 2.2 能力。
- 详情查看：可加一个轻量详情弹层，展示路径、参数、最近一次启动、路径是否可用，并在其中直接「启动 / 编辑 / 重新指定路径」。工作台行组件 `LaunchProfileRow` 已有这些能力，首页小卡可复用同一套交互文案。
- 托盘末尾「+」：与其它小图标同尺寸、以虚线边框区分，点击 `openCreate` 进入新增（即走完 2.5 的「一键检测 → 回填 → 保存」）。带 `personal.launch.write` 权限才渲染，只读访客不显示入口（沿用现有「藏起而非置灰」的取舍）。
- 保留区块头右侧「管理配置」链接，指向 `/workbench/launch` 完整面板，作为小卡操作之外的次级入口。

### 2.8 主卡托盘换行时的显示缺陷（2026-10-15 真机反馈，已修）

**现象。** 配置到 7 个启动程序时，主卡标题「已配置软件」整块消失、托盘首行 6 枚图标的**上沿被切平**，底部状态行与「一键启动」按钮挤在一起。

**根因（两处）。**

1. **行高写死（主因）。** 栅格写成 `grid grid-cols-4 grid-rows-[200px_128px] gap-4`，把主卡所在行锁在 200px；主卡自身是 `flex flex-col justify-end overflow-hidden`。托盘 `flex-wrap` 换到第二行后内容总高 216（标题 24 + gap 8 + 托盘 136 + gap 8 + 状态行 40）> 可用 152（200 − `py-6`×2），溢出 64px。**`justify-end` 把溢出全部推向上方**，于是 `overflow-hidden` 从**顶部**裁：标题（落在卡片上沿之上 40px）整块不可见，首行图标上沿被切平。注意诊断方向 —— 不是「内容太高被压扁」，是「顶部被切掉」。
2. **「+」卡与实例卡盒模型不一致。** 实例卡内容 = 36 图标盒 + 4 gap + 14 行高 = 54；「+」卡内容 = 18 裸 `<svg>` + 4 + `text-xs` 默认行高 16 = 38。并排时「+」的图标中线低 8px、名称高 10px（实测 `Δicon=-8`、`Δname=10`）。

**触发条件。** 托盘项数超过一行容量即触发。默认 1280 窗口 → 侧栏 240、内容区 `px-12` 96 → 栅格 944、主卡 464、内宽 432 → 一排 **6 枚 64px 卡**（`floor((432+8)/72)`）。故**第 6 个启动程序**（+「新增」= 7 项）即换行触发；窄窗口更早（`minWidth` 960 → 一排 3 枚）。§2.6 写的「实例接近 9 条时自动换行」与实际不符，已按实测改为「默认 1280 窗口下一排 6 枚」。

**修复（`apps/web/src/components/home/LaunchSection.tsx`，两处）。**

1. `grid-rows-[200px_128px]` → **`grid-rows-[minmax(200px,auto)_128px]`**：该行随内容长高，200px 只作下限。这正是 §2.6 与组件注释里「主卡随之增高」的原意 —— 原注释这么说，实现却没做到。同排两张单元卡随行拉伸，Bento 的矩形关系不变。
2. 「+」卡内层套 `<span className="grid size-9 place-items-center">` 包住 `Plus`，名称补 `leading-[14px]`，与实例卡逐值对齐（实测 `Δicon=0`、`Δname=0`，上下留白同为 5px）。

**实测对照**（Electron 无头 `capturePage` + `executeJavaScript` 量取，复现工程在 `.tmp/repro/`，未入库）：

| 档位 | 修复前 heroH / 标题 | 修复后 heroH / 标题 |
| --- | --- | --- |
| 5 程序 + 新增（6 项，一行） | 200 / 可见 | 200 / 可见 |
| 6 程序 + 新增（7 项，两行） | **200 / 整块消失**（托盘顶部被裁） | **264 / 可见** |
| 13 程序 + 新增（14 项，三行） | **200 / 整块消失** | **336 / 可见** |

**验收。** `@fanhe/web` typecheck ✅；单测 146/146 ✅；`@fanhe/desktop check:web`（产物版本闸门）✅；`@fanhe/shared`、`@fanhe/desktop` typecheck ✅。`pnpm lint`（5 个 `react-hooks/set-state-in-effect`）与 `pnpm format:check`（16 个文件）在本轮之前即为红，已用 `HEAD` 版本复现确认与本改动无关，未处理。

### 2.9 实例卡图标改为「程序自己的图标」（2026-10-15 追加，已实施）

**结论。** 首页一键启动实例卡的图标，从 `lib/launch-icons.ts` 那套通用 lucide 图标改为
**程序自己的图标** —— 外壳经 Electron 内置的 `app.getFileIcon` 取回（与系统「图标来源」
同一套实现，因此与桌面快捷方式显示的一致），底衬按品牌色配浅底。

**为什么推翻 §2.6 那句「不引品牌图标」。** 原取舍的理由是商标约束，代价是**每枚图标都
认不出是哪个软件**：配了 7 条就是 7 枚形状各异的通用图标，只有下面那行小字能区分。
用户已拍板改为取真实图标。

**为什么是取 exe 的图标、而不是内置一套品牌 SVG。** 覆盖面：真图标从 exe 里取，
**自定义程序也有图可出**，不依赖我们预先认识它 —— 预置品牌资源给不了这个（而且会把
商标资源引进仓库）。通用图标那套因此**保留为回落层**：浏览器态、或图标没取到
（路径失效、文件被占用）时用它。

**三条实测形态（决定了实现怎么写，都是踩过的）：**

1. **必须传 exe 路径，不能传 `.lnk`。** 实测 9 个不同快捷方式（GitHub / Docker Desktop /
   Cloudflare…）返回的 PNG **逐字节相同**（md5 一致）—— 那是系统的「快捷方式」通用图标，
   不是目标的图标。
2. **`size: 'large'` 出 48×48**（`normal` 32 / `small` 16）。界面按 24 CSS px 渲染，
   2 倍屏上要 48 设备像素，正好一对一。
3. **路径不存在时返回的仍是「非空」图标**（系统的通用文件图标），`isEmpty()` 区分不出来
   → **不用它判「取没取到」**。路径失效这件事由卡片右上角那个红点表达，不该由同一个
   信号承担。

**落点。**

| 层 | 文件 | 做什么 |
| --- | --- | --- |
| 外壳 | `apps/desktop/src/launch-icon.ts`（新） | 路径归一（只收绝对路径、去重、限长）+ 带缓存的取图器（**成功才缓存**、LRU 淘汰） |
| 外壳 | `apps/desktop/src/main.ts` | 新增 IPC `launch:icon`（批量；空入参直接返回，不做任何事） |
| 桥 | `apps/desktop/src/preload.ts` | 暴露 `getLaunchIcons(paths)`；`vite-env.d.ts` 补 web 侧声明 |
| 前端 | `apps/web/src/lib/launch-app-icon.ts`（新） | 品牌色表 + 查找表归一 + 查询（纯函数） |
| 前端 | `apps/web/src/lib/use-launch-app-icons.ts`（新） | 批量取、按小写路径去重缓存、**只请求没拿到的那几条** |
| 前端 | `apps/web/src/components/home/LaunchSection.tsx` | 图标位：品牌浅底 + `<img object-contain>`；取不到回落通用图标 |

**边界与取舍。**

- **一次请求取回整盘**：十几枚逐条 `await` 会在打开首页时明显卡一下；外壳那条通道本来就
  按路径数组收。**只请求「还没拿到的那几条」**，所以新增一条配置不会把已有的十几条重取。
- **失败静默回落，不弹提示**：用户不需要知道「图标没取到」，他需要的是这一行仍然可读。
- **品牌色取「压深到与 `--m-teal` / `--m-blue` 同明度档」的值**，因为它同时承担
  **回落图标的前景色** —— 直接用官方原色（如微信 `#07c160`）在浅色主题下当文字色对比度
  不够。`custom` 没有品牌色，给中性灰蓝。
- **浅底用与右侧模块卡同一条配方**（`--hue` + `--wash`，见 `.mod-icon`），明度语言两处一致。
- **`<img>` 用 `object-contain` + 定宽定高**：源图 48、显示 24，长宽比不是 1:1 的图标按
  比例缩放并居中，**不会被拉伸**（用户明确要求「保持原始长宽比不失真」）。

**验收。** `@fanhe/desktop` 单测 **210/210** ✅（新增 `test/launch-icon.test.mjs` 10 例）；
`@fanhe/web` 单测 **155/155** ✅（新增 `test/launch-app-icon.test.mjs` 9 例）；
`shared` / `web` / `desktop` 三包 typecheck ✅；`check:web` 产物版本闸门 ✅。

真机图标实测（本机）：QQ / 微信 / 千牛 / 记事本 / AutoCAD / 命令提示符 / 计算器 均取到
48×48 真图；无内嵌图标的 exe（`accoreconsole.exe`）回落 32×32 系统通用图；9 个 `.lnk`
的图标 md5 全同（证实「必须传 exe」这条）。

### 2.10 「一键登录」两个新需求的设计分析（2026-10-15 追加，**仅设计未实施**）

用户新增两条需求：**微信**扫码登录、不做账号密码，要求「配几个微信启动项就拉起几个」；
**QQ / 千牛**支持账号密码，客户端自带的「记住密码」只能记一个账号，因此要在配置页新增
账号密码记录与存储（**仅本地**），多账号时用内置脚本在相应位置自动填写并登录。

完整设计分析见 **`docs/LAUNCH-LOGIN-DESIGN-2026-10-15.md`**。这里只记与本文档直接相关的
四条结论：

1. **§2.4 的结论修正**：「只唤起 + 点登录，工作台不存密码」这条**没有被推翻**，而是把
   「工作台」的所指**收窄为「服务端 / 共享包 / 数据库」**（那是它原本就在约束的东西）。
   本机凭据库不在此列 —— 共享包原话紧跟着就写了「免密只能走 OS 凭据接口（Windows DPAPI
   或 Electron safeStorage）」，新需求正是这条被预告过的路径到了该走的时刻。**共享包与
   Prisma 均零改动**（不加密码字段、不加列），配置与凭据用本地 `profileId` 映射关联。
2. **§2.4 未闭环的「等窗口 + 有限次重试」被提升为必做项**。填表比敲 Enter 更依赖窗口
   存在，而现实现是 spawn 后立刻执行（实测恒 `no-window`）。新流程是四段：等窗口 →
   判定是登录窗 → 填表 → 等窗关闭。
3. **「密码打进聊天框」是唯一会造成真实泄露的风险点**：客户端「已登录、免登录直进主界面」
   时，填表序列会把账号密码打进聊天输入框并回车发出。必须实现「这确实是登录窗」的保守
   判据（窗口标题白名单 + UIA 密码控件，**至少命中一条**；不确定就只敲 Enter）。这是
   §8.2 的第一项，也是 P2 优先实现项。
4. **多账号的唯一正确形态是串行**，且**串行的单位是整条流水线而不是 spawn**：N 个登录窗
   同时开着时，「哪个窗口对应哪份凭据」没有可靠答案；对单实例客户端，并发 spawn 还会
   让第二条只激活第一条的窗口。千牛原生支持多开（双击即新窗口新账号），微信有互斥量，
   QQNT 待探针。3 秒去重窗口按 `profile.id` 各算，因此「配几个拉几个」天然满足。
5. **安全关键取舍**：机密**从子进程 stdin 读**，不用 `-EncodedCommand`（base64 会被
   `Win32_Process.CommandLine` 读出，且 base64 不是加密）；输入用 `SendInput` +
   `KEYEVENTF_UNICODE`，**不碰剪贴板**（避免 `Win+V` 历史持久化）也不用 UIA 定位
   （QQNT 是 Electron 应用，UIA 常是空树）；CDP 注入与驱动级模拟**明确否决**。
6. **头号风险是账号风控，无法用技术手段消除**。设计上的应对是：默认关闭、首次开启明确
   告知、失败绝不重试（`maybe-captcha` 是终态）、单次批量超过 3 条要确认。

未决项与真机探针清单见该文档 §9.2 / §10。

**P0 已实施（2026-10-15）**：用户拍板「需要自动填表」+「微信快速点击下确定可多开」，据此落地了窗口原语与批量后置编排，详见 `docs/LAUNCH-LOGIN-DESIGN-2026-10-15.md` §9.1b。要点三条：① 等窗口进脚本（带超时轮询 + 稳定期复查），「实测恒 `no-window`」随此闭环；② 微信多开后把 N 个登录窗按网格平铺（不动 z 序、不抢焦点），一个键都不敲；③ QQ / 千牛的「点登录」改为串行（并发的两条 Enter 会互相抢前台）。desktop 单测 210→243 全过，三包 typecheck 与 web/shared 单测无回归。

## 3. 对现有架构的影响面与不改动的地方

| 需求 | 主要落点 | 改动性质 |
| --- | --- | --- |
| 2.1 端口 | `apps/web/src/lib/launch.ts` 宿主分流 + `launchRunRecovery` 扩展 | 改行为，端口机制不动 |
| 2.2 并发 | 新增 IPC `launch:runMany` + HTTP `run-many`，复用 `agent.ts` | 增量，不动 spawn 核心 |
| 2.3 多账号 | 分组/勾选 UI，复用 2.2；数据模型不动 | 增量视图层 |
| 2.4 凭据 | 新增按软件开关的「登录点击」后置步骤，独立模块；不存密码 | 增量，云端库零第三方密码 |
| 2.5 检测 | 新增 IPC `launch:detect`，逻辑入 `agent.ts`，纯 Node | 增量 |
| 2.6/2.7 UI | `LaunchSection.tsx` 重构 + 抽 launch CRUD hook | 重构前端 |

**明确不改的东西。** `agent.ts` 的 spawn 核心（路径复核在前、等 `spawn` 事件才算成功、`unref`、3 秒去重、失败不进缓存）是 192 项测试钉着的稳定件，只复用不改写。`shell-origin.ts` / `server.ts` 的端口候选链是「更新后设置不丢」的地基，一行不动。两条安全边界（只启动配置不启动命令、远程不能启动本机进程）是红线，本次所有改造都在其内增量，不拆边界换功能。

**需要留意的耦合。** `launchRunRecovery` 当前只认 HTTP 的 `error.code`，接入 IPC 后要同时认 `{ok:false, reason}`，否则桌面态路径失效会被错判成「可重试」，用户被引去反复点一个注定失败的按钮。这是最容易漏、且现场最难解释的一处，改造时要一并覆盖单测。

## 4. 实施优先级与验收

**建议顺序。** 先 2.1（端口/宿主分流）与 2.2（批量 run），它们解锁「安装版真正能一键启动多个客户端」这个核心价值；再 2.5（路径检测）降低配置门槛；再 2.3/2.7（多账号视图与小卡交互）；2.4（唤起 + 点登录）依赖外部客户端行为，随版本迭代发布，默认仅 qq / qianniu 开登录点击、wechat 只唤起；2.6（UI 重构）可与交互改造合并推进。

**验收要点。**

- 2.1：安装态指向云端 api 时，一键启动仍能拉起本机客户端（证明走的是 IPC，绕过了回环门）；换任意 shell 端口重启后启动依旧可用。
- 2.2：批量启动 N 个不同实例，各自窗口出现；故意把其中一条配成失效路径，仅那一条报错并链到重指定，其余照常。
- 2.5：一键检测在本机命中微信/千牛默认安装路径并回填；断开/卸载后该条在启动自检里变红。
- 2.4：QQ / 千牛唤起后登录窗被带到前台并触发登录，微信只唤起不触发；全程无任何第三方密码入库、无任何网络上传凭据。

## 5. 风险与未决（需拍板）

1. **凭据做到哪一层（已定）。** 唤起 + 点击登录。QQ / 千牛唤起后自动点登录，凭据交给客户端自带的「记住账号密码」；微信只唤起。工作台不存密码、不输入机密。
2. **微信等扫码登录客户端的处理（已定，结合第 1 条）。** 微信只唤起，不触发任何登录点击。
3. **6 张 AI 占位卡与已配置软件卡的版面归属（已定，用户出图）。** 小图标托盘直接做在主卡上，AI 占位卡保持原位。落定细节见 2.6 方案 C。
4. **多开的版本风险呈现（已定）。** 不额外呈现，不在界面加版本敏感提示，参数按需在运维侧填入即可。
5. **凭据同步范围（已定）。** 无独立同步设计，随版本迭代发布；工作台本身不存凭据，故无同步负担。

五项未决至此全部有定论（凭据=唤起+点登录、微信只唤起、AI 卡保持原位 + 小图标上主卡、多开风险不呈现、凭据随版本迭代发布）。可以据此进入拆任务登记与编码。

---

*本方案为设计文档，未改动任何生产代码。落地前建议按第 5 节逐项与需求方确认，再据此拆任务登记。*

---

## 实施进度（2026-10-15）

设计文档已陆续进入编码。下列条目已落地并经类型检查与单测闭环：

- **§2.1 端口/宿主分流（已实施）**：`apps/web/src/lib/launch.ts` 的 `runLaunchProfile(profile)` 改宿主分流，桌面态走既有 `launch:run` IPC；`launchRunRecovery` 与 `LaunchRunError` 抽到纯模块 `apps/web/src/lib/launch-recovery.ts`，HTTP 失败与 IPC 失败共用同一套 `relocate/retry` 分流。web typecheck 绿、单测 126→130 全过。
- **§2.2 并发批量启动（已实施）**：桌面侧新增 `agent.ts` 的 `runShellLaunchProfiles`（复用 `runShellLaunchProfile`，`Promise.allSettled` 并发、每条独立、单条失败不影响其余、代理不可用逐条报 `agent_unavailable`）+ `main.ts` 的 `launch:runMany` IPC + `preload.ts` 的 `runLaunchProfiles` 桥；web 侧 `runLaunchProfiles` 宿主分流（桌面走 IPC，浏览器逐条走单条 HTTP 端点再经 `summarizeLaunchMany` 聚合，未新开服务端 `run-many` 路由——桌面是主场景，且逐条端点已含历史记录与权限）。desktop 单测 21/21、web 全量单测 130/130 通过。

- **§2.5 本地路径一键检测（已实施）**：桌面侧 `agent.ts` 新增纯函数 `knownExecutableCandidates(software, env?)`（按 `ProgramFiles` / `ProgramFiles(x86)` / `LOCALAPPDATA` 枚举已知相对路径，零依赖、与 `process.env` 解耦以便单测）与 `detectLaunchPaths(software, { extraPath?, inspect, env? })`（注入 `inspect`，复用启动同款路径判断，返回 `preferred` + `candidates`、`extraPath` 优先且去重）；`main.ts` 新增 `launch:detect` IPC（无候选可查时不加载代理，与 `launch:diagnostics` 同取舍）；`preload.ts` 新增 `detectLaunchPath` 桥 + `LaunchPathDetectResult` 类型；web 侧新增纯模块 `lib/launch-detect.ts`（`detectLaunchPath` 宿主分流：桌面走 IPC，浏览器回落空结果）并由 `lib/launch.ts` 再导出，`vite-env.d.ts` 补桥声明，并开启 `allowImportingTsExtensions` 让纯模块能被 Node 单测直接加载。desktop 单测 30/30（含 9 项检测）、web 全量单测 135/135（含 5 项检测分流）通过。持久化与复用（命中写 `executablePath`、新增同类软件带出库内最近有效路径）属后续工作台面板表单的对接，本步只落地检测通道。

- **§2.5 复用（补充，已实施）**：新增纯模块 `apps/web/src/lib/launch-suggest.ts` 的 `buildSuggestedPaths(profiles, statuses)`（同 `software` 优先 `pathState==='ok'`、同状态取 `updatedAt` 最新、全 missing 退回最近一条、best-effort、与 React 解耦以便单测）。`launch:detect` 命中后路径由表单既有保存逻辑写入 `LaunchProfile.executablePath`（保存即入库），而「新增同类软件带出最近有效路径」接在 `LaunchProfileDialog`：新增可选属性 `suggestedPaths`，新增配置且路径框为空时选中某软件即预填其反查表里的路径（编辑态或已手填一律不覆盖）。首页 `LaunchSection` 与工作台 `LaunchPanel`（共用 `useLaunchProfiles`）各自 `useMemo` 现算并传入，两处一份表格。web typecheck 绿、web 全量单测 135→141（含 6 项复用选取规则）通过。

- **§2.3 + §2.7 + §2.6 多账号分组 / 首页 UI 重构（方案 C）/ 小卡交互（已实施）**：抽共享 hook `apps/web/src/lib/use-launch-profiles.ts`（`useLaunchProfiles()` 持有 `profiles` / `statuses` / `loading` / `loadError` / `reload` / `recheckStatuses` / `createProfile` / `updateProfile` / `removeProfile` / `reorder`，列表与状态走两条独立请求——状态失败只不显示标记、不换错误页；增删改/update/reorder 内部顺手重拉状态，首页与工作台面板共用一份数据源，避免两套提交逻辑漂移）。首页 `apps/web/src/components/home/LaunchSection.tsx` 重写为方案 C：标题改「已配置软件」、删除无效「一键登录」文案；芯片选择器换小图标托盘（每实例 `size-[64px]` 卡：`LAUNCH_ICONS[resolveLaunchIconKey(profile)]` + 名称 + 右上角路径状态点、绿可用红失效、`flex-wrap`；悬停小火箭单独启动、整卡点击进编辑、末尾虚线「+」进新增仅 `canWrite` 可见）；大「一键启动」按钮启动当前选中（默认首条）；直接复用 `LaunchProfileDialog` 做新增/编辑。`apps/web/src/components/launch/LaunchPanel.tsx` 同步迁移到该 hook：删掉重复的 `profiles` / `statuses` / `reloadToken` / `statusToken` 两套 state 与模块级 `fetchLaunchProfiles` / `fetchLaunchStatuses`，保留 `LaunchProfileRow`、删除确认 `Dialog`、上移/下移、重新检查路径、顶部提示条、`hasChanges` 守卫（编辑无变化不空写），`handleRetry`→`reload`、`handleRecheck`→`recheckStatuses`、`handleLaunch` 收尾 `recheckStatuses`、`handleMove` 改传完整 id 顺序给 `reorder`、`handleDelete` 走 `removeProfile`。web typecheck 绿、web 全量单测 135/135 通过。

- **§2.4 唤起+点登录（已实施）**：新增桌面侧模块 `apps/desktop/src/launch-login-click.ts`（**不进 `agent.ts` 零依赖内核**，由 `main.ts` 在 spawn 成功后按需加载）。`shouldClickLogin(software)` 纯函数按软件开关（qq / qianniu 开、wechat / custom / 未知关，是「按软件开关」的唯一入口）；`clickLoginAfterLaunch(software, pid)` best-effort：非 Windows 直接拦下、关掉的软件不操作窗口，全程 try/catch 吞异常回报 `failed` 绝不抛、绝不阻断启动结果；`buildLoginClickScript(pid)` 用 PowerShell P/Invoke（按 pid 枚举顶层窗口挑可见首窗 + `AttachThreadInput` 绕前台锁 + `ShowWindow(SW_RESTORE)` + `SetForegroundWindow` + `keybd_event(VK_RETURN=0x0D)`）把登录窗带到前台敲 Enter，经 `-EncodedCommand` 传 base64(UTF-16LE)、5 秒超时；只发按键、不输账号密码、不读登录态、不注入，工作台全程不持机密。`main.ts` 在 `launch:run` 成功返回后 `void clickLoginAfterLaunch(software, pid)`、`launch:runMany` 按 `id` 反查 `software` 为每条成功结果 fire-and-forget。桌面 typecheck 绿、desktop 单测 167→174（含 7 项：开关映射 / 脚本含 pid 与 Enter 键码 / 非 Win 平台守门 / 关掉的软件不点）。「自定义程序用户按需自开」作为已知扩展点留在 `shouldClickLogin`（将来下放到单条 `LaunchProfile` 标志时只改这一处），本步先按软件级默认值落地。

- **§2.5 检测增强（多盘 + 注册表，已实施）**：真机反馈「软件装了却检测不到」后逐条取证，落成三件事。① 目录扫描补「所有盘的 Program Files」：新增 `windowsProgramFilesRoots()`（枚举 A–Z 盘符 × `Program Files` / `Program Files (x86)`，`existsSync` 过滤，非 Windows 天然空），`knownExecutableCandidates` / `detectLaunchPaths` 加 `extraRoots`；原来只扫环境变量那三个根（都指向系统盘 C:），装到 `D:\Program Files` 的软件永远找不到。② 候选表补版本布局：`qq` 加 `Tencent\QQNT\Bin\QQ.exe`（新版 NT 架构），`wechat` 加 `Tencent\Weixin\Weixin.exe`（4.x 改名）。③ **注册表来源**（新增模块 `apps/desktop/src/launch-registry.ts`，见上文 2.5「注册表增强」）：读三个卸载 hive 的 `DisplayName` / `InstallLocation` / `DisplayIcon`，按软件识别规则推出自定义安装目录下的主程序路径；`detectLaunchPaths` 加通用入参 `extraCandidates`（排序 `extraPath > extraCandidates > 已知候选`），`main.ts` 的 `launch:detect` 把注册表候选并入 `hasKnown` 判定与检测调用。**真机端到端实测**：QQ → `D:\软件安装目录\QQ\QQ.exe`、微信 → `D:\软件安装目录\微信\Weixin\Weixin.exe`、千牛 → `D:\软件安装目录\千牛\AliWorkbench.exe` 全部命中（此前三者均为「未找到」）。desktop typecheck 绿、desktop 单测 181→199（含 14 项注册表解析/推导/降级 + 4 项 `extraCandidates` 排序与去重）。
- **真机反馈的两处 UI 修复（已实施）**：① 「一键检测」此前只有数据通道（`detectLaunchPath` + `launch:detect` IPC + preload 桥）而 UI 层零调用 —— 补在 `LaunchProfileDialog` 路径字段下的「一键检测」按钮（`Radar` 图标 / 检测中 `LoaderCircle` 转动），命中多个时列候选切换器，`agentAvailable=false` 据实说明「需要桌面外壳」。② 首页零配置时整块托盘不渲染（`LaunchSection` 把托盘放进「有配置」分支，零配置只剩一行文字、末尾「+」与整卡点击入口整块消失）—— 改为零配置也渲染托盘（空列表 + `canWrite` 时托盘里只有那枚虚线「+」）。另修 `selectSoftware` 只在路径框为空时预填、换软件残留旧路径的「张冠李戴」（加 `pathAuto` 状态：自动填过或空则随软件换、手输过不动）。

- **路径状态改由客户端判定（已实施）**：真机症状是「同一条配置点启动成功、卡片却显示『路径失效』」。根因：`LaunchProfileStatus.pathState` 一直由**服务端**算（`apps/api` 的 `listProfileStatuses` → `inspectExecutablePath`），而服务端跑在 Linux 容器里，看不见客户端的 `D:\软件安装目录\...`，恒判 `missing`。修法与 `runLaunchProfile` 同一套宿主分流：`loadLaunchStatuses(profiles)` 在桌面态用本机自检（既有 `launch:diagnostics` IPC，用的正是**启动同款** `inspectExecutablePath`）**覆盖** `pathState`，`lastRun`/`lastSuccessAt` 仍取服务端；翻译逻辑抽成纯模块 `apps/web/src/lib/launch-status-desktop.ts` 的 `pathStatesFromDiagnostics`（代理不可用时不判断、退回服务端原值，避免把环境问题误报成路径问题）。真机日志 `自检完成 可用=2/2`。web 单测 141→146。
- **§2.4 脚本兼容 Windows PowerShell 5.1（已实施）**：`buildLoginClickScript` 里用了 `0u`（无符号整数字面量后缀，**PS 7 才支持**），系统自带的 5.1 会报 `无法将"0u"识别为 cmdlet`，脚本在 `EnumWindows` 回调里直接终止，真机表现为「登录点击 尝试=是 结果=failed」。改为 `[uint32]$x = 0`，并补回归用例断言脚本不含 `0u`/`0ul`。真机 PS `5.1.26100.9711` 复验通过。desktop 单测 199→200。

- **QQ 启动崩溃归因：与本次改动无关，系 agent 进程上下文所致（已查清）**：真机反馈「启动 QQ 报错」，QQ 自带崩溃报告（模块 `QQNT.dll`，`call_stack_hash=80000003-aa82f54b142f17ecf623bf6d2294a65d`）。逐条取证后确认**崩溃不由本模块引起**。判据是「同机、同 QQ、同环境变量，只换启动上下文」：

  | 启动上下文 | 环境 | 结果 |
  |---|---|---|
  | 我方 `spawn`（外壳主进程 / 探针，位于 agent 进程树内） | 完整 agent 环境 | **崩**（可复现） |
  | 我方 `spawn` | 最小环境（18 项） | **崩** |
  | 资源管理器双击等价（`explorer.exe <exe>`） | 正常 | **稳**（3/3） |
  | WMI `Win32_Process.Create` | 正常 | **稳**（3/3） |
  | **WMI 启动的 Node 探针 → spawn QQ** | **完整 agent 环境（193 项，含 `NODE_OPTIONS`）** | **稳** |
  | WMI 启动的最小 Electron 探针 → spawn QQ | 正常 | **稳** |

  关键对照是第 5 行：**同一份完整 agent 环境**，只要把启动上下文移出 agent 进程树，QQ 就稳定 —— 故**环境变量被排除，`NODE_OPTIONS` 不是 QQ 崩溃的原因**。真正的差异是**进程上下文**：agent 把其子进程放进了一个 Job Object（环境变量 `WORKBUDDY_APP_LIFETIME_JOB=Local\WBAppJob-…` 即其名字），QQNT 自身是 Electron 应用，其进程模型与该 Job 冲突而崩（微信是原生程序、不建 Electron 进程树，故同套 spawn 下正常）。**结论：这是开发态的产物（外壳由 agent 拉起、落在 agent 的 Job 内）；正式版由用户双击启动、不在该 Job 内，不受影响。**

  - 已排除项（逐条实测）：`NODE_OPTIONS`/`NODE_PATH`/`ELECTRON_*` 注入、`windowsHide`、`stdio:'ignore'`、`cwd`、工具沙箱（关掉沙箱仍崩）、环境变量（最小环境仍崩；而完整 agent 环境在外部上下文稳定）。
  - 附带保留的加固：`apps/api/src/launch/agent.ts` 仍新增 `buildLaunchEnv()` / `shouldStripFromLaunchEnv()` 并在 `spawn` 传 `env: buildLaunchEnv()`（剔除 `NODE_OPTIONS` / `NODE_PATH` / `NODE_REPL_EXTERNAL_MODULE` 与 `ELECTRON_*`）。这条**不是 QQ 崩溃的修因**（已证伪），但本身是正确的卫生习惯：宿主注入的 `NODE_OPTIONS=--require=<fs 劫持 shim>` 确实会被 Electron 系客户端执行（最小 Electron 探针实测 `shimLoaded=true`，剔除后 `undefined`），留着以防其它客户端踩同一坑。api 单测 232 pass / 0 fail（新增 4 项）。
  - 排查方法论（值钱）：① 崩溃判据用 **Crashpad `reports/*.dmp` 新增数**（QQ 转储在 `%APPDATA%\QQ\Crashpad\reports\`），配合进程数时间线；② 本沙箱 `spawnSync('tasklist')` 返回 **EBUSY**（同步 spawn 被拦），**必须用异步 `spawn`** 抓进程表，否则每次都得「0 行」，把「存活」误报成「崩溃」——本轮第一版结论正栽在此；③ Bash 里 `tasklist /FO CSV /NH` 会被 MSYS 路径转换把 `/FO` 当路径而报错，进程查询改用 PowerShell 或异步 spawn；④ 用 `explorer.exe <exe>` / WMI `Win32_Process.Create` 制造「脱离本进程树」的对照，是区分「我方上下文」与「客户端自身」的关键手段；⑤ 崩溃是否可复现要重复测（QQ 崩溃有概率性，单次结果不可作数）。

未决/待续：§2.4 的窗口操作依赖外部客户端窗口行为、best-effort，需在真实客户端（qq / qianniu 登录窗）上真机验证 Enter 是否落到默认按钮；**当前登录点击在 spawn 后立即执行、客户端窗口往往尚未出现，实测恒 `no-window`，要真正生效需「等窗口出现 + 有限次重试」，属待定的设计取舍**；QQ 启动崩溃已归因为 agent 进程上下文（见上），**其真机复验须在非 agent 上下文里做**（由用户从自己的终端启动开发外壳，或装正式版双击启动），agent 拉起的开发外壳里 QQ 必崩、不代表正式版；其余需求（2.1~2.7）均已实施。



