# 梵禾 Work · 完整工作总结与换机续接指南

> **本文档是单文件自包含的交接主文档。** 换一台电脑后，只读这一份就能把开发环境恢复起来并接着往下做：
> 项目是什么、做到哪了、哪些功能已经能用、下一步做什么、当初为什么这么定、环境怎么搭、有哪些坑不能踩，全部在这一份里。
>
> | 项 | 值 |
> | -- | -- |
> | 生成时间 | 2026-10-11 17:55（2026-10-11 21:3x 随 T3-09 回填；22:0x 随 T3-10 回填；22:2x 随 T3-11 回填；22:5x 随 T3-12 回填，**阶段三收口**；2026-10-12 0x:5x 随 **UI 集成**回填；2026-10-12 0x:xx 随 **N-01** 回填至最终态；2026-10-12 0x:xx 随 **T4-01** 回填，**阶段四开工**；2026-10-12 01:4x 随 **阶段性总结**回填；2026-10-12 12:3x 随 **T4-02** 回填；2026-10-12 13:0x 随 **T4-03** 回填） |
> | 对应提交 | 代码基线 `d76e084`（**T4-03 本机代理内置**；T4-02 为 `f2bfc16`，T4-01 为 `b03ddb5`，UI 集成为 `2576388`，阶段三为 `a5370b0`）；本文档定稿于 T4-03 文档提交，用 `git log -1 -- docs/WORK-STATUS.md` 查 |
> | 当前阶段 | **阶段零至三已完成（38/50）；阶段四 3/4：T4-01 外壳脚手架、T4-02 服务地址切换、T4-03 本机代理内置均已完成。** 下一项是 T4-04 启动自检 |
> | 最后验证 | 四道门禁全绿（**378 项**，2026-10-12 12:2x 实跑）；浏览器 e2e **149 项**全通过（UI 集成后实跑，本次无界面改动未重跑）；外壳冒烟 **PASS**（渲染出界面、console 零错误、**反代到达上游=是**） |
>
> 阅读顺序建议：**第零节（速览）→ 第二节（进度）→ 第七节（换机步骤）**，其余按需查。
> 深度的设计推演与逐任务判断在 `DEVELOPMENT-PLAN.md` 第九章（9.1 ~ 9.41），本文已把结论汇总，需要细节时再翻过去。

---

## 零、五分钟速览

**这个项目是什么**：一个桌面端个人工作台（实验版），用来管自己的软件启动通道、工作纪要、事件记录，后面会包成 Electron 外壳、并支持局域网/远程两种服务地址。

**现在到哪了**：账号与权限体系、主框架与 UI 骨架、个人工作台的「启动通道」「工作纪要」「事件记录」三个板块**全部完成并可用**。工作纪要支持编辑、Markdown 预览、标签、置顶、归档、删除、**中文全文检索**与**草稿自动保存**（未提交的内容落在本机，误关、切板块、被检索筛掉之后再回来都能接着写）。事件记录（`events` 与 `event_logs` 两张表、八条接口、状态变更一律追加流水）能未完成 / 已完成分组、已完成默认折叠、行内四要素（勾选框 / 标签 / 截止时间 / 优先级）、检索与增删改；**勾一下即完成、再点提示条上的「撤销」即恢复**（乐观更新、失败回滚都在）；**点标题打开详情面板** —— 完整描述（Markdown 渲染）、创建 / 截止 / 完成时间、完成用时、完成人，以及来自 `event_logs` 的**完整变更历史时间线**。**阶段三到此收口。**

**界面层已按最终 UI 方案整体整合**（两批，见 `UI-INTEGRATION-2026-10-11.md`）：侧栏导航由 5 项扩为 **18 项 / 4 分组**（含 11 个「功能开发中」占位槽），工作台首页改为**三段式**（案例展示 / 启动通道 / 记录），顶栏账号菜单底部新增**版本号**行。**业务逻辑一行未动** —— 整合只落在界面与导航结构上。

**桌面外壳 3/4**（阶段四）：T4-01 把 `apps/desktop` 从空目录落成一个能用的 Electron 外壳 —— 打开即渲染出已有界面，`/api` 由外壳内置的静态服务反代到服务地址（**`apps/web` 一行未改**），冒烟 PASS。T4-02 把服务地址从环境变量常量升级为**可持久化的配置项**，落在**工作区的 `.config/fanhe-work/service.json`**（换机时随工作空间走，被根 `.gitignore` 排除）；`FANHE_SERVICE_URL` 保留为一次性覆盖，开发与验证仍可用。T4-03 把 `apps/api/src/launch/agent.ts` **原样**搬进外壳主进程（经 `import()` 动态加载 TS 源码，无构建顺序依赖），**远程模式下也能启动本机软件**；主进程对来自 IPC 的配置另做一道形态复核，因为这条通道没有 HTTP 那侧的权限与回环中间件。下一项是 T4-04 启动自检。

**最短三条路径**（假定已按第七节把环境装好）：

```bash
# 1. 跑起来（两个终端；注意 API 要开短令牌，端到端验证才等得到续期）
cd projects/fanhe-work/apps/api && ../../infra/portable/ws-run.cmd pnpm dev:api   # 或 pnpm dev:all 一起起
# 另开一个终端
cd projects/fanhe-work && infra/portable/ws-run.cmd pnpm dev

# 2. 验证没被你改坏（四道门禁）
cd projects/fanhe-work && ../../infra/portable/ws-run.cmd pnpm test && \
  ../../infra/portable/ws-run.cmd pnpm lint && \
  ../../infra/portable/ws-run.cmd pnpm typecheck && \
  ../../infra/portable/ws-run.cmd pnpm format:check

# 3. 推到远端（必须走代理，详见 6.6）
GIT_TERMINAL_PROMPT=0 HTTPS_PROXY=http://127.0.0.1:7897 HTTP_PROXY=http://127.0.0.1:7897 \
ALL_PROXY=http://127.0.0.1:7897 git -c http.proxy=http://127.0.0.1:7897 push origin main
```

**四条不能忘的事**：① 包管理**一律经 `infra/portable/ws-run.cmd`**，裸跑 pnpm 会静默把 store 落到宿主机磁盘；② 数据库在容器里、**不随 U 盘走**，换机必重建；③ 受版本控制的文件**禁止写死盘符**；④ 浏览器 e2e 跑一次 = 清一次库 + 重建一次 owner，不是随便能跑的。

---

## 一、项目概况

### 1.1 项目定位

**梵禾 Work** 是桌面端个人工作台（实验版），按「账号权限 → 主框架 → 个人工作台三板块（纪要 / 事件 / 启动）→ 桌面外壳 → 服务端化 → 更新通道」分七个阶段实现。七个阶段共 50 项任务，编号为「T + 阶段号 + 连字符 + 序号」。

### 1.2 技术栈

| 层 | 选型 |
| -- | -- |
| 桌面外壳 | Electron 44.7.0（阶段四，T4-01 脚手架已落地） |
| 前端 | React 19 + TypeScript 6.0.3 + Vite 8 + Tailwind 4（方案 B 现代极简，shadcn/ui） |
| 后端 | Node 22.22.2 + Fastify 5 + Prisma 7.10.0 |
| 数据库 | PostgreSQL `postgres:16-alpine`（容器，数据在命名卷，**不随 U 盘移动**） |
| 共享包 | `packages/shared`（跨进程类型与收窄函数，构建型包，输出到 `dist`） |
| 路由 / 图标 / Markdown | `react-router@8.4.0`、`lucide-react`、`react-markdown` + `remark-gfm` |
| 密码哈希 | `@node-rs/argon2`（Argon2id） |

### 1.3 仓库与提交身份

- **仓库根 = 工作空间根 = 可移动介质根**，整体推 `main`。注意不是 `projects/fanhe-work`。
- 远端：`https://github.com/dy00001/fanhe-work`（**公开**，2026-10-11 由私有改公开）。
- 提交身份：`梵禾 <dev@fanhe.local>`（**仅本仓库局部配置**，换机后要重设）。
- 分支约定：`main` 为主线、保持可交付；`dev` 为开发分支。**实际执行的是「dev 跟随 main」** —— 有实际分叉需求前，每次推完 main 就把 dev 快进并推送。两条分支本地均已建立跟踪。
- 两条访问链路：**本地 git 可读写**（细粒度 PAT 经 GCM 存于 `~/.gitconfig`，逐机逐用户，换机必重配）；**WorkBuddy 的 GitHub 连接器只读**（只能读公开仓库，写入返回 403，GitHub 侧无可调项）。**凡需要写入远端，一律走本地 git。**
- 仓库内另有 `.git/info/exclude`（本地排除，不进版本控制），`.workbuddy/` 与 `.workbuddy-ai/` 都不进仓库。

### 1.4 工作区目录结构

```
<工作空间根>/                       ← git 仓库根，整盘走
├── .ws-root                       ← 根定位标记，脚本向上查找它推导根，不写死盘符
├── infra/                         ← 工作空间机制（唯一入口）
│   ├── portable/
│   │   ├── ws-run.cmd / .ps1 / .sh    ← 唯一入口（cmd 是 Windows 上的首选）
│   │   ├── ws-env.ps1 / .sh           ← 只设置环境，不转交命令
│   │   ├── ws-locate.ps1 / ws-state.ps1 / ws-doctor.ps1 / ws-repair.ps1
│   │   ├── ws-enable-devmode.cmd/.ps1
│   │   ├── config/
│   │   └── state/root.json
│   └── docs/PORTABLE-WORKSPACE.md
├── projects/fanhe-work/           ← 代码主体
│   ├── apps/
│   │   ├── api/                   ← Fastify 后端 + Prisma + 迁移 + 测试
│   │   ├── web/                   ← React 前端（Vite）
│   │   └── desktop/               ← Electron 外壳（阶段四，T4-01 已落地）
│   ├── packages/shared/           ← 跨应用共享类型与工具（构建型，先构建后用）
│   ├── docs/                      ← 规划与交接文档（本文所在处）
│   ├── tools/                     ← 诊断脚本归档（checks/ prisma/ oneoff/）
│   ├── data/                      ← 本地数据目录（已忽略）
│   ├── docker-compose.yml
│   └── package.json               ← pnpm 工作区根
├── docs/                          ← 工作空间级文档
├── .tmp/                          ← 被忽略，临时产物与凭据落在这里
├── .cache/ .cargo/ .m2/ .nuget/ .rustup/ .venv/ ...  ← 各类工具链缓存，随盘
└── .workbuddy/ .workbuddy-ai/     ← 本地记忆（不进版本控制）
```

---

## 二、当前进度

### 2.1 阶段进度总览

| 阶段 | 范围 | 状态 |
| -- | -- | -- |
| 阶段零 | 目录骨架（T0-01 ~ T0-07） | ✅ 完成 |
| 阶段一 | 账号与权限（T1-01 ~ T1-12） | ✅ 完成（验收 7 项勾 6，余 1 项见 4.5） |
| 阶段二 | 主框架与 UI 骨架（T2-01 ~ T2-07） | ✅ 完成（验收 6 项全勾）；**UI 集成两批已完成**（导航 18 项 + 首页三段式 + 版本号），见 `UI-INTEGRATION-2026-10-11.md` |
| 阶段三 | 个人工作台三板块（T3-01 ~ T3-12） | ✅ 完成（验收 6 项全勾）：**纪要链收口**、**事件链收口**（T3-09 模型接口 → T3-10 列表 → T3-11 勾选切换 → T3-12 详情面板） |
| 阶段四 | Electron 外壳（T4-01 ~ T4-04） | 🔄 进行中：**T4-01 外壳脚手架、T4-02 服务地址切换、T4-03 本机代理内置完成（3/4）**，T4-04 未开始 |
| 阶段五 | 服务端化（T5-01 ~ T5-05） | ⬜ 未开始 |
| 阶段六 | 更新通道 | ⬜ 未开始 |

> 阶段三的分母口径（12 项）见 `PROGRESS-REVIEW-2026-10-11.md` 第 28 行。

### 2.2 阶段三验收清单

- [x] 第一项：启动配置可新增、编辑、排序，可一键唤起
- [x] 第二项：路径失效有提示与重新指定入口（T3-04）
- [x] 第三项：纪要支持编辑预览、标签、置顶、检索、草稿恢复 —— **五项全部完成并逐条过浏览器验证**（编辑预览 / 标签 / 置顶 T3-06，检索 T3-07，**草稿恢复 T3-08**）
- [x] 第四项：事件列表分组正确，勾选切换乐观更新可回滚 —— 前半句 T3-10（分组、已完成默认折叠、行内四要素），后半句 T3-11（乐观更新与失败回滚，e2e 用「把切换请求拖后 1.2 秒、断言回话之前界面已改」与「服务端已删仍照样先勾上」两条把「乐观」与「等回话」分开）
- [x] 第五项：撤销入口可恢复状态并清除完成时间（T3-11；e2e 既查界面（入口出现与收起、该行回到未完成组），也经接口查服务端 `status` 回 `todo`、`completedAt` 与 `completedBy` 一起变 `null`）
- [x] 第六项：已完成详情展示耗时、操作人与变更历史（T3-12；详情面板由标题进入，展示完整描述、创建 / 截止 / 完成时间、完成用时、完成人与来自 `event_logs` 的时间线。**e2e 里那一条是按「能证伪」做的**：拿一条走过「完成 → 撤销」的事件，它此刻是未完成，而面板里必须仍留着那两笔 —— 界面若在按当前状态反推，永远画不出它们）

### 2.3 最近提交（截至本文档定稿）

> 下表是截至文档定稿时的快照。定稿之后若只有对本文档本身的文档类提交，不会补进此表 —— 想知道最新提交直接 `git log --oneline -10`。

| 提交 | 说明 |
| -- | -- |
| `d76e084` | feat(阶段四): T4-03 本机代理内置（**外壳代码基线**） |
| `b03ddb5` | feat(阶段四): T4-01 Electron 外壳脚手架（**外壳代码基线**） |
| `c8f7a4d` | docs: WORK-STATUS 头部标注 N-01 定稿提交号 |
| `9502591` | docs: 梳理下一步任务（N-01 与阶段四主线） |
| `b5c0e7f` | docs(阶段四): 补充 T4-01 开工准备清单 |
| `fe92cb4` | docs(UI集成): 回填最终态集成记录（`UI-INTEGRATION-2026-10-11.md`） |
| `2576388` | feat(UI集成): 落地最终 UI —— 导航 18 项、首页三段式、版本号（**界面层整合代码基线**） |
| `278059d` | docs(阶段三): 回填 T3-12 实施判断与验证结果，阶段三收口 |
| `a5370b0` | feat(阶段三): T3-12 已完成详情面板（详情 + 耗时 + 操作人 + `event_logs` 变更历史时间线） |
| `29752ea` | docs(阶段三): 回填 T3-11 实施判断与验证结果 |
| `a3c08bf` | feat(阶段三): T3-11 勾选切换与撤销（乐观更新 + 失败回滚 + 撤销入口） |
| `f77c563` | docs(阶段三): 回填 T3-10 实施判断与验证结果 |
| `a7069de` | feat(阶段三): T3-10 事件列表视图（分组折叠 + 行内四要素 + 事件检索与增删改） |
| `d252107` | feat(阶段三): T3-09 事件模型与接口（第六个迁移 + 八条接口） |
| `fcfc7aa` | feat(阶段三): T3-08 草稿自动保存 |
| `4d43dae` | fix(web): 补齐 NavLink className 回调的类型标注（换盘重建依赖后 `typecheck` 才暴露出来的既有疏漏） |
| `db7bc77` | docs(交接): 重写为单文件自包含的完整工作总结与换机续接指南（本文档定稿于此） |
| `3c402fa` | docs(阶段三): 回填 T3-07 实施判断与验证结果 |
| `95bdcf2` | feat(阶段三): T3-07 纪要全文检索 |
| `122931d` | docs(阶段三): 回填 T3-06 浏览器 e2e 验证结果并修正实施判断 |
| `19c08a2` | fix(阶段三): 修复新建纪要后编辑器草稿被初始化成空白 |
| `42963b4` | docs(阶段三): 回填 T3-06 实施判断与验证结果 |
| `eb4992b` | feat(阶段三): T3-06 纪要 Markdown 编辑与预览 |
| `5d1883a` | feat(阶段三): T3-05 纪要模型与接口 |

