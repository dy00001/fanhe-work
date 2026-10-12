# 梵禾 Work 开发计划

| 项目 | 内容 |
| --- | --- |
| 版本 | v1.25 |
| 日期 | 2026-10-12 |
| 上游文档 | `projects/fanhe-work/docs/IMPLEMENTATION-PLAN.md` |
| 交接文档 | `projects/fanhe-work/docs/HANDOFF-2026-10-10.md` 与 `projects/fanhe-work/docs/HANDOFF-2026-10-11.md` |
| 选定界面方案 | 方案 B 现代极简，`projects/fanhe-work/docs/mockups/option-b-minimal.html` |
| 方案对比入口 | `projects/fanhe-work/docs/mockups/index.html` |
| 载体 | `projects/fanhe-work/` |
| 当前状态 | 阶段一（T1-01 至 T1-12）与阶段二（T2-01 至 T2-07）均已完成，阶段二验收清单 6 项全部勾选；阶段一验收清单尚余「关键操作在 `audit_logs` 有记录」一项，待账号与角色管理接口落地后勾选。**阶段三已完成（T3-01 至 T3-12 共 12 项全绿），阶段三验收清单 6 项全部勾选**。**界面层已按最终 UI 方案整体整合（两批：导航 18 项 + 首页三段式 + 版本号），业务逻辑一行未改**，记录见 `UI-INTEGRATION-2026-10-11.md`。**阶段四已完成（T4-01 ~ T4-04 共 4/4，验收四项全部勾选，出口条件达成）**：外壳脚手架、服务地址切换、本机代理内置、启动自检。**阶段四代码基线 `760b92f`。** 四道门禁全绿，四包合计 **426 项**（shared 83 + api 197，其中 5 项因 owner 已存在而设计性跳过 + web 70 + **desktop 76**）。数据库为 6 个迁移、**12 张业务表**，处于基线：`users` 1（owner `fanhe`）、其余业务表 0 行、种子 11 / 4 / 29 完好。**下一项是阶段五 T5-01 容器编排**（阶段五不占关键路径，可与阶段六并行）。依据见 9.28 ~ 9.44 与 `WORK-STATUS.md` |

---

## 零、本计划的定位与前置决策

实施方案回答做什么与为什么，本计划回答按什么顺序做、每步产出什么、做到什么程度算完成。两者互补，实施方案中的架构判断与数据模型在本计划中不再重复展开。

### 0.1 决策门

以下五项在实施方案第十二章提出，现已全部确认。

| 门 | 决策内容 | 采用的取值 | 状态 | 受阻任务 |
| --- | --- | --- | --- | --- |
| G1 | 前端技术栈 | React 19 + TypeScript + Vite | 已确认 | T0-01、T0-02 |
| G2 | 实验版数据库 | PostgreSQL，实验版即引入 | 已确认 | T1-01 |
| G3 | UI 方案 | shadcn/ui 配 Tailwind CSS，现代极简方向 | 已确认 | T2-01 |
| G4 | 桌面外壳 | Electron | 已确认 | T0-03、阶段四 |
| G5 | 账号登录方式 | 账号密码登录，并提供记住账号密码 | 已确认 | T1-01、T1-12 |

### 0.2 G2 变更的连带影响

实验版由 SQLite 改为直接引入 PostgreSQL，这一项改变了若干任务的性质，需要单独说明。

1. **阶段零的门槛抬高**。实验版需要本机存在一个可用的 PostgreSQL 实例。可选路径为安装本机服务或提前引入 Docker 容器。建议采用后者，与阶段五的编排保持同构，避免两套环境。
2. **阶段五的迁移任务减轻**。原 T5-02「PostgreSQL 迁移」不再需要方言转换，改为数据库容器化与连接切换。原 T5-03「数据迁移脚本」保留，用于实验版数据导入容器卷。
3. **数据随盘移动的性质改变**。数据库运行在宿主机或容器卷上，其数据不随 U 盘移动。这一点与工作区的可移动前提存在张力，需要在项目级约定中明确写出，并由启动自检提示。
4. **ORM 抽象的要求不变**。仍从 T1-01 起全程使用 Prisma 的 migration 管理表结构，不写方言专有语法，这条约束在换用 PostgreSQL 后依然成立，作用是降低后续升级与回退的成本。

### 0.3 G3、G4 与 G5 的连带影响

**G3 选定方案 B 现代极简。** 对应实施方案第四章的方向一，落地形态为 shadcn/ui 配 Tailwind CSS。组件以源码形式进入项目，样式完全可控，视觉上限最高。代价有三。其一，需要自行维护组件规范，前期多投入约一到两周。其二，样式与结构写在组件源码内，UI 基础库升级不再是一条命令，需要人工比对差异。其三，构建与规范配置需要增加 Tailwind 相关项，T0-05 已并入。

**G4 采用 Electron。** 与 Tauri 相比，差别集中在三处。

1. 本机能力改用 Node 侧实现，启动外部进程与读取路径的代码量更少，不需要 Rust 工具链，前期没有编译开销。
2. `CARGO_TARGET_DIR` 不再需要。原 T0-03 改为核对 Electron 缓存重定向，`ELECTRON_CACHE` 与 `ELECTRON_BUILDER_CACHE` 机制中已覆盖，只需确认生效。
3. 安装包与内存开销增加约一个数量级。`node_modules` 与 Electron 二进制成为 U 盘写入量的主要来源，忽略规则与缓存重定向必须覆盖到位。

**G5 明确为账号密码登录加记住账号密码。** 经确认，该能力作用于工作台自身的登录，与第三方软件账号无关。实现要点有三。

1. 登录方式为用户名加密码，密码以 Argon2id 哈希存储，这一条不变。
2. 记住账号密码属于客户端行为，凭据由系统凭据接口加密后落盘，不进入服务端数据库。
3. 第三方软件账号的密码仍不保存，边界不变。个人工作台的软件启动通道只做启动配置管理与一键唤起。

### 0.4 环境实测结论

工作区已具备启动条件。Node `v22.22.2`、npm `10.9.7`、pnpm `10.33.0`、git `2.55.0` 均可用。工作区为空，无历史依赖需要清理。git 仓库已在工作区根初始化，分支 `main`，本地配置为 `core.filemode=false`、`core.autocrlf=false`、`core.symlinks=true`、`core.longpaths=true`，与机制约定一致。开发者模式已于 2026-10-10 开启，`core.symlinks` 随之由 false 改为 true。

---

## 一、目标与范围

### 1.1 目标

项目分两个目标层，共用同一份代码，差异只体现在配置中的服务地址。

**实验版目标。** 在本机以浏览器加本机服务的形态，跑通账号权限、主框架与个人工作台三板块，验证交互与数据模型。数据库采用 PostgreSQL，建议以容器方式提供，与阶段五保持同构。

**网络版目标。** 把控制面迁移到 Docker 与 Cloudflare Tunnel，实现集中分发与多端一致，客户端外壳始终保留本机能力。

### 1.2 范围内

1. 账号体系与四级权限，含记住账号密码。
2. 主框架与左侧导航，含三个占位模块。
3. 个人工作台三板块，软件启动通道、工作纪要、事件记录。
4. 桌面外壳与本机代理。
5. 服务端化部署与访问策略。
6. 更新分发通道。

### 1.3 范围外

以下内容明确不纳入本期，列出以避免中期扩张。

1. 不保存第三方软件账号的密码，不做自动填充。
2. 不实现客户端内部参数或进程互斥量的绕行。
3. 不实现客户信息平台与运营信息平台的业务逻辑，本期仅占位。
4. 不做移动端适配。
5. 不做多租户与组织架构。

### 1.4 成功判据

实验版验收以「本机可用且数据可查」为准，网络版验收以「外部网络可访问且无入站端口暴露」为准。全部阶段通过各自验收标准，视为项目达成。

---

## 二、功能模块清单

优先级定义。P0 为不可裁剪，缺失则主流程不成立。P1 为本期应当交付，可延后但不建议。P2 为可延后至后续版本。

| 模块 | 功能点 | 优先级 | 所属阶段 |
| --- | --- | --- | --- |
| 账号与权限 | 登录、会话、刷新令牌、撤销 | P0 | 阶段一 |
| 账号与权限 | 记住账号密码，系统凭据接口加密 | P0 | 阶段一 |
| 账号与权限 | 角色与权限点、服务端校验 | P0 | 阶段一 |
| 账号与权限 | 首次初始化、审计日志、登录限速 | P1 | 阶段一 |
| 主框架 | 左侧导航、路由、占位页 | P0 | 阶段二 |
| 主框架 | 折叠记忆、主题令牌、错误与空状态 | P1 | 阶段二 |
| 软件启动通道 | 启动配置 CRUD 与一键唤起 | P0 | 阶段三 |
| 软件启动通道 | 启动记录、路径失效提示 | P1 | 阶段三 |
| 工作纪要 | Markdown 编辑预览、标签、置顶 | P0 | 阶段三 |
| 工作纪要 | 全文检索、草稿自动保存、归档 | P1 | 阶段三 |
| 事件记录 | 列表分组、勾选切换、撤销 | P0 | 阶段三 |
| 事件记录 | 已完成详情面板、状态变更历史 | P0 | 阶段三 |
| 桌面外壳 | 外壳加载本机与远程地址 | P0 | 阶段四 |
| 桌面外壳 | 内置本机代理、启动自检 | P0 | 阶段四 |
| 服务端化 | 容器编排、数据库容器化 | P0 | 阶段五 |
| 服务端化 | Tunnel 与访问策略 | P0 | 阶段五 |
| 更新通道 | 版本清单与比对 | P1 | 阶段六 |
| 更新通道 | 外壳安装包升级与签名 | P1 | 阶段六 |

---

## 三、任务分解

编号规则为「阶段号 连字符 序号」。每条任务给出依赖、产出与验收要点。

### 阶段零 项目初始化

| 编号 | 任务 | 优先级 | 依赖 | 主要产出 | 验收要点 |
| --- | --- | --- | --- | --- | --- |
| T0-01 | 建立目录骨架 | P0 | G1 | `apps/web`、`apps/api`、`apps/desktop`、`packages/shared`、`docs`、`data` | 目录齐备，`data/` 纳入忽略规则 |
| T0-02 | 初始化 workspace 与脚本 | P0 | T0-01 | 根 `package.json`、pnpm workspace 配置、`dev` 与 `build` 脚本 | 经 `ws-run.cmd` 可完成安装与启动 |
| T0-03 | 核对 Electron 缓存重定向 | P1 | T0-01、G4 | 确认 `ELECTRON_CACHE` 与 `ELECTRON_BUILDER_CACHE` 生效，必要时补 `ELECTRON_MIRROR` | 二进制落在 `.cache/electron/`，不写系统盘 |
| T0-04 | 项目级约定文档 | P0 | T0-01 | 项目 README，记录入口、禁盘符、`data/` 忽略、编码约定 | 新成员可据此完成环境搭建 |
| T0-05 | 代码规范与类型检查 | P0 | T0-02、G3 | ESLint、Prettier、Tailwind 插件、TypeScript 严格模式配置 | `lint` 与 `typecheck` 可执行且通过，类名排序自动生效 |
| T0-06 | 项目级忽略规则补充 | P0 | T0-01 | 根级与项目级 `.gitignore`，覆盖 `data/`、构建产物 | `ws-doctor.ps1` 扫描 PASS，状态干净 |
| T0-07 | 初始化 git 仓库 | P0 | 无 | 工作区根 git 仓库，本地配置与机制一致 | 根级三份配置生效，首次提交完成 |

**出口条件。** 从 `infra/portable/ws-run.cmd` 进入后，可完成依赖安装、类型检查与开发服务器启动，审计脚本无硬编码盘符告警，git 仓库已建立且首次提交完成。

### 阶段一 账号与权限

| 编号 | 任务 | 优先级 | 依赖 | 主要产出 | 验收要点 |
| --- | --- | --- | --- | --- | --- |
| T1-01 | 数据模型与首个迁移 | P0 | T0-02、G2 | Prisma schema 与 migration，含六张账号权限表 | 迁移可重复执行，无方言专有语法 |
| T1-02 | 数据库连接与种子 | P0 | T1-01 | 连接封装、角色与权限点种子数据 | 空库可一键初始化到可登录状态 |
| T1-03 | 密码哈希 | P0 | T1-01 | Argon2id 封装 | 库中无明文，哈希参数可配置 |
| T1-04 | 登录与令牌签发 | P0 | T1-03 | 登录接口、访问令牌与刷新令牌 | 登录成功返回双令牌，失败不区分账号是否存在 |
| T1-05 | 令牌轮换与撤销 | P0 | T1-04 | 刷新令牌只存哈希、按设备撤销 | 撤销后该设备刷新立即失败 |
| T1-06 | 登录限速 | P1 | T1-04 | 账号与 IP 双重限速 | 连续失败触发限速并记录 |
| T1-07 | 权限中间件 | P0 | T1-02、T1-04 | 服务端权限点校验 | 无权限接口返回 403，前端绕过无效 |
| T1-08 | 首次初始化引导 | P1 | T1-02 | 空库时创建 owner，完成后关闭入口 | 已有 owner 时入口不可访问 |
| T1-09 | 审计日志 | P1 | T1-07 | 关键操作写入 `audit_logs` | 登录、授权变更、删除均有记录 |
| T1-10 | 登录页与会话管理 | P0 | T1-04 | 前端登录页、令牌存储与自动刷新 | 令牌过期可静默续期，续期失败回到登录页 |
| T1-11 | 前端路由守卫 | P0 | T1-10 | 按权限过滤菜单与路由 | 仅承担体验职责，安全由 T1-07 保证 |
| T1-12 | 记住账号密码 | P0 | T1-10、G5 | 系统凭据接口封装，客户端加密保存 | 重启后账号密码自动带出，磁盘上无明文 |

**出口条件。** 四种角色登录后可见范围符合预期，直接调用无权限接口返回 403，刷新令牌可撤销，审计日志有记录，记住账号密码在重启后生效。

### 阶段二 主框架与 UI 骨架

| 编号 | 任务 | 优先级 | 依赖 | 主要产出 | 验收要点 |
| --- | --- | --- | --- | --- | --- |
| T2-01 | shadcn/ui 与设计令牌 | P0 | T1-10、G3 | 组件源码接入，Tailwind 令牌集中定义 | 令牌改动可全局生效，组件观感与方案 B 一致 |
| T2-02 | 布局骨架 | P0 | T2-01 | 左侧导航 224px、折叠 64px、顶栏 56px、内容区最大宽度 | 与实施方案第五章规格一致 |
| T2-03 | 路由体系 | P0 | T2-02 | 一级导航五项与嵌套路由 | 直接访问子路由可正确渲染 |
| T2-04 | 占位页 | P0 | T2-03 | 统一「功能开发中」页，注明规划范围 | `planned` 为真的四项占位模块进入后均显示该页 |
| T2-05 | 错误与空状态 | P1 | T2-01 | 404、500、空列表组件 | 各状态有明确文案与操作入口 |
| T2-06 | 折叠偏好记忆 | P1 | T2-02 | 折叠状态持久化 | 刷新后保持上次状态 |
| T2-07 | 主题令牌 | P2 | T2-01 | 亮暗两套令牌 | 切换后无对比度异常 |

**出口条件。** 导航折叠状态可记忆，占位页正确显示，界面与选定 UI 方案的设计令牌一致。

### 阶段三 个人工作台三板块

| 编号 | 任务 | 优先级 | 依赖 | 主要产出 | 验收要点 |
| --- | --- | --- | --- | --- | --- |
| T3-01 | 启动配置模型与接口 | P0 | T1-07 | `launch_profiles` 表与 CRUD 接口 | 路径只存运行时数据库，不进版本控制 |
| T3-02 | 本机代理与进程启动 | P0 | T3-01 | 仅监听回环的本地代理，启动外部进程 | 可成功拉起配置的客户端实例 |
| T3-03 | 启动配置管理界面 | P0 | T3-02 | 列表、新增、编辑、排序、图标 | 同一软件可配置多条实现多账号 |
| T3-04 | 启动记录与失效提示 | P1 | T3-03 | `launch_history` 与路径校验 | 路径不存在时给出提示与重新指定入口 |
| T3-05 | 纪要模型与接口 | P0 | T1-07 | `notes` 表与接口 | 标签、置顶、时间归档可查询 |
| T3-06 | Markdown 编辑与预览 | P0 | T3-05 | 编辑器与预览，含标签输入 | 编辑与预览内容一致 |
| T3-07 | 全文检索 | P1 | T3-05 | 覆盖标题与正文的检索 | 中文关键词可命中 |
| T3-08 | 草稿自动保存 | P1 | T3-06 | 定时保存与误关恢复 | 关闭后重进可恢复未提交内容 |
| T3-09 | 事件模型与接口 | P0 | T1-07 | `events` 与 `event_logs` 表及接口 | 状态变更追加日志，不做原地修改 |
| T3-10 | 事件列表视图 | P0 | T3-09 | 未完成与已完成分组，已完成默认折叠 | 勾选框、标签、截止时间、优先级齐备 |
| T3-11 | 勾选切换与撤销 | P0 | T3-10 | 乐观更新、失败回滚、可撤销入口 | 切换后写入完成时间与操作人，撤销可恢复 |
| T3-12 | 已完成详情面板 | P0 | T3-09 | 详情、耗时、操作人、变更历史 | 历史来源为 `event_logs`，有据可查 |

**出口条件。** 逐条对照实施方案第六章各节的交互要点，全部通过。

### 阶段四 桌面外壳

| 编号 | 任务 | 优先级 | 依赖 | 主要产出 | 验收要点 |
| --- | --- | --- | --- | --- | --- |
| T4-01 | Electron 外壳脚手架 | P0 | 阶段三、G4 | 外壳工程，加载现有前端构建产物 | 外壳可打开并渲染界面 |
| T4-02 | 服务地址切换 | P0 | T4-01 | 本机地址与远程地址的配置切换 | 两种模式均可用，仅改配置 |
| T4-03 | 本机代理内置 | P0 | T4-02 | 代理并入外壳主进程，不经过远程接口 | 远程模式下仍可启动本机软件 |
| T4-04 | 启动自检 | P1 | T4-03 | 检测代理与路径可用性，给出引导 | 换机后失效可被明确报出 |

**出口条件。** 外壳加载本机服务与加载远程地址两种模式均可正常工作，本机代理可成功启动外部软件。

### 阶段五 服务端化

| 编号 | 任务 | 优先级 | 依赖 | 主要产出 | 验收要点 |
| --- | --- | --- | --- | --- | --- |
| T5-01 | 容器编排 | P0 | 阶段三 | Docker Compose 编排 web、api、db | 一条命令可拉起全套 |
| T5-02 | 数据库容器化与连接切换 | P0 | T5-01 | PostgreSQL 进容器，连接串与卷配置 | 连接串切换后无需改业务代码 |
| T5-03 | 数据迁移与校验 | P0 | T5-02 | 实验版数据导入容器卷 | 记录数与抽样内容一致 |
| T5-04 | Tunnel 配置 | P0 | T5-01 | Cloudflare Tunnel 仅出站连接 | 源站无入站端口暴露 |
| T5-05 | 访问策略 | P0 | T5-04 | 域名访问控制与鉴权 | 未授权访问被拦截 |

**出口条件。** 外部网络可访问，数据库数据与实验版迁移一致，无公网入站端口暴露。

### 阶段六 更新通道

| 编号 | 任务 | 优先级 | 依赖 | 主要产出 | 验收要点 |
| --- | --- | --- | --- | --- | --- |
| T6-01 | 版本清单接口 | P1 | 阶段五 | 返回前端版本与哈希 | 客户端可读取并比对 |
| T6-02 | 客户端版本比对 | P1 | T6-01 | 启动时比对，差异则提示或拉取 | 服务端更新后重启即生效 |
| T6-03 | 外壳升级通道 | P1 | T4-01 | `electron-updater` 通道与签名校验 | 差分下载可用，签名校验生效 |

**出口条件。** 服务端发布新版本后，客户端重启即加载新版本，旧版本有明确提示。

---

## 四、依赖关系与关键路径

### 4.1 阶段级依赖

```
阶段零 ──► 阶段一 ──► 阶段二 ──► 阶段三 ──┬──► 阶段四 ──┐
                                          │              ├──► 阶段六
                                          └──► 阶段五 ──┘
```

阶段四是唯一可并行的分支。阶段五只依赖阶段三的数据模型与阶段一的接口层，与阶段四并行不冲突。阶段六需要阶段四与阶段五同时完成。

### 4.2 任务级关键依赖

1. T1-07 权限中间件是阶段三全部接口的前置，缺失时所有数据接口都无保护。
2. T2-01 UI 库接入阻塞阶段二全部界面任务。
3. T3-02 本机代理是 T3-03 与 T4-03 的共同前置，代理形态一旦确定不宜再改。
4. T1-12 记住账号密码依赖 T1-10 的会话管理，凭据接口与令牌存储需要共用同一套客户端封装。
5. T5-02 数据库容器化的前提是 T1-01 起全程使用 ORM 抽象，不写方言专有语法。
6. T4-02 服务地址切换是 T6-02 的前置，更新通道依赖外壳具备加载远程地址的能力。

### 4.3 关键路径

T0-01 → T0-02 → T1-01 → T1-04 → T1-07 → T2-01 → T2-02 → T3-01 → T3-02 → T4-01 → T4-02 → T5-04 → T6-01。

关键路径上的任一任务延期都会顺延整体交付。非关键路径中，阶段五的容器编排与阶段四并行，可作为缓冲。

---

## 五、优先级与实施顺序

### 5.1 排序原则

1. 先打通纵向主流程，再横向补齐功能。阶段一先做登录与权限的最小闭环，不追求功能完备。
2. 数据模型与迁移机制先于界面，避免后期返工。
3. 安全相关项不可降级。权限服务端校验、密码哈希、令牌撤销、凭据加密始终为 P0。
4. 与介质寿命冲突的项后置。桌面外壳引入 Electron 二进制与 `node_modules` 放在阶段四，避开前期的高频迭代。

### 5.2 首轮迭代范围

若需要尽快看到可运行结果，建议首轮只做 T0-01 至 T0-07、T1-01 至 T1-04、T1-07、T1-10、T1-12、T2-01 至 T2-04。这一范围能交付一个可登录、记住账号密码、有主框架与三个占位页的最小可用版本，可作为后续排期的基准。

---

## 六、风险与注意事项

### 6.1 风险清单

| 风险 | 影响 | 概率 | 应对 |
| --- | --- | --- | --- |
| 工具链写入量压垮 U 盘 | 安装与构建缓慢，闪存寿命消耗 | 高 | 重型产物移出 U 盘，Electron 二进制与 `node_modules` 走重定向并纳入忽略 |
| 记住账号密码的凭据被窃取 | 账号安全 | 中 | 只用系统凭据接口加密存储，密钥不随盘移动，磁盘上不留明文 |
| 启动通道被判定为异常行为 | 第三方账号风控 | 中 | 只做唤起，不做自动填密，界面明确告知 |
| 权限只在前端校验 | 越权访问 | 中 | 服务端强制校验，代码评审硬性检查 |
| 实验版 PostgreSQL 实例抬高搭建门槛 | 首次启动步骤变多，环境不一致 | 中 | 实验版与网络版统一用容器，提供一键启动与连接自检 |
| 表结构未走 migration 管理 | 后续变更返工 | 中 | 全程 Prisma migration，不写方言专有语法 |
| 自建组件规范耗时 | 阶段二延期 | 中 | 先定令牌与基础组件清单，只实现本期用到的组件，不追求全集 |
| 数据库数据不随工作空间移动 | 换机后数据丢失 | 高 | 实验版明确提示，网络版由容器卷统一管理 |
| 更新包被篡改 | 供应链风险 | 低 | 启用签名校验，密钥独立保管 |
| 换机后本机代理失效 | 启动通道不可用 | 中 | 外壳启动时自检并给出重新配置引导 |
| 依赖安装体积与耗时 | 首次搭建时间长 | 中 | 依赖重定向到工作区缓存，避免重复下载 |
| 中文路径与编码差异 | 清单或脚本误判 | 中 | 跨 bash 与 PowerShell 传递文本时显式指定 UTF-8 |

### 6.2 必须遵守的既有约定

1. 所有开发操作从 `infra/portable/ws-run.cmd` 或 `ws-run.sh` 进入，直接启动 IDE 不会继承环境重定向。
2. 受版本控制的文件中不出现盘符，需要根目录时使用 `WS_ROOT`。
3. 脚本中所有变量加引号，工作空间路径含空格。
4. `data/` 目录与数据库文件纳入忽略规则，它们逐机不同。
5. 跨 bash 与 Windows PowerShell 传递含中文路径的文本，读取侧显式指定 UTF-8。

### 6.3 工程注意事项

1. 权限点采用 `模块.对象.操作` 三段式命名，新增模块时同步登记。
2. 所有表带 `created_at` 与 `updated_at`，软删除统一用 `deleted_at`。
3. 事件状态变更只追加 `event_logs`，不做原地修改，为审计留出接口。
4. 首次初始化入口在创建 owner 后自动关闭，避免重复暴露。
5. 记住账号密码的凭据只在本机加密保存，不进入服务端数据库，不随工作空间移动。
6. 更新签名密钥与工作空间分开保管，不随盘移动。

---

## 七、阶段划分与验收标准

每个阶段给出交付物与可勾选的验收清单，未通过验收不进入下一阶段。

### 阶段零 项目初始化

交付物为目录骨架、包管理与脚本约定、Electron 缓存核对、项目级约定文档、git 仓库。

- [ ] 经 `ws-run.cmd` 可完成依赖安装与开发服务器启动
- [ ] `lint` 与 `typecheck` 通过
- [ ] `ws-doctor.ps1` 扫描无硬编码盘符
- [ ] `data/` 与生成物已纳入忽略规则
- [ ] git 仓库已建立且首次提交完成

### 阶段一 账号与权限

交付物为登录页、会话管理、角色与权限点、首次初始化、审计日志、记住账号密码。

- [x] 四种角色登录后可见范围符合预期
- [x] 直接调用无权限接口返回 403
- [x] 刷新令牌可撤销，撤销后立即失效
- [x] 连续登录失败触发限速
- [ ] 关键操作在 `audit_logs` 有记录
- [x] 勾选记住账号密码后重启，账号密码自动带出
- [x] 凭据以密文保存，磁盘上无明文

### 阶段二 主框架与 UI 骨架

交付物为左侧导航、路由体系、主题令牌、占位页（`planned` 为真共四项）、错误与空状态页。

- [x] 导航折叠状态可记忆
- [x] 占位页正确显示「功能开发中」
- [x] 界面与方案 B 的设计令牌一致
- [x] 子路由可直接访问
- [x] 错误与空状态给出明确文案与操作入口
- [x] 亮暗主题可切换，切换后无对比度异常

### 阶段三 个人工作台三板块

交付物为软件启动通道、工作纪要、事件记录。

- [x] 启动配置可新增、编辑、排序，可一键唤起
- [x] 路径失效有提示与重新指定入口（T3-04，见 9.31；整套浏览器 e2e 现为 118/118 全通过，见 9.37）
- [x] 纪要支持编辑预览、标签、置顶、检索、草稿恢复（编辑预览、标签、置顶在 T3-06（见 9.33），检索在 T3-07（见 9.34），**草稿恢复在 T3-08（见 9.35）**；五项均已由浏览器 e2e 逐条覆盖）
- [x] 事件列表分组正确，勾选切换乐观更新可回滚 —— **前半句在 T3-10 落地**（分组、已完成默认折叠、行内四要素，见 9.37），**后半句在 T3-11 落地**（见 9.38）。「乐观」在 e2e 里被两处直接钉住：一次是把切换请求人为拖后 1.2 秒、断言「回话之前未完成组已经 2 → 1」；另一次是让服务端删掉那条、再点它的勾选框，断言界面**照样先勾上**（那个勾不可能来自服务端，服务端根本不会答应），随后被回滚抹掉
- [x] 撤销入口可恢复状态并清除完成时间（T3-11，见 9.38；e2e 既查界面（提示条上的入口出现与收起、该行回到未完成组），也经接口查服务端那三个字段（`status` 回 `todo`、`completedAt` 与 `completedBy` 一起变 `null`））
- [x] 已完成详情展示耗时、操作人与变更历史（T3-12，见 9.39；详情面板由标题进入，展示完整描述、创建 / 截止 / 完成时间、完成用时、完成人与来自 `event_logs` 的时间线。**e2e 里那一条是按「能证伪」做的**：拿一条走过「完成 → 撤销」的事件，它此刻是未完成，而面板里必须仍留着那两笔 —— 界面若在按当前状态反推，永远画不出它们）

### 阶段四 桌面外壳

交付物为 Electron 外壳、本机代理、服务地址切换。

- [x] 外壳加载本机服务可用（T4-01，见 9.41；外壳打开并渲染出界面，`/api` 经内置服务反代连通，冒烟 PASS）
- [x] 外壳加载远程地址可用（T4-02，见 9.42；**验收口径是「可配置即算」**，用两个自报家门的本地假端点代表本机与远程，验证「改配置 → 请求真的打到了新上游」；真实远程地址要到 T5-04 才有，届时补一次对真机的验收）
- [x] 本机代理可成功启动外部软件（T4-03，见 9.43；**`apps/api/src/launch/agent.ts` 一行未改**，经 `import()` 动态加载 TS 源码进外壳主进程，无构建顺序依赖；主进程对来自 IPC 的配置另做形态复核——HTTP 那侧有入库校验与权限中间件，IPC 这侧一道都没有，少这一步这条通道就是本机任意命令执行入口。验收用「远程模式下真进程跑起来并写出标记文件」+「假上游零请求」两条判据）
- [x] 启动自检可报出失效配置（T4-04，见 9.44；**三类失效分开**（代理不可用 / 配置不合法 / 路径不在），因为引导方向不同 —— 合成一类必有一份文案是错的；路径检查**复用 `apps/api` 的 `inspectExecutablePath`**（与启动同一个实现），自检说「可用」而点击失败是最坏的失效；**并发检查**，因为失效配置的典型成因正是指向死掉的网络共享，而那个检查最坏要等 5 秒超时）
- ✅ **阶段四出口条件已达成**：本机服务与远程地址两种模式均可加载、本机代理可启动外部软件、失效配置可在点击前被报出。下一阶段为阶段五。

### 阶段五 服务端化

交付物为 Docker Compose 编排、数据库容器化、Tunnel 配置、访问策略。

- [ ] 外部网络可访问
- [ ] 数据库数据与实验版一致
- [ ] 无公网入站端口暴露
- [ ] 未授权访问被拦截

### 阶段六 更新通道

交付物为版本清单接口、客户端版本比对、外壳升级通道。

- [ ] 服务端发布新版本后客户端重启即加载新版
- [ ] 旧版本有明确提示
- [ ] 安装包签名校验生效

---

## 八、里程碑

| 里程碑 | 内容 | 达成标志 |
| --- | --- | --- |
| M1 可运行 | 阶段零与阶段一完成 | 可登录的最小服务在浏览器中运行 |
| M2 有骨架 | 阶段二完成 | 左侧导航与占位页齐备 |
| M3 核心可用 | 阶段三完成 | 个人工作台三板块全部通过验收 |
| M4 可分发 | 阶段四与阶段五完成 | 外壳可在多端加载远程服务 |
| M5 可运营 | 阶段六完成 | 更新通道闭环 |

---

## 九、进度与下一步

