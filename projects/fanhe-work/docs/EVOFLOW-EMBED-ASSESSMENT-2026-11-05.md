# EvoFlow 内嵌至「梵禾 Work」可行性评估与集成方案

> 评估日期：2026-11-05
> 评估对象：EvoFlow 桌面端（安装于 `D:\EvoFlow`，panel_version 1.2.9）
> 承接方：梵禾 Work（Electron 桌面端 + React 前端 + Fastify/Prisma 服务端）
> 性质：方案评估。本文不含任何代码改动。
> **已被取代**：源码公开后结论变更，见 `EVOFLOW-WEB-EMBED-PLAN-2026-11-05.md`。本文保留作为「桌面二进制形态」的技术记录，其中窗口级内嵌的验证结论与完整性问题仍然有效。

---

## 一、结论摘要

**能力层与发行层可以内嵌，界面层只能有限内嵌，二进制层改名不建议做。**

分四层给出结论：

| 层次 | 目标 | 可行性 | 依据 |
| --- | --- | --- | --- |
| 能力层 | 把 EvoFlow 的对话、Agent、技能、知识库能力接入梵禾 Work | **高** | 网关暴露 OpenAPI 3.1 共 640 个接口，纯 HTTP/JSON，可被任意客户端调用 |
| 发行层 | 一次安装、一个入口、一套更新 | **高** | 安装根目录可整体平移，exe 按相对路径定位 sidecar，无绝对路径写死 |
| 界面层 | 把 EvoFlow 界面嵌进梵禾 Work 主窗口内 | **中偏低** | 前端资源编译进 Tauri exe，无独立 URL；梵禾窗口 `sandbox:true` 且导航白名单锁死 |
| 品牌层 | 改名为「全能AI助手」 | **不建议（二进制层）** | 完整性 pin、自动更新、AppUserModelID、数据目录、授权校验、商标授权六处耦合 |

推荐落地路径：**先做发行层合并（1 至 2 天可交付），再做生命周期托管，界面层用独立视图承载，品牌只在显示层做别名。**

### 重要前置：本项目今日上午已实测否决「窗口级内嵌」

2026-11-05 上午 09:20 至 10:45，同一个工作区做过一次结构完全相同的实验：把微信客户端窗口用 Win32 手段嵌进梵禾 Work 的工作台页面。三级方案测完，前两级不成立，第三级能用但被判定「没有意义」，当天 10:45 全部回退（详见 `.workbuddy/memory/2026-11-05.md`）。

那次实验的三条硬结论，对 EvoFlow 全部适用：

1. **`SetParent` 到 Electron 主窗口渲染不出来。** 子窗口列表里 `Chrome_RenderWidgetHostHWND` 与 `Intermediate D3D Window` 各占整个客户区，Chromium 用 DirectComposition 直接合成到 DWM，压过 GDI z-order，置顶无效。EvoFlow 是 Tauri + WebView2，同样走 DirectComposition，同一面墙。
2. **`GWLP_HWNDPARENT` 从属窗口能显示，但仍是顶层窗口。** 有标题栏、能拖走、任务栏多一条，等于没嵌。
3. **自建 `WS_POPUP` 宿主面板可行，但拖动拦不住。** 跨进程装不了 `WndProc`，`SetWindowLongPtr(GWLP_WNDPROC)` 对别的进程无效，拦不下 `WM_SYSCOMMAND`；只能 16 毫秒轮询 `GetWindowRect` 强行拉回坐标。

**这次的差别在另一处**：微信是封闭客户端，除了窗口拼接没有别的接法，所以那条路走完就是死路。EvoFlow 网关暴露 640 个 OpenAPI 接口，价值在能力层而不是窗口层。因此本方案的重心从「把窗口搬进来」转向「把能力接进来」，窗口只作为承载容器，不作为集成手段。

---

## 二、事实基础（实测证据）

所有结论均可复现。关键证据如下。

### 2.1 进程与运行时构成

