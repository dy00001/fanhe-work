# EvoFlow 架构解构与梵禾 Work 集成可行性评估

> 评估对象：EvovexAI/EvoFlow，版本 1.1.1，HEAD `b9c8c41`（2026-10-18）
> 评估时间：2026-10-19
> 事实来源：本地源码快照（浅克隆 30 次提交，7,784 个文件）、本地安装产物 `E:\EvoFlow`（572MB）、上游仓库元数据与许可证正文
> 说明：本文所有代码量与组件数量均为实测统计，工作量估算为工程判断，标注了假设前提

---

## 0. 结论摘要

**架构判断。** EvoFlow 是"LangGraph 内核 + 双层宿主"的产物。内核 `evoflow-harness`（31.0 万行 Python）承担 Agent 运行时，应用层 `app/gateway`（7.5 万行）承担协议与控制平面，外壳（Tauri + React，76.2 万行）承担交互。三层之间用 AG-UI 事件流与 REST 解耦，这是它最值得借鉴的工程决策，也是唯一让"部分复用"成立的前提。

**复用判断。** 真正可搬的是六个接口级资产，即技能契约、MCP 客户端、沙箱抽象、工具分层目录、代码索引、AG-UI 事件契约。它们对 LangChain 的依赖接近零。整包搬运不可行，安装态 572MB 相对梵禾 Work 的 112MB 是约 5 倍膨胀，且引入 Python 与 Node 双运行时。

**法律判断，这一条是决定性的。** EvoFlow 主协议是 PolyForm Noncommercial 1.0.0，商用需书面授权（`cloud@evovexai.com`）。但其 NOTICE 同时声明，核心 harness 部分源自 MIT 协议的 DeerFlow 2.0，`zcode-*` 前端源自 Apache-2.0 的 ZCode。存在合法的上游替代路径，这从根本上改变了迁移策略的选项集。

**落地建议。** 不做整包移植。走"服务端 Agent 内核 + 桌面工具桥"的自主实现，以 DeerFlow 2.0 作为合法的代码级参考，以 EvoFlow 作为产品化与协议设计参考。分期投入约 60 至 95 人日达到可用状态，长期总拥有成本显著低于维护一个 38 万行的 Python 分叉。

---

## 1. 事实基础与评估方法

本次评估基于三条独立证据链，避免只读 README 导致的失真。

| 证据源 | 用途 | 关键价值 |
|---|---|---|
| 源码快照（`git clone --depth 30`） | 模块划分、代码量、依赖耦合 | 可验证的结构事实 |
| 本地安装产物 `E:\EvoFlow` | 真实运行形态与体积 | 暴露打包方式与运行时构成 |
| 上游元数据（GitHub API、LICENSE、NOTICE） | 许可结构与血统 | 决定复用是否合法 |

需要指出一处文档与代码的偏差。`backend/README.md` 描述的目录结构是 `src/agents/`、`src/gateway/`，实际代码已迁移到 `backend/app/` 与 `backend/packages/harness/evoflow/`。这说明 README 落后于重构，评估必须以代码为准。该偏差本身也是一个信号，即项目处于高速迭代期，文档债务已经出现。

---

## 2. 项目定位与许可结构

### 2.1 产品定位

EvoFlow 自我定位是"面向长任务的原生 Agent Runtime 与控制平面"。这句话拆开看包含两层含义，对应两类完全不同的工程资产。

- **Runtime**，即 Agent 怎么跑起来。这部分是通用能力，任何 AI 产品都需要。
- **Control Plane**，即人怎么管 Agent。这部分是产品化能力，包含任务中心、员工值班、审批、计费、多租户。

这个二分法是后续复用评估的主轴。Runtime 层偏通用，Control Plane 层偏业务，两者的可迁移性差异极大。

### 2.2 许可结构，必须先于技术讨论

`LICENSE` 正文为 PolyForm Noncommercial License 1.0.0，`Required Notice: Copyright 2026 景银泰 (EvovexAI)`。该协议允许非商业目的的使用、修改与分发，商业目的需要单独授权。它对"非商业"的界定是"不以商业优势或金钱报酬为主要目的"，企业内部用于经营活动的工具通常难以落入这一豁免。

`NOTICE` 文件披露了三层血统，这是本次评估最重要的发现。

| 来源 | 许可 | 覆盖范围 | 商用可行性 |
|---|---|---|---|
| EvoFlow 原创 | PolyForm NC 1.0.0 | 主协议，覆盖未被下述声明豁免的部分 | 需书面授权 |
| DeerFlow（bytedance） | MIT | 核心 harness 的派生部分，NOTICE 明确"those files may be used under MIT terms for those portions" | 可商用，需保留版权声明 |
| ZCode（zai-org） | Apache-2.0 | `evopanel/src/zcode-ui`、`zcode-shared`、`zcode-rpc`、`zcode-provider`、`zcode-provider-node` | 可商用，需保留 NOTICE 与许可副本 |

这个结构带来一个反直觉的结论。EvoFlow 最值钱的那部分（Agent harness）恰恰是 MIT 血统最重的部分，而它自己原创的差异化部分（协作编排、主动式员工、应用中心、授权计费）受最严格的协议约束。换句话说，法律约束与商业价值呈负相关，这决定了迁移策略必须"取骨架、弃上层"。

