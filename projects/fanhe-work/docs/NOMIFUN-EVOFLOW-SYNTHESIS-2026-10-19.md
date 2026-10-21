# NomiFun 架构解构与 EvoFlow 综合对照
## 兼论梵禾 Work 的技术路线选择

> 评估对象一：nomifun/nomifun-desktop，版本 0.8.14，HEAD `8c3a5cb`（2026-10-18）
> 评估对象二：EvovexAI/EvoFlow，版本 1.1.1，HEAD `b9c8c41`（2026-10-18）
> 评估时间：2026-10-19
> 事实来源：两份源码快照（浅克隆 30 次提交，NomiFun 5,318 文件）、本地安装产物 `E:\NomiFun`（246MB 单文件）、两份 LICENSE 与 NOTICE、GitHub REST API 元数据
> 前序报告：`EVOFLOW-ARCH-REUSE-2026-10-19.md`

---

## 0. 结论摘要

**NomiFun 的架构判断。** 它用一句话概括是"一个 Rust 后端，两种宿主，一个前端"。`nomifun-app` 编译出的 axum 服务器同时嵌入 Tauri 桌面壳与独立 Web 服务器，React 19 SPA 只讲 HTTP 与 WebSocket。这个模型与梵禾 Work 现有的"Electron 壳 + 内置静态服务 + 反代"高度同源，是两份参考实现里与梵禾底座最接近的一个。

**规模判断。** NomiFun 比 EvoFlow 更大，Rust 侧 102.8 万行 / 1,818 文件，前端 35.6 万行 / 2,262 文件，合计约 138 万行。65 个 crate 中，`nomi-*` 引擎组对 `nomifun-*`、axum、sqlx、tauri 零依赖，这条 seam 比 EvoFlow 的端口模式更彻底。

**许可证判断，这一条与 EvoFlow 形成决定性反差。** NomiFun 是 Apache-2.0，可商用、可修改、可再分发，只需保留 NOTICE 与许可副本，并注意商标不在授权范围内。EvoFlow 是 PolyForm Noncommercial，商用需书面授权。因此在"能否直接使用代码"这一维度上，NomiFun 是唯一可行的基线，EvoFlow 只能作为设计参考。

**对梵禾 Work 的综合建议。** 两个项目都不应整包移植。正确做法是抽取三份不同来源的资产，即从 NomiFun 取宿主模型与应用托管生命周期，从 EvoFlow 取工具分层与 AG-UI 事件词表，从梵禾自身取既有的 Fastify、Prisma、PostgreSQL 与权限体系，在 TypeScript 栈内自研 Agent 内核。修订后工作量约 66 至 102 人日。

---

## 1. 评估方法与事实基础

延续前序报告的三证据链方法，本次增加一条横向对照轴。

| 证据源 | 用途 | 关键价值 |
|---|---|---|
| NomiFun 源码快照 | crate 划分、代码量、契约设计 | 可验证的结构事实 |
| NomiFun 本地产物 `E:\NomiFun` | 真实分发形态 | 单文件 246MB，Tauri 打包 |
| 官方 `docs/architecture/` 18 篇 | 设计意图与边界规则 | 项目自带高质量架构文档，罕见 |
| GitHub REST API | 许可证、活跃度、社区规模 | 客观元数据 |

需要说明一处方法论差异。EvoFlow 的文档与代码存在偏差（README 仍描述 `src/` 而代码已迁至 `packages/`），NomiFun 的文档与代码高度一致，且文档本身承担了"契约说明书"的角色，例如 `app-hosting.md` 用 277 行描述一个模块的并发栅栏与失败语义。这个差异本身就是两个团队工程文化的映射，后文会展开。

---

## 2. NomiFun 架构解构

### 2.1 一句话定位

NomiFun 自我定位是"本地优先的 AI 工作站"，明确承诺无云账号、无遥测、无订阅，数据留在本机。产品形态覆盖对话、无人值守自动化（AutoWork）、知识库、原生电脑与浏览器操作、创意画布、应用托管、陪伴角色、机器人接入、终端与 SSH、远程能力 API。

### 2.2 两宿主一前端