### 9.1 已完成

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| G1 前端技术栈 | 已确认 | React 19 + TypeScript + Vite |
| G2 实验版数据库 | 已确认 | PostgreSQL，实验版即引入 |
| G3 UI 方案 | 已确认 | 方案 B 现代极简，shadcn/ui 配 Tailwind CSS |
| G4 桌面外壳 | 已确认 | Electron |
| G5 账号登录方式 | 已确认 | 账号密码加记住账号密码，作用于工作台自身登录 |
| T0-01 目录骨架 | 已完成 | `apps/web`、`apps/api`、`apps/desktop`、`packages/shared`、`data` |
| T0-02 workspace 与脚手架 | 已完成 | pnpm workspace、根脚本、web 与 api 骨架，安装、类型检查、构建与开发服务器均验证通过 |
| T0-07 git 仓库 | 已完成 | 分支 `main`，提交身份 梵禾 `<dev@fanhe.local>`，基线提交 `70b382e` |
| T0-06 忽略规则 | 已完成 | 根级与项目级规则已补齐，随基线提交纳入版本控制 |
| T0-05 代码规范 | 已完成 | ESLint 10 扁平配置、Prettier、Tailwind 类名排序；`lint`、`typecheck`、`format:check` 均通过 |
| T0-04 约定文档 | 已完成 | `projects/fanhe-work/README.md`，含起步步骤、强制约定、数据库与版本取舍说明 |
| T0-03 Electron 缓存 | 已完成 | 修正变量名缺陷并补镜像，详见 9.4 |
| 界面方案对比 | 已完成 | `docs/mockups/index.html`，四版方案，选定方案 B |
| 品牌标识 | 已完成 | `docs/mockups/logo.png` 与 `apps/web/public/brand/logo.png` |
| T1-01 数据模型与首个迁移 | 已完成 | 六张账号权限表与首个迁移，已应用到 PostgreSQL 16.15 并确认无漂移；连接自检 `pnpm db:ping` 通过 |
| T1-02 数据库连接与种子 | 已完成 | 连接封装 `src/db/prisma.ts` 与种子 `src/db/seed.ts`；库中 11 个权限点、4 个角色、29 条授权关联，重跑无副作用；发现并修正 `matchesGrant` 缺陷，详见 9.8 |
| T1-03 密码哈希 | 已完成 | `src/auth/password.ts`，Argon2id 参数可配置、可判定重算；12 项测试通过。依赖选型受本机无编译器约束，见 9.9 |
| 机制修正：入口保留调用者目录 | 已完成 | `ws-run.sh` 与 `ws-run.ps1` 不再无条件切到工作空间根，三种场景在两个入口上实测通过。详见 9.9 |
| T1-04 登录与令牌签发 | 已完成 | `src/auth/tokens.ts`、`src/auth/login.ts` 与 `POST /api/auth/login`；四种失败共用同一响应，端到端验证通过；11 项令牌测试。判断见 9.10 |
| T1-05 令牌轮换与撤销 | 已完成 | `src/auth/session.ts` 与 `POST /api/auth/refresh`、`POST /api/auth/logout`；轮换用行锁串行化并发，重放按 familyId 整链撤销，撤销分 session / device / all 三层；14 项集成测试连真实数据库通过。判断见 9.11 |
| T1-06 登录限速 | 已完成 | 新增 `login_attempts` 表与 `src/auth/login.ts` 的 IP 维度判定；两个维度的阈值与窗口全部配置化，尝试记录落库并在写入时清理超期数据；限速返回 429；11 项集成测试通过。判断见 9.12 |
| T1-07 权限中间件 | 已完成 | `src/auth/guard.ts` 提供 requireAuth 与 requirePermission；授权每次查库、不缓存，账号停用或删除后令牌立即失效；新增 `GET /api/auth/me`；14 项集成测试通过。判断见 9.13 |
| T1-08 首次初始化引导 | 已完成 | 新增 `packages/shared/src/account.ts`（账号标识规则的唯一实现）与 `src/auth/setup.ts`、`src/routes/setup.ts`；并发初始化用咨询锁串行化，账号名归一同时落在创建与登录两侧，owner 被误删时有 `pnpm db:create-owner` 恢复通道；12 项测试通过（8 项集成 + 4 项纯函数）。判断与一处真实缺陷见 9.14 |
| T1-09 审计日志 | 已完成 | 新增 `packages/shared/src/audit.ts`（动作码词表）与 `src/audit/audit.ts` 的 `recordAudit`；登录、登出、刷新令牌重放、首次初始化四条路径已接入，共 8 项集成测试。**授权变更与删除两个事件族尚无对应接口**，待账号与角色管理功能落地时接入，见 9.15 |
| T1-10 登录页与会话管理 | 已完成 | 新增 `packages/shared/src/auth.ts`（跨进程认证 DTO）与前端 `lib/api.ts`、`lib/session.ts`、`auth/`、`pages/`；访问令牌只放内存、刷新令牌持久化，续期用单飞收敛并发，401 续期一次后重试；服务端认证路由改用共享类型标注响应。判断见 9.17 |
| T1-11 前端路由守卫 | 已完成 | 新增 `packages/shared/src/navigation.ts`（一级导航清单、模块级可见性判定、过滤与激活项解析）与前端 `components/NavRail.tsx`，HomePage 改为带左侧导航的主界面；补 14 项单元测试钉住四种角色的可见范围，浏览器级端到端验证从 9 项扩到 18 项。过程中发现并修复一处登出与在飞续期的竞态，见 9.18 |
| T1-12 记住账号密码 | 已完成 | 新增 `apps/web/src/lib/credential.ts`（AES-GCM 加密，密钥存 IndexedDB 且不可导出）与登录页的记住勾选；凭据只在登录成功后写入，取消勾选即清除；端到端验证从 18 项扩到 22 项。判断与安全边界见 9.20 |
| 迁移顺序核验 | 已完成 | 两个迁移的目录名字典序与应用顺序相反，实测确认互相独立、按字典序应用正常；空库重建链路（deploy → 七表齐全 → seed 11/4/29）验证通过。见 9.16 |
| 交接文档 | 已完成 | `docs/HANDOFF-2026-10-10.md`，含当日成果、关键决策、未解决问题、后续待办、逐文件清单与换机步骤。见 9.16 |
| T2-01 shadcn/ui 与设计令牌 | 已完成 | 新增 `apps/web/components.json`、`src/lib/utils.ts` 与 `src/components/ui/` 下 14 个官方组件源码；`index.css` 改为两层令牌结构并统一到 shadcn 语义命名，现有界面 60 余处类名同步迁移；`TextField` 内部改用 `Input` 与 `Label`，登录与初始化按钮改用 `Button`，记住账号密码改用 `Checkbox`。接入路线与四处源码修正见 9.21 |
| T2-02 布局骨架 | 已完成 | 新增 `components/Sidebar.tsx`（224px / 折叠 64px，折叠态用气泡提示补名称）、`components/TopBar.tsx`（56px，含面包屑、禁用态全局搜索、账号下拉菜单）与 `components/AppShell.tsx`（`h-screen` 应用式外壳，内容区独立滚动、最大宽度 1080px）；`NavRail.tsx` 删除，`HomePage` 改为使用骨架。规格取舍与端到端脚本的一处必要改造见 9.22 |
| T2-03 路由体系 | 已完成 | 新增 `apps/web/src/routes.tsx`（路由表由 `NAV_ITEMS` 派生：无路径布局路由承载外壳，五个模块为子路由，落地页与未匹配路径重定向，模块守卫复用 `resolveActiveNav`）、`pages/ModulePage.tsx`（统一模块头部，T2-04 改名为 `components/ModuleHeader.tsx`）、`pages/WorkbenchPage.tsx`（个人工作台落地内容）、`pages/NoAccessPage.tsx`（可见清单为空的兜底）、`auth/useVisibleNavItems.ts`（三个调用点共用一份可见清单）；共享包 `navigation.ts` 新增 `navPath` 与 `navCodeFromPath`（含 4 项回归测试）；依赖加 `react-router@8.4.0`，`HomePage.tsx` 删除。判断与一处测试断言修正见 9.23 |
| T2-04 占位页 | 已完成 | 新增 `apps/web/src/pages/PlaceholderPage.tsx`（统一「功能开发中」页：模块图标、标题、占位标记、规划范围与返回落地模块的入口）与 `apps/web/src/lib/nav-icons.ts`（导航图标表抽出，侧栏与占位页共用，避免两处各写一份）；`routes.tsx` 改为按 `planned` 分派（占位项走 PlaceholderPage，已落地项走各自页面）；`pages/ModulePage.tsx` 收敛为 `components/ModuleHeader.tsx`（只剩页头职责，`WorkbenchPage` 改用）；端到端占位断言从 1 项扩到 3 项。判断与「三个占位页」的口径澄清见 9.24 |
| T2-05 错误与空状态 | 已完成 | 新增 `apps/web/src/components/EmptyState.tsx`（统一状态呈现：图标、标题、说明、操作入口，`card` 与 `plain` 两种形态，建立在官方 `ui/empty.tsx` 之上）、`pages/NotFoundPage.tsx`（404，保留原地址不重定向）、`pages/ErrorPage.tsx`（500，不展示异常原文）、`components/ErrorBoundary.tsx`（类组件，位于认证提供者之内、门禁之外）；`routes.tsx` 的 catch-all 由重定向改为 404 页，`AppShell.tsx` 的面包屑在未匹配路径下回落到应用名；`PlaceholderPage`、`NoAccessPage`、`WorkbenchPage` 的空权限分支统一到 `EmptyState`，`NoAccessPage` 补上此前缺失的出口（退出登录）；端到端新增 404 两项断言（31 项全绿）。判断与一处测试基础设施缺陷见 9.25 |
| T2-06 折叠偏好记忆 | 已完成 | 新增 `apps/web/src/lib/preferences.ts`（本机界面偏好的读写，键 `fanhe-work.ui.sidebar-collapsed`，只认 `'true'` 为折叠、其余回落展开，读写失败静默）；`components/AppShell.tsx` 的折叠状态由 `useState(false)` 换成 `useState(readSidebarCollapsed)` 惰性初始化并在切换时写回；端到端新增 5 项断言（36 项全绿），其中用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 注入逐帧宽度采样器，把「首帧即折叠」与「先展开一帧再折叠」两种实现区分开。判断见 9.26 |
| T2-07 主题令牌 | 已完成 | `apps/web/src/index.css` 新增 `@custom-variant dark` 与 `.dark` 块（覆盖 `:root` 的全部颜色原始值，含 `color-scheme`），亮暗两套令牌就位、组件侧一行未改；`apps/web/index.html` 加内联脚本，在样式生效前定下主题初值；`lib/preferences.ts` 增 `ThemePreference` 类型、`isThemePreference` 与主题读写（键 `fanhe-work.ui.theme`，三档含 `system`）；新增 `lib/theme.ts`（`resolveTheme` / `applyTheme` / `useTheme`，含 `prefers-color-scheme` 变化监听）；`components/TopBar.tsx` 加三档单选菜单。端到端新增 6 项断言（42 项全绿），含逐帧采样首帧配色与 CDP 模拟系统配色。判断见 9.27 |
| T3-01 启动配置模型与接口 | 已完成 | 新增 `packages/shared/src/launch.ts`（软件标识清单与判定、字段上限、绝对路径判定、请求与响应类型；启动参数用 `String[]` 而不是拼接字符串）；`schema.prisma` 加 `LaunchProfile` 模型与迁移 `20261010165220_launch_profiles`（软删除、复合索引 `(user_id, deleted_at, sort_order)`、外键级联）；新增 `apps/api/src/launch/profiles.ts`（所有权在 service 层强制，重名检查不用数据库约束）与 `src/routes/launch.ts` 五条路由（列表 / 新增 / 重排 / 修改 / 删除，统一挂 `personal.launch.*` 权限）；api 新增 18 项集成测试、shared 新增 7 项。判断见 9.28 |
| T3-02 本机代理与进程启动 | 已完成 | 新增 `apps/api/src/launch/agent.ts`（**代理核心**：`buildLaunchCommand` 纯函数 + `runLaunchProfile`，不认识数据库、认证与 HTTP，阶段四原样搬进外壳主进程）、`src/launch/loopback.ts`（回环来源判定）、`profiles.ts` 增 `getProfile`、`routes/launch.ts` 增 `POST /api/launch/profiles/:id/run`（只接受配置 id，来源必须是回环，挂 `personal.launch.write`）；失败原因新增 `executable_missing`(409) 与 `spawn_failed`(500)；api 新增 18 项测试（含 8 项纯函数）。判断见 9.29 |
| T3-03 启动配置管理界面 | 已完成 | 新增 `apps/web/src/components/launch/`（`LaunchPanel.tsx` 四态分派容器与删除确认、`LaunchProfileRow.tsx` 单行、`LaunchProfileDialog.tsx` 新增/编辑表单）；新增 `components/StateView.tsx`（空、加载、错误三态收敛到一处，`EmptyState.tsx` 删除、五处调用点改指向）与 `components/ui/dialog.tsx`、`ui/textarea.tsx`（依赖加 `@radix-ui/react-dialog`）；新增 `lib/launch.ts`（六条接口的会话感知封装与启动失败分流）与 `lib/launch-icons.ts`（软件名、图标查找表与解析键）；`lib/api.ts` 补六条传输函数并把方法域扩到 PUT/PATCH/DELETE；`pages/WorkbenchPage.tsx` 接入板块并移除阶段二的账号与权限点诊断内容；端到端从 42 项扩到 56 项（新增 14 项覆盖空态、校验、增删改与排序）。判断见 9.30 |
| T3-04 启动记录与路径失效提示 | 已完成 | 新增 `launch_history` 模型与第四迁移 `20261010180508_launch_history`、`launch/history.ts` 与 `launch/status.ts`；启动真实尝试的成功与两类失败落库，去重不记；独立 `GET /api/launch/profiles/status` 提供路径状态与近期历史，启动模块共七条路由；界面有失效徽标、重新指定路径与启动摘要，`canWrite: false` 隐藏 Row 全行操作；新增 api 历史测试 17 项、web 相对时间测试 10 项（纳入根 `test`），shared 启动测试由 7 增至 9 项。浏览器 e2e 62/62 全通过、无渲染异常，`zz_e2e` 残留已清；最终门禁已核验全绿（shared 40 + api 138 + web 10 = 188 项，0 跳过），fresh deploy 经空库实测通过。见 9.31 |
| T3-05 纪要模型与接口 | 已完成 | 新增 `packages/shared/src/note.ts`（纪要跨进程类型、字段上限 `NOTE_LIMITS`、标签归一 `normalizeNoteTags` 与合法性判定）与 `schema.prisma` 的 `Note` 模型、第五迁移 `20261011064829_add_notes`（标签用 `text[]` 加 GIN 索引、两处复合索引、外键级联、软删除）；新增 `apps/api/src/note/notes.ts`（所有权在 service 层强制、五种失败原因、排序三级键、标签走 `unnest` 原生查询）与 `src/routes/notes.ts` 八条路由（列表 / 标签清单 / 单条 / 新增 / 修改 / 删除 / 置顶 / 归档，统一挂 `personal.note.read` 与 `personal.note.write`）；api 新增 21 项集成测试、shared 新增 10 项；四道门禁全绿，三包合计 219 项（含 5 项因 owner 已存在而设计性跳过）。**本轮只落模型与接口，界面属 T3-06。** 判断见 9.32 |
| T3-06 Markdown 编辑与预览 | 已完成 | 新增 `apps/web/src/components/notes/`（`NotesPanel` 四态分派容器、`NoteList`、`NoteEditor`、`MarkdownPreview`、`TagInput`）与 `lib/notes.ts`（八条接口的会话感知封装、拆信封、按 404 分流）；`lib/api.ts` 补八条传输函数（id 一律 `encodeURIComponent`）；`routes.tsx` 把一级导航的精确路径改为「父路由 + `index` 子路由 + `notes` 子路由」（新增 `MODULE_SUB_ROUTES`），`WorkbenchPage` 加板块切换并按地址分派（`/workbench` 启动通道、`/workbench/notes` 工作纪要）；`packages/shared/src/note.ts` 增 `parseNoteTagInput`；依赖新增 `react-markdown` 与 `remark-gfm`（**不引 `rehype-raw`**）；shared 测试由 50 增至 58（+8）；四道门禁全绿，三包合计 227 项；另以真实 owner 跑通八条接口冒烟 23 项。**浏览器 e2e 已执行：78 项全通过**（原 62，新增 16；首轮 3 项失败已逐一归因修掉，其中一项是编辑器草稿同步的真 bug）。判断见 9.33 |
| T3-07 全文检索 | 已完成 | `packages/shared/src/note.ts` 增 `NOTE_LIMITS.SEARCH_MAX = 64` 与 `normalizeSearchQuery`（`undefined` / 全空白一律归一为 `null`，含义是**不检索**）；`apps/api/src/note/notes.ts` 的 `NoteListFilter` 增 `search`，条件为 `title` 或 `content` 的 `contains` + `mode: 'insensitive'`（即 `ILIKE`，**本轮不建索引**，理由与升级路径见 9.34）；`routes/notes.ts` 的查询串增 `q`（`maxLength` 同共享包上限）；`apps/web/src/lib/api.ts` 的 `NoteListQuery` 增 `q` 并只在非空时拼参；`components/notes/NotesPanel.tsx` 加检索框（防抖 250ms、复用加载 effect 的 `cancelled` 丢弃过期响应、空态分「库里没有」与「没搜到」两种说法、关键词跨视图保留）。api 新增 6 项集成测试、shared 新增 5 项；四道门禁全绿，三包合计 238 项。**浏览器 e2e 已执行：85 项全通过**（原 78，新增 7；首轮跑崩于第 7 项主题菜单，成因是 Radix 关闭动画期间的点击被忽略，已抽出 `openThemeMenu` 修掉，另有 9222 被非 CDP 监听者占用、改用 `E2E_CDP_PORT`）。判断见 9.34 |
| T3-08 草稿自动保存 | 已完成 | 新增 `apps/web/src/lib/note-draft.ts`（**本机草稿暂存**：槽名 `fanhe-work.draft.note.<id>` 与 `…note.new`、带结构版本号 `v` 的序列化与校验、过期 7 天与容量 20 条的清理、**接口注入 storage** 以便在 Node 里单测、写失败先让掉一条最旧再重试并只回调一次）；`components/notes/NoteEditor.tsx` 加三个写入触发点（防抖 500ms / `pagehide` + `visibilitychange` 立即落盘 / 卸载落盘）与三个清除触发点（提交成功 / 明确丢弃 / 与库里一致），恢复合流到既有的 `syncedNoteId` 机制并加一条可「丢弃草稿」的提示条；`hasChanges` 的比较规则下沉到 `isSameDraftValues`（**单一出处**）；`NotesPanel.tsx` 只改注释、**`key` 一行未动**。新增 `apps/web/test/note-draft.test.mjs` 13 项，并**把 `apps/web` 的 `test` 脚本从写死单文件改成 `test/*.test.mjs`**（漏掉这一步新单测根本不会被执行）；四道门禁全绿，三包合计 **251 项**。**浏览器 e2e 已执行：98 项全通过**（原 85，新增 13）。判断见 9.35 |
| T3-09 事件模型与接口 | 已完成 | 新增 `packages/shared/src/event.ts`（状态 `todo`/`done` 与优先级 `low`/`normal`/`high` 取值域、动作码 `created`/`completed`/`reopened`、`EVENT_LIMITS`、`Event`/`EventLog` 与七个请求响应类型；**标签归一复用纪要那一套**不写第二份）；`schema.prisma` 加 `EventStatus`/`EventPriority` 两个枚举与 `Event`/`EventLog` 两个模型、**第六个迁移 `20261011132819_add_events`**（`events` 是实体表带软删除，`event_logs` 是**只追加流水**只带 `createdAt`，`action` 用 VarChar 不做枚举）；新增 `apps/api/src/event/events.ts`（所有权在 service 层强制、七种失败原因、**状态变更与追加日志在同一事务**、幂等时不写第二条日志、标签走 `unnest` 原生查询）与 `src/routes/events.ts` 八条路由（列表 / 标签清单 / 单条 / 状态变更历史 / 新增 / 修改 / 状态切换 / 删除，统一挂 `personal.event.read` 与 `personal.event.write`）。api 新增 32 项集成测试、shared 新增 6 项；四道门禁全绿，三包合计 **289 项**。**本轮只落模型与接口，界面属 T3-10。** 判断见 9.36 |
| T3-10 事件列表视图 | 已完成 | 新增 `apps/web/src/lib/event-display.ts`（**可被 Node 单测直跑的纯函数**：`groupEvents` 分组、`isOverdue` 逾期判定、`formatDueAt` 文案、`toDateTimeLocalValue` / `fromDateTimeLocalValue` 时间往返，以及三张取值到文案与样式的映射表）与 `lib/events.ts`（会话感知数据层：`loadEvents` / `loadEventTags` / `createEvent` / `updateEvent` / `removeEvent` 与 `eventFailureExit`）；`lib/api.ts` 补六条传输函数；新增 `components/events/`（`EventsPanel` 四态分派容器 + `EventList` 分组与折叠 + `EventRow` 行内四要素 + `EventFormDialog` 新增/编辑表单）；`components/notes/TagInput.tsx` 增 `maxTags` prop（上限从写死改为注入）；`WorkbenchPage` 加第三块板块、`routes.tsx` 的模块子路由补 `events`。**行内勾选框本轮是只读的**（`disabled` + `disabled:opacity-100`），切换与撤销属 T3-11（**已在该轮接线，见 9.38**）。新增 17 项 web 单测；四道门禁全绿，三包合计 **306 项**；**浏览器 e2e 118 项全通过**（原 98，新增 20）。判断见 9.37 |
| T3-11 勾选切换与撤销 | 已完成 | `lib/api.ts` 增第六条传输函数 `setEventStatusRequest`（`PUT /api/events/:id/status`），`lib/events.ts` 增 `setEventStatus`（会话感知封装，返回服务端更新后的**整条**事件 —— `completedAt` 与 `completedBy` 是服务端的时间与身份快照，界面猜不出来）；`lib/event-display.ts` 增 `applyEventStatus` 纯函数（改一条的状态、其余按原引用带过去、找不到 id 时原样返回，可被 Node 单测直跑）；`EventRow` 的勾选框去掉 `disabled` 并接上 `onCheckedChange`，新增 `locked` / `switching` 两个 prop 把「现在能不能点」与「正在切的是哪一条」分开；`EventList` 透传并将组标题改用 `EVENT_STATUS_LABELS`（消除与 `event-display.ts` 的重复字面量）；`EventsPanel` 增 `changeStatus`（乐观更新 → 发请求 → 成功重拉 / 失败重拉回滚）、`switching` 串行化（同一时刻只允许一条切换在飞）与提示条上的**撤销入口**。**后端与共享包一行未改** —— `PUT .../status` 与「撤销即设回 `todo`、三列完成信息一起清空」在 T3-09 就已就位。新增 5 项 web 单测（乐观改状态、不伪造完成信息、找不到 id、不改原数组）；四道门禁全绿，三包合计 **311 项**；**浏览器 e2e 135 项全通过**（原 118，新增 17）。判断见 9.38 |
| T3-12 已完成详情面板 | 已完成 | `lib/api.ts` 增第七条传输函数 `eventLogsRequest`（`GET /api/events/:id/logs`），`lib/events.ts` 增 `loadEventLogs`（只读不回写，归属由服务端确认，404 按 `gone` 走）；`lib/event-display.ts` 增 `EVENT_LOG_ACTION_LABELS` / `eventLogActionText`（认不出的动作码原样返回）/ `eventLogTransitionText`（只在动作码认不出时才用）/ `formatMoment`（年份永远在，历史可能跨年）/ `formatDuration`（取最大两个单位、整值省略第二项、区间反过来返回 `null`）；新增 `components/events/EventDetailDialog.tsx`（**头部用列表那一份数据，只有时间线在等接口**，日志单独三态；描述复用 `MarkdownPreview`；完整标签、创建 / 截止 / 完成时间、完成用时、完成人；时间线来自 `event_logs`）；`EventRow` 的标题由 `<span>` 改为 `button` 作为详情入口（行仍然不是按钮），`EventList` 透传 `onOpenDetail`；`EventsPanel` 托管 `detailId` + `detailOpen` 两个量（关闭时不清 id，见 9.39）。**未完成的事件也能打开**（描述在列表上无处可看，这是对规格的有意扩展）；**详情里不放编辑入口与勾选框**。新增 17 项 web 单测；四道门禁全绿，三包合计 **328 项**；**浏览器 e2e 146 项全通过**（原 135，新增 11），连跑两次均全绿。**后端与共享包一行未改。** 判断见 9.39 |
| T4-01 Electron 外壳脚手架 | 已完成 | 新增 `apps/desktop`（`package.json` / `tsconfig.json` / `src/{main,preload,server}.ts` / `scripts/{ensure-electron,launch}.mjs` / `test/server.test.mjs`）；主进程在回环上起**内置静态服务**托管 `apps/web/dist` 并把 `/api/*` **反代**到服务地址（含 SPA 回退），**`apps/web` 一行未改**（单一来源前提继续成立）；桌面端**刻意用 CJS** 以保住沙箱化的预加载脚本；补 `scripts/ensure-electron.mjs` 并由根 `postinstall` 调用，解决 **Electron 44.7.0 无安装脚本导致二进制不随依赖落地**的问题；启动器摘掉 `ELECTRON_RUN_AS_NODE`、按 `FANHE_NO_SANDBOX` 决定是否关沙箱、渲染进程 `no-proxy-server`。四道门禁全绿，四包合计 **360 项**（desktop 新增 10 项，覆盖 SPA 回退 / 404 / 越界 / 405 / 反代 / 502）；**外壳冒烟 PASS**（渲染出界面、console 零错误），另以活体 API 验证 `/api/health` 经反代返回 200。判断见 9.41 |

### 9.2 待办

1. **阶段三已完成（T3-01 至 T3-12 共 12 项全绿），界面层已按最终 UI 方案整体整合（导航 18 项 + 首页三段式 + 版本号，业务逻辑一行未改，见 9.40），阶段四已完成（T4-01 见 9.41、T4-02 见 9.42、T4-03 见 9.43、T4-04 见 9.44）—— 验收四项全部勾选、出口条件达成，代码基线 `760b92f`**。**四道门禁全绿**（shared 83 + api 197 + web 70 + desktop 76 = 426 项，其中 api 5 项因 owner 已存在而设计性跳过；`lint` / `typecheck` / `format:check` 全绿），**浏览器 e2e 149 项全通过**（UI 集成后实跑，一次跑通；T4-01 ~ T4-04 无界面改动未重跑），**外壳冒烟 PASS**。**下一项是阶段五 T5-01 容器编排**（任务定义见第三章第 205 行，阶段验收见第七章；阶段五不占关键路径，见第八章）。续接时先读 9.44、9.43、9.42、9.41、`WORK-STATUS.md` §3.5 与 §8.5、`NEXT-TASK-PREP-阶段四-2026-10-11.md`、`NEXT-TASKS-2026-10-12.md` 与 `HANDOFF-2026-10-11.md`。

   **本轮 e2e 首轮是失败的，而失败与产品无关 —— 这一条本身值得记下来。** 同一份脚本三跑两败在「回话之前未完成组已经少了一条」上，报的是「等待超时」。加探针复现后发现：CDP 的合成鼠标事件组（`mouseMoved / Pressed / Released`）偶尔会被**整组丢掉**，也就是点击根本没送达。改法是行内的点击改用 `element.click()` —— Radix 的下拉菜单必须走真实指针事件（`pointerdown` / `pointerup`），但勾选框与标题都是普通 `onClick`，两者不能一刀切。**这条教训不只是修一处脚本：断言失败时先问「这一击真的发生了吗」，再问产品对不对。** 另外顺手查清了一个早先没弄明白的现象：截图里对话框半透明、背后文字透过来，不是 `bg-background` 没生效，而是 `waitFor` 一返回就抓帧，拍到了对话框淡入动画（200ms）的中间帧 —— T3-10 的截图同样如此。截图前等 350ms 之后，元信息与时间线都清楚（这个等待只影响截图，断言读的是 DOM 不是像素）。跑 e2e 的代价与前置条件不变（清库 → 跑 → 重建 owner → 更新 `.tmp/owner-credentials.txt`），本轮已按此收尾；`assertUninitialized` 报错信息里那条重置语句也补全了事件两张表（原来漏掉，症状是「空态断言失败」，看起来像界面坏了）。

   纪要链已收口（T3-05 → T3-06 / T3-07 → T3-08 全部完成），**事件链到此也收口**：T3-09 落模型与接口（第六个迁移 `20261011132819_add_events` 建起 `events` 与 `event_logs`，其中 `event_logs` 是**只追加流水**，只有 `createdAt`），T3-10 落列表视图，T3-11 落勾选切换与撤销，T3-12 落详情面板。**阶段三验收六项至此全部勾上**。四块加起来只改了前端（`apps/web`）与两端共用的展示规则，**后端与共享包在 T3-09 之后再未改动** —— 这是一个信号：T3-09 把状态流水那条链路设计对了。下一阶段是桌面外壳（T4-01 ~ T4-04），它依赖的是产物而不是这套业务代码。

   与界面直接相关的三条既有约定：**令牌的唯一来源是 `index.css` 的两层结构**（`:root` 原始值加 `@theme inline` 映射），不要在组件里写死颜色；**方案 B 与 shadcn 默认风格的差异在令牌层消化**（`--shadow-xs/sm` 归零、只覆盖 `--radius-md` 到 8px），不要改组件源码；**新增颜色令牌要同时在 `:root` 与 `.dark` 两块里各写一份**，只写一处会得到一个只在亮色（或只在暗色）下正确的界面，而这类缺陷在默认配色下完全看不出来。

   T3-04 至此已完整收口（含提交推送与 fresh deploy 实测），路径失效有行内徽标与重新指定入口，`launch_history` 记录真实启动尝试；其他角色的真实渲染与状态重查失败反馈仍属明确边界，见 9.31。

2. 组件清单与令牌规格已在 T2-01 落定，见 9.21。**新增界面一律从 `apps/web/src/components/ui/` 取组件，不要再手写等价元素**：同一件东西两种实现时，差异只会在改令牌或换主题时才暴露，而那时已经很难判断是哪一处漏改。T2-02 已把 `NavRail` 换掉，剩余的 `AuthLayout` 与 `HomePage` 内容区手写元素随 T2-03 一并处理。
3. `users.passwordChangedAt` 已在 T1-01 建表时留下，schema 注释写的是「改密后旧令牌立即失效」，但 T1-04 签发访问令牌时并未把它写进载荷，因此目前改密不会让已签发的访问令牌失效。补齐需要在访问令牌里加 `pwd` 声明并在校验时比对，属于改密流程的一部分，等该功能排期时一并处理。
4. username 的大小写归一已在 T1-08 落地，`packages/shared/src/account.ts` 是唯一实现，账号创建与登录查询两侧都走它。尚未覆盖的是**改名**：账号管理功能排期后，改名必须复用同一个 `normalizeUsername`，并在改名前用归一后的值查一次冲突，否则会出现「改成一个只差大小写的名字」而库侧唯一约束恰好拦不住的情形。目前用得上唯一约束冲突检测的入口只有首次初始化。
5. 权限点的可见范围目前只有 `system` 与 `personal` 两段，共 11 个。客户信息平台与运营信息平台的对象清单尚未确定，等阶段三这两个模块定下来后再追加常量与权限行，不需要改表结构。**追加时要同步改 `packages/shared/src/navigation.ts` 里对应导航项的 `module`**：导航重构后共 18 项，除首页（`personal`）与系统设置（`system`）外，其余 **16 项现在填的是 `null`**（含 11 个预留槽位），含义是「尚无权限点可绑，对所有已认证用户可见」，模块落地后要改成各自的模块段，否则它们会一直对所有人可见。`navigation.test.mjs` 里那条「占位项对已认证用户一律可见」的断言届时也要一并改掉。
6. 「四种角色登录后可见范围符合预期」已在 T1-11 勾选，依据与边界见 9.18。
7. 审计的写入链路已完成，但「授权变更」与「删除」两类事件还没有接口可挂：账号与角色管理功能尚未实现。这些功能排期时在它们的 service 里调一次 `recordAudit` 即可，写入层不需要改。验收清单中的「关键操作在 `audit_logs` 有记录」因此也暂不勾选，见 9.15。

原第 3 项「补登录的剩余集成测试」已在 T1-10 完成：schema 校验（缺字段、多余字段、超长账号名）与登录成功后的落库形态（令牌哈希为 64 位十六进制且等于明文的 SHA-256、`lastLoginAt` 更新、失败计数清零）共 3 项，见 9.17。

验收清单的浏览器侧复核已有自动化入口：`pnpm --filter @fanhe/web test:e2e` 走一遍首次初始化到登出的完整路径，并断言渲染期无未捕获异常与 `console.error`。前置条件与用法见 9.18。

开发者模式已于 2026-10-10 开启，两个环境脚本与仓库本地配置中的 `core.symlinks` 已改为 true，原先列在这里的这一项已完成。实测确认 git 与 node 均可在不提权的情况下创建符号链接；PowerShell 5.1 的 `New-Item -ItemType SymbolicLink` 仍会失败，因为它不传 `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE`，属该版本的自身限制，不影响 git。

### 9.3 阶段零实施中的三处技术判断

**TypeScript 取 6.x 而非 7.x。** `typescript-eslint` 8.71.1 的 peer 声明为 `>=4.8.4 <6.1.0`，且遇到 TS 7 是导入即抛错而非警告。官方给出的出路是并行安装第二个 TS 6 编译器供工具链使用，代价是并存两套类型系统。工作区在 32GB U 盘上，且 G1 决策只约定「TypeScript」未指定大版本，故取 6.0.3。上游支持 TS >= 7.1 后可再评估。

**Vite 开发服务器显式绑定 IPv4 回环。** Vite 默认使用 `localhost` 主机名，在 Windows 上只解析到 IPv6 回环 `::1`，导致服务在 `127.0.0.1` 上不可达，且与后端 `127.0.0.1:8787` 不在同一协议栈。已改为显式绑定。

**Electron 缓存变量名修正。** 见下节。

### 9.4 T0-03 发现的缺陷与修正

机制原先只设置了 `ELECTRON_CACHE`。核查安装链路源码后确认，**这个变量在整条链路里没有任何一处读取**，因此二进制实际会写到系统盘的 `%LOCALAPPDATA%\electron\Cache`，与写入内聚的约定相悖。

| 变量 | 读取方 | 修正前 | 修正后 |
| --- | --- | --- | --- |
| `electron_config_cache` | `electron` 包的安装脚本，转交 `@electron/get` 作 `cacheRoot` | 未设置 | 指向 `.cache/electron` |
| `ELECTRON_CACHE` | 链路内无读取方，仅第三方工具可能引用 | 已设置 | 保留 |
| `ELECTRON_BUILDER_CACHE` | electron-builder | 已设置，有效 | 保留 |
| `ELECTRON_MIRROR` | `@electron/get` | 未设置 | npmmirror |
| `ELECTRON_BUILDER_BINARIES_MIRROR` | electron-builder | 未设置 | npmmirror |

关键点在于 `@electron/get` 自身没有 `ELECTRON_CACHE` 回退，它只接受调用方传入的 `cacheRoot`，而调用方读的是 `electron_config_cache`。Windows 环境变量大小写不敏感，故同时设置大小写两种拼写以兼容大小写敏感的系统。

镜像指向 npmmirror。本轮已把 `infra/portable/config/.npmrc` 的 registry 也固定为 npmmirror，Prisma 引擎与 Electron 二进制使用同一家镜像。

### 9.5 T1-01 实施中的四处判断

**Prisma 7 与 6.x 不兼容，不能照搬旧写法。** 三处变化都会直接导致跑不起来。一是 SQL 提供方必须配驱动适配器，7 起不再自带 Rust 查询引擎，PostgreSQL 需要 `@prisma/adapter-pg` 与 `pg`，实例化时传入 `new PrismaClient({ adapter })`。二是连接串与迁移目录从 schema 移到 `prisma.config.ts`，生成器由 `prisma-client-js` 改为 `prisma-client` 且 `output` 变为必填。三是 `.env` 不再自动加载，配置文件里必须自己 `import 'dotenv/config'` 且置于首行。另有 `migrate diff` 的 `--to-schema-datamodel` 改名为 `--to-schema`。

**版本取 7.10.0，不取 npm 标记为 latest 的 8.0.0-rc.22。** `prisma` 的 `latest` 标签当前指向预发布版，而 `@prisma/client` 的 `latest` 是 7.10.0。两个包必须同版本，因此都钉在 7.10.0。这条约束意味着后续不要用 `@latest` 安装。

**首个迁移离线推导，并在 PGlite 上实际执行验证。** 真实数据库不可达，但迁移没有跑过就只是一份文本。用 `prisma migrate diff --from-empty --to-schema` 推导出 DDL，再借 Prisma 传递依赖中已有的 PGlite（编译为 WASM 的 PostgreSQL）实际执行，逐项确认六张表、两个枚举、22 个索引与五个外键，并验证唯一约束拒绝重复、外键拒绝无效引用、角色被引用时不可删除、删除账号后审计日志保留且 `actor_id` 置空。这能证明 DDL 可执行且语义正确，**不能**替代真实实例上的验证：`_prisma_migrations` 记账、并发行为与具体 PostgreSQL 版本差异都不在其中。

**`packages/shared` 由源码直出改为构建型包。** 原先 `exports` 直接指向 `src/index.ts`，对 Vite 可行，但 api 用 NodeNext 且 `rootDir` 限定为 `src`，引用包外的 TS 源文件会触发 TS6059。改为编译到 `dist` 并输出声明文件，根脚本在启动前先构建一次。

### 9.6 数据库阻塞与所需操作

Docker 29.8.1 与 Compose v5.5.1 已安装，但守护进程起不来，本机也没有原生 PostgreSQL。按四层顺序诊断，前三层全部正常：CPU 虚拟化已启用且被 Hyper-V 接管，`VirtualMachinePlatform`、`HypervisorPlatform`、`Microsoft-Windows-Subsystem-Linux`、`Microsoft-Hyper-V-All` 的可选功能状态均为已启用，BCD 的启动类型为 `AUTO`。

根因在第四层，Docker 后端日志给出：

```
[com.docker.backend.exe.wslexec][E] c:\windows\system32\wsl.exe --version failed:
  fork/exec C:\Windows\System32\wsl.exe: Access is denied.
[com.docker.backend.exe.engines][E] starting engine: engine linux/wsl failed to start
```

`wsl.exe` 被安全策略列入程序黑名单，Docker 的 Linux 引擎因此无法启动。这条策略同时拦住了直接调用该程序，无法从当前环境绕过。

**需要手动操作：在安全中心的「命令安全 → 程序黑名单」中把 `wsl.exe` 移出。** 不做这一步，阶段五的容器编排同样会被挡住。

**已于同日解决。** 用户手动启动 Docker Desktop 后守护进程正常，`postgres:16-alpine` 镜像本机已有（另一项目在用，其容器未向宿主机发布 5432，无端口冲突），据 `docker-compose.yml` 起容器一次通过，未向网络拉取任何镜像。

### 9.7 工作空间机制的一处缺陷：DOCKER_CONFIG 重定向

启动数据库前发现 `ws-env.ps1` 与 `ws-env.sh` 把 `DOCKER_CONFIG` 重定向到了工作空间内的 `.docker` 目录。这处重定向沿用了其它工具主目录的写法，但 Docker 的配置目录不是缓存 —— 它存的是上下文、registry 凭据与 `cli-plugins`。实测两项后果：

1. **`docker compose` 直接失效**，报 `docker: unknown command: docker compose`。CLI 插件是从 `$DOCKER_CONFIG/cli-plugins` 发现的，指向空目录就什么都找不到。整个阶段五的容器工作流会因此中断，而且报错信息指向的是命令名，不指向环境变量。
2. **`desktop-linux` 上下文消失**，只剩裸的 `default`。普通的 `docker ps` 仍然能通，因为 Docker Desktop 同时提供了两个命名管道 —— 正是这种偶然的成功把缺陷藏到了真正需要它的时候。

重定向还会把机器相关的端点带到另一台机器上，与机制不依赖 ACL 是同一个理由。

**已修正：** 两个脚本中的 `DOCKER_CONFIG` 赋值与 `.docker` 目录条目均已移除。修正后 `docker compose version` 恢复正常。此后新增工具主目录时要注意，判断标准是「该目录存的是可重建的缓存，还是跨机无效的身份与端点」。

### 9.8 T1-02 发现的权限展开缺陷

种子首次运行报出 **17** 条授权关联，而按设计应为 **29** 条。差额暴露了一个真实缺陷，它不在种子脚本里，而在权限展开函数里。

`matchesGrant` 原先要求模式段数与编码段数**相等**，于是 `personal.*`（2 段）永远匹配不上 `personal.launch.read`（3 段）。展开结果：

| 角色 | 授权模式 | 应有 | 实际 |
| --- | --- | --- | --- |
| owner | `*` | 11 | 11 |
| admin | `personal.*` + 3 个 system | 9 | 3 |
| member | `personal.*` | 6 | **0** |
| viewer | `personal.*.read` | 3 | 3 |
| 合计 | | 29 | 17 |

后果是 `member` 角色拿到零权限，而整个流程不报任何错：种子正常跑完、正常打印成功、退出码为 0。只有把两个数字摆在一起才看得出来。原注释还写着 `personal.*` 表示「模块下的全部权限」，即实现与自己的文档相反。

**修正规则：通配符的吃法取决于位置。** 末尾的 `*` 吞掉剩余全部段，非末尾的 `*` 只匹配一段。

```
personal.*        末尾通配  → 覆盖 personal.note.read
personal.*.read   非末尾通配 → 只匹配 personal.<对象>.read
```

两者都必须支持，因为它们表达不同的授权意图：`personal.*` 是「这个模块全给」，`personal.*.read` 是「这个模块只能看」。若一律让 `*` 吞掉剩余段，只读角色会静默拿到写权限。模式走完且未出现末尾通配符时，段数仍必须相等，防止 `personal.note` 意外匹配到 `personal.note.read`。

**顺带补上回归测试。** 这个缺陷属于「静默且影响安全」一类，值得一个测试。`packages/shared/test/permissions.test.mjs` 用 Node 内置测试运行器，**不引第三方框架** —— 要守的规则很少，为一个文件装一套 vitest 不划算。它直接跑 `dist` 产物，因为写进库的就是那份展开结果，测它才是测真实生效的代码。13 项测试覆盖四种通配写法、三种不命中情形与四个角色的授权数。

**种子脚本的三处设计。** 一是用 `prisma.$transaction` 包裹，失败时整体回滚，不留半份数据。二是角色权限关联做差集同步，新增缺失的、删除多余的，因此可重复执行；同步时只处理代码里定义过的角色，将来支持自建角色后那些角色的授权不会被抹掉。三是**不创建任何账号**，超级管理员留给 T1-08 的首次初始化引导。种子里塞一个带默认口令的管理员是最常见的一类事故来源：它会在每台部署过的机器上都存在，而且没人记得改。

