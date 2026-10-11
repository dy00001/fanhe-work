# 梵禾 Work 项目全景扫描报告

> 扫描时间 2026-10-11。扫描范围覆盖工作空间根下全部受版本控制的内容，以及运行时目录的现状抽样。
> 本文只描述事实与判断，路径一律以工作空间根为基准，不写盘符。

---

## 零、扫描范围与方法

| 项目 | 说明 |
| --- | --- |
| 扫描对象 | 工作空间根 `fanhe Work` 下 `infra/`、`projects/`、根级配置文件 |
| 排除对象 | `node_modules/`、`.cache/`、`.tmp/`、`.config/`、`.local/`、`runtime/`、`.venv/`、各工具 home |
| 版本控制 | 仓库根即工作空间根，远端 `origin/main`，当前 HEAD `ea119ab`，工作树干净 |
| 生成物 | `apps/api/src/generated/`（Prisma 客户端）、`dist/`、`e2e-shots/` 均被忽略，未跟踪 |

受版本控制的实质内容集中在两处。`infra/` 是工作空间机制，`projects/fanhe-work/` 是唯一的业务项目。

---

## 一、工作区顶层结构

工作空间按「归属与变更节奏」切成两类内容，物理分开。

```
fanhe Work/
├── infra/                 机制层，随机制演进，变更频率低而影响面大
│   ├── portable/          入口脚本、配置与运行时状态
│   └── docs/              机制文档
├── projects/              业务层，随业务迭代，变更频繁
│   └── fanhe-work/        唯一的业务项目，pnpm monorepo
├── .workbuddy-ai/         本机助手记忆，被忽略，不随仓库走
├── .ws-root               工作空间定位标记，跨盘符定位的唯一依据
├── README.md              工作空间说明
├── .editorconfig          编辑器约定
├── .gitattributes         换行与二进制约定
├── .gitignore             忽略规则
└── .cache/ .tmp/ .local/ .config/ logs/ .venv/ runtime/
    .gradle/ .m2/ .cargo/ .rustup/ .go/ .nuget/ .docker/    运行时重定向目标
```

划分依据是审计与备份的边界。机制文件的变更会同时影响所有项目，业务文件的变更只影响自身。混在一起时，改业务代码容易误动机制文件。

---

## 二、文件清单与职责

### 2.1 机制层 `infra/`

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `portable/ws-env.ps1` | 257 | PowerShell 环境解析。导出 `WS_ROOT` 与全部重定向变量，是机制的核心 |
| `portable/ws-env.sh` | 203 | bash 版本的环境解析，供 Git Bash 使用 |
| `portable/ws-run.ps1` | 78 | PowerShell 入口。解析环境后在调用者目录执行命令 |
| `portable/ws-run.sh` | 41 | bash 入口。行为与 PowerShell 版一致 |
| `portable/ws-run.cmd` | 22 | cmd 入口。定位自身目录，转发给 `ws-run.ps1`，优先用 `pwsh` |
| `portable/ws-repair.ps1` | 238 | 换机修复例程。处理盘符变化后的链接与配置重建 |
| `portable/ws-doctor.ps1` | 178 | 审计工具。扫描硬编码盘符、忽略规则覆盖、状态脏污 |
| `portable/ws-locate.ps1` | 71 | 跨盘符定位。靠向上查找 `.ws-root` 还原根路径 |
| `portable/ws-state.ps1` | 117 | 运行时状态的读写封装，对应 `state/root.json` |
| `portable/ws-enable-devmode.ps1` | 98 | 开启 Windows 开发者模式，符号链接能力的前置条件 |
| `portable/ws-enable-devmode.cmd` | 33 | 上者的 cmd 包装 |
| `portable/config/.npmrc` | 20 | npm 源与缓存重定向。源固定为 npmmirror，缓存路径用 `${WS_ROOT}` 展开 |
| `portable/config/.yarnrc.yml` | 6 | Yarn Berry 的缓存与全局目录重定向 |
| `portable/state/root.json` | 10 | 运行时状态。记录上次挂载的盘符、卷标、主机名与用户 |
| `portable/state/.gitkeep` | 0 | 占位，保证目录存在 |
| `docs/PORTABLE-WORKSPACE.md` | 230 | 机制的目标、适用范围、触发方式与需规避场景 |
| `docs/FILESYSTEM-OPTIONS.md` | 149 | 摆脱 exFAT 约束的三条路径对比 |
| `docs/NTFS-MIGRATION.md` | 213 | NTFS 迁移操作手册与执行记录 |
| `docs/WORKSPACE-STATUS.md` | 160 | 工作空间当前状态快照 |

重定向覆盖的维度较广，包括临时目录、各类包管理器缓存、语言工具链 home、浏览器与 Electron 二进制缓存。

### 2.2 项目根配置 `projects/fanhe-work/`

