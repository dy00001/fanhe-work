# EvoFlow 集成进梵禾 Work 工作台：Web 内嵌实施方案

> 日期：2026-11-05 12:50
> 前提变更：EvoFlow 源码公开（`github.com/EvovexAI/EvoFlow`），锁定版本 1.2.9 不更新，AI 助手对全部账号开放。
> 取代：`EVOFLOW-EMBED-ASSESSMENT-2026-11-05.md`（那份基于已安装的桌面二进制，结论是「窗口级内嵌不可行」，此处结论已变）
> 性质：实施方案。本文不含梵禾代码改动。

---

## 一、结论

**技术上可行，且最佳路线与上一版完全不同：不做桌面端内嵌，改为服务端 headless 部署加浏览器内嵌。**

三点判断：

1. **官方原生支持 headless Web 部署。** `evopanel/scripts/serve.js` 头注释写明「无需 Tauri / Rust / GUI，纯 Node.js 运行，适用 Linux 服务器、Docker 等无桌面环境」，并且它自己就把 `/api` 与 `/health` 反代到网关。这意味着团队不需要每人装 88MB 桌面壳加 58MB 网关。
2. **承载条件充足。** 本机 16 逻辑核、63.8GB 内存（可用 40.6GB）、Docker 盘 121.7GB 可用；1420、8001、2024 三个目标端口全空闲；现有 4 个容器（web 8080、api 8787、db 5432、cloudflared）稳定运行 3 小时以上。
3. **唯一硬阻断是许可证。** 仓库使用 PolyForm Noncommercial License 1.0.0，README 明确写「商业使用须书面授权」「本许可证并非 OSI 开源许可证」。团队拿它做家具生意属于商业使用，上线前必须取得书面授权。技术方案可以先做验证，不能用生产数据跑。

---

## 二、为什么推翻上一版的路线

上一版基于已安装的桌面二进制，结论是「界面层内嵌可行性低」，理由是前端资源封在 Tauri exe 内、没有可外部加载的 URL，窗口拼接又被同项目上午的实验证否。

源码在手之后，这个前提全部消失：

| 上一版的约束 | 源码在手后的状态 |
| --- | --- |
| 前端资源封在 exe 内，无 URL | `evopanel/` 是标准 Vite + React 工程，可独立构建、可容器化 |
| 后端是 PyInstaller 黑盒 | `backend/` 是完整 Python 3.12 源码，含 `pyproject.toml`、`langgraph.json`、`uv.lock` |
| 二进制 pin 校验不能碰 | 自建镜像，pin 逻辑不参与 |
| 数据目录硬编码无法改 | 容器里 `EVOFLOW_HOME` 是环境变量 |

一句话：**从「外挂一个封闭进程」变成「部署一个自己掌控的服务」。**

---

## 三、许可证：唯一的硬前置

### 3.1 事实

| 项 | 内容 |
| --- | --- |
| 许可证 | PolyForm Noncommercial License 1.0.0 |
| GitHub 识别 | `Other / NOASSERTION`（GitHub 无法识别该许可证，正常现象） |
| 版权方 | Copyright 2026 景银泰（EvovexAI） |
| 必需声明 | `Required Notice: Copyright 2026 景银泰 (EvovexAI) (https://www.evovexai.com)` |
| 允许 | 非商业目的、个人研究实验、修改与创作衍生作品、分发（须附带许可条款与 Required Notice） |
| 禁止 | 商业目的使用；转授权；去除版权声明 |
| 官方口径 | 「商业使用须书面授权（cloud@evovexai.com）」「欢迎有能力的老板多多资助，打赏不构成商用许可」 |

PolyForm 对「非商业目的」的界定里，豁免对象是慈善机构、教育机构、公共研究组织、公共安全与健康组织、环保组织、政府机构。家具公司不在豁免名单内。团队内部用于经营，属于商业使用。

### 3.2 处置

三步，按顺序：