| 项 | 实测值 | 来源 |
| --- | --- | --- |
| 桌面壳 | `D:\EvoFlow\evoflow.exe`，88.8 MB，Tauri（Rust + WebView2） | exe 字符串含 `tauri` 51 处、`wry` 28 处、`CoreWebView2` 9 处 |
| 前端资源 | 编译进 exe，运行时 origin 为 `http://tauri.localhost` | 日志 `main-Zc4fqUV1.js` 指向 `tauri.localhost/assets/` |
| 后端网关 | `binaries\evoflow-gateway\evoflow-gateway.exe`，58.9 MB，PyInstaller onedir | `_internal` 目录含 CPython 3.12 `.pyd`、FastAPI、uvicorn |
| 网关端口 | 本会话 8382，另有 langgraph runtime 8384 | `~/.evoflow/evopanel/backend-runtime.json`、启动日志 |
| 数据存储 | SQLite（`evoflow.db`、`checkpoints.db`）+ DuckDB | `~/.evoflow/config.yaml`；`_duckdb.cp312-win_amd64.pyd` 35 MB |
| 用户目录 | `C:\Users\Administrator\.evoflow`（**硬编码**） | 启动日志 `resolved config.yaml`，网关 exe 内 `.evoflow` 出现 15 次 |

### 2.2 启动链路与耗时

启动日志 `evopanel-startup-2026-11-05.log` 记录了完整时序：

1. `ensure_backend_sidecar begin` → 回收 stale 锁（pid 校验）
2. `sidecar pin ok panel_version=1.2.9`（**版本与 sha256 完整性校验**）
3. `selected backend port 8382`（有偏好端口，可回退）
4. `resolved backend launch: \\?\D:\EvoFlow\binaries\evoflow-gateway\evoflow-gateway.exe`
5. `backend work dir: C:\Users\Administrator\.evoflow\profiles\default`
6. `langgraph runtime spawned port=8384 (split process model)`
7. `sidecar spawned ... model=split (stdio app-server)`
8. 前端轮询 `/health/ready`，约 **8.7 至 9.9 秒**后 `ENGINE READY`

冷启动接近 9 秒是硬约束。任何「点开即用」的界面设计都要为此准备骨架屏或预热策略。

### 2.3 接口面

`~/.evoflow/evo_api.json`（767 KB）为网关自述的 OpenAPI 3.1 文档，640 个 path。按域分布：

```
chat 42        proactive 42    eval 38        knowledge 55
observability 29  tasks 28     workspaces 24  threads 23
channels 22    apps 20         config 17      models 16
plugins 16     speech 14       automation 13  memory 13
identity 12    settings 13     goal 12        usage 8
agents 8       organizations 8 license 6      skills 6
mcp 5          collab 6        webui 13       events 4
```

要点：
- **有完整控制面**，接口粒度足够做外部宿主集成。
- **有 `events` 与 SSE 通道**，流式对话可复用。
- **有 `ui-extensions` 三个接口**，这是官方认可的界面扩展点，优先级高于任何非侵入式替代方案。

### 2.4 安全与授权事实（影响方案边界）

| 事实 | 位置 | 影响 |
| --- | --- | --- |
| `sandbox.use: NoopSandboxProvider` | `~/.evoflow/config.yaml` | 工具调用**直连宿主机**，无沙箱 |
| `tools_mode: host_direct` | 同上 | Agent 可执行本机命令 |
| 自带 `agent-browser`、`ripgrep`、`cua`（computer use） | `binaries/evoflow-gateway/tools/` | 可驱动浏览器与本机界面 |
| `case closed guardrails.fail_closed: true`、`AllowlistProvider` | `config.yaml` | 有一层工具白名单，但默认 `denied_tools: []` |
| `/api/license/*` 共 6 个接口 | OpenAPI | 商业授权校验存在，域名 `evovexai.com` |
| `sidecar-manifest.json` 含 `exe_sha256` | gateway 根目录 | 二进制被替换会触发 pin 失败 |
| `AppUserModelID = com.evovex.evoflow`，深链 `evoflow://` | 快捷方式与 exe 字符串 | 改名破坏任务栏归组、通知、单实例 |