经 GitHub API 核实，`bytedance/deer-flow` 为 MIT 协议，84,069 stars，最近推送时间 2026-10-18，其 `backend/packages/harness/deerflow/` 下的包清单（`agents`、`authz`、`community`、`config`、`knowledge`、`mcp`、`models`、`persistence`、`reflection`、`runtime`、`sandbox`、`scheduler`、`skills`、`subagents`、`tools`）与 EvoFlow 的 `evoflow/` 高度同构。这基本确认了分叉关系。

来源：https://github.com/bytedance/deer-flow （MIT，仓库元数据经 GitHub REST API v3 查询）

---

## 3. 架构总览

### 3.1 五层结构

```
┌──────────────────────────────────────────────────────────────┐
│ L1 外壳层   Tauri 2.11 (Rust)                                │
│     窗口 / 托盘 / 全局快捷键 / 更新签名(ed25519) / sidecar 生命周期 │
├──────────────────────────────────────────────────────────────┤
│ L2 交互层   React + Vite + Tailwind 4                        │
│     聊天 / Plan / Goal / 任务中心 / 资产中心 / 设置 / 技能市场      │
├──────────────────────────────────────────────────────────────┤
│ L3 协议层   FastAPI Gateway（73 个路由模块，单 uvicorn 进程）      │
│     REST + SSE(AG-UI) + WS + OpenAI 兼容 /v1 + IM 渠道            │
├──────────────────────────────────────────────────────────────┤
│ L4 内核层   evoflow-harness（1,126 文件 / 31.0 万行）            │
│     Lead Agent / 中间件链 / 工具 / 沙箱 / 子 Agent / 技能 / MCP    │
│     记忆 / 知识库 / 代码索引 / 协作编排 / 主动式引擎 / 可观测        │
├──────────────────────────────────────────────────────────────┤
│ L5 存储层   SQLite(WAL) + 工作区目录 + sqlite-vec               │
│     124 张表 / 每线程隔离目录 / FTS5 + 向量召回                    │
└──────────────────────────────────────────────────────────────┘
```

分层规则被写成了 CI 强制项，见 `backend/ARCHITECTURE.md`。规则 R1 规定内核不得 import 应用层，现存违规被登记在 `scripts/arch_ban_app_imports_baseline.txt`（60 条），且"清单只许缩短"。内核需要反向调用应用层时，只能通过 `evoflow/runtime/` 里定义的端口（Protocol）加启动时注册适配器。这是一条清晰的依赖倒置实践，也是该项目架构纪律最扎实的地方。

需要辩证地看这条规则。规则存在，同时存在 60 条存量违规，说明治理是"先冻结再收敛"的务实做法，而非教条。`ARCHITECTURE.md` 的修复计划五阶段中，第一阶段（把 49 个 `app.gateway` 加 11 个 `app.channels` 的 import 迁到端口）仍未完成。这意味着内核当前并非完全可独立发布，任何"只搬 harness"的想法都要先做依赖切割验证。

### 3.2 进程与部署形态

存在两种形态，差异很大。

| 形态 | 进程模型 | 端口 | 适用场景 |
|---|---|---|---|
| 开发态 | Nginx + LangGraph Server + Gateway + 前端，四进程 | 2026 / 2024 / 8001 | 二次开发 |
| 发布态 | 单个 PyInstaller 二进制内嵌 LangGraph（`LANGGRAPH_RUNTIME_EDITION=inmem`），挂载在 `/api/langgraph` | 单端口，动态分配 | 桌面安装包 |

发布态的关键实现是 `app/gateway/lazy_langgraph.py` 把 LangGraph 运行时设为 inmem 并挂到同进程，`app/gateway/app.py` 里注释写明"LangGraph is mounted in-process under /api/langgraph (single uvicorn process)"。这样做的好处是消除跨进程序列化与端口协商，代价是单进程承载全部并发，故障域不可分割。

本地实测体积构成如下，这组数字直接决定集成成本。

| 组成部分 | 体积 |
|---|---|
| `binaries/` 总计 | 572MB |
| `_internal/`（Python 运行时与三方库） | 384MB |
| `tree_sitter_languages` | 80MB |
| `speech_recognition` | 43MB |
| `evoflow`（业务代码 + 资源） | 36MB |
| `_duckdb` | 34MB |
| `onnxruntime` | 29MB |
| `numpy.libs` + `pandas` + `PIL` | 47MB |

---

## 4. 模块划分与核心组件

### 4.1 内核层包清单（按代码量排序，实测）