1. **发邮件申请商业授权。** 收件人 `cloud@evovexai.com`，内容写清：公司主体、使用人数、用途（内部设计协作与客户沟通辅助）、部署形态（私有化容器，不对外提供服务）、是否需要去除品牌显示名。这是唯一能一劳永逸的动作，且成本远低于任何自建替代方案。
2. **在授权落地前，只做技术验证。** PolyForm 允许「personal use for research, experiment, and testing」，本地起一套容器验证可行性属于此列，但不要写入真实客户数据，不要给团队开通使用。
3. **授权落地后再决定是否 fork。** 若授权协议允许修改品牌，再做改名；若不允许，只做显示层别名。

### 3.3 一个反向判断

README 里的「治理套件：多账号与 SSO、费用统计、运维观测、安全中心」正是团队多人使用的刚需。如果官方商业授权版本已经包含这些，那么买授权比自己 fork 维护一套要划算得多，因为上游是日更节奏（今天 04:00 还有推送）。这一点值得在邮件里直接问。

---

## 四、三条嵌入路线

决定路线的是一个容易被忽略的细节：**团队通过什么地址访问梵禾 Work。**

现状是 `fanhe-work-web` 映射 `127.0.0.1:8080`，对外靠 `cloudflared` 隧道。如果员工是通过隧道域名访问梵禾，那么他浏览器里的 `127.0.0.1` 指的是他自己的电脑，不是服务器。这一点直接判死「iframe 直连 1420」在团队场景下的可用性。

### 路线一：iframe 直连 EvoPanel 端口

梵禾前端放一个 iframe，`src` 指向 EvoPanel 的地址。

| 维度 | 评价 |
| --- | --- |
| 改造量 | 最小，梵禾侧只加一个页面 |
| 适用 | **仅限所有人都在同一台机器上打开梵禾**（当前单机自用形态） |
| 团队场景 | **不成立**。隧道访问时 `127.0.0.1:1420` 指向员工本机 |
| EvoFlow 侧改造 | 无 |

### 路线二：梵禾 nginx 子路径反代

在 `apps/web/deploy/nginx.conf` 增加 `location /assistant/`，反代到 `evopanel:1420`，iframe 用相对路径 `/assistant/`。

| 维度 | 评价 |
| --- | --- |
| 改造量 | 中。nginx 加块，EvoPanel 需以 `--base=/assistant/` 重建 |
| 优点 | 同源。无论从本机还是隧道访问都正确，Cookie 与鉴权统一 |
| 风险 | EvoPanel 的 SPA 资源引用、路由、`/api` 前缀都要照顾到，需要实测 |
| 适用 | 单域名部署，不想多一条隧道 |

### 路线三：独立子域名加同隧道（推荐）

给 EvoPanel 单独一个 hostname（例如 `ai.你的域名`），走同一条 cloudflared 隧道，梵禾前端 iframe 指向该域名。

| 维度 | 评价 |
| --- | --- |
| 改造量 | 小。梵禾侧加一个 iframe 页面；隧道加一条 ingress；EvoPanel 零改造 |
| 优点 | EvoPanel 保持在根路径，`/api` 绝对路径天然正确，不需要改 base，不需要动它的构建 |
| 缺点 | 跨域 iframe，父页面不能读子页面 DOM（也不需要）；需要两个 hostname |
| 鉴权 | 可在隧道层或 EvoPanel 前置一层 Basic Auth / Access，补齐它自身无鉴权的问题 |
| 适用 | **团队远程访问的推荐解** |

### 路线四（不推荐）：源码融合进梵禾前端

把 `evopanel/src` 作为梵禾 web 的一个路由模块编译进去。

不推荐的理由：`evopanel` 有 489KB 的 `pnpm-lock.yaml`、大量重依赖（Mermaid、Excel WASM、图表库），样式体系与梵禾的令牌体系会正面冲突；上游日更，每次都要合并。只在需要深度定制界面时才考虑。