### 2.4 当前验证基线（改完东西应与这些数字对照）

| 项 | 基线 | 说明 |
| -- | -- | -- |
| `pnpm test` | **402 项，0 失败** | `packages/shared` **83** + `apps/api` **197**（**192 通过 / 5 跳过**）+ `apps/web` **70** + **`apps/desktop` 52**。desktop 的增量轨迹：T4-01 起 10（内置静态服务的 SPA 回退 / 404 / 越界 / 反代 / 502）→ T4-02 **28**（配置读写 18 + 服务端 10）→ T4-03 **52**（配置 18 + 服务端 10 + 代理形态复核 17 + 跨包路径 7）。web 的增量轨迹：T3-10 起由 23 → 40，T3-11 → 45，T3-12 → 62（详情展示规则），**UI 集成 → 70**（新增 `version.test.mjs` 8 项）；shared 由 69 → **83**（导航 18 项 / 层级路径 / `navCodeFromPath` 断言扩写） |
| 其中 5 项跳过 | **设计行为，不是失效** | `apps/api/test/setup.test.ts` 的首次初始化用例，前置条件是「库里没有 owner」；owner 建成后自然跳过 |
| `pnpm lint` / `typecheck` / `format:check` | 全绿 | `format:check` 应输出 `All matched files use Prettier code style!` |
| 浏览器 e2e | **149 项全通过，0 失败** | 含「渲染过程未产生未捕获异常或 console.error」。**这是 UI 集成后的结果**（T3-12 时为 146，UI 集成新增 3 项：导航 18 项形态、首页三段式、顶栏版本号），**一次跑通**。T4-01 无界面改动，未重跑。T3-12 那次的首轮超时与根因（CDP 合成指针事件概率性整组丢失）见 8.2 与 9.39 |
| 外壳冒烟 | **PASS** | `pnpm --filter @fanhe/desktop smoke`：隐藏窗口加载产物 → 探 DOM → 打印一行结论并按成败设退出码。判据是 `#root` 里有元素 + console 零错误（见 8.5）。**受限环境需 `FANHE_NO_SANDBOX=1`** |
| 数据库 | 6 个迁移、**12 张业务表**、种子 11 / 4 / 29 | 基线数据：`users` 1（owner `fanhe`）、其余业务表 0 行（跑完 e2e 已清库并重建 owner） |

---

## 三、已完成的功能

### 3.1 阶段零 · 目录骨架（T0-01 ~ T0-07）

一次性把工程地基打完：`apps/{web,api,desktop}` + `packages/shared` + `data` 的目录骨架（T0-01）；pnpm workspace 与根脚本（T0-02）；Electron 缓存变量名缺陷的修正与镜像补全（T0-03，判断见 9.4）；约定文档 `README.md`（T0-04）；ESLint 10 扁平配置 + Prettier + Tailwind 类名排序（T0-05）；忽略规则（T0-06）；git 仓库与提交身份（T0-07）。另有界面方案四选一对比页（`docs/mockups/index.html`，选定方案 B）与品牌标识入库。

### 3.2 阶段一 · 账号与权限（T1-01 ~ T1-12）

**这一阶段的产品能力：能登录、能记住账号密码、能按角色看到不同的导航。**

| 能力 | 交付 | 关键文件 |
| -- | -- | -- |
| 数据模型与首个迁移 | 六张账号权限表，已应用并确认无漂移 | `apps/api/prisma/schema.prisma`、`migrations/20261010150103_init` |
| 数据库连接与种子 | 11 个权限点、4 个角色、29 条授权关联，重跑无副作用 | `src/db/prisma.ts`、`src/db/seed.ts` |
| 密码哈希 | Argon2id，参数可配置、可判定重算，12 项测试 | `src/auth/password.ts` |
| 登录与令牌签发 | `POST /api/auth/login`，四种失败共用同一响应（不给枚举用户名的机会） | `src/auth/tokens.ts`、`src/auth/login.ts` |
| 令牌轮换与撤销 | `refresh` / `logout`，并发轮换用行锁串行化，重放按 `familyId` 整链撤销，撤销分 session / device / all 三层 | `src/auth/session.ts` |
| 登录限速 | 账号 + IP 双维度，阈值与窗口全部配置化，落库 `login_attempts`，超限返回 429 | `src/auth/login.ts` |
| 权限中间件 | `requireAuth` / `requirePermission`，**授权每次查库不缓存** | `src/auth/guard.ts` |
| 首次初始化引导 | 并发初始化用咨询锁串行化，owner 被误删有 `pnpm db:create-owner` 恢复通道 | `packages/shared/src/account.ts`、`src/auth/setup.ts` |
| 审计日志 | 动作码词表 + `recordAudit`，已接入登录 / 登出 / 刷新重放 / 首次初始化四条路径 | `packages/shared/src/audit.ts`、`src/audit/audit.ts` |
| 登录页与会话管理 | 访问令牌只放内存、刷新令牌持久化，续期单飞收敛并发，401 续期一次后重试 | `apps/web/src/lib/{api,session}.ts`、`auth/`、`pages/` |
| 前端路由守卫 | 导航清单（**UI 集成后 18 项 / 4 分组**）+ 模块级可见性判定，32 项测试钉住四种角色的可见范围与分层路径 | `packages/shared/src/navigation.ts`、`components/Sidebar.tsx` |
| 记住账号密码 | AES-GCM 加密，密钥存 IndexedDB 且不可导出；只在登录成功后写、取消勾选即清 | `apps/web/src/lib/credential.ts` |

### 3.3 阶段二 · 主框架与 UI 骨架（T2-01 ~ T2-07）

**这一阶段的产品能力：一个应用式外壳（侧栏 + 顶栏 + 内容区），可折叠、可切主题、有完整的空/错/404 页。**

- **T2-01 shadcn/ui 与设计令牌**：`components.json` + `src/lib/utils.ts` + `components/ui/` 下 14 个官方组件源码；`index.css` 改为两层令牌结构并统一到 shadcn 语义命名，现有界面 60 余处类名同步迁移。
- **T2-02 布局骨架**：`Sidebar`（224px / 折叠 64px，折叠态用气泡提示补名称）、`TopBar`（56px，面包屑 + 账号下拉）、`AppShell`（`h-screen` 应用式外壳，内容区独立滚动、最大宽度 1080px）。
- **T2-03 路由体系**：路由表由 `NAV_ITEMS` 派生，模块守卫复用 `resolveActiveNav`；共享包新增 `navPath` 与 `navCodeFromPath`。
- **T2-04 占位页**：统一「功能开发中」页（模块图标、标题、规划范围、返回入口）；导航图标表抽出共用。
- **T2-05 错误与空状态**：`EmptyState`（`card` / `plain` 两形态，收敛到一处）、`NotFoundPage`（404，保留原地址不重定向）、`ErrorPage`（500，不展示异常原文）、`ErrorBoundary`。
- **T2-06 折叠偏好记忆**：`lib/preferences.ts` 读写本机偏好（键 `fanhe-work.ui.sidebar-collapsed`），读写失败静默降级。
- **T2-07 主题令牌**：`index.css` 新增 `@custom-variant dark` 与 `.dark` 块（覆盖 `:root` 全部颜色原始值），`index.html` 内联脚本在样式生效前定下主题初值，`lib/theme.ts` 提供三档（含跟随系统）与系统配色变化监听。

### 3.4 阶段三 · 个人工作台（T3-01 ~ T3-12，**已收口**）

**已经能用的三块：启动通道、工作纪要、事件记录（列表、增删改、勾选切换与详情面板）。三个板块全部完成。**

#### 启动通道（T3-01 ~ T3-04）

- **T3-01 模型与接口**：`launch_profiles` 表 + 五条路由（列表 / 新增 / 重排 / 修改 / 删除），所有权在 service 层强制，重名检查不用数据库约束。启动参数用 `String[]` 而不是拼接字符串。
- **T3-02 本机代理与进程启动**：`src/launch/agent.ts` 是**代理核心**，`buildLaunchCommand` 纯函数 + `runLaunchProfile`，**不认识数据库、认证与 HTTP**（阶段四要原样搬进外壳主进程）；只接受回环来源。
- **T3-03 管理界面**：列表 + 新增/编辑对话框 + 删除确认 + 排序，四态分派容器照 `LaunchPanel` 的形态。
- **T3-04 启动记录与路径失效提示**：`launch_history` 表记录真实启动尝试（成功 / `executable_missing` / `spawn_failed`），去重命中不记；独立的状态接口提供路径状态与近期历史；界面有失效徽标、「重新指定路径」入口与启动摘要。

#### 工作纪要（T3-05 ~ T3-08，**已收口**）

- **T3-05 模型与接口**：`notes` 表 + 八条路由（列表 / 标签清单 / 单条 / 新增 / 修改 / 删除 / 置顶 / 归档）。标签用 `text[]` + GIN 索引，归档用 `archivedAt` 记时刻而非布尔，沿用软删除。
- **T3-06 Markdown 编辑与预览**：`NotesPanel`（四态分派）/ `NoteList` / `NoteEditor` / `MarkdownPreview` / `TagInput`；**预览读的是草稿而不是已保存值**；一级导航补上二级路径这一层，`/workbench/notes` 因此可达。
- **T3-07 全文检索**：中文关键词可命中**标题与正文**；界面检索框防抖 250ms、丢弃过期响应、空态分「库里没有」与「没搜到」两种说法、关键词跨视图保留。详见 5.4。
- **T3-08 草稿自动保存**：未提交的内容按「编辑器的身份」落到本机 localStorage（`fanhe-work.draft.note.<id>` / `…note.new`）。误关页面、切板块、被检索筛掉之后再回来都能接着写，编辑器顶部给一条可「丢弃草稿」的提示条。**后端零改动、零迁移**，草稿不进数据库也不进审计。规则在 `apps/web/src/lib/note-draft.ts`，触发点与那个「提交成功后旧实例的卸载落盘把已提交内容写回新建槽」的时序坑见 5.6 与 9.35。

> 界面入口：`/workbench` 是启动通道，`/workbench/notes` 是工作纪要，`/workbench/events` 是事件记录，靠 `WorkbenchPage` 顶部的板块切换按地址分派。

#### 事件记录（T3-09 ~ T3-12 已完成，**已收口**）

- **T3-09 模型与接口**：第六个迁移 `20261011132819_add_events` 建起 **`events`** 与 **`event_logs`** 两张表，八条路由（列表 / 标签清单 / 单条 / 状态变更历史 / 新增 / 修改 / 状态切换 / 删除），统一挂 `personal.event.read` 与 `personal.event.write`。
- **T3-10 列表视图**：`components/events/` 四件（`EventsPanel` 四态分派容器、`EventList` 分组与折叠、`EventRow` 行内四要素、`EventFormDialog` 新增 / 编辑表单）＋ `lib/event-display.ts`（展示规则的纯函数）＋ `lib/events.ts`（会话感知数据层）＋ `lib/api.ts` 六条传输函数；`WorkbenchPage` 加第三块板块，`routes.tsx` 的模块子路由补 `events`。
- **界面上现在能做到什么**：未完成与已完成分两组（**已完成默认折叠**，组头带条数）、每行左侧勾选框、中间标题与最多三个标签、右侧截止时间与优先级徽标；**已过截止时间且未完成**的那条标出「已逾期 · …」；检索走与纪要同一条链路（防抖 250ms、丢弃过期响应、空态分「库里没有」与「没搜到」两种说法）；新增 / 编辑 / 删除都在，写完一律重拉列表（**排序在服务端，界面不自己排**）。
- **T3-11 勾选切换与撤销**：点行内勾选框即完成，再点即取消完成；两条路都走 `PUT /api/events/:id/status`，**后端与共享包一行未改**（T3-09 那条路径早就把「写完成时刻与完成人」「三列一起清空」「同事务追加流水」做完了）。改动集中在三处：`EventRow` 的勾选框去掉 `disabled` 并接上 `onCheckedChange`；`lib/event-display.ts` 增 `applyEventStatus` 纯函数（乐观改本地那一条）；`EventsPanel` 增 `changeStatus`、`switching` 串行化与提示条上的**撤销入口**。
- **勾选框现在可点了，两种「点不动」分得很开**：只读角色（没有 `PERSONAL_EVENT_WRITE`）永远点不动，这种禁用补 `disabled:opacity-100` —— 一整片半透明的勾选框看起来像列表坏了，而实际只是没权限；切换中的临时禁用保留组件自带的半透明，那正好表达「正在处理」。判据按 `canWrite` 取而不是按 `disabled` 取。
- **乐观更新只改 `status`，不伪造 `completedAt` / `completedBy`**：那两个是服务端的时间与身份快照，列表这一版不展示它们（展示在 T3-12 的详情面板里）。乐观阶段写一个「本地现在」进去，界面上会短暂出现一个可能偏掉的时刻，而权威值紧随其后被重拉覆盖。
- **成功之后仍然重拉列表**：乐观值负责「点下去到响应到达之间」那段空窗（完成一条会让整行跳进默认折叠的组、也就是从眼前消失），而**顺序始终来自服务端那一次重拉** —— 界面从头到尾没有定义过任何顺序。这条不违背 9.37 立的规矩，而是它的一个用例。
- **失败的回滚是「重新对齐服务端」，不是手工改回去**：切换失败时的正确状态只有服务端知道（可能刚被别处删掉、可能令牌刚失效），所以失败路径做的是「提示 + 重拉」，直接复用 `eventFailureExit` 的 404 / 其余分流。
- **切换是串行的**（`EventsPanel` 的 `switching: string | null`）：同一时刻只允许一条在飞，否则先回来的那次重拉会把另一条还没落库的乐观值覆盖成旧值，表现为「另一行的勾选框自己弹回去、过一会儿又勾上」。串行化期间所有勾选框都进 `disabled`，**不是「能点但被静默忽略」**。
- **撤销入口只在「刚标成完成」之后给，且不自动消失**：那一步会把行从眼前拿走，点错了当场看不见它去了哪 —— 这是唯一真正需要反悔入口的方向；反方向的「恢复」是把行放回眼前，做错了再点一次即可。不设定时器是因为「定时消失」= 「用户还没读完入口就没了」，而且会引入一个测试必须等待的时钟。撤销之后也不再给「重做」。
- **这张表与纪要怎么区分**：`events` 是实体表（带 `createdAt` / `updatedAt` / `deletedAt`），`event_logs` 是**只追加流水**，**只有 `createdAt`** —— 给它加 `updatedAt` 会让人以为这行改过，而它的价值就在于「记的是当时发生的事」。
- **状态是怎么存的**：`events` 上的 `status` / `completedAt` / `completedById` / `completedByName` 是**可重建的冗余**，权威来源在 `event_logs` 里；每次 `todo ↔ done` 的流转都**追加一行**（`created` / `completed` / `reopened`），从不修改已有那行，两件事在**同一个事务**里。撤销完成是追加 `reopened`，不是删掉 `completed`。
- **不写日志的那一类**：编辑标题 / 描述 / 标签 / 优先级**刻意不写日志** —— 详情面板要回答的是「状态怎么变的」，混进编辑记录就变成另一份东西了。因此 `PATCH` 的 schema 里**没有 `status` 项**，改状态只能走 `PUT /api/events/:id/status`。
- **T3-12 已完成详情面板**：点**行内标题**打开（行本身仍然不是 `<button>`，行里已经有勾选框与行内菜单两个可交互元素，整行包成按钮会得到嵌套的可点击元素）。面板展示：完整描述（**复用纪要那个 `MarkdownPreview`**，不写第二份渲染器）、完整标签（不截断到 3 个）、创建 / 截止 / 完成时间、完成用时、完成人，以及来自 `event_logs` 的**变更历史时间线**。**后端与共享包一行未改** —— `GET /api/events/:id/logs` 在 T3-09 就已就位，前端只补 `eventLogsRequest` / `loadEventLogs` 两个封装。
- **面板头部直接用列表那一份数据，只有时间线在等接口**：打开面板的第一帧就有标题、描述、时间、耗时要显示，而不是先给一个空的骨架。日志另有自己的三态（加载 / 失败 / 空）。
- **耗时不需要新字段**：`completedAt` 减去创建时刻即可，而那个「创建时刻」就是 `event_logs` 里那一行 `created`。同理操作人是 `completedByName`（**显示名快照**）。**不要为此加表或加列。**
- **未完成的事件也能打开详情**（规格里只要求已完成）：描述在列表行上无处可看，只给已完成开面板等于让未完成的人找不到自己写的内容。这是对规格的**有意扩展**。已完成的事件额外多出完成时间 / 完成人 / 完成用时三块；未完成的不显示完成用时（没有终点，硬算出来会是一个假数字）。
- **动作码认不出来就原样显示**：`EventLog.action` 的类型是 `string` 而非联合类型（有意，见 `packages/shared/src/event.ts`），因此界面用 `eventLogActionText` 匹配、认不出就把动作码本身显示出来。收窄成三选一会让「库里有第四种动作」这件事在界面上被吃掉。
- **变更历史是读 `event_logs`，不是界面按当前状态反推的**：反推的做法（「当前是未完成就画一条未完成」）在界面上看起来很对，只有一件事经历过往返时才露馅。e2e 那一段刻意复用 T3-11 段里已走过「完成 → 撤销」的那条事件 —— 它此刻是**未完成**，而面板里必须**仍然留着那两笔**。这是整个 T3-12 里唯一真正有证明力的断言。
- **详情面板里没有编辑入口、没有勾选框**：编辑走行内菜单、状态走行内勾选框，把它们再搬进面板只会给同一个动作两条路径。要在详情里改状态是以后可能的独立改动。
- **相关规则位置**：取值域与传输类型在 `packages/shared/src/event.ts`，读写与事务在 `apps/api/src/event/events.ts`，接口在 `apps/api/src/routes/events.ts`，展示规则与乐观改状态的纯函数在 `apps/web/src/lib/event-display.ts`，界面在 `apps/web/src/components/events/`。判断见 9.36、9.37、9.38 与 9.39。