| 包 | 行数 | 文件 | 职责 | 血统推断 |
|---|---:|---:|---|---|
| `agents` | 59,689 | 199 | Lead Agent、目标图、中间件、记忆插件、任务态 | 分叉 + 扩展 |
| `tools` | 34,610 | 115 | 工具目录、内置工具、宿主直连文件与终端 | 分叉 + 扩展 |
| `persistence` | 30,252 | 63 | SQLite schema 与仓储（唯一 DB 所有者） | 分叉 + 扩展 |
| `collab` | 20,371 | 64 | 任务编排账本、工作流、子任务流式 | EvoFlow 原创 |
| `proactive` | 19,032 | 36 | 心跳、主动式引擎、员工值班 | EvoFlow 原创 |
| `eval` | 14,056 | 68 | 评测集与指标 | EvoFlow 原创 |
| `knowledge` | 13,417 | 47 | 知识库、索引、向量化 | 分叉 + 扩展 |
| `admin` | 12,980 | 29 | 后台管理 | EvoFlow 原创 |
| `observability` | 9,941 | 26 | Trace 存储、延迟瀑布、思考上下文 | 分叉 + 扩展 |
| `community` | 9,866 | 60 | 搜索、抓取、媒体生成等三方集成 | 分叉 |
| `assets` | 6,829 | 31 | 经验、流程、反思、技法四类资产库 | EvoFlow 原创 |
| `config` | 6,621 | 37 | 按特性分组的强类型配置 | 分叉 |
| `plugins` | 5,594 | 14 | 插件装载 | EvoFlow 原创 |
| `models` | 5,579 | 16 | 模型工厂、厂商载荷适配 | 分叉 |
| `code_index` | 4,539 | 14 | 符号图、FTS5、tree-sitter、LSP | EvoFlow 原创 |
| `memory` | 3,705 | 16 | 记忆门面、固化、知识图谱抽取 | EvoFlow 原创 |
| `authz` | 3,371 | 19 | 主体、工作区可见性 | 分叉 |
| `mcp` | 3,098 | 14 | MCP 客户端池、OAuth、市场 | 分叉 |
| `skills` | 2,881 | 17 | 技能加载、安装、注入 | 分叉 |
| `subagents` | 2,760 | 19 | 子 Agent 注册表与执行器 | 分叉 |
| `sandbox` | 2,399 | 8 | 沙箱抽象与本地提供者 | 分叉 |
| `a2a` | 1,937 | 7 | Agent 间会议协议 | EvoFlow 原创 |
| `license` | 1,247 | 10 | 本地授权码、机器绑定、权益门 | EvoFlow 原创 |
| `scheduler` | 1,333 | 10 | 本地工具调度（预取、编辑后 lint） | 分叉 |
| `session_execution` | 1,074 | 9 | 会话运行生命周期与取消 | EvoFlow 原创 |

合计 1,126 个 Python 文件，310,417 行。

### 4.2 应用层网关

73 个路由模块，覆盖对话会话、任务、协作、Agent 角色、应用中心、自动化调度、渠道、知识库、技能、MCP、模型、记忆、资产、评测、可观测、授权、组织、平台配置等。其中体量最大的几个是 `debug_agent_trace.py`（115KB）、`chat_sessions.py`（71KB）、`agents.py`（59KB）、`automation_runner.py`（62KB）。

路由注册采用延迟导入（`router_registry.py`），并按 `optional=True` 标记可失败模块，注释写明"packaged builds must not brick employee / apps / automation behind a permanent 503"。这是一个成熟的发布态容错设计，值得记录。

### 4.3 交互层

2,962 个前端文件，761,784 行。其中 `src/zcode-*` 五个目录共约 24MB，`zcode-ui` 单独 17MB，属 ZCode 的 Apache-2.0 内嵌件。`src/react/ChatApp.tsx` 单文件 16,966 行，是整个聊天交互的巨石组件。

这个体量说明一件事，前端属于高度耦合的应用，谈不上"可复用的组件库"。任何想搬 UI 的尝试都会陷入 1.7 万行单文件的泥潭。

### 4.4 存储层

`persistence/db.py` 的设计值得单独说明。全进程单连接，`check_same_thread=False`，每条语句加 `RLock`，并显式注释"FastAPI / asyncio.to_thread workers never open concurrent writers on separate connections (the usual cause of database is locked here)"。`schema.py` 内 124 处 `CREATE TABLE`。

这是一个面向桌面单机的存储设计，用串行化换取稳定性。它对服务端多租户场景不适用，对梵禾 Work 反而是好消息，因为不需要继承这套模型，可以直接用既有的 PostgreSQL 与 Prisma。

---

## 5. 技术栈清单

| 层 | 技术 | 版本约束 | 备注 |
|---|---|---|---|
| 外壳 | Tauri | 2.11 | Rust，sidecar 管理，ed25519 更新签名 |
| 外壳 | WebView2 | 系统内置 | Windows 走 `embedBootstrapper` |
| 交互 | React + Vite | Vite 8 系 | 与梵禾 Work 的 React 19 + Vite 8 同代 |
| 交互 | Tailwind | 4.3 | 与梵禾 Work 的 Tailwind 4 一致 |
| 交互 | Radix UI | 1.x | 与梵禾 Work 已用的 Radix 同族 |
| 交互 | AG-UI | `@ag-ui/core` 0.0.57 | 事件协议契约 |
| 交互 | Zustand / Lexical / Mermaid / Streamdown | | zcode-ui 内 |
| 网关 | FastAPI + uvicorn | 0.115+ / 0.34+ | SSE 用 sse-starlette |
| 内核 | LangGraph | 1.0.6 至 1.0.9 | 图编排与检查点 |
| 内核 | LangChain | 1.2.3+ | 模型与工具抽象 |
| 内核 | langchain-mcp-adapters | 0.1.0+ | MCP 接入 |
| 内核 | agent-sandbox | 0.0.19+ | 沙箱提供者 |
| 存储 | SQLite (WAL) + sqlite-vec | | 向量检索用 vec0 虚拟表 |
| 检索 | sentence-transformers + onnxruntime | | 本地 BGE 类向量模型 |
| 解析 | markitdown / tree-sitter / jieba / DuckDB | | 文档转换、代码索引、中文分词 |
| 浏览器 | Playwright | 1.54+ | 内嵌浏览器与抓取 |
| 集成 | lark-oapi / slack-sdk / python-telegram-bot / dingtalk-stream | | IM 渠道 |