**这一节是整套方案的地基。** 内嵌意味着把「一个有宿主机执行权限、无沙箱、可驱动浏览器的 Agent 运行时」放进梵禾 Work 的信任边界内。方案必须对此有明确处置，否则功能再顺也不能上。

---

## 三、四种嵌入方式对比

### 方式 A：进程并列 + 单入口编排

梵禾 Work 负责探测、拉起、健康检查、退出清理 EvoFlow 进程，界面层新增一个入口，点击后切到 EvoFlow 自己的窗口。

| 维度 | 评价 |
| --- | --- |
| 界面无损 | 100%（还是原来那个窗口，一个像素都没动） |
| 功能无损 | 100% |
| 改动量 | 小。桌面端新增约 300 至 500 行生命周期管理 |
| 风险 | 低。进程崩溃不影响梵禾主窗口 |
| 体验 | 中等。用户感知是「两个窗口」，需要靠统一入口与托盘策略抹平 |

### 方式 B：发行层合并

一个 NSIS 安装包、一个桌面图标、一套更新策略。安装时串联 EvoFlow 官方安装器（静默参数），或检测已安装则跳过。

| 维度 | 评价 |
| --- | --- |
| 界面无损 | 100% |
| 改动量 | 小。`electron-builder.yml` 加 NSIS 自定义脚本（`include` + `customInstall`） |
| 风险 | 中。安装顺序、权限提升、卸载残留需要实测 |
| 体验 | 高。「一次装完、一个图标」，对外就是一个产品 |

### 方式 C：界面窗口级内嵌（**本项目已实测否决，不建议再投入**）

用 Win32 `SetParent` 把 EvoFlow 的 Tauri 窗口变成梵禾 Work 的子窗口，视觉上嵌进梵禾的某个区域。

| 维度 | 评价 |
| --- | --- |
| 界面无损 | 95%，视觉一致但边界行为会变 |
| 改动量 | 大。需原生模块（koffi / ffi-napi / neon），Electron 无官方 API |
| 风险 | 高。DPI、输入法候选框、模态遮挡、子窗口裁剪、全屏切换、崩溃残留 |
| **实测状态** | **2026-11-05 上午已在同类场景（微信窗口）验证三代方案，前两代不成立，第三代需每帧压坐标** |
| 结论 | **不再投入。** 理由：窗口拼接属于窗口管理层面的拼接，读不到数据、做不了联动，与「应用集成」是两件事 |

如果仍要做，只有第三代方案成立：自建 `WS_POPUP` 宿主面板当父级，不走 Chromium 合成链路，再用 16 毫秒轮询压住子窗口坐标。代价是常驻一个定时器，且每台机器都要处理进程权限。


### 方式 D：接口级复用

梵禾前端自己画界面，调用网关 640 个接口中的子集。

| 维度 | 评价 |
| --- | --- |
| 界面无损 | 0%（界面是新写的，谈不上无损） |
| 功能无损 | 理论 100%，实际取决于覆盖到哪些接口 |
| 改动量 | 极大。流式对话、线程历史、工具时间线、文件上传、技能管理逐项重写 |
| 风险 | 中。接口无版本化承诺，上游变更会打断集成 |
| 适用 | 只对 2 至 3 个高频场景做，不做全量复刻 |

### 推荐组合

```
基线（必做）  方式 B + 方式 A
长期（按需）  方式 D，先做 chat 流式与 threads 历史两个场景
已否决        方式 C
```

理由：B + A 能在 3 天内拿到「一个安装包、一个入口、一个托盘」的产品化效果，同时保持零界面改动、零兼容风险。D 是「用工程量换深度联动」，应当按真实痛点分批投入，不宜作为第一步。C 已被同项目实测证否，不再列入选项。

---

## 四、集成架构

### 4.1 分层视图