| 文件 | 职责 |
| --- | --- |
| `package.json` | monorepo 根。声明 `packageManager: pnpm@10.33.0`、`engines.node >= 22`，集中定义 dev/build/test/lint/format/db 脚本 |
| `pnpm-workspace.yaml` | 工作区声明 `apps/*` 与 `packages/*`。`onlyBuiltDependencies: []` 是有意留空 |
| `tsconfig.base.json` | 全仓 TS 基线。`strict` 之外开启了 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 等强约束 |
| `eslint.config.js` | ESLint 10 扁平配置。按浏览器、Node、端到端脚本三层分配 globals |
| `.prettierrc.json` | 无分号、单引号、printWidth 100，挂 Tailwind 类名排序插件 |
| `.prettierignore` | 格式化排除项 |
| `.gitignore` | 项目级忽略。覆盖 `data/`、`apps/api/src/generated/`、`e2e-shots/`、`.env` |
| `docker-compose.yml` | PostgreSQL 16 容器定义。ICU `zh-CN` 排序规则、仅回环绑定、健康检查 |
| `pnpm-lock.yaml` | 锁文件 |
| `README.md` | 项目主文档。起步流程、目录结构、强制约定、数据库、认证、版本取舍、常见问题 |
| `apps/desktop/.gitkeep` | Electron 外壳占位，阶段四启用 |
| `data/.gitkeep` | 本地数据目录占位 |
| `docs/mockups/` | 6 个文件。UI 方案预览稿，其中 `index.html` 是方案索引，另有 `main-frame` 与三套方案页 |

### 2.3 后端 `apps/api/`

依赖栈为 Fastify 5、Prisma 7.10.0、`@prisma/adapter-pg`、`pg`、`jose`、`@node-rs/argon2`、`dotenv`。

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/index.ts` | 11 | 进程入口。构建 app 后监听端口，失败退出码 1 |
| `src/app.ts` | 43 | 应用构建。装配 AJV 策略、认证容器与三组路由，暴露 `/api/health` |
| `src/config/env.ts` | 157 | 环境变量的唯一读取处。含整数上下界与密钥最小字节数的强制校验 |
| `src/db/prisma.ts` | 29 | Prisma 客户端单例。挂 `globalThis` 以跨热重载复用连接池 |
| `src/db/seed.ts` | 136 | 种子脚本。写入 11 个权限点、4 个内置角色与 29 条关联，事实来源是共享包 |
| `src/audit/audit.ts` | 82 | 审计写入。定义结构化的最小日志接口 |
| `src/auth/password.ts` | 112 | Argon2id 哈希与校验，含 `needsRehash` 参数弱化判定 |
| `src/auth/tokens.ts` | 119 | 访问令牌签发校验与刷新令牌生成。HS256，刷新令牌只存 SHA-256 |
| `src/auth/login.ts` | 259 | 登录编排。含账号与 IP 双重限速、时间填充抗枚举、锁定计数 |
| `src/auth/session.ts` | 306 | 刷新令牌轮换与撤销。含 `familyId` 整链撤销与并发宽限期 |
| `src/auth/setup.ts` | 176 | 首次初始化引导。已有 owner 时关闭入口 |
| `src/auth/guard.ts` | 187 | 认证与授权守卫。`requireAuth` 与 `requirePermission` 两个 preHandler |
| `src/launch/agent.ts` | 264 | 本机代理核心。见第四节，是阶段四搬迁的关键 |
| `src/launch/profiles.ts` | 359 | 启动配置的读写与排序，恒带 `userId` 归属条件 |
| `src/launch/history.ts` | 182 | 启动记录写入与摘要查询，按用户保留最近 500 条 |
| `src/launch/status.ts` | 41 | 路径状态与历史摘要的并发装配 |
| `src/launch/loopback.ts` | 44 | 回环地址判定。启动接口的第二道防线 |
| `src/routes/auth.ts` | 193 | 登录、刷新、登出、`/me` 四个端点 |
| `src/routes/launch.ts` | 389 | 启动配置的 8 个端点，全部挂权限守卫 |
| `src/routes/setup.ts` | 87 | 初始化状态查询与初始化提交 |
| `src/tools/create-owner.ts` | 59 | 命令行恢复超级管理员 |
| `src/tools/ping-db.ts` | 48 | 数据库连接自检，打印表与行数 |
| `prisma/schema.prisma` | 370 | 数据模型。9 张表与 3 个枚举，注释密度很高 |
| `prisma.config.ts` | 45 | Prisma 7 配置文件。连接串、迁移目录与 seed 命令 |
| `prisma/migrations/` | 4 个 | `init`（6 表）、`login_rate_limit`、`launch_profiles`、`launch_history` |
| `tsconfig.json` / `tsconfig.test.json` | | 源码与测试两套编译配置 |
| `.env.example` | | 环境样例。`DATABASE_URL` 有默认值，`JWT_SECRET` 留空必填 |
| `test/` | 10 个 | 见 2.5 |

### 2.4 前端 `apps/web/`

依赖栈为 React 19、react-router 8、Vite 8、Tailwind 4、Radix UI 与 shadcn/ui。

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/main.tsx` | 15 | 挂载入口 |
| `src/App.tsx` | 59 | 顶层装配。错误边界、认证 Provider 与路由 |
| `src/routes.tsx` | 85 | 路由表。由 `NAV_ITEMS` 派生，含模块守卫与 404 |
| `src/index.css` | | Tailwind 4 入口与设计令牌 |
| `src/auth/context.ts` | 38 | 认证上下文定义 |
| `src/auth/AuthProvider.tsx` | | 会话状态与自动续期 |
| `src/auth/useAuth.ts` | 18 | 消费上下文的 hook |
| `src/auth/useVisibleNavItems.ts` | 20 | 按权限过滤导航项 |
| `src/lib/api.ts` | 279 | 传输层。只拼地址与拆信封，刻意不认识会话 |
| `src/lib/session.ts` | 218 | 会话。访问令牌只放内存，刷新令牌走持久化，含静默续期 |
| `src/lib/credential.ts` | 284 | 记住账号密码。AES-GCM 加密后写 localStorage，密钥不可导出存 IndexedDB |
| `src/lib/launch.ts` | 102 | 启动通道数据层。包一层令牌、拆信封、按错误码分流恢复动作 |
| `src/lib/preferences.ts` | 107 | 本机界面偏好，只存 localStorage |
| `src/lib/theme.ts` | 95 | 主题解析与生效，与偏好存储分工 |
| `src/lib/relative-time.ts` | 54 | 相对时间，用 `Intl.RelativeTimeFormat` |
| `src/lib/launch-icons.ts` | 117 | 软件标识到图标的映射 |
| `src/lib/nav-icons.ts` | 21 | 导航项到图标的映射，写成全量 `Record` 以在编译期兜住新增项 |
| `src/lib/utils.ts` | 20 | `clsx` 加 `twMerge` 的类名合并 |
| `src/components/AppShell.tsx` | | 外壳布局，承担侧栏与顶栏 |
| `src/components/AuthLayout.tsx` | | 未认证页面的版式 |
| `src/components/TopBar.tsx` / `Sidebar.tsx` | | 顶栏与侧栏，含折叠态 |
| `src/components/StateView.tsx` | | 空、加载、错误三态收敛 |
| `src/components/ErrorBoundary.tsx` / `ModuleHeader.tsx` / `TextField.tsx` | | 通用件 |
| `src/components/launch/LaunchPanel.tsx` | 543 | 启动板块主面板 |
| `src/components/launch/LaunchProfileDialog.tsx` | 369 | 新增与编辑对话框 |
| `src/components/launch/LaunchProfileRow.tsx` | 223 | 单行渲染，含失效徽标与只读隐藏 |
| `src/components/ui/` | 16 个 | shadcn/ui 官方源码原样搬入，不随项目风格改写 |
| `src/pages/` | 7 个 | Setup、Login、Workbench、Placeholder、NoAccess、NotFound、Error |
| `index.html` | | 宿主页。含主题与折叠状态的内联初始化脚本 |
| `vite.config.ts` | | 开发服务器绑 IPv4 回环，`/api` 代理到后端 8787 |
| `tsconfig.json` | | 声明 `@/*` 路径别名，与 vite 的 resolve.alias 对应 |
| `components.json` | | shadcn 配置，new-york 风格，zinc 基色 |