```
        ┌──────────────────────────────────────────┐
        │  ui/  React 19 SPA（Vite 6 构建）          │
        │  HashRouter · SWR · Arco · UnoCSS         │
        │  http://127.0.0.1:<port>/api  +  /ws      │
        └───────────────▲──────────────▲───────────┘
              HTTP/REST │      WS /ws  │
   ┌────────────────────┴───┐  ┌───────┴──────────────────┐
   │ apps/desktop (Tauri 2) │  │ apps/web (独立 axum)      │
   │ 独立线程 + tokio 运行时 │  │ 同端口服务 /api + /ws + SPA│
   │ 动态端口 + LocalTrust   │  │ JWT + CSRF，默认强制鉴权    │
   └────────────────────┬───┘  └───────┬──────────────────┘
                        ▼              ▼
        ┌──────────────────────────────────────────┐
        │  nomifun-app（二进制 nomicore）            │
        │  组合根 · axum 路由 · 中间件栈             │
        └───────┬──────────────────────┬───────────┘
                ▼                      ▼
    ┌────────────────────┐   ┌─────────────────────┐
    │ nomifun-* 52 个     │◀─▶│ nomi-* 7 个          │
    │ 数据/鉴权/MCP/会话   │   │ Agent 引擎（零框架依赖）│
    └─────────┬──────────┘   └─────────────────────┘
              ▼
    SQLite(sqlx) · 每会话工作目录 · PTY · MCP 桥
```

关键设计是"同一个 `create_router` 被两个宿主复用"。桌面宿主在独立线程启动 tokio 运行时，用 `bind 127.0.0.1:0` 取空闲端口，再通过初始化脚本把 `window.__backendPort` 注入 SPA。Web 宿主则用同端口同源，省掉端口协商。这条设计让"桌面版"和"自托管版"共享全部业务代码，只在鉴权模式与静态资源服务上分叉。

### 2.3 三层 crate 结构

Cargo workspace 用目录承载架构边界，而不只靠命名约定。

| 目录 | 职责 | 前缀 | 数量 | 代码量 |
|---|---|---|---:|---:|
| `crates/agent/` | 模型供应商、配置、桌面自动化原语 | `nomi-*` | 7 | 6.4 万行 |
| `crates/backend/` | HTTP/WS 服务器、数据、鉴权、业务域 | `nomifun-*` | 52 | 约 90 万行 |
| `crates/shared/` | 跨层工具（进程运行时、SSH、脱敏） | 混合 | 6 | 5.8 万行 |

`crates/agent/` 的独立性是可验证的硬约束。文档写明"no `nomi-*` crate references any `nomifun-*` crate, the workspace root, or frameworks like Tauri / sqlx / axum"。反向调用统一走 `nomifun-ai-agent` 这一个 seam，浏览器与电脑控制是显式 feature-gated 例外。

对比 EvoFlow 的规则 R1（内核不得 import 应用层，但存在 60 条存量违规基线），NomiFun 的边界是"零违规 + 例外需登记"。前者是治理中，后者是治理完成。这个差别决定了"能否单独拎出引擎复用"的答案，NomiFun 可以，EvoFlow 暂时不能。

后端 crate 里与产品能力直接相关的几个值得单列。

| crate | 职责 | 对梵禾的相关度 |
|---|---|---|
| `nomifun-app-hosting` | 本地程序托管全生命周期，含导入、命令检测、进程树、预览 | 极高 |
| `nomifun-agent-runtime` | 统一执行循环，通过模型/工具/事件/取消端口组合 | 高 |
| `nomifun-agent-session` | 会话事实与投影，含 Session/Turn/Event/Effect/Payload | 高 |
| `nomifun-agent-execution` | 多 Agent 协作执行聚合，Planner DAG + Attempt | 高 |
| `nomifun-skill-library` | 技能库、市场发现、启动物化、运行时解析 | 高 |
| `nomifun-mcp` | MCP CRUD、OAuth、多 CLI 同步（Claude/Codex/Gemini/Qwen 等 8 家） | 高 |
| `nomifun-channel` | Telegram、飞书、钉钉、微信渠道适配 | 中 |
| `nomifun-idmm` | 智能决策监督，规则层 + 受限旁路模型 | 中 |
| `nomifun-requirement` | AutoWork 常驻执行器，开机续跑 | 中 |
| `nomifun-workshop` / `nomifun-creation` | 创意画布、媒体生成队列 | 低 |
| `nomifun-robot` | 小智固件机器人网关 | 低 |

### 2.4 Agent 引擎

执行路径是显式的六段式，没有隐藏在框架里。

```
UI 或领域命令
  → 规范会话所有者与 Store
  → 规范 Turn 准入
  → official_runtime 与 EngineSessionHost
  → nomifun-agent-runtime（模型/工具/事件/取消端口）
  → engine_journal
  → 规范事件与消息投影
  → realtime → 渲染层
```

与 EvoFlow 的 LangGraph 图相比，NomiFun 的循环是手写的 Rust，状态由 `engine_journal` 承载。这个选择的代价是必须自己实现重试、恢复、并发，收益是每一帧都能审计，且没有框架版本漂移风险。