### 3.5 阶段四 · 桌面外壳（T4-01 ~ T4-03 完成，T4-04 未开始）

**这一阶段改的是运行宿主，不是业务代码。** T4-01 只做一件事：让外壳打开并渲染出已有界面。

- **工程落点**：`apps/desktop`（此前只有 `.gitkeep`）。最小集合为 `package.json`（`@fanhe/desktop`，`main` 指向 `dist/main.js`）、`tsconfig.json`、`src/main.ts`（主进程）、`src/preload.ts`（预加载）、`src/server.ts`（内置静态服务）、`scripts/`（下载与启动两个脚本）、`test/server.test.mjs`。
- **用 CommonJS 而不是 ESM**：`package.json` **刻意不写 `"type": "module"`**，于是 `module: NodeNext` 产出 CJS。理由是 Electron 的主进程与**沙箱化的预加载脚本**都以 CJS 为默认形态，而 ESM 预加载要求关掉沙箱；T4-03 之后预加载要承担代理与凭据的 IPC，保持沙箱开启更稳妥。
- **外壳怎么拿到前端**：主进程在回环上起一个服务，托管 `apps/web/dist` 并把 `/api/*` 反代到服务地址（含 SPA 回退）。**`apps/web` 一行未改。** 为什么不能用 `file://`、为什么必须反代而不是直连 API，见 8.5 与 9.41。
- **`/api` 反代让「单一来源」这条前提继续成立**：开发期靠 Vite 代理把 `/api` 桥到 8787，服务端因此**从不需要 CORS**；外壳照抄这个形状，前端那侧（`API_BASE_URL` 默认空串）一行不用动。
- **Electron 二进制不随依赖安装落地**：44.7.0 的 tarball 里**没有 `scripts.postinstall`**，所以 `onlyBuiltDependencies` 对它其实是空操作，装完依赖不等于二进制就位。补了 `scripts/ensure-electron.mjs` 并由根 `postinstall` 调用，幂等、换机可复现，压缩包经 `ELECTRON_*` 落在工作区 `.cache/electron`。
- **启动器要摘掉 `ELECTRON_RUN_AS_NODE`**：该变量一旦为真，electron 会退化成纯 Node（不建窗口、`require('electron')` 返回路径字符串），而 CI、部分 IDE 终端与自动化会话都会带上它。见 8.5。
- **沙箱默认开启**：受限环境（无桌面会话）里 Chromium 沙箱起不来，表现为不含原因的 `ERR_FAILED (-2)`，此时用 `FANHE_NO_SANDBOX=1` 显式关闭。**关沙箱是安全降级，不设为默认值。**
- **判断见 9.41 / 9.43**；验收对照阶段四第一项「外壳可打开并渲染界面」与第三项「远程模式下可启动本机软件」。
- **本机代理是 `import()` 进来的源码，不是拷贝，也不是构建产物**：`apps/desktop` 是 CJS、`apps/api` 的产物是 ESM，而真正需要的只有 `runLaunchProfile` 这一个函数 → 走 `import()` 直接执行 `.ts`（Node 类型剥离），于是 `agent.ts` 改完外壳下一次启动就用新的，不存在「忘了先构建 api」。代价是这条路径**只有真机能验**，见 9.43 里那个被单测放过、只有真跑才炸的坑。

---

## 四、待办事项

### 4.1 下一项：T4-04 启动自检（P0，可直接开工）

> **T4-01 ~ T4-03 均已完成**（外壳能打开并渲染界面、服务地址可配置且切换后请求真的到达新上游、远程模式下能启动本机软件）。下一项是 T4-04，任务定义见 `DEVELOPMENT-PLAN.md` 第三章第 201 行，阶段四验收见第七章。

- **T4-04 要做什么**：启动时自检一遍——本机代理能不能用、启动配置里那些路径还在不在——并在失效时给出可照着修的引导（而不是让用户点了启动才看到一个没头没尾的失败）。
- **可以直接复用的东西**：`apps/api/src/launch/agent.ts` 的 `inspectExecutablePath`（带 `PATH_INSPECT_TIMEOUT_MS` 超时，专门对付 `\\server\share\...` 这种死掉的共享）与 `apps/api/src/routes/status.ts` 的 `listProfileStatuses`。**优先复用，不要在 desktop 侧重写一份路径检查。**
- **与 T4-03 的分工**：T4-03 的复核（`normalizeProfile`）管「送来的东西像不像一条配置」，自检管「这条配置指的东西还在不在」。两者失败原因不同，界面给的动作也不同（前者不该让用户去改路径，后者要）。
- **剩余范围**：另有一项**不在编号内但属既定范围**：`credential.ts` 的存储后端换成主进程 `safeStorage`，建议单独一笔。
- **别顺手做阶段五的容器化。**

### 4.1.1 T4-03 的实施记录（已完成，供对照）

- **外壳不查库，`LaunchProfile` 由渲染进程送进来**。三个方案里选了「渲染进程经现有 `GET /api/launch/profiles` 取配置 → IPC 送进主进程」：主进程自己查库会违背 `agent.ts` 顶部写死的约束（它**不认识数据库**），而把启动配置落成配置文件则要重做已交付的 T3-03，且与阶段五的数据库模型冲突。选中的方案完全复用现有链路，`agent.ts` **一行未改**，远程模式下同样通。
- **主进程必须自己复核形态**。HTTP 那条路上配置在入库时校验过一次、路由 schema 又把一次，agent 收到的一定是像样的东西；IPC 这条路上**没有任何一道**，而这条通道对渲染进程里的任何脚本开放。少这一步，`launch:run` 就等于一个本机任意命令执行入口。复核落在 `apps/desktop/src/agent.ts` 的 `normalizeProfile`：逐字段查（绝对路径、参数全为字符串、个数与长度不超限、`icon` 形态、`sortOrder` 有限数），**返回新对象**，未知的额外字段因此被丢掉、带不进进程创建。
- **新增失败原因 `invalid_profile`**，与 agent 原有的 `executable_missing` 分开：前者是「你送来的东西不像一条配置」（不该让用户去改路径），后者是「配置没问题但文件不在」（该让用户重新指定）。界面给的动作不同，合成一类会让其中一个的引导必然出错。
- **`apiLaunchModule(fromDir)` 的 `fromDir` 是必填**，沿用 T4-02 `config.ts` 的同一条约定（见 4.1.1 里那条 `__dirname` 的坑）。顺带收获是这段逻辑**可测了** —— 模块内不留 `__dirname`，单测就能在 ESM 里传自己造的目录进去。
- **`import()` 的参数必须是 URL 而不是路径**。ESM 加载器只认 `file:` / `data:` / `node:`，直接喂 Windows 绝对路径会被当成协议名为 `f` 的 URL 拒掉（`ERR_UNSUPPORTED_ESM_URL_SCHEME`）。用 `pathToFileURL` 转，顺带把工作区名里的空格（`fanhe Work`）正确编码掉。**这一条是只有真机才暴露的**：前一层单测用的是假 agent 模块，从不真的 import，于是它在 desktop 全绿的情况下一直是坏的 —— 详见 9.43。
- **刻意不缓存模块实例**。Node 的模块缓存按 URL 索引，同 URL 第二次 `import()` 拿同一实例，这正是去重表要跨调用生效所依赖的；而缓存到模块级会让 `recentRuns` 在两个壳实例间不共享，症状是「任务管理器里躺着五个微信」。
- **`LaunchAgentModule` 写成结构类型**而不是 `typeof import('apps/api/src/launch/agent')`：后者在构建期要求 tsc 能解析那个路径，而 desktop 既没把 `@fanhe/api` 声明成依赖、工作区根也没配路径别名 —— 真写上去会得到一条解析不了的 import，**且它只在类型位置出现、运行时一切正常**，属于最难查的一类错误。代价是契约要手写，接口因此收窄到只用得到的两个成员。
- **`LaunchAgentModule` 失败时不抛而变成返回值**：agent 是按需加载的（工作区不完整时它会失败），那不该让外壳连界面都开不出来。加载失败变成一个可显示的 `detail`，界面能报「本机代理不可用」并说明原因。
- **验收脚本的判据是「真进程跑起来了且写出了标记文件」**，不是返回值也不是 pid 是否存在。可执行文件取 `process.execPath`（node 自己）加一段写标记的临时脚本，参数逐个断言原样送达 —— 只断言「进程起来了」的话，一个无视参数的错实现也能通过。另外断言了**假上游一次请求都没收到**：那是「启动走的是主进程 IPC 而没有绕回服务那条路」的唯一硬证据，而这条恰好就是 T4-03 的全部价值所在。
- **`test/acceptance/t403-shell-launch.mjs` 刻意不放 `test/*.test.mjs`**（那是 node --test 的 glob）。同 T4-02，暂存根固定落系统盘 —— `ws-run.cmd` 把 `TMP` 指向工作区 `.tmp`，会让「找不到工作区根」这类用例自相矛盾。
- **验证结果（2026-10-12）**：四道门禁全绿，`test` 为 shared 83 + api 197（192 过 / 5 跳过）+ web 70 + **desktop 52**，合计 **402 项 0 失败**；lint / typecheck / format:check 全通过。验收脚本 10 项全通过。外壳冒烟 PASS（`渲染元素=1 console错误=0`；`反代到达上游=否` 是因为当时 8787 无监听，与 T4-02 同因，非回归）。

### 4.1.1 T4-02 的实施记录（已完成，供对照）

- **配置文件落点**：工作区 `.config/fanhe-work/service.json`。**刻意不放 Electron 的 `userData`** —— 后者装的是 Chromium 缓存与 `credential.ts` 的凭据密钥库，搬进 U 盘既伤盘（与「数据库刻意不进 U 盘」同理）又会改变「凭据不随工作空间移动」的安全语义；而服务地址描述的恰恰是「这套工作空间接哪个服务」，该跟着介质走。`.config/` 是工作区既有的逐机配置目录（`ws-env.sh` 把 `XDG_CONFIG_HOME` 指向那里），已被根 `.gitignore` 第 6 行排除。
- **形状只有 `serviceUrl` 一个字段**。本机与远程**不是两个槽位**，而是同一个地址的两种取值 ——「切换」就是把这一项改成另一个 URL。做成 `localUrl` / `remoteUrl` + `active` 会引入一个真实坏处：远程没配时切过去，外壳以「没有可用地址」启动，而这与「配错了」在现场看起来一模一样。单字段下配错会当场被校验挡下。
- **改配置需重启外壳才生效**，这是刻意取舍：反代上游在起服务时确定，运行中换会产生「切了一半」的中间态，那在现场与「切失败了」难以区分。`service:set` 的返回值带 `needsRestart` 让界面能提示。
- **配置坏了不让外壳起不来**：坏 JSON、非法地址、空串、顶层是数组，全部退回缺省并把原因写进 `warning`，启动时打到标准输出。四条路径都有单测。
- **`fromDir` 必填而不是模块内自己推断**：`__dirname` 在单测那条 ESM 路径上不存在（且在参数默认值求值时就抛，早于任何显式传参），`import.meta.url` 又被 tsc 以 TS1470 拒绝（CJS 产物）。于是把「从哪儿找工作区根」交回调用方，`main.ts` 跑在 CJS 里传 `__dirname`。
- **验收脚本刻意不放在 `test/*.test.mjs`**：它没有 `node:test`，放进去会被门禁的 glob 当单测跑。落在 `test/acceptance/t402-service-switch.mjs`。
- **一处环境依赖型坑**：`ws-run.cmd` 把 `TMP` / `TEMP` 指向工作区的 `.tmp`，而 `.tmp` 就在 `.ws-root` 底下 → 任何从 `os.tmpdir()` 派生的目录向上找都必然命中工作区根。于是「找不到 `.ws-root` 时返回 null」这条用例在裸 node 下过、经 ws-run 挂。两个测试文件的暂存根因此固定落系统盘。**症状是「裸跑过、门禁里挂」，判据是跑两次对比。**
- **验证结果（2026-10-12）**：四道门禁全绿，`test` 为 shared 83 + api 197（192 过 / 5 跳过）+ web 70 + **desktop 28**（原 10 + 新增 18），合计 **378 项 0 失败**；lint / typecheck / format:check 全通过。验收脚本 11 项全通过。外壳冒烟 PASS，且**扩展了一条「反代到达上游」**（经内置服务请求 `/api/`，上游回 401/404 也算到达，只有 502 才是没到）—— 在真实工作区读到配置后为「是」，改指向假地址后转「否」。提交 `f2bfc16`。
- **顺带答了一个悬着的取舍**：「配置要跟着 U 盘走」由此落地，而 R2（`userData` 是否重定向进工作区）**降级为不阻塞主线** —— T4-02 证明了配置不必经由 `userData`。缓存留在系统盘与数据库不进 U 盘是同一类判断，凭据的安全语义也保持不变。