### 结论

**若团队全部在同一局域网内访问服务器，选路线二或三均可。若有远程访问，选路线三。** 路线一仅保留给单机验证。

---

## 五、目标架构

```
                    ┌──────────────────────────────────┐
  员工浏览器 ──────▶│ cloudflared 隧道                  │
                    │  ├─ work.域名      → web:80      │
                    │  └─ ai.域名        → evopanel    │
                    └──────────┬───────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────────┐
        │  Docker 网络 fanhe-work                            │
        │                                                    │
        │  fanhe-work-web   (nginx, 8080→80)                 │
        │    └ /api → api:8787                               │
        │                                                    │
        │  fanhe-work-api   (8787)                           │
        │    └ /api/assistant/* 只读代理（可选）              │
        │                                                    │
        │  fanhe-work-db    (postgres 5432)                  │
        │                                                    │
        │  ┌── EvoFlow 三件套（锁定 1.2.9）──────────────┐    │
        │  │ evopanel     :1420  静态 SPA + /api 反代     │    │
        │  │ gateway      :8001  FastAPI，4 workers       │    │
        │  │ langgraph    :2024  LangGraph dev server     │    │
        │  │ 卷：evoflow-home（会话/知识库/技能/DB）      │    │
        │  └─────────────────────────────────────────────┘    │
        └────────────────────────────────────────────────────┘
```

资源预算（基于本机实测）：三容器峰值估算 4 至 6GB 内存、2 至 4 核。当前可用 40.6GB / 16 核，余量充足。

端口分配（全部已确认空闲）：1420、8001、2024。三个都只绑 `127.0.0.1`，对外只经隧道。

---

## 六、梵禾侧改造清单

| 文件 | 改动 | 说明 |
| --- | --- | --- |
| `apps/web/src/pages/` 新增 `AssistantPage.tsx` | 新增 | iframe 容器 + 加载态 + 失败态 + 全屏切换 |
| `apps/web/src/routes.tsx` | 新增路由 | `/assistant` |
| `packages/shared/src/navigation.ts` | 新增导航项 | 放进合适分组，`filterNavigation` 按前缀过滤 |
| `packages/shared/src/permissions.ts` | 新增权限点 | 建议 `assistant.use`、`assistant.admin` 两个就够 |
| `apps/web/deploy/nginx.conf` | 视路线 | 路线二需要加 `location /assistant/`；路线三不需要 |
| `docker-compose.yml` | 新增服务 | 或用独立 compose 文件加 `external` 网络，避免污染现有编排 |
| `apps/api` | 可选 | 只读状态代理，供「服务是否在线」展示 |

**权限点落地的三个已知坑（本项目踩过，必须一起处理）**：

1. 新增权限点后，`migrate` 与 `api` **两个镜像都要重建**。
2. owner 的权限清单走 `guard.ts` 的 `[...ALL_PERMISSIONS]` 代码常量，不查库。旧镜像只返回旧清单，前端按 `module.` 过滤，新模块会整组静默消失，零报错、库全对。
3. `pnpm db:seed` 必须经 package.json 脚本（先构建 shared），否则会用旧 dist 把新授权当多余项删掉，且照样打印完成。

用户要求 AI 助手对全部账号开放，实现方式是给所有角色默认授予 `assistant.use`，而不是跳过权限体系。保留权限点是为将来能关掉。

---

## 七、EvoFlow 侧处置

### 7.1 锁版本

| 项 | 值 |
| --- | --- |
| 参考 tag | `v1.2.9` = `f9258fb92e0673d4943202997e24eed634743148` |
| 参考 main | `86729e65b288b6c26c597576b2f37b7905618e66`（2026-11-05 04:00 推送） |
| 仓库体积 | 168 MB |
| 锁定方式 | 本地 fork 打 tag，镜像打固定 tag（如 `evoflow-gateway:1.2.9-local.1`），compose 里禁用 `latest` |
| 上游更新 | 不跟随。容器化后天然没有桌面版的 `_up_` 自动更新机制 |