多 Agent 协作由 `AgentExecution` 聚合承担，内部四个角色分工明确，Planner 产出 DAG，Router 选参与者，Scheduler 管就绪与租约，AttemptRunner 通过会话所有者执行单次尝试。四类策略正交，即委派策略、计划门、决策策略、适应策略。这比 EvoFlow 的十态协作状态机更抽象，也更容易映射到业务。

值得注意的是 IDMM 的保守设计。规则层不调用模型，能恢复可重试的供应商与网络故障、检测模型阶段静默、对显式选项提示选第一个安全项。它明确不自动回答权限、凭据、购买、破坏性提示，也不因为工具静默就取消执行，理由是可能重复外部副作用。这条"宁可停住也不误动"的取舍，是生产级 Agent 产品必须内化的判断，梵禾 Work 若要让 Agent 操作千牛，应当直接照搬这条原则。

### 2.5 数据与存储契约

三处存储，SQLite（sqlx）为结构化真相源，安装级数据目录存库与日志，每会话工作目录存 Agent 读写文件。

数据契约 v3 有四条硬规则值得记录。每张产品表用 `id INTEGER PRIMARY KEY AUTOINCREMENT`，跨数据集实体用裸 UUIDv7 字段（`user_id`、`conversation_id`、`message_id`），一个关系只有一个引用字段（禁止 `*_row_id` 双字段），产品 DDL 不含物理外键、`REFERENCES`、`ON DELETE`、`ON UPDATE`。

"用逻辑引用替代物理外键"是一个反直觉但在多宿主场景下正确的决定。它让数据集可以整体迁移、备份、重建，而不受外键级联约束。代价是把完整性责任转移给仓储层与服务层，需要配套的守卫触发器。

对梵禾 Work 的启示是负面的，即不必照搬。梵禾已有 Prisma + PostgreSQL 与成熟的迁移链，物理外键与级联删除是既有资产。照搬无外键模型会削弱现有数据完整性保障。

### 2.6 通信面

六条通道，各有明确调用方与安全模型。

| 通道 | 方向 | 承载 |
|---|---|---|
| HTTP REST | UI/客户端 → 后端 | CRUD、命令、文件、终端输入 |
| WebSocket `/ws` | 双向 | Agent 流事件、终端输出、广播事件、心跳 |
| Tauri IPC | SPA → 桌面壳 | 仅桌面 OS 能力 |
| PTY stdio | 后端 ↔ 子进程 | 终端字节流，含第三方 Agent CLI |
| MCP stdio/HTTP | Agent ↔ MCP 服务器 | 工具、资源、提示 |
| 规范远程入口 | 外部 Agent → 后端 | `open` / `turn` / `observe` / `cancel` |

鉴权有三档，即强制模式（JWT + CSRF 双提交 Cookie + 限流）、无鉴权模式（仅回环或私有网络显式开启）、`TrustLocalToken`（桌面壳每启动一次生成密钥，经 `x-nomi-local-trust` 头传递）。

这套设计与梵禾 Work 的现状可对齐度很高。梵禾已有登录态与 `/api` 反代，缺的是 CSRF 双提交与本地信任令牌这两档。

### 2.7 应用托管

`nomifun-app-hosting` 是 NomiFun 与梵禾 Work 重叠度最高的模块。它管理普通本地程序，支持创建、导入（文件夹或 ZIP）、搜索、标签、卡片网格，并提供 install / build / start / stop / preview 五段式生命周期。静态站点用 Node HTTP 服务预设，服务型产物用其真实前台命令。

工程细节里有一条对梵禾直接可用，即"配置的本地 HTTP 地址在启动返回前做两秒有界 TCP 监听等待，不发送 HTTP、TLS 或凭据，不探测远程域名"。这解决了启动器"启动了但还没就绪"的经典问题，实现成本极低。

另一条是进程识别。"重启后恢复要校验 PID、原生创建键与可执行文件身份，绝不单独信任 PID，也不自动重启应用"。梵禾 Work 的启动器目前按进程名与窗口标题判断，这条更严格的身份校验值得借鉴，尤其是自动填表依赖"前台窗口确实是目标应用"这一前提。

还有一条与梵禾既有踩坑直接呼应。"主机退出时先取消准备并停止托管进程树，再等待 HTTP 排空"，以及"意外退出（含退出码 0）视为失败，正常停止与预览切换不算"。梵禾 Work 在 Windows Job Object 与子进程回收上已有教训，这套判据可以直接复用。