### 4.2 阶段三已无待办

纪要链（T3-05 → T3-06 / T3-07 → T3-08）与事件链（T3-09 → T3-10 → T3-11 → T3-12）**都收口了，12 项任务全部完成，验收六项全部勾选**。两链的已知边界与有意留白都记在 4.5，**那些是记录不是待办** —— 别把它们当缺陷去「修」。

### 4.3 后三个阶段

- **阶段四 Electron 外壳（T4-01 ~ T4-04）**：外壳脚手架、本机/远程服务地址切换、把 `launch/agent.ts` 搬进外壳主进程（它已经为此设计好了）、启动自检；另把 `credential.ts` 的存储后端换成主进程 `safeStorage`。
- **阶段五 服务端化（T5-01 ~ T5-05）**：Docker Compose 编排 web/api/db、数据库容器化与连接切换、数据迁移与校验、Cloudflare Tunnel 仅出站、访问策略。
- **阶段六 更新通道**：版本清单接口、客户端版本比对、外壳升级通道、安装包签名校验。

### 4.4 长期遗留（跨阶段，待排期）

- `users.passwordChangedAt` 接入访问令牌载荷（目前改密**不会**让已签发的访问令牌失效）。
- 改名复用 `normalizeUsername`，并在改名前用归一后的值查一次冲突（否则「只差大小写」的改名会绕过唯一约束）。目前唯一用得上冲突检测的入口是首次初始化。
- 账号与角色管理的审计挂钩（「授权变更」与「删除」两个事件族还**没有接口可挂**）。
- 客户信息平台 / **运维信息平台**（UI 集成时由「运营信息平台」改名）的权限点定义；当前 11 个权限点只有 `system` 与 `personal` 两段。
- **16 个占位导航项的 `module` 目前为 `null`**（对已认证用户一律可见）：除「首页」与「系统设置」外，其余 16 项（含 11 个预留槽位）都还没绑模块段。模块落地时改成对应模块段并同步改 `navigation.test.mjs` 的断言（否则它们会一直对所有人可见）。UI 集成里新加的 14 个子项与顶层「资产 / 搜索」同属这一类。
- `projects/fanhe-work/`、`apps/api/`、`apps/web/`、`packages/shared/` 四处 `node_modules.old`：**已分析确认应当删除，但用户 2026-10-11 决定暂不删**。约 489 MB、23802 个文件，顶层软链接 100% 悬空于已不存在的 `E:` 盘，且与现役树重复、会污染 lint/format（现靠三处忽略规则压住）。依据见 `SYNC-COMPARE-2026-10-11.md` 第十一节。**将来删的时候不要连带删 `node_modules/`。**

### 4.5 已知边界与有意留白（不是缺陷）

**纪要**
- **列表分页未做**：`GET /api/notes` 一次返回该用户全部未删除纪要，没有分页参数。**检索也是全表扫描**，分页与索引应当一起排期。
- **检索有三条边界**：① 走 `ILIKE` 全表扫描、不建索引；② `LIKE` 元字符 `%` / `_` 未转义（搜 `%` 命中全部记录，有意不修）；③ 两个字的关键词即使将来建了 trgm 索引也仍走全表扫描。
- `PATCH` **不接受** `pinned` / `archivedAt` —— 这两个状态各有独立幂等 `PUT`，是有意设计。
- 标签无独立元数据（没有颜色、描述，也不跨用户共享），「标签重命名」目前要逐条改标签数组。
- 正文上限 10 万字符是**防超大请求体的闸门**而非业务约束；列类型是 `text` 不设宽度，改上限只需改 `NOTE_LIMITS.CONTENT_MAX` 与 schema 注释，**不需要迁移**。
- `@updatedAt` 副作用：置顶 / 归档都会刷新 `updatedAt`，取消置顶后该条会落到「最近修改」首位 —— 有意保留。

**启动通道**
- `canWrite: false` 已隐藏整行操作，但**浏览器级验证只覆盖 owner**；其他角色的真实渲染不能算作已验收。
- 路径 `stat` 的 5 秒超时**只结束等待、不取消底层文件系统调用**。
- 历史按用户保留最近 500 条，**不永久保证「上次成功」可得**。
- 状态重查**没有「检查中」状态、也没有失败反馈**，失败时保留上次快照。

**事件记录**
- **列表分页未做**：`GET /api/events` 一次返回该用户全部未删除事件，没有分页参数（与纪要同量级、同一判断）。
- **没有「归档」**：需要收起来时用的是软删除。真出现「要留但要退出列表」的需求再加，那是一个独立的迁移。
- **行上最多显示 3 个标签**，多出来的在后面记一句 `+N`；**完整标签列表在详情面板里**（T3-12 已做）—— 两处是同源数据，行上截断是为了让标题有地方放，不是两套值。
- **勾选切换是串行的**（同一时刻只允许一条在飞），期间所有勾选框都进 `disabled`。这不是性能问题而是观感问题：允许并发会让后一次重拉把另一条还没落库的乐观值抹掉（表现为另一行的勾选框自己弹回去）。单用户本机应用的通行做法，代价在几百毫秒的量级、实际看不见。
- **撤销入口不自动消失、不给「重做」、不写 `comment`**：服务端支持 `comment`，但界面的勾选是「做完了」这一个动作，没有可填备注的位置 —— `setEventStatusRequest` 因此刻意不收这个参数。真需要「撤销原因」时再加，那会是一次独立的改动。
- **没有批量勾选**（一次一条，配合串行化）。
- **`EventRow` 的 `locked` 与 `switching` 是两个 prop 而不是一个枚举**：「点不动」与「正在处理的是我」在界面上确实是两件事（前者不压暗、后者压暗），合成一个之后会需要在这两个量之间做一次没有信息量的映射。
- **详情面板不做编辑与勾选**（T3-12 的有意留白）：编辑走行内菜单、状态走行内勾选框，面板只做「看清楚这一件事」。想在详情里直接改状态是以后可能的独立改动，现在别加。
- **未完成的事件也能打开详情**（规格只要求已完成，这是有意扩展）：描述在列表行上无处可看，只给已完成开面板等于让未完成的人找不到自己写的内容。代价是未完成的面板缺完成时间 / 完成人 / 完成用时三块 —— **未完成时不显示完成用时**，没有终点算出来的只是一个假数字。
- **时间线只展示状态流转，不展示编辑历史**：编辑标题 / 描述 / 标签 / 优先级刻意不写日志（详见 3.4）。所以时间线里看不到「谁改了标题」—— 面板回答的是「状态怎么变的」，混进编辑记录就变成另一份东西了。若将来要编辑历史，那是新增一条 `action` 码并改 `PATCH` 的写日志策略，不是界面改动。

**账号与权限**
- 阶段一验收「关键操作在 `audit_logs` 有记录」**未勾选**：写入链路与四类事件已完成，但缺「授权变更」与「删除」两类事件的接口。

---

## 五、关键决策清单

> 每条只给结论与**为什么**，需要完整推演时按编号翻 `DEVELOPMENT-PLAN.md`。这一节的存在意义是：**别把已经论证过的事再论证一遍**。

### 5.1 技术选型

| 决策 | 结论与理由 | 出处 |
| -- | -- | -- |
| TypeScript **6.0.3** | 不用 7.x：`typescript-eslint` 8.71.1 的 peer 是 `>=4.8.4 <6.1.0`，遇 TS 7 是**导入即抛错**。官方出路是并存两套类型系统，不值得 | 9.3 |
| Vite **显式绑 IPv4 回环** | Windows 上 `localhost` 只解析到 IPv6 `::1`，与后端 `127.0.0.1:8787` 不在同一协议栈 | 9.3 |
| Prisma **钉 7.10.0** | 两个包同版本，不要 `@latest` | 8.4 |
| 数据库**容器 + 命名卷** | PostgreSQL 随机 IO 重，而工作空间在闪存 U 盘上（慢且有写入寿命）；代价是换机后库不在 | `docker-compose.yml` 注释 |
| 排序规则 **ICU `zh-CN`** | 默认 `C` 按 UTF-8 字节序比较，中文相当于按码位排，列表里的中文姓名不会按拼音顺序出现。建库时定死，事后改要重建 | 同上 |
| 密码哈希用 **`@node-rs/argon2`** | 本机**没有 C++ 编译器**，node-gyp 源码编译走不通；装带二进制的包优先 napi-rs 系 | 9.9 |
| Argon2id 用 **OWASP 最低推荐档**（m=19456 / t=2 / p=1） | PHC 编码串自带生成时的参数，**改参数不会让已有密码失效** | `.env.example` 注释 |
| **不引 `rehype-raw`** | Markdown 一旦放行原始 HTML，一段 `<img onerror=…>` 就能在读到它的人那里执行；要支持 HTML 必须同时加 `rehype-sanitize`，而那不该由一个预览组件顺手决定 | 9.33 |
| Web 端**不引 `@tailwindcss/typography`** | 项目排版规格出自方案 B，覆盖插件带来的整套字位与间距，成本高于直接写十几个标签 | 9.33 |

### 5.2 安全与认证

- **访问令牌只放内存，刷新令牌持久化**；续期用**单飞**收敛并发，401 续期一次后重试。出处 9.17。
- **四类登录失败共用同一响应**，不给人枚举用户名的机会。出处 9.10。
- **登录限速双维度**（账号 + IP），阈值与窗口全部配置化，超限 429。出处 9.12。
- **权限每次查库、不缓存** —— 账号停用或删除后令牌立即失效。出处 9.13。
- **归属不符与不存在统一返回 404**，不用 403 —— 用 403 会让任何一种响应都变成「这个 UUID 存在」的探针。因此前端那一侧也无从区分，文案统一。出处 9.32。
- **刷新令牌重放按 `familyId` 整链撤销**，撤销分 session / device / all 三层。出处 9.11。
- 记住账号密码用 **AES-GCM**，密钥存 IndexedDB 且不可导出；凭据只在登录成功后写入，取消勾选即清。出处 9.20。

### 5.3 数据与数据库

- **软删除统一用 `deletedAt`**；**归档用 `archivedAt` 记时刻而不是布尔**（「什么时候归档的」本身有信息，且布尔改不动历史）。
- **标签用 `text[]` + GIN，不另开 `tags` / `note_tags` 关联表**。出处 9.32。
- **所有权的强制在 service 层**（`where` 恒带 `userId`），不用数据库约束兜。
- **重名检查不用数据库唯一约束**（启动配置），因为软删除之后那个「唯一」的含义会变。出处 9.28。
- **`PATCH` 体要求 `minProperties: 1`**，空 body 被 400 拒。
- **正文不 trim、标题 trim**：Markdown 的前导空白有意义。
- **迁移的目录名字典序 ≠ 实际创建顺序**（`login_rate_limit` 比 `init` 排得靠前但创建得更晚）。当前字典序**恰好**满足依赖，**不能宣称全部迁移互相独立**；新增迁移若引用更晚创建的对象，要查的是迁移间是否真的独立。出处 9.16。
- **不写审计**：纪要属私有用量，与启动配置同判（服务端不记录读写的审计流水）。

### 5.4 中文全文检索（T3-07 的核心结论）

**选择：`ILIKE` 覆盖标题与正文，不建索引。这是实测后的决定，不是绕开。**

| 候选方案 | 实测结果 | 结论 |
| -- | -- | -- |
| `tsvector` + GIN | `to_tsvector('simple','衣柜门板安装说明')` 只产出**一个**词位，`@@ to_tsquery('simple','衣柜')` 为 **false**。返回的是「正常结果为空」而不是报错，很容易被误读成数据没写进去 | **否决**。本机容器 `pg_available_extensions` 只有 `pg_trgm` / `btree_gin` / `unaccent`，**没有中文分词器** |
| `pg_trgm` GIN + `ILIKE` | 30 000 行中文数据、索引已建并 ANALYZE：**两个字**的 `'%衣柜%'` 仍走 **Seq Scan**，三个字以上才走 Bitmap Index Scan | **否决**。两个字恰是中文最常用的关键词长度，这条路在最需要它的地方不生效 |
| **`ILIKE` 全表扫描** | 单用户纪要量级是几百到几千条，全表扫描在此量级是**毫秒级** | **采用** |

**升级路径已备好**（真出现性能问题再上）：迁移里 `CREATE EXTENSION IF NOT EXISTS pg_trgm;`，模型上加
`@@index([title(ops: raw("gin_trgm_ops")), content(ops: raw("gin_trgm_ops"))], type: Gin)` —— Prisma 7.10 对 `ops: raw(...)` 与 `extensions = [pg_trgm]` 都能通过 `prisma validate`（已实测）。**但那时只有三字以上的关键词会变快。**

**「什么叫空检索词」只有一处定义**：共享包 `normalizeSearchQuery`，`undefined` 与全空白**一律归 `null`（含义是不检索）**。`null` 与 `''` 的区别是**承重**的 —— Prisma 的 `contains: ''` 会匹配每一行。上限 `NOTE_LIMITS.SEARCH_MAX = 64` 也放共享包，前端拿它做 `maxLength`。

**边界**：`LIKE` 的 `%` / `_` 未转义（Prisma 的 `contains` 不提供 `ESCAPE`），搜 `%` 命中全部记录。不是安全问题（查询参数化、无注入面），**有意不修** —— 要修得换成原生 `$queryRaw`。完整判断见 **9.34**。

### 5.5 前端约定

- **令牌唯一来源是 `apps/web/src/index.css` 的两层结构**（`:root` 原始值 + `@theme inline` 映射），不要在组件里写死颜色。
- **新增颜色令牌要同时在 `:root` 与 `.dark` 各写一份** —— 只写一处会得到一个只在亮色（或只在暗色）下正确的界面，而这类缺陷在默认配色下完全看不出来。
- **不改 shadcn 组件源码**；方案 B 与 shadcn 默认风格的差异**在令牌层消化**（`--shadow-xs/sm` 归零、只覆盖 `--radius-md` 到 8px）。
- **组件一律从 `apps/web/src/components/ui/` 取，不手写等价元素**：同一件东西两种实现时，差异只会在改令牌或换主题时才暴露。
- **前端分层固定为三层**：`lib/api.ts`（只拼地址、不认会话）→ `lib/session.ts` 的 `withAccessToken` → `lib/<模块>.ts`（会话感知 + 拆信封 + 按错误码分流）。界面三态走 `components/StateView.tsx`。
- **展示规则下沉到 `lib/<模块>-display.ts` 的纯函数，不要写在组件里**：分组、派生判断（逾期）、取值到文案与样式的映射、时间形态转换，全都是纯函数，而它们恰恰最容易在某次改动里被弄错（例如「逾期」顺手把已完成的也算进去）。写在组件里就只有开一次浏览器才能验，抽出来则能被 `node --test` 直跑。范例见 `lib/event-display.ts` 与其 17 项单测。
- **`pnpm --filter @fanhe/shared build` 必须先跑**：根脚本的 `dev` / `build` / `typecheck` / `test` 都会先构建共享包，直接调用子包脚本会跳过这一步。
- **受控组件的「数据后到」死角**（实战踩过，见 5.6）：靠父组件 `key` 重挂来初始化草稿或表单状态时，**key 的变化可能与数据到达脱钩**。