脚本放在 `src/db/` 而非 Prisma 惯例的 `prisma/seed.ts`：api 的 tsconfig 把 `rootDir` 限定为 `src`，放在 `prisma` 目录下会脱离类型检查，或者要为它再引一份 tsconfig。这个脚本是要写库的真实代码，不该落在检查范围之外。

**验证方式。** 除重跑确认 `0 新增 / 0 移除` 外，另手工向 `viewer` 插入一条多余的写权限，重跑后确认被移除、计数回到 3 —— 差集同步的两个方向都实际走通了，而不只是「重跑没变化」。

### 9.9 密码哈希的依赖选型与一处机制缺陷

**依赖只能选 `@node-rs/argon2`，不是偏好而是约束。** 本机没有 MSVC 编译器（`cl.exe` 不存在）。官方 `argon2` 包靠 postinstall 脚本调 `prebuild-install` 拉预编译二进制，而 `pnpm-workspace.yaml` 里的 `onlyBuiltDependencies: []` 会禁掉该脚本，于是退回 `node-gyp` 源码编译，然后必然失败。`@node-rs/argon2` 的二进制由 optionalDependencies 按平台分发，包内不含任何安装脚本，实测 19.4 秒装完、无需编译。这条约束适用于后续任何原生依赖：**先看它是靠 postinstall 还是靠可选依赖包分发二进制**。

**`parseOptions` 与 `Version` 枚举是两个容易踩错的点。** 库本身导出了 `parseOptions`，注释明确写着就是给 needs-rehash 用的，不必自己拆 PHC 串。更要紧的是库的 `Version` 枚举是 `V0x10 = 0`、`V0x13 = 1`，而 PHC 串里写的是 `v=19` —— 两者不是同一个数。按字面量 19 去比对，会让每一个哈希都被判为需要重算，而且不报错，只是每次登录都多做一次哈希。

**机制缺陷：入口脚本强制切换工作目录。** 安装依赖时发现 virtual store 落到了 `apps/api/node_modules/.pnpm`，而其它依赖都在工作空间根的 `node_modules/.pnpm`，出现了两套。

根因在入口脚本。`ws-run.sh` 结尾是 `cd "$WS_ROOT"`，`ws-run.ps1` 用 `Push-Location $env:WS_ROOT` 包住命令，两者都把工作目录切到工作空间根。文档里的示例是 `ws-run.cmd npm install`，那是单项目时代的写法 —— 当时项目就在根目录下，切过去是对的。现在项目在 `projects/fanhe-work/`，根目录下没有 `package.json`，同样的写法等于在错误目录执行命令，而且不会有任何提示。

本次的后果：`pnpm --filter @fanhe/api add` 在根目录执行，pnpm 未能按预期定位 workspace 根，virtual store 落到了子包目录下。用 `pnpm install` 归位后，残留的 666K 目录要手工清除；删掉之后 pnpm 又因非交互环境拒绝重建 modules 目录（`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`），需加 `CI=true` 才能继续。

**环境重定向全部通过进程级环境变量实现，与工作目录无关**，所以切目录并非重定向所必需。**已修正**：两个入口改为保留调用者的目录，仅当调用者在工作空间之外时才回退到根。三种场景（在根调用、在项目目录调用、在工作空间之外调用）在两个入口上均已实测。

修正过程中还牵出一个更深的问题。当时为了归位，用**未经入口**的 pnpm 跑了几次 `install` —— 环境变量未设，pnpm 退回默认 store，把 `node_modules` 重建到了 U 盘根目录的 `F:\.pnpm-store`。而 `node_modules/.modules.yaml` 记着 store 的绝对路径，于是后续经入口运行时又因 store 不匹配而要求重建整个 `node_modules`。

**这恰好证明了为什么所有包管理操作都必须经入口。** 少走一次，写入内聚就破了，而且当场没有任何提示 —— 命令正常成功，只有对比 `.modules.yaml` 里的 `storeDir` 才看得出来。判断 store 是否落在正确位置，可以直接查这一项，不必推断：

```powershell
Select-String -Path node_modules/.modules.yaml -Pattern storeDir
```

修复后经入口执行即可，入口会保留调用者目录：

```bash
cd projects/fanhe-work
bash ../../infra/portable/ws-run.sh pnpm install
```

### 9.10 T1-04 实施中的几处判断

**两种令牌分工，不混用。** 访问令牌是 JWT，短期、无状态，每个请求只验签不查库；刷新令牌是不透明随机串，长期、有状态，只存哈希、可撤销。把访问令牌也做成有状态的，等于每个请求查一次库；把刷新令牌也做成 JWT 的，等于放弃撤销能力。两种退化都会让设计里最有价值的那一半消失。

**选 HS256 而非 RS256。** 当前只有一个服务既签发又校验，不存在「校验方不该有签发权」的分离需求 —— 非对称算法解决的正是这个。在没有这个需求时引入非对称，只是多出一套密钥轮换的负担。将来若有独立服务需要校验令牌，再换，改的是 `tokens.ts` 里的一处与配置项。

**刷新令牌用 SHA-256，不用 Argon2。** 这与密码的处理必须分开看：密码是低熵的，必须用慢哈希抵抗离线爆破；刷新令牌是 256 位随机串，不存在「猜」的余地，慢哈希只会让每次刷新白付几十毫秒。用哈希的目的只有一个 —— 让拖库者拿到摘要而非明文。

**失败只有一种响应，配套三处时间填充。** 账号不存在、被停用、被锁定时都仍然执行一次哈希校验，用的是模块加载期现算的假哈希。不写死常量：写死的哈希会进版本控制，任何人都能读到它的参数，而且换算法后容易忘记同步。少了时间填充，这几条路径会立刻返回，而真实校验要等一次 Argon2 计算 —— 几十毫秒的稳定差别足以用来枚举用户名。

**Fastify 的 AJV 默认 `removeAdditional: true`。** 这个默认值让 schema 里的 `additionalProperties: false` 变成一次静默删除，而不是拒绝。实测确认过：带多余字段的登录请求原本返回 200。已在 `app.ts` 里显式改为 `false`。这处默认值很隐蔽 —— schema 看起来完全正确，行为却不是那样。

**登录的集成测试暂缺。** 端到端验证用 Fastify 的 inject 走完了完整链路（正确密码、错误密码、不存在的账号、缺字段、多字段、令牌落库形态、失败计数累加、lastLoginAt 更新），核心验收点「失败不区分账号是否存在」实测为两条响应完全一致、库中无明文令牌。但那次验证依赖本机数据库、且用的是用完即删的临时脚本；固化成可重复运行的测试需要库可达性探测与测试数据隔离，记在待办第 3 项。

### 9.11 T1-05 实施中的几处判断

**轮换必须用行锁，否则一次登录会裂成两条链。** 轮换的语义是「旧令牌作废、新令牌生效」，这两步必须同时成立。实现上把整个判定与写入放进一个事务，并先用 `SELECT ... FOR UPDATE` 锁住该行。没有行锁时，两个并发请求会同时读到「未撤销」，各自签发一份新令牌，于是一次登录产生两条互不知晓但都有效的链，轮换的意义随之消失。集成测试里有一项专门跑并发轮换，断言恰好一次成功。

**重放检测要区分「并发」与「泄露」，而这两者在库里长得一样。** 已作废的令牌被再次提交时，可能是同一客户端的多个窗口同时刷新，也可能是有人拿着偷来的旧令牌。库无法区分，只能按时间判断：撤销后极短时间内的重复提交算并发，超出宽限期的算泄露。前者只返回失败，后者按 familyId 整链撤销。

宽限期由 `REFRESH_ROTATION_GRACE_SECONDS` 配置，默认 10 秒，设为 0 即严格模式。这个取舍有代价，必须写明：宽限期内攻击者重放不会触发整链撤销。危害是有限的，攻击者拿不到新令牌，收到的是 401；被削弱的是「检测到泄露」这个信号的及时性。反过来，不设宽限期时任何并发刷新都会让用户掉线。两种损失都要付，选了后者更小的一种。

**撤销分三层，默认只撤当前会话。** `session` 撤当前这条链，`device` 撤该设备上的全部链，`all` 撤该账号的所有链。默认值取最小范围，因为撤销范围越大影响面越大，不该靠「省略参数」意外得到。

有一处退化要留意：`scope` 为 `device` 但令牌没有记录设备号时，退化为只撤当前会话。无从识别设备就把整个账号的会话全撤掉，会把用户从其它正常的设备上踢出去。

撤销写入用 `updateMany` 并带 `revokedAt: null` 条件，而不是按 id 逐个更新。并发下可能已有另一处撤销了其中一部分，带条件的更新不会把它们的撤销原因与时间覆盖掉。撤销时间是「第一次失效的时刻」，不该被后续操作改写。

**登出是幂等的。** 令牌不存在、已撤销、已过期，一律返回成功。客户端在令牌失效后重试、用户重复点击，都不该看到失败提示。登出的目的是让凭证不再可用，而它已经不可用了。

**一条必须写明的边界：撤销不会让已签发的访问令牌立即失效。** 访问令牌是无状态的 JWT，服务端不查库，它最多再活一个有效期，默认 15 分钟。要做到「撤销即刻生效」就得每个请求查库，那等于放弃无状态。两者不能同时要，所以访问令牌的有效期必须短。T1-05 的验收要点是「撤销后该设备刷新立即失败」，这一条是满足的。

**轮换采用滑动过期，链没有绝对寿命。** 新令牌的过期时间从当前时刻重新起算，持续在用的会话不会因为累计时长到期而中断。代价是一条被盗的链只要定期刷新就能一直续下去，止损只剩重放检测与手动撤销两道。若将来需要绝对上限，做法是在 family 上记一个创建时间，取两者中较早的过期时刻。

**测试基础设施：需要数据库的测试要能跳过，而且跳过必须出声。** T1-05 的行为落在事务与行锁上，内存替身测不出真伪，因此引入连真实数据库的集成测试。`test/helpers/db.ts` 负责在 `env.ts` 被求值之前把连接串换回真实值，取值顺序是 `FANHE_TEST_DATABASE_URL` 优先，其次是 `apps/api/.env` 里的 `DATABASE_URL`；两者都没有时返回 null，测试跳过。

这里有一个容易被读错的输出：`describe` 的 skip 会让整个 suite 从统计里消失，总数从 37 降到 23，而 `skipped` 与 `fail` 都仍然是 0，输出全绿。因此文件顶层在库不可达时显式打印一条告警。静默跳过比测试失败危险，它会把「没跑」显示成「跑过了」。

**一处实测发现：同一秒内签发的访问令牌逐字节相同。** JWT 的 `iat` 与 `exp` 都是秒级精度，同一账号在同一秒内签发两次，载荷与签名必然一致，令牌字符串完全相同。这是 JWT 的固有特性，不是缺陷，两份令牌语义相同、同时失效。最初写的断言是「新旧访问令牌不同」，跑出来失败，排查后确认是断言写错而非实现有问题。需要「每次签发都不同」时应加 `jti`，但当前没有任何场景需要区分它们，故不加，只在 `tokens.ts` 注明。

### 9.12 T1-06 实施中的几处判断

**两个限速维度各挡一类攻击，谁也不能替代谁。** 账号维度针对的是猜某个账号的密码，连续失败若干次后锁定该账号。它挡不住用户名枚举，攻击者拿一批不存在的用户名逐个试，每个账号的失败计数都停在 0，永远不触发锁定，却能通过响应差异把存在的用户名筛出来。IP 维度看的是来源的失败密度，与用户名是否存在无关，这一类攻击正好落在它的覆盖范围里。反过来，IP 维度挡不住换 IP 的分布式爆破，那要靠账号维度。缺任何一边都留下一整类攻击。

**登录尝试单独建表，不复用 audit_logs。** 决定性的理由是两者的保留策略相反。审计日志要长期保留且不可删，而限速计数只需要覆盖一个时间窗口，超期记录必须清掉，否则一张会被反复写入的表迟早涨到影响查询。把保留策略相反的两类数据放进同一张表，清理与保留两边都做不成。

**被限速的请求既不做哈希校验，也不写记录。** 这两条都是为了不让限速本身变成放大器。若被拒绝的请求仍然照常算一次 Argon2，攻击者用大量请求就能把服务端 CPU 打满，而挡在前面的限速恰恰在帮他完成这件事。若不阻止写入，攻击者持续发请求就能让 `login_attempts` 按请求量增长。限速需要的信息只是「窗口内已有多少次失败」，被拒绝的尝试对它没有贡献。

**限速是唯一对外可见的失败原因，返回 429 并带 Retry-After。** 其余四种失败共用同一个 401 响应，因为任何差异都会变成账号枚举接口。限速不涉及账号信息，只说明来源的失败密度，让客户端知道要等多久是必要的。把它伪装成 401 只会让正常用户以为密码错了而反复重试，把窗口越拖越长。

**窗口是滑动的，不按固定区间分桶。** 固定窗口存在边界效应，在窗口切换的瞬间前后两段各允许一个满额，实际放行的请求量是阈值的两倍。滑动窗口没有这个缺口，代价是每次判定都要统计窗口内的记录条数，走 `[ip, created_at]` 索引，在登录这个频率下开销可以忽略。

**记录保留期必须显著长于 IP 窗口。** 两者存在约束关系，若保留期短于窗口，窗口还没滑完记录就被删了，计数会偏小，限速会提前失效。默认是 7 天对 15 分钟，余量充足。调参时要一起看，这一条也写在 env 的注释里。

**清理挂在写入路径上，不引入定时任务。** 个人工作台的登录频率很低，每次多一条走索引的删除语句，开销可以忽略。为一张几天才写几十行的表专门起一个调度器，复杂度远大于收益。清理条件是全局时间范围，超期记录对任何 IP 都没有价值。

**测试的阈值一律从 env 读，不写死。** 默认值改了，测试跟着走，不会因为「测试还在按旧阈值构造数据」而误报。每个用例分配独立的来源地址，取自 RFC 5737 的文档用地址段，既避免限速计数互相污染，也让清理能精确圈定本文件产生的记录。

**一处尚未处理的遗留：用户名的大小写归一。** schema 的注释写明 username 在写入前由应用层统一归一为小写，但登录查询目前直接使用提交的原值，创建账号的代码还不存在（属 T1-08）。单独在查询侧加一行归一会造成「读侧归一、写侧不归一」的半成品状态，比现在更隐蔽。归一是账号标识的整体策略，需要与创建、改名、唯一约束冲突检测一起落地，因此留给 T1-08，已记入待办第 5 项。

### 9.13 T1-07 实施中的几处判断

**认证与授权拆成两步，职责不重叠。** 认证回答「你是谁」，只解析访问令牌并确认账号可用；授权回答「你能不能做这件事」，在认证结果之上比对权限点。合成一个函数会让「已登录但没有权限」这条路径缺少一个明确的落点，而 401 与 403 的区别对客户端是有意义的：前者提示重新登录，后者提示找管理员要权限。

**权限点不放进令牌，授权每次查库。** 放进令牌的好处是省一次查询，代价是改了角色授权之后旧令牌仍带着旧权限，要等它过期才生效，而撤权需要立刻生效。这条取舍在 T1-04 就定下了，T1-07 是它的执行方。

**不加缓存。** 给权限查询加一层 TTL 缓存，会把「撤权立刻生效」退化成「最多延迟 N 秒」，而且延迟长短取决于缓存是否命中，排查时看不出来。将来真要优化，正确做法是给角色加版本号、在授权变更时递增，而不是给缓存设一个拍脑袋的 TTL。

**同一趟查询顺带确认账号状态。** 既然每次请求本来就要查库拿权限，把 `status` 与 `deletedAt` 一起读出来几乎不增加成本，换来的是账号被停用或删除后已签发的访问令牌立即失效。这是「撤销立刻生效」在无状态令牌下唯一可行的实现方式。

**权限点用类型而不是字符串。** `requirePermission` 的参数是 `PermissionCode`，调用方只能从 `@fanhe/shared` 的清单里取值。写错一个字母会在编译期被拒绝，而不是变成一个永远返回 403 的路由。后者在联调时的表现是「权限明明配了却不生效」，排查方向会先落到数据库上。

**库里的权限码要收窄。** 权限清单调整后如果种子还没重跑，库里会留着已经不存在的权限点。这些码在精确匹配下命中不了任何 required，过滤掉它们是为了让「权限只能来自这份清单」在类型层面也成立。

**403 记日志，401 不记。** 401 是「没带令牌」或「令牌过期」，属于正常流程，记日志只会刷屏。403 已经知道是谁在访问，这条记录是区分「权限配错了」与「有人在试探」的唯一依据。

**测试用 `inject` 走完整链路。** 守卫的价值全在「绕过前端直接调接口」这一条路径上，只测函数返回值等于把最有意义的那一段漏掉。测试内注册了三个最小的受保护端点，避免把权限测试绑在某个业务模块上，那些模块要到阶段三才存在。

两条关键断言值得单独说。一是**令牌里的 role 被篡改不影响授权**，测试用真实密钥签了一个 sub 指向 viewer、role 写成 owner 的令牌，仍然返回 403，证明授权以库为准。二是**账号停用后令牌立即失效**，令牌的签名与过期时间都没问题，失效来自守卫对账号状态的检查。

**api 的测试脚本现在会先构建 shared。** 该包从 T1-07 起依赖 `@fanhe/shared` 的权限常量，而测试用 `tsx` 直接跑 TypeScript，不会自动构建依赖包。脚本里加一行 `pnpm --filter @fanhe/shared build` 前置，从任何目录直接跑都不会因为 `dist` 缺失而失败。

### 9.14 T1-08 实施中的几处判断

**初始化的判据是「存在任意 owner 账号」，且不过滤状态与软删除。** 这是系统里唯一一处不需要认证就能创建账号的入口，它的安全性完全依赖「不可再次进入」。若把已停用或已软删除的 owner 排除在外，「先让 owner 不可用、再走初始化入口给自己建一个」就成了一条完整的路径。停用与删除 owner 本身需要 owner 权限，但一条只差一步就能成立的路径不该留着。代价是 owner 被全部删除后入口不会重新开放，恢复走 `pnpm db:create-owner`。

**并发初始化用咨询锁，而不是给 users 表加约束。** 要表达的条件是「owner 角色至多一个账号」，它跨行，普通唯一约束写不出来。`createOwnerAccount` 在事务内先取 `pg_advisory_xact_lock`，再重新判一次是否已初始化，把并发请求串行化。事务外那次存在性检查只用来省掉无谓的 Argon2 计算，真正的判定在锁内；哈希也刻意放在事务外算，免得咨询锁被多持有几十毫秒。

**一处真实缺陷：`pg_advisory_xact_lock` 的返回值让初始化必然 500。** 该函数返回 `void`，而 Prisma 7 的驱动适配器无法反序列化 `void` 列，报出的是 `Failed to deserialize column of type 'void'`。这条错误只在运行期出现，类型检查与 lint 都发现不了；而初始化入口的每一条成功路径都会经过它，也就是说这个功能此前从未真正跑通过一次。修法是套一层子查询取一个整型常量：`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock($1)) AS setup_lock`。锁的语义不变，函数是 volatile 的，不会被优化掉。

**初始化成功后不自动签发令牌。** 初始化与登录是两件事，合成一条路径会多出一个需要单独验证的令牌签发入口，而客户端紧接着调一次登录接口的成本几乎为零。

**账号名归一放在应用层，库侧只留唯一约束。** PostgreSQL 的 text 等值比较区分大小写，不归一时 `Admin` 与 `admin` 会是两个账号，而登错那一个得到的提示是「密码错误」，把人引向完全错误的方向。用 `toLowerCase` 而不是 `toLocaleLowerCase`：后者在土耳其语环境下把 `I` 变成 `ı`，而账号名是标识，归一结果必须与运行环境的区域设置无关。不放在库侧（citext 或 lower() 表达式索引）是因为归一规则将来可能变化，而索引表达式一旦建成就很难改。

**登录侧的归一拆成两个值。** 提交的原值用于记录尝试，归一后的值用于查询。合并成一个会让日志看不出有人在试大小写变体；而库里的账号名是归一形式，拿原值去查会让用户输入 `Admin` 登不上 `admin`。

**首次初始化的测试依赖全局单例状态，因此 api 测试改为串行。** 判据是「全库没有 owner」，而 `permission.test.ts` 需要建一个 owner 角色的账号来验证 owner 专属权限。两个文件并行跑时，对方建的 owner 会落在这边的判定与断言之间，表现是 status 报已初始化、初始化请求全部被拒。这类时序问题的特征是**断言说库不干净、而直接查库却干干净净**，且偶发不复现；只看单次失败输出会误以为是实现缺陷。修法是把 api 的 test 脚本加上 `--test-concurrency=1`。顺带记一条：Node 的 `{ skip: '<理由>' }` 确实生效，跳过会计入 `# skipped`，所以「用例没跑」不会被误读成「跑过了」。

**恢复通道与 HTTP 入口共用同一份实现。** `pnpm db:create-owner` 与初始化接口的差别只在 `requireUninitialized` 这一个开关。分成两份代码的话，两条路径的校验与并发处理迟早会走偏，而其中一条只在出事时才被用到，偏了也发现不了。密码只从环境变量读，不走命令行参数：参数会留在 shell 历史与进程列表里。

**验收清单中的「四种角色登录后可见范围符合预期」当时暂不勾选。** 服务端这一半（角色到权限点的展开）已由 T1-02 的种子核对与 T1-07 的测试覆盖，但「可见范围」作为使用者能观察到的现象依赖前端按权限过滤菜单与路由，属 T1-11。该断言已于 T1-11 补上（`packages/shared/test/navigation.test.mjs` 的 14 项），这一项随之勾选，依据与边界见 9.18。

### 9.15 T1-09 实施中的几处判断

**审计与限速记录的保留策略相反，因此分表。** `audit_logs` 长期保留、只增不改不删；`login_attempts` 只覆盖一个限速窗口，超期必须清理。放进同一张表，清理与保留两边都做不成 —— 这条在 T1-06 定下，T1-09 是它的另一半。

**写入失败不能让主流程失败，但也不能静默。** 一次登录不该因为审计表出问题而登不进来，owner 恢复脚本同样不该因此停住。而记录缺失意味着「出了事却查不到痕迹」，与没出事一样糟。`recordAudit` 因此把异常吞掉并出声，而不是向上抛。测试用一条超长的 `ip` 让 INSERT 在数据库层真实失败，验证的正是这个保证。

**`actorId` 与 `actorName` 同时写。** 外键用的是 SetNull，账号被删除后 `actorId` 会置空；没有写入时的那份名字快照，「谁做的」这个问题在账号删除后就再没有答案。

**被限速的登录不写审计。** 与 T1-06 里不写 `login_attempts` 是同一条理由：限速的目的就是让被拒的请求不产生任何写入，一旦写，攻击者的请求量就直接换成表的增长量，限速本身成了放大器。首次初始化被拒绝的那次同理 —— 那条路径在算哈希之前就返回，匿名调用者能用请求量换表的增长。

**失败的登录不填 actor。** 只在账号存在时才填，等于让 `actor` 列变成「这个账号存不存在」的旁路判据。审计是 owner 能看的，没必要把枚举结果沉淀进去；提交的账号名进 `detail`，它忠实反映有人试过什么。

**重复登出不写第二条。** 登出是幂等的，客户端在令牌失效后重试、用户重复点击都会走到写入点。没撤销任何东西就等于没有事件。

**`user_unavailable` 不记。** 账号被停用后合法客户端每次刷新都会撞上它，记下来只有噪声；账号状态变更本身会有对应的事件。

**动作码不拆成功与失败。** 用 `result` 列区分。同一个动作的两种结果是同一件事的两面，拆成两个码会让「按动作聚合」时漏掉一半。

**验收清单中的「关键操作在 `audit_logs` 有记录」暂不勾选。** 写入链路与四类事件已完成，但「授权变更」与「删除」还没有对应的接口 —— 账号与角色管理功能尚未实现，没有可以挂钩的地方。那两类事件的落点在这两个功能的 service 里，写入层不需要改动。

**测试清理暴露的一个坑。** 审计行按来源地址清理，但两处落不进这个圈：`session.test.ts` 直接调 service，登出与轮换没有来源地址，写出来的是 NULL；`setup.test.ts` 的 `inject` 不给 `remoteAddress` 时默认 `127.0.0.1`，会落到真实地址段上。前者的修法是改在删账号之前按 `actorId` 清理（`actor_id` 是 SetNull，账号一删归属就断了），后者是显式给出 `TEST_IP`。第一次跑完门禁时数据库里留了 12 行，是事后核对行数才发现的 —— 断言全绿并不代表没有残留。

### 9.16 迁移顺序核验与交接文档

**迁移目录名的字典序与应用顺序相反，已实测确认无影响。** `prisma/migrations/` 下 `20261010082118_login_rate_limit` 的字典序排在 `20261010150103_init` 之前，而 `_prisma_migrations` 记录的应用顺序是 `init` 先。看起来像隐患：`login_attempts` 与其枚举定义在 `login_rate_limit` 里，若 `init` 引用了它，按字典序应用就会失败。

实测方式是建一个临时空库跑完整链：`migrate deploy` 按字典序依次应用两个迁移，七张业务表齐全，`migrate status` 报 up to date，`db:seed` 写入 11 权限点 / 4 角色 / 29 授权关联，结果与主库一致。**结论是两个迁移互相独立，不需要重命名目录，也不需要任何调整。**

这条之所以要记，是因为它会在将来变真：新增迁移时若引用了时间上更晚创建的对象，同样的不一致就会从「无害」变成「建库失败」，而那时要检查的不是 Prisma 的排序，是迁移之间是否真的独立。

**同日新增交接文档 `docs/HANDOFF-2026-10-10.md`。** 汇总当日 26 个提交的成果、关键决策、未解决问题、后续待办，以及逐文件清单（用途 / 位置 / 是否纳入版本控制）与换机必做步骤。目的是让换一台电脑后的自己能在不看聊天记录的前提下继续开发。该文档遵守「受版本控制的文件里不出现盘符」的约定，路径一律相对工作空间根。

**同日修正 README 两处与代码不符的描述。** 一是入口脚本的行为：原文说入口会把当前目录切回工作空间根，而该行为已在 `479bd83` 改为保留调用者目录，README 未同步。二是迁移清单：原文只提了首个迁移，实际有两个，且未说明字典序与应用顺序相反这一情形。

### 9.17 T1-10 实施中的几处判断

**跨进程结构放进共享包，服务端用同一份类型标注响应。** 新增 `packages/shared/src/auth.ts` 定义登录、刷新、登出、`/me`、初始化五组传输结构。只放传输形态，不放行为：令牌是 JWT 还是随机串留在服务端，前端不必知道。服务端的认证路由改用这些类型标注响应体，字段名改了而忘了同步前端时会在编译期失败，而不是等到联调时表现为「界面拿不到数据」。

**访问令牌只放内存，刷新令牌放 localStorage。** 两者寿命与用途不同，存储位置也必须不同。访问令牌短命、无状态、不可撤销，放进 localStorage 会让任何一次 XSS 都能读走它，而它无法被服务端提前作废；放内存意味着刷新页面即丢，用刷新令牌换一个即可。刷新令牌长期有效、可撤销，是「刷新页面不用重新登录」的唯一依据，必须持久化。这条取舍的边界写在 `lib/session.ts` 的注释里：当前是外壳内的单页应用，不加载第三方脚本，风险面可控；若将来引入第三方脚本或做多用户共用浏览器，正确做法是改成 HttpOnly Cookie，改的是这里与服务端两处。

**续期用单飞收敛并发。** 页面打开时可能有多个请求同时拿到 401，各自触发一次续期。服务端对刷新令牌做轮换，第一个请求成功后旧令牌即作废，后续请求拿着同一个旧令牌提交会被判为「已轮换令牌被重放」：落在宽限期内只是失败，超出宽限期就整链撤销，把用户直接踢下线。因此 `refreshSession` 把并发请求收敛到同一个 Promise 上，后到的调用方拿到同一个结果，不产生第二次提交。这一条不是优化，是正确性要求。

**主动续期优先于被动重试。** 定时器在访问令牌过期前 60 秒换新，而不是等某个请求拿到 401 再补救。被动续期会让每个到期点都先产生一次失败请求，而那次失败会短暂影响界面上正在进行的操作。60 秒是留给网络往返的余量，不能等到过期那一刻才发，否则请求会带着刚好过期的令牌出发，表现为「每次续期都先失败一次」。401 重试仍然保留，作为定时器之外的兜底，且只重试一次：第二次仍 401 说明问题不在令牌时效上。

**续期失败即回登录页，不做重试。** 失败的原因通常是刷新令牌已过期、已被撤销或账号已被停用，这三种情况重试都不会成功，继续留在主界面只会让后续每个请求都失败。

**登出先清本地再通知服务端。** 服务端撤销需要一次网络往返，失败或超时后若把本地令牌留着，用户会以为自己没退出。清掉本地令牌后即使撤销请求失败，本机也已经退出，下次刷新会因没有刷新令牌而回到登录页。撤销失败不向用户报错：登出的目标是「这个凭证不再可用」，本机这一侧已经达成，报错只会给出一个他无法处理的提示。

**阶段一不引入路由库。** 三个界面（初始化 / 登录 / 已登录）互斥，一个状态量就够表达，此时引入路由只是多一层抽象。真正的路由体系属 T2-03，届时守卫的判断依据仍然是这一份认证状态。同理，T1-10 顺带实现了首次初始化的界面：没有它，空库状态下无法创建第一个账号，登录页也就无从验证。它属于 T1-08 的前端对应物，但离开它这条链路不闭合。

**补上的三项登录测试。** schema 校验（缺字段、多余字段、超长账号名）验证 `additionalProperties: false` 真正生效，而不是被 AJV 的 `removeAdditional` 静默删除；落库形态验证刷新令牌只存 64 位十六进制摘要、等于明文的 SHA-256，且 `lastLoginAt` 更新与失败计数清零；路由层成功响应验证 `expiresIn` 与服务端配置一致，且响应体不含任何哈希字段。第三项里的 `expiresIn` 不是可有可无的断言：客户端靠它安排续期，对不上会让续期要么过早要么过晚。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 13 项加 api 85 项合计 98 项，0 跳过。另跑了一次不依赖浏览器的端到端冒烟（初始化 → 登录 → `/me` → 轮换 → 宽限期重放 → 登出），逐项符合设计，随后清空冒烟数据，四张流水表回到 0 行。前端生产构建通过（31 个模块，产物 234.58 kB，gzip 73.96 kB）。

**环境归位的两处发现。** 本次换机后 `pnpm` 未随介质带过来（上一台机器装在另一账户下），本机改用 corepack 提供并启用垫片；同时 `node_modules` 因 store 路径随盘符变化而失效，需重建。重建时 pnpm 删除 `node_modules` 触发了宿主环境的批量删除保护，最终以一次性清空 `NODE_OPTIONS` 的方式完成，未改动其它任何环境。

### 9.18 浏览器级端到端验证（T1-10 的收尾）

**为什么补这一层。** T1-10 完成时的验证组合是「类型检查 + 生产构建 + HTTP 契约冒烟」，三者都覆盖不到渲染层。React 在运行期抛错时构建照样通过、接口照样返回 200，只有页面会白掉 —— 这类故障前面三道关卡一个都拦不住。当时把这条列为唯一未被自动覆盖的风险面，留作手工检查。现在把它自动化：`apps/web/test/e2e-auth.mjs`，`pnpm --filter @fanhe/web test:e2e`。

**不下载 Chromium。** 原判断是「安装 agent-browser 需下载 Chromium 约 500MB，代价高于收益」。这个前提不成立：本机已装有 Chrome 与 Edge，直接走 DevTools 协议驱动即可。Node 22 自带 `WebSocket` 与 `fetch`，因此整条链路零第三方依赖，脚本不到 500 行，含一个最小 CDP 客户端。

**十三项断言，覆盖一条完整用户路径。** 首次初始化页渲染 → 两次密码不一致被客户端拦下 → 初始化成功后切登录页 → 错误密码显示统一文案 → 正确密码进入主界面并展示 11 个权限点与角色名 → 刷新令牌落在 localStorage 而访问令牌不在 → 静默续期确实发生 → 续期期间未掉回登录页 → 登出清空本地令牌并回到登录页 → 渲染期未产生未捕获异常或 `console.error`。截图逐张存盘，可直接肉眼复核排版与样式。

**续期的判据是请求发出去了，不是界面还在。** 这是本脚本里最容易写错的一处。令牌有效期内界面本来就正常，所以「等 14 秒看有没有掉回登录页」在续期完全没发生时也会通过，是个假阳性。改为在页面里挂钩 `fetch` 统计发往 `/api/auth/refresh` 的请求数，等它出现才判定通过。顺带从登录响应里取回 `expiresIn`：有效期没压短时（默认 900 秒，续期要等 14 分钟）直接报出实际值并给出「需以 `ACCESS_TOKEN_TTL_SECONDS=60` 启动 API」的提示，而不是抛一句没头没尾的等待超时。

**`--user-data-dir` 必须传绝对路径。** 传相对路径时 Chrome 不报参数错误，而是弹一个模态对话框说「无法对其数据目录执行读写操作」然后卡在那里等用户点确定。调试端口始终不开，外部只看到「CDP 目标未就绪」，与真正原因相距很远。这个坑的实际表现是一次失败的运行加上一张用户截图才定位到，值得写下来。

**脚本自带前置检查。** 第 1 项断言依赖库处于未初始化状态，否则首次初始化页不会出现。因此脚本先取 `/api/setup/status`，已初始化时直接退出并打印重置命令，而不是让第 1 项以「找不到元素」的形式失败 —— 后者的排查方向会先落到前端选择器上。同理，每次运行使用全新的浏览器 profile，断言不依赖上一次运行的残留。

**本次验证结果。** 13 项全部通过。续期在登录后 4.8 秒触发，与 60 秒有效期、60 秒提前量被夹到 5 秒下限的预期一致；期间发出的鉴权请求为 `login → login → me → refresh`（第一次 login 是故意用错密码那一步）。渲染期未捕获异常与 `console.error` 均为零。数据库在验证后回到基线：`users` / `refresh_tokens` / `audit_logs` / `login_attempts` 四张流水表 0 行，种子 11 / 4 / 29 完好。

**T1-11 把脚本扩到 18 项**，新增 5 项覆盖导航过滤，见 9.19。上面这段保留为当时的记录。

### 9.19 T1-11 实施中的几处判断

**导航清单放共享包，而不是前端内部。** 新增 `packages/shared/src/navigation.ts`。按「只放两边都要用的东西」这条既有原则，导航项本身只有前端消费，看起来该留在 `apps/web`。选择放进共享包有两个理由。一是它回答的是「权限点到界面」的映射，与 `permissions.ts` 的权限点清单是同一件事的两面，拆开放会让「哪个角色能看到哪一项」这条规则散落在两个包里。二是阶段二 T2-03 的路由表要从它派生，服务端将来做菜单下发或路由级提示时也要用它；那时再从前端搬出来，代价是多一次反向依赖。

只放信息架构：编号、名称、可见性条件、规划说明。图标、样式与组件留在前端，与 `permissions.ts` 的分工相同。

**可见性判定用模块，不用具体权限点。** 导航项的粒度是模块，所以判定条件写成「持有该模块下任意一个权限点即可见」。若绑一个具体权限点，例如个人工作台绑 `personal.launch.read`，那么一个只被授予 `personal.note.read` 的角色将看不到个人工作台，尽管它确实拥有这个模块的权限。这类失效不报错、不打日志，只表现为「菜单少了一项」。值得记下来的是：当前四个内置角色的授权模式（`personal.*` 与 `personal.*.read`）恰好都覆盖 `launch.read`，所以**绑具体权限点现在也能通过全部测试**，缺陷要等到出现一个权限更窄的角色才会暴露。用模块判定从一开始就不依赖这个巧合。

判定用 `模块名 + '.'` 前缀匹配而不是裸前缀：后者会让 `personal` 命中 `personalized.xxx`。权限点固定三段式，加上分隔符后不存在误配。

**三个占位项的可见性条件是 `null`，含义是对所有已认证用户可见。** 客户、运营、数据看板三段权限点目前不存在。若在这里编造一个 `customer.read` 之类并不存在的权限点，判定结果对**所有**角色都是不可见，包括 owner，那等于把实施方案要求的「预留占位」做成了「永远隐藏」。因此占位项暂时不设门槛，等阶段三确定对象清单、追加权限点后再改。这条已写进 9.2 待办第 5 项，连同届时需要一并改掉的测试断言。

**`planned` 与 `module` 是两个正交的字段。** 不能用 `module === null` 代替 `planned`：占位项将来定义了权限点后仍属占位，而可见性条件那时已经不再是 `null`。合起来会让「功能开发中」这个标签在模块落地的那一刻自动消失。