### 2.8 技术栈与规模

| 层 | 技术 | 备注 |
|---|---|---|
| 桌面壳 | Tauri 2 | Rust，WebView2 / WKWebView |
| 后端 | Rust 2024 + axum + tokio + sqlx | 单二进制 `nomicore` |
| 数据 | SQLite（WAL） | v3 契约，UUIDv7，无物理外键 |
| 前端 | React 19 + Vite 6 + Arco Design + UnoCSS | HashRouter、SWR、xterm、Mermaid、KaTeX |
| 工具链 | Bun 1.3 | 工作区与脚本 |
| 模型 | Anthropic、OpenAI、OpenAI Responses、Gemini、Bedrock、Vertex | `nomi-providers` 1.9 万行 |
| 自动化 | `nomi-computer`（1.0 万行）、`nomi-browser-engine`（2.7 万行）、`nomi-a11y`（6.5 千行） | 跨 macOS/Linux X11/Wayland |
| 分发 | Tauri NSIS / DMG / AppImage / deb | 单文件实测 246MB |

实测规模，Rust 1,818 个文件 1,028,441 行，前端 2,262 个文件 355,848 行。测试文件 357 个（Rust）加 861 个（前端）。

---

## 3. 与 EvoFlow 的九维对照

| 维度 | EvoFlow | NomiFun | 判断 |
|---|---|---|---|
| 许可证 | PolyForm NC 1.0.0 | Apache-2.0 | NomiFun 可商用，决定性差异 |
| 语言栈 | Python 3.12 + FastAPI | Rust 2024 + axum | 两者都与梵禾的 TS 栈不同 |
| Agent 框架 | LangGraph 1.0.6 图编排 | 自研 Rust 执行循环 | 前者省力，后者可控 |
| 运行时位置 | 独立 PyInstaller 进程（sidecar） | 宿主进程内嵌 | 后者部署更简单 |
| 流式协议 | SSE + AG-UI 标准事件 | WebSocket 单例 + 事件总线 | 前者标准化，后者双向 |
| 状态存储 | SQLite 单连接 RLock，124 表 | SQLite sqlx，v3 契约，逻辑引用 | 前者简单，后者严谨 |
| 代码规模 | 约 115 万行 | 约 138 万行 | 同量级，都远超可整包移植的阈值 |
| 安装体积 | 572MB（含 384MB Python 运行时） | 246MB 单文件 | 后者更紧凑，仍偏重 |
| 社区规模 | 未见公开星数，单日 7 次提交 | 301 stars / 59 forks / 7 issues，单日 7 次提交 | 两者都在高频迭代 |
| 文档质量 | README 落后于代码，ARCHITECTURE 有治理清单 | 18 篇架构文档与代码一致，契约级描述 | NomiFun 明显更强 |
| 多用户 | 有组织、权限、计费、管理后台 | 单用户本地优先，Web 模式有 JWT 与管理员 | EvoFlow 更接近梵禾形态 |

来源：https://github.com/nomifun/nomifun-desktop （Apache-2.0，301 stars，pushed_at 2026-10-18，经 GitHub REST API v3 查询）；https://github.com/EvovexAI/EvoFlow

---

## 4. 分歧的本质，三个架构抉择

把两份实现放在一起看，差异可以收敛成三个抉择。这三个抉择也是梵禾 Work 必须自己回答的问题。

### 4.1 运行时放在进程内还是进程外

EvoFlow 把 Python 运行时打成独立二进制，由 Tauri 拉起。NomiFun 把 Rust 后端编进宿主进程，开独立线程跑 tokio。

进程外的好处是语言自由、崩溃隔离、可独立升级。代价是端口协商、僵尸进程、双运行时体积、以及"两个进程谁先就绪"的启动时序问题。EvoFlow 用 572MB 换来这些复杂度，NomiFun 用 246MB 换掉了它们。

对梵禾 Work 的含义是明确的。既然业务代码本来就在 Node 里，把 Agent 循环放进 Fastify 进程内是唯一合理选择，进程内方案在梵禾的语境下等价于 NomiFun 的选择，成本最低。

### 4.2 复杂度投向广度还是深度

EvoFlow 把复杂度花在请求管线的广度上，79 个中间件覆盖从线程目录、上传注入、沙箱获取、摘要、待办、标题、记忆、图片、计划守卫到澄清拦截的每一个横切点。它用"加一个中间件"解决新需求，扩展性极好，代价是任何一次请求都要穿过一条很长的链，调试需要理解链的完整语义。