### 5.6 三处踩过的真 bug（这类 bug 只有浏览器验证能抓到）

1. **新建纪要后编辑器被初始化成空白**（T3-06）。父组件先 `setSelectedId(created.id)` 再重拉列表，于是 `key` 由 `'new'` 变成新 id、编辑器重挂，而重挂那一刻列表里还没有这一条、`note` 仍是 `null` —— 草稿被初始化成空白且此后再无同步时机。现象是「左侧列表里有条目，右侧编辑器一片空白、标题计数 0/200」，而保存按钮还亮着。**修法**：记一个 `syncedNoteId`，只在 note 的 **id** 变化时补一次同步（判据用 id 而不是整个对象，否则列表重拉换了引用会把用户正在输入的内容冲掉）。见 9.33。
2. **空库时第一条纪要永远建不出来**（T3-06）。编辑器原先只画在「列表非空」分支里，空库走空态，而空态里的「新建」只是把选中项设回 `null` —— 渲染分支不变，点按钮毫无反应。**修法**：可写角色在加载完成后一律渲染「左列表 + 右编辑器」，只读角色空库时才回落空态。见 9.33。
3. **提交成功后旧实例的卸载落盘把已提交内容写回新建槽**（T3-08）。父组件先换 `selectedId`、编辑器随之重挂，而**旧实例的卸载清理是在重挂之后才执行的**；那一刻它手上的 `note` 仍是 `null`（列表还没重拉完），「有没有改动」恒为真，于是内容被写回 `'new'` 槽。现象是「**新建 → 提交 → 再点新建**」时编辑器里躺着上一条已经存过的纪要 —— 要三步才出现。**修法**：`committedRef`，提交成功时置真并清槽，落盘前先看它；**重置必须放在输入回调里而不是 effect 里**，因为紧跟其后的 `setValues(valuesFrom(saved))` 也是一次 values 变化，放 effect 里会被它立刻清掉、等于没挡。见 9.35。

**这三条与「四道门禁全绿」并存**：单测、类型检查、接口冒烟全都拦不住它们。第 3 条尤其典型 —— 它被修好之前，`pnpm test`（当时 251 项）、`typecheck`、`lint` **全都是绿的**，只有浏览器 e2e 的「新建 → 提交 → 再点新建」那一项能把它照出来。

> **补一条同源的反面提醒**：反过来说，**没有界面改动的任务不该硬跑 e2e**。T3-09（事件模型与接口）就属于这一类 —— 它的验收要点落在**数据**上（每次状态变更到底追加了哪一行），e2e 断言的是界面行为，跑了也验不到。那一类的正确验证方式是**绕过接口直查库**，见 9.36。

### 5.7 工作空间与工程约定

- **根靠向上查找 `.ws-root` 定位，不写死盘符**；**受版本控制的文件禁止硬编码盘符**，需要根时用 `WS_ROOT`；路径含空格时变量一律加引号。
- **诊断脚本归档在 `projects/fanhe-work/tools/`**（`checks/` 门禁与探针、`prisma/` 数据库、`oneoff/` 一次性），由工作区根的 `.tmp/` 归档而来。
- **`.ps1` 必须带 UTF-8 BOM**（硬性约束）：Windows PowerShell 5.1 解析无 BOM 文件时按系统 ANSI（GBK）解码，GBK 尾字节会吃掉落在其范围内的 ASCII 字符（含单引号），报「字符串缺少终止符」而**整个脚本一行都不执行**。推论：**任何要被 PS 5.1 执行的 `.ps1`，要么带 BOM，要么全文只用 ASCII。**
- **提交完整、别用 `git add -A`**：工作区里有并发会话产生的未跟踪目录（本次为 `UI合并方案/` 与 `星尘AIGC-UI解析/`），`add -A` 会把它们一起提交进去。**显式列出路径。**
- **推送要给足时间并落盘日志**：凭据阶段会停滞约 70 秒（git 先查 `credential.helper=helper-selector` → `credential.helperselector.selected` → 才落到 GCM 绝对路径），**超时给到 ≥150 秒**；**不要把推送输出接管道**（`| tail` 的缓冲会把日志全吞掉，表现为「无输出卡死」），改用 `> .tmp/push.log 2>&1` 落盘再读。

---

## 六、依赖环境与配置

### 6.1 唯一入口：工作空间机制

- **所有包管理（install / add / build / test / lint / format）一律经 `infra/portable/ws-run.cmd`。** 直接裸跑 `pnpm` 会让 store 落到宿主机磁盘，且当场无提示。
  - 工作空间根调用：`infra/portable/ws-run.cmd pnpm <cmd>`
  - 从 `projects/fanhe-work` 调用：`../../infra/portable/ws-run.cmd pnpm <cmd>`
  - 从 `apps/web` 深处调用：四层 `../../../../infra/portable/ws-run.cmd pnpm <cmd>`
- **并行调用入口会撞车**（同时写 `state/root.json` 抛 `IOException`），串行执行即可。
- 入口下 `TEMP` / `TMP` 被重定向到 U 盘的 `.tmp/`，**`os.tmpdir()` 不可信**；要让产物落系统盘需从 `LOCALAPPDATA` 推。
- **本机没装编译器**（无 MSVC / node-gyp 走不通），装依赖优先选带预编译二进制的包。
- **`ws-env.sh` 的正确用法**（在会话里临时用）：`cd <repo> && WS_NO_REPAIR=1 WS_QUIET=1 . "<工作区根>/infra/portable/ws-env.sh" && <命令>`，**必须在同一条命令内完成**，因为 shell 状态不跨调用保留。

### 6.2 Node 与包管理

- Node **22.22.2**（受管运行时）。包管理用 **pnpm**（版本在 `package.json` 的 `packageManager` 声明，`corepack enable pnpm`）。
- `pnpm-workspace.yaml` 的 `onlyBuiltDependencies: []` **刻意禁掉生命周期脚本**。
- `.npmrc` 固定 registry 为 `registry.npmmirror.com`；**装依赖按分钟到十分钟量级预留**（实测装两个 Markdown 包解出 593 个包、耗时 5 分 25 秒，伴随 `ERR_PNPM_TARBALL_EXTRACT` 重试最终成功 —— 别把 5 分钟当卡死）。
- **store 有重定向**：`node_modules` 链到 `<工作空间根>/.cache/pnpm-store/v10`，而裸跑 pnpm 想用 `<盘符>:\.pnpm-store\v10`，于是报 `ERR_PNPM_UNEXPECTED_STORE`。重定向来自 `infra/portable/ws-env.sh` 导出的 `npm_config_store_dir` 与 `config/.npmrc` 的 `store-dir=${WS_ROOT}/.cache/pnpm-store`。**盘符会在 `E:` / `F:` 之间变**，所以上面写的是「盘符」而不是具体某个字母 —— 2026-10-11 实测已从 `F:` 变回 `E:`。
- **`pnpm` 本身是逐机的**：本机若从未 `corepack enable pnpm`，入口会报「无法将"pnpm"项识别为 cmdlet」或 `command not found`（`ws-run` 只负责转交裸 `pnpm`，自己不装）。临时替代是 `corepack pnpm <cmd>`，可免 enable 直接跑。**换机必做**。
- **`pnpm install` 的两个必加开关**（非交互环境）：① 无 TTY 时它要 purge 整个 `node_modules` 并等确认，会被中止（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）→ 加 `CI=true` 与 `--config.confirmModulesPurge=false`；② 清 `node_modules` 会撞上批量删除保护（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`）→ 加 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=<大数>`。完整可用写法：
  `cd <repo> && CI=true CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=2000000 ../../infra/portable/ws-run.cmd pnpm install --config.confirmModulesPurge=false`
- **换盘之后 `node_modules` 里的软链接会全部悬空**（实测 `apps/api/node_modules/tsx -> /f/fanhe Work/...`），现象是 `Cannot find module .../tsx/dist/cli.mjs`。工作区的换机自愈会重建 `.bin` shim，但**不修软链接** —— 必须重跑一次 `pnpm install`（store 本身是好的，不需要重新下载）。

### 6.3 数据库（不随盘，换机必重建）

- 容器 **`fanhe-work-db`**，镜像 `postgres:16-alpine`，库 `fanhe_work`，用户 `fanhe`，端口绑 `127.0.0.1:5432`。
- 数据在宿主机**命名卷 `fanhe-work-pgdata`**，不随介质移动。
- 排序规则在建库时定死 **ICU `zh-CN`**，事后更改需重建数据库。
- 健康检查让 `docker compose up -d --wait` 真正等到可连接（迁移脚本依赖这一点）。
- **当前 6 个迁移、12 张业务表**（另加 `_prisma_migrations`）：

  | 迁移目录 | 建的对象 |
  | -- | -- |
  | `20261010082118_login_rate_limit` | `login_attempts` |
  | `20261010150103_init` | `users` / `roles` / `permissions` / `role_permissions` / `refresh_tokens` / `audit_logs` |
  | `20261010165220_launch_profiles` | `launch_profiles` |
  | `20261010180508_launch_history` | `launch_history` |
  | `20261011064829_add_notes` | `notes` |
  | `20261011132819_add_events` | `events` / `event_logs`（**阶段三唯一一次建两张表的迁移**） |

- **迁移目录的时间戳是 UTC**（`date -u`，与 Prisma 自身一致），因此它比本地时间小 8 小时 —— 别按本地时间去找「今天那个迁移」。
- **手写迁移的生成方式（Prisma 7.10 起）**：`migrate diff --from-url` **已被移除**，改用
  `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script -o <文件>`（在读得到 `prisma.config.ts` 的目录下跑），再 `prisma migrate deploy` 应用。**生成后用同一条命令复核一次**，输出应当是 `-- This is an empty migration.` —— 那是「库与 schema 已无差异」的判据，比人肉核对 DDL 可靠。

- **种子数据**：11 个权限点、4 个角色、29 条授权关联；重跑无副作用。
- **owner 账号**：登录名 `fanhe`，显示名「梵禾」，状态 active。口令为 24 位强随机，写在被忽略的 `.tmp/owner-credentials.txt`（**该文件不随盘走**）。
- **owner 存在之后，`apps/api/test/setup.test.ts` 的 5 项首次初始化用例会自动跳过**（前置条件是「库里无 owner」）。看到 api 测试 `skipped=5` 是**设计行为，不是失效**。
- 常用脚本：`pnpm db:deploy`、`pnpm db:ping`、`pnpm db:seed`、`pnpm db:create-owner`、`pnpm db:generate`、`pnpm db:studio`。

### 6.4 Prisma 7 的三处硬性差异（两个包同版本 7.10.0，不要 `@latest`）

1. **强制驱动适配器**：`@prisma/adapter-pg` + `pg`。
2. **连接串与迁移配置移到 `prisma.config.ts`**；生成器改名 `prisma-client`，`output` 必填。
3. **`.env` 不再自动加载**，需 `import 'dotenv/config'` 且置于首行。

### 6.5 环境变量

`apps/api/.env`（由 `.env.example` 复制，**不进版本控制、不随盘走**）：

| 变量 | 说明 |
| -- | -- |
| `DATABASE_URL` | **`schema=public` 不能省**（Prisma 默认把表建在 public 下，缺了它部分命令会走错搜索路径） |
| `SHADOW_DATABASE_URL` | 迁移用影子库。留空时 Prisma 会在目标实例上临时建/删一个库，要求账号有 `CREATEDB` |
| `JWT_SECRET` | **必填，至少 32 字节，没有默认值**。生成：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`。每套部署用自己的，不要跨机复用 |
| `ACCESS_TOKEN_TTL_SECONDS` | 默认 900（15 分钟）。**验证「静默续期」时要压到 60** |
| `REFRESH_TOKEN_TTL_DAYS` | 默认 30 |
| `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` | 默认即 OWASP 对 Argon2id 的最低推荐档 |
| `OWNER_USERNAME` / `OWNER_PASSWORD` / `OWNER_DISPLAY_NAME` | **只被 `pnpm db:create-owner` 读取**，走环境变量不走命令行参数（避免口令留在进程列表里） |

### 6.6 GitHub 与代理（推送必看）

- **GitHub 直连不通，必须走本地代理 `http://127.0.0.1:7897`**（不是 17897，不是会话里的临时端口）。
- **代理不对的症状是「卡住」而不是「报错」**：`git push` 无限等待、无任何输出，极易被误读成凭据过期。判定方法：`git credential fill` 带 / 不带 `HTTPS_PROXY=http://127.0.0.1:7897` 各跑一次，带了的立刻返回、不带就超时，即确认是代理问题。
- 推送时三个变量一起给并加 `GIT_TERMINAL_PROMPT=0`（见第零节的命令），**把输出重定向到文件**再读。
- 判连通性用 `git ls-remote origin HEAD`（秒回即网络与凭据都正常），比反复重推更快定位问题。
- **凭据是逐机逐用户的**（细粒度 PAT 经 GCM 存于 `~/.gitconfig`），**换机必须重配**；WorkBuddy 的 GitHub 连接器只读，写不了。

### 6.7 编码与其他陷阱

- **编码**：bash 写 UTF-8 无 BOM；PowerShell 5.1 的 `Get-Content` 无 BOM 时按系统 ANSI 解码。跨环境传中文清单，读取侧必须显式 `-Encoding UTF8`。
- 原生命令的 stderr 被 PowerShell 包成 `ErrorRecord`；点源 `ws-env.ps1`（设 `$ErrorActionPreference='Stop'`）后更危险 —— 调用会写 stderr 的工具（如 Prisma）前要先改回 `Continue`。
- **Docker 客户端配置不重定向**：`DOCKER_CONFIG` 指向空目录会让 `docker compose` 变成未知命令。
- **跑 `prisma generate` 或门禁会打断正在跑的 `tsx watch`**（删文件导致整个进程退出）。先停 dev，或跑完门禁后重启 dev。
- **`EADDRINUSE` 通常意味着「已有另一个自己在跑」**。清残留要对着命令行按整条链杀，或直接杀 `tsx watch`。
- **Vite dev server 会被批量删除保护挡住**：它启动时要清自己的 `apps/web/node_modules/.vite/deps`（实测 61 个条目），撞上保护后直接抛错退出，日志是 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，而外部只看到「5173 连不上」。**与 `pnpm install` 那个坑同源**，加 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=<大数>` 即可（本次实测 `2000000` 够用）。
- **起 API 做一次性验证时，用不带 watch 的 `tsx src/index.ts`**（在 `apps/api` 下执行）。`tsx watch` 会在构建产物一变就重启，可能撞 `EADDRINUSE` 整进程退出；而且跑 `prisma generate` 或四道门禁会删文件把它打断。
- **本地端口请求一律加 `--noproxy '*'`**：不带它时 `curl http://127.0.0.1:8787` 会被送到系统代理，返回 `HTTP 000`，看起来像服务没起来。取当前代理端口：`env | grep -i proxy`。
- **`pnpm --filter <pkg> exec` 会把工作目录切到该包**：在仓库根 `exec tsx apps/api/src/index.ts` 会因为 `.env` 不在当前目录而报「缺少环境变量 DATABASE_URL」。要跑 api 就在 `apps/api` 下用 `./node_modules/.bin/tsx src/index.ts`。
- **PowerShell 里不要拿 `$pid` 当循环变量**：它是只读自动变量，赋值会静默失败，于是 `Stop-Process -Id $pid` 杀掉的是**运行脚本的 PowerShell 自己**（表现为输出截半、目标进程没死）。换名如 `$procId`。