依赖重心很清楚。真正吃体积与吃风险的是 `sentence-transformers`（拉 PyTorch 或 onnxruntime）、`tree_sitter_languages`（80MB 预编译语法库）、`playwright`（浏览器内核）、`DuckDB`。这四个恰好都属于检索与浏览器能力的外围，Agent 运行时本身并不需要它们。

---

## 6. 数据流向

### 6.1 对话主链路

```
用户输入
  → ChatApp.tsx（乐观渲染 + 本地消息表）
  → POST /api/chat/sessions/{key}/messages 或 /api/langgraph/threads/{id}/runs/stream
  → Gateway middleware（鉴权、UTF-8、trace）
  → LangGraph（in-process，thread 检查点）
  → make_lead_agent() 组装：模型 → 工具 → 79 个中间件按序 → 系统提示（技能 + 记忆 + 子 Agent 指令）
  → 模型流式输出 → 工具调用 → 沙箱执行 / MCP 调用 / 子 Agent 委派
  → EVF 语义载荷 → agui_stream_normalizer 归一化为 AG-UI 事件
  → SSE（event: ag-ui）→ 前端 parseStreamBlockWire → 分块渲染
  → 持久化：transcript 落 evoflow_chat_messages，运行态落 live_run
```

关键设计点在中间那一层归一化。后端内部使用自有语义载荷（EVF），出口统一投影成 AG-UI 标准事件，前端只认 AG-UI。这形成了一道稳定的协议边界。`agui_stream_normalizer.py` 单文件 109KB，说明投影逻辑的复杂度被刻意集中在一处。

### 6.2 任务协作链路

```
App 定义（SOP 模板，含 {{param}} 占位）
  → render_plan()（纯内存参数渲染）→ PlanInput
  → evoflow_collab_tasks（执行实例）
  → plan_steps 展开为 evoflow_collab_subtasks（DAG 调度单元）
  → 子任务会话 → 子 Agent 执行 → 结果回填 → 验收
  → AppRun 记录（哪个 App / 哪一版 / 哪些参数 / 哪个 task）
```

`collab/app_schema.py` 的注释把三层存储的职责写得非常清楚，明确"App 表只存可复用定义，不要塞运行结果"，并指出 Task 上的 `plan_*` 是"某次开跑后的物化 plan，不是第二套应用定义"。这是一份高质量的数据建模说明，属于可以直接借鉴的设计资产。

### 6.3 主动式链路

```
心跳调度（proactive/runner.py）
  → 值班员工（employee_prompt + departments + kpi_checker）
  → 触发判定（triggers + decision_gate + overlap 去重）
  → 执行桥（execution_bridge）复用同一套 Agent 运行时
  → 推送绑定（feishu / wecom）→ 结果回传
```

这条链路的产品含义是把 Agent 从"被动应答"变成"有班次的员工"。技术实现上没有新运行时，全部复用对话链路，属于编排层的组合创新。

### 6.4 装配链路

`get_available_tools()` 的四段式装配（config.yaml 定义 → MCP 工具懒加载 → 内置工具 → 子 Agent 的 `task` 工具）加工具分层目录（runtime / core / workspace / plan / goal / optional / retired 七档），是控制"工具爆炸"的有效手段。`tool_catalog.py` 明确只有 workspace 与 optional 两档对角色编辑器可见，其余由模式在运行时注入。这个分层思路对任何要接 50 个以上工具的 Agent 产品都有参考价值。

### 6.5 可观测链路

Trace 落 SQLite，包含 invocation kinds、延迟瀑布、思考上下文、缓存命中与计价。`observability/sqlite_store.py` 与 `queries.py` 构成查询层。前端有独立的 `agent-trace.js` 页面族。这条链路的价值不在实现，而在数据模型，它回答了"一次 Agent 运行应该记录什么才够复盘"。

---

## 7. 依赖关系与耦合分析

用"引用 LangChain/LangGraph 的文件占比"作为耦合度代理指标，实测结果如下。

| 包 | 含 LangChain 引用的文件 | 总文件 | 耦合度 | 可移植性 |
|---|---:|---:|---|---|
| `skills` | 0 | 17 | 0% | 高 |
| `memory` | 0 | 16 | 0% | 高 |
| `code_index` | 0 | 14 | 0% | 高 |
| `subagents` | 1 | 19 | 5% | 较高 |
| `sandbox` | 2 | 8 | 25% | 中 |
| `mcp` | 5 | 14 | 36% | 中 |
| `proactive` | 4 | 36 | 11% | 中（业务耦合重） |
| `collab` | 7 | 64 | 11% | 中（业务耦合重） |
| `observability` | 5 | 26 | 19% | 中 |
| `persistence` | 11 | 63 | 17% | 中 |
| `tools` | 73 | 115 | 63% | 低 |
| `agents` | 99 | 199 | 50% | 低 |

这张表推翻了一个常见假设，即"内核是一个整体，要么全要要么全不要"。事实是内核内部的可移植性差异达 5 倍以上。`skills`、`memory`、`code_index` 三个包在语言层面就是干净的 Python，搬到任何技术栈都只是"读懂契约再实现"的问题。

另一条依赖链是跨语言的方向。前端只依赖 AG-UI 与 REST，不依赖 Python 任何实现。这意味着"换后端"在协议层是被允许的，这是 EvoFlow 架构上最克制也最正确的决定。

---

## 8. 可复用性评估

### 8.1 评估维度

采用四个维度打分，避免只看"功能是否相似"。