NomiFun 把复杂度花在数据与权限模型的深度上，65 个 crate 围绕"规范事实、投影、效果、栅栏"构建，一份模块文档要写 277 行才能讲清并发与失败语义。它用"定义清楚谁是权威"解决新需求，可审计性极好，代价是任何新功能都要先回答一堆所有权问题。

这个对照对梵禾 Work 的实际指导是，现阶段应当学 EvoFlow 的广度式扩展，而非 NomiFun 的深度式契约。理由是团队规模与业务确定性都不支持后者，过早引入"每个操作都要有 Effect 回执"的规范，会让三个人的团队陷入设计会议。

需要保留一个反面。当 Agent 开始执行有副作用的真实操作（启动程序、填表、发消息），NomiFun 的"效果先持久化、未知结果不得自动重放"就成为必需品，而非过度设计。梵禾的 P1 阶段恰好会跨过这条线，届时应当局部引入，而非全盘否定。

### 4.3 流式协议选标准还是选表达力

EvoFlow 用 SSE 加 AG-UI 标准事件。好处是词表统一、第三方 UI 可直接消费、事件可回放。限制是单向，且必须自建断流恢复机制（它为此写了 `stream_resume`、`live_run_snapshot`、`content_block_ledger` 三个模块）。

NomiFun 用 WebSocket 单例加广播总线。好处是双向、可承载终端字节流与多类事件（会话、终端、定时、渠道、陪伴、SSH），且 `ssh.status` 这类"会话空闲时也会变化"的事件有地方走。代价是需要自己定义消息信封，标准化程度低。

梵禾 Work 的需求更接近 NomiFun。它的 Agent 要操作本地程序，会产生启动状态、窗口状态、填表进度这类非对话事件，SSE 单通道难以优雅承载。建议用 WS 承载传输，同时借用 AG-UI 的事件词表来描述对话内的事件，两者可以并存。

---

## 5. 许可证作为架构约束

前序报告已论证 EvoFlow 的 PolyForm NC 约束。加入 NomiFun 后，许可格局变成一组清晰的三分。

| 项目 | 许可 | 可商用 | 可修改分发 | 义务 |
|---|---|---|---|---|
| NomiFun | Apache-2.0 | 是 | 是 | 保留 LICENSE 与 NOTICE、标注修改、专利授权随分发 |
| EvoFlow | PolyForm NC 1.0.0 | 需授权 | 非商业目的可 | 保留 Required Notice，商用须书面许可 |
| DeerFlow | MIT | 是 | 是 | 保留版权与许可声明 |

三条推论。

第一，若团队需要"读代码并借鉴实现细节"，NomiFun 是唯一可以合法深入的对象。Apache-2.0 允许派生作品，只要保留声明与变更说明。EvoFlow 的代码只能作为"理解设计"的输入，不能成为"复制实现"的来源。

第二，NomiFun 的商标不在授权范围内。Apache-2.0 第 6 条明确不授予商标权。若考虑白标或二次分发，必须移除 NomiFun 品牌、图标与产品名，只保留 NOTICE 中的归属声明。这一点在"直接拿 NomiFun 做底座"的设想下是硬约束。

第三，NomiFun 自身的血统也需注意。NOTICE 声明部分 UI 交互参考 MIT 的 infinite-canvas，Agent 引擎部分改编自 Apache-2.0 的 OpenAI Codex（`nomi-redact` 脱敏器与 `nomi-config` 项目指令默认值），安装器模板来自 Tauri。这些都在 Apache-2.0 与 MIT 范围内，商用无额外障碍，但 NOTICE 必须原样保留。

---

## 6. 对梵禾 Work 的综合判断

### 6.1 三方定位对照

| 维度 | EvoFlow | NomiFun | 梵禾 Work |
|---|---|---|---|
| 产品形态 | 桌面 Agent 工作站 | 本地优先 AI 工作站 | 工作台启动器 + 协作平台 |
| 用户模型 | 多用户、组织、计费 | 单用户本地，Web 可选多用户 | 多用户、角色权限、服务端 |
| 数据位置 | 本地 SQLite | 本地 SQLite | 服务端 PostgreSQL |
| 运行时 | Python 进程外 | Rust 进程内 | 无 |
| 前端栈 | React + Vite + Tailwind + Radix | React + Vite + Arco + UnoCSS | React + Vite + Tailwind + Radix |
| 桌面壳 | Tauri 2 | Tauri 2 | Electron 44 |
| 分发体积 | 572MB | 246MB | 112MB |
| 核心差异化 | 多 Agent 协作、主动式员工、应用中心 | 本地优先、应用托管、电脑与浏览器操作 | 本地程序启动与凭据自动填充、中文电商场景 |