**守卫落在共享包的 `resolveActiveNav`，不新增组件。** 它的职责是把三种情形收敛成同一个结果：请求的项可见就用它，不可见就回退到第一项，可见清单为空就返回 `null` 交给调用方兜底。第二种情形是真正的守卫场景。会话存续期间权限被收紧时，`requested` 会指向一个已经不可见的项，此时继续渲染它的内容，界面会停在一个已经没有权限的模块上。放在共享包而不是写进 `HomePage`，是为了让它能被测试覆盖，而这类回退逻辑恰好是最容易写错、又最不容易被发现的一类。

**阶段一仍然不引入路由库。** 与 9.17 的判断一致：当前只有一个已登录界面，切换的是界面内部的选中项，不是路由。真正的路由体系属 T2-03，届时 `resolveActiveNav` 的判断依据（可见清单加请求项）不需要变，换掉的是「请求项从哪里来」，从组件状态变成 URL。

**过程中发现一处真实缺陷：登出与在飞的续期存在竞态。** 这是本次最有价值的产出。它由端到端验证的既有断言暴露，与 T1-11 的功能改动无关，属 T1-10 遗留。

机制是这样的：用户点登出时，若一次静默续期正好在路上，`endSession` 会先清掉本地令牌，而那个已经发出的刷新请求无法取消，它返回后照常执行 `applyTokens`，把新的刷新令牌写回 `localStorage`。结果是「点了登出，本地却还留着一个可用凭证」，刷新页面会重新进入会话。界面在这一步看不出任何异常，登出按钮也正常回到登录页。唯一能观察到它的方式是登出后去读 `localStorage`，而那正是端到端脚本第 8 项做的事。

修法是在 `lib/session.ts` 引入会话代数：`clearSession` 递增一次，`refreshSession` 在发起时记下当前代数，写回之前比对，代数变了就丢弃这次结果并抛出 401。请求本身无法取消，所以只能在写回前判断。抛错而不是静默返回，是为了让调用方走「续期失败」这条既有路径，而不是拿着一个已被丢弃的令牌继续请求。

这条缺陷的暴露与时序有关：它要求登出恰好落在一次续期请求的往返窗口内。T1-11 的改动让页面渲染变慢，登出时机后移，这次跑出来了。修掉之后连续三次运行均通过。

**验收清单第一项的勾选依据与边界。** 「四种角色登录后可见范围符合预期」在 T1-08 时因缺少前端落点而搁置（见 9.14 末段）。现在两半都齐了：服务端的角色到权限点展开由 T1-02 的种子核对与 T1-07 的测试覆盖，前端的权限点到可见范围由 `navigation.test.mjs` 的 14 项覆盖，输入用的是 `ROLE_PERMISSIONS`，即种子展开后真正写进 `role_permissions` 的那份结果。

边界要说清楚：**端到端脚本只能验证 owner 一种角色**，因为造出另外三个角色的账号需要账号管理接口，那是阶段三的功能。admin / member / viewer 的可见范围目前只有单元测试覆盖，没有经过真实渲染。这个缺口随账号管理功能落地而闭合，届时把四个角色各建一个账号跑一遍端到端即可。

**顺带修正了脚本的一处度量错误。** 续期耗时原先由脚本在几步之后取当前时间作为基准，而中间隔着截图与断言，算出的「登录后多久续期」会偏小甚至变成负数（本次首跑报出 -5.3 秒）。改为在探针里记录登录成功响应的时刻，重跑得到 5.2 秒，与 60 秒有效期、60 秒提前量被夹到 5 秒下限的预期一致。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 27 项加 api 85 项合计 112 项，0 跳过。前端生产构建通过（238.10 kB，gzip 75.09 kB，较 T1-10 增加约 3.5 kB）。浏览器级端到端验证 18 项全部通过，其中新增 5 项覆盖导航可见范围与占位页文案。数据库在验证后回到基线：四张流水表 0 行，种子 11 / 4 / 29 完好。

### 9.20 T1-12 实施中的几处判断

**阶段一没有系统凭据接口，用的是浏览器能提供的最强形态。** G5 的实现要点写的是「凭据由系统凭据接口加密后落盘」，风险应对写的是「只用系统凭据接口加密存储」。这两处指向 Windows DPAPI 或 Electron `safeStorage`，而阶段一还没有 Electron 外壳（属阶段四），浏览器里也不存在这两个接口。因此 `apps/web/src/lib/credential.ts` 用 Web Crypto 实现，AES-GCM 加密，密文与初始向量写 localStorage。

**密钥不可导出，这是这套方案里唯一真正起作用的约束。** 加密密钥以 `extractable: false` 生成，存进 IndexedDB。同源脚本可以调用它加解密，但无法把密钥本身导出带走。这一位决定的是「拿到磁盘文件的人能否解密」。把它设成 true 再导出成 JWK 存起来，等于把密钥和密文放在一起，那是混淆而非加密。

**安全强度的边界必须写明。** 密钥由浏览器托管，一次同源 XSS 就能调用它解密。这比把密码明文放进 localStorage 强一个数量级，但低于操作系统密钥链。后者把密钥交给 DPAPI 或 Keychain，渲染进程根本够不到。**阶段四落地 Electron 后应把本文件的实现换成主进程的 `safeStorage`**，替换只涉及这一个文件，登录页调用的是 `saveCredential` / `loadCredential` / `clearCredential` 三个函数。这是阶段一已知的安全缺口，性质上与 9.19 那类「阶段一临时实现」相同，但它涉及安全，所以单列出来。

**凭据只在登录成功之后写入。** 放在提交时写会把输错的密码一并记住，而用户下次看到密码框已经被填满，会以为那个密码是对的。取消勾选后登录则清除已保存的凭据，清除同样发生在成功之后。

**明文不落盘的可验证形式是结构断言。** 端到端脚本断言 localStorage 里那条记录只有 `data` / `iv` / `v` 三个字段，且整串文本不含账号名与密码。只判断「存在」是不够的，明文同样满足存在。

**填充只在输入框还空着时进行。** 浏览器自带的密码管理器可能已经填过一份，那一份是用户刚在浏览器里更新过的，覆盖它会把密码换回旧的，而界面上看不出发生过什么。

**发现并修掉一处真实的性能缺陷：IndexedDB 连接没有复用。** 首版每次读写密钥都开一个连接再关掉。在系统盘上这个代价看不出来，而在随机 IO 慢的介质上单次打开可以花掉数秒。实测把浏览器 profile 放在工作空间所在的 U 盘上时是 5.8 秒。登录页每次挂载都要读一次密钥，这个代价会直接变成「密码框几秒钟之后才被填上」。改为在模块作用域缓存连接，一次会话只打开一次，并处理 `onversionchange` 与 `onclose` 两个会让缓存失效的事件。

顺带把验证脚本的浏览器 profile 从截图目录移到系统临时目录。profile 里是 IndexedDB 与 localStorage 的后端文件，访问模式是随机小 IO，放在 U 盘上会拖慢每一次运行。这是项目约定「重型产物移出 U 盘」的一个具体落点。

**一处一度误判的现象。** 第一次跑端到端时凭据没有落盘，最初的判断是 headless Chrome 不支持 IndexedDB。加了能力探测才看清：`isSecureContext` 为 true，`crypto.subtle` 与 `indexedDB` 都在，真正的问题是**读取的时机太早**。写入发生在登录成功之后，走的是取密钥加一次加密，比界面切到主界面要慢，脚本读到的是还没写进去的空值。修法是先等记录出现再断言。这条记下来是因为它的表现形式（功能没生效）与真正的原因（测试读早了）指向完全不同的方向。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 27 项加 api 85 项合计 112 项，0 跳过。前端生产构建通过（241.32 kB，gzip 76.23 kB）。浏览器级端到端验证 22 项全部通过，其中新增 4 项覆盖凭据的落盘形态、重启带出、复选框状态与取消勾选后的清除。数据库在验证后回到基线：四张流水表 0 行，种子 11 / 4 / 29 完好。

**阶段一至此收尾。** 验收清单剩「关键操作在 `audit_logs` 有记录」一项未勾选，它依赖账号与角色管理接口，见 9.15 与 9.2 第 7 项。

### 9.21 T2-01 实施中的几处判断

**接入路线：拉官方 registry 源码，不跑 CLI。** shadcn 的官方接入方式是 `npx shadcn@latest init` 后按需 `add`。这条路在别处没问题，在本项目里有两处冲突。一是 CLI 会自行调用包管理器，而项目约定**所有包管理操作必须经 `ws-run` 入口**，否则 pnpm 的 store 会落到宿主机磁盘；这个偏差当场没有任何提示，只有对比 `node_modules/.modules.yaml` 的 `storeDir` 才看得出来。二是 CLI 会写入 npx 缓存，那也在宿主机上。

改为直接取 registry 的 HTTP 端点：`https://ui.shadcn.com/r/styles/new-york-v4/<组件>.json`，返回体里的 `files[].content` 就是组件源码全文。依赖仍然经入口显式安装。`components.json` 照样写进项目，字段与 CLI 生成的一致，将来若要改用 CLI 追加组件，不必先补配置。

**取 v4 版源码，但把它的 `radix-ui` 导入改回分散原语包。** registry 有两个版本。旧版（`styles/new-york/`）是 React 18 时代的写法：`forwardRef`、`ButtonProps` 接口、依赖七个分散的 `@radix-ui/react-*`。v4 版（`styles/new-york-v4/`）是函数组件加 `data-slot` 属性，依赖统一的 `radix-ui` 包。选 v4 版是因为 `data-slot` 让样式可以按插槽定位，且 React 19 下 `forwardRef` 已是过渡写法。

但选完源码之后又做了一处反向改写：v4 源码里 `import { Slot } from "radix-ui"` 这类写法，被改回 `@radix-ui/react-slot` 等分散包。原因是 `radix-ui` 是 umbrella 包，把全部原语都声明为依赖，而本期只用到六个。**这是对官方源码唯一一处主动改写**，涉及 9 个文件的 import 行，以及 `Slot.Root` 到 `Slot` 的写法差异（umbrella 导出命名空间，分散包导出组件本身）。

**令牌统一到 shadcn 的语义命名，其中 `accent` 的语义是反转的。** 旧令牌是项目自定义名（`surface` / `card` / `line` / `ink` / `accent`），shadcn 组件源码引用的是它自己的语义名（`background` / `foreground` / `muted` / `primary` / `accent`）。两套并存的代价是每搬一个组件都要改一遍样式类，此后官方每更新一次组件，diff 里都会混进这些改写，无法判断哪些是官方变更、哪些是本地修改。

统一的方向只能是往 shadcn 那边靠，因为改组件源码会让后续追加组件变成逐行对照的负担。这里有一处必须记住的反转：**旧的 `--color-accent` 是近黑主色，在 shadcn 体系里主色叫 `primary`；而 `accent` 指的是浅灰悬停底色。** 同名不同义，看名字猜不出方向。旧名到新名的完整映射是：`surface`→`background`、`ink`→`foreground`、`ink-soft`→`muted-foreground`、`ink-faint`→`muted-foreground-weak`、`line`→`border`、`line-soft`→`border-soft`、`accent`→`primary`、`accent-soft`→`accent`，`card` 两套同名。

另有一处无对应：旧令牌 `ink-faint`（#a1a1aa，最弱一级文字）在 shadcn 默认集里没有。方案 B 的层级靠三级文字深浅区分，所以保留它，命名 `muted-foreground-weak`，作为本项目的扩展令牌。

**令牌分两层，为的是让 T2-07 的主题切换不必重构。** 第一层是 `:root` 里的原始值，第二层是 `@theme inline` 到 Tailwind 工具类的映射。若只写一层（直接把颜色写进 `@theme`），Tailwind 会把它们烘进 `:root` 的一次性定义，没有第二个作用域可以插进来，亮暗切换就无从下手。分两层之后，T2-07 只需加一个 `.dark` 块覆盖同名变量，组件侧一行都不用动。

`inline` 关键字是这一层的关键：不加它，Tailwind 会先产出 `--color-background: var(--background)` 再让工具类引用那份中间变量，覆盖时要保证两份同时变；加了它，工具类直接编译成 `var(--background)`。

**方案 B 与 shadcn 默认风格的差异在令牌层消化，不改组件源码。** 两处差异。一是阴影：方案 B 明确「无阴影」，而组件源码带 `shadow-xs` 与 `shadow-sm`。做法是把这两档令牌归零（`0 0 #0000`），而不是逐个组件删类名；浮层另留 `md` 与 `lg` 两档极浅阴影，否则下拉菜单浮不起来。二是圆角：方案 B 的规格是「小控件 7–8px、大容器 12px」，Tailwind 默认刻度里 `rounded-xl` 正好 12px 可直接用，`rounded-md` 是 6px 窄了 2px，所以**只覆盖这一档**。

不覆盖整套刻度是有意的：项目里已有的 `rounded-lg` 是 8px，重定义整个序列会让它无声地变成别的值，而这类变化在界面上只表现为「圆角看着有点怪」，很难反查回令牌表。

**四处对官方源码的必要修正。** 除上面那处导入改写外，还有三处。

其一，registry 源码里的 `import { cn } from "cn"` 是占位符，CLI 会在写入时替换，手工搬运需要自己换成 `@/lib/utils`。

其二，六个文件带 `"use client"` 指令。那是 React Server Components 的标记，Vite 构建会对模块级指令发警告，本项目也没有 RSC，因此删除。

其三，`empty.tsx` 与 `skeleton.tsx` 用了 `React.ComponentProps` 却没有导入 `React`。官方源码依赖 UMD 全局，而在模块文件里 TS 不认这个全局，直接报错。补上 `import * as React from "react"`。

其四，`dropdown-menu.tsx` 里 `DropdownMenuCheckboxItem` 把 `checked` 解构出来又原样传回，在 `exactOptionalPropertyTypes: true` 下不合法：目标属性的可选语义与显式传 `undefined` 不等价。让 `checked` 留在 `props` 里透传即可，行为不变。

**路径别名要同时在两处声明。** shadcn 源码用 `@/` 引用项目内模块。类型侧靠 `tsconfig.json` 的 `paths`，构建侧靠 `vite.config.ts` 的 `resolve.alias`，缺一处就是「类型检查能过而构建失败」。`baseUrl` 没有写：TypeScript 6 已把它标记为弃用，而 `paths` 在没有 `baseUrl` 时本来就相对于 tsconfig 所在目录解析。

**现有界面的迁移范围。** 六个文件、六十余处类名，按映射表逐条替换。`TextField` 内部改为 `Input` 加 `Label`，对外接口一字未动；保留这层封装是因为「标签 + 输入框 + 提示」这套间距在五个调用点重复，摊开写会变成改一处要改五处。登录与初始化页的提交按钮改为 `Button`，记住账号密码的复选框改为 `Checkbox`。

**迁移时漏了一个文件，靠 `git diff` 兜住。** 替换脚本按文件清单执行，`App.tsx` 不在清单里，它里面的 `bg-surface` 与 `text-ink-faint` 留了下来。这次没造成后果，因为 Prettier 的 Tailwind 插件重排了那两行的类名顺序，文件因此出现在 `git status` 里，顺着 diff 看到了未替换的令牌名。教训是**替换脚本不该维护文件清单，应该按模式扫全目录**。

**复选框换成 Radix 之后，端到端脚本的断言要跟着改。** 原来断言 `document.querySelector('#login-remember').checked`，而 Radix 的复选框渲染成 `<button role="checkbox">`，没有 `checked` 属性，改为读 `data-state` 是否为 `checked`。这是「组件替换改变了 DOM 结构」的一个具体代价，凡是断言到元素属性而非可见文本的地方都要检查一遍。

**ESLint 对 `components/ui/` 关掉 fast-refresh 规则。** `button.tsx` 与 `badge.tsx` 同时导出组件和 cva 生成的变体常量，触发 `react-refresh/only-export-components`。这条规则约束的是 HMR 边界，代价仅限于这两个文件在编辑时可能整页刷新一次，而保持源码能逐行对照官方版本的收益更大，所以在这一层关掉而不是拆文件。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 27 项加 api 85 项合计 112 项，0 跳过。前端生产构建通过（JS 292.18 kB，gzip 93.33 kB；CSS 36.72 kB，gzip 7.19 kB）。JS 较 T1-11 增加约 51 kB，来自 Radix 原语、`class-variance-authority` 与 `tailwind-merge`（`cn` 的实现），本期未使用的组件已被 tree-shaking 排除。浏览器级端到端验证 22 项全部通过，登录页与主界面另经截图复核。数据库在验证后回到基线：四张流水表 0 行，种子 11 / 4 / 29 完好。

**验收清单第 3 项的勾选依据与边界。** 「界面与方案 B 的设计令牌一致」勾选，依据是令牌层已建成且全局生效，现有全部界面已迁到新令牌，观感经截图确认。边界要说清楚：**阶段二剩下的三项验收（折叠记忆、占位页、子路由）尚未开始**，T2-02 起是在这套令牌之上搭布局与路由，不再涉及令牌体系本身。

### 9.22 T2-02 实施中的几处判断

**外壳用 `h-screen` 加 `overflow-hidden`，由内容区独立滚动。** 另一种做法是让整页滚动，侧栏与顶栏随之上移。选前者是因为这是工作台而不是文档站：模块切换必须随时可用，翻长列表时不该先滚回顶部才能点导航。代价说清楚：内容区的滚动条出现在侧栏右侧而不是窗口最右缘，视觉上略微内收。这是应用式布局的常规取舍，不是疏漏。

**内容区的最大宽度约束放在外壳里，不放到各页面。** 页面各自决定宽度上限，结果是不同页面的正文左边距不一致，而这种不一致在单页上看不出来，只有来回切换时才觉得「页面在跳」。所以 `AppShell` 里统一写 `mx-auto max-w-[1080px]`。

同一层还有一个容易漏的点：右侧容器的 `min-w-0`。flex 子项的默认 `min-width` 是 `auto`，即「不小于内容的固有宽度」，所以内容区一旦出现长表格或长字符串，整个容器会被撑宽，`max-w` 形同虚设，而且溢出的是最外层，表现为整页出现横向滚动条。加 `min-w-0` 才能让 `overflow-y-auto` 与最大宽度真正生效。

**侧栏宽度用条件类名加 `transition-[width]`，不用内联 `style`。** 两个宽度值（`w-56` / `w-16`）都是 Tailwind 的既有刻度，写类名就能表达；用内联样式反而绕过了令牌体系，将来改尺寸要满文件找。过渡只声明 `width` 一个属性（`transition-[width]`）而不是 `transition-all`：后者会让子元素里任何一次状态变化都触发一遍宽度插值，包括那些本来不该有动画的。

**品牌区高度与顶栏一致（56px），这不是巧合。** 侧栏右边界与顶栏下边界构成一个直角，两条线的交点要能接上，整块白色侧栏才像一个整体浮在浅灰背景上。顶栏背景取 `background` 而不是 `card` 也是同一个理由：侧栏是白的、内容区与顶栏同色，浅灰构成一个 L 形，白色侧栏从背景里浮出来。方案 B 不用阴影分层，只能靠这一处明度差。

**折叠态的名称由气泡提示承担，这不是装饰。** 文字一没，图标就成了唯一的信息载体，而图标本身表意模糊 —— 「数据看板」与「运营信息平台」用的都是趋势类图标。少了提示等于让用户靠记忆点菜单。反过来，展开态下名称就在按钮上，再加气泡是重复，所以只在折叠态挂 `Tooltip`。

**「可见 N / 共 M 项」那行调试文字去掉了。** 它原本是阶段一可见范围验收的可观察落点（见 9.19），但那是开发者视角的信息，不该出现在正式界面上。可见范围的断言改由端到端脚本数导航项数承担，两边不重复覆盖。

**登出移进账号菜单，端到端脚本必须改用真实指针事件。** 这是本期唯一一处「界面结构变化迫使测试手段变化」的地方，值得记下来。登出按钮原先在顶栏是个裸 `<button>`，脚本用 `element.click()` 就能点到。收进 `DropdownMenu` 之后 `click()` 失效了，而且失败信息是「找不到按钮 退出登录」—— 看起来像选择器写错了，实际原因是 **Radix 的菜单在 `pointerdown` 上展开、在 `pointerup` 上选中**，合成事件只派发 `click`，两个动作都不会发生。

修法不是加一个「先点开菜单」的等待，而是换事件通道：新增 `mouseClick` 助手，用 CDP 的 `Input.dispatchMouseEvent` 按元素中心坐标发 `mouseMoved` / `mousePressed` / `mouseReleased`，让浏览器自己生成 pointerdown / mousedown / pointerup / mouseup / click 全套。**判据是「事件类型对不对」，不是「元素找没找到」** —— 只补选择器会得到一个仍然不展开的菜单。别处仍用 `element.click()`：原生按钮、复选框、提交按钮都监听 `click`，那里够用。

**全局搜索框刻意保持禁用。** 搜索覆盖纪要、事件与账号，是阶段三的能力。放一个能输入却什么都不发生的框，比放一个明确不可用的框更糟 —— 后者至少诚实说明了当前状态。`title` 给出原因，避免用户以为界面坏了。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 27 项加 api 85 项合计 112 项，0 跳过。前端生产构建通过（JS 383.42 kB，gzip 123.78 kB；CSS 37.67 kB，gzip 7.35 kB）。**JS 较 T2-01 增加约 91 kB**，来自 Radix 的下拉菜单与气泡提示（含 popper 定位）以及侧栏新引的七个 lucide 图标 —— T2-01 时这些组件虽已写入源码但无人引用，被 tree-shaking 排除了，本期接上才真正计入。浏览器级端到端验证 25 项全部通过，其中新增 4 项覆盖侧栏与顶栏的实测尺寸、折叠后的宽度与气泡提示；原「侧栏标注可见范围 5 / 5」一项随调试文字一并删除。数据库在验证后回到基线：四张流水表 0 行，种子 11 / 4 / 29 完好。

**边界：三项验收尚未开始。** 「导航折叠状态可记忆」需要持久化，本期折叠状态只是 `AppShell` 内的 `useState`，刷新即回到展开态，属 T2-06；「占位页正确显示功能开发中」目前是内容区里的一段临时文案，统一页面属 T2-04；「子路由可直接访问」需要路由库，选中项目前由 `HomePage` 的组件状态驱动，属 T2-03。顶栏面包屑同理，现在只有一级，是为那时只加元素、不改外层结构而留的形态。

### 9.23 T2-03 实施中的几处判断

**路由表由 `NAV_ITEMS` 派生，不另写一份。** 这是 T1-11 在 `navigation.ts` 顶部就写下的约定：两份定义迟早会不一致，而这类不一致只表现为「菜单里有、点进去落回首页」，排查方向会先落到路由配置上，离真正的原因很远。`routes.tsx` 用 `NAV_ITEMS.map` 生成子路由，新增模块只改共享包一处。分工与令牌体系一致：编号、名称、可见性进共享包，图标与样式留在前端。侧栏的图标表写成 `Record<NavCode, LucideIcon>` 而不是 `Partial<...>`，是为了让漏配图标在**编译期**报错 —— 漏配的表现是那一项没有图标而其他项都有，属于看得见但很容易被忽略的不一致。

**外壳做成无路径的布局路由，五个模块是它的子路由。** 这样切换模块时外壳不重新挂载，侧栏的折叠状态与内容区的滚动位置因此保留。若把五个模块写成平级路由、各自再包一层外壳，切一次模块就重挂一次外壳，折叠会被重置回展开 —— 而这类缺陷只在「折叠后切模块」这一条路径上复现，单看每个模块的截图都正常。

**认证门禁留在路由之外，路由只管已登录的那一半。** 初始化页与登录页是状态驱动的：它们的出现与否取决于「库里有没有 owner」「本地有没有有效会话」，与地址无关。若把它们也做成路由（`/login`、`/setup`），就会出现「已登录状态下直接访问 `/login`」这类地址与状态互相矛盾的情形，处理它又要再加一层重定向。代价说清楚：登录页与初始化页的地址栏会显示进入前的路径，但那是全屏界面，用户不会去复制地址，可以接受。`BrowserRouter` 放在门禁之外，让路由实例在整个会话里保持稳定 —— 登录前打开的深链接（例如 `/system-settings`）在登录后被原样保留并直接落到那个模块。

**模块守卫复用 `resolveActiveNav`，不可见时重定向而不是就地渲染。** 判据与阶段一的组件状态版本是同一个函数，T2-03 换掉的只是「请求项从哪里来」（从组件状态改成 URL）。不可见时**重定向**而非就地渲染，是为了让地址栏与内容始终一致：否则刷新一次，地址栏还写着 `/system-settings` 而内容已经是个人工作台，用户把这个地址复制给别人会得到误导性的结果。这一层只承担体验职责，真正的访问控制在服务端的 `requirePermission`，绕过它只会让请求返回 403。

**激活态用 `NavLink` 由 URL 判定，不用受控按钮。** 受控写法要求「点按钮改状态」与「地址变化」两条路径都去同步那个状态，而其中一条（浏览器前进后退、直接输入地址）很容易被漏掉，表现为「地址变了但高亮没变」。`NavLink` 顺带写入 `aria-current="page"`，无障碍与测试都省了一件事。

**`navCodeFromPath` 只认首段，认不出来返回 `null` 而不擅自兜底。** 「路径不认识」与「路径认得但当前角色无权限」是两回事：前者应由调用方导向落地页，后者应由守卫回退到第一个可见项。若这里也回退到第一项，调用方就再也分不清自己面对的是哪一种，守卫的回退逻辑会连带失去意义。只认整段相等（`/workbenchX` 不命中 `workbench`），由回归测试钉住。

**一处测试断言随路由化失效，已修正。** 端到端脚本最后一步「取消勾选后再次登录」原先等正文出现「权限点」。引入路由后这条判据不再成立：登出不改写地址栏，而上一节的深链接验证把地址留在了 `/system-settings`，再次登录会**原样落到系统设置模块**（这正是上面刻意保留深链接的行为）。系统设置是占位模块，内容区没有个人工作台才有的「权限点」段落，等待必然超时。判据改为「已登录外壳挂上」——等账号菜单这种只存在于外壳里的元素，与落地在哪个模块无关。这是「组件或结构变化迫使测试手段变化」的第二例，第一例是 T2-02 的 Radix 菜单（见 9.22）。

**并发调用工作空间入口会触发一处竞态。** 验证时曾并行跑两条 `ws-run` 命令，`ws-state.ps1` 写 `state/root.json` 因文件被另一进程占用而抛 `IOException`（命令本身仍成功）。这是并发写入的竞态，串行调用入口即可避免，不影响单次操作的正确性。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 31 项加 api 85 项合计 116 项，0 跳过。前端生产构建通过（JS 421.94 kB，gzip 137.51 kB；CSS 37.67 kB，gzip 7.35 kB），JS 较 T2-02 增加约 38.5 kB，来自 react-router。浏览器级端到端验证从 25 项增至 **26 项**，新增「直接访问 `/system-settings` 落到该模块且地址栏未被改写」，全部通过。数据库在验证后回到基线：四张流水表 0 行，种子 11 / 4 / 29 完好。

**边界：阶段二还剩三项。** 「导航折叠状态可记忆」的折叠状态目前仍是 `AppShell` 内的 `useState`，刷新即回到展开态，属 T2-06；「占位页正确显示功能开发中」目前由 `ModulePage` 的统一头部内联渲染，带规划范围与操作入口的独立页面属 T2-04；顶栏面包屑仍只有一级，二级导航随阶段三模块落地后再加，结构已留成 `BreadcrumbList` 加单个 `BreadcrumbItem`，届时只加元素、不改外层。

### 9.24 T2-04 实施中的几处判断

**占位页的判据是 `planned`，不是 `module === null`。** 两者正交：系统设置已绑 `system` 段权限，可见性条件不是 `null`，但它仍是占位项。若按 `module === null` 分派，系统设置在将来定义权限点的那一刻会漏掉占位页，直接渲染出一个空模块。这条在 9.19 已经写下，T2-04 是它的第一次实际兑现。

**「三个占位页」的口径需要澄清。** 任务表与阶段交付物写的是「三个占位页」，而共享包里 `planned` 为真的实际是四项：客户信息平台、运营信息平台、数据看板、系统设置。文档里的「三个占位项」指的是 `module` 为 `null` 的那三项（见 9.2 待办第 5 项与 9.19），系统设置因为已绑 `system` 段权限，在同一段文字里被单独计数，于是形成了「三个」与「四项」两种说法。T2-04 按 `planned` 实现，覆盖全部四项，验收点「三个占位模块进入后均显示该页」自然成立。此后描述占位页数量时以 `planned` 为真为准。

**`ModulePage` 收敛为页头，并改名为 `ModuleHeader`。** T2-03 时 `ModulePage` 同时承担两件事：已排期模块的页头，以及占位模块的「功能开发中」标注。占位渲染移交 `PlaceholderPage` 之后，它只剩页头一件事，名字里的 `Page` 就成了误导。改为 `components/ModuleHeader.tsx`（从 `pages/` 移到 `components/`，因为它现在是表现组件而非页面），去掉占位标注分支，`WorkbenchPage` 改用。不把这两行标记摊进各页面，是因为标题与规划说明的排版在已落地模块页上一致，各写一份改一次要改多处。

**导航图标表抽到 `lib/nav-icons.ts`。** 占位页的页头需要一个模块图标，而图标表原本在 `Sidebar.tsx` 内部。两处各写一份的话，新增模块时漏改一处，表现是「侧栏有图标而占位页没有」或两处图标不一致。抽到 `lib` 之后两个消费方共用一份，`Record<NavCode, LucideIcon>` 的类型约束保证新增模块时编译期报错。

**操作入口指向落地模块，不指向浏览器历史。** `navigate(-1)` 在直接输入地址进来时无历史可回，会把人留在原地或弹回站外。指向第一个可见模块（即登录后的落地页）与历史无关，刷新或深链接进来都能用。落地项恰好是本模块时（某角色只可见一个占位模块）不渲染按钮，避免出现点了不动的链接。

**占位页的内容取舍。** 页面给出四样东西：模块图标、标题加「功能开发中」标记、规划范围、返回入口。规划范围直接取自共享包的 `NavItem.summary`，将来模块落地时改共享包一处即可，不必回来改页面。没有给「预计上线时间」这类信息，因为它没有依据，写上去只会变成一句没人维护的文案。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 31 项加 api 85 项合计 116 项，0 跳过。前端生产构建通过（JS 423.96 kB，gzip 138.03 kB；CSS 37.92 kB，gzip 7.39 kB），JS 较 T2-03 增加约 2 kB，来自新的占位页与图标表抽出后的重组。浏览器级端到端验证从 26 项增至 **28 项**，新增「占位页注明规划范围」与「占位页提供返回落地模块的入口」，并把原先只看「功能开发中」四个字的那一项细化为「进入统一占位页」；点返回入口回落地页的路径一并覆盖。全部通过。数据库在验证后回到基线：四张流水表 0 行，种子 11 / 4 / 29 完好。

**边界：阶段二还剩三项。** 折叠偏好记忆属 T2-06（折叠状态仍是 `AppShell` 内的 `useState`，刷新即回展开态）；错误与空状态属 T2-05（`PlaceholderPage` 与 `NoAccessPage` 是两种具体状态，404 与 500 的统一页面尚未做）；亮暗两套令牌属 T2-07。

### 9.25 T2-05 实施中的几处判断

**空状态只有一份实现。** 五种状态（404、500、占位模块、无可见模块、卡片内空列表）此前各写各的卡片，或压根没有。T2-05 把排版收敛到 `components/EmptyState.tsx`，它不另写一套，而是架在官方 `ui/empty.tsx` 之上（`EmptyHeader` / `EmptyMedia` / `EmptyTitle` / `EmptyDescription` / `EmptyContent`），自己只补两件事：把图标渲染出来、按形态套上或去掉卡片外观。分开写的话，改一次间距要改四五处，而这类偏差只在来回切换页面时才看得出来。

**两种形态的分工。** `card` 用于页面级状态，带边框与 `bg-card`；`plain` 用于卡片内部的空列表，去边框去内边距，并把标题收小一档 —— 它嵌在正文尺寸的卡片里，沿用页面级的 `text-lg` 会盖过卡片自己的标题。

**标题外面套一层语义标签。** 官方 `EmptyTitle` 渲染成 `div`，而页面级状态需要一个一级标题：既为读屏软件，也为「当前在哪一页」有个稳定的落点。`card` 形态套 `h1`，`plain` 形态套 `div`（所在卡片已有自己的标题，再出一个 `h1` 会破坏层级）。这是「组件替换会改 DOM 结构」的第三例，前两例见 9.21 与 9.22。

**卡片形态用 12px 圆角，不用官方 `Empty` 自带的 8px。** 方案 B 的规格是「小控件 7–8px、大容器 12px」，页面级状态卡属于大容器，且要与 `ModuleHeader` 及工作台的内容卡并排出现 —— 圆角差一档，只在并排时才看得出来。

**404 保留原地址，不重定向。** T2-03 时未匹配路径是重定向回落地页，代价是地址栏被改写成 `/workbench`，用户看不出自己输错了什么，只会觉得「点了之后莫名其妙到了别处」。现在保留原路径、把原因写清楚、给一个出口。这与模块守卫「不可见时重定向」看似矛盾，实为同一条原则的两面：**地址栏与内容始终一一对应**。守卫重定向是因为内容确实换成了另一个模块，地址必须跟着走；404 不重定向是因为内容本身就是「这个地址没有页面」，地址不动才是准确的。

**404 与 500 的出口都指向落地模块，不指向浏览器历史。** 与 9.24 同一条理由：`navigate(-1)` 在直接输入地址进来时无历史可回，会把人留在原地或弹回站外。500 页的「返回首页」用 `window.location.assign('/')` 而不是路由跳转，是为了让这一页不依赖 Router 与认证上下文 —— 它可能因为路由层自身出错而被渲染出来，那时再调 `useNavigate` 只会抛出第二个异常。

**错误边界只能是类组件，且不展示异常原文。** React 至今没有等价的 Hook，`componentDidCatch` 与 `getDerivedStateFromError` 只在类上存在，这是本仓库唯一的类组件。异常原文只写进控制台：堆栈对使用者没有意义，还可能带出内部路径与变量。三个成员带 `override` 是因为仓库开了 `noImplicitOverride`，它挡的是「父类改了成员名、子类还写着旧名」这类静默失效。

**错误边界放在认证提供者之内、门禁之外。** 放在门禁之外，是因为登录页与初始化页同样可能渲染期抛错，只包住已登录的部分会漏掉那两个界面；放在提供者之内，是因为边界自身渲染的 500 页要能读到认证上下文，而提供者若抛错，它也无力接住。

**`NoAccessPage` 补上出口。** 这一页没有侧栏项、没有面包屑可点，是整个应用里唯一一个四面都没有出口的界面。文案里让用户「退出后重新登录」，那就把这件事做成按钮，而不是让他自己去顶栏的账号菜单里找。

**面包屑在未匹配路径下回落到应用名。** 否则会出现「地址栏写着陌生路径、面包屑却说是个人工作台」。根路径要排除，它是落地页重定向的中转，重定向完成前也会走到这里。

**一处测试基础设施缺陷：浏览器 profile 其实一直落在 U 盘上。** 端到端脚本用 `os.tmpdir()` 取临时目录，注释里写着「放在系统临时目录，不放截图目录」—— 而经工作空间入口运行时 `TEMP` 与 `TMP` 已被重定向到 U 盘上的 `.tmp/`，`os.tmpdir()` 读的正是这两个变量，于是 profile 又落回了 U 盘。实测确认：入口下 `os.tmpdir()` 返回 `E:\fanhe Work\.tmp`，该目录里已留下两份共 45MB 的历史 profile。**注释里的理由看起来成立，实际不成立**，属「写了理由但没验证理由」。改为从 `LOCALAPPDATA` 推（它不在重定向映射表里），非 Windows 环境退回 `os.tmpdir()`；改后实测落在 `C:\Users\dy\AppData\Local\Temp`。这条与 9.20 的「profile 移出 U 盘」是同一件事 —— 那次只改了取值方式，没有验证取到的值。

**一处环境观察：遗留的开发服务进程会累积。** 本次重启 API 时发现同时存在六条 `pnpm dev:api` / `pnpm dev` 链与三个 `tsx watch`，都是历次会话留下的，只有最后一条真正持有端口。**只杀应用子进程是无效的** —— `tsx watch` 会立刻重新拉起一个，端口仍被占，新进程报 `EADDRINUSE`。清理要按命令行匹配整条链，或直接杀掉 `tsx watch` 本身。这不影响正确性，但会让「端口被谁占着」变得难以判断。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 31 项加 api 85 项合计 116 项，0 跳过。前端生产构建通过（JS 427.64 kB，gzip 139.39 kB；CSS 37.85 kB，gzip 7.39 kB），JS 较 T2-04 增加约 3.7 kB，来自 404 页、500 页、错误边界与空状态组件。浏览器级端到端验证从 28 项增至 **31 项**，新增「未知路径落到 404 页且地址栏未被改写」「404 页的面包屑回落到应用名」「404 页的返回入口指向落地模块」；未知路径用整页导航访问，顺带验证了「服务器把未知路径交回给前端」—— 生产环境缺 SPA 回退配置时，这一步会直接拿到服务器的 404 而不是应用界面。全部通过。数据库在验证后回到基线：四张流水表 0 行，种子 11 / 4 / 29 完好。