### 2.5 共享包与测试

`packages/shared/` 是构建型包，产物在 `dist`，两个应用消费编译结果。

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/index.ts` | 26 | 出口。只放跨端共用的类型与常量 |
| `src/permissions.ts` | 248 | 权限点与角色的唯一事实来源。含通配符展开与精确匹配 |
| `src/navigation.ts` | 203 | 一级导航的唯一事实来源。含可见性与激活项解析 |
| `src/launch.ts` | 286 | 启动配置的跨进程结构与取值规则，含路径形态判定 |
| `src/auth.ts` | 115 | 认证相关的传输结构 |
| `src/account.ts` | 68 | 账号相关结构 |
| `src/audit.ts` | 25 | 审计相关结构 |

测试共 5747 行，覆盖后端 9 个测试文件、前端 2 个、共享包 3 个。

| 测试文件 | 行数 | 覆盖范围 |
| --- | --- | --- |
| `apps/api/test/launch.test.ts` | 583 | 启动配置 CRUD、归属隔离、排序、边界校验 |
| `apps/api/test/launch-history.test.ts` | 493 | 记录写入、去重不记、保留策略、摘要查询 |
| `apps/api/test/login.test.ts` | 446 | 登录成功与各类失败、抗枚举的时间一致性 |
| `apps/api/test/launch-run.test.ts` | 390 | 进程启动、去重窗口、失败分类 |
| `apps/api/test/session.test.ts` | 382 | 刷新轮换、整链撤销、并发宽限 |
| `apps/api/test/audit.test.ts` | 368 | 审计写入与四类事件 |
| `apps/api/test/permission.test.ts` | 323 | 403 边界与权限点校验 |
| `apps/api/test/setup.test.ts` | 291 | 初始化引导与入口关闭 |
| `apps/api/test/tokens.test.ts` | 134 | 签发校验、篡改、过期、签发者受众 |
| `apps/api/test/password.test.ts` | 91 | 哈希往返、盐随机、旧参数可校验、重算判定 |
| `apps/api/test/test-env.ts` | 22 | 测试环境变量固定 |
| `apps/api/test/helpers/db.ts` | | 数据库测试夹具 |
| `apps/web/test/e2e-auth.mjs` | 1759 | 浏览器级端到端。驱动本机 Chrome 走 DevTools 协议 |
| `apps/web/test/relative-time.test.mjs` | 104 | 相对时间格式 |
| `packages/shared/test/permissions.test.mjs` | 113 | 通配符展开与五种写法 |
| `packages/shared/test/navigation.test.mjs` | 168 | 可见性过滤与激活项回退 |
| `packages/shared/test/launch.test.mjs` | 80 | 路径形态判定 |

### 2.6 项目文档 `docs/`

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `IMPLEMENTATION-PLAN.md` | 448 | 实施方案。回答做什么与为什么这样选 |
| `DEVELOPMENT-PLAN.md` | 1128 | 开发计划。回答按什么顺序做、产出什么、怎样算完成，第九章逐任务记录实施判断 |
| `WORK-STATUS.md` | 224 | 自包含的任务记录与换机续接指南，当前状态的索引与快照 |
| `HANDOFF-2026-10-10.md` | 642 | 第一份交接文档，含整体进度与设计决策 |
| `HANDOFF-2026-10-11.md` | 130 | T3-04 当日补记 |

`.workbuddy-ai/memory/` 下有 7 个文件，记录环境事实、测试约定、界面令牌规格与逐日工作记录。该目录被忽略，不随仓库移动。

---

## 三、关键入口文件

按重要性排序，以下五个文件决定了系统的行为边界。

| 排名 | 文件 | 入口性质 |
| --- | --- | --- |
| 1 | `infra/portable/ws-run.cmd` | 工作空间唯一入口。所有包管理操作必须经它进入，否则环境重定向不生效 |
| 2 | `projects/fanhe-work/package.json` | 任务入口。全部开发动作的脚本定义在此 |
| 3 | `apps/api/src/index.ts` | 后端进程入口。`app.ts` 负责装配，本文件负责监听 |
| 4 | `apps/web/src/main.tsx` | 前端挂载入口。`App.tsx` 负责顶层装配，`routes.tsx` 负责路由 |
| 5 | `infra/portable/ws-env.sh` / `.ps1` | 环境入口。`WS_ROOT` 与全部重定向变量的注入点 |

另有两处属于「约定入口」，新增功能时必须改这里。

| 文件 | 为什么是入口 |
| --- | --- |
| `packages/shared/src/permissions.ts` | 新增权限点或角色只改这一处，类型、清单与种子数据都由它派生 |
| `packages/shared/src/navigation.ts` | 新增一级模块只改这一处，菜单、路由表与可见性判定都由它派生 |

---

## 四、核心模块解析

### 4.1 `apps/api/src/launch/agent.ts`：本机代理

这是全项目设计密度最高的模块，两条硬性约束决定了它的形态。

第一条，不认识数据库、认证与 HTTP。入参是一条已取好的 `LaunchProfile`，出参是一次进程创建的结果。这样设计的目标是阶段四能把这个文件原样 import 进 Electron 主进程，把路由换成 IPC 即可，核心逻辑一行不改。

第二条，只能启动配置，不能启动命令。接口只接受配置 id，路径与参数都来自库里用户自己存下的那一行。若接口允许把路径与参数一起提交，它就成了本机任意命令执行入口。

模块内部还有三处值得注意的实现判断。去重窗口取 3 秒并只缓存成功结果，失败不进缓存以便用户改完路径立刻重试。进程创建以 `spawn` 事件为准而非 `spawn()` 返回，避免在进程未创建时回一个成功。子进程 `stdio` 设为 `ignore` 并调用 `unref`，工作台退出不牵连被启动的客户端。

### 4.2 `apps/api/src/auth/`：认证与授权

令牌分两层。访问令牌是 HS256 的 JWT，默认 15 分钟，服务端不存，代价是无法单独撤销。刷新令牌是不透明随机串，只存 SHA-256 哈希，可撤销，用 `familyId` 把一次登录衍生的整条轮换链归组，检测到重放时整链撤销。轮换设了 10 秒宽限期，用于区分并发刷新与令牌泄露。

登录失败只有一种响应，账号不存在、密码错误、账号停用、账号锁定都返回 401 与同一句话。配套的是三处时间填充，即使不查库也执行一次假哈希校验。这条设计针对的是账号枚举攻击。

授权每次请求都查库，不做缓存。理由写得很明确，权限点不进令牌，撤权才能立刻生效。将来要优化应当给角色加版本号，而非给缓存设一个拍脑袋的 TTL。

### 4.3 `apps/api/src/launch/loopback.ts`：回环判定

44 行代码，承担的是安全边界。启动接口的动作是创建进程，而任何能在用户机器上跑起来的东西都能向回环端口发请求。两道防线叠加，来源必须是回环，并且必须持有有效会话与写权限。整个 `127.0.0.0/8` 段都判为回环，`undefined` 一律判否。

### 4.4 `packages/shared/src/permissions.ts`：权限模型

权限点固定三段式 `模块.对象.操作`。授权模式支持五种写法，通配符的吃法取决于位置。末尾的 `*` 吞掉剩余全部段，非末尾的 `*` 只匹配一段。这两者必须区分，否则 `personal.*.read` 会退化成 `personal.*`，只读角色静默拿到写权限。展开只在种子阶段做一次，运行时只做精确匹配。

### 4.5 `apps/web/src/lib/`：前端分层

七个模块形成一条清晰的分工链。

| 层 | 模块 | 职责 |
| --- | --- | --- |
| 传输 | `api.ts` | 只拼地址、拆信封，刻意不认识会话 |
| 会话 | `session.ts` | 令牌存放、静默续期、失败回登录页 |
| 凭据 | `credential.ts` | 加密保存账号密码，密钥不可导出 |
| 领域 | `launch.ts` | 把需要令牌这件事从界面拿掉，按错误码分流恢复动作 |
| 偏好 | `preferences.ts` | 本机观感偏好，读写失败静默回落 |
| 表现 | `theme.ts` | 把偏好变成 DOM 状态 |
| 工具 | `relative-time.ts`、`utils.ts`、两个 icons | 无状态纯函数 |

`api.ts` 不认识会话是刻意的，续期流程自身要用它，反过来依赖会成环。

---

## 五、依赖关系

### 5.1 包级依赖

```
apps/api  ──依赖──>  @fanhe/shared (workspace:*)
apps/web  ──依赖──>  @fanhe/shared (workspace:*)
apps/desktop         阶段四启用，当前为空
```

`@fanhe/shared` 是构建型包，产物在 `dist`，两个应用消费编译结果。这是最容易踩坑的一处依赖关系。直接跑 `pnpm --filter @fanhe/api dev` 会跳过 shared 的构建，改动不生效。根脚本 `dev`、`dev:api`、`dev:all` 都会先构建一次。

`shared` 不依赖任何运行时框架，也不引入数据库客户端。api 侧的 Prisma 类型留在 `apps/api`，一旦从 shared 导出，web 的构建会被拖上数据库依赖。

### 5.2 运行时依赖链

```
浏览器 ──/api 代理──> Fastify 8787 ──Prisma adapter-pg──> PostgreSQL 根 docker-compose.yml
                          │
                          └──spawn──> 本机客户端进程（工作台不管理其生命周期）