一个容易被忽略的观察。梵禾 Work 的 `apps/web/src/components/nomifun` 目录已存在但是空的。这可能只是占位，也可能说明此前已有引入 NomiFun 相关能力的意图。无论哪种，本文的结论都适用，即引入的是形态与契约，而非代码包。

### 6.2 重叠与差异

三者的能力重叠集中在四块。

| 能力 | EvoFlow | NomiFun | 梵禾 Work |
|---|---|---|---|
| 本地程序启动/托管 | 宿主直连工具（read/write/bash） | 完整应用托管生命周期 | 启动器 + 凭据自动填充 |
| IM 渠道 | 飞书、Slack、Telegram、钉钉 | Telegram、飞书、钉钉、微信 | 无 |
| 技能与 MCP | 84 个技能 + MCP 客户端 | 18 个内置技能 + MCP + OAuth | 无 |
| 多 Agent 协作 | 十态协作 + 任务账本 | AgentExecution DAG + 四策略 | 无 |

梵禾 Work 的真实差异不在功能清单，而在两处。

第一处是多用户与服务端。EvoFlow 有组织与权限但数据在本地，NomiFun 干脆是单用户本地优先。梵禾的登录、角色、审计、PostgreSQL 是另外两家都没有的产品骨架。这个骨架决定了它不能简单套用任何一家的数据模型。

第二处是中文电商场景的最后一公里。启动 QQ、千牛并自动填账号密码，这件事 EvoFlow 做不了（它没有窗口级自动化），NomiFun 能做但需要大量适配（它的 computer use 是通用能力，不含特定客户端的坐标与控件知识）。梵禾在这一点的积累是真实的护城河。

### 6.3 可复用资产合并清单

去重后按"契约、形态、实现"三层归类。

**契约层，可直接采用，无法律与体积成本**

| 资产 | 来源 | 用途 |
|---|---|---|
| SKILL.md 技能格式 | 两者一致 | 领域能力声明式扩展 |
| MCP 作为工具边界 | 两者一致 | 外部系统接入标准 |
| 工具七档分层 | EvoFlow | 控制工具爆炸，角色编辑器只暴露两档 |
| AG-UI 事件词表 | EvoFlow | 对话内事件的通用描述 |
| 四类执行策略（委派、计划门、决策、适应） | NomiFun | 长任务的可配置行为 |
| IDMM 的保守决策原则 | NomiFun | 副作用操作的暂停判据 |

**形态层，借鉴结构，自行实现**

| 资产 | 来源 | 说明 |
|---|---|---|
| 两宿主一前端 | NomiFun | 一份后端同时服务桌面壳与浏览器，梵禾可直接受益 |
| 本地信任令牌 + CSRF 双提交 | NomiFun | 桌面壳免登录而 Web 强制鉴权的分档 |
| 应用托管五段式生命周期 | NomiFun | install/build/start/stop/preview，梵禾启动器的升级方向 |
| 有界就绪等待（两秒 TCP 探测） | NomiFun | 解决"启动了但没就绪" |
| 进程身份三元校验 | NomiFun | PID + 原生创建键 + 可执行文件身份 |
| 会话四事实模型（Session/Turn/Event/Effect） | NomiFun | 长任务可恢复的基础 |
| 沙箱四方法接口 | EvoFlow | 让"在哪执行"可替换 |
| App/Task/Subtask/AppRun 四层建模 | EvoFlow | 模板与实例分离 |

**实现层，不建议移植**

| 资产 | 原因 |
|---|---|
| EvoFlow harness（31 万行 Python） | 许可受限、体积 572MB、LangGraph 绑定 |
| NomiFun Rust 后端（102 万行） | 语言栈不匹配、契约密度过高、246MB |
| 两家前端 | EvoFlow 76 万行、NomiFun 36 万行，均为整体应用而非组件库 |
| 创意画布、机器人、陪伴角色 | 与梵禾业务无关 |

---

## 7. 推荐方案与分期

### 7.1 总体形态

```
[Electron 主进程]
   ├─ 本地工具执行器（launch / fill / screenshot / read_file）
   ├─ WS 长连接（下行事件 + 上行工具结果）
   └─ 渲染层（React 19，消费 AG-UI 词表 + 自定义事件）

[Fastify 服务端]
   ├─ Agent 循环（模型 + 工具调度 + 状态机）
   ├─ 会话四事实（session / turn / event / effect）
   ├─ 工具注册表（远端工具 + 桌面代理工具 + MCP 工具）
   ├─ 技能加载器（SKILL.md）
   ├─ 执行策略（委派 / 计划门 / 决策 / 适应）
   └─ 应用托管（install/build/start/stop/preview）

[PostgreSQL + Prisma]
   ├─ agent_session / agent_turn / agent_event / agent_effect
   ├─ skill / skill_binding
   └─ app_template / app_run（可选）
```