| 维度 | 含义 | 权重理由 |
|---|---|---|
| 契约清晰度 | 是否能用一页纸描述清输入输出 | 决定能否独立重实现 |
| 语言耦合 | 是否绑定 Python 生态 | 决定搬运成本 |
| 法律可用性 | 是否落在 MIT / Apache 范围内 | 决定是否合法 |
| 业务耦合 | 是否依赖 EvoFlow 特有概念 | 决定改造成本 |

### 8.2 分级结论

**A 级，建议直接借鉴契约并在梵禾 Work 内重实现（法律干净、契约清晰）**

| 资产 | 具体内容 | 复用方式 |
|---|---|---|
| 技能规范 | `SKILL.md` + YAML frontmatter（`name` / `description` / `license` / `allowed-tools`），目录扫描、mtime 缓存、启用态、按需注入系统提示 | 直接采用格式，自研 200 至 300 行加载器 |
| 工具分层目录 | 七档分级（runtime/core/workspace/plan/goal/optional/retired），角色编辑器只暴露两档 | 直接采用分层模型 |
| 沙箱抽象 | `execute_command` / `read_file` / `write_file` / `list_dir` 四方法接口，虚拟路径 `/mnt/user-data/{workspace,uploads,outputs}` 到物理目录的映射 | 直接采用接口形状 |
| 代码索引 | tree-sitter 抽符号 + FTS5 + 文件依赖图（`file_deps`），支持 py/js/ts/java | 采用方案，用 SQLite FTS5 或 PG 全文索引落地 |
| AG-UI 事件契约 | SSE `event: ag-ui`，事件类型对齐 `@ag-ui/core`，含 CUSTOM 事件承载业务扩展（如 `kb_citations`） | 直接采用协议，前后端都省事 |
| 存储建模 | App / Task / Subtask / AppRun 四层职责划分，`{{param}}` 参数渲染 | 直接采用模型，映射到 Prisma |

**B 级，建议借鉴设计思想，不搬实现**

| 资产 | 价值 | 不建议直接搬的原因 |
|---|---|---|
| 中间件链 | 横切关注点单一出口，顺序即语义 | 79 个中间件里至少 40 个服务于 EvoFlow 特有概念（collab 阶段、mission state、scenario 激活），剥离成本高于重写 |
| 目标图（goal） | 长任务自动续跑与完成判定 | 与 LangGraph 检查点强绑定 |
| 协作状态机 | idle → req_confirm → planning → plan_ready → awaiting_exec → executing → verifying → reflecting → paused → done | 状态划分极有价值，实现依赖任务账本 |
| 可观测数据模型 | 一次运行该记什么 | 表结构 124 张，需裁剪 |
| 记忆/资产四分类 | memory / process / reflection / craft | 与业务语义强绑定 |

**C 级，不建议复用**

| 资产 | 原因 |
|---|---|
| 完整 harness | 31 万行，Python，LangGraph 强绑定，法律受限 |
| 前端 UI | 76 万行，`ChatApp.tsx` 单文件 1.7 万行，zcode-ui 17MB |
| 主动式员工 | 业务语义极重（部门、KPI、值班、飞书/企微推送） |
| 授权计费 | PolyForm 原创部分，且与商业目标直接冲突 |
| 评测体系 | 1.4 万行，依赖其自有数据集与指标定义 |

### 8.3 六个接口级资产的价值排序

按"投入产出比"排序，而非按代码量。

1. **AG-UI 事件契约**。零成本采用，一次性解决前后端协议、断流恢复、工具卡片渲染的数据形状问题。这是整份报告里性价比最高的一项。
2. **技能规范**。把"领域知识"从代码里剥离成 Markdown，这是让产品团队而非工程团队扩展 Agent 能力的关键。梵禾 Work 的业务场景（电商客服、订单处理、素材生成）恰好适合用技能表达。
3. **工具分层目录**。防止工具数量增长后模型选择困难与提示膨胀。
4. **沙箱四方法接口**。让"在哪执行"成为可替换项。
5. **存储四层建模**。避免把"模板定义"和"运行实例"混在一张表里，这是同类产品最常见的建模错误。
6. **代码索引**。仅当梵禾 Work 要做"本地项目问答"时才需要，优先级最低。

---

## 9. 与梵禾 Work 的适配点

### 9.1 现状盘点（实测）

| 维度 | 现状 |
|---|---|
| 桌面 | Electron 44，主进程内置静态服务 + `/api` 反代，加载 `apps/web/dist` |
| 前端 | React 19 + Vite 8 + Tailwind 4 + Radix + react-router 8 + react-markdown |
| 服务端 | Fastify 5 + Prisma 7.10 + PostgreSQL，部署于 `work.fanhe.dpdns.org` |
| 已有能力 | 登录鉴权、用户与权限、应用启动器（QQ/千牛，含凭据自动填充）、笔记、事件、托盘、更新通道 |
| AI 能力 | 无。全仓库检索 `openai|anthropic|llm|deepseek|dashscope` 仅命中一个与 LLM 无关的登录点击脚本 |
| 安装包 | 112MB（v0.1.5） |

这个盘点得出一个明确判断。梵禾 Work 的底座（React 19 + Vite 8 + Tailwind 4 + Radix + Fastify + Prisma + PG）与 EvoFlow 的前端技术选型高度同代，迁移 UI 概念的成本低。但后端语言栈完全不同（Node 对 Python），这决定了任何"搬后端"的方案都要付出双运行时代价。