**锁版本要付的代价必须说清**：上游是日更节奏，锁死后安全补丁与缺陷修复都拿不到。建议保留一条「季度差量合并」的例行工作，而不是真的永久不动。

### 7.2 零改造的部分

- `evopanel` 容器化：`Dockerfile` 与 `scripts/serve.js` 官方已提供，直接用。
- 后端：`docker/docker-compose.yaml` 官方已提供 gateway 与 langgraph 两个服务定义。
- 部署形态：独立 compose 文件，通过 `external` 网络或同一网络接入梵禾，不改梵禾现有四个服务。

### 7.3 必须改的一处安全配置

官方 compose 给 gateway 与 langgraph 都挂了宿主 Docker socket：

```yaml
- ${EVOFLOW_DOCKER_SOCKET}:/var/run/docker.sock
```

这是为 `AioSandboxProvider` 起沙箱容器用的。挂上之后，容器内进程等于拥有宿主 root 级能力。**如果不使用沙箱能力，应当去掉这个挂载**，改用 noop provider，安全边界立刻收紧一个量级。这一点与桌面版 `config.yaml` 里 `sandbox: NoopSandboxProvider` 的现状一致，去掉挂载不会损失已用到的功能。

同时建议：
- `tools_mode` 从 `host_direct` 收敛到容器内执行；
- `guardrails.denied_tools` 不要留空，把删除类、写系统目录类的工具列进去；
- 三个容器全部只绑 `127.0.0.1`。

---

## 八、改名「全能AI助手」

拿到商业授权之后，按四个层次处理：

| 层 | 做法 | 约束 |
| --- | --- | --- |
| 显示层 | 梵禾入口名用「全能AI助手」，页面标题同理 | 零风险 |
| 关于页 | 保留「基于 EvoFlow 1.2.9 构建 · Copyright 2026 景银泰（EvovexAI）」 | PolyForm 要求保留 Required Notice，这条不能省 |
| 源码层 | 可改 `evopanel` 的界面文案与图标 | 需授权协议明确允许；不得去除版权声明 |
| 法律文件 | 随分发附带 LICENSE 与 NOTICE | PolyForm 强制要求 |

不建议做的事：把 `backend` 或 `evopanel` 内的版权头删掉；对外宣称是自有产品。这两条在授权谈判里是红线，也会让后续升级失去依据。

---

## 九、风险登记

| # | 风险 | 影响 | 处置 |
| --- | --- | --- | --- |
| R1 | **许可证**：商业使用未获授权 | 高 | 上线前拿书面授权，这是唯一硬前置 |
| R2 | **EvoPanel headless 无鉴权**：`serve.js` 默认监听 `0.0.0.0`，无登录 | 高 | 只绑回环；对外经隧道并在隧道层加访问控制；确认 gateway 在容器模式下是否加载 WebUI JWT 中间件 |
| R3 | **docker.sock 挂载**：容器内可控制宿主 Docker | 高 | 去掉挂载，用 noop sandbox |
| R4 | **隧道下 `127.0.0.1` 语义变化**：iframe 直连在远程访问时指向员工本机 | 高 | 用子路径反代或独立子域名，禁止在团队场景用路线一 |
| R5 | **子路径部署的资源路径**：SPA 绝对路径在 `/assistant/` 下会 404 | 中 | 路线二需 `vite build --base=/assistant/` 并实测路由回退；路线三无此问题 |
| R6 | **SSE 与流式响应经反代**：nginx 缓冲会吞掉流式增量 | 中 | 若走路线二，需对 `/api/` 关 `proxy_buffering`，并放大 `proxy_read_timeout` |
| R7 | **全员共用一套模型 Key**：费用不可控 | 中 | 用 EvoFlow 的费用统计；或按账号分配额度；先小范围试用再全开 |
| R8 | **锁版本后无安全补丁**：上游日更，锁死即停更 | 中 | 建立季度差量合并；把上游提交做定期审阅 |
| R9 | **双套数据与备份**：梵禾 PG 加 EvoFlow SQLite/DuckDB | 中 | 卷单独命名，纳入同一份备份清单，恢复演练一起做 |
| R10 | **桌面端 iframe 行为**：梵禾 Electron 外壳的导航白名单只限制顶层导航，iframe 不受影响 | 低 | 但需确认 `webPreferences` 与外链策略不会把 iframe 内的弹窗交给系统浏览器 |
| R11 | **镜像构建时间与网络**：`uv` 与 npm 依赖拉取在国内可能很慢 | 中 | Dockerfile 已支持 `APT_MIRROR` 与 `NPM_REGISTRY` 参数，构建时传入镜像源 |