这个形态吸收了 NomiFun 的两宿主思想，即同一套 Fastify 既服务 Electron 内置壳，也服务浏览器端；也吸收了 EvoFlow 的事件词表与工具分层。它没有吸收任何一方的数据契约，因为梵禾的 Prisma + PG 底座更成熟。

### 7.2 分期与工作量

沿用前序报告的估算口径，并因新信息做两处修订。P0 因明确了 WS 与四事实模型，增加 2 至 3 人日；P2 因引入应用托管生命周期，增加 8 至 12 人日。

| 阶段 | 内容 | 人日 |
|---|---|---:|
| P0 | 会话四事实 + Agent 循环 + WS 流 + 前端对话页 | 17 至 25 |
| P1 | 工具注册表与分层 + 桌面工具桥 + 技能加载器 + MCP 客户端 + 审批门 | 18 至 28 |
| P2 | 计划状态机 + DAG 调度 + 应用托管五段式 + 运行可视化 | 33 至 52 |
| 合计 | | 68 至 105 |

若只做 P0 加 P1，约 35 至 53 人日即可形成可演示产品。应用托管是梵禾启动器的自然升级，建议作为独立里程碑而非塞进 P2，这样可以在 AI 能力上线后再评估是否投入。

### 7.3 与前一版建议的差异

前一版建议"服务端循环 + 桌面工具桥"，本次维持不变。新增三条。

第一条，传输层从 SSE 改为 WebSocket。原因是梵禾需要承载启动状态、填表进度、任务进度等非对话事件，SSE 单通道会让这些事件被迫挤进对话流。

第二条，会话模型从"消息表"升级为四事实模型（会话、回合、事件、效果）。原因是一旦 Agent 能启动程序，就必须能回答"这次操作到底做没做成功"，仅靠消息记录无法支撑。

第三条，应用托管从"可选"提升为"推荐里程碑"。原因是它与梵禾现有启动器同域，复用面最大，且不需要模型即可先落地（NomiFun 明确"手动导入配置不需要 Agent 或模型"）。这条可以先于 AI 能力上线。

---

## 8. 难点与风险

| 难点 | 说明 | 应对 |
|---|---|---|
| 四事实模型的建模成本 | 需要重新设计会话表结构与投影逻辑，与现有消息表并存 | 先做双写灰度，稳定后切换读路径 |
| WS 生命周期 | 多标签页、断线重连、事件去重、刷新恢复 | P0 就设计事件序号与快照补齐，不留到后期 |
| 桌面工具桥的安全边界 | 凭据只从 stdin 读、不经 IPC 的既有约束不能被 Agent 绕过 | 工具层不暴露凭据读取，只暴露"用凭据执行动作" |
| 副作用审批 | Agent 能启动程序、填表、发消息 | 引入 NomiFun 的保守原则，权限/凭据/破坏性操作一律暂停 |
| 上下文管理 | 长会话必然超限 | 参考 EvoFlow 的压缩与大内容外置，P1 必做 |
| 体积控制 | 两家参考实现分别 572MB 与 246MB | 坚持服务端执行，桌面不引入模型运行时 |
| 概念通胀 | 两家合计 30 多个领域概念 | 梵禾只保留五个概念：会话、回合、工具调用、技能、任务 |

风险清单。

| 风险 | 等级 | 规避 |
|---|---|---|
| 误用 EvoFlow 代码导致许可违约 | 高 | 建立"参考来源登记"，EvoFlow 只读不抄；可抄对象限定为 NomiFun 与 DeerFlow |
| 照搬 NomiFun 契约导致过度设计 | 中高 | 只取其形态，不取其栅栏语义；Effect 回执仅在副作用工具上启用 |
| 低估 WS 与恢复的复杂度 | 高 | P0 预留 30% 缓冲，先内部灰度两周 |
| 单用户模型与多用户需求的冲突 | 中 | 明确梵禾走多用户服务端路线，不采用本地优先数据模型 |
| 商标与品牌风险 | 中 | 若做白标，移除 NomiFun 品牌与图标，保留 NOTICE 归属 |
| Rust 引入冲动 | 中 | 明确否决，梵禾的团队能力与交付节奏不支持双语言栈 |