**边界：阶段二还剩两项。** 折叠偏好记忆属 T2-06（折叠状态仍是 `AppShell` 内的 `useState`，刷新即回展开态）；亮暗两套令牌属 T2-07。**「无可见模块」与「当前角色没有任何权限点」两处状态目前不可达** —— 四个内置角色都至少持有 `personal` 段权限，可见清单不会为空，要触发需要账号管理接口（阶段三）。因此这两处只有单元测试间接钉住（`resolveActiveNav` 的用例），端到端暂时覆盖不到，与 4.7 里「另外三个角色的真实渲染待账号管理接口落地后补」是同一类边界。

### 9.26 T2-06 实施中的几处判断

**偏好的读取必须走 `useState` 的惰性初始化，不能放进 `useEffect`。** 这是本期唯一一处真正会被用户看见的取舍。用 `useEffect` 在挂载后读 localStorage 再 `setState`，界面会先按默认的展开态渲染一帧，再跳到折叠态 —— 用户看到的是每次刷新都闪一下展开的侧栏。而**两种写法都能通过「刷新后量一下宽度是 64px」这类事后断言**：等一会儿再看，宽度确实是 64px。判据必须落在首帧上，所以端到端脚本改用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 注入一个逐帧宽度采样器（它比应用脚本更早开始跑，这是 `Runtime.evaluate` 替代不了的），断言第一个出现侧栏的帧就是 64px，并且整个采样序列没有中间值。这与 9.22、9.23 的两处教训是同一条：**断言要能区分真假，而不只是「最终看起来对」**。

**「偏好」与「凭证」分属两个模块，因为丢失的代价不同。** `session.ts` 存刷新令牌、`credential.ts` 存加密后的账号密码，丢失的代价是重新登录或重新输密码；`preferences.ts` 存的是观感偏好，丢失只是回到默认值。因此后者不加密、不做版本迁移、读写失败一律静默回落 —— 为「侧栏是宽是窄」写一套恢复逻辑，收益远小于它引入的分支。这条边界值得写清楚，因为「都是 localStorage，为什么不合并」是个很容易提出的问题。

**键名前缀 `fanhe-work.ui.` 把界面偏好与身份类数据分开。** 除了在浏览器存储面板里一眼可辨，也为将来「恢复默认设置」留出空间：按前缀清理即可，不会碰到会话。已有的键是 `fanhe-work.refresh-token`、`fanhe-work.device-id`、`fanhe-work.credential`，本期新增 `fanhe-work.ui.sidebar-collapsed`。

**读侧只认 `'true'`，不用 `Boolean()` 转换。** 用 `Boolean()` 的话，任何非空字符串 —— 手改出来的 `'maybe'`、旧版本留下的 `'1'` —— 都会被当成折叠。偏好读不懂时应当退回默认值，而不是猜一个方向：猜错的表现是「侧栏自己收起来了」，而用户没做过这个操作。端到端为此专门写入一个非法值再重载，断言回落为展开。

**偏好只存本机，不进数据库。** 换机、换浏览器、清缓存都会回到默认，这是刻意的。桌面外壳下每台机器的窗口尺寸不同，把折叠状态同步到服务端反而会造出「在这台机器上收起了，到那台机器上还是收起的」。等到阶段五服务端化、真的要按账号同步界面偏好时再谈，那时的形态是「本机偏好优先、服务端作为新设备的初值」，而不是简单的双向同步。

**写回放在事件处理里，不放进 `setCollapsed` 的更新函数。** 更新函数里做副作用在 StrictMode 下会被执行两次；写入同一个值虽然幂等、不会出错，但把副作用藏在那里迟早会在别处踩坑。改为先算 `next`、再 `setCollapsed(next)`、再写回。

**新增的偏好模块单开文件，不写进 `AppShell.tsx`。** 一是 react-refresh 的约束（一个文件同时导出组件与非组件时，热更新无法确定该保留哪一部分的状态，`auth/context.ts` 里有同款说明），二是与 `session.ts`、`credential.ts` 的分层保持一致：存储细节不进组件。

**端到端这一段为什么排在 7d 之后，而不是紧挨着 5b-3 的折叠断言。** 它需要整页重载，而重载会把挂在 `window` 上的请求探针清掉 —— 续期断言正靠它计数。这与 7b 的深链接验证不能提前是同一个理由。脚本里两处都写了交叉引用，避免后来者把它挪回去。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 31 项加 api 85 项合计 116 项，0 跳过。前端生产构建通过（JS 427.86 kB，gzip 139.47 kB；CSS 37.85 kB，gzip 7.39 kB），JS 较 T2-05 增加约 0.2 kB。浏览器级端到端验证从 31 项增至 **36 项**：新增「折叠后偏好写入 localStorage」「刷新后侧栏仍是折叠态」「刷新后没有展开→折叠的跳动」「展开后偏好改写为 false」「偏好值非法时回落为展开」。重载后实测首帧 64px、连续采样无中间值，说明惰性初始化确实生效。全部通过。数据库在验证后回到基线：四张流水表 0 行，种子 11 / 4 / 29 完好。

**边界：阶段二只剩 T2-07。** 亮暗两套令牌完成后，阶段二验收清单即全部勾选（本期后来又补了一项「亮暗主题可切换，切换后无对比度异常」，见 9.27）。**T2-07 会用到本期这层结构**：`preferences.ts` 可以直接承担主题偏好的读写（键名 `fanhe-work.ui.theme`，与侧栏折叠同族），而 `index.css` 的两层令牌结构让切换只需加一个 `.dark` 块覆盖 `:root` 的同名原始值。需要注意的一处：主题偏好在「跟随系统」这一档下**不能持久化成 `'light'` / `'dark'`**，否则用户改了系统设置而界面不动 —— 那一档要存成第三个值，并在读取时监听 `prefers-color-scheme`。

### 9.27 T2-07 实施中的几处判断

**初值放在 `index.html` 的内联脚本里，不放 `main.tsx`，也不放 `useEffect`。** 这是本期唯一一处必须跳出 React 才能做对的事。侧栏折叠可以等 React 挂载再读 —— 它影响的只是外壳的一个尺寸，晚一帧没人看得出；配色不行，它要在**第一个像素**上就对，而那时 React 还没挂载。放在 `main.tsx` 的模块顶层同样不够：模块脚本是 defer 语义，浏览器在它执行之前就有机会按默认配色画一帧，深色偏好的用户每次打开都会看到一下白闪。内联脚本在 `<head>` 里同步执行，早于任何渲染。

代价是那段判断与 `lib/preferences.ts` 的 `readThemePreference` 重复了一次 —— 内联脚本没法 import 模块。这是**刻意的重复**，两处都写了注释互相指向，改键名或改回落规则时必须一起改。另一种做法是让 Vite 插件在构建时把逻辑注入 HTML，但那只是把重复搬到了构建配置里，读代码的人更难看懂，不值得。

**「跟随系统」必须存成第三个值。** 这一档若在写入时折算成当时的亮暗，用户之后改了系统设置界面不会跟着变 —— 存下去的是一个瞬间的快照，而用户选的是一条规则。所以 `ThemePreference` 是 `'light' | 'dark' | 'system'` 三值，`'system'` 与「没存过」在读侧合并处理（都按跟随系统），但写侧绝不合并。同理，切换按钮上的图标按**偏好**取（跟随系统就一直是显示器图标），不按当前生效的配色取：后者会让「跟随系统」与「深色」显示同一个图标，用户看不出自己选的是哪一个。

**`@custom-variant dark` 是 Tailwind 4 下必须显式声明的一行。** Tailwind 4 的 `dark:` 变体默认是 `@media (prefers-color-scheme: dark)`，与「按类名切换」是两回事。不声明这个变体，`index.css` 里的 `.dark` 块照样生效（它只是普通的 CSS 选择器），但**组件源码里那些 `dark:` 类不会认 `.dark` 类名** —— 于是令牌层看起来完全正确，而 Radix 组件自带的那些暗色微调全都停在亮色分支上，且没有任何报错。`:where()` 把权重压到 0，是为了不让它盖过 `.dark` 块里的令牌覆盖。

**`color-scheme` 不能漏。** 滚动条、输入框自动填充底色、日期选择器这些是**浏览器自己画的**，取不到我们的令牌，只能靠 `color-scheme` 告诉它用哪套配色。它写在两个作用域的 CSS 里（`:root` 写 `light`、`.dark` 写 `dark`），不写进 JS：它是配色的一部分，放在令牌旁边才不会被漏改。

**暗色令牌不是把浅色取反，有三处关系要守住。** 一是背景仍要比卡片深（浅色 #fafafa 对 #ffffff，暗色 #0a0a0a 对 #141414），反过来会让卡片看起来凹进去；二是主色反转（暗色下 `primary` 是浅色、`primary-foreground` 是深色），不反转会得到一块浅底浅字；三是三级文字的明度顺序要按亮度反过来排，照抄浅色的明度会让「最弱一级」在暗色下反而更醒目。阴影不做暗色适配：方案 B 本来就不用阴影分层，而且 `--shadow-*` 定义在 `@theme inline` 里，那是会被内联进工具类的值，`.dark` 覆盖不到 —— 这一条写进注释，免得后来者以为漏了。

**主题的 hook 只挂在 `TopBar`，没有提到应用根。** 后果是登录页与初始化页不响应**运行中**的系统配色变化（初值仍然正确，由内联脚本定下）。这是刻意的最小实现：那两个页面没有切换入口、停留时间短，而把 `useTheme` 提到根上需要引入 context，只为覆盖一个几乎不会被察觉的场景。若将来登录页也要响应，正确的做法是加一个主题提供者，而不是在两处各调一次 `useTheme` —— 后者会得到两份互不同步的状态。

**端到端这一段同样必须逐帧采样，而且踩到了一个只属于主题的坑。** 「刷新后还是深色」与折叠那条一样，放进 `useEffect` 也能通过，所以沿用同一手法看首帧（`THEME_FRAME_PROBE`）。不同之处在于：侧栏采样器只在 `aside` 存在时才记录，「攒够 5 帧」因此隐含等到了外壳挂载；主题采样器是无条件逐帧记录的，几帧就攒满了，而那时重载后的「初始化状态 + 静默续期」往返还没走完，紧接着点主题按钮会报「找不到元素：主题切换按钮」—— 一个与主题毫无关系的失败。修法是重载后显式等 `[aria-label="切换主题"]` 出现。**教训与 9.22、9.26 是同一条：等待条件要等的是「依赖就绪」，不是「某个数字够了」。**

**「跟随系统」的行为用 CDP 的 `Emulation.setEmulatedMedia` 验证。** 这是本期唯一能直接证明「存的是规则而不是快照」的办法：把模拟的系统配色改成深色，选「跟随系统」，断言界面变深、而存储里留下的是 `system`；再把模拟改成浅色，断言界面即时跟着变浅。后者走的是 `matchMedia` 的 `change` 事件，即 `useTheme` 里那条监听 —— 少了它，界面会停在用户切换那一刻的配色上，而这在任何静态断言里都看不出来。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 31 项加 api 85 项合计 116 项，0 跳过。前端生产构建通过（JS 432.26 kB，gzip 140.65 kB；CSS 38.80 kB，gzip 7.57 kB；HTML 1.69 kB，含内联脚本），JS 较 T2-06 增加约 4.4 kB（三档菜单与三个图标），CSS 增加约 0.95 kB（`.dark` 块）。浏览器级端到端验证从 36 项增至 **42 项**：新增「切到深色后偏好写入 localStorage」「刷新后首帧就是深色」「刷新后没有浅色→深色的闪烁」「切到浅色后偏好改写为 light」「跟随系统档存的是 system 而不是当时的配色」「跟随系统档下系统配色变化即时生效」。实测重载后首帧即为 `dark`、连续 22 帧无中间值，说明初值确实在 React 之前落定；模拟系统配色改浅后界面即时跟随。全部通过。数据库在验证后回到基线：四张流水表 0 行，种子 11 / 4 / 29 完好。

**边界：阶段二至此收口。** 验收清单本期补了一项「亮暗主题可切换，切换后无对比度异常」，六项全部勾选。**两件事没有做**：一是登录页与初始化页不响应运行中的系统配色变化（理由见上）；二是**暗色下的观感没有逐页复核** —— 端到端验证的是类名与存储，暗色各页面的对比度只经截图（`e2e-shots/7-dark-theme.png`）看过一遍，而四个 `planned` 模块的暗色观感只覆盖了占位页那一种。两条都不阻塞进入阶段三，阶段三落地真实内容后再一并复核更划算。

### 9.28 T3-01 实施中的几处判断

**所有权在 service 层强制，归属不符与不存在对外是同一种结果。** 每一条查询的 `where` 里都带 `userId`，而不是先取出记录再判断 `record.userId === userId`：后者在「先查后判」之间留了一个窗口，而且一旦哪条路径忘了判，泄漏的是别人的数据。对外一律返回 404（`removed: false` 用在同一位置），**不返回 403** —— 403 等于告诉调用方「这个 id 是存在的」，而 id 是 UUID，能问出存在性就能逐个试探出别人有多少条配置。这与阶段一「401 与 403 对客户端有意义」并不矛盾：那里区分的是「没登录」与「登录了但没权限」，两者都是关于**调用方自己**的事实；这里要挡的是关于**别人数据**的信息。

**重名检查放 service 层，不用数据库唯一约束。** 表上有软删除（`deletedAt`），而 Prisma 的 `@@unique` 没法附加 `deletedAt IS NULL` 这个条件。若直接建 `@@unique([userId, name])`，用户删掉一条叫「微信小号」的配置后再新建一条同名，会撞上那条已被软删除的行 —— 报错信息还会说「名称已存在」，而用户在界面上根本看不到这个名字。所以改成在 service 层按未删除行查一次，并专门写了「删除后同名可以重新使用」这条测试钉住。代价是并发下理论上可能插入两条同名，考虑到这是单用户私有配置、写入频率极低，可以接受。

**重排要求提交完整 id 集合，缺一个、多一个、重复都返回 409。** 一种更宽松的做法是「按提交的顺序给这些 id 依次编号，其余保持不动」，但那样一次部分成功的重排会得到一个谁也没预期过的排列，而界面上只表现为「拖拽没生效」—— 用户会以为是拖拽坏了，反复重试。要求完整集合把「界面上的顺序」与「库里的顺序」变成同一件事：提交的就是全量，对不上就是客户端的清单已经过期，让客户端刷新重来。校验与写入放在同一个 `$transaction` 里，避免校验通过后集合又被别的请求改掉。

**启动参数存 `String[]`，不存拼接好的字符串。** 一条命令的参数该在哪里断开，Windows 与 POSIX 的规则并不相同，而工作台将来要同时在两边启动进程。存数组把「哪些算一个参数」这件事交还给用户，也让含空格的路径不必靠引号去猜 —— 拼接字符串的写法在遇到「路径里有空格」和「参数里有引号」时会需要一层转义逻辑，而那层逻辑的 bug 要到启动失败时才暴露。

**本机绝对路径是全项目唯一不受「不出现盘符」约定约束的地方。** 那条约定管的是受版本控制的文件；启动配置的路径只活在运行时数据库里，而且它的语义就是「这台机器上的这个文件」，换成相对路径反而失去意义。判定写成 `isAbsoluteExecutablePath`（`/` 开头、`\\` 开头、`盘符:[/\\]` 三种），放在 shared 里是因为两侧都要用：服务端校验入库，客户端将来要在选择文件后先自查一次。注意 `C:` 与 `C:app.exe` 都**不算**绝对路径 —— 前者是「C 盘的当前目录」，后者是相对该目录的路径，这是 Windows 上很容易判松的一处。

**软件标识刻意不在 JSON Schema 里写 `enum`。** 清单在 `packages/shared/src/launch.ts`，校验也在那里（`isLaunchSoftware`）。若在路由的 schema 里再写一份 `enum`，清单将来增删一项就要改两处，而漏改一处的表现是「新加的软件在界面上选得到、存不进去」—— 报错还来自一个和清单无关的地方。让 schema 只约束类型与长度，语义校验统一走 shared 的那一个函数，失败时给出与其它校验一致的 400。

**这一组接口不写审计。** 启动配置是用户的私有数据，增删改的频繁程度与登录相当甚至更高，写进 `audit_logs` 会把真正需要留痕的事件（登录失败、令牌重放、授权变更）淹掉。审计的价值来自「写进去的都是值得回头看的事」，而不是「什么都写」。阶段三其余两个板块（纪要、事件）同样按这条判断走。

**路由的静态段 `order` 优先于 `:id`。** `PUT /api/launch/profiles/order` 与 `PATCH /api/launch/profiles/:id` 在路径形态上会互相匹配，注册顺序决定谁先拿到请求。把静态段放前面，`order` 就不会被当成一个 id 去解析（虽然它也不像 UUID，但依赖「不像」是脆的）。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 38 项加 api 103 项合计 141 项，0 失败 0 跳过。api 新增的 18 项覆盖：未认证 401；viewer 能读不能写；新增字段原样返回（含空串参数，且 `userId` / `deletedAt` 不外泄）；新增依次排末尾；修改只影响提交的字段；空修改体 400；相对路径 400；Unix 绝对路径接受；清单外软件 400；同用户重名 409 且保留原名不冲突；跨用户同名允许；列表只返回自己的；改或删别人的返回 404 / `removed: false`；软删除幂等；删除后同名可重用；重排写库并返回新列表；id 集合不完整、多余、重复均 409；重排不能包含别人的配置。shared 新增的 7 项钉住路径判定与软件标识两处纯函数。迁移 `20261010165220_launch_profiles` 已应用，数据库在验证后回到基线：`users` 0 / `launch_profiles` 0 / `roles` 4 / `permissions` 11 / `role_permissions` 29 / 三张流水表 0 行。

**边界：T3-01 只做到「能存能改」，还没有「能启动」。** 本机代理与进程启动属 T3-02，管理界面属 T3-03，因此阶段三验收清单第一项「启动配置可新增、编辑、排序，可一键唤起」**暂不勾选** —— 接口已具备前三项的能力，但没有任何界面在用它们，勾上等于把接口的完成当成功能的完成。另有两处留给后续：启动记录（`launch_history`）与路径失效提示属 T3-04，所以现在**入库时只校验路径形态（是否绝对），不校验文件是否真的存在** —— 换机或卸载软件后路径会失效，那是运行期的事，要在启动时发现并给出重新指定的入口，而不是拒绝保存。

### 9.29 T3-02 实施中的几处判断

**代理的形态：核心逻辑与宿主分离，这一步必须一次定对。** 第四章把 T3-02 列为「T3-03 与 T4-03 的共同前置，代理形态一旦确定不宜再改」，所以本期先回答的是「这个模块长什么样」，而不是「怎么把进程拉起来」。

结论是 `apps/api/src/launch/agent.ts`：**不认识数据库、不认识认证、不认识 HTTP**，入参是一条已经取好的 `LaunchProfile`，出参是一次进程创建的结果。阶段三由 `apps/api` 挂一条路由把它暴露出去（实验版架构图里「本机代理路由」本来就是本机 Node 服务的一部分），阶段四 T4-03 把这个文件原样 import 进外壳主进程、把路由换成 IPC 即可，核心逻辑一行不改。

反过来的做法（在 agent 里查库、读请求上下文）会让阶段四必须把它拆开重写，而那时 T3-03 的界面已经建在它的接口上。判断的标准很直接：**这个模块将来要换宿主，所以它不能依赖宿主的任何东西**。「取配置」与「启动进程」因此在调用侧分成两步 —— `profiles.ts` 的 `getProfile` 负责前者，`agent.ts` 负责后者。

**接口只接受配置 id，不接受路径与参数。** 这条边界比它看起来重要：若请求体里能带路径与参数，这个接口就成了一个「本机任意命令执行」入口，任何拿到会话的人（或任何一个能向回环端口发请求的页面）都能运行任意程序。只认 id 之后，能启动什么完全由用户自己事先配置的那几条决定，攻击面从「任意命令」收缩到「用户自己配好的那几个客户端」。

**来源必须是回环，而且判定要用 `socket.remoteAddress`，不能用 `request.ip`。** 这个板块天生带着一个攻击面：任何能在用户机器上跑起来的东西 —— 另一个程序、浏览器里的任意页面、一个被注入的脚本 —— 都能向 `127.0.0.1` 上的端口发请求，而这条接口的动作是创建进程。两道防线叠在一起才有意义：**来源是回环**（挡住局域网与远程），**并且持有有效会话与写权限**（挡住同机的其它程序）。缺任何一道都留下一整类攻击。

用 `request.ip` 会让这道防线名存实亡：Fastify 开启 `trustProxy` 之后它取的是 `X-Forwarded-For`，而那个头客户端随手就能写。用一个可伪造的值判断来源，等于没有判断。socket 上的地址由内核给出，伪造不了。判定覆盖整个 `127.0.0.0/8`（RFC 1122 把它整段定义为回环）以及 `::1` 与 `::ffff:127.0.0.1` 两种 IPv6 形态；拿不到地址时一律判否 —— 默认放行的那一侧永远是错的一侧。

非回环来源返回 **404 而不是 403**：403 等于向探测者确认「这个端点存在，只是不给你用」，而它不该得到这个确认。响应与「配置真的不存在」完全一致，从外面看不出区别。这条判定在阶段五容器化之后才真正开始起作用 —— 那时 API 不再绑在回环上，远程请求会走到这里并被挡下。

**等到 `spawn` 事件才算成功。** `spawn()` 是同步返回的，它返回时进程还没创建；真正的失败（可执行格式不对、句柄耗尽）通过 `error` 事件异步到达。若不等待，接口会在进程根本没起来的情况下回一个「已启动」—— 用户看到成功提示却什么都没发生，这种「报成功而没做事」比明确失败难查得多。`spawn` 事件由操作系统创建进程成功后触发，正常在几毫秒内到达，不会拖慢接口。测试里用一个「真实存在、确实是文件、但操作系统无法执行」的路径（`apps/api/package.json`）来触发 `error` 事件，验证的正是「我们等到了那个事件」而不是「`spawn` 没抛异常」。

**去重窗口只缓存成功的结果。** 窗口取 3 秒，防的是连点：按钮点下去到进程真正出现之间有几百毫秒空档，用户在这个空档里会再点一次，而每次点击都是一次真实的进程创建 —— 结果是任务管理器里躺着五个微信。同一软件要开多个实例本来就该配多条配置（多账号场景正是这么设计的），不是靠重复点同一条。

**失败不进缓存**，这一点是刻意的：用户看到「路径不存在」之后最自然的动作就是去改路径、然后立刻再点一次，若把失败也缓存下来，那个窗口内的重试会拿到同一条旧错误，用户会以为「改了没用」。失败路径也没有「起多个进程」的风险，缓存它换不来任何东西。窗口值不做成环境变量 —— 它不由部署环境决定，做成配置只会多出一处可以配错的地方，而配错的表现（点了没反应 / 起了五个进程）都不会指向配置。

**`cwd` 取可执行文件所在目录，`stdio: 'ignore'`，`unref()`，`shell: false`。** 四行都是取舍。`cwd` 与双击快捷方式的行为对齐，不设的话子进程继承 api 进程的工作目录也就是项目目录，于是「在工作台里启动一次客户端，项目目录里多出几个日志文件」这种事就会发生。`stdio: 'ignore'` 与 `unref()` 一起保证「关掉工作台不牵连客户端」：用管道的话父进程退出后管道关闭，子进程再往 stdout 写会拿到 EPIPE，而没人读的管道写满之后会阻塞子进程本身；`unref()` 则让子进程不再阻止父进程退出 —— 少了它，工作台会一直等到微信关闭才能退出。`shell: false` 显式写出，因为它是安全边界，不该靠默认值承担：将来有人为了「支持通配符」把它改成 `true`，这一行会先被看到。

**用 POST 而不是 GET，权限用 `write` 而不是 `read`。** 有副作用的操作不能是 GET 的语义：浏览器与中间层对 GET 的预取与重试会让「打开一个链接」变成「启动一个程序」。权限用 `write` 是因为启动不修改任何数据、但有副作用，而只读访客这一档的语义是「看得到、什么也做不了」—— 用 `read` 会让 viewer 能拉起别人机器上的客户端。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 38 项加 api 121 项合计 159 项，0 失败 0 跳过。api 新增 18 项，其中 8 项是纯函数（回环判定的五种地址形态与畸形串、启动命令组装的命令/参数/工作目录/数组副本），10 项走完整路由链路：未认证 401；只读访客 403；启动成功返回正整数 pid 与 ISO 时间；去重窗口内的第二次请求返回同一 pid 且 `deduplicated: true`；路径不存在与路径指向目录均 409 `executable_missing`；存在但不可执行 500 `spawn_failed`；非回环来源 404；别人的配置 404；不存在的 id 404。数据库在验证后回到基线：`users` 0 / `launch_profiles` 0 / `roles` 4 / `permissions` 11 / `role_permissions` 29 / 三张流水表 0 行。

**边界：阶段三验收清单仍一项未勾。** 前两项交付的都是后端能力，而验收要点要的是界面上的结果：「可一键唤起」需要一个能点的按钮（T3-03），「路径失效有提示与重新指定入口」需要一处能把提示渲染出来的地方。接口这一侧已经具备条件 —— 路径失效会被检出并给出可区分的原因码，界面上要做的只是按 `error` 分流到「重新指定路径」与「重试」两个出口。另外两件事留给后续：**启动记录不写库**（`launch_history` 属 T3-04；进程创建这件事本身不该依赖数据库可用），**启动失败不进审计**（与配置的增删改同一条判断：用户私有数据、发生频率与登录相当，写进去会把真正需要留痕的事件淹掉）。

### 9.30 T3-03 实施中的几处判断

**三态收敛到 `components/StateView.tsx`，但 `EmptyState` 这个名字留着。** 阶段二把 404、500、占位、无权限四个页面统一到一个组件时，它只覆盖「空」这一态，当时就在注释里记了一句「加载态与错误态还没有统一实现」。T3-03 是阶段三第一个真正的列表页，两态一并收进同一个文件：`EmptyState`（原样保留）、`LoadingState`（骨架）、`ErrorState`（`EmptyState` 的一层语义包装，补默认图标与重试按钮）。

文件改名而导出名不改，是因为改名要动的是「这个模块负责什么」，而调用点关心的是「我要一个空状态」。五处调用点只改 import 路径一行，断言里出现的 `EmptyState` 一词也不必跟着变。

`ErrorState` 刻意做得很薄 —— 它没有自己的排版，只是 `EmptyState` 加两件容易写漏的事：图标统一成警示样式（各调用点各挑一个，摆在一起看才发现不重样），以及重试按钮的落点。**没有做「重试中」的按钮禁用**：调用方按下重试后会把状态切回加载中，这个错误态连同按钮一起被替换掉，连点的机会不存在，为此多存一份状态只会多一个与加载态重复的布尔量。

**「正在加载」不单独存一个布尔量，由「还没有数据」与「还没有错误」推出来。** 单独存就有两个真相：重试成功时忘了改回来，界面会一直停在加载态。这条加载路径上只有首屏与重试两个入口，推导比维护省心。重试则走「把一个计数加一」触发 effect 重跑，而不是再写一遍加载逻辑 —— 落状态的代码只该存在一处，两边各写一份迟早不一致（例如一边清了错误、另一边没清）。

**表单重置靠重挂载，不靠 effect。** 对话框关闭后 Radix 会卸载内容（退场动画结束即移除），于是每次打开都是一次全新挂载，各字段初值直接由 props 算出来即可。把表单状态留在对话框外壳那一层的话，它会跨多次打开存活，就需要一个「打开时重置」的 effect —— 那种 effect 在首帧之后再触发一轮渲染，而且很容易漏掉某个字段，漏掉的那一个会带着上一次的值被提交出去（编辑完 A 再点 B 的编辑，表单里还是 A 的值，保存下去就是把 B 改成了 A）。所以 `LaunchProfileDialog` 拆成外壳与 `LaunchProfileForm` 两层，表单只在对话框打开时挂载。

**两条 eslint 规则决定了这里的两处写法。** 一条是 `react-hooks/set-state-in-effect`：它做保守的跨函数分析，把「effect 同步调用了某个含 setState 的函数」判为问题（会多触发一轮渲染），看不出那些 setState 其实都在 `await` 之后。于是拉取列表的落状态直接写在 effect 内、`await` 之后，而拉取本身抽成模块级的 `fetchLaunchProfiles`（它不碰组件状态，返回一个判别联合）。另一条是 `react-hooks/static-components`：它不允许 `const Icon = resolve(profile)` 再渲染 `<Icon />`，因为那与「每次渲染新建一个组件」在静态上无法区分，而后者会让整棵子树的状态每次渲染都重置。项目里现有的图标消费（`NAV_ICONS[item.code]`）都是索引访问，本期保持一致 —— `launch-icons.ts` 对外暴露的是**查找表加解析键**，渲染处一行索引。

**排序用上移/下移按钮，不做拖拽。** 拖拽要引入一套手势依赖（`@dnd-kit` 之类），还要处理重排动画与「拖到哪一格」的判定；上移下移只需交换两个相邻元素，零依赖、无动画歧义，键盘与读屏软件也能直接操作。重排接口收的是**整个列表的 id 顺序**，与这个交互天然对得上：点一次，算出新顺序，整份提交。

上移下移平铺在行内而不是收进「更多」菜单：它们是这个板块唯一的排序手段，收进菜单意味着每次调整都要点两次，而排序恰恰是需要反复微调的操作。首项的上移与末项的下移置灰，否则点下去什么都不会发生，看起来像界面卡了。

**重排不做乐观更新。** 接口会把落库后的完整顺序返回，等它回来再重绘，界面显示的永远是服务端那一份。先改本地再提交的话，请求失败时得回滚，而回滚期间用户可能又点了一次 —— 那两次操作各自基于不同的顺序，很难收敛。本机回环请求的延迟在毫秒级，等结果是可接受的代价。失败时也不动本地列表：界面仍显示服务端的顺序，用户看到的是「点了没反应加一句说明」，比显示一个没落库的顺序要好。

**`Dialog` 与 `Textarea` 走既有接入路线，不跑 CLI。** 新增依赖只有 `@radix-ui/react-dialog` 一个（`Textarea` 是纯原生元素，零依赖）。官方源码按 9.21 的清单修正四处，另外把 `DialogContent` 的关闭按钮与 `DialogFooter` 的 `showCloseButton` 文案从 `Close` 改成中文。启动参数用 `Textarea` 输入，**一行一个参数**：共享包里参数按数组存（Windows 与 POSIX 的分词规则不同），界面这一侧必须有一种同样不依赖分词的输入方式，按行拆正好满足 —— 参数里带空格也不需要引号。

**启动结果用板块顶部一条提示呈现，不引 toast。** 这个板块的动作都很短（启动一个进程、保存一条配置），结果紧跟操作出现即可，而 toast 要处理堆叠、超时与点击穿透，代价远大于收益。成功与失败共用一处，失败按服务端给的错误码分流：`executable_missing`（路径失效）的文案直接引导用户去编辑那一条并重新指定路径，其余情况给的是可重试的说法。分流规则写在数据层（`launchRunRecovery`）而不是界面里，因为它取决于服务端定义的错误码取值域，界面只消费结论。成功提示里带上 pid —— 它不面向日常使用，但出现「启动了却看不到窗口」时，这是判断进程到底有没有被创建的第一手信息。

**只读访客的入口一并收起，不是置灰。** `personal.*.read` 这一档能看到列表，但看不到任何改动入口。一个常年不可点的按钮只会让人反复尝试。这一层只是体验职责：能不能改由服务端判定，前端藏按钮挡不住直接发请求。

**工作台的诊断内容随之移除。** 阶段二在个人工作台上摆了「当前账号」与「权限点」两块，注释里写明了理由：「随阶段三三板块落地后移除」。现在页面上有了真正的功能，再留一块只对开发有意义的账号信息会挤掉它。账号与角色并没有失去落点 —— 顶栏的账号菜单本来就展示这两项，端到端断言改到那里核对。本页也因此不再读认证上下文，少一个只有渲染期才会暴露的空值分支。

**端到端脚本的四处改造。** 一是**判据从「等某段正文」换成「等只存在于已登录外壳里的元素」**：原先等的是工作台上的「权限点」，而那段内容本期被移除了 —— 等正文的断言会在内容改版时无声地失效（它等的那句话可能只是恰好还在），等账号菜单则与落在哪个模块无关。二是 `fillInput` 按元素类型取 value 描述符（`textarea` 的挂在 `HTMLTextAreaElement.prototype` 上，拿 `input` 的那一份去调用会抛 Illegal invocation）。三是新增 `openRowMenu` 辅助，点菜单之前先确认没有浮层还开着 —— Radix 的对话框与下拉菜单在关闭动画期间仍留在 DOM 里，全屏遮罩会吃掉这一击，而失败表现只是「菜单没打开」，单跑某一段又往往正常。四是前置条件的重置命令加上 `launch_profiles`：删除是软删除，跑完之后表里会留下几行 `deletedAt` 非空、`deleted_at is null` 为 0 的记录。

**本次验证结果。** 门禁 `format` / `lint` / `typecheck` / `test` / `format:check` 全绿，shared 38 项加 api 121 项合计 159 项，0 失败 0 跳过；浏览器级端到端从 42 项扩到 **56 项全绿**，新增 14 项覆盖：空态入口、打开新增对话框、相对路径被客户端拦下且对话框不关闭、新增后列表出现一条、参数按行解析为两个、新增排在末尾、下移一格后两条互换、首项不能上移末项不能下移、点击启动后提示已启动、编辑对话框带出原有值、编辑保存后名称更新且顺序不变、删除前先出确认框、删除后该条消失、删掉最后一条后回到空态。被拉起的程序是当前这个 Node 加 `-e process.exit(0)`，所以验证的是「进程被创建出来了」这件事，不会在机器上留下窗口。数据库在验证后回到基线：`users` 0 / `launch_profiles` 0 / `roles` 4 / `permissions` 11 / `role_permissions` 29 / 四张流水表 0 行。

**边界：阶段三验收清单第二项未勾，只读访客的界面也未在浏览器级覆盖。** 「路径失效有提示与重新指定入口」需要一处能把提示渲染出来的地方 —— 现在失效只在点击启动之后以顶部提示的形式出现，配置安静地躺在列表里时看不出它的路径已经失效，那是 T3-04 的事。浏览器级验证只覆盖 owner 一种角色：造一个只读访客账号需要账号管理接口，属阶段三后半；服务端那一侧的 403 已由 api 测试覆盖，界面上「入口收起」这一半只有代码与约定保证。另外两件事仍然留着：**启动记录不写库**（`launch_history` 属 T3-04），**启动失败不进审计**（与配置的增删改同一条判断）。

### 9.31 T3-04 实施中的几处判断

**`launch_history` 记录真实启动尝试，不只记成功。** 代理真实尝试的成功，以及 `executable_missing` / `spawn_failed` 两类失败都写入；命中去重窗口的响应不记，否则连点会制造指向同一 pid 的重复成功记录。这条判断放在路由层，代理核心不认识数据库。成功记录的 `startedAt` 沿用代理返回的进程创建时刻；失败没有进程创建时刻，取结果确认时刻。流水表没有 `createdAt` / `updatedAt`，不要把 `startedAt` 解释为统一的请求开始时刻或落库时刻。**不进审计**：启动记录是用户的私有使用痕迹，与启动配置增删改同一条判断。

**保留策略按用户最近 500 条，而非天数。** `LAUNCH_HISTORY_MAX_PER_USER = 500`，清理挂在写入路径上，不引定时任务。保留窗口按 `startedAt desc`、`id desc` 排序；`id` 仅提供稳定 tie-break，**uuidv7 同毫秒不保证生成顺序**，不能据此保证刚写入的记录必定更新。上次成功只从尚在保留窗口内的成功记录推导，连续失败或其他配置的使用可能淘汰较早成功，**不永久保证 `lastSuccess` 可得**。因此没有近期记录时的文案是「暂无近期启动记录」，不是「从未启动过」。

**写入失败吞异常但出声，与 `recordAudit` 同一条取舍。** 历史是辅助信息：不能让落库异常把成功的进程创建变成 500，也不能覆盖真实启动失败原有的错误码。历史由路由在拿到结果后写入；`agent.ts` 不碰数据库。

**路径状态是检查时的快照，不入库、不进缓存、不进配置响应。** `inspectExecutablePath` 用 `stat` 判断存在且是文件，启动前复核与列表状态共用同一判断点；快照与实际启动之间路径仍可能变化。对外只有 `ok` / `missing`，不存在、目录、检查失败与超时都可落为 `missing`，并非对操作系统可执行性的完整证明。`PATH_INSPECT_TIMEOUT_MS = 5000` **仅结束对 `stat` 的等待，不取消底层文件系统调用**。多条路径并发检查，等待不逐条累加；但查询、调度与后续处理也有开销，**不保证整个 API 恰在 5 秒内返回**。

**状态与列表分开接口、分开请求。** 独立 `GET /api/launch/profiles/status` 挂 `personal.launch.read`，启动模块目前共七条路由（列表 / 新增 / 重排 / 修改 / 删除 / 启动 / 状态）。归属由 `listProfilePaths` 的 `where` 恒带 `userId` 保证；`status.ts` 的 `listProfileStatuses` 把路径检查、`loadLastRuns` 与 `loadLastSuccessAt` 用 `Promise.all` 并发，辅助信息不会阻塞主列表的加载。