### 9.2 能力缺口映射

| 梵禾 Work 缺口 | EvoFlow 对应模块 | 适配度 | 说明 |
|---|---|---|---|
| 对话式助手 | Lead Agent + 中间件链 | 中 | 需重实现循环，概念可直接用 |
| 会话与消息持久化 | `chat_sessions` + transcript | 高 | 梵禾已有 Prisma，建模可平移 |
| 让 AI 操作本地程序 | 工具系统 + 宿主直连工具 | 高 | 与梵禾的启动器天然契合 |
| 领域能力扩展 | 技能系统 | 极高 | 纯 Markdown，产品团队可维护 |
| 接外部系统 | MCP 客户端 | 高 | 与梵禾的集成诉求一致 |
| 长任务（如批量上架、批量素材） | 目标图 + 协作 DAG | 中 | 概念可用，实现需自研 |
| 运行过程可视化 | 可观测 + AG-UI | 高 | 协议可直接采用 |
| 定时/值班型任务 | 主动式引擎 | 中低 | 业务语义需重设计 |
| 本地代码/文档问答 | 代码索引 + 知识库 | 中 | 按需，非首期 |

### 9.3 架构落位建议

这里有一个关键决策，即 Agent 运行时放在哪一侧。三个选项。

| 选项 | 运行时位置 | 优势 | 劣势 |
|---|---|---|---|
| 桌面内嵌 | Electron 主进程内 Node | 本地工具调用零延迟，离线可用 | 模型密钥下发到客户端，算力与内存受终端限制，多端不同步 |
| 服务端 | Fastify 侧新增 Agent 服务 | 密钥集中、算力可扩、多端共享会话 | 本地工具（启动程序、读本地文件）需回传通道 |
| 混合 | 服务端跑循环，桌面跑工具 | 兼顾安全与本地能力 | 协议设计复杂，需处理断连与超时 |

推荐混合方案，理由有三。

第一，梵禾 Work 已经具备现成的双向通道基础。Electron 主进程与渲染进程之间已有 IPC，服务端与桌面之间已有 `/api` 反代与登录态。把"工具执行请求"作为一条新的下行消息，比从零建立通道便宜得多。

第二，密钥安全是硬约束。梵禾 Work 是分发给终端用户的产品，把模型 API Key 打进安装包或落到本地存储会直接导致密钥泄露。服务端持有密钥是唯一可持续的做法。

第三，本地能力是梵禾 Work 的差异化所在。它能启动 QQ、千牛并自动填表，这是纯云端产品做不到的。Agent 要产生业务价值，必须能调用这些本地动作。

落地形状如下。

```
[Electron 主进程]
   ├─ 本地工具执行器（launch / fill / read_file / screenshot）
   ├─ 长连接（WS 或 SSE 下行 + HTTP 上行）
   └─ 渲染层（React，消费 AG-UI 事件）

[Fastify 服务端]
   ├─ /api/agent/sessions       会话与消息（Prisma）
   ├─ /api/agent/runs/:id/stream  AG-UI SSE
   ├─ Agent 循环（模型调用 + 工具调度 + 状态机）
   ├─ 工具注册表（远端工具 + 代理到桌面的本地工具）
   ├─ 技能加载器（SKILL.md）
   └─ MCP 客户端池

[PostgreSQL]
   ├─ agent_session / agent_message
   ├─ agent_run / agent_tool_call
   ├─ skill / skill_binding
   └─ app_template / app_run（若做模板化 SOP）
```

---

## 10. 集成路线对比

| 方案 | 做法 | 工期 | 体积影响 | 法律 | 长期维护 |
|---|---|---|---|---|---|
| A 整包 sidecar | 把 572MB gateway 打进安装包，Electron 拉起 Python 进程 | 8 至 12 人日 | +450 至 550MB | 违规（商用需授权） | 需跟进上游，38 万行分叉 |
| B 协议对接 | 用户自行安装 EvoFlow，梵禾作为客户端调其 AG-UI / OpenAI 兼容接口 | 5 至 8 人日 | 无 | 分发形态仍需评估 | 受制于第三方产品 |
| C 选择性重写 | 采用 A 级契约，在 Node 侧重实现内核 | 60 至 95 人日 | +5 至 15MB | 干净（自研 + MIT 参考） | 完全自主 |
| D 上游 DeerFlow | 以 MIT 的 DeerFlow 2.0 为代码基线做二次开发 | 25 至 40 人日 | +300MB 以上 | 合法 | 需跟进 DeerFlow，仍是 Python |

**方案 A 的辩证评价。** 它在时间压力下是合理的。一周内就能拿到一个功能完整的 Agent 产品，且经过真实用户打磨。代价是三重的，法律上需要先取得授权，工程上要处理 Python 与 Electron 的进程生命周期（梵禾 Work 已经在 Windows Job Object 上踩过坑，Python sidecar 会重复同类问题），体验上安装包从 112MB 涨到 660MB 左右，下载与更新成本都会显著上升。

**方案 C 的辩证评价。** 它看起来最慢，实际风险最低。原因是 Agent 运行时的核心循环并不复杂，大约 800 至 1,500 行就能跑通"模型 → 工具 → 结果 → 再模型"。真正耗时的是边界情况，即工具调用失败重试、流式断连恢复、上下文超限压缩、并发工具调度。这些恰好是 EvoFlow 用 31 万行代码在解决的问题，也是自研最容易低估的部分。