---

## 七、换机续接步骤（照做即可 100% 恢复）

> 每一步后面都给了**验证判据**。判据不通过就别往下走 —— 后面几步的失败现象会互相掩盖。

| # | 步骤 | 命令 / 动作 | 验证判据 |
| -- | -- | -- | -- |
| 1 | **介质就位** | 整盘带 U 盘到新机，或 `git clone` **整个工作空间根**（仓库根即工作空间根，**不是** `projects/fanhe-work`） | 根目录下有 `.ws-root`、`infra/`、`projects/` |
| 2 | **pnpm 就位** | `corepack enable pnpm` | `pnpm -v` 等于 `package.json` 里 `packageManager` 声明的版本 |
| 3 | **Git 信任与身份** | `git config --global --add safe.directory "<工作空间根>"`；确认提交身份为 `梵禾 <dev@fanhe.local>` | `git config user.name` / `user.email`；`git log -1` 能正常显示（不报 dubious ownership） |
| 4 | **凭据重配** | 重配 GitHub 细粒度 PAT 到 GCM（`~/.gitconfig` 是逐机的） | `GIT_TERMINAL_PROMPT=0 HTTPS_PROXY=http://127.0.0.1:7897 git ls-remote origin HEAD` 秒回 |
| 5 | **依赖重建** | 经入口 `ws-run.cmd pnpm install` | 无 `ERR_PNPM_UNEXPECTED_STORE`；`node_modules` 链到 `<根>/.cache/pnpm-store` |
| 6 | **数据库重建** | `docker compose up -d --wait` → `cp apps/api/.env.example apps/api/.env` 并填 `JWT_SECRET` → `pnpm db:deploy` → `pnpm db:seed` → `pnpm db:ping` | `db:ping` 列出 **12 张业务表**；种子为 11 / 4 / 29；`docker ps` 里 `fanhe-work-db` 是 `healthy` |
| 7 | **构建共享包** | 经入口 `pnpm --filter @fanhe/shared build`；再 `pnpm db:generate` | `packages/shared/dist` 有产物；`apps/api/src/generated/prisma` 有产物 |
| 8 | **建 owner** | 走首次初始化引导，或 `OWNER_USERNAME=… OWNER_PASSWORD=… OWNER_DISPLAY_NAME=… pnpm db:create-owner` | 用该账号能登录（`POST /api/auth/login` 返回 200） |
| 9 | **门禁确认** | 逐条串行跑 `pnpm test` / `lint` / `typecheck` / `format:check` | test 为 **360 项、0 失败**（shared 83 + api 197 含 5 跳过 + web 70 + desktop 10）；其余三条全绿 |
| 10 | **浏览器级验证（可选，代价大）** | 见 8.2 | e2e **149 项全通过**（UI 集成后的结果；改界面就要重跑） |
| 11 | **外壳（阶段四起）** | 经入口 `pnpm --filter @fanhe/web build` 重建产物 → `pnpm --filter @fanhe/desktop smoke`（受限环境加 `FANHE_NO_SANDBOX=1`） | 输出 `[smoke] PASS`，且 `console错误=0`；详见 8.5 |

**换机后不复存在、必须重建的东西**（都是刻意不随盘走的）：

- `.tmp/owner-credentials.txt`（owner 口令）
- `apps/api/.env`（含 `JWT_SECRET`）
- 数据库容器与命名卷（**逐机**：换一台机器就是另一份库）
- 四处 `node_modules/` 与 pnpm store（store 随盘符失效，且软链接会全部悬空）
- **`corepack enable pnpm`**（逐机，本机没做过时入口直接报「找不到 pnpm」）
- GCM 里的 GitHub 凭据、git 的 `safe.directory` 与提交身份

> **换机后必须实跑一遍四道门禁再开工**，别信文档里的「全绿」数字 —— 2026-10-11 就出现过文档记全绿、实跑 `typecheck` 报错（`WorkbenchPage.tsx` 的 `NavLink` 回调缺类型标注，换盘重建依赖后才暴露）的情况。那处已修（`4d43dae`）。

---

## 八、后续开发的注意事项

### 8.1 改代码前必读

1. **改前端**先看 5.5：令牌只从 `index.css` 取、新增令牌要在 `:root` 与 `.dark` 各写一份、组件只从 `components/ui/` 取、不改 shadcn 源码。
2. **改数据模型**先看 5.3：新增迁移要检查迁移间是否真的独立，序列与字典序不保证一致。
3. **碰检索**先看 5.4 —— 那两条路已经实测否决过，重做只会得到同样三个结论。
4. **新增界面板块**不要手写 `StateView` 的等价物；四态（加载 / 失败 / 空 / 列表）照 `LaunchPanel` / `NotesPanel` 的分派形态写。

### 8.2 跑测试与浏览器验证

- **四道门禁依次为** `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm format:check`。`test` 与 `typecheck` 会先构建共享包，`test` 还依赖数据库容器在跑。
- **断言失败时先分清是哪一类，别默认去改产品代码。** 至今累计四类，性质完全不同，但在脚本输出里长得一模一样：
  - ① **真 bug**（改产品代码）—— T3-06 的编辑器草稿同步死角；
  - ② **断言作用域过宽**（改脚本）—— T3-06 的 `nav a` 应为 `aside nav a`，尺子变长了而界面本身正确；
  - ③ **环境残留**（清进程）—— T3-06 的旧 `tsx watch` 占着 8787；
  - ④ **断言期望与实现不符**（改脚本，且要改「对的那一半」）—— T3-10 的「低优先级也有文字」：事件乙在表单里没显式选优先级、吃的是默认的「普通」，而断言期望「低」。**修法是在表单里补一次「低」的点击，而不是把期望改成「普通」** —— 后者会让那一条退化成「为默认值恰好等于期望值背书」，而它本要验的是「非默认档也有文字」。判据：问一句「这条断言要证明的到底是哪件事」，再看改哪一侧更接近那件事。
- **浏览器 e2e 的代价必须记住**（`apps/web/test/e2e-auth.mjs`）：
  - 它以**数据库未初始化（`users` 表为空）**为前置条件 → **每跑一次都要先清库，跑完重建 owner** 并更新 `.tmp/owner-credentials.txt`。重置语句见该文件头部注释（**依次 `event_logs` → `events` → `notes` → … → `users`**；`event_logs` 跟着事件走、`notes` 排在 `users` 之前都是外键的缘故）。**`event_logs` 与 `events` 从 T3-09 起必须带上**：三张表都走软删除，不清的话上一轮留下的 `deletedAt` 非空行会让这一轮的「空态」不可达，而症状只是某条空态断言失败，看起来像界面坏了。
  - 想在不破坏数据的前提下验证接口，用 `.tmp/note-smoke.mjs` 那类脚本（以现有 owner 登录，只碰自己创建的数据，跑完清理）。
  - 用法：`node test/e2e-auth.mjs <应用地址> <截图目录>`，截图目录给 `.tmp/` 下的路径，**别落进仓库**。
  - **界面做不了的准备动作可以走接口**，但要写清理由：T3-10 需要「已完成」的数据来验分组与折叠，而当时界面上还没有把事件置为完成的手段。脚本里因此有 `apiAccessToken()` 与 `apiCompleteEvent()` 两个辅助函数，各自的注释里都说明了「本轮验的是拿到数据之后怎么分组与显示，不是怎么把状态改掉」。**这不是绕开验证，是把两件事分开**。T3-11 起界面有了入口，同样的数据改由界面自己造（`apiCompleteEvent` 因此只留在 T3-10 那一段）；T3-11 反过来用接口做了一件界面做不到的事 —— **先让服务端把那条删掉**，好在界面上制造一次必然失败的切换（见 9.38）。
  - **断言要对得上它声称要证明的事**：T3-11 的「乐观更新」是这条的最新例子。直接点一下再断言「界面变了」证明不了乐观 —— 本机回环几十毫秒的响应，那个变化也可能来自回话之后的重拉。做法是给切换请求装一个 1.2 秒的延迟钩子，把断言预算压到 0.9 秒。**遇到「这条断言其实证不了它说的那件事」时，先想「要把它与什么区分开」，再决定加什么手段。**
- **三个启动前置**：① API 用 `ACCESS_TOKEN_TTL_SECONDS=60` 起（否则等不到续期，「静默续期」那项必失败）；② 前端 dev server 在 5173（**它自己也要加 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD`，否则起不来 —— 见 6.7**）；③ 调试端口上**没有别的监听者**。
- **调试端口现在可以换**：脚本默认 9222，实测可能被一个**非 CDP 的监听者**占住（任何路径都返回 `Content-Length: 0` 的 404），而脚本自带的占用检查判的是 `response.ok`，**因此拦不住你**，症状是 30 秒后的「CDP 页面目标未就绪」。**用 `E2E_CDP_PORT=<端口>` 换一个端口跑。**
  - **菜单类控件（Radix 下拉）点之前先等上一个菜单从 DOM 里消失**：关闭动画期间它仍在 DOM 里，此间的点击会被触发器忽略，脚本**直接抛错中断整轮**（不是记一条 FAIL 继续）。`openThemeMenu` 与 `openRowMenu` 都已按这个模式封好，**新增菜单交互照抄**。
  - **CDP 合成的指针事件（`mouseMoved` / `mousePressed` / `mouseReleased`）会概率性整组丢失** —— T3-12 首轮两次在 T3-11 的乐观更新断言上超时，根因就是这个（`dispatchMouseEvent` 三条都发出去了、界面却没收到）。**症状是「上一轮稳定的断言这轮超时」，重跑又好了。** 判据：CDP 返回值一切正常但 DOM 无反应，且同一段脚本换个时候就通。
  - **因此按控件类型分两档**：**Radix 下拉菜单仍走真实指针事件**（`openRowMenu` / `openThemeMenu`，菜单依赖 hover 与指针捕获，合成的 `element.click()` 不触发定位）；**Radix Checkbox 与普通标题按钮改用 `element.click()`** —— 同步、无动画依赖，稳定性明显更好。改法是让 finder 返回元素句柄后在页面里直接调 `.click()`，不再走 CDP 三件套。T3-12 改完后**连跑两次 146/146 全绿**；UI 集成后基线升到 **149/149**。
  - **二级菜单（`DropdownMenuSub`）靠 `pointermove` 展开，不是 `pointerdown`**：UI 集成把「外观」改成头像菜单下的二级菜单后，合成 `mousePressed` / `mouseReleased` 与 `element.click()` 都不触发它 —— 必须发一次**真实指针移动**（`mouseMove` 辅助函数，`Input.dispatchMouseEvent` 的 `mouseMoved`）。**判据**：菜单能靠手点开、脚本点不开，且 `pointerdown` 类事件都试过无效。
  - **「上一个菜单关好了」要等父菜单，不是子菜单**：Radix 的子菜单先于父菜单卸载。等 `[role="menuitemradio"]`（子菜单项）归零时父菜单仍在关闭动画里，紧接着的点击会被父级忽略、**直接抛错中断整轮**。**改等 `[role="menuitem"]` 归零**。
  - **坐标点击会在入场动画里漂移**：菜单项入场有动画，量中心点与真正可点之间差几像素，点偏一点就落到菜单外、菜单被关掉而选项没选中。**两条应对**：① 让 `elementCenter` 等位置稳定再取（60ms 两次采样、最多 8 次）；② 能走合成 `click` 的控件就走合成 `click`（Radix 菜单项把选择挂在 `onClick` 上，`selectThemeOption` 即此）。
  - **别把 `async` 辅助函数包进 `evaluate`**：`openHomeSection` 是 `async (client, href)`，误写成 `evaluate(client, openHomeSection(...))` 会把 Promise 当表达式，报 `client.send is not a function`。直接 `await openHomeSection(client, href)`。
  - **不要因为一次超时就断言「功能有 bug」**：先分类（见上）。概率性丢包的表现是「同一断言时好时坏」，与真 bug 的「稳定失败」正好相反 —— **跑第二次是最便宜的判据**。
  - **起服务前先确认端口上的监听者是谁** ——「上一轮遗留的进程」是这里最常见的坑。判据最省事：量 JWT 的 `exp - iat`（应为启动时给的 TTL）。

### 8.3 提交与推送

- 提交粒度照现有风格：`feat/docs/fix(阶段X): 中文说明`，一段说清「做了什么 + 为什么」。**同一功能的代码与文档回填分两笔提交**（便于查证）。
- **不要 `git add -A`**（工作区里有并发会话产生的未跟踪目录），**显式列路径**。
- 推送后**把 `dev` 快进到 `main` 并一起推**（当前约定是 dev 跟随 main）。
- 推送走 6.6 的命令，超时 ≥150 秒，日志落盘。

### 8.4 别做这些事（反模式）

- ❌ **裸跑 `pnpm`**（不经入口）—— 会静默把 store 落到宿主机磁盘，事后很难发现。
- ❌ **在受版本控制的文件里写死盘符**（工作空间会在 `E:` / `F:` 之间变）。
- ❌ **删 `.workbuddy/` 或 `.workbuddy-ai/`** —— 那是项目数据与本地记忆。
- ❌ **`git add -A`** —— 见上。
- ❌ **把 `.tmp/owner-credentials.txt` 提交进仓库** —— 它是被忽略的凭据文件。
- ❌ **在没有读 5.4 的情况下「顺手补一个中文全文检索」**。
- ❌ **给 `notes` 表加 `LIKE` 元字符转义**（除非你打算把它换成原生 `$queryRaw`）。
- ❌ **改动 shadcn 组件源码来适配本项目风格** —— 差异在令牌层消化。
- ❌ **忘了 `pnpm --filter @fanhe/shared build`** —— 共享包是构建型包，改了不构建，下游看到的是旧 `dist`。
- ❌ **在受限环境里默认关掉 Chromium 沙箱** —— 需要时用 `FANHE_NO_SANDBOX=1` 显式声明，别写进代码或脚本默认值。

### 8.5 跑外壳与验证外壳

- **加载的是构建产物，不是 dev server**：`pnpm --filter @fanhe/desktop smoke` 前必须先 `pnpm --filter @fanhe/web build`，否则加载到的是上一轮的界面（`dist` 不入版本控制，换机后是空的）。
- **冒烟（`smoke`）是外壳的验收手段**：隐藏窗口加载一次，在渲染进程里探 DOM，打印 `渲染元素/标题/路径/预加载桥/console错误` 一行并按成败设退出码。判据是 `#root` 里有元素且 console 零错误 —— 只看 HTTP 200 不够，那只说明文件在，说明不了界面画出来了。
- **受限环境（没有桌面会话的服务进程、容器、部分 CI）必须加 `FANHE_NO_SANDBOX=1`**：那里 Chromium 的渲染进程沙箱起不来，症状是加载以**不含任何原因**的 `ERR_FAILED (-2)` 结束。**先确认是这个原因再关**，因为同一个报错也可能是产物缺失或内置服务没起来。
- **`ELECTRON_RUN_AS_NODE=1` 会让 electron 退化成纯 Node**：不建窗口，`require('electron')` 返回可执行文件路径，症状是启动即抛 `Cannot read properties of undefined (reading 'on')`，看起来像 Electron 没装好。启动器 `scripts/launch.mjs` 已摘掉它，**别绕过启动器直接调 `electron .`**。
- **渲染进程不走代理**：外壳只加载自己的回环服务，`main.ts` 里已 `appendSwitch('no-proxy-server')`。缺了它，系统/环境代理会把 `127.0.0.1` 的请求也送出去、同样得到 `ERR_FAILED`。
- **Electron 二进制要单独确认**：44.7.0 没有安装脚本，`pnpm install` **不会**下载它。判据是 `node_modules/.pnpm/electron@*/node_modules/electron/dist/electron.exe` 与 `path.txt` 存在；缺了就 `pnpm --filter @fanhe/desktop ensure-electron`（根 `postinstall` 也会自动跑，幂等）。
- **内置服务有单测**：`pnpm --filter @fanhe/desktop test`，10 项，覆盖 SPA 回退、带扩展名 404、路径越界 403、405、HEAD、反代路径/查询串/方法/请求体、上游不可达 502。**改 `server.ts` 就重跑它**，这些行为只有跑起来才看得见。