```
┌─────────────────────────────────────────────────────────────┐
│  梵禾 Work 桌面端（Electron 主进程）                          │
│                                                             │
│  ┌───────────────┐   ┌──────────────────────────────────┐   │
│  │ 窗口与导航     │   │ EvoFlow 生命周期管理器（新增）     │   │
│  │ main.ts       │   │ src/evoflow/*.ts                 │   │
│  │ 白名单 shell-  │   │ · 安装探测（注册表 + 目录）        │   │
│  │ Origin        │   │ · spawn / kill / 退避重启         │   │
│  └───────┬───────┘   │ · 健康探测 /health/ready          │   │
│          │           │ · 端口分配与冲突处理               │   │
│          │           │ · 状态广播到渲染进程               │   │
│          │           └──────────────┬───────────────────┘   │
│          │                          │ spawn                 │
│  ┌───────▼───────┐                  ▼                       │
│  │ React 前端     │        ┌──────────────────────┐          │
│  │ 新增「AI 助手」 │        │ evoflow.exe (Tauri)  │          │
│  │ 入口 + 状态灯   │        │ 独立窗口，界面零改动   │          │
│  └───────┬───────┘        └──────────┬───────────┘          │
│          │                            │ stdio app-server     │
│          │ 可选：API 直连             ▼                      │
│          │                 ┌──────────────────────┐          │
│          └────────────────▶│ evoflow-gateway.exe  │          │
│                            │ 127.0.0.1:8382       │          │
│                            │ + langgraph :8384    │          │
│                            └──────────────────────┘          │
└─────────────────────────────────────────────────────────────┘
```

### 4.2 关键设计决策

**决策一：网关由谁拉起。**
不要让梵禾直接 spawn `evoflow-gateway.exe`，而是 spawn `evoflow.exe`。原因：网关以 `stdio app-server` 模式运行时依赖父进程的 stdio 管道（日志明确写 `desktop stdio: skip WebUI JWT middleware`），脱离 Tauri 壳直接拉网关会缺少 `get_gateway_base_url` 握手与 license 上下文。让 Tauri 壳自己管 sidecar，梵禾只做「确保它活着」。

**决策二：端口以文件为准，不自己猜。**
`~/.evoflow/evopanel/backend-runtime.json` 是唯一的运行时真相源（`baseUrl`/`port`/`pid`/`generation`/`status`）。梵禾读它，不硬编码 8382。这与梵禾既有的「派生值不重算」原则一致。

**决策三：进程归属与退出策略。**
梵禾退出时**不杀** EvoFlow（它可能有长任务在跑），改为「梵禾关闭后 EvoFlow 退到托盘」。反过来，EvoFlow 崩溃不阻塞梵禾启动，只把入口状态灯从绿变灰，并在用户点击时做一次重启尝试。

**决策四：安全边界前置。**
`NoopSandboxProvider` + `host_direct` 意味着内嵌后梵禾用户等于获得一个全机执行通道。方案要求：
1. 梵禾侧给「AI 助手」模块单独设权限点，默认只给管理员；
2. 首次进入时显式风险确认；
3. 不把 EvoFlow 的任何 HTTP 端口暴露到 `0.0.0.0`；
4. 梵禾的服务端（`apps/api`）不代理 Agent 的工具执行，只代理只读查询。

---

## 五、需要改造或适配的关键模块

### 5.1 桌面端（`apps/desktop`）

| 文件 | 改动性质 | 说明 |
| --- | --- | --- |
| `src/main.ts` | 新增 | 引入生命周期管理器；`before-quit` 增加 EvoFlow 处置分支；新 IPC 通道注册 |
| `src/evoflow/`（新建目录） | 新增 | `locate.ts`（注册表与目录探测）、`lifecycle.ts`（spawn/健康/退避）、`runtime.ts`（读 backend-runtime.json）、`types.ts` |
| `src/config.ts` | 扩展 | 新增 `evoflow` 配置块：`installRoot`、`autoStart`、`portPolicy`、`embedMode` |
| `src/preload.ts` | 扩展 | 只暴露窄接口 `evoflowStatus()`、`evoflowLaunch()`、`evoflowFocus()`。**禁止暴露任意 URL 打开能力** |
| `electron-builder.yml` | 扩展 | NSIS `include` 自定义脚本；串联安装或已安装检测 |
| `src/update.ts` | 扩展 | 明确「梵禾更新不得触碰 EvoFlow 安装目录」的边界 |
| `src/server.ts` / `shell-origin.ts` | 视方案 | 若选方式 D，需要为助手视图分配独立 origin 与 CSP |