**推荐路径是 C 为主，B 为辅。** 首期用方案 B 做能力验证（不写进产品，只在内部评估 Agent 能否解决真实业务问题），验证通过后按 C 分期实现。这样避免了"先建一套再发现没用"的沉没成本。

---

## 11. 推荐路线与分期工作量

假设投入一名熟悉 TypeScript 与 Node 的全栈工程师，加一名前端工程师，均熟悉现有代码库。

### P0 最小可用对话内核（15 至 22 人日）

| 任务 | 人日 | 交付物 |
|---|---:|---|
| 数据模型与 Prisma 迁移 | 2 | `agent_session` / `agent_message` / `agent_run` |
| Agent 循环（流式、工具调用、中断恢复） | 6 至 9 | 服务端模块 |
| AG-UI 事件投影与 SSE 端点 | 3 | `/api/agent/runs/:id/stream` |
| 前端聊天界面（复用现有 react-markdown 与 Radix） | 4 至 6 | 新页面 |
| 模型接入与密钥管理 | 1 | 配置项 + 服务端调用 |
| 基础可观测（run 与 tool_call 落库） | 1 | 复盘页雏形 |

验收标准，能完成一次含 3 个以上工具调用的多轮对话，断流后可恢复，全链路有 trace。

### P1 工具与技能（18 至 28 人日）

| 任务 | 人日 | 说明 |
|---|---:|---|
| 工具注册表与七档分层 | 3 | 直接采用 EvoFlow 分层模型 |
| 桌面工具桥（IPC 下行 + 结果上行） | 5 至 8 | 接 launch / fill / read_file / screenshot |
| 技能加载器（SKILL.md + 启用态 + 注入） | 3 | 参考 `skills` 包契约 |
| 技能管理界面 | 3 | 列表、启停、编辑 |
| MCP 客户端（stdio + HTTP） | 4 至 6 | 参考 `mcp` 包，Node 侧有官方 SDK |
| 工具调用可视化卡片 | 3 | 参考其 tool card 数据形状 |

验收标准，业务人员能通过写一个 `SKILL.md` 让助手获得新能力，无需改代码。

### P2 长任务与模板化（25 至 40 人日）

| 任务 | 人日 | 说明 |
|---|---:|---|
| 计划状态机（plan / execute / verify） | 6 至 8 | 参考 collab 十态，裁剪为五态 |
| 任务与子任务 DAG 调度 | 8 至 12 | 并发上限、超时、重试 |
| SOP 模板（`{{param}}` 渲染） | 4 | 参考 `app_engine.py` |
| 运行过程可视化 | 4 至 6 | 时间线 + 步骤态 |
| 人工审批门 | 3 至 4 | 副作用工具前置确认 |

验收标准，一个"批量处理 N 条订单"的任务可后台跑，中途可暂停、可干预、可复盘。

合计 58 至 90 人日。若只做 P0 加 P1，约 33 至 50 人日即可形成可对外演示的产品能力。

---

## 12. 集成难点

按"踩坑概率"排序。

**1. 双运行时与进程生命周期。** 若走 sidecar 路线，Python 进程需要与 Electron 同生共死，涉及端口协商、僵尸进程回收、崩溃重启。梵禾 Work 在 Windows 上已经验证过 agent 进程树内的 Job Object 会导致 Electron 类应用崩溃（QQ 启动问题的真因），引入 Python sidecar 会重复这一整类问题。走方案 C 可完全规避。

**2. 安装包体积与更新成本。** 当前 112MB 的安装包，更新走 electron-updater 的 blockmap 差分。若膨胀到 600MB 以上，差分更新失效概率上升，全量下载在弱网环境不可接受。体积是产品体验问题，不只是存储问题。

**3. 流式协议的生命周期管理。** SSE 断连、重连、事件去重、多标签页并发、页面刷新后恢复现场。EvoFlow 用了 `stream_resume`、`live_run_snapshot`、`content_block_ledger` 三个模块才解决，说明这是真正难的部分。自研时必须在 P0 就设计好，不能后补。

**4. 上下文窗口管理。** 长对话必然超限，需要压缩、摘要、工具结果截断、大内容外置（EvoFlow 有 `large_content_offload_middleware` 与 `tool_result_store`）。这部分如果缺失，产品在真实使用 2 至 3 周后就会开始出现"失忆"投诉。

**5. 凭据与密钥边界。** 梵禾 Work 已有 `credentialVault` 管理 QQ/千牛账号，且明确"凭据只从 stdin 读、不经 IPC"。Agent 若需要读取这些凭据（例如自动登录某后台），必须复用同一套边界，不能因为"AI 要方便"而放宽。这是安全红线。

**6. 工具副作用与审批。** 让 Agent 能启动程序、填表、发消息，意味着它能造成真实后果。EvoFlow 的做法是 `tool_approval` 中间件加 `PlanGuardMiddleware` 在规划阶段过滤副作用工具。梵禾 Work 必须在 P1 就引入审批门，否则一次误操作就可能造成业务事故。

**7. 与现有单实例锁和托盘模型的冲突。** 梵禾 Work 有单实例锁与托盘实例卡，Agent 后台运行时如何与托盘交互（是否显示运行中状态、是否允许在托盘里取消任务）需要在设计阶段一并考虑。

---

## 13. 风险与规避