---

## 九、关键文件路径清单

| 用途 | 路径（相对工作空间根） |
| -- | -- |
| 工作空间唯一入口 | `infra/portable/ws-run.cmd`（另有 `.ps1` / `.sh`） |
| 工作空间机制说明 | `infra/docs/PORTABLE-WORKSPACE.md` |
| 根定位标记 | `.ws-root` |
| 项目根 / pnpm 工作区根 | `projects/fanhe-work/` |
| 后端入口与代码 | `apps/api/src/index.ts`、`apps/api/src/` |
| 认证相关 | `apps/api/src/auth/{password,tokens,login,session,guard,setup}.ts` |
| 审计 | `apps/api/src/audit/audit.ts`、`packages/shared/src/audit.ts` |
| 启动通道（含代理核心） | `apps/api/src/launch/{agent,profiles,status,history}.ts`、`apps/api/src/routes/launch.ts` |
| 工作纪要（含检索） | `apps/api/src/note/notes.ts`、`apps/api/src/routes/notes.ts`、`packages/shared/src/note.ts` |
| 事件记录（T3-09 模型与接口、T3-10 列表视图、T3-11 勾选切换、T3-12 详情面板） | 后端：`apps/api/src/event/events.ts`、`apps/api/src/routes/events.ts`、`packages/shared/src/event.ts`；前端：`apps/web/src/components/events/`（`EventsPanel` / `EventList` / `EventRow` / `EventFormDialog` / `EventDetailDialog`）、`apps/web/src/lib/events.ts`、`apps/web/src/lib/event-display.ts`（展示规则、乐观改状态、动作码映射与耗时的纯函数，可被 Node 单测直跑） |
| 共享包 | `packages/shared/src/`（类型与判定）、`packages/shared/test/` |
| 前端外壳与导航 | `apps/web/src/components/{AppShell,Sidebar,TopBar,StateView}.tsx`、`apps/web/src/routes.tsx` |
| 前端首页三段式与版本号（**UI 集成新增**） | `apps/web/src/components/home/{CaseGallery,LaunchSection,RecordSection}.tsx`、`apps/web/src/pages/HomePage.tsx`、`apps/web/src/lib/{nav-icons,version}.ts`；版本常量由 `apps/web/vite.config.ts` 的 `define` 注入 |
| 桌面外壳（**阶段四 T4-01 ~ T4-03**） | `apps/desktop/src/{main,preload,server}.ts`（主进程 / 预加载 / 内置静态服务）、**`src/{agent,paths}.ts`（T4-03：主进程侧形态复核 + 跨包路径解析与 `import()` 加载 api 的 agent 源码）**、**`src/config.ts`（T4-02：服务地址配置读写）**、`apps/desktop/scripts/{ensure-electron,launch}.mjs`（二进制下载 / 启动器）、`apps/desktop/test/{server,agent,paths,config}.test.mjs` + **`test/acceptance/{t402-service-switch,t403-shell-launch}.mjs`**、`apps/desktop/{package.json,tsconfig.json}`；根 `package.json` 的 `postinstall` 调 `ensure-electron` |
| 前端启动通道 UI | `apps/web/src/components/launch/`、`apps/web/src/lib/{api,launch,launch-icons,relative-time}.ts` |
| 前端工作纪要 UI | `apps/web/src/components/notes/`（`NotesPanel` / `NoteList` / `NoteEditor` / `MarkdownPreview` / `TagInput`）、`apps/web/src/lib/notes.ts` |
| 前端本机草稿暂存（T3-08） | `apps/web/src/lib/note-draft.ts`（槽名、带版本号的序列化、过期与容量清理、写失败重试；接口注入 storage 以便单测） |
| 前端偏好与主题 | `apps/web/src/lib/{preferences,theme,credential}.ts`、`apps/web/src/index.css` |
| Prisma 配置与模型 | `apps/api/prisma.config.ts`、`apps/api/prisma/schema.prisma` |
| 迁移目录 | `apps/api/prisma/migrations/`（**6 个**；时间戳是 UTC） |
| 数据库 compose | `projects/fanhe-work/docker-compose.yml` |
| 环境变量样例 | `apps/api/.env.example` |
| 种子 | `apps/api/src/db/seed.ts` |
| 测试 | `apps/api/test/{event,note,launch-history,setup,…}.test.ts`、`packages/shared/test/{event,note,launch,navigation,account,auth}.test.mjs`、`apps/web/test/{relative-time,note-draft,event-display,version}.test.mjs`、**`apps/desktop/test/server.test.mjs`**、`apps/web/test/e2e-auth.mjs`（`apps/web` 与 `apps/desktop` 的 `test` 脚本都是 `test/*.test.mjs`，新增单测文件会被自动收进来） |
| 诊断脚本归档 | `projects/fanhe-work/tools/`（其 `README.md` 说明各脚本用途、归档来由，以及 `.ps1` 必须带 UTF-8 BOM 这条硬性约束） |
| 规划与交接 | `projects/fanhe-work/docs/`（本文所在处） |
| 环境踩坑（逐机） | `.workbuddy-ai/memory/ENVIRONMENT.md` |
| 测试 / 界面令牌约定 | `.workbuddy-ai/memory/TESTING.md`、`.workbuddy-ai/memory/UI-TOKENS.md` |
| 临时产物与凭据 | `.tmp/`（被忽略，不进版本控制） |

---

## 十、文档索引

**本文档（`docs/WORK-STATUS.md`）是交接主文档**，自包含。其余文档按其职责查阅：

| 文档 | 职责 |
| -- | -- |
| `docs/DEVELOPMENT-PLAN.md` | 总体方案、任务表（第三章）、阶段验收（第七章）、里程碑（第八章）、**逐任务实施判断（第九章，阶段三为 9.28 ~ 9.39，UI 集成为 9.40，桌面外壳 T4-01 为 9.41、T4-02 为 9.42、T4-03 为 9.43）**。9.34 专门记录中文检索的选型，9.35 记录草稿自动保存的三写三清与那个时序坑，9.36 记录事件板块两张表的语义区分与状态流水的写法，9.37 记录事件列表视图的分工（分组在前端、排序在服务端），9.38 记录勾选切换的四处判断（乐观更新与重拉如何并存、回滚为什么是「重新对齐服务端」、串行化、「乐观」那条断言怎么才证得了），9.39 记录详情面板与 e2e 指针事件的判断，9.40 记录 UI 集成的实施判断，**9.41 记录 T4-01 外壳的实施判断（内置静态服务 vs `file://`、`/api` 反代、CJS 与沙箱、Electron 无 postinstall 等），9.42 记录 T4-02 的实施判断，9.43 记录 T4-03 的实施判断（跨包 `import()` 加载源码、主进程复核、IPC 通道缺防线）**。 |
| `docs/PHASE-SUMMARY-2026-10-12.md` | **阶段性工作总结（换机检查点）**：总体进度、已完成 / 进行中 / 待办、文件与版本状态、换机衔接步骤、下一步 T4-02。**换机或新会话接手时先读本文，再读主文档。** |
| `docs/UI-INTEGRATION-2026-10-11.md` | **本次 UI 集成记录（最终态）**：18 项导航信息架构与分层路径、两批边界、改动文件清单、四个关键对接点、五项用户裁决、版本号的展示与更新方式、验证结果与实跑中修掉的六个渲染层问题。 |
| `docs/NEXT-TASK-PREP-阶段四-2026-10-11.md` | 阶段四开工准备（T4-01 开工清单；§八 为阶段三收口后的收尾更新）。**下一阶段执行前先读这份**。 |
| `docs/NEXT-TASKS-2026-10-12.md` | 下一步任务清单：**N-01（回填本文档）+ 阶段四主线 T4-01 ~ T4-04**，含优先级、先后顺序、预期产出与并行的长期线。 |
| `docs/T3-08-IMPLEMENTATION-PLAN.md` | T3-08 的施工图（含开工前的环境复位记录）。**任务已完成，此文档作为实施依据留档**。 |
| `docs/NEXT-TASK-PREP-2026-10-11.md` | 2026-10-11 的进度核对与开工清单（当时面向 T3-08）。**数字已过期，以本文为准**。 |
| `docs/IMPLEMENTATION-PLAN.md` | 实施层面的方案对照 |
| `docs/HANDOFF-2026-10-10.md` | 阶段一收口时的交接（当日成果、决策、未解决问题、逐文件清单、换机步骤 7.x） |
| `docs/HANDOFF-2026-10-11.md` | T3-04 当日补记 |
| `docs/PROGRESS-REVIEW-2026-10-11.md` | 任务进度盘点（完成 / 进行中 / 未开始、九条风险 R1~R9、下一步优先级）。**数字已过期，以本文为准** |
| `docs/SYNC-COMPARE-2026-10-11.md` | 工作空间与远端仓库逐项对比（含 `node_modules.old` 的完整分析，第十一节） |
| `docs/SYNC-AUDIT-*.md` | 仓库同步审计 |
| `docs/PROJECT-SURVEY-*.md` | 项目结构与依赖现状扫描 |
| `docs/WORKSPACE-BINDING.md` | 工作空间与远端仓库绑定登记、两条访问链路 |
| `infra/docs/PORTABLE-WORKSPACE.md` | 工作空间机制、入口、重定向、换机修复 |
| `projects/fanhe-work/README.md` | 项目说明、起步步骤、强制约定、迁移表、数据库与 Prisma 7 说明 |
| `.workbuddy-ai/memory/*.md` | 逐机环境事实与踩坑（ENVIRONMENT）、测试约定（TESTING）、界面令牌规格（UI-TOKENS） |

---

## 十一、本次（2026-10-11 ~ 10-12）工作留痕