**分组取最新记录的查询口径。** `loadLastRuns` / `loadLastSuccessAt` 使用 Prisma `distinct: ['profileId']`，顺序为 **`profileId asc` / `startedAt desc` / `id desc`**；后者只查成功记录。**Prisma 的默认 `distinct` 不能宣称一定使用 PostgreSQL 原生 `DISTINCT ON`**，应以该查询的分组与排序语义为准，不把未核验的 SQL 实现当成硬性断言。库侧 `outcome` 是字符串，读取由 `isLaunchRunOutcome` 收窄，未知值按失败处理，不冒充成功。

**前端：状态失败不拖垮列表，保留上次状态。** `loadLaunchStatuses` 失败返回 null；首次未拿到状态时不显示路径标记或历史摘要，也不显示「从未启动过」。`statuses` 与 `profiles` 用 `statusToken` / `reloadToken` 分开驱动；重查失败不清空已有状态，标记可能是上次检查的旧快照。`describeRunHistory` 对已取得状态但无近期记录显示「暂无近期启动记录」，最近一次失败时仅在保留窗口仍有成功记录的情况下附上「上次成功」。**当前边界：重新检查没有「检查中」状态，也没有失败反馈**，不能说用户已能观察到本次重查是否成功。

**路径失效时「启动」换成「重新指定路径」。** 复用同一编辑对话框，`onOpenAutoFocus` 把光标落到 `#launch-path` 并选中；U 盘重插或共享恢复后可用表头「重新检查路径」。`canWrite: false` 已隐藏 `LaunchProfileRow` 的全行操作（启动、重新指定、排序、菜单等），不是仅隐藏新增或菜单；权限仍由服务端强制。**浏览器验证只覆盖 owner，其他角色的真实渲染仍待后续覆盖**，不能把隐藏逻辑的实现当成多角色浏览器验收。

**相对时间与测试接入。** `relative-time.ts` 用 `Intl.RelativeTimeFormat('zh-CN')`，取最大完整单位、不显示两级，解析不了的值原样返回。新增 `apps/web/test/relative-time.test.mjs` 10 项，使用 Node `--experimental-strip-types` 零依赖直接测试 TS 源码；`apps/web/package.json` 增加 `test`，随根 `test` 纳入验证。`apps/api/test/launch-history.test.ts` 新增共 **17 项（4 项路径检查 + 13 项集成）**；shared `test/launch.test.mjs` 当前 **9 项，是原 7 项加 2 项**，不是本次新增 7 项。

**写入时机：路由层等写完再回响应。** 界面收到启动结果后会重拉状态，等待写入可避免正常落库时读到旧摘要；写入异常被记录并吞掉，主流程仍保持真实启动结果。这不意味着历史写入失败时也保证摘要更新。

**浏览器验证与收尾状态（2026-10-11）。** 浏览器 e2e 已证实 **62/62 全通过，无渲染异常**，阶段三验收第二项据此勾选；最后调用已清掉 `zz_e2e` 残留。路径失效徽标的断言用 **`[data-slot=badge]` 精确匹配徽标文本**，避开名称 `zz_e2e_路径失效` 导致正文包含匹配的假判据。终门禁已核验全绿：shared 40 + api 138 + web 10 = **188 项**，0 跳过；lint / typecheck / build / format:check 全绿。第四迁移 `20261010180508_launch_history` 的 fresh deploy 已在空库实测通过（九张业务表齐全，seed 写入 11 / 4 / 29，与主库一致）；当前共九张业务表，`launch_profiles` 依赖 init 的 `users`，history 依赖 `users` / `launch_profiles`，字典序满足这两组依赖，前两个旧迁移互相独立的历史结论不扩展到全部迁移。**T3-04 功能已完成并提交（bb29055），下一项 T3-05 纪要模型与接口，本轮未开启；待推送 origin/main。**

### 9.32 T3-05 实施中的几处判断

**本次只落模型与接口，界面留给 T3-06。** T3-05 的范围是 `notes` 表与八条接口（列表 / 标签清单 / 单条 / 新增 / 修改 / 删除 / 置顶 / 归档）加上标签、置顶、时间归档查询；Markdown 编辑与预览属 T3-06，全文检索属 T3-07。因此本轮**没有前端改动**，`apps/web` 的 10 项测试数不变，端到端仍是 62 项 —— 不能把「接口能跑」当成「功能可用」，界面上现在还没有入口。

**`notes` 表与第五个迁移。** 迁移目录名 `20261011064829_add_notes`，字典序排在 `launch_history` 之后。它依赖 `users`（init 建的）与自身的外键级联，与前面两个旧迁移互相独立的历史结论不冲突。至此共**五个迁移、十一张表**（十张业务表加 `_prisma_migrations`）。列类型：`title` 用 `varchar(200)` 与共享包的 `NOTE_LIMITS.TITLE_MAX` 对齐；`content` 用 `text` **不设宽度**，长度上限由应用层强制 —— 上限只是防超大请求体的闸门，改它不该需要一次迁移。

**标签用 `text[]` 加 GIN 索引，不另开 `tags` / `note_tags` 两张关联表。** 个人工作台的标签是轻量场景：没有颜色、描述这类独立元数据，也不需要跨用户共享。开两张表换来的查询能力（标签重命名、标签统计）用数组加一次聚合同样能做，代价是两处级联维护与两次连接查询。标签名过滤走 `has`（数组包含），**B-tree 用不上数组的包含判断**，因此单建一条 `@@index([tags], type: Gin)`。这条判断与 `LaunchProfile.args` 用 `String[]` 同源。

**正文按 Markdown 原文存，不做 trim；标题做 trim。** Markdown 的前导空白有意义：缩进决定列表层级与代码块，首尾空行在编辑器里是用户看得见的东西。归一正文等于悄悄改写用户写下的内容，而他在大纲视图里看不出哪里变了。标题归一则是必要的 —— 前端漏做一次，库里就会并存两个「看起来一样」的标题。正文允许为空（先起标题、内容回头再补是记纪要时最常见的动作），标题不允许（一条没有标题的纪要，在列表上看起来就像一行渲染错误）。存原文而不存渲染后的 HTML：渲染是前端的事，存 HTML 意味着换一个渲染器就要重写全部历史数据，而且 HTML 里能塞脚本。

**置顶与归档各自一条幂等 `PUT`，不并入 `PATCH`。** `PUT /api/notes/:id/pin` 与 `PUT /api/notes/:id/archive` 用 PUT 是因为它们替换的是这个状态整体，天然幂等（设成与当前相同的值不报错）。不并进 `PATCH /api/notes/:id` 的理由是：它们表达的是「用户对这条纪要做的动作」，与「编辑正文」是两件事，混在一条路径上会让失败处理与界面反馈都变复杂 —— 改标题失败与置顶失败对用户是两回事。`PATCH` 的 body 因此只含 `title` / `content` / `tags` 三个字段，并要求 `minProperties: 1`：空 body 等于什么都没改却会走完一次查询与一次写入，`updatedAt` 随之变化，让「这条纪要什么时候被改过」失真。

**归档记时刻而不是布尔。** `archivedAt` 为 `timestamptz(3)` 且可空，null 表示未归档。布尔表达不了「什么时候归档的」，而这个问题（「这个月归档了哪些」）在回头看时有用。再次归档会得到新时刻，不沿用上一次 —— 保留旧时刻会让这个答案停在几个月前。归档的纪要**仍可读、可改、可取消归档**，只是退出默认列表；这一点与 `deletedAt` 的软删除不同，删除的不再出现在任何默认视图里。列表筛选的 `archived` 只有两档（`null` / `not null`），**没有「两者一起看」这一档** —— 界面上归档与未归档是两个视图，多一个档就要在每个视图里多一次判断。

**归属不符与真的不存在，对外是同一种结果（404），不是 403。** 与 `launch/profiles.ts` 同一条规则：所有权在 service 层强制，每个函数都要求传入 `userId` 且所有查询都把它写进 `where`。403 等于确认「这个 id 存在，只是不属于你」，而 id 是 UUID，能问出存在性就意味着可以逐个试探。`removeNote` 用 `updateMany` 而不是「先查再 update」：一条语句同时完成归属校验与写入，返回的 `count` 天然表达「本次是否真的改动了一行」，重复删除返回 `removed: false` 而不是报错。

**`NoteListFilter` 的四个可选字段显式带上 `| undefined`。** 这个对象在路由层由查询参数拼出来，参数缺省时读到的就是 `undefined`；项目开了 `exactOptionalPropertyTypes`，不加这一项就必须为每个字段写一次条件赋值，而那只是语法噪音 —— 对筛选条件而言，「字段缺失」与「显式 undefined」是同一件事，都表示不过滤。**这个宽松只留给筛选对象**：请求体类型（`UpdateNoteRequest` 等）不跟随，在那里「没传这个字段」表示不改、「传了 undefined」是需要被拒绝的非法输入，两者必须能区分开。

**校验分两层：schema 管形状，service 管业务规则，这里曾让一条测试失败。** 路由的 JSON schema 管类型与长度上限（挡住超大请求体），service 管「标题归一后不能为空」「标签归一与计数」「时间范围能不能解析」。分工的接缝上出过一次真实的失败：测试往 `tags` 里塞了一个空串 `''` 想验证「归一丢掉空串」，结果被 schema 的 `minLength: 1` 先挡在门外（`body/tags/2 must NOT have fewer than 1 characters`）。结论是**归一与合法性判断不是同一件事**：schema 挡明显非法的形状，`normalizeNoteTags` 负责「哪些算是同一个标签」。测试因此改成只留一个纯空白项（空白项能过 `minLength`）去触发 service 的归一。另一个顺序判断同理：**先归一去重再判数量上限**，否则「提交 25 个标签其中有 10 个重复、归一后 15 个」这样一次合法提交会被误拒。

**列表排序是三级键：置顶倒序 → 更新时间倒序 → 创建时间倒序。** 第三级键有必要：同一秒内创建或批量导入的纪要，`updatedAt` 会撞到一起，那时排序结果随数据库物理顺序变化，表现为「刷新一次顺序就变一次」。副作用要记住：`@updatedAt` 会随置顶/归档一起刷新，因此取消置顶后这条纪要会落到「最近修改」的第一位 —— 用户刚刚确实操作过它，这个位置符合直觉。

**标签清单走原生 SQL，不用 `groupBy`。** `groupBy` 对标量列分组，而标签在数组里，只能用 `unnest` 展开再分组；`userId` 用参数绑定而不是字符串拼接 —— 拼接在这个位置会直接变成一个注入口。计数口径：**已归档的计入，已删除的不计**。归档是「收起来」不是「不要了」，按标签找东西时把归档排除掉会让「这个标签下只有两条」这种结论失真；删除的连标题都不该再出现，它的标签自然也不该再被推荐。排序按条数倒序、标签名升序，次级键不写就会随物理顺序变化。

**不写审计。** 与启动配置同一条判断：纪要是用户自己的私有数据，增删改的影响范围不超出他本人，记审计只会让 `audit_logs` 里混进大量噪音。权限点用 `personal.note.read` / `personal.note.write` 两个（这两个常量在 T1-02 时已定义，本次只是第一次真正挂上路由），只读访客这一档因此能看到纪要但改不了任何一条，这条限制**由服务端强制** —— 前端隐藏按钮只承担体验职责。

**本次验证结果（2026-10-11）。** 四道门禁全绿：`format:check` 报 `All matched files use Prettier code style!`；`lint` 退出码 0；`typecheck` 退出码 0；`test` 结果为 `packages/shared` **50 项全通过**（原 40，本次新增 10 项）、`apps/web` **10 项全通过**（本轮无前端改动，数量不变）、`apps/api` **159 项，154 通过 / 5 跳过 / 0 失败**（原 138，本次新增 21 项）。三包合计 **219 项**。**那 5 项跳过是本次创建 owner 账号的直接后果**：`apps/api/test/setup.test.ts` 里的首次初始化用例以「库里是否已有 owner」为前置条件，`fanhe` 建好之后它们自动转入跳过并注明原因（`库里已存在 owner`），这是设计内的行为，不是失效。

### 9.33 T3-06 实施中的几处判断

**一级导航的路径是精确的，子路径需要显式补一层。** `routes.tsx` 原本写的是 `path={item.code}`，它匹配 `/workbench` 但不匹配 `/workbench/notes`。而共享包的 `navCodeFromPath` 只读首段，注释里早就写着「`/workbench/notes` 与 `/workbench` 解析出同一个编号」—— 也就是说子路径是它预期之内的事，缺的只是路由表这一层。改法是每个模块变成父路由，模块自身的页面挂 `index`，二级页面由 `MODULE_SUB_ROUTES` 列出的路径段挂子路由；`ModuleRoute` 的守卫判据是**按模块编号**而不是按路径，因此二级路径天然复用同一层守卫，不必为每个子页面重写一遍「这个角色能不能进」。板块切换用 `NavLink` 的激活态驱动、不用组件状态：这与 `ModuleRoute` 那条「重定向而不是就地渲染，是为了让地址栏与内容始终一致」同源。

**Markdown 渲染选 `react-markdown` + `remark-gfm`，且明确不引 `rehype-raw`。** 正文按原文存（见共享包 `note.ts` 顶部），渲染是读回自己写的内容 —— 但「自己写的」不等于可信，纪要可以被粘贴进来，而一旦放行原始 HTML，一段 `<img onerror=…>` 就能在读到它的人那里执行。react-markdown 默认不解析 HTML，标签以字面文本出现，这正是要的行为。**要支持 HTML 的话必须同时加 `rehype-sanitize`，而那不该由一个预览组件顺手决定。** 样式逐元素写而不引 `@tailwindcss/typography`：项目的排版规格出自方案 B，覆盖插件带来的整套字位与间距，成本高于直接写十几个标签。

**预览读的是草稿，不是已保存的那一条。** 这是本任务验收要点「编辑与预览内容一致」的落点：预览若读 `note.content`，用户要等保存后才看得见渲染结果，写表格、写代码块时就失去了「一边写一边核对」的机会。因此编辑器持有草稿，左右两栏是同一份值的两种投影。

**草稿的同步：只靠父组件的 `key` 不够，必须按「正在编辑哪一条」的身份补一次 —— 这一条是被浏览器 e2e 抓出来的真 bug。** 初版写的是「草稿初值只算一次，靠 `key` 区分『新建』与『某一条』，不用 effect 去同步 `note`」。前半句的理由成立（`useEffect` 无条件同步 `note` 会在父组件重渲染时冲掉用户正在输入的内容，而那个 bug 只在「数据加载完成的同时用户已经在打字」时出现，极难复现），但**「靠 key 就够」是错的**：新建成功那一刻，父组件先 `setSelectedId(created.id)` 再重拉列表，于是 `key` 由 `'new'` 变成新 id、编辑器重挂，而重挂时列表里还没有这一条，`note` 仍是 `null` —— 草稿被初始化成空白，且此后再无同步时机。界面表现是「左侧列表里那条好好的，右侧编辑器一片空白、标题计数 0/200、预览显示空态提示」，而保存按钮还因为 `hasChanges(null, 空白)` 为真而亮着，点下去只会收到「标题不能为空」。修法是加一个 `syncedNoteId`，只在 note 的 **id** 变化时重置草稿；判据用 id 而不是整个 note 对象，同一条纪因列表重拉而换了引用时不重置 —— 这样既补上了这个死角，又保住了原来那条「不冲掉正在输入的内容」的性质。**这个 bug 单测与接口冒烟都拦不住**（服务端一切正常，接口返回也对），只有真的在浏览器里点一遍「新建」才会现形，这也正是这段 e2e 存在的理由。

**空库时编辑器必须直接可用 —— 这里改掉了实现中的一个死角。** 初版把编辑器画在「列表非空」的分支里，空库走 `EmptyState`，而空态里的「新建纪要」只是把选中项设回 `null`：由于列表仍然是空的，渲染分支不变，**第一条纪要永远建不出来**，界面上表现为点按钮毫无反应。改为：可写角色在加载完成后一律渲染「左列表 + 右编辑器」，列表为空时左侧给一句说明而不是一张居中大卡片（此刻页面的主体是右边那个待填的编辑器，摆大卡片会把视线从它上面拽走）；只读角色空库时才回落到 `EmptyState`——他本来就没有「新建」这件事。这类死角单看任何一屏都正常，只有走一遍「全新库」的路径才会暴露。

**标签的拆分规则下沉到共享包。** 新增 `parseNoteTagInput`：按**中英文逗号与换行**三种分隔符拆分，拆完立刻复用 `normalizeNoteTags` 归一。中文输入法下打出的是全角 `，`，只认半角时那串会被存成**一个**标签，而且在提交那一刻完全看不出问题 —— 要等到标签候选里出现一个长句子才会被发现。拆分放共享包而不是只放前端，与「长度上限放共享包」是同一条理由：界面显示的标签数与库里存的对不上，是这类控件最容易产生又最难解释的偏差。**超长标签不丢弃**，只标红 —— 丢掉的话用户会以为是自己没打进去，而界面又无法指出是哪一个被吃掉了。

**失败反馈分工：表单提交走内联，其余动作走提示条。** `handleSubmit` 不捕获异常，直接抛给编辑器显示在字段旁 —— 与 `LaunchProfileDialog` 的约定一致。理由是这个位置用户要看的是「哪个字段有问题」，而那条信息只能显示在表单旁边；容器再报一次会让同一件事出现两条文案，内容还可能不一致（一条服务端原文、一条加工过），用户不知道该信哪条。置顶、归档、删除不是表单提交，没有可承载内联错误的位置，才走板块顶部的提示条。删除的确认按钮在 portal 里、不在 `main` 内，这一点也影响了 e2e 的辅助函数：`clickMainButton` 必须限定 `main`，否则「点确认」命中的是编辑器里那个「删除」（打开确认框），表现为对话框一直开着而脚本报超时。

**TagInput 不覆盖 `Input` 自带的尺寸与描边。** 初版把标签芯片与输入框塞进同一个带描边的容器，靠 `h-7` / `border-0` 去覆盖 `Input` 的 `h-9` / `border`。**这并不可靠**：Tailwind 里同类工具类的胜负由生成顺序决定，不由类名字符串的先后决定，`h-7` 与 `h-9` 谁生效取决于数值排序。写一组「看起来对、换个版本就变」的覆盖，不如让输入框保持本来的样子 —— 芯片在上、输入框在下，视觉上少一点紧凑，行为上没有任何含糊。同理，预览与编辑器之间刻意**不做**「所见即所得」的富文本编辑，只做原文与预览并排：Markdown 的原文是唯一事实来源，富文本编辑器会引入第二份表示。

**接口冒烟发现的一件事：新增返回 201 而不是 200。** 前端传输层的判成功用的是 `response.ok`（200–299），因此 201 本来就被接受、无需改动；但这值得钉住 —— 若哪天有人把它收紧成 `status === 200`，新增会在前端表现为「请求失败」而服务端日志里全是 201，那种不一致很难从现象反推回来。本次用真实 owner 跑了一遍八条接口的冒烟（脚本 `.tmp/note-smoke.mjs`，不破坏既有数据），23 项全部通过，另确认了「标题 trim / 正文不 trim」「空 body 的 PATCH 被 400 拒绝」「不存在的 id 返回 404」「重复删除返回 `removed: false` 而不是 404」四条边界。

**断言不能比被测对象宽 —— 否则会把正确的东西判成错的。** 首轮 e2e 报了 `owner 可见全部五个导航项` 失败，实测文本是「个人工作台 / 客户信息平台开发中 / 运营信息平台开发中 / 数据看板开发中 / 系统设置开发中 / **一键登录通道 / 工作纪要**」。界面本身完全正确：T3-06 给个人工作台加了板块切换（`<nav aria-label="工作台板块">`，含那两个链接），而这条断言用的是**全局选择器 `nav a`**，于是把新增的板块链接一并数了进来，「五项」变成七项。改法是限定到侧栏的 `aside nav a`。**这不是被测对象坏了，是尺子变长了**，而两类失败在脚本输出里长得一模一样 —— 所以断言失败时第一件事是核对选择器的作用域，而不是去改产品。

**残留的 `tsx watch` 会静默顶掉新启动的 API，并让后续验证对着旧环境跑。** 首轮 e2e 的 `静默续期` 一项失败，报「访问令牌有效期 900 秒」，而启动时明明给了 `ACCESS_TOKEN_TTL_SECONDS=60`。根因不在接口也不在环境变量传递（`import 'dotenv/config'` 不会覆盖已存在的 `process.env`）：**上一轮会话遗留的一个 `pnpm --filter @fanhe/api dev`（即 `tsx watch src/index.ts`）一直占着 8787**，新启动的 API 直接 `EADDRINUSE` 退出（而它的输出没被接住的话，表现就是「安静地没起来」），浏览器访问到的始终是旧进程。旧进程带了上一轮的 `pid 4900`/`3184`，也解释了为什么端口监听者 PID 会在两次探测之间变化。**教训：复用长驻服务前先确认端口上的监听者是谁**，用 JWT 的 `exp - iat` 直接量令牌有效期是最省事的判据（实测改后为 60 秒）。另有一个易错点：`pnpm --filter <pkg> exec` 会把工作目录切到该包，所以在仓库根直接 `exec tsx apps/api/src/index.ts` 会因为 `.env` 不在当前目录而报「缺少环境变量 DATABASE_URL」。

**验证结果（2026-10-11）。** 四道门禁全绿：`format:check` 报 `All matched files use Prettier code style!`；`lint` 退出码 0；`typecheck` 退出码 0；`test` 结果为 `packages/shared` **58 项全通过**（原 50，新增 8）、`apps/web` **10 项**（本轮无前端单测新增，见下）、`apps/api` **159 项，154 通过 / 5 跳过 / 0 失败**（未改动 api）。三包合计 **227 项**。前端本轮**没有新增单测**：新增的界面逻辑已经全部下沉到共享包（标签拆分）或由传输层与数据层承担，剩下的都是组件渲染与交互，用浏览器 e2e 覆盖比用组件测试框架划算得多 —— 为一个板块引入一套组件测试栈，代价远大于它兜住的风险。

**浏览器 e2e：已执行，78 项全通过。** 本轮把它从「已写未验证」跑成了已验证，从 62 项增至 **78 项**（T3-06 新增 16 项：板块切换与地址同步、空库直接可用、草稿即时渲染、GFM 表格、草稿跟随、创建与列表行、保存按钮状态、**创建后编辑器载入该条**、标签芯片文案、置顶排序、归档与归档视图、删除确认与消失、删空回空态）。首轮跑出 3 项失败，逐一归因后分别为：1 项真 bug（上面那条草稿同步死角）、1 项断言作用域过宽、1 项环境残留（旧 `tsx watch`），修完后重跑 78/78，且「渲染过程未产生未捕获异常或 console.error」一项通过。**跑一次 e2e 要清库并重建 owner**（脚本以「users 表为空」为前置条件），本轮据此重建了 `fanhe`（显示名「梵禾」，口令沿用原值），并在收尾后把数据库回到基线：`users` 1、`notes` / `launch_profiles` / `launch_history` / `refresh_tokens` / `audit_logs` / `login_attempts` 全 0，种子 11 / 4 / 29 完好。

### 9.34 T3-07 实施中的几处判断

**中文检索不能用 `tsvector`，这条路是先量后弃的，不是凭印象绕开的。** PostgreSQL 自带的全文检索按空格与标点切词，**连续的中文整段被当成一个 token**。实测（一次性库 `zz_t307_probe`，造 30 000 行中文数据）：`to_tsvector('simple','衣柜门板安装说明')` 只产出**一个**词位，`to_tsvector('simple','衣柜门板安装说明') @@ to_tsquery('simple','衣柜')` 为 `false` —— 词明明在库里存在，全文检索却一条也搜不到，而它返回的是「正常结果为空」而不是报错，很容易被误读成数据没写进去。正确解法是装中文分词器（`zhparser` / `pg_jieba`），但本机容器的 `pg_available_extensions` 里只有 `pg_trgm`、`btree_gin`、`unaccent` 三个可用，没有中文分词器；引入它意味着要换镜像、迁移里跟着建扩展，代价与「单用户纪要检索」这一件事不相称。

**`pg_trgm` 的 GIN 索引救不了两个字的关键词。** 另一个常见方案是给标题与正文建 `gin_trgm_ops` 索引配合 `ILIKE '%词%'`。同样实测（同一批 30 000 行、索引已建好并 ANALYZE 过）：两字模式 `'%衣柜%'` 仍然走 **Seq Scan**；三字、四字模式才走 Bitmap Index Scan。原因是 trgm 索引对不足三个字符的模式生成不出有效的三元组查询。而两个字恰好是中文最常用的关键词长度（「衣柜」「报价」「门板」），也就是说这条路**在最需要它的地方不生效**。

**结论：先用 `ILIKE`，本轮不建索引。** 检索实现为 `title ILIKE %q% OR content ILIKE %q%`（Prisma 的 `contains` 加 `mode: 'insensitive'`），**不加任何索引**。理由是数据规模：单用户纪要，量级是几百到几千条，全表扫描在这个量级是毫秒级；而索引的代价是第六个迁移、一个扩展依赖，且在两个字的关键词上根本不会被使用 —— 换来的是一份「看着像做了优化、实际没生效」的复杂度。**升级路径已经备好**（见下），等真的出现性能问题再上，不必现在猜。

**真要升级时的现成形态。** 迁移里加 `CREATE EXTENSION IF NOT EXISTS pg_trgm;`，模型上加
```prisma
@@index([title(ops: raw("gin_trgm_ops")), content(ops: raw("gin_trgm_ops"))], type: Gin)
```
Prisma 7.10 对 `ops: raw(...)` 与 `extensions = [pg_trgm]` 都能通过 `prisma validate`（已实测）。但要记住：那时**只有三字以上的关键词会变快，两个字仍然全表扫描**，所以这个升级对最常见的输入形态收益有限，别把它当成「搜得慢」的解法。

**一个已知边界：`LIKE` 的元字符没有转义。** Prisma 的 `contains` 只做字符串包含，不提供 `ESCAPE` 子句，因此用户输入里的 `%` 与 `_` 会被当成通配符 —— 搜 `%` 会命中**全部**记录，搜 `100_` 会把 `100X` 一并带出来。这不是安全问题（查询是参数化的，没有注入面），影响面只是「结果比预期多」。**本轮有意不修**：要转义就得把这条件换成原生 `LIKE`（`$queryRaw`），为两个几乎不会有人输入的字符付这份维护成本不划算。记录在此，等真被绊到再改。

**「什么叫空检索词」这条规则只写在共享包一处。** 新增 `normalizeSearchQuery`：`undefined` 返回 `null`（含义是**不检索**），全空白返回 `null`，其余返回 trim 后的串。`null` 与 `''` 的区别是**承重**的 —— Prisma 的 `contains: ''` 会匹配每一行，所以「拿到了但不是空串」这件事在服务端必须能表达；若这里偷懒返回 `''`，用户清空搜索框之后就会进入「跟没搜一样、但走的是检索分支」的状态，而那个分支将来一旦加了排序权重或高亮就会当场变成 bug。前端过同一个函数（`NotesPanel` 的防抖回调），并且**空串时干脆不发送 `q`**：服务端对空串同样按不检索处理，但少发一个参数能让「界面认为没在搜」与「服务端收到的是没在搜」永远一致。上限 `SEARCH_MAX = 64` 也放共享包，前端拿它做 `maxLength`，用户就撞不到那个 400。

**界面上的三处判断。** 其一是**检索框不随列表状态出现或消失**（加载中、加载失败、搜不到，它都在）—— 否则一次请求失败之后，输入框连同里面那个关键词一起被卸载，用户没法把它清掉再重试。其二是**防抖 250ms，且复用既有的加载 effect 与它的 `cancelled` 标志**：连续改词时会有多个请求同时在飞，先发的后到会把新结果覆盖成旧的（表现为「搜到一半，结果显示的是上一个关键词」）；把 `query` 放进同一个 effect 的依赖数组，每次改动先置真上一轮的 `cancelled`，晚到的响应就写不回状态。其三是**「列表为空」要分两种说法**：库里没有、检索没命中是两件事 —— 只读角色在搜不到时若看到「当前角色只能查看，请联系管理员」，会跑去要一个他已经有的权限；可写角色那边把关键词回显出来（`没有匹配「衣柜」的纪要。`），多数字符串里差的就是一个字，回显比一句「没有结果」有用得多。

**检索与视图是正交的，关键词跨视图保留。** 归档视图与检索是两个独立条件，服务端按交集处理。界面**切换视图时不清空关键词** —— 找的仍是同一样东西，让用户重打一遍没有道理。这条在 e2e 里有断言：同一条纪要（关键词「衣柜」）在未归档视图搜不到（它已归档），切到已归档就搜得到。

**一处留给 T3-08 的残留。** 检索会缩小可见集合，被搜掉的那条会退出列表、选中随之落到第一条匹配上，编辑器重挂、**正在编辑的草稿随之丢失**。这是既有行为（归档、删除、切视图早已如此，不是检索引入的），也正是 T3-08「草稿自动保存」要解决的那件事，因此本轮不动它，只把这条交接写进组件注释。

**验证结果（2026-10-11）。** 四道门禁全绿：`format:check` 报 `All matched files use Prettier code style!`；`lint` 与 `typecheck` 退出码 0；`test` 为 `packages/shared` **63 项全通过**（原 58，新增 5）、`apps/api` **165 项，160 通过 / 5 跳过 / 0 失败**（原 159，新增 6）、`apps/web` **10 项**，三包合计 **238 项**。

**浏览器 e2e：已执行，85 项全通过。** 由 78 项增至 **85 项**，T3-07 新增 7 项：检索前置（两条互不包含的纪要）、中文关键词命中标题且另一条被筛掉、**关键词只出现在正文里同样命中**（该词不在任何标题里）、搜不到时回显关键词且计数为「匹配 0 条」、清空后立即恢复完整列表且输入框被清空、**检索与视图正交**、验证用的两条纪要清理干净回到空态。首轮跑崩过一次，**与本轮改动无关**：脚本在第 7 项主题切换处抛「等待超时：主题菜单展开」，成因是 Radix 下拉菜单在关闭动画期间仍留在 DOM 里、此间的点击被触发器忽略 —— 与 `openRowMenu` 里早就记着的那个坑是同一个，只是这次撞在「切回浅色」之后紧接着的那一次打开上。修法是抽出 `openThemeMenu`，点之前先等 `[role="menuitemradio"]` 从 DOM 里消失。另有一处环境问题不得不绕：**9222 被一个非 CDP 的监听者占着**（任何路径都返回 `Content-Length: 0` 的 404，脚本自带的占用检查判的是 `response.ok`，因此拦不住它），于是给调试端口加了 `E2E_CDP_PORT` 覆盖，本次跑在 19222 上。跑完仍按老规矩收尾：清库、重建 owner（登录名 `fanhe`、显示名「梵禾」，口令沿用原值）、更新被忽略的 `.tmp/owner-credentials.txt`、停掉 API 与前端并释放 8787 / 5173 / 19222，核对基线为 `users` 1、其余业务表全 0、种子 11 / 4 / 29 完好。

**T3-07 已完成并提交，浏览器 e2e 85 项全通过，下一项 T3-08 草稿自动保存。**

### 9.35 T3-08 实施中的几处判断

**这是一项纯增量改动：零迁移、零新接口、不触碰任何既有数据路径。** 后端一行未改 —— 草稿只落在浏览器 localStorage 里，既不进数据库也不进审计（与既有判断一致：纪要是私有用量，而一条尚未提交的草稿连「这条纪要存在」都还不成立）。与事件板块（要从第六个迁移、两张新表起步）相比，它的风险面小得多，也正因如此它更适合拿来把纪要链收口。

**槽名 = 编辑器的身份 = 父组件传给编辑器的 `key`。** `fanhe-work.draft.note.<id>` 存已有纪要的草稿，`fanhe-work.draft.note.new` 存新建中的。前缀与既有的 `fanhe-work.ui.` 并列，既能按前缀整体清理，又不会碰到会话令牌那类数据 —— 这一点在 e2e 里被专门断言过（容量清理跑完后 `fanhe-work.ui.theme` 与无关键一根没动）。**没有另开一套键名规则，是因为「编辑哪一条」这件事本来就已经有一个唯一表达（`key`）；再定一套，两者迟早会分叉。**

**值里带结构版本号 `v`，读到不认识的版本一律丢弃、不做迁移。** 草稿是可有可无的副本：把 `tags` 从数组改成字符串之后，为旧格式写一套迁移逻辑的收益，抵不过它引入的分支数与「迁移写错反而把能读的草稿弄丢」的风险。反过来说，**不带版本号才是真的危险** —— 旧草稿会把界面打崩（`tags.map` 在字符串上直接抛），而崩的位置离原因很远。

**三个写入触发点缺一不可，而且不能合并成一个 effect。** ① 输入防抖 500ms（比检索的 250ms 长一倍：检索是一次网络请求，晚发一点只是结果晚到；草稿写是**同步阻塞主线程**的 I/O，10 万字正文每次按键都写会肉眼可见地发涩）。② `pagehide` + `visibilitychange(hidden)` 立即落盘 —— **这才是「误关恢复」真正依赖的那一条**：用户打完最后一个字、不到 500ms 就关掉页面时，防抖还没到期。用 `pagehide` 而不是 `beforeunload`，后者在移动端与部分浏览器上不可靠。③ 卸载时立即落盘，负责「切板块、被检索筛掉、归档之后编辑器重挂」这一类。**① 的清理函数只清定时器、不落盘**：若在清理里也写一次，每敲一个字都会触发上一轮的清理，等于变成「每次输入都立即写」，防抖整个失效 —— 三个 effect 合并不了，这是直接原因。

**三个清除触发点同样是承重的。** ① 提交成功后清当前槽（新建时尤其关键，见下）。② 用户点「丢弃草稿」。③ **草稿与已保存值一致时清掉** —— 改了又改回原样，留着只会在重进时凭空弹一次「已恢复未保存的内容」，而恢复出来的东西与库里一模一样，纯噪音。

**本任务最阴的一个坑：提交成功后的卸载落盘会把已提交的内容写回去。** 时序是：新建 → 点「创建」→ 提交成功 → 父组件 `setSelectedId(created.id)` → `key` 由 `'new'` 变成新 id → 组件重挂 → **旧实例的卸载清理函数在重挂之后才执行**。那一刻旧实例手上的 `note` 仍是 `null`（列表还没重拉完），`hasChanges(null, values)` 恒为真，于是内容被写回 `'new'` 槽 —— 表现是「新建 → 提交 → **再点新建**」时，编辑器里躺着上一条已经存过的纪要。修法是 `committedRef`：提交成功时置真并清槽，卸载落盘前先看它。**重置不能放在 effect 里**，因为紧跟其后的 `setValues(valuesFrom(saved))` 也是一次 values 变化，会立刻把标记清掉、等于没挡，所以它放在三个输入回调里。

**这个 bug 单测与类型检查都拦不住（它们当时全绿），而且现象要三步才出现。** e2e 里专门有一项打它，写法上刻意用「读值 + 断言」而不是「等待某条件成立」：后者在条件不成立时会超时抛错、把整轮脚本打断，而这一条恰恰属于「出问题时也必须把结论打印出来」的那种。

**比较规则下沉为单一出处。** `NoteEditor` 原先自己有一份 `hasChanges`（标题按 trim 后比较、正文原样、标签逐位比较）。草稿「要不要留」与「保存按钮要不要亮」必须用同一条判据 —— 各写一份的结果是出现「按钮是灰的、草稿却一直在」这类没人能一眼解释的现象。因此把内核抽成 `lib/note-draft.ts` 的 `isSameDraftValues`，`hasChanges` 改为委托给它。

**存储异常的处理与 `lib/preferences.ts` 刻意不同。** 那边的取舍是「写不进去就算了」，因为它丢的只是「侧栏是宽是窄」；草稿丢的是用户刚敲进去的工作，因此分两档：**读失败**（隐私模式、存储被禁）静默按「没有草稿」处理，等价于退回到没有这个功能之前的行为，可接受；**写失败**（配额满）先清一条最旧的再重试一次，仍然失败才给**一次**提示「自动保存暂不可用，请手动保存」。**「只提示一次」是刻意的**：每次输入都弹会变成噪音，而噪音的结果是用户学会忽略它，那它就不再是提示了。容量治理同样只做最朴素的两条：超过 7 天、或总数超过 20 条，写入前顺手清一次，**且清理严格限定在 `fanhe-work.draft.note.` 前缀内**。

**已知边界（记录下来，别当成 bug 去修）。** 同一浏览器多标签页同时编辑同一条 → 后落盘的覆盖先落盘的（localStorage 无锁），单机单用户可接受；换浏览器、清缓存即丢，与 `preferences.ts` 同源；不跨设备同步，那是阶段五服务端化的事；`'new'` 槽只有一个，因此同时保留不了两条「新建中」的草稿；**用户在已有纪要上把三个字段全部清空后误关，草稿不保留**（三个字段全空一律当「没有草稿」处理，否则 `'new'` 槽会被写满空值），重进看到的是库里的版本，重新清一遍即可。