| 风险 | 等级 | 影响 | 规避方案 |
|---|---|---|---|
| 许可证风险 | 高 | 商用分发 PolyForm 代码可被追责，且违反协议后 32 天内未整改则全部授权终止 | 方案 C 自研；若必须用其代码，先向 `cloud@evovexai.com` 取得书面授权；参考实现改用 MIT 的 DeerFlow 2.0 |
| 血统混杂导致授权不清 | 中高 | 无法界定哪一行属于 MIT 哪一行属于 NC | 以文件为单位隔离，只参考 NOTICE 明确列出的 MIT 路径；不复制 EvoFlow 原创目录（collab / proactive / assets / license / eval / admin） |
| 供应链风险 | 中 | 上游高频迭代（单日 7 次提交），API 与文档漂移 | 锁定参考版本快照，不在生产依赖其代码 |
| 低估长尾复杂度 | 高 | 首版可用，真实使用 1 个月后集中暴露上下文、重试、并发问题 | P0 预留 30% 缓冲，先做内部灰度 2 周 |
| 体积膨胀 | 中 | 安装与更新体验下降 | 坚决不引入 Python 运行时；向量检索用服务端而非本地模型 |
| 密钥泄露 | 高 | 直接经济损失 | 密钥只在服务端，桌面永不落盘；沿用现有 vault 边界 |
| Agent 误操作 | 高 | 业务事故 | 副作用工具默认需人工确认，白名单化本地动作 |
| 团队能力错配 | 中 | 前端团队被要求写 Agent 循环，交付质量下降 | 明确归属，服务端团队负责循环与工具层，前端只负责协议消费与渲染 |

补充一条容易被忽略的风险，即"概念通胀"。EvoFlow 有 20 多个领域包，每个都对应一套术语（scenario、mission state、collab phase、asset、craft、reflection）。若照搬术语体系，梵禾 Work 的代码库会迅速变得难以理解。建议只保留五个概念，会话、运行、工具调用、技能、任务，其余全部砍掉。

---

## 14. 结论

三条判断，按重要性排列。

**第一，EvoFlow 的架构价值高于其代码价值。** 它把 Agent 产品拆成了"协议层 / 运行时层 / 控制平面层"，并用 AG-UI 把前后端解耦。这个分层本身是可复用的知识资产，且不受许可证约束。抄架构不需要授权，抄代码需要。

**第二，法律约束把"整包复用"这条路基本关上了，但同时打开了一条更好的路。** DeerFlow 2.0 是 MIT 协议、8.4 万星、当日仍在更新，其 harness 结构与 EvoFlow 高度同构。这意味着如果团队确实需要 Python 侧的成熟实现，合法基线是 DeerFlow，而非 EvoFlow。EvoFlow 应当被定位为"产品化设计参考"，用来看它如何把通用 harness 包装成可售卖的产品，而不是代码来源。

**第三，对梵禾 Work 而言，正确的集成粒度是契约级，不是模块级。** 采用六个接口级资产（AG-UI 协议、技能规范、工具分层、沙箱接口、存储四层建模、代码索引方案），在 Node 侧重实现运行时，把 Agent 循环放服务端、把本地动作放桌面。这条路径首期约 33 至 50 人日可见成果，且不引入任何法律与体积负担。

需要保留一个反面判断。如果梵禾 Work 的 AI 能力必须在 4 周内上线且能接受商用授权成本，方案 A（整包 sidecar 加商务授权）在时间维度上是更优解，工程风险也低于从零实现。技术选型从来是约束条件下的最优，而非绝对优劣。建议先做一件事，用方案 B 花 3 天验证 Agent 在真实业务场景（例如"帮我把这批商品上架到千牛"）里到底能完成多少，再决定投入规模。这个验证的成本远低于任何架构决策错误的代价。

---

## 附录 A 关键文件索引

| 主题 | 路径 |
|---|---|
| 分层规则与领域表 | `backend/ARCHITECTURE.md` |
| LangGraph 图注册 | `backend/langgraph.json` |
| 网关装配 | `backend/app/gateway/app.py` |
| 路由注册与容错 | `backend/app/gateway/router_registry.py` |
| AG-UI 归一化 | `backend/app/gateway/agui_stream_normalizer.py` |
| 内核依赖清单 | `backend/packages/harness/pyproject.toml` |
| 工具分层目录 | `evoflow/tools/tool_catalog.py` |
| 技能契约 | `evoflow/skills/types.py`、`evoflow/skills/parser.py` |
| 沙箱接口 | `evoflow/sandbox/sandbox.py` |
| 存储设计 | `evoflow/persistence/db.py`、`schema.py` |
| 协作与应用建模 | `evoflow/collab/app_schema.py`、`app_engine.py` |
| 代码索引 | `evoflow/code_index/__init__.py` |
| 桌面壳 | `evopanel/src-tauri/tauri.conf.json`、`src/commands/backend.rs` |
| 许可证与血统 | `LICENSE`、`NOTICE`、`licenses/` |

## 附录 B 外部信源

- DeerFlow 仓库与许可证：https://github.com/bytedance/deer-flow （MIT，经 GitHub REST API 核验 stars 84,069，pushed_at 2026-10-18）
- PolyForm Noncommercial 1.0.0 协议正文：https://polyformproject.org/licenses/noncommercial/1.0.0
- ZCode 仓库：https://github.com/zai-org/ZCode （Apache-2.0，经 EvoFlow NOTICE 声明）

---

*本文为工程与合规评估，法律结论不构成法律意见，商用决策前建议由法务复核许可证条款。*