---

## 十、分阶段实施与验收

### P0 授权与合规（并行启动，阻塞后续上线）

- 发邮件到 `cloud@evovexai.com`，说明主体、人数、用途、部署形态、是否需要改显示名，同时问商业版是否已含多账号与 SSO。
- 本地留存 LICENSE 与 NOTICE 副本，记录 `Required Notice` 原文。

验收：拿到书面答复。答复为否时，本方案终止，改评估替代品。

### P1 本地跑通（1 天，不接梵禾）

- 浅克隆到 `D:\EvoFlow-src`，检出 `v1.2.9`。
- 用官方 `docker/docker-compose.yaml` 起 gateway 与 langgraph；去掉 docker.sock 挂载。
- 用 `evopanel` 的 Dockerfile 起前端（`EVOFLOW_GATEWAY_URL` 指向 gateway）。
- 浏览器访问 1420，配一个模型，跑通一轮对话与一次长任务。

验收（每条都要有阳性对照）：
- `/health/ready` 返回 ready，冷启动到可交互时间记录在案；
- 一轮对话能流式输出；
- 一个 Goal 任务能跑完并在任务中心可见；
- 拔掉模型 Key 后界面给出明确错误，不白屏；
- 反例：`docker stop` gateway 后，前端显示网关不可达而不是卡死。

### P2 接入梵禾（2 至 3 天）

- 按路线三加隧道 ingress，或按路线二加 nginx location。
- 梵禾新增 `AssistantPage`、路由、导航项、权限点。
- 重建 `migrate` 与 `api` 镜像，跑 `db:seed`，确认全员可见入口。

验收：
- 从梵禾侧栏进入助手，能正常对话；
- 退出梵禾再进，会话列表仍在；
- 用非 owner 账号登录，入口可见（用户要求全员开放）；
- 从外网经隧道访问，iframe 正确加载（这一条是路线一会被判死的地方）；
- 反例：把员工账号的 `assistant.use` 移除，入口应按既有规则隐藏，而不是报错。

### P3 加固与治理（2 天）

- 隧道层访问控制、gateway 鉴权确认、工具白名单、费用统计接入。
- 备份纳入统一清单。

验收：
- 未授权的外部 IP 访问 `ai.域名` 被拒；
- 工具清单里删除类操作被 guardrails 拦下并留痕；
- 备份恢复演练通过。

### P4 团队推广（1 天）

- 一份使用说明（怎么开、怎么配模型、费用怎么看、出问题找谁）。
- 灰度：先 2 人用一周，再全开。

---

## 十一、待确认的三个前提

1. **团队怎么访问梵禾**：全部在办公室局域网，还是有人远程？这决定路线二还是路线三。
2. **服务器在哪**：就是这台机器（16 核 63.8G），还是另有服务器？这台机器同时跑梵禾四容器加 EvoFlow 三容器没问题，但它同时是你的设计工作站。
3. **模型用哪家、预算多少**：全员共用一套 Key，用量会集中爆发，需要先定月度上限。