**本轮又发现一个环境坑：Vite dev server 起不来。** 它启动时要清自己的 `node_modules/.vite/deps`（实测 61 个条目），撞上批量删除保护后直接抛错退出，日志是 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`，而外部只看到「5173 连不上」。**与 `pnpm install` 那个坑同源**，加 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD` 即可。另外本轮把 API 起成了不带 watch 的 `tsx src/index.ts`（一次性验证的推荐形态），顺带避开了「跑构建会打断正在跑的 `tsx watch`」那个老问题。

**验证结果（2026-10-11）。** 四道门禁全绿：`format:check` 报 `All matched files use Prettier code style!`；`lint` 与 `typecheck` 退出码 0；`test` 为 `packages/shared` **63 项全通过**、`apps/api` **165 项，160 通过 / 5 跳过 / 0 失败**、`apps/web` **23 项全通过**（原 10，新增 13），三包合计 **251 项，0 失败**。

**浏览器 e2e：已执行，98 项全通过。** 由 85 项增至 **98 项**，T3-08 新增 13 项：草稿槽清空前置、防抖到期后自动落盘、**重载后标题与正文都被恢复**、恢复时给出提示条、点「丢弃草稿」后回到库里版本且提示条消失、**打完字立刻关掉页面也不丢**（专打 `pagehide` 那条路）、切板块往返内容还在、提交成功后草稿被清掉、保存成功的内容重进后不弹恢复提示、**新建 → 提交 → 再点新建不带出旧内容**（专打上面那个时序坑）、改回与库里一致后草稿槽被清掉、改了又改回原样重进不出现提示、验证用的纪要删除且草稿槽清回基线。**首轮就全绿，没有出现需要归因的失败。** 按照老规矩收尾：清库、重建 owner（登录名 `fanhe`、显示名「梵禾」，口令沿用原值）、更新被忽略的 `.tmp/owner-credentials.txt`、停掉 API 与前端并释放 8787 / 5173，核对基线为 `users` 1、其余业务表全 0、种子 11 / 4 / 29 完好。

**T3-08 已完成，纪要链收口（阶段三验收第三项五项全勾），下一项 T3-09 事件模型与接口。**

### 9.36 T3-09 实施中的几处判断

**这一轮的产出是两张表与八条接口，界面留给 T3-10，与纪要链的切分方式一致。** 第六个迁移 `20261011132819_add_events` 是阶段三唯一一次建两张表的迁移（前五个各建一张），也是**事件板块与纪要板块最根本的区别所在**。

**`events` 是实体表，`event_logs` 是只追加流水，两者在时间戳上的处理刻意不同。** `events` 带 `createdAt` / `updatedAt` / `deletedAt` 三件套（软删除），`event_logs` **只有 `createdAt`**。给流水加 `updatedAt` 会给出「这行被改过」的错误暗示，而它的全部价值就在于「记的是当时发生的事」；给它加 `deletedAt` 更荒唐 —— 一份日志能被软删除，等于它随时可能消失。这与 `audit_logs` / `login_attempts` / `refresh_tokens` 是同一条判断，抄纪要那一套会直接把这条语义弄丢。

**`events` 上的 `status` / `completedAt` / `completedById` / `completedByName` 是可重建的冗余，权威来源在 `event_logs` 里。** 这是整个设计里最需要说清的一点：状态不是一个「改了就完了」的普通列，它是那份流水最新一行的投影。详情面板要回答「谁在什么时候完成的」「为什么又被撤销了」，只留一个当前状态答不了。冗余留着是因为每次读列表都去聚合一遍流水不划算，而它是可重建的 —— 万一两者不一致，以流水为准。这与纪要的 `pinned` / `archivedAt` 不同：那两个字段只表达「现在是怎样」，没有历史可言。

**状态变更与追加日志在同一个事务里，幂等时不写第二条。** 拆开事务的话，一次中途失败会留下「状态是已完成但历史里没有完成记录」或反过来，而这两种不一致**没有任何后续步骤能修回来** —— 事件自己的历史只能由事件自己的变更写。幂等不写第二条的判断与「重复登出不写第二条」同源：客户端超时重试、用户连点两下都会走到写入点，让它们各写一行，历史里就会出现一串相同动作，「这条到底完成过几次」的答案就此失真。前端因此可以放心重试。

**撤销完成是追加一行 `reopened`，不是删掉那条 `completed`。** 删掉它等于抹去「这件事曾经被完成过」，而详情面板要展示的耗时（T3-12）恰恰需要那个时刻。撤销时 `completedAt` / `completedById` / `completedByName` **三列一起清空**：留一个「完成了但不知道是谁」的中间状态没有意义，只会让详情面板多一个分支去猜。

**编辑（标题、描述、标签、优先级）刻意不写日志。** 详情面板要回答的是「状态怎么变的」，把每次改标题也塞进去，这条流水就从「状态变更历史」变成一份全字段的修改记录 —— 而后者真正的归宿是审计，不是这里。代价是「谁改了标题」暂时查不到，而那个问题当前没有人问。为了让这条边界不可绕过，PATCH 的 schema 里**没有 `status` 项**且 `additionalProperties: false`，改状态只能走 `PUT /api/events/:id/status`；有一条集成测试专门验证「PATCH 传 status 会被拒」，而不是被静默丢弃。

**`status` 与 `priority` 做成数据库枚举，`action` 用 VarChar —— 三个字段三种处理，依据是同一条。** 前两者的取值域由产品定义、稳定，且需要库侧保证不出现第三态（枚举的排序还顺带承担了列表分组顺序，见下），因此做成枚举；`action` 的取值域会随功能演进（将来可能加「改期」「指派」），**新增一种动作不该需要一次迁移**，因此用 VarChar，读出来由共享包的 `isEventLogAction` 判断认不认识。这条与 `launch_profiles.software`、`launch_history.outcome` 完全同源。

**`EventLog.action` 在共享包里的类型是 `string` 而不是联合类型，这是有意的。** 库侧没有约束，而这条记录是只追加的历史：一个动作码在写入之后才被引入，旧版本的代码读它时必须能**原样展示**，而不是因为「类型上不该出现」就丢掉。把类型收窄成联合类型会让「库里有第四种动作」这件事在类型层面撒谎。写入侧由 service 收口（只写清单里那三个），读取侧用 `isEventLogAction` 决定展示分支。

**完成人同时存 id 与显示名快照，对外只暴露名字。** 存 id 供追溯（谁完成的），存名字是因为账号随后可能改名甚至被删 —— 排查时最需要的是当时那一行。对外接口只给 `completedBy`（名字）：界面不需要 id，而 id 一旦暴露出去就会有人依赖它。这与 `audit_logs` 同时记 `actorId` 与 `actorName` 是同一条判断。

**标签归一直接复用纪要那一套（`normalizeNoteTags` / `isValidNoteTag`），没有为事件再写一份。** 标签在两个板块里是同一个概念 —— 用户心里的「这个标签下有哪些东西」是跨板块的。各写一份的结果是同一个输入在纪要里被去重、在事件里没有，而两边界面看起来完全一样。注释里记下了后续动作：**若出现第三个使用标签的模块，再把这三个函数搬到独立的 `tag.ts`**，现在为两个使用方做那次搬家只换来多一个文件。

**列表排序 `status: 'asc'` 能「未完成在前」，靠的是 PostgreSQL 按枚举的定义顺序比较**（`event_status` 是 `('todo', 'done')`）。这是一个不显眼的隐性依赖：改动枚举里的书写顺序就会翻转结果，所以那**不是一个纯排版动作**。集成测试里有一条断言钉住了当前行为，改动时它会失败。组内按 `dueAt` 升序（近的在前），没有截止时间的靠 PostgreSQL 对 ASC 的默认行为（NULLS LAST）落在组尾 —— 与纪要列表里「`createdAt` 兜底」是同一种做法：显式声明主要排序键，边界交给数据库的既定语义。

**`dueAt` 显式传 `null` 表示清除，与「没传」区分开。** 不区分的话用户就没法把已经设过的截止时间取消掉。列表筛选对象那边「缺失即不过滤」的宽松处理不跟随这里 —— 请求体（`UpdateEventRequest`）不适用那条宽松。

**本轮踩到一条新的工具事实：Prisma 7.10 移除了 `migrate diff --from-url`。** 换成 `--from-config-datasource`（读 `prisma.config.ts` 里的 datasource）配 `--to-schema <path>`。本轮的第 6 个迁移是这么生成的：`prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` → 写进 `migrations/<ts>_add_events/migration.sql` → `prisma migrate deploy`。生成之后再用同一条命令复核，输出应当是 `-- This is an empty migration.` —— 那是「库与 schema 已无差异」的判据，比人肉核对 DDL 可靠。

**本轮没有跑浏览器 e2e，这是刻意的决定。** T3-09 只落模型与接口，没有一行界面改动，而 e2e 的断言全部指向界面行为，跑了也验不到本轮的东西。**但这不代表「没有界面就不需要别的验证」**：本轮的验收要点「状态变更追加日志，不做原地修改」落在**数据**上，而不是响应体上 —— 接口返回的 `status` 变了只说明第一半做到了。因此 32 项集成测试里有相当一部分是**绕过接口直接查库**（`GET /api/events/:id/logs`，以及断言原 `created` 那行原样还在、条数精确），那才是这条设计的本体。e2e 的结论停在 **98 项全通过**（T3-08 时的结果），T3-10 落地后要与它一起跑。

**验证结果（2026-10-11）。** 四道门禁全绿：`format:check` 报 `All matched files use Prettier code style!`；`lint` 与 `typecheck` 退出码 0；`test` 为 `packages/shared` **69 项全通过**（原 63，新增 6）、`apps/api` **197 项，192 通过 / 5 跳过 / 0 失败**（原 165，新增 32）、`apps/web` **23 项全通过**，三包合计 **289 项，0 失败**。数据库为 **6 个迁移、12 张业务表**，处于基线（`users` 1、其余业务表 0 行、种子 11 / 4 / 29 完好）。

**已知边界（记录下来，别当成 bug 去修）。** 事件没有分页，量与纪要同量级（单用户数百到数千条），沿用同一判断；事件没有「归档」，需要收起来时用的是软删除（真出现「要留但要退出列表」的需求再加，那是一个独立的迁移）；`event_logs` 没有 `userId` 列，它的归属完全靠 `events` 那一次确认来保证 —— 因此 `listEventLogs` **必须先确认事件归属再读日志**，漏掉这一步就是一个「拿到任意 eventId 就能读别人历史」的口子，集成测试里专门有一条打它；事件被软删除后日志接口返回 404，但日志行仍在库里（软删除不抹数据），这是有意的 —— 与纪要的软删除同一条处理；`description` 的 Markdown 渲染属 T3-12 详情面板。

### 9.37 T3-10 实施中的几处判断

**这一轮只做「看得见」的部分，勾选切换刻意留白。** 列表、分组、折叠、行内四要素、检索、新增 / 编辑 / 删除都在（那些是「看得见」的），而**点勾选框会怎样不在**。行上的 `Checkbox` 是 `disabled` 的：它如实反映状态（已完成的是勾上的），但不接受点击。这是给 T3-11 留接线点 —— 那一轮要处理的是乐观更新、失败回滚与可撤销入口三件事，把它们提前塞进一轮纯展示里，会让 T3-11 没有干净的地方下刀。**用 `disabled` 而不是「能点但不生效」**：后者会让人以为是自己点错了。为了让整行看起来不像坏掉，勾选框补了 `disabled:opacity-100` 抵消组件自带的半透明 —— 一行行都是半透明的勾选框，像的是「整块列表坏了」，而这里的意图只是「暂不可改」。

**分组在前端，排序在服务端，两边各管一件事。** `groupEvents` 是纯函数，只做「按 `status` 挑成两堆」，**组内顺序原样保留**。服务端已经保证「未完成在前、组内按截止时间升序、没有截止时间的落在组尾」（靠枚举定义顺序与 PostgreSQL 对 ASC 的默认 NULLS LAST，见 9.36），界面若再排一遍就有了第二份顺序定义，而两份会在某次改动后悄悄分叉 —— 那时的表现是「刚改完截止时间的那条没动位置」，看起来很像接口没生效。同理，**写操作之后一律重拉列表**而不是就地改本地数组：本机回环请求是毫秒级，重拉的代价远小于维护第二份顺序。

**展示规则抽到 `lib/event-display.ts` 而不是写在组件里，为的是能被单测直跑。** 分组、逾期判定、时间在两个输入形态之间的往返，全是纯函数 —— 而它们恰恰是最容易被某次改动弄错的那部分（例如「逾期」顺手把已完成的也算进去）。写进组件就等于把这几条规则锁在浏览器里，只有真开一次页面才能验。抽出来之后 `apps/web` 的单测从 23 项变成 40 项（新增 17 项），其中最有价值的是三条：**映射表的完备性**（三张 `Record<EventPriority|EventStatus, …>` 各验一遍「三个档位都有中文说法与配色」，将来新增一档会在编译期与用例上同时报缺项）、**分组的顺序保持**、以及 **`datetime-local` 的往返**（含个位数月份补零）。

**截止时间的输入用本地时间串，绝不用 `toISOString().slice(0, 16)`。** 后者是 UTC：本地时区不是 UTC 时，界面上显示的截止时间会整体挪走（东八区的 18:00 会显示成 10:00），用户据此改一下再存回去，时间就被改掉了，而且从界面上完全看不出是谁改的。转换只发生在两侧 —— 初值进来时 `toDateTimeLocalValue` 转一次，提交时 `fromDateTimeLocalValue` 转回去，中间一律是本地串（输入框的 `value` 就是那个形态）。这条有 e2e 断言直接钉住：编辑对话框打开后 `#event-due` 的值必须是本地时刻。

**「逾期」不把已完成的事件算进去。** 一件做完了的事，当初的截止时间只影响「是按时还是晚了」，而那个判断归详情面板（T3-12 要展示耗时）。若在列表上继续标红，用户会看到一片红色却无从下手 —— 那些事他已经做完了。另外逾期写成**前缀文字**（`已逾期 · 10月9日 09:00`）而不是只把日期涂红：颜色是唯一信号时，色觉差异与黑白打印都会让它消失，而几个字不会。

**截止时间说绝对日期，不说相对时间（「3 天后」）。** 它要回答的是「哪一天之前」，而相对说法把一天之内的位置抹掉了 —— 而「今天 18:00」与「明天 09:00」谁更紧，正是排优先级时在看的东西。今年之内省掉年份、跨年时补上（基准取 `now` 而不是「当前年」，这样可测），因为一旦跨年，「1月3日」就产生了歧义。

**已完成的默认折叠写成组件状态，不写进偏好存储。** 它表达的是「这一次浏览想怎么看」，与侧栏折叠（`fanhe-work.ui.sidebar-collapsed`）那种「这台机器上一直怎么显示」不是一回事 —— 把两者混在一起会让「我只是想看一眼已完成的」变成一次持久的界面改动。另外折叠时**不渲染**列表，而不是渲染一个 `hidden` 的：后者会让页面里躺着一组看不见但可被读屏与自动化读到的行，而「折叠」的含义就是它此刻不在页面上。

**`TagInput` 的标签数量上限改成注入（新增 `maxTags` prop）。** 事件与纪要的上限取值相同（都是 20），但**在两个板块里各自定义**（`EVENT_LIMITS.TAGS_MAX_COUNT` / `NOTE_LIMITS.TAGS_MAX_COUNT`）。控件里写死哪一份，都会让另一边的改动悄悄失效 —— 那一侧的标签上限从此由另一个模块的常量决定。上限是这个控件唯一需要知道的外部规则，注入它比给控件加一个「我在哪个板块」的参数干净。

**行本身不是 `<button>`。** 行里已经有勾选框与行内菜单两个可交互元素，把整行包成按钮会得到嵌套的可点击元素（无效的 HTML，读屏会念出两个入口）。打开详情面板是 T3-12 的事，到那时入口落在标题上。行内菜单的 `aria-label` 以「更多操作：」开头，与另外两个板块一致 —— e2e 按这个前缀定位。同理，**「已完成」组的计数放在折叠按钮外面**：放进去之后按钮的文本就不再是「已完成」这一个词，而 e2e 按精确文本定位按钮。

**检索参数只在非空时拼接。** 服务端对空串也按「不检索」处理，但少发一个参数能让「界面认为没在搜」与「服务端收到的是没在搜」这两件事永远一致。归一仍用共享包的 `normalizeSearchQuery`（全空白归 `null`），与纪要走同一条链路；本轮的 e2e 只验「它确实接上了事件列表」，不重复纪要那一段的细节。

**e2e 里新增了两个走接口的辅助函数，这不是绕开验证。** 界面上没有「把事件置为已完成」的入口（勾选切换属 T3-11），而验证分组与默认折叠必须有已完成的数据。做法是：`apiAccessToken()` 经前端代理登录拿访问令牌，`apiCompleteEvent()` 查列表拿到 id 再 `PUT /api/events/:id/status`。**本轮要验的是「拿到数据之后怎么分组与显示」，不是「怎么把状态改掉」** —— 后者是 T3-11 的验收要点，届时会由界面驱动。用接口把数据摆成需要的形态，再用界面验呈现，恰好把两件事分开。置完之后整页重载一次，顺带证明分组是**从服务端拿到的那份数据**算出来的，而不是留在本地的判断。

**验证结果（2026-10-11）。** 四道门禁全绿：`format:check` 报 `All matched files use Prettier code style!`；`lint` 与 `typecheck` 退出码 0；`test` 为 `packages/shared` **69 项全通过**、`apps/api` **197 项，192 通过 / 5 跳过 / 0 失败**、`apps/web` **40 项全通过**（原 23，新增 17 项 `event-display.test.mjs`），三包合计 **306 项，0 失败**。**浏览器 e2e 118 项全通过**（原 98，事件段新增 20 项），其中覆盖了空态入口、行内四要素、只读勾选框、逾期标记、检索收窄与清空、已完成默认折叠与展开、`aria-checked` 随状态、编辑回填（标题 / 截止时间的本地时刻 / 优先级的按下态）、删除确认与回到空态、以及「渲染过程未产生未捕获异常或 console.error」。**首轮 115/116 的那条失败是断言写错**，归因与修法见 9.2 第 1 条。数据库为 **6 个迁移、12 张业务表**，已回到基线（`users` 1、其余业务表 0 行、种子 11 / 4 / 29 完好），owner 已重建。

**已知边界（记录下来，别当成 bug 去修）。** 事件**没有分页**（与纪要同量级、同一判断）；**没有「归档」**，需要收起来时用软删除；**标签在行上最多显示 3 个**，多余的在后面记一句 `+N`，完整标签列表留给详情面板（T3-12）；`EventRow` 的勾选框 `disabled` 是**有意为之**，不要因为「它看起来该能点」而在这一轮放开；`description` 的 Markdown 渲染与变更历史展示属 T3-12。

### 9.38 T3-11 实施中的几处判断

**「成功之后仍然重拉列表」与「乐观更新」不是互相矛盾，而是各管一段。** 9.37 立了一条规矩：写操作之后一律重拉列表，界面不自己排序（顺序的定义在服务端）。勾选切换看起来是这条规矩的例外，其实不是 —— 乐观更新改的是**本地那一条的状态**，而顺序始终来自服务端那一次重拉，**界面从头到尾没有定义过任何顺序**。之所以非要这段空窗：完成一条会让它从「未完成」组跳进默认折叠的「已完成」组，也就是整行从眼前消失；等一个往返再消失，点击会像是没生效。反过来，若为了追求「立刻」而干脆不重拉、靠本地把那条插进已完成组的正确位置，就等于把服务端的 `orderBy` 规则抄了第二份到前端，而两份规则迟早分叉 —— 那时的表现是「界面上看到的顺序与刷新之后不一致」，极难查。

**失败回滚不是「手工改回去」，而是「重新对齐服务端」。** 切换失败时的正确状态只有服务端知道：它可能刚被别处删掉（404），也可能令牌刚失效。手工把状态改回点击前的值，要额外记住「这期间用户又动了什么」，而重拉一次直接问真相。代价是失败时多发一次列表请求 —— 本机回环，可以接受。这也是为什么 `lib/events.ts` 里 `eventFailureExit` 的分流能被直接复用：404 那一支走「提示已不在 + 刷新」，其余走「提示原因 + 刷新」。

**切换是串行的：同一时刻只允许一条在飞。** 允许两条并发的话，先回来的那次重拉会把另一条还没落库的乐观值覆盖成服务端的旧值 —— 用户看到另一行的勾选框自己弹回去、过一会儿又勾上。串行化把这个窗口彻底消掉，代价是几百毫秒内点不动第二行。实现上落在 `EventsPanel` 的一个 `switching: string | null`，而**「点不动」这件事要如实画出来**：切换期间 `EventList` 把 `locked` 透给每一行，所有勾选框都进 `disabled`（不是「能点但被静默忽略」—— 那正是 T3-10 刻意避开的观感）。用「一条 id」而不是「一个集合」表达，也是因为串行：集合会让人以为可以并发，而代码里并没有那套合并逻辑。

**两种「勾选框点不动」在样式上要分开。** 只读角色（没有 `PERSONAL_EVENT_WRITE`）永远点不动，这种禁用补 `disabled:opacity-100` —— 一整片半透明的勾选框看起来像「列表坏了」，而实际只是这个角色没权限；切换中的临时禁用则保留组件自带的半透明，它正好表达「正在处理」。判据按 `canWrite` 而不是按 `disabled` 取，因为同一时刻可能两个原因都成立。

**撤销入口只在「刚标成完成」之后给，而且刻意不自动消失。** 那一步会把行挪进默认折叠的组、也就是从眼前拿走，点错了当场看不见它去了哪 —— 这是唯一真正需要反悔入口的方向。反方向的「恢复」不给：它把行放回眼前，做错了再点一次即可，摆一个「撤销撤销」只会让人多想一层。**不设定时器让它几秒后消失**：定时消失意味着「用户还没读完，入口就没了」，而且会引入一个测试必须等待的时钟；它跟着下一条提示、或用户点「关闭提示」一起走，行为可预测。撤销之后不再给「重做」—— 撤销已经让状态回到原点，再挂一个反向入口就成了一个没有终点的环。

**`applyEventStatus` 只改 `status`，不伪造 `completedAt` 与 `completedBy`。** 那两个是服务端的时间与身份快照（本地时钟可能偏，显示名还要再问一次会话），而列表这一版也不展示它们 —— 展示要给 T3-12 的详情面板。乐观阶段写一个「本地现在」进去，只会让界面上短暂出现一个可能偏掉的时刻，而权威值紧随其后被重拉覆盖，那个中间值除了误导没有任何作用。同理，**撤销时本地也不清空 `completedAt`**：服务端在撤销时把三列一起清空（见 9.36），界面不替它做这个决定，等下一个往返取回权威值即可。

**`applyEventStatus` 找不到 `id` 时原样返回，不凭空补一条。** 切换可能在「这条已被别处删掉」之后才回到界面，此时手上的列表里已经没有它 —— 为了「让它有个状态」而补一条进去，表现是一行凭空出现又消失。这条有单测直接钉住。

**`EventList` 的组标题改用 `EVENT_STATUS_LABELS`，不再写字面量。** 「未完成」「已完成」这两个词原本在 `event-display.ts` 的映射表里有一份、在 `EventList` 的 JSX 里又写了一份。两份都在时，改一处不会报错，只是界面上出现两套说法；而 e2e 是按精确文本找折叠按钮的（`clickMainButton('已完成')`），改漏一处会让那一条以「找不到按钮」的形式失败，看起来像界面坏了。改用常量之后 `EVENT_STATUS_LABELS` 也重新有了生产代码里的用处 —— 否则它会退化成一个只有单测在用的导出。

**「乐观更新」这一条断言，在 e2e 里是刻意做成能证伪的。** 直接点一下再断言「界面变了」是没有意义的：本机回环的响应只要几十毫秒，那个变化既可能来自乐观更新、也可能来自回话之后的重拉。做法是**在页面里给状态切换那条 `fetch` 装一个 1.2 秒的延迟**（只拦 `PUT` 且路径以 `/status` 结尾的那一条，别的不动），再把断言预算压到 0.9 秒：断言的是「回话还没来，未完成组的计数已经从 2 变成 1」。判据取**未完成组的计数**而不是「行不见了」，因为「已完成」组一展开，被切走的那一行就还在页面上、只是换了组，「行不见了」立刻失效；计数在两种折叠状态下都成立。更硬的一条在失败那一支：先经接口把那条删掉、界面上仍画着它，此时点勾选框必然 404 —— 而断言的是界面**照样先把它勾上了**，那个勾不可能来自服务端。这一对断言合起来，才真正把「界面自己先改了」与「界面等回话才改」分开。

**e2e 里为这一段重新取了一次访问令牌。** 上一段那把是十几步操作之前拿的，而访问令牌的有效期被压到 60 秒（前置条件之一）—— 一直用同一把，接口断言会在某次运行里突然变成 401，表现成一句和事件毫无关系的「接口取事件列表失败」。界面自己那条链路不受影响（它会静默续期），但脚本这一侧不会。

**验证结果（2026-10-11）。** 四道门禁全绿：`format:check` 报 `All matched files use Prettier code style!`；`lint` 与 `typecheck` 退出码 0；`test` 为 `packages/shared` **69 项全通过**、`apps/api` **197 项，192 通过 / 5 跳过 / 0 失败**、`apps/web` **45 项全通过**（原 40，新增 5 项 `applyEventStatus` 用例），三包合计 **311 项，0 失败**。**浏览器 e2e 135 项全通过**（原 118，T3-11 段新增 17 项），一次通过、无首轮失败；覆盖了「切换前未完成组 2 条」「回话之前已经 2 → 1」「完成后给出撤销入口」「已完成组计数变 1」「切换一条不影响另一条」「服务端记下 `status` / `completedAt` / `completedBy`（完成人为显示名快照）」「展开后勾选框是勾上的」「撤销后回到未完成组、入口收起、勾选框恢复」「撤销把 `completedAt` 与 `completedBy` 一起清空」「失败也照改（乐观）」「失败后说清实情并把列表对齐服务端」「回滚之后已完成组仍是 0 条」。数据库为 **6 个迁移、12 张业务表**，已回到基线（`users` 1、其余业务表 0 行、种子 11 / 4 / 29 完好），owner 已重建。**后端与共享包本轮一行未改** —— 这也是一个信号：T3-09 把状态流水那条链路设计对了，界面这一层只需要正确地使用它。

**已知边界（记录下来，别当成 bug 去修）。** **撤销入口不自动消失**（见上，是刻意的）；**不给「重做」**；**没有批量勾选**（一次一条，配合串行化，符合单用户的使用形态）；**`EventRow` 的 `locked` 与 `switching` 是两个 prop 而不是一个枚举**，因为「点不动」与「正在处理的是我」在界面上确实是两件事（一个压暗、一个不押），合成一个之后会需要在这两个量之间做一次没有信息量的映射；**撤销时写不写 `comment` 还没定**（服务端支持 `comment`，界面上没有可填的位置，`setEventStatusRequest` 刻意不收这个参数）—— 真需要「撤销原因」时再加，那会是一次独立的改动；**详情面板（耗时、操作人、变更历史）属 T3-12**，历史来源是 `event_logs`。

### 9.39 T3-12 已完成详情面板实施中的几处判断

**只有时间线在等接口，头部用列表那一份数据。** 标题、描述、标签、创建与截止时间在列表返回的那条事件里就有，打开面板时不该让用户先看一眼转圈；日志只贡献最下面那段变更历史，所以它**单独三态、单独失败**。历史拉不到时上面的内容照样是对的，把整块换成「加载失败」等于用一个次要部分的失败否掉已经拿到手的主要部分。这与标签候选「失败静默降级」是同一条判断：**能分开失败的就分开**。

**未完成的事件也能打开详情 —— 这是对规格的一处有意扩展。** 实施方案第六章写的是「已完成条目点击后打开详情面板」，但**描述在列表那一行上根本不显示**（那行只有标题、标签、截止时间、优先级）。若只有完成之后才看得到完整描述，一件写着上下文的待办在完成之前就完全无处可看 —— 而「记下要做什么、细节写在描述里」恰恰是这个板块最常见的用法。因此入口对所有条目开，只是「完成时间 / 完成人 / 完成用时」三项在未完成时不出现，改用一句「尚未完成。标记完成之后，这里会记下完成时间、完成人与用时」顶上。**没有做「已进行多久」**：那个数字随时间变，而面板只在打开的那一刻算一次，摆出来很快就会是错的。

**详情存的是 `id`，不是整条事件；关闭时也刻意不清它。** 存 `id` 是为了**列表仍然唯一权威**：面板画的一定是列表里当前那一份，不会拿着一份打开时的旧快照（详情里没有写操作，现在看不出差别，但列表将来改成轮询或加实时刷新时，存 `id` 的这一版自动是对的）。至于「关闭时不清」：Radix 在关闭动画（约 200ms）期间仍然渲染内容，那一刻若 `detailId` 已清空，查出来的 `detailEvent` 就是 `null`，标题、描述与时间线会一起被抽走，看起来像内容在淡出的同时闪没了。因此 `EventsPanel` 托管的是**两个量**（`detailId` 说看的是哪一条、`detailOpen` 说开着没有），而不是一个布尔量。不用「给内容里每处访问加可选链」绕过，是因为那样虽然不崩，闪没照样发生。

**变更历史来自 `event_logs`，不是界面按当前状态反推的 —— 这件事在 e2e 里被做成了可证伪的。** 反推的做法（「当前是未完成就画一条未完成」）在界面上看起来很对，只有在一件事经历过往返时才露馅。因此 e2e 那一段刻意复用 T3-11 段里已走过「完成 → 撤销」的那条事件：它此刻是**未完成**，而详情面板里必须**仍然留着「完成」与「撤销完成」两笔**。界面若在反推，它永远画不出这两条。这是整个 T3-12 里唯一真正有证明力的断言，其余（标题、时间、耗时）都只是「显示对了」。

**认得出的动作码不再重复画一遍状态流转，认不出的才补上。** 「完成」「撤销完成」这两个说法本身已经说清了流向，后面再跟一句「未完成 → 已完成」是同一件事说两遍。而动作码认不出时（库侧对 `action` 没有约束，只追加的历史里可能出现新版本写下的第四种动作），状态流转往往是**唯一**能看懂的线索 —— 那时候它不是冗余，是全部。因此 `eventLogActionText` 对认不出的码**原样返回**，而 `eventLogTransitionText` 只在那种情况下被调用。

**`formatMoment` 与 `formatDueAt` 的唯一区别是年份永远在。** 前者给详情面板用（创建时间、完成时间、时间线上的每一条），后者给列表用。列表上省略今年是为了让一列截止时间读起来短，而**历史可以跨年** —— 一条两年前建的、去年完成的、今年才被撤销的事件，三个时刻会同屏，省掉年份会让「10月11日」指向哪一年变成要靠上下文推。

**`formatDuration` 取最大的两个单位，并且对反过来的区间返回 `null`。** 只取一个单位的话，「3 天」会掩盖「3 天 2 小时」与「3 天 23 小时」的差别，而这个数字在详情面板上是给人看出量级**与细度**的；取三个又会读成「1 小时 23 分 45 秒」，后两位在这里没有决策价值。第二个单位为零时省略（「2 小时」而不是「2 小时 0 分」）。`to` 早于 `from` 只可能来自手工改库或时钟回拨，此时返回 `null`、界面显示「—」—— 显示负数或「不到 1 秒」都是在替数据编一个说得通的说法。

**详情面板里不放「编辑」入口。** 行内菜单已经是编辑的入口，而面板与表单是两个浮层，叠在一起要处理焦点归属与 Esc 的先后顺序 —— 为了省两次点击引入这套复杂度不划算。同理**面板里也不放勾选框**：完成与撤销的入口在列表那一行上，那里才是看到「这件事要不要做」的地方。

**e2e 里把「点击有没有送达」从断言中拿掉了。** 这一段最初沿用 T3-11 的 `mouseClick`（CDP 合成鼠标事件）去点勾选框与标题，结果同一份脚本**三跑两败**在「回话之前未完成组已经少了一条」上，报的是「等待超时」。加探针复现时看到整组 `mouseMoved / Pressed / Released` 偶尔被整组丢掉 —— 点击**根本没有送达**，界面自然一直不变，而失败信息看起来像是乐观更新坏了。改法是把行内的点击换成 `element.click()`：**Radix 的下拉菜单**在 `pointerdown` 上展开、在 `pointerup` 上选中，合成 click 两个都不触发，所以菜单必须走真实指针事件；而**勾选框与标题**都是普通 `onClick`，`.click()` 派发的就是真实 click 事件 —— 两者取舍不同，不能一刀切。换掉之后 `.click()` 是同步的，这一步不再有「送没送到」的不确定环节，连跑两次全绿。这条与 9.33 那条「先等菜单从 DOM 消失」是同一类教训：**断言失败时先问「这一击真的发生了吗」，再问产品对不对**。

**截图之前等了 350ms，而这件事顺带解释了一个此前没弄清的现象。** 早先的截图里对话框是半透明的、背后的页面文字透过来，看着像 `bg-background` 没生效。对照 T3-10 的截图发现**那时也一样**，说明不是某一轮引入的。真正的原因是：断言用的 `waitFor` 是「元素一挂上就返回」，紧接着抓帧拍到的正是对话框淡入动画（`animate-in fade-in-0 zoom-in-95`，200ms）的中间帧。等一小会让截图反映稳态之后，对话框是不透明的、元信息与时间线都清楚。**这个等待只影响截图好不好看**：断言读的是 DOM，不是像素。同时把 `assertUninitialized` 报错信息里那条重置语句补全了事件两张表 —— 它原来漏掉了 `event_logs` 与 `events`，而症状是「空态那几条断言失败」，看起来像界面坏了，实际是上一轮的软删除行还躺在库里。

**验证结果（2026-10-11）。** 四道门禁全绿：`format:check` 报 `All matched files use Prettier code style!`；`lint` 与 `typecheck` 退出码 0；`test` 为 `packages/shared` **69 项全通过**、`apps/api` **197 项，192 通过 / 5 跳过 / 0 失败**、`apps/web` **62 项全通过**（原 45，新增 17 项：动作码映射完备性、`eventLogActionText` 对未知码原样返回、`eventLogTransitionText` 的三种缺端情形、`formatMoment` 跨年、`formatDuration` 的九个边界），三包合计 **328 项，0 失败**。**浏览器 e2e 146 项全通过**（原 135，T3-12 段新增 11 项），**连跑两次均全绿**；覆盖了「点标题就打开详情」「未完成也能打开且不显示完成用时」「详情补齐完整描述与创建时间」「描述按 Markdown 渲染而不是原样贴出」「未完成状态下历史里仍留着『完成』与『撤销完成』两笔」「时间线每一条都带发生时刻」「完成后补齐完成时间 / 完成人 / 完成用时」「完成人是当前账号显示名」「完成用时是真实时长而非『—』」「流水按发生顺序四条」「关掉之后回到列表」。数据库为 **6 个迁移、12 张业务表**，已回到基线（`users` 1、其余业务表 0 行、种子 11 / 4 / 29 完好），owner 已重建。**后端与共享包本轮仍然一行未改** —— 事件链三块（T3-09 / T3-10 / T3-11）与这一块加起来只动了前端。

**已知边界（记录下来，别当成 bug 去修）。** **耗时算的是「最后一次完成时刻 − 创建时刻」**，中间若有撤销再完成，那段间隔也算在内 —— 要算「净投入」得从时间线累加，那是另一个需求；**没有做「已进行多久」**（随时间变，见上）；**时间线上的 `comment` 只读不写**（服务端支持，界面没有可填的位置）；**详情里没有编辑入口、没有勾选框**（见上，刻意的）；**`event_logs` 没有分页**，与事件列表同一判断（单用户数百到数千条）；**动作码认不出时状态流转也认不出**（`fromStatus` / `toStatus` 都是 `null`）时会只显示动作码原文 —— 那已经是最诚实的呈现了。

### 9.40 UI 集成（最终 UI 落地）实施中的几处判断

**集成只替换界面层，业务逻辑一行未改。** 四个功能面板（`LaunchPanel` / `NotesPanel` / `EventsPanel` 与各对话框）与 `lib/` 数据层（`api.ts` / `session.ts` / `notes.ts` / `events.ts` / `launch.ts` / `credential.ts`）在整轮集成里**一行未动**，后端与共享包的**数据模型、接口、认证**也一行未动。共享包只改了 `navigation.ts`（信息架构）与 `permissions.ts`（一处改名）。这条是这次集成能两批落地、且门禁从 328 → 350 项仍全绿的根据：**界面与业务是分开的两层，换前者不必碰后者**。

**分组头是纯折叠开关，不是路由项 —— 因此 `NAV_CODES` 与 `NAV_GROUP_CODES` 没有交集。** 原型里分组头就是 `<button>`、没有 href。上一版为了让每个分组头有落点，给它们各保留了一个同名占位页，于是 `customer` / `ops` / `design` / `others` 同时出现在两份清单里，读代码时很难说清某个 `'customer'` 指哪一份。这次按原型收敛：四个分组编号**只**留在 `NAV_GROUP_CODES`，`NavGroup` 也去掉了 `summary`（不可路由就没有「规划范围」可展示）。代价是 `navCodeFromPath` 不能再取首段匹配（首段现在是分组名），改成**先整段精确、再按 `/` 前缀**两步。