**注意 `main.ts` 的既有约束**：`will-navigate` 只放行 `shellOrigin`，外链一律 `shell.openExternal`。新增助手视图时不要修改这条规则，应通过 `WebContentsView` 或独立窗口绕过它，避免把整壳的导航白名单打开成洞。

### 5.2 前端（`apps/web` + `packages/shared`）

| 文件 | 改动性质 | 说明 |
| --- | --- | --- |
| `packages/shared/src/permissions.ts` | 新增权限点 | 例如 `assistant.read`、`assistant.launch`、`assistant.admin` |
| `packages/shared/src/navigation.ts` | 新增导航项 | 放在合适的分组，`filterNavigation` 按 `module.` 前缀过滤 |
| `apps/web/src/auth/useVisibleNavItems.ts` | 无需改 | 复用现有纯函数 |
| `apps/web/src/pages/` | 新增页面 | 入口页（状态 + 一键启动 + 最近会话），**不重写对话界面** |
| `apps/web/src/lib/assistant.ts`（新建） | 新增 | 若走方式 D，按 `lib/api.ts → withAccessToken → 拆信封 → 错误码分流` 三层约定组织 |

**必须同时处理的两个坑（本项目已踩过）**：

1. **新增权限点后必须重建 `migrate` 与 `api` 两个镜像**。更隐蔽的一点：owner 权限走 `guard.ts` 的 `[...ALL_PERMISSIONS]` 代码常量，不查库。旧镜像只返回旧清单，前端 `filterNavigation` 会整组静默消失，库里的数据全对。表现为「新模块根本看不见，控制台零报错」。
2. **`apps/web/src/index.css` 是令牌唯一来源**。新增模块的颜色、间距必须从令牌取，不要写死色值。

### 5.3 服务端（`apps/api`）

| 改动 | 说明 |
| --- | --- |
| 新增只读代理（可选） | `/api/assistant/status` 转发到网关只读接口，供 Web 端（非桌面端）使用 |
| 审计埋点 | 记录谁在何时启动了 Agent、跑了哪些工具。**这是内嵌高权限组件后的最低要求** |
| 权限落库 | 新权限点进 `permissions` 表，经 `pnpm db:seed` 写入，不要手改库 |

**不建议**让 `apps/api` 代理对话与工具执行。理由：会引入双重超时、SSE 穿透困难、以及把宿主机执行权放到服务端进程（可被远程网络触达）。

### 5.4 安装与更新

| 项 | 说明 |
| --- | --- |
| 安装包 | NSIS 串联：先装 EvoFlow（静默），再装梵禾；或检测 `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall` 中 EvoFlow 条目后跳过 |
| 卸载 | 梵禾卸载**不自动卸载** EvoFlow（可能被独立使用），在卸载页给出勾选项 |
| 更新 | 两套更新器并行。梵禾更新只覆盖自身目录；EvoFlow 由它自己更新（`_up_` 目录 + sidecar pin 流程） |
| 版本展示 | 梵禾「关于」页同时展示两个版本号，便于排障 |

---

## 六、功能与界面无损的保障措施

### 6.1 三条不可越过的红线

1. **不修改 EvoFlow 安装目录内的任何文件**。`sidecar-manifest.json` 里有 `exe_sha256`，任何改动都会触发 pin 失败，进而可能引发自动修复或拒绝启动。
2. **不修改 `~/.evoflow` 的目录结构与配置语义**。`config.yaml` 有 `config_version: 5`，手改容易触发迁移逻辑。
3. **不替换、不改名、不重签名任何 EvoFlow 二进制**。这一条同时是技术要求和授权要求。