| 时间 | 事项 | 结果 |
| -- | -- | -- |
| 上午 | T3-05 纪要模型与接口收口 | 5 迁移 / 10 表；八条接口；三包 219 项 |
| 下午 | T3-06 Markdown 编辑与预览 | 界面接通，路由补二级路径；三包 227 项；**e2e 首跑 78/78** |
| 下午 | T3-06 收尾归因 | 首轮 3 项失败 → 1 项真 bug（草稿同步死角，已修）+ 1 项断言过宽 + 1 项旧 `tsx watch` 残留 |
| 17:0x | T3-07 定方案前实测 | 一次性库验证 `tsvector` 与 `pg_trgm` 两条路均不可用，结论落 9.34 |
| 17:2x | T3-07 实施 | shared 63 + api 165 + web 10 = 238 项；e2e 新增 7 项 |
| 17:4x | T3-07 浏览器验证 | 首跑崩于主题菜单时序（与本次改动无关，已修 `openThemeMenu`）；换 `E2E_CDP_PORT=19222` 后 **85/85 全通过** |
| 17:5x | 提交推送 | `95bdcf2`（代码）+ `3c402fa`（文档），`main` 与 `dev` 同步；库回基线，端口释放 |
| 18:0x | 文档重写与存档 | `WORK-STATUS.md` 整体重写为十一节的单文件交接主文档并推送（`db7bc77`），`main` 与 `dev` 同步 |
| 20:0x | 换机后环境复位 | 工作区换机自愈（`root: F: → E:`、`host: DY008 → DY`）；修掉三处阻塞：`pnpm` 未 `corepack enable`、`node_modules` 软链接全部悬空（指向已不存在的 `F:`）、数据库落后一个迁移（只有 4 个且 `users` 为空，说明容器卷是**另一台机器的**）。另实跑门禁抓出 `WorkbenchPage.tsx` 的 `NavLink` 回调缺类型标注（TS7031），补成与 `Sidebar.tsx` 一致 → `4d43dae` |
| 20:5x | T3-08 实施 | 新增 `apps/web/src/lib/note-draft.ts` 与 13 项单测，`NoteEditor` 接三写（防抖 / 页面隐藏 / 卸载）三清（提交成功 / 丢弃 / 与库一致）+ `committedRef`；`apps/web` 的 `test` 脚本改为 `test/*.test.mjs`；三包 **251 项 0 失败** |
| 21:1x | T3-08 浏览器验证 | **首跑即 98/98 全通过**（原 85，新增 13），含「打完字立刻关掉页面也不丢」与「新建→提交→再点新建不带出旧内容」两条时序断言。途中踩到 Vite dev server 被批量删除保护挡住（同源坑，见 6.7） |
| 21:2x | 提交与收尾 | `fcfc7aa`（代码）+ 文档回填；库回基线、owner 重建、8787 / 5173 释放、无残留进程 |
| 21:2x | T3-09 实施 | `packages/shared/src/event.ts` 与 6 项单测；`schema.prisma` 加两个枚举与两个模型 + **第六个迁移 `20261011132819_add_events`**；`apps/api/src/event/events.ts` + `src/routes/events.ts` 八条路由 + 32 项集成测试；三包 **289 项 0 失败** |
| 21:3x | T3-09 收尾 | `d252107`（代码）+ 文档回填。**本轮未跑 e2e**（无界面改动）；库回基线（6 迁移 / 12 表、`users` 1、种子 11 / 4 / 29），owner 未动 |
| 21:5x | T3-10 实施 | 新增 `apps/web/src/components/events/` 四件 + `lib/event-display.ts` + `lib/events.ts` + 17 项单测；`lib/api.ts` 补六条传输函数；`TagInput` 增 `maxTags`；`WorkbenchPage` 加第三块板块、路由补 `events`。三包 **306 项 0 失败**；`lint` / `typecheck` / `format:check` 全绿 |
| 21:56 | T3-10 浏览器验证（首轮） | 116 项 **115 通过 / 1 失败**；唯一那条「低优先级也有文字」是**断言写错**（事件乙吃的是默认的「普通」而断言期望「低」），不是产品缺陷 |
| 22:0x | T3-10 浏览器验证（重跑） | 修掉那条断言（补一次「低」的点击），并加两条断言（编辑回填优先级的按下态、新建默认停「普通」）→ **118/118 全通过**，0 失败 |
| 22:0x | 提交与收尾 | `a7069de`（代码）+ 文档回填；库回基线（6 迁移 / 12 表、`users` 1、种子 11 / 4 / 29）、owner 第四次重建、8787 / 5173 释放、无残留进程 |
| 22:1x | T3-11 实施 | `lib/api.ts` 补 `setEventStatusRequest`、`lib/events.ts` 补 `setEventStatus`、`lib/event-display.ts` 增 `applyEventStatus` + 5 项单测；`EventRow` 勾选框接线（去掉 `disabled`、加 `locked` / `switching`）、`EventList` 透传并将组标题改用 `EVENT_STATUS_LABELS`、`EventsPanel` 增 `changeStatus` / `switching` / 撤销入口。三包 **311 项 0 失败**；`lint` / `typecheck` / `format:check` 全绿 |
| 22:1x | T3-11 浏览器验证 | e2e 段新增 17 项，**一次跑通 135/135 全通过**，无首轮失败。关键两条：给切换请求装 1.2 秒延迟钩子后断言「回话之前未完成组 2 → 1」；经接口删掉那条再点它的勾选框，断言界面「照样先勾上」（404 之后回滚） |
| 22:2x | 提交与收尾 | `a3c08bf`（代码）+ 文档回填；库回基线（6 迁移 / 12 表、`users` 1、种子 11 / 4 / 29）、owner 第五次重建、8787 / 5173 释放、无残留进程 |
| 22:3x | T3-12 实施 | `lib/api.ts` 补 `eventLogsRequest`、`lib/events.ts` 补 `loadEventLogs`、`lib/event-display.ts` 增 `EVENT_LOG_ACTION_LABELS` / `eventLogActionText` / `formatMoment` / `formatDuration` + 17 项单测；新增 `components/events/EventDetailDialog.tsx`；`EventRow` 标题由 `<span>` 改 `button` 作为详情入口、`EventList` 透传 `onOpenDetail`、`EventsPanel` 托管 `detailId` / `detailOpen`。三包 **328 项 0 失败**；`lint` / `typecheck` / `format:check` 全绿。**后端与共享包一行未改** |
| 22:4x | T3-12 浏览器验证（首轮） | e2e 段新增 11 项，146 项**两次在 T3-11 的乐观更新断言上超时**。诊断为 CDP 合成指针事件（`mouseMoved` / `mousePressed` / `mouseReleased`）**概率性整组丢失** —— 返回值正常但界面无响应，重跑即过 |
| 22:5x | T3-12 浏览器验证（修复后） | 改法是**按控件类型分两档**：Radix 下拉菜单仍走真实指针事件（依赖 hover 与指针捕获），**Radix Checkbox 与普通标题按钮改用 `element.click()`**（同步、无动画依赖）。随后 **146/146 连跑两次全通过**，0 失败 |
| 22:5x | 提交与收尾 | `a5370b0`（代码）+ 文档回填。**阶段三收口**；库回基线（6 迁移 / 12 表、`users` 1、种子 11 / 4 / 29）、owner 第六次重建、8787 / 5173 / 9222 释放、无残留进程 |
| 10-12 0x:xx | **UI 集成（第一批 · 骨架层）** | 导航结构、令牌层、侧栏、顶栏、内容区通栏按最终原型改造；业务逻辑一行未动 |
| 10-12 0x:5x | **UI 集成（第二批 · 首页三段式 + 导航重构）** | 导航扩为 **18 项 / 4 分组**（分层路径、纯折叠分组头、11 个预留槽位、页脚系统设置）；首页替换为三段式并保留三个子路由；头像菜单补齐五项 + **版本号**行；「运营信息平台」→「运维信息平台」 |
| 10-12 0x:xx | UI 集成门禁 | 四道门禁全绿：**350 项 0 失败**（shared 83 + api 197 含 5 跳过 + web 70）；`lint` / `typecheck` / `format:check` 通过 |
| 10-12 0x:xx | UI 集成浏览器验证 | e2e **149/149 全通过、一次跑通**；实跑中抓到并修掉六个渲染层问题（导航计数漏页脚项、顶层项文本含「开发中」、二级菜单靠 hover 展开、关闭判据要等父菜单、`openHomeSection` 误包进 `evaluate`、入场动画导致坐标漂移），修法见 8.2 与 `UI-INTEGRATION-2026-10-11.md` 第 7.3 节。库回基线（`pg_dump` 备份恢复） |
| 10-12 0x:xx | UI 集成提交推送 | `2576388`（代码）+ `fe92cb4`（文档回填）；`main` 与 `dev` 同步 |
| 10-12 0x:xx | 阶段四准备与任务梳理 | `b5c0e7f`（T4-01 开工准备清单）、`9502591`（下一步任务 N-01 与阶段四主线） |
| 10-12 0x:xx | **N-01 回填本文档** | 头部与 §0/§2.1/§2.3/§2.4/§3.2/§4.1/§4.4/§7/§8.2/§9/§10 同步至最终态：验证基线 328 → **350**、e2e 146 → **149**、导航口径统一为 **18 项**、`NavRail.tsx` → `Sidebar.tsx`、「三个占位导航项」→ **16 项**；`DEVELOPMENT-PLAN.md` 追加 9.40 |
| 10-12 0x:xx | **T4-01 实施（Electron 外壳脚手架）** | `apps/desktop` 从 `.gitkeep` 落成最小工程：`src/{main,preload,server}.ts` + `scripts/{ensure-electron,launch}.mjs` + `test/server.test.mjs`。主进程在回环上起内置静态服务托管 `apps/web/dist` 并把 `/api/*` 反代到服务地址（含 SPA 回退）；`apps/web` 一行未改。四道门禁全绿：**360 项 0 失败**（shared 83 + api 197 含 5 跳过 + web 70 + **desktop 10**） |
| 10-12 0x:xx | **T4-01 外壳冒烟验证** | `pnpm --filter @fanhe/desktop smoke`（受限环境加 `FANHE_NO_SANDBOX=1`）→ **PASS**：`渲染元素=1 标题=梵禾 Work 路径=/ 预加载桥=有 console错误=0`；另以活体 API 验证 `/api/health` 经反代返回 200 |
| 10-12 0x:xx | **T4-01 提交推送** | `b03ddb5`（代码，13 文件 +980/-8）；`main` 与 `dev` 同步 |
| 10-12 01:4x | **阶段性工作总结（换机检查点）** | 新增 `docs/PHASE-SUMMARY-2026-10-12.md`：总体进度 39/50（约 78%）、已完成 / 进行中 / 待办、文件与版本状态（四 ref 同点 `948b20c`）、换机衔接步骤、下一步 T4-02。核对仓库干净、门禁 360 项、四 ref 一致后落盘并登记入 §10 |
| 10-12 12:3x | **T4-02 实施（服务地址切换）** | 新增 `apps/desktop/src/config.ts`（服务地址读写，配置落工作区 `.config/fanhe-work/service.json`）+ `test/config.test.mjs`（18 项）+ `test/acceptance/t402-service-switch.mjs`（11 项）；`main.ts` 删掉 `SERVICE_URL` 常量改为 `registerServiceIpc()`；`preload.ts` 加 `getServiceStatus` / `setServiceUrl`。四道门禁全绿 **378 项 0 失败**（desktop 10 → 28）。提交 `f2bfc16` + `9963276` |
| 10-12 13:0x | **T4-03 实施（本机代理内置）** | 新增 `apps/desktop/src/{agent,paths}.ts`（主进程侧形态复核 + 跨包路径解析与 `import()` 加载 api 的 agent 源码）+ `test/agent.test.mjs`（17 项）+ `test/paths.test.mjs`（7 项）+ `test/acceptance/t403-shell-launch.mjs`（10 项）；`main.ts` 加 `registerLaunchIpc()`；`preload.ts` 加 `runLaunchProfile`；`package.json` 加 `@fanhe/shared` 依赖。**`apps/api/src/launch/agent.ts` 一行未改**。四道门禁全绿 **402 项 0 失败**（desktop 28 → 52） |
| 10-12 13:0x | **T4-03 验收与冒烟** | 验收脚本 10 项全通过（远程模式下真进程跑起来并写出标记文件、假上游零请求）；冒烟 PASS（`渲染元素=1 console错误=0`）。**期间修掉一个真 bug**：`import()` 收路径而非 URL 在 Windows 上抛 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，单测用假模块时看不出来 |

**§十一 新增/修改的关键文件（T4-01）**：`apps/desktop/package.json`（**新**，`@fanhe/desktop`，`productName: 梵禾 Work`，`main: dist/main.js`，`devDependencies.electron: 44.7.0`，脚本 build / typecheck / test / ensure-electron / start / dev / smoke）、`apps/desktop/tsconfig.json`（**新**，`module`/`moduleResolution: NodeNext`，**刻意不写 `"type": "module"` 以产出 CJS**）、`apps/desktop/src/server.ts`（**新**，内置静态服务：MIME 表、逐跳头与剥离头、`startStaticServer` / `serveStatic`（SPA 回退 + 405 + 越界 403）/ `sendFile`（哈希资源长缓存、index 不缓存）/ `proxyToService`（剥 `host`/`content-length`/`accept-encoding`））、`apps/desktop/src/main.ts`（**新**，主进程：`DIST_ROOT`、`SERVICE_URL`（`FANHE_SERVICE_URL`）、`IS_SMOKE`、`no-proxy-server`、`buildWindow`、`setWindowOpenHandler`/`will-navigate` 白名单、`runSmoke`）、`apps/desktop/src/preload.ts`（**新**，`contextBridge` 暴露 `fanheDesktop`）、`apps/desktop/scripts/ensure-electron.mjs`（**新**，幂等二进制自检）、`apps/desktop/scripts/launch.mjs`（**新**，摘 `ELECTRON_RUN_AS_NODE`、按 `FANHE_NO_SANDBOX` 决定是否 `--no-sandbox`）、`apps/desktop/test/server.test.mjs`（**新**，10 项）、`apps/desktop/.gitkeep`（删）；`pnpm-workspace.yaml`（`onlyBuiltDependencies: [electron]`）、根 `package.json`（加 `postinstall`）、`eslint.config.js`（`apps/desktop` 进 Node 全局块）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/web` / `apps/api` / `packages/shared` 本轮一行未改。**

**§十一 新增/修改的关键文件（UI 集成）**：`packages/shared/src/navigation.ts`（18 项 / 分组 / `slug` / `buildNavSections` / `navCodeFromPath` 重写）、`packages/shared/src/permissions.ts`（运维信息平台改名）、`packages/shared/test/navigation.test.mjs`（重写，32 项）；`apps/web/src/components/Sidebar.tsx`（重写）、`TopBar.tsx`（五项菜单 + 版本号行）、`AppShell.tsx`（外层 `relative`）、`components/home/{CaseGallery,LaunchSection,RecordSection}.tsx`（新）、`pages/HomePage.tsx`（新）、`pages/WorkbenchPage.tsx`（按地址分派）、`routes.tsx`（`routePath` + `MODULE_SUB_ROUTES`）、`lib/nav-icons.ts`（重写）、`lib/version.ts`（新）、`vite-env.d.ts`、`index.css`（hero 令牌族）、`vite.config.ts`（`define` 注入构建常量）、根 `package.json`（`0.0.0` → `0.1.0`）；`apps/web/test/e2e-auth.mjs`（新外壳同步 + `mouseMove` / `elementCenter` / `selectThemeOption` / `openHomeSection`）、`apps/web/test/version.test.mjs`（新，8 项）；`docs/{DEVELOPMENT-PLAN,WORK-STATUS,UI-INTEGRATION-2026-10-11}.md`。**业务逻辑（四个面板与 `lib/` 数据层）一行未改。**

**§十一 新增/修改的关键文件（T3-12）**：`apps/web/src/lib/api.ts`（增 `eventLogsRequest`）、`apps/web/src/lib/events.ts`（增 `loadEventLogs`）、`apps/web/src/lib/event-display.ts`（增动作码映射 / `formatMoment` / `formatDuration`）、`apps/web/src/components/events/EventDetailDialog.tsx`（**新**）、`apps/web/src/components/events/EventRow.tsx`（标题改可点按钮）、`apps/web/src/components/events/EventList.tsx`（透传 `onOpenDetail`）、`apps/web/src/components/events/EventsPanel.tsx`（`detailId` / `detailOpen` 与对话框挂载）、`apps/web/test/event-display.test.mjs`（增 17 项）、`apps/web/test/e2e-auth.mjs`（新增 T3-12 段 11 项 + 截图等待 Dialog 完成 + Checkbox / 标题按钮改 `element.click()`）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**后端与共享包本轮一行未改**，**行结构（除标题变成按钮）一行未改**。

**上一轮新增/修改的关键文件（T3-11）**：`apps/web/src/lib/api.ts`（增 `setEventStatusRequest`）、`apps/web/src/lib/events.ts`（增 `setEventStatus`）、`apps/web/src/lib/event-display.ts`（增 `applyEventStatus`）、`apps/web/src/components/events/EventRow.tsx`（勾选框接线 + `locked` / `switching`）、`apps/web/src/components/events/EventList.tsx`（透传 + 组标题改用常量）、`apps/web/src/components/events/EventsPanel.tsx`（`changeStatus` / `switching` / 撤销入口 / `Notice.undo`）、`apps/web/test/event-display.test.mjs`（增 5 项）、`apps/web/test/e2e-auth.mjs`（新增 T3-11 段 17 项 + `eventCheckboxFinder` + `installStatusDelay` + `apiEventFacts` / `apiDeleteEvent` + 组计数与撤销入口的取数表达式）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**后端与共享包本轮一行未改**，**行结构一行未改**。

**上一轮新增/修改的关键文件（T3-10）**：`apps/web/src/lib/event-display.ts`（新）、`apps/web/src/lib/events.ts`（新）、`apps/web/src/components/events/{EventsPanel,EventList,EventRow,EventFormDialog}.tsx`（四个皆新）、`apps/web/src/lib/api.ts`、`apps/web/src/components/notes/TagInput.tsx`、`apps/web/src/pages/WorkbenchPage.tsx`、`apps/web/src/routes.tsx`、`apps/web/test/event-display.test.mjs`（新）、`apps/web/test/e2e-auth.mjs`（新增事件段 20 项 + 两个接口辅助函数 + 重置语句补 `event_logs` / `events`）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**后端与共享包本轮一行未改**（T3-09 的八条接口够用）。

**上一轮新增/修改的关键文件（T3-09）**：`packages/shared/src/event.ts`（新）、`packages/shared/src/index.ts`、`packages/shared/test/event.test.mjs`（新）、`apps/api/prisma/schema.prisma`、`apps/api/prisma/migrations/20261011132819_add_events/`（新）、`apps/api/src/event/events.ts`（新）、`apps/api/src/routes/events.ts`（新）、`apps/api/src/app.ts`、`apps/api/test/event.test.ts`（新）、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。**`apps/web` 本轮一行未改。**

**上一轮新增/修改的关键文件（T3-08）**：`apps/web/src/lib/note-draft.ts`（新）、`apps/web/src/components/notes/{NoteEditor,NotesPanel}.tsx`、`apps/web/test/note-draft.test.mjs`（新）、`apps/web/test/e2e-auth.mjs`、`apps/web/package.json`、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。

**上一轮新增/修改的关键文件（T3-07）**：`packages/shared/src/note.ts`、`apps/api/src/note/notes.ts`、`apps/api/src/routes/notes.ts`、`apps/web/src/lib/api.ts`、`apps/web/src/components/notes/NotesPanel.tsx`、`apps/web/test/e2e-auth.mjs`（新增 `openThemeMenu` 与 `E2E_CDP_PORT`）、三个测试文件、`docs/{DEVELOPMENT-PLAN,WORK-STATUS}.md`。