最后一条风险值得单独说。NomiFun 的 Rust 实现质量很高，很容易让团队产生"我们也用 Rust 重写核心"的冲动。这个冲动的期望收益是性能与类型安全，期望成本是招聘、构建时间、与现有 Node 生态的集成摩擦。在梵禾当前的业务规模下，这笔交易不划算。

---

## 9. 结论

**第一，两份实现回答的是同一个问题的两种答案，而梵禾的问题更接近 NomiFun 的答案。** 那个问题是"Agent 运行时应该放在哪"。EvoFlow 选择进程外，用 572MB 与双运行时换来语言自由；NomiFun 选择进程内，用 246MB 换来部署简单。梵禾的业务代码本来就在 Node 里，进程内是唯一低成本选项。

**第二，许可证把两份实现分成了"可读"与"可抄"两类。** EvoFlow 的 PolyForm NC 让它只能作为设计参考，NomiFun 的 Apache-2.0 让它成为唯一可以合法深入代码的对象。这个约束应当写进团队的工程规范，而不是留在法务抽屉里。

**第三，真正稀缺的资产是契约，而非代码。** 两个项目合计 253 万行代码，其中能被梵禾直接使用的不足千分之一。但它们的六份契约（技能格式、MCP 边界、工具分层、AG-UI 词表、执行策略、应用托管生命周期）可以在数周内被吸收，且不带来任何体积与许可负担。

**第四，需要保留一个反方向判断。** 如果梵禾 Work 的定位可以从"工作台"放宽到"AI 工作站"，那么直接以 NomiFun 为底座做白标，在时间维度上可能优于自研。Apache-2.0 允许这样做，NomiFun 已具备应用托管、渠道、技能、MCP、电脑操作、多端 WebUI。代价是接受 Rust 技术栈、246MB 体积、以及单用户本地优先的数据模型与梵禾多用户服务端定位的根本冲突。这个冲突是决定性的，它让白标路线在架构上不成立，除非梵禾愿意放弃服务端多用户模型。

**建议的第一步。** 用一周时间做两件低成本验证。其一，把梵禾的启动器按 NomiFun 的五段式生命周期重构一版（不含 Agent），验证"应用托管"这一层能否独立产生价值。其二，用现有 Fastify 起一个最小 Agent 循环，只接一个工具（启动千牛），验证端到端链路与 WS 事件的可行性。两个验证合计不超过 8 人日，却能回答"要不要做"这个比"怎么做"更贵的问题。

---

## 附录 A 关键文件索引

| 主题 | NomiFun 路径 |
|---|---|
| 架构总览 | `docs/architecture/overview.md` |
| 后端 crate 职责 | `docs/architecture/backend-crates.md` |
| Agent 引擎 | `docs/architecture/agent-engine.md` |
| 会话与恢复 | `docs/architecture/agent-session.md` |
| 执行与决策 | `docs/architecture/agent-execution.zh.md` |
| 应用托管 | `docs/architecture/app-hosting.md` |
| 通信面 | `docs/architecture/communication.md` |
| 数据与存储 | `docs/architecture/data-and-storage.md` |
| 前端 | `docs/architecture/frontend.md` |
| 组合根 | `crates/backend/nomifun-app/src/{cli,services,lib}.rs`、`src/router/` |
| Agent seam | `crates/backend/nomifun-ai-agent/src/lib.rs` |
| 执行循环 | `crates/backend/nomifun-agent-runtime/src/lib.rs` |
| 供应商 | `crates/agent/nomi-providers/src/lib.rs` |
| 电脑操作 | `crates/agent/nomi-computer/src/lib.rs` |
| 进程运行时 | `crates/shared/nomi-process-runtime/src/lib.rs` |
| 技能资产 | `crates/backend/nomifun-skill-library/assets/builtin-skills/` |

## 附录 B 外部信源

- NomiFun 仓库与许可：https://github.com/nomifun/nomifun-desktop （Apache-2.0，301 stars，59 forks，pushed_at 2026-10-18，经 GitHub REST API v3 核验）
- EvoFlow 仓库与许可：https://github.com/EvovexAI/EvoFlow （PolyForm Noncommercial 1.0.0）
- DeerFlow 仓库与许可：https://github.com/bytedance/deer-flow （MIT，84,069 stars，pushed_at 2026-10-18）
- Apache License 2.0 正文：https://www.apache.org/licenses/LICENSE-2.0
- PolyForm Noncommercial 1.0.0 正文：https://polyformproject.org/licenses/noncommercial/1.0.0

---

*本文为工程与合规评估，法律结论不构成法律意见。涉及二次分发或白标时，建议由法务复核 Apache-2.0 的 NOTICE 保留义务与商标条款。*