### 6.2 可判定的验收判据

| 目标 | 判据 | 反例测试 |
| --- | --- | --- |
| 界面无损 | 同一操作在「原桌面快捷方式」与「梵禾入口」两条路径下，截图逐区域比对一致 | 故意在两条路径分别截取同一页面，做像素差；差异应只出现在窗口边框 |
| 功能无损 | 对话、线程历史、技能列表、Apps、MCP 配置五项逐项走通 | 人为禁用一项技能后两端表现一致 |
| 启动可靠 | 冷启动到可用 ≤ 12 秒，失败要有明确状态而不是白屏 | 占住 8382 端口，看梵禾是否给出「端口被占用」并自动退避 |
| 崩溃隔离 | kill 掉 gateway 进程，梵禾主窗口不崩、其它模块可继续用 | 连续 kill 三次，确认退避重启生效且不产生僵尸进程 |
| 退出干净 | 梵禾退出后无孤儿子进程 | 任务管理器核对 `evoflow*` 进程数 |
| 数据干净 | 两套数据互不污染 | EvoFlow 的 `evoflow.db` 不被梵禾读写；梵禾的 PG 不受影响 |
| 安全边界 | 网关端口只监听 127.0.0.1 | `netstat -ano \| findstr 8382` 确认无 `0.0.0.0` |

### 6.3 与既有质量门禁的衔接

梵禾现有的四道门禁（`test` → `lint` → `typecheck` → `format:check`）基线为 1529 项 0 失败。本次改造需要：

1. 新增桌面端单元测试（生命周期管理的状态机），建议放 `apps/desktop/test/`，沿用现有 `.mjs` 测试风格；
2. 新增一个纯函数层 `lib/assistant-display.ts` 承载状态到文案的映射，**不要写在组件里**，否则只有开浏览器才能验；
3. 导航与权限的改动必须补一条断言：新模块在 `ALL_PERMISSIONS` 全集下可见，在缺权限时不可见。这条断言要做反例测试（从权限数组里删掉新点，确认断言报 FAIL）。

---

## 七、风险登记表

按「发生概率 × 影响」排序。

| # | 风险 | 概率 | 影响 | 处置 |
| --- | --- | --- | --- | --- |
| R1 | **授权与商标**：EvoFlow 为第三方商业软件，去标改名后分发可能违反许可与商标法 | 高 | 高 | 不改二进制、只做显示层别名；对客户分发前必须取得授权或改为「附带官方安装包」的集成模式 |
| R2 | **完整性 pin 与自动更新冲突**：改动目录触发 pin 失败，或梵禾更新覆盖 EvoFlow 目录 | 中 | 高 | 目录物理隔离 + 更新器边界写死 + 安装路径纳入 `.gitignore` 与打包排除 |
| R3 | **安全边界塌陷**：`NoopSandboxProvider` + `host_direct` + CUA，等于给出全机执行通道 | 高 | 高 | 独立权限点默认仅管理员；首次使用风险确认；端口不对外；服务端不代理工具执行 |
| R4 | **端口冲突**：网关偏好 8382/8384，与梵禾 3000/8787/5432 相邻但独立；若被占则冷启动变慢或失败 | 中 | 中 | 以 `backend-runtime.json` 为真相源；启动前探测占用；失败给出可操作提示 |
| R5 | **冷启动 9 秒**：用户点击后长时间无反馈 | 高 | 中 | 入口页先渲染本地状态（已安装/未启动/启动中），进度可感知；可选开机预热 |
| R6 | **上游接口漂移**：640 个接口无版本化承诺，方式 D 的客户端会随上游变更失效 | 中 | 中 | 方式 D 限定在 3 个以内场景；对使用的接口做契约快照测试 |
| R7 | **窗口内嵌的边界行为**：DPI、输入法候选框、模态遮挡、全屏 | 必然（仅方式 C） | 中 | 方式 C 已否决，不再承担该风险 |
| R8 | **双份数据与双份备份**：两套 SQLite + 一套 PG | 中 | 中 | 备份脚本纳入同一份运维清单；恢复演练时两者一起验 |
| R9 | **原生模块引入**（方式 C）：打包签名、杀软误报、ABI 升级 | 中 | 中 | 若非必要不引入；若引入则锁版本并纳入发布检查 |
| R10 | **品牌认知割裂**：改名为「全能AI助手」后，出问题无法对官方报障 | 高（若改名） | 低 | 关于页保留原始产品名与版本号；日志中保留 `evoflow` 标识 |