```

前端开发服务器绑 IPv4 回环并把 `/api` 代理到后端，浏览器侧只有一个来源，开发期不需要 CORS。

### 5.3 数据模型关系

九张表分三类，分类规则写在 schema 注释里。

| 类别 | 表 | 时间戳与删除策略 |
| --- | --- | --- |
| 实体表 | `users`、`roles`、`permissions`、`launch_profiles` | 三种时间戳齐备，软删除 |
| 关联表 | `role_permissions` | 只带 `createdAt`，取消授权即物理删除 |
| 流水表 | `login_attempts`、`refresh_tokens`、`audit_logs`、`launch_history` | 只带 `createdAt`，不软删除 |

外键关系上，`users` 是中枢。`refresh_tokens`、`launch_profiles`、`launch_history` 对 `users` 走级联删除，`audit_logs` 对 `users` 走 `SetNull`。后者是刻意的，删账号不能连带抹掉它做过的操作痕迹。

`launch_history` 同时依赖 `launch_profiles`，两级都走级联。配置走软删除，因此删掉配置不会带走历史。

### 5.4 任务级关键路径

按 `DEVELOPMENT-PLAN.md` 第四章，关键路径为 T1-07 权限中间件到 T3-01 启动配置，再到 T3-02 本机代理，进而到 T4-03 代理并入外壳。`agent.ts` 的形态判断就落在 T3-02 与 T4-03 之间，这是它必须一次定对的原因。

---

## 六、代码风格约定

分为三层，从工具强制到团队默契。

### 6.1 工具强制层

| 维度 | 约定 | 约束来源 |
| --- | --- | --- |
| 缩进 | 默认 4 空格，JS/TS/JSON/YAML/CSS/HTML 为 2 空格，Python/shell 为 4 空格 | `.editorconfig` |
| 换行 | 仓库内统一 LF，`.cmd`/`.bat`/`.ps1` 为 CRLF | `.gitattributes` |
| 编码 | UTF-8 | `.editorconfig` |
| 格式化 | 无分号、单引号、printWidth 100、尾随逗号、箭头函数必带括号 | `.prettierrc.json` |
| 类名排序 | Tailwind 类名按插件规则自动排序 | `prettier-plugin-tailwindcss` |
| 类型严格度 | `strict` 之外开启 `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitOverride`、`noImplicitReturns`、`noUnusedLocals`、`noUnusedParameters` | `tsconfig.base.json` |
| 未使用变量 | 以 `_` 开头的参数、变量、捕获错误豁免 | `eslint.config.js` |
| 模块格式 | 全仓 ESM，`type: module`；后端 `NodeNext`，前端 `ESNext` 加 `bundler` | 各 `tsconfig.json` |

### 6.2 命名与结构约定

数据库侧有三条成文规则。模型名用单数大驼峰，物理表名用复数小写下划线。字段名用大驼峰，物理列名用小写下划线。时间列一律 `timestamptz(3)`，主键统一 UUIDv7 由客户端生成，前 48 位是毫秒时间戳，索引局部性接近自增列而不暴露总量。

后端路由与模块的对应关系是显式的。`routes/` 只做 schema 校验与守卫挂载，业务逻辑在 `auth/`、`launch/` 领域目录。`app.ts` 不做业务，只做装配。

前端有一条「组件与 hook 分文件」的约定。一个文件同时导出组件与 hook 会破坏 react-refresh 的边界，因此 `auth/context.ts`、`lib/theme.ts` 单独拆出。唯一的例外是 `components/ui/` 下的 shadcn 官方源码，那边在 ESLint 里显式关掉了该规则，理由是保持源码能逐行对照官方版本。

### 6.3 注释文化

这是本项目最鲜明的风格特征。注释密度接近代码量的一半，且几乎不写「这行在做什么」，而是写「为什么这样做、放弃了什么、代价在哪」。典型写法包含三部分，先给结论，再给替代方案的名称，最后给放弃替代方案的具体理由。

三处高频出现的判断句式值得在后续开发中保持。一处是「有意的，不是疏忽」，用于标记反直觉的选择，例如 `onlyBuiltDependencies: []` 与 `removeAdditional: false`。一处是「代价是」，用于明确记下取舍的成本。一处是「将来要改，改这里」，用于标注扩展点。

约束类注释会指出违规的后果与排查路径。例如把去重窗口做成环境变量会怎样，把失败也缓存下来会怎样，把授权改为通配匹配会怎样。

### 6.4 测试约定

后端用 Node 内置测试运行器经 `tsx` 跑 TS 源码，并发数固定为 1。前端单测用 `node --experimental-strip-types --test`，零第三方框架。共享包测试直接跑 `dist` 产物，因为写进库的就是那份展开结果。

测试命名上，负向用例的比重明显高于正向。`tokens.test.ts` 与 `login.test.ts` 的注释都写明这条理由，签发永远成功，安全边界完全落在校验那一步。

### 6.5 工作空间强制约定

五条，违反后问题往往延迟暴露。

1. 入口唯一，所有开发操作经 `infra/portable/` 下的入口进入。
2. 受版本控制的文件里禁止出现盘符，需要根目录用 `WS_ROOT`。
3. 路径含空格，脚本中所有变量必须加引号。
4. 跨环境传中文清单时读取侧必须显式指定 UTF-8。
5. `data/` 不进版本控制。

---

## 七、完成度评估

### 7.1 阶段总览

| 阶段 | 范围 | 状态 | 备注 |
| --- | --- | --- | --- |
| 阶段零 | 目录骨架，T0-01 至 T0-07 | 完成 | |
| 阶段一 | 账号与权限，T1-01 至 T1-12 | 完成 | 验收 7 项勾 6，余 1 项待账号管理接口 |
| 阶段二 | 主框架与 UI 骨架，T2-01 至 T2-07 | 完成 | 验收 6 项全勾 |
| 阶段三 | 个人工作台三板块，T3-01 至 T3-12 | 进行中 | T3-01 至 T3-04 完成，T3-05 起未启动 |
| 阶段四 | Electron 外壳，T4-01 至 T4-04 | 未开始 | `apps/desktop/` 仅有占位 |
| 阶段五 | 服务端化，T5-01 至 T5-05 | 未开始 | |
| 阶段六 | 更新通道，T6-01 至 T6-03 | 未开始 | |

### 7.2 已交付能力

账号与权限这一层是完整的。密码用 Argon2id 存储，参数可配且改参数不使旧哈希失效。双令牌体系齐备，含轮换、撤销与整链撤销。登录限速有账号与 IP 两个维度。首次初始化引导可用。审计写入链路与四类事件已完成。前端登录页、会话自动续期、记住账号密码三项均已落地。

主框架这一层是完整的。shadcn 组件接入，设计令牌集中定义，布局骨架、嵌套路由、占位页、三态收敛、折叠记忆、亮暗主题齐备。

启动通道板块已经打通端到端。配置的增删改排序、路径形态校验、进程启动、去重、路径失效提示、启动记录与摘要，从数据库到界面全链路可用。

### 7.3 代码规模

| 范围 | 行数 |
| --- | --- |
| 后端源码（不含生成物） | 3283 |
| 前端源码（含 ui 组件） | 3759 |
| 共享包源码 | 971 |
| 测试 | 5747 |
| 项目文档 | 2572 |
| 机制脚本 | 1136 |

测试与源码的比例约为 1.4 比 1，文档与源码的比例约为 0.3 比 1。这个比例在个人项目中偏高，与本项目的注释文化一致。

### 7.4 近期提交轨迹

最近 20 次提交呈清晰的「功能一次、文档一次」交替节奏。每次功能提交后紧跟一次文档提交，把实施判断回填进 `DEVELOPMENT-PLAN.md` 第九章并同步进度。这个节奏从阶段二一直保持到阶段三，是可复用的工作方式。

---

## 八、潜在问题与风险

按严重程度分三级。

### 8.1 已解决：盘符变化导致的依赖链接失效

**状态。** 2026-10-11 修复并验证通过。

现象是 `projects/fanhe-work/` 下四处 `node_modules` 的顶层符号链接全部失效。这些链接存的是绝对路径，指向 `E:/fanhe Work/...`，而工作空间当时挂载在 F 盘。`pnpm`、`tsc`、`vite` 等命令会立刻失败。

**判断需要修正的地方。** 依赖实体并没有丢失。`node_modules/.pnpm/` 下 415 个包目录完好，包文件是硬链接（抽样 `typescript/package.json` 的链接计数为 2），与 store 共享 inode，不受盘符变化影响。store 也在工作空间内部，位于 `.cache/pnpm-store/v10/`。真正失效的只有两样。一是顶层符号链接。二是 pnpm 的路径元数据，`.modules.yaml` 的 `storeDir` 与 `virtualStoreDir`、`.pnpm-workspace-state-v1.json` 的 workspace 根，两者都记为 E 盘。因此修复等级是重建链接，不涉及网络下载。

**处置。** 先把四处 `node_modules` 改名为 `.old` 作为保底，再执行 `CI=true pnpm install --offline --frozen-lockfile`。`--offline` 用于排除网络因素，`--frozen-lockfile` 保证不改锁文件，`CI=true` 用于跳过非 TTY 环境下的清除确认（缺少它会报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。

**结果。** 输出为 `resolved 413, reused 413, downloaded 0, added 413`，耗时 20 分 12.5 秒。`downloaded 0` 是决定性证据，证明 store 自给自足。耗时来自 U 盘的随机写性能，瓶颈在创建 413 个目录结构与链接，与网络无关。随后验证三项，八个关键包的符号链接全部可解析，`packages/shared` 构建通过，`apps/web` 类型检查通过。

**附带发现。** 机制的状态文件 `infra/portable/state/root.json` 已自动更新为当前环境（F 盘、主机 DY008、用户 Administrator），无需人工干预，与 `infra/docs/WORKSPACE-STATUS.md` 第 95 行的描述一致。更新前记录的是 E 盘、主机 DY、用户 dy，说明环境确实发生了迁移。

**数据库仍需单独准备。** 数据库数据在容器命名卷 `fanhe-work-pgdata` 上，不随介质移动。换机后需要重新 `docker compose up -d --wait`，复制 `.env`，再跑 `db:deploy` 与 `db:seed`。

### 8.2 中优先级，设计层面的已知张力

**修复例程与 pnpm 不匹配。** `infra/docs/PORTABLE-WORKSPACE.md` 第 15 行已写明原则，绝对路径只允许出现在可重建产物内，`node_modules` 属此类，因此本次失效落在机制的设计范围内，不算机制失灵。但 `infra/portable/ws-repair.ps1` 第 4 步用的是 `npm rebuild`，那是重建 npm 的 `.bin` 转发脚本与原生模块绑定的做法。本项目用 pnpm 的 isolated 链接器，失效形态是整棵依赖树的符号链接，`npm rebuild` 覆盖不到，还可能干扰 pnpm 的目录结构。这条需要补进机制文档，否则每次换盘符都要靠人手工判断该跑什么。

**可移动介质与数据库的固有矛盾。** 工作空间的前提是整体可携带，而 PostgreSQL 数据刻意不落在介质上。这条取舍的理由充分（闪存 U 盘的随机 IO 性能与写入寿命），但结果是换机后必须重建数据库，这与文档强调的「换机续接」体验存在落差。目前靠文档与 checklist 兜住，属可接受范围。

**迁移目录名字典序与实际创建顺序不一致。** 现有四个迁移恰好满足依赖关系，因此按字典序应用没有问题。`README.md` 与 `WORK-STATUS.md` 都明确提示了这一点，并指出不能宣称全部迁移互相独立。风险落在将来，若新迁移引用了时间上更晚创建的对象，故障形态是迁移顺序错误，而 Prisma 报错未必指向真正的原因。

**`packages/shared` 的构建型依赖。** 改动 shared 后若不重新构建，两个应用消费的仍是旧产物。根脚本已覆盖常见路径，但直接调用子包脚本会跳过。开发期可以另开终端跑 `pnpm dev:shared` 进入监听模式。

**浏览器级验证只覆盖 owner 角色。** `canWrite: false` 已隐藏只读角色的整行操作，但多角色的真实渲染与状态重查失败反馈没有进入端到端验收。`WORK-STATUS.md` 自己把这一条列了出来，并强调不能把服务端的 403 或代码里的隐藏逻辑算作多角色浏览器验收。

### 8.3 低优先级，已登记的遗留项

以下七项在 `WORK-STATUS.md` 第六节有明确登记，属有意留白而非遗漏。

| 遗留项 | 影响 |
| --- | --- |
| `users.passwordChangedAt` 未接入令牌载荷 | schema 与注释均已就位，签发侧尚未使用 |
| 改名未复用 `normalizeUsername` | 存在「只差大小写」的命名冲突绕过唯一约束的可能 |
| 账号与角色管理接口未实现 | 导致阶段一「关键操作在 audit_logs 有记录」一项无法勾选 |
| 客户、运营、数据看板三个占位项的 `module` 为 `null` | 当前对所有已认证用户可见，与「置灰加标签」的原始意图有偏差 |
| 状态重查无「检查中」状态与失败反馈 | 失败时保留上次快照，用户看不出检查发生过 |
| 路径 `stat` 的 5 秒超时只结束等待 | 不取消底层文件系统调用，不保证整个接口恰在 5 秒内返回 |
| 历史按用户保留 500 条 | 不永久保证「上次成功」可得，无记录时文案为「暂无近期启动记录」 |

另有两项属于版本取舍，已在 `README.md` 记录成因。TypeScript 固定在 6.x，因为 `typescript-eslint` 8.71.1 的 peer 上限是 6.1.0 且遇 TS 7 是导入即抛错。Prisma 钉 7.10.0，因为 `prisma` 包的 `latest` 标签指向预发布版本。

`onlyBuiltDependencies: []` 带来两个连带后果，esbuild 的 postinstall 被阻止（已确认无害，二进制由可选依赖提供），官方 `argon2` 包不可用（改用 `@node-rs/argon2`，二进制按平台分发，不含安装脚本）。

### 8.4 环境层面的已知坑

沙箱与工作空间机制叠加后，有几处反复出现的操作陷阱。

`docker compose` 的客户端配置不重定向，`DOCKER_CONFIG` 指向空目录会让它变成未知命令。跑 `prisma generate` 或门禁会打断正在运行的 `tsx watch`，因为生成过程会删除并重建文件。并行调用入口会撞车，两者同时写 `state/root.json` 会抛 `IOException`。入口下 `TEMP`/`TMP` 被重定向到介质上，`os.tmpdir()` 不可信。推送 GitHub 必须走本地代理，代理不对的症状是卡住而不是报错。

---

## 九、后续开发建议

### 9.1 接续前的必做动作

1. 经入口重装依赖，恢复 `node_modules` 的符号链接。
2. 重建数据库，`docker compose up -d --wait`、`db:deploy`、`db:seed`、`db:ping`。
3. 跑四道门禁确认环境完整，`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm format:check`。
4. 跑浏览器级端到端，预期 62 项全通过。
5. 确认 `state/root.json` 已更新为当前盘符，避免下次换机时误判。

### 9.2 下一项任务的可复用结构

T3-05 纪要模型与接口是下一个 P0 项。现成结构有三处可直接照搬。数据表照 `apps/api/src/launch/profiles.ts` 的写法，「用户私有、按所有者隔离」的模式已经跑通并有测试覆盖。界面三态走 `components/StateView.tsx`。前端数据层照 `lib/launch.ts` 的两层结构，`api.ts` 拼地址、领域层包令牌并拆信封。本机界面偏好已有 `lib/preferences.ts`，纪要若需要本机态可以直接复用。

### 9.3 需要提前决策的两处

一是三个占位导航项的权限点。`navigation.ts` 的注释已经把动作写清楚，等对象清单确定后把 `module` 从 `null` 改为实际取值，并同步改 `navigation.test.mjs` 的断言。

二是账号与角色管理接口。它同时是阶段一最后一项验收的前置，也是审计写入覆盖「授权变更」与「删除」两类事件的前置。若短期不排期，建议把那项验收显式标注为「依赖未实现功能」，避免它长期处于既未通过也未被排除的状态。

---

## 附、权威文档索引

| 关注点 | 文档 |
| --- | --- |
| 工作空间机制、入口、重定向、换机修复 | `infra/docs/PORTABLE-WORKSPACE.md` |
| 做什么与为什么这样选 | `projects/fanhe-work/docs/IMPLEMENTATION-PLAN.md` |
| 按什么顺序做、怎样算完成、逐任务实施判断 | `projects/fanhe-work/docs/DEVELOPMENT-PLAN.md` |
| 当前状态快照与换机续接 | `projects/fanhe-work/docs/WORK-STATUS.md` |
| 起步流程、强制约定、常见问题 | `projects/fanhe-work/README.md` |
| 逐机环境事实与踩坑 | `.workbuddy-ai/memory/ENVIRONMENT.md` |
| 测试约定、界面令牌规格 | `.workbuddy-ai/memory/TESTING.md`、`UI-TOKENS.md` |