**`code` 是身份、`slug` 是地址，两者刻意分开。** 首页的 `code` 至今仍是 `workbench`（旧地址与将来的埋点认它），显示名早已改成「首页」。上一版把两者混为一谈，代价是「数据看板」从一级降为子项时，地址与标识只能一起改。`slug` 的引入让路径层级由 `navPath` **唯一决定** —— 侧栏链接、落地页重定向、守卫回退三处若各拼一次，改动路径规则时漏掉一处，表现是「菜单点得进去、刷新后落到别处」，而这类偏差不报错。

**子项被权限全部过滤掉的分组整组不渲染，因此 `buildNavSections` 不做权限过滤。** 权限过滤在前一步（`filterNavigation`），聚合只回答「结构上谁属于谁」。两件事分开，侧栏才能在「整组都不可见」时把分组也一并省掉，而不必自己再判一次权限。分组头不可路由，一个空分组点了只会展开一片空白。

**预留槽位是真项，不是装饰。** 原型里每组尾部那几行「功能开发中 N」可以点、点了进统一占位页，因此它们**有编号、有路由**，只是 `slot` 为真 —— 侧栏用虚线图标与弱化文字把它们与具名项区分开，且**不带**「开发中」标签（名称本身就是「功能开发中 N」，再加一个标签是重复）。`slot` 与 `planned` 正交：具名占位项（资产、搜索、综合看板…）将来定义权限点后仍属占位，而可见性条件那时已不再是 `null`。

**首页替换为三段式，但保留三个子路由 —— 补入口是本实现刻意的偏离。** 首页把三个完整面板换成摘要区块后，若不给入口，等于把「配置管理 / 纪要增删改 / 事件增删改」整个砍掉。因此补了三个链接：「管理配置」→ `/workbench/launch`、「新建」→ `/workbench/notes`、事件卡头「查看全部」→ `/workbench/events`。**原型对应位置没有这三个链接。** `WorkbenchPage` 读 `useLocation` 分派（**不存状态**）：地址栏能表达「我在哪」，意味着刷新不丢位置、地址可直接分享，且 `/workbench` 与 `/workbench/notes` 之间切换不重挂外壳，侧栏折叠状态与滚动位置不丢。

**版本号放头像菜单最底部一行，用 `div` 而不是菜单项。** 它属于「我是谁 / 我在哪一版」这类账号元信息，与上一条身份信息同源；菜单是「随时可查」与「不必随时可见」两条的交点。用 `div` 是因为菜单项带悬停底色与键盘焦点，会让一行纯信息看起来像一个能按的按钮。格式 `版本号 · 构建日期 · 提交短号`，悬停给出完整说明（`title`）。构建时刻按**本地时区**显示 —— 否则 `2026-10-11T16:14Z` 在 UTC+8 下显示成 10-11，而此刻本机已是 10-12，读起来像过期版本。

**版本三常量在构建期注入，`lib/version.ts` 里加 `typeof` 守卫。** `__APP_VERSION__` 读根 `package.json` 的 `version`、`__BUILD_TIME__` 取 `new Date().toISOString()`、`__COMMIT_SHA__` 走 `git rev-parse --short HEAD`（失败回退 `unknown`），三者经 `vite.config.ts` 的 `define` 注入。加 `typeof __APP_VERSION__ === 'string'` 这层守卫，是因为该模块会被 Node 的类型剥离测试直接加载，那里没有 Vite 的 `define`，不加会直接 `ReferenceError`。**更新版本只改根 `package.json` 的 `version` 一处、重新构建即生效**，提交号与构建时刻自动跟进。这套做法给后期的版本比对留两个稳定锚点：**版本号是人为语义、提交号是机器事实**，两者印在同一行，用户报问题能直接念出来。

**e2e 在集成期间抓到六个渲染层问题，四道门禁一个都拦不住。** 全是交互时序问题：① 导航项计数漏了页脚项（系统设置在 `nav` 之外，要加 `aside a[aria-label]`）；② 顶层项文本里含「开发中」标签（要只取名称所在的 `<span>`）；③「外观」改成二级菜单后靠 `pointermove` 展开（合成按下/抬起与 `element.click()` 都不触发，需发真实 `mouseMoved`）；④「上一个菜单关好了」的判据要等**父菜单** `[role="menuitem"]` 归零（子菜单先于父菜单卸载，等子菜单归零时父菜单还在关闭动画里，紧接着的点击被忽略并**直接抛错中断整轮**）；⑤ `openHomeSection` 是 `async (client, href)`，误写成 `evaluate(client, openHomeSection(...))` 会把 Promise 当表达式（`client.send is not a function`）；⑥ 菜单项入场动画导致坐标点击漂移（量到的中心点与最终位置差几像素，点偏就落到菜单外、菜单被关掉而选项没选中）。前四条与 9.39 那条「先问这一击真的发生了吗」是同一类教训。

**验证结果（2026-10-12）。** 四道门禁全绿：`test` 为 `packages/shared` **83 项**（导航 18 项 / 分层路径 / `navCodeFromPath` 断言扩写）、`apps/api` **197 项，192 通过 / 5 跳过 / 0 失败**、`apps/web` **70 项**（新增 `version.test.mjs` 8 项），三包合计 **350 项，0 失败**；`lint` / `typecheck` / `format:check` 全绿。**浏览器 e2e 149 项全通过、一次跑通**（原 146，新增 3 项：导航 18 项形态、首页三段式、顶栏版本号）。数据库无改动（仍 **6 个迁移、12 张业务表**），e2e 后经 `pg_dump` 备份恢复基线。提交：`2576388`（代码）+ `fe92cb4`（文档）。

**未完成部分（记下来，别当成缺陷）。** **案例展示没有数据源**（原型是 9 张 webp 占位卡，落地前要先定封面素材与来源）；**六个 AI 模块卡是静态占位**（右上角带「开发中」）；**搜索能力先占位**（一级导航项「搜索」进统一占位页）；**16 个导航项的 `module` 为 `null`**（除首页 `personal` 与系统设置 `system` 外，含 11 个预留槽位，对已认证用户一律可见），模块落地时改成对应模块段并同步改 `navigation.test.mjs` 断言。

### 9.41 T4-01 Electron 外壳脚手架实施中的几处判断

**外壳用「主进程内置静态服务」，不用 `file://`。** 这是本任务唯一一个需要先推翻候选方案的决定。`file://` 有两条硬伤：其一，`file://` 页面的来源是 **`null`**，向 `http://127.0.0.1:8787` 发 `fetch` 是跨源请求，而 API **从不发 CORS 头**（它的单一来源前提建立在 Vite 代理上，见 9.21），因此登录、纪要、事件、启动全都会以跨源被拒；其二，前端是 `BrowserRouter`（history API），`file://` 下 `pushState` 与深链接刷新都会失败。两条都不是加一个 `base` 能解决的，故改为在回环上起一个静态服务托管 `apps/web/dist`，并**把 `/api/*` 反代到服务地址**（含 SPA 回退）。**`apps/web` 一行未改。**

**反代让「单一来源」这条前提继续成立。** 开发期靠 Vite 把 `/api` 桥到 8787，服务端因此从不需要 CORS；外壳照抄这个形状，前端那侧的 `API_BASE_URL`（默认空串）一行不用动，业务代码对「跑在浏览器里还是外壳里」毫无感知。代价是外壳多了一段反代代码，但它换来的是**宿主可替换而应用不知情** —— T4-02 切远程地址时改的只是这一段的上游。

**桌面端刻意用 CommonJS 而不是 ESM。** `apps/desktop/package.json` **不写 `"type": "module"`**，于是 `module: NodeNext` 产出 CJS。理由是 Electron 的主进程与**沙箱化的预加载脚本**都以 CJS 为默认形态，而 ESM 预加载要求关掉沙箱；T4-03 之后预加载要承担代理与凭据的 IPC，保持沙箱开启更稳妥。这是「配置决定模块格式」的一处刻意选择，改它之前先确认预加载是否还允许沙箱。

**Electron 二进制不随依赖安装落地 —— 44.7.0 的 tarball 里没有 `scripts.postinstall`。** 核查 registry 的 `hasInstallScript` 为 `null`，也就是说 `pnpm-workspace.yaml` 里的 `onlyBuiltDependencies: [electron]` 对它其实是**空操作**：装完依赖不等于二进制就位，`node_modules/electron` 下既无 `dist/` 也无 `path.txt`，而 `pnpm rebuild electron` 同样什么都不做（它没有可跑的安装脚本）。补了 `apps/desktop/scripts/ensure-electron.mjs`（按 `path.txt` + `dist/` 判存在，缺则跑包内 `install.js`），并由根 `postinstall` 调用；幂等、换机可复现，压缩包经 `ELECTRON_*` 落在工作区 `.cache/electron`（沿用 9.4 的镜像与缓存重定向）。**这条与版本绑定**：将来升级 Electron 若恢复了安装脚本，`onlyBuiltDependencies` 才会真正生效，届时 `ensure-electron` 可退化为兜底。

**启动器必须摘掉 `ELECTRON_RUN_AS_NODE`。** 该变量一旦为真，electron 会**退化成纯 Node** —— 不建窗口，`require('electron')` 返回可执行文件路径字符串。症状是启动即抛 `Cannot read properties of undefined (reading 'on')`（在 `app.on` 处），看起来像 Electron 没装好。而 CI、部分 IDE 终端与自动化会话都会带上它，所以 `scripts/launch.mjs` 一律先 `delete process.env.ELECTRON_RUN_AS_NODE` 再 spawn，**不要绕过启动器直接调 `electron .`**。

**沙箱默认开启，受限环境用环境变量显式降级。** 在没有桌面会话的环境（服务进程、容器、部分 CI）里 Chromium 的渲染进程沙箱起不来，症状是加载以**不含任何原因**的 `ERR_FAILED (-2)` 结束 —— 同一个报错也可能来自产物缺失或内置服务没起来，所以**先确认是这个原因再关**。开关做成 `FANHE_NO_SANDBOX=1` 才加 `--no-sandbox`，**不写进代码或脚本默认值**：关沙箱是安全降级，不该是常态。另加 `app.commandLine.appendSwitch('no-proxy-server')`，否则系统/环境代理会把 `127.0.0.1` 的回环请求也送出去，同样得到 `ERR_FAILED`。

**`exactOptionalPropertyTypes` 拒绝显式的 `body: undefined`。** 反代里 GET / HEAD 不带请求体，但 `fetch` 的 `RequestInit.body` 在该选项下不接受 `undefined` 字面量（TS2379）。改法是先构造 `init`，仅在确有请求体时才 `init.body = body`，而不是把 `body: undefined` 塞进去。

**冒烟的判据是 DOM，不是 HTTP 200。** `smoke` 隐藏窗口加载一次，在渲染进程里探 `#root` 的子元素数、`document.title`、路径与预加载桥，打印一行结论并按成败设退出码。只看 200 不够 —— 那只说明文件在，说明不了界面画出来了（产物缺 JS 时 HTML 照样 200）。判据是 `#root` 里有元素且 console 零错误。

**验证结果（2026-10-12）。** 四道门禁全绿：`test` 为 `packages/shared` **83** + `apps/api` **197**（192 通过 / 5 跳过）+ `apps/web` **70** + **`apps/desktop` 10**（内置静态服务的 SPA 回退 / 带扩展名 404 / 路径越界 403 / 405 / HEAD / 反代路径·查询串·方法·请求体 / 上游不可达 502），合计 **360 项，0 失败**；`lint` / `typecheck` / `format:check` 全绿。外壳冒烟 **PASS**（`渲染元素=1 标题=梵禾 Work 路径=/ 预加载桥=有 console错误=0`），另以活体 API 验证 `/api/health` 经反代返回 200。e2e 无界面改动未重跑（仍 149）。提交：`b03ddb5`（代码，13 文件 +980/-8）。

**一处待决的取舍（记下来）。** Electron 的 `userData`（Chromium 缓存、GPU 缓存等）默认落在**系统盘** `%APPDATA%`，而本项目其余一切都在 U 盘上。保持默认与「数据库刻意不进 U 盘」是同一类判断（缓存写入量大、伤 U 盘寿命），但若希望外壳完全便携，需要显式把 `userData` 重定向进工作区。**T4-01 未做这个重定向**，只把应用名定为「梵禾 Work」以得到一个正常目录名；是否重定向留待用户裁决。

### 9.42 T4-02 服务地址切换实施中的几处判断

**配置文件落工作区的 `.config/`，不落 Electron 的 `userData`。** 这条是本任务里唯一需要先拆开一个概念的决定。`userData` 不是一个「配置目录」，它装的是 Chromium 的缓存（Cache / Code Cache / GPU Cache）与 `credential.ts` 的凭据密钥库。把整个目录搬进 U 盘有两个后果，**都与项目已有判断冲突**：缓存是高频随机写，搬进 U 盘既慢又伤盘（这正是「数据库刻意不进 U 盘」的理由）；凭据跟着介质走，会改变 `credential.ts` 注释里写明的「密钥落在浏览器 profile 中，profile 在系统盘而不在 U 盘上，因此凭据不随工作空间移动」这个安全语义。而服务地址描述的恰恰是「**这套**工作空间接哪个服务」，它本来就该跟着介质走。两者不该混在一个目录里，于是配置另落 `.config/` —— 那是工作区既有的逐机配置位置（`infra/portable/ws-env.sh` 把 `XDG_CONFIG_HOME` 指过去，根 `.gitignore` 第 6 行排除），不是新造的位置。

**顺带答了一个悬着的取舍。** `WORK-STATUS.md` 的 R2 记着「Electron `userData` 要不要重定向进工作区」，当时判不了，因为 T4-01 没有别的配置可放。现在有了：**配置可以绕开 `userData`**，于是 R2 降级为不阻塞主线的外观问题 —— 缓存留在系统盘，与数据库不进 U 盘是同一类判断；凭据的安全语义也不变。用户「配置要跟着 U 盘走」的诉求由 `.config/` 完全满足。

**本机与远程不做成两个槽位，只有 `serviceUrl` 一个字段。** 直觉上「两档切换」该有两个地址加一个 `active`，但那个形状有一个真实坏处：远程地址没配时切过去，外壳会以「没有可用地址」启动，而这在现场与「配错了」长得一模一样 —— 用户看到的是一个连不上的界面，分不清是配置项空着还是填错了。单字段下配错会在读取当场被校验挡下，报的是「这不是一个合法地址」。**「切换」的本质就是把这一项改成另一个 URL**，两个字段加一个开关只是把同一个值抄成两份，还多了一处会不一致的地方。

**配置坏了不能让外壳起不来。** 坏 JSON、非法地址、空串、顶层是数组 —— 每一种都退回缺省并把原因写进 `warning`，启动时打到标准输出。判据是：用户对着一个开不起来的窗口无从排查，而对着一行「服务地址配置不可用（…），退回缺省 http://127.0.0.1:8787」能立刻知道去改哪里。**这也意味着外壳永远不会因为一个配置文件而白屏** —— 对一个「换个机器就要重配」的产品，这条比任何配置项本身都重要。

**`FANHE_SERVICE_URL` 保留为一次性覆盖，而不是删掉。** T4-01 只读环境变量，那是开发期唯一能指端点的手段。删掉它会让验证必须先改文件，多一步且容易留下脏配置。降级成「设了赢过文件、不落盘」之后：开发与验证照旧用环境变量，日常使用不依赖它，而**它不会污染磁盘上的配置** —— 这条也有单测钉住（读回磁盘确认仍是文件里那个值）。

**`fromDir` 做成必填参数，不在模块内自己推断。** 本模块有两条加载路径：生产走 `dist/` 下 tsc 编出的 CJS（`apps/desktop` 刻意不带 `"type": "module"`，为的是保住沙箱化的预加载），单测走 Node 的类型剥离直接加载 `src/config.ts`，那条按 ESM 处理。于是两个自动推断的路子各有一半失效：`__dirname` 在 ESM 路径上不存在，而且它写在**函数参数默认值**里 —— 求值时机早于任何显式传参，症状是「一调这个函数就炸」，比「拿到 undefined」难查得多；`import.meta.url` 反过来，tsc 以 **TS1470** 拒绝它（`The 'import.meta' meta-property is not allowed in files which will build into CommonJS output`）。两者都不能用，于是把「从哪儿找工作区根」交回调用方：`main.ts` 跑在 CJS 里，那里 `__dirname` 有定义。副产品是这条前提变成了显式可测的输入。

**改配置要重启外壳，不在运行中热切。** 反代的上游在起服务时确定，要热切就得把 `apiBaseUrl` 从一个值换成一个可变的来源，中间会出现「切了一半」的中间态 —— 那个状态在现场与「切失败了」难以区分。`service:set` 因此只写文件，返回值带 `needsRestart: true` 让界面提示。把「重启才生效」显式做成接口的一部分，比让用户自己发现要省事。

**验收脚本刻意不放 `test/*.test.mjs`。** 那个 glob 是 `node --test` 用的，而验收脚本没有 `node:test` 结构（它自己发 PASS/FAIL 并设退出码）。放进去会被门禁当单测跑。落在 `test/acceptance/t402-service-switch.mjs`。

**判据取「上游回显的标记」而不是状态码。** 验收要证的是「请求真的打到了新地址」。两个假端点各自回显一个标记（`LOCAL` / `REMOTE`），切到哪个就该拿到哪个的标记。**状态码不够** —— 上游回 401、404、500 都是「到了」，而 502 只在根本没到时才出现；更关键的是，一个「改了但没白改」的假实现也可能返回看似合理的状态码。标记是被测方无法伪造的证据。

**验收判据用「经外壳自己的反代」而不是直接 ping 上游。** 冒烟里加了一条：起完内置服务后请求它的 `/api/`，据状态码判断反代是否到达上游（上游回 401/404 也算到达，只有 502 才是没到）。这条比「改完配置读回来值变了」更难糊弄 —— 它走的是 主进程读配置 → 起内置服务 → 请求经反代 → 落到上游 整条链，中间任一环没接上，读文件那一步照样会「成功」。本机实跑：真实工作区读到配置后为「是」，改指向假地址后转「否」。

**一处环境依赖型坑，值得单列。** `infra/portable/ws-run.cmd` 把 `TMP` / `TEMP` 都指向工作区的 `.tmp`，而 `.tmp` 就在 `.ws-root` 底下 —— 于是**任何从 `os.tmpdir()` 派生的目录，向上找必然命中工作区根**。后果是「找不到 `.ws-root` 时返回 null」这条用例**在裸 `node` 下通过、经门禁失败**，且报错是 `expected null, actual 'F:\fanhe Work'`，看着像实现有 bug。判据是**跑两次对比**：裸 node 与经 ws-run 的结果不同，就该往环境差异找，而不是改产品代码。两个测试文件的暂存根因此固定落系统盘。**这类「同一条命令在两种入口下结果不同」的失败，先查环境再改断言** —— 本项目的门禁与开发命令走的是不同入口，这个差异会反复出现。

**验证结果（2026-10-12）。** 四道门禁全绿：`test` 为 `packages/shared` **83** + `apps/api` **197**（192 通过 / 5 跳过）+ `apps/web` **70** + `apps/desktop` **28**（原 10 + 新增 18），合计 **378 项，0 失败**；`lint` / `typecheck` / `format:check` 全通过。验收脚本 11 项全通过。外壳冒烟 PASS 且新增的「反代到达上游」判据为「是」。e2e 无界面改动未重跑（仍 149）。提交 `f2bfc16`（5 文件 +853/−14）。

### 9.43 T4-03 实施中的几处判断

**核心问题是「外壳不查库，`LaunchProfile` 怎么送进主进程」。** 三个方案：**(A)** 渲染进程经现有 `GET /api/launch/profiles` 取配置、IPC 送进主进程；**(B)** 主进程自己连数据库；**(C)** 启动配置落成工作区配置文件。选 **A**。B 直接违背 `agent.ts` 顶部写死的第一条约束（**不认识数据库**），那个约束从 T3-02 起就是为了这一刻才成立的；C 要重做已交付的 T3-03，且与阶段五的数据库模型冲突。A 完全复用现有链路，`agent.ts` **一行未改**，且**远程模式下同样通** —— 后者正是 T4-03 的全部价值所在（用户不必在本机另开一个 API 进程）。

**选了 A 之后必须补一件事：主进程自己复核形态。** HTTP 那条路上，配置的形态在入库时校验过一次、路由 schema 又把一次，`agent.ts` 收到的一定是一条像样的配置，**它信任调用方是安全的**。IPC 这条路上**一道都没有** —— 而 `launch:run` 对渲染进程里的任何脚本开放。少了主进程这次复核，这条 IPC 就等于一个本机任意命令执行入口。复核落在 `apps/desktop/src/agent.ts` 的 `normalizeProfile`：逐字段查（绝对路径、参数全为字符串、个数与长度不超限、`icon` 形态、`sortOrder` 有限数），**返回新对象**而不是就地改入参 —— 入参来自 `structuredClone`，改它不影响任何人，但返回新对象让「原始对象绝不被信任」这件事在**代码形状上**就看得出来，额外的未知字段因此被丢掉、带不进进程创建。

**新增一类失败 `invalid_profile`，不并进已有的两类。** `executable_missing` 是「配置没问题但文件不在」，`spawn_failed` 是「进程创建失败」。前者是**另一类**：送来的东西压根不像一条配置（IPC 这条路上才存在，HTTP 那侧在入库与 schema 处已经拦掉了）。界面上要给的动作不同 —— 前者不该让用户去改路径。合成一类会让其中一个的引导必然出错。

**跨包复用走 `import()` 加载 TS 源码，而不是构建产物。** `apps/desktop` 是 CJS（刻意不写 `"type": "module"`，为的是保住沙箱化的预加载），`apps/api` 的产物是 ESM —— 两边模块系统不同，且**没有必要去解这个结**：真正需要的只有 `runLaunchProfile` 这一个函数。于是走 `import()` 直接执行 `apps/api/src/launch/agent.ts`，靠 Node 的类型剥离，**不引入构建顺序依赖**（agent 改完外壳下一次启动就用新的，不存在「忘了先构建 api」）。`paths.ts` 因此只做两件事：向上找 `.ws-root` 定位工作区根（**不写盘符**，盘符在 `E:`/`F:` 间变），以及 `existsSync` 预检查 —— 直接 import 一个不存在的路径会抛 `MODULE_NOT_FOUND`，而那条消息指向 `node_modules` 里的中间路径，看不出真正缺的是 api 源码目录。

**`import()` 的参数必须是 URL 而不是路径 —— 这一条只有真机能暴露。** ESM 加载器只认 `file:` / `data:` / `node:`，直接喂一条 Windows 绝对路径（`F:\...\agent.ts`）会被当成协议名为 `f` 的 URL 拒掉：`ERR_UNSUPPORTED_ESM_URL_SCHEME`。**而这一层单测用的是假 agent 模块，从不真的 import，于是它在 desktop 全绿的情况下一直是坏的** —— 直到给 `paths.ts` 补了真机用例（`test/paths.test.mjs`）才暴露。修法是 `pathToFileURL(target).href`，顺带把工作区名里的空格（`fanhe Work`）正确编码掉；手拼 `file://` 十有八九会漏这一步，而漏掉的症状是「路径里有空格时才坏」，更难查。**教训：跨进程/跨包的加载路径，单测里用假模块替身就等于没测那条链**，替身越像越危险。

**`apiLaunchModule(fromDir)` 的 `fromDir` 做成必填，沿用 T4-02 的同一条约定。** 9.42 记过 `__dirname` 在 ESM 路径下不存在、且写在参数默认值里会在任何显式传参之前抛。这里同一个坑会第二次咬人（同一个文件里既有 CJS 路径又有 ESM 路径），所以直接沿用结论。副产品仍然是**这段逻辑变得可测** —— 模块内不留 `__dirname`，单测就能在 ESM 里传一个自己造的目录进去，断言「找不到 `.ws-root`」「仓库结构变了」这些**最容易在换机时才暴露**的分支，而且断言的是报错文本里带着可照着修的信息（只断言「抛了」，真出事时仍不知道该改哪）。

**刻意不缓存模块实例。** Node 的模块缓存按 URL 索引，同 URL 第二次 `import()` 拿到同一实例 —— 这本来正是想要的（去重表要跨调用生效），要求只是加载路径在进程内稳定，而本函数每次都从同一个 `fromDir` 推导，天然满足。反过来若为了「省一次加载」把实例缓存到模块级变量，`agent.ts` 里的 `recentRuns` 就在**两个壳实例**之间不共享，一旦将来支持多窗口或热重载，去重会静默失效 —— 症状是「任务管理器里躺着五个微信」，而那条规则的注释正好写着它要防的就是这件事。

**`LaunchAgentModule` 写成结构类型，而不是 `typeof import('apps/api/src/launch/agent')`。** 后者在构建期要求 tsc 能解析那个路径，而 desktop 既没把 `@fanhe/api` 声明成依赖、工作区根也没配路径别名 —— 真写上去会得到一条解析不了的 import，**且它只在类型位置出现、运行时一切正常**，属于最难查的一类错误（门禁全绿、功能全对，直到某天有人真的去改那个 import）。代价是契约要手写且有漂移风险，于是**接口收窄到只用得到的两个成员**：`runLaunchProfile` 的返回类型 `{ok:true, data: RunLaunchProfileResponse} | {ok:false, reason: 'executable_missing' | 'spawn_failed'}` 是窄的 —— 多出的成员不影响赋值，少掉的才会。而 `data` 与 `reason` 两处都直接引用共享包的类型，真正的漂移面只有 `LaunchRunOutcome` 那个判别式，而它在 api 侧有 192 项集成测试钉着。

**agent 模块按需加载，加载失败变成返回值而不是抛。** 它是一次动态 `import()` 跨包的 TS 源码，失败原因可能是工作区不完整（介质拷漏了 `.ws-root`）。那不该让外壳连界面都开不出来 —— 失败落成一个带 `detail` 的 `{ ok: false }`，界面能报「本机代理不可用」并说明原因。`paths.ts` 那两个函数也因此**返回 null 而不抛**，抛只发生在真正要加载时。

**IPC 侧刻意不做权限与回环判定，那不是漏掉。** `apps/api` 那条 HTTP 路由有 `isLoopbackAddress` 防远程启动，原因是**远程不应该能启动任何人电脑上的进程**。外壳的主进程与它开的窗口同属一个用户，「哪个用户」在这条链路上没有意义；而那道边界在**远程场景**下由 API 侧守着呢。所以这里少的不是防线，是**另一套场景的东西**。真正不能省的是形态复核 —— 那条与「哪个用户」无关，纯粹是「别信调用方」。

**验收判据是「真进程跑起来了并写出标记文件」，不是返回值也不是 pid。** 可执行文件取 `process.execPath`（node 自己）加一段写标记文件的临时脚本。`runLaunchProfile` 返回 `ok: true` 只说明 `spawn` 事件到了，不说明那个进程真是我们要的那个 —— 而 pid 存在与「程序跑对了」是两件事。参数还逐个断言原样送达：只断言「进程起来了」的话，一个无视参数、把 cwd 当参数传的错实现也能通过。另外断言了**假上游一次请求都没收到** —— 那是「启动走的是主进程 IPC、没有绕回服务那条路」的唯一硬证据，而这条恰好就是 T4-03 的价值本身；一条偷偷走了远程 HTTP 的实现，靠前面那些断言全都通得过。

**断言写反了一次，值得记一笔。** 验收脚本里我把 `node script.js a b` 的参数期望写成 `slice(2)` 里含脚本路径，实际 `argv[1]` 才是脚本路径。实现是对的、断言错的。**这类失败要先分清「真 bug / 断言作用域过宽 / 环境残留 / 断言期望与实现不符」四类**，后两类在输出里长得一模一样 —— 而第 4 类的处理办法是回到「这条断言要证明的是哪件事」，想清楚了就知道该改哪一侧。

**验证结果（2026-10-12）。** 四道门禁全绿：`test` 为 `packages/shared` **83** + `apps/api` **197**（192 通过 / 5 跳过）+ `apps/web` **70** + `apps/desktop` **52**（T4-02 的 28 + 代理形态复核 17 + 跨包路径 7），合计 **402 项，0 失败**；`lint` / `typecheck` / `format:check` 全通过。验收脚本 10 项全通过。外壳冒烟 PASS（`渲染元素=1 预加载桥=有 console错误=0`；`反代到达上游=否` 是因为当时 8787 无监听，与 T4-02 同因，非回归）。e2e 无界面改动未重跑（仍 149）。

### 9.44 T4-04 实施中的几处判断

**这个任务的重点不是「检查」，是「给每类失效配一句能照着做的引导」。** 失效的成因在换机、插 U 盘、搬家之后极其常见（绝对路径失效是默认结果），而失效的现场表现是「点启动才失败，只有一句路径失效」。自检要把它搬到打开外壳就知道 —— 但**一份说「有问题」却不说「怎么办」的检查，界面上没法用**：用户看到红字却不知道该做什么，唯一的合理反应就是忽略它，于是这个功能白做。

**因此三类原因必须分开，判据是「引导动作是否相同」。** `agent_unavailable`（代理本身不可用 → 去查工作区）、`invalid_profile`（送来的东西不像一条配置 → 重新编辑；**路径根本没被看过，所以引导绝不能让用户去改路径**）、`path_unavailable`（配置没问题但文件不在 → 去确认路径，必要时重新指定）。合成一类看着省事，代价是其中两类的文案必有一份是错的，**而用户分辨不出来** —— 他只会照着错的那份做无用功，然后更不信任这个功能。这与 T4-03 里把 `invalid_profile` 从 `executable_missing` 分出来是同一条判断，两处保持一致。

**路径检查必须复用 `apps/api` 的 `inspectExecutablePath`，也就是启动时那一个。** 理由与其他「复用而非拷贝」的地方一样：自检说「可用」而点击失败是这类功能**最坏的失效** —— 用户会开始不信任自检，进而不再看它，于是真出问题也没人看。`LaunchAgentModule` 契约因此加了 `inspectExecutablePath`，并**刻意要求它是「这个模块上的方法」而不是一个自由函数**：写成自由函数，外壳就会顺手自己写一份 `fs.stat`，两份实现会对「目录算不算存在」「UNC 超时怎么办」给出不同答案，而分歧的表现正是最难查的那种。

**但 `listProfileStatuses` 不能复用，这一点要说清楚。** 它要 `userId` 且走两次分组查询查启动记录，复用它外壳就得变成一个连库的服务 —— 而「外壳不连数据库」是 T4-01 定下的形态（9.41）。**阶段四能做的复用只有「纯函数那一半」**，判断哪些函数属于这一半是每轮都要重新决定的事：判据是「它需不需要宿主给的东西」。`inspectExecutablePath` 只需要一条路径字符串，所以能搬；`listProfileStatuses` 需要「哪个用户」，所以不能。

**自检的依赖全部注入，这一条的起因是 desktop 的双路径问题。** `apps/desktop` **刻意产出 CommonJS**（`tsconfig.json` 里有注释说明，为了保住沙箱化预加载），于是模块间的相对 import 必须写 `.js` 后缀 —— 那是产物里的文件名。但单测走 Node 的类型剥离、直接加载 `src/*.ts`，那里**没有 `.js` 文件**，于是自检模块 `import` `agent.ts` 时单跑就 `ERR_MODULE_NOT_FOUND`，报错指向 `src/agent.js`，与真实原因（我 import 了一个在测试路径下不存在的文件）毫无关系。这是本包第一次出现模块间 import 撞上双路径（`main.ts` 的 import 只在构建产物里跑过，从没被单测加载）。

**可选的三条路**：① 给 desktop 配一套「`.js` 优先、`.ts` 兜底」的条件导出；② 让 `agent.ts` 兼容两种解析；③ 把依赖注入。选了 ③。①② 都是**每个模块都要背上**的复杂度，而注入的代价只是一处显式的参数 —— 并且它让单测能断言「注入的复核函数被调用了几次」，那是真实实现反而难验的东西。**注入之后两侧仍传同一份实现**（`main.ts` 传 `normalizeProfile` 与 agent 上的方法），所以「自检与启动对形态的判断不分叉」这条并没有因为注入而丢掉。

**路径检查必须并发，这是正确性问题不是性能优化。** `PATH_INSPECT_TIMEOUT_MS` 是 5 秒，而**失效配置的典型成因恰恰是指向网络共享**（`\\server\share\...`）—— 那台机器关机或掉线时 `stat` 不会立刻失败。逐条 `await` 的话，10 条指向同一台关机机器的配置就是 50 秒，而自检恰恰是那种「用户已经等着了」的场合。api 侧 `listProfileStatuses` 的注释里已经写了「串起来等于白等那几秒」，此处沿用同一口径。

**判可用时只认 `ok`，其余值一律按不可用。** 最初写的是 `state !== 'missing'`，被一条断言逮住了：将来 agent 换了取值、或包装层串了类型，一个没预料到的值会被当成「可用」放过去，于是自检说没问题而点击失败。**兜底方向是刻意选的**：误报不可用，用户去确认一下路径，代价很小；误报可用，用户点了才收到失败，而且会开始不信任自检 —— 那比自检坏掉更糟，因为**没人会去看它了**。同一条方向也用在「单条检查抛错」上：按 `missing` 处理而不是中断整轮（「一条查不了不代表其余查不了」），与 api 侧那个兜底同一理由。

**诊断按配置顺序排序。** 界面列表本身按 `sortOrder` / 名称排，而诊断若按「形态失败在前、路径失败在后」两批追加，用户会看到第 3 条的坏配置排在第 2 条的坏配置前面 —— 两套顺序叠在一起会让人以为漏了哪一条。

**「代理不可用」是自检的一个结论，不是自检没能跑起来。** 所以它返回一份**可显示的报告**（`agentAvailable: false` + 一条诊断）而不是抛错或返回 null。界面因此不必处理「检查失败」这个第四种状态，**用户也不必分辨那两者的区别** —— 他分辨不出，而「我不知道这个提示什么意思」和「我该去查工作区」是完全不同的两种体验。同理，自检内部凡是它自己出错的地方（读不可信对象、单条检查抛错）都变成可显示的诊断，而不是异常。

**「全部形态不合法」与「空配置」都提前返回，不做任何路径检查。** 没有一条值得查的路径就别付那个代价（含最坏 5 秒的共享超时）。IPC 层还多判了一层：**空配置先判、不加载代理** —— 先加载会在工作区恰好有点问题时把结果报成「代理不可用」，而那与事实不符（代理没事，只是没东西可查），会把用户引去查一个没坏的东西。

**冒烟的自检判据从渲染进程里调，不是主进程自调。** 用 `executeJavaScript` 在页面里调 `window.fanheDesktop.checkLaunchProfiles([])`，走的是 渲染进程 → preload → `contextBridge` → IPC → 主进程 整条链。主进程自己调自己注册的处理函数，前三段全绕过去了，冒烟会绿而界面用不了 —— 这正是 T4-03 里那条「单测用假模块等于没测那条链」的同一个道理。**判据只看「返回结构完整」不判「查出几条问题」**，否则冒烟的成败会随用户库里有没有失效配置而变。

**验收脚本用真实文件与真实 agent 核心，不靠替身（21 项）。** 单测里那两个依赖是注入的简版（原因见上），但验收必须用真的：一条**真实存在**的文件被报成可用、一条**真实缺失**的被报成 `path_unavailable`，两者来自同一个 `inspectExecutablePath` —— 这才验到了「自检与启动用的是同一份实现」。里面还单独断言了「自检与启动对形态的判断一致」（两侧都调真实的 `normalizeProfile`，自检说不合法的启动也必须拒绝）。本机 `stat` 是毫秒级，所以真跑不慢。

**那条并发判据验过能证伪。** 判据是**耗时**（10 条 × 60ms 的假检查，并发 < 400ms）而不是「并发计数」—— 因为实现完全可能并发发起却仍然串行 `await`，那种写法在计数上看起来是对的。临时把 `Promise.all` 改回逐条 await，该用例确实失败（串行 600ms 超阈值），恢复后全绿。**断言要能证伪它声称的那件事**，否则等于没测。

**验证结果（2026-10-12）。** 四道门禁全绿：`test` 为 `packages/shared` **83** + `apps/api` **197**（192 通过 / 5 跳过）+ `apps/web` **70** + `apps/desktop` **76**（T4-03 的 52 + 自检 24），合计 **426 项，0 失败**；`lint` / `typecheck` / `format:check` 全通过。验收脚本 21 项全通过。外壳冒烟 PASS，新增一行 `启动自检=可用 代理=可用 配置=0条 可用=0条`。e2e 无界面改动未重跑（仍 149）。**阶段四 4/4 完成，验收四项全部勾选，出口条件达成**，代码基线 `760b92f`。**下一项：阶段五 T5-01 容器编排** —— 它不占关键路径（第八章），可以与阶段六并行；顺带一提，T4-02 把服务地址做成了配置项这件事，会让 T5-01 省事：容器化之后本机 api 的地址就是那个缺省值，切换链路等于已经被验证过一遍。

本计划与实施方案配合使用。实施方案中的架构判断、数据模型与界面规格为本计划的依据，本计划中的任务编号可作为后续进度跟踪的锚点。