---

## 八、改名「全能AI助手」的影响评估

分四层看，结论完全不同。

### 8.1 显示层（窗口标题、侧栏名、托盘菜单、关于页）

**可以改，技术零风险。**

建议做法：在梵禾 Work 里把入口命名为「全能AI助手」，同时在关于页与窗口副标题标注「由 EvoFlow 1.2.9 驱动」。这既满足产品统一，也保留了排障线索。

### 8.2 数据层（用户目录名）

**不能改。** `~/.evoflow` 在网关 exe 中硬编码出现 15 处。改名等于新建一个空目录，用户的历史会话、技能、知识库、配置**全部「消失」**（文件还在，但程序不再读它）。这是最容易发生、也最容易被误判为「升级丢了数据」的坑。

### 8.3 二进制层（exe 名、AppUserModelID、NSIS 标识）

**不能改。** 具体耦合点：

| 耦合项 | 证据 | 改名后果 |
| --- | --- | --- |
| sidecar 相对定位 | 日志 `resolved backend launch: <安装根>\binaries\evoflow-gateway\evoflow-gateway.exe` | 目录结构变更即启动失败 |
| 完整性 pin | `sidecar pin ok panel_version=1.2.9` + `exe_sha256` | 二进制被替换触发 pin 失败 |
| 自动更新 | `_up_` 目录、`sidecar-manifest.json` 的 `built_at`/`panel_version` | 更新器会按原标识回写，覆盖改动 |
| AppUserModelID | `com.evovex.evoflow` | 任务栏归组、通知、单实例锁异常 |
| 深链协议 | `evoflow://` | 桌面通知点击、OAuth 回调失效 |
| 授权校验 | `/api/license/*` 6 接口 + `evovexai.com` | 改名不等于改授权，校验仍指向原厂 |

### 8.4 法务层

EvoFlow 是第三方商业产品（`evovexai.com`），具备授权体系与商标标识。**在自己机器上做显示层别名属于个人使用范畴；一旦随梵禾 Work 分发给团队或客户，去标改名会同时触碰许可条款与商标权。** 若目标是对外交付，正确做法是「集成而非改标」：保留原产品名，以「梵禾 Work 内置 EvoFlow 能力」的方式呈现，并附官方授权说明。

### 8.5 结论

| 层 | 建议 |
| --- | --- |
| 显示层 | 改，用「全能AI助手」作入口名，副标题保留 EvoFlow 与版本 |
| 数据层 | 不改 |
| 二进制层 | 不改 |
| 分发 | 对外分发前确认授权；未确认前仅限本机自用 |

---

## 九、分阶段实施步骤与验证

### P0 勘察与基线（0.5 至 1 天）

工作内容：
1. 记录 EvoFlow 版本、`sidecar-manifest.json` 的 `exe_sha256`、安装根路径；
2. 对将要用到的接口做契约快照（把 OpenAPI 相关片段存进仓库，作为漂移检测基线）；
3. 实测冷启动时间三次取中位数；
4. 阅读官方许可条款，产出「可做/不可做」清单。

验收：产出一份基线记录，含版本、哈希、启动耗时、许可结论。
失败判据：拿不到许可条款或条款禁止再分发，则后续阶段降级为「仅本机集成」。

### P1 发行层合并（1 至 2 天）

工作内容：
1. `electron-builder.yml` 增加 NSIS 自定义安装脚本；
2. 安装前检测 EvoFlow 是否已安装（注册表 Uninstall 键 + 目录存在性双判据）；
3. 未安装则静默调用官方安装包；已安装则跳过并记录版本；
4. 卸载页增加「是否一并卸载 EvoFlow」勾选项。

验收：
- 全新机器一次装完，桌面只有一个图标，两个程序都能启动；
- 已装 EvoFlow 的机器上重装梵禾，不重复安装、不覆盖 EvoFlow 目录；
- 反例：手动把 EvoFlow 目录改名，安装器应报告「检测到异常安装」而非静默跳过。

### P2 生命周期托管（2 至 3 天）

工作内容：
1. 新增 `src/evoflow/` 四个模块；
2. 主进程注册窄 IPC 通道，preload 暴露三个方法；
3. 前端新增入口页，含四态：未安装 / 未启动 / 启动中 / 就绪；
4. 失败退避与日志落盘（沿用梵禾既有 `.tmp/` 日志习惯）。

验收：
- 冷启动点开入口，能在 12 秒内到达就绪并自动聚焦 EvoFlow 窗口；
- kill gateway 后状态灯 10 秒内变灰，点击可重启；
- 梵禾退出后 `tasklist | findstr evoflow` 无孤儿进程；
- 反例：把 `backend-runtime.json` 改成非法 JSON，入口应显示「运行时信息损坏」而不是崩溃。

### P3 承载形态（1 至 2 天）

**只做路线 1：独立窗口 + 梵禾侧「返回梵禾」快捷入口。**

- 梵禾入口页点击后，唤起 EvoFlow 窗口并置前；
- EvoFlow 窗口侧边或托盘提供「回到梵禾」；
- 两者通过窗口激活事件同步状态灯，不做窗口坐标与父子关系绑定。

**路线 2（`WebContentsView` 或 Win32 子窗口嵌入）不执行**，理由见方式 C：同项目已于 2026-11-05 上午完成三代验证并否决，重复投入没有新增信息。

验收：
- 从梵禾入口到 EvoFlow 可交互，点击后 3 秒内窗口置前；
- 两个窗口间来回切换，梵禾主窗口状态（当前模块、滚动位置）不丢；
- EvoFlow 窗口最小化时，梵禾侧状态灯正确显示为「已最小化」而非「未启动」；
- 反例：把 EvoFlow 窗口拖到第二块屏，梵禾入口的「置前」仍能定位到正确显示器。

### P4 接口复用（按场景，1 至 2 周/场景）

只做两个场景，不做全量：
1. **对话流式**：复用 `/api/chat/*` 与 SSE；
2. **线程历史**：复用 `/api/threads/{id}` 与 `/api/threads/{id}/tool-timeline`。

验收：
- 与 EvoFlow 原生界面对同一会话的渲染结果一致（消息数、工具时间线条目数）；
- 断网重连后 SSE 可恢复；
- 反例：人为让网关返回 500，梵禾页面显示可重试错误，不出现空白会话。

### P5 品牌层（需 P0 许可结论支撑）

工作内容：入口命名、关于页文案、托盘菜单文案。

验收：关于页同时可见「全能AI助手」「EvoFlow 1.2.9」，日志中 `evoflow` 标识完整保留。

---

## 十、待确认事项

这几项需要阿阳拍板，直接影响方案取舍：

1. **使用范围**：只在本机自用，还是要给团队或客户装机？前者可选激进方案，后者必须先解决授权。
2. **「内嵌」的验收标准**：是「一个安装包一个图标」（发行层），还是「梵禾窗口里能看到 EvoFlow 界面」（界面层）？两者工程量差一个数量级。
3. **是否接受两套更新器并行**：如果不能接受，需要与 EvoFlow 官方确认更新通道策略，否则只能锁定版本不升级。
4. **AI 助手的权限范围**：给全部账号，还是仅管理员？这决定权限点设计与审计要求。
