# 任务记录与换机续接指南（梵禾 Work）

> 本文档是一份**自包含的任务记录 + 换机续接手册**。目标是：在另一台机器上重新配置环境后，能凭此文档顺利接续开发，而无需依赖对话历史。
> 深度设计、架构判断与逐任务验收以 `DEVELOPMENT-PLAN.md`（第九章）为准；环境踩坑细节以 `.workbuddy-ai/memory/ENVIRONMENT.md` 为准。本文是它们的**索引与当日快照**。
>
> 生成时间：2026-10-11。记录时工作树干净、与 `origin/main` 同步（领先 0）。
>
> 更新 2026-10-11 15:40。以下事实点已变化，最新进度见 `PROGRESS-REVIEW-2026-10-11.md`。
> 其一，远端仓库已由私有改为公开，绑定与两条访问链路见 `WORKSPACE-BINDING.md`。
> 其二，`dev` 与 `main` **已对齐**在同一提交（`2cfdb42`）并各自推送，不再是「dev 落后 4 个提交」。
> 其三，数据库五个迁移全部应用，十张业务表齐备（另加 `_prisma_migrations`）。
> 其四，四道门禁本日实跑多次，`test`、`lint`、`typecheck`、`format:check` 全部通过。
> 其五，`node_modules.old` 此前未被忽略规则覆盖，会污染 lint 与 format，已修复。
> 其六，首个 owner 账号已创建（登录名 `fanhe`，口令写入被忽略的 `.tmp/owner-credentials.txt`）；由此 `apps/api/test/setup.test.ts` 的 5 项首次初始化用例转为设计性跳过。
> 其七，T3-05 纪要模型与接口已完成并提交（模型 + 八条接口 + 共享类型 + 31 项新测试），**界面尚未接上，属 T3-06**。
> 其八，`.tmp` 里的诊断脚本已归档到 `projects/fanhe-work/tools/`（盘符改为向上查找 `.ws-root`，`.ps1` 补 UTF-8 BOM）；`.tmp` 内 99% 的可重建缓存已清理，体积 73.6 MB → 0.4 MB。
> 其九，四处 `node_modules.old` **经分析确认应当删除但暂未删除**（约 489 MB、23802 个文件、软链接 100% 悬空于已不存在的 `E:` 盘），完整依据见 `SYNC-COMPARE-2026-10-11.md` 第十一节。
> 其十，**T3-06 Markdown 编辑与预览已完成并提交**：纪要界面接通（编辑器 / 预览 / 标签 / 置顶 / 归档 / 删除），一级导航补上二级路径这一层（`/workbench/notes`），依赖新增 `react-markdown` 与 `remark-gfm`；四道门禁全绿，三包合计 **227 项**（shared 58 + api 159 + web 10）；另用真实 owner 跑通八条接口冒烟 **23 项**。**浏览器 e2e 尚未执行**（脚本要求空库，见第七节）。

---

## 一、项目背景

**梵禾 Work** 是一个桌面端个人工作台（实验版），按「账号权限 → 主框架 → 个人工作台三板块（纪要 / 事件 / 启动）→ 桌面外壳」分阶段实现。

- **仓库**：整个工作空间根（可移动介质）整体推 `main`，远端 `https://github.com/dy00001/fanhe-work`（公开），凭据走 GCM。
- **提交身份**：`梵禾 <dev@fanhe.local>`（仅本仓库局部配置）。
- **项目目录**：`projects/fanhe-work/` 是代码主体；`infra/` 是工作空间机制；`.workbuddy-ai/` 被 Git 忽略（本地记忆，不随仓库走）。

### 技术栈

| 层 | 选型 |
| -- | -- |
| 桌面外壳 | Electron（阶段四，尚未实现） |
| 前端 | React 19 + TypeScript + Vite 8 + Tailwind 4（方案 B 现代极简） |
| 后端 | Node 22.22.2 + Fastify 5 + Prisma 7.10.0 |
| 数据库 | PostgreSQL `postgres:16-alpine`（容器，数据在命名卷，**不随 U 盘移动**） |
| 共享包 | `packages/shared`（跨进程类型与收窄函数，构建型包，输出到 `dist`） |

### 工作区包结构

```
projects/fanhe-work/
├── apps/
│   ├── api/        Fastify 后端 + Prisma + 迁移
│   ├── web/        React 前端（Vite）
│   └── desktop/    Electron 外壳（阶段四）
├── packages/
│   └── shared/     跨应用共享类型与工具（构建型）
├── docs/           规划与交接文档（本文所在处）
├── data/           本地数据目录（已忽略）
├── docker-compose.yml
└── package.json    pnpm 工作区根
```

---

## 二、当前进度总览

| 阶段 | 范围 | 状态 |
| -- | -- | -- |
| 阶段零 | 目录骨架 | ✅ 完成 |
| 阶段一 | 账号与权限（T1-01 ~ T1-12） | ✅ 完成（验收 7 项勾 6，余 1 项见第六节） |
| 阶段二 | 主框架与 UI 骨架（T2-01 ~ T2-07） | ✅ 完成（验收 6 项全勾，阶段二收口） |
| 阶段三 | 个人工作台三板块（T3-01 ~ T3-06） | 🔄 T3-01~T3-06 已完成并提交（启动通道 4 项 + 纪要 3 项中的界面已接上；检索 T3-07 与草稿恢复 T3-08 未做，事件板块 T3-09 起未开始） |
| 阶段四 | Electron 外壳 | ⬜ 未开始 |

**阶段三验收清单**：
- [x] 第一项：启动配置可新增、编辑、排序，可一键唤起
- [x] 第二项：路径失效有提示与重新指定入口（T3-04，浏览器 e2e 62/62 全通过）
- [ ] 第三项：纪要支持编辑预览、标签、置顶、检索、草稿恢复 —— **编辑预览、标签、置顶已在 T3-06 完成并可用**；检索属 T3-07、草稿恢复属 T3-08，两项未做，故整项不勾
- 其余验收项（折叠记忆、占位页、子路由等）随阶段二已落定

**最近提交**：
- `5d1883a` feat(阶段三): T3-05 纪要模型与接口
- `dba6198` docs(阶段三): 回填 T3-04 验证结果与迁移计数
- `bb29055` feat(阶段三): T3-04 启动记录与路径失效提示

---

## 三、已完成任务明细（阶段三）

- **T3-01 启动配置模型与接口**：`LaunchProfile` 模型、配置 CRUD 接口、按所有者隔离（`where` 恒带 `userId`）。
- **T3-02 本机代理与进程启动**：`apps/api/src/launch/agent.ts` 不依赖数据库/认证/HTTP，入参为已取好的 `LaunchProfile`，便于阶段四搬进 Electron 主进程。
- **T3-03 启动配置管理界面**：前端 `lib/api.ts`（只拼地址、不认会话）+ `lib/launch.ts`（`withAccessToken` 包一层、拆信封、按服务端错误码分流 `launchRunRecovery`）；界面三态走 `components/StateView.tsx`。
- **T3-04 启动记录与路径失效提示**（已提交 `bb29055`，含文档回填 `dba6198`）：
  - 新增 `launch_history` 表与第四迁移 `20261010180508_launch_history`。
  - `history.ts`：记录真实启动尝试（成功 / `executable_missing` / `spawn_failed`），去重命中不记；按用户保留最近 500 条；`loadLastRuns` / `loadLastSuccessAt` 分组查询。
  - `status.ts`：独立 `GET /api/launch/profiles/status`（挂 `read`，与列表分开），并发做文件系统检查 + 历史摘要。
  - 前端：行内「路径失效」徽标 + 「重新指定路径」入口（复用编辑对话框并聚焦路径字段）；表头「重新检查路径」。
  - 只读角色：`LaunchProfileRow` 的 `canWrite: false` 隐藏整行操作。
  - 相对时间：`lib/relative-time.ts`（`Intl.RelativeTimeFormat('zh-CN')`），前端零依赖单测 10 项。

- **T3-05 纪要模型与接口**（**只落模型与接口，界面属 T3-06**，已于 T3-06 接上）：
  - 新增 `notes` 表与第五迁移 `20261011064829_add_notes`。至此五个迁移、十张业务表（另加 `_prisma_migrations`）。
  - 标签用 `text[]` 加 **GIN 索引**，不另开 `tags` / `note_tags` 关联表；归档用 `archivedAt` 记时刻而非布尔；沿用 `deletedAt` 软删除；两处复合索引覆盖列表与归档视图。
  - `packages/shared/src/note.ts`：纪要跨进程类型、`NOTE_LIMITS` 上限、`normalizeNoteTags` 归一（去空白 + 精确去重，不做大小写折叠）、`isValidNoteTag` 判定。
  - `apps/api/src/note/notes.ts`：所有权在 service 层强制（`where` 恒带 `userId`），归属不符与不存在**统一返回 404**（不用 403，避免 UUID 存在性试探）；标题 trim、**正文不 trim**（Markdown 前导空白有意义）；先归一去重再判数量上限；列表排序三级键（置顶 → 更新时间 → 创建时间）；标签清单走 `unnest` 原生 SQL，**已归档计入、已删除不计**。
  - `apps/api/src/routes/notes.ts`：八条路由 —— 列表 / 标签清单 / 单条 / 新增 / 修改 / 删除 / 置顶 / 归档，读写分挂 `personal.note.read` 与 `personal.note.write`；`PATCH` 体要求 `minProperties: 1`；置顶与归档各自一条幂等 `PUT`。**不写审计**（私有用量，与启动配置同判）。
  - 测试：api 新增 21 项（`note.test.ts`）、shared 新增 10 项（`note.test.mjs`）。

- **T3-06 Markdown 编辑与预览**（本次重点，纪要界面已接通）：
  - 新增 `apps/web/src/components/notes/`：`NotesPanel`（四态分派容器，照 `LaunchPanel`）、`NoteList`（只按服务端顺序渲染）、`NoteEditor`（草稿态 + 提交前校验）、`MarkdownPreview`（`react-markdown` + `remark-gfm`，**不引 `rehype-raw`**）、`TagInput`（芯片 + 候选，拆分规则来自共享包）。
  - 新增 `apps/web/src/lib/notes.ts`：八条接口的会话感知封装、剥掉 `{notes}` / `{note}` / `{tags}` 信封、`noteFailureExit` 把 404 与其余失败分开。
  - `lib/api.ts` 补八条传输函数；`NoteListQuery` 只把真正给了的条件拼进查询串（服务端 schema 是 `additionalProperties: false`）。
  - **预览读草稿而不是已保存值** —— 这是验收要点「编辑与预览内容一致」的落点；草稿初值靠 `key` 区分新旧，不用 effect 同步。
  - **路由补上二级路径这一层**：`routes.tsx` 由精确 `path={item.code}` 改为「父路由 + `index` 子路由 + `MODULE_SUB_ROUTES` 的子路由」，`/workbench/notes` 因此可达；`WorkbenchPage` 加板块切换（`NavLink` 激活态驱动，不用组件状态）并按地址分派。
  - **共享包新增 `parseNoteTagInput`**：中英文逗号 + 换行三种分隔符，拆完复用 `normalizeNoteTags`；超长标签不丢弃、只标红。
  - **修掉一个空库死角**：编辑器原先只画在「列表非空」分支里，导致全新库上「新建」点了没反应、第一条纪要永远建不出来；改为可写角色一律渲染「左列表 + 右编辑器」，只读角色空库时才回落空态。
  - 依赖新增 `react-markdown@10.1.0` 与 `remark-gfm@4.0.1`（无 postinstall，`onlyBuiltDependencies: []` 不动）。
  - 测试：shared 新增 8 项（`parseNoteTagInput` 的分隔符与边界）；**前端本轮未加单测**（界面逻辑已下沉共享包或由传输/数据层承担，其余用浏览器 e2e 覆盖更划算）。
  - 接口冒烟：`.tmp/note-smoke.mjs` 以真实 owner 跑通 23 项（含「标题 trim / 正文不 trim」「空 body 的 PATCH 被 400 拒」「不存在 id 返回 404」「重复删除返回 `removed:false`」），跑完已清理残留。
  - **浏览器 e2e 未执行**：`test/e2e-auth.mjs` 已补上纪要整段断言，但要求空库，见第七节。

> 详细判断见 `DEVELOPMENT-PLAN.md` 9.28 ~ 9.33。

---

## 四、进行中开发

**无。** T3-06 已实现并提交，下一项 T3-07 全文检索尚未启动。本轮验证期间短暂起过一个 API 进程（8787）用于接口冒烟，验完即停；前端 5173 未启动。**浏览器 e2e 未跑**，原因见第七节第 1 条。

---

## 五、未提交的代码改动

**无。** T3-06 的代码 + 测试 + 文档回填随本次一并提交。提交后推送见第八节 8.5（必须走本地代理）。

---

## 六、遗留问题与已知边界

### T3-05 的明确边界（非缺陷，是有意留白）
- **界面尚未接上**：本轮只落模型与接口，`apps/web` 里没有纪要入口，前端测试数不变（10 项），端到端仍 62 项。**不要把「接口能测通」当成「功能可用」。**
- **列表分页未做**：`GET /api/notes` 目前一次返回该用户全部未删除纪要，没有分页参数；数据量上来后需要补。
- **全文检索属 T3-07**：标题与正文的中文关键词检索尚未实现。
- **`PATCH` 不接受 `pinned` / `archivedAt`**：这两个状态各有独立幂等 `PUT`，是有意设计而非遗漏。
- **标签无独立元数据**：没有颜色、描述，也不跨用户共享；「标签重命名」目前需要逐条改标签数组。
- **正文上限 10 万字符是防超大请求体的闸门**，不是业务约束。列类型是 `text` 不设宽度，改上限只需改 `NOTE_LIMITS.CONTENT_MAX` 与 schema 注释，**不需要迁移**。
- **`@updatedAt` 副作用**：置顶 / 归档都会刷新 `updatedAt`，取消置顶后该条会落到「最近修改」首位 —— 有意保留，与用户「我刚操作过它」的直觉一致。

### T3-04 的明确边界（非缺陷，是有意留白）
- `canWrite: false` 已隐藏 `LaunchProfileRow` 全行操作，但**浏览器级验证只覆盖 owner**；其他角色的真实渲染与状态重查失败反馈仍属后续边界，不能把服务端 403 或代码隐藏逻辑算作多角色浏览器验收。
- 路径 `stat` 的 5 秒超时**仅结束等待、不取消底层文件系统调用**；并发检查不逐条累加，但不保证整个 API 恰在 5 秒内返回。
- 历史按用户保留最近 500 条，**不永久保证「上次成功」可得**；无近期记录时文案是「暂无近期启动记录」。
- 状态重查**没有「检查中」状态，也没有失败反馈**；失败保留上次快照。

### 阶段一剩余验收项
- 「关键操作在 `audit_logs` 有记录」一项**未勾选**：写入链路与四类事件已完成，但「授权变更」与「删除」两类事件**尚无对应接口**（账号与角色管理功能未实现），待其 service 里接 `recordAudit`。

### 长期遗留（跨阶段，待排期）
- `users.passwordChangedAt` 接入令牌载荷。
- 改名复用 `normalizeUsername`（避免「只差大小写」的命名冲突绕过唯一约束）。
- 账号与角色管理的审计挂钩。
- 客户 / 运营平台的权限点定义。
- 三个占位导航项的 `module` 由 `null` 改为各自模块段，并同步改 `navigation.test.mjs` 断言。
- 阶段四将 `credential.ts` 存储后端换成主进程 `safeStorage`。

---

## 七、后续计划

1. **先办一件收尾事：跑一次浏览器 e2e。** `test/e2e-auth.mjs` 已补上工作纪要整段断言，但它要求数据库处于未初始化状态（`users` 表为空），而 owner 已经建好 —— 跑之前要先清库，跑完要重建 owner 并更新被忽略的 `.tmp/owner-credentials.txt`。重置语句见该文件头部注释（本次已补 `notes`）。**这段断言目前是「已写未验证」**，不要当成已通过的覆盖。当前库里除 owner 账号之外没有任何业务数据（启动配置 0 / 纪要 0 / 历史 0），因此清库的代价很低。

2. **下一项 T3-07 全文检索（P1）**：覆盖标题与正文，验收要点是中文关键词可命中。任务定义见 `DEVELOPMENT-PLAN.md` 第三章（第 186 行）。可直接复用的现成结构：八条纪要接口与 `lib/notes.ts` 已就位，检索入口落在 `NotesPanel` 的列表上方；`GET /api/notes` 的查询串目前只认 `tag` / `archived` / `from` / `to`，加检索要新增参数与对应的 service 查询。
   - **中文检索的难点是分词，这一点要先验证再定方案。** PostgreSQL 的 `to_tsvector` 默认分词不认中文，可行的方向是 `pg_trgm` 模糊匹配或 `ILIKE '%关键词%'`。别直接照搬英文全文检索那套（`tsvector` + GIN）——那条路在中文上会得出「搜不到」的结论，而现象看起来像是索引没生效。
3. T3-08 草稿自动保存（P1）：依赖 T3-06（现已具备）。落点是 `NoteEditor` 的草稿态加一层本机存储（照 `lib/preferences.ts` 的读写与静默降级），验收要点是「关闭后重进可恢复未提交内容」。
4. 阶段三收尾：T3-07 与 T3-08 完成后开事件记录（T3-09 起）。事件板块需要**新增第六个迁移**建 `events` 与 `event_logs` 两张表（目前不存在），且 `event_logs` 是只追加不修改的流水，设计时要与既有实体表的 `createdAt` / `updatedAt` / `deletedAt` 三件套区分开。
5. 阶段四 Electron 外壳（含 `agent.ts` 搬入主进程、凭据换 `safeStorage`）。

---

## 八、环境依赖与配置（换机必读）

### 8.1 唯一入口：工作空间机制
- **所有包管理（install / add / build / test / lint / format）一律经 `infra/portable/ws-run.cmd`**。直接裸跑 `pnpm` 会让 store 落到宿主机磁盘且当场无提示。
  - 工作空间根调用：`infra/portable/ws-run.cmd pnpm <cmd>`
  - 从 `projects/fanhe-work` 调用：`../../infra/portable/ws-run.cmd pnpm <cmd>`
  - 从 `apps/web` 深处调用：四层 `../../../../infra/portable/ws-run.cmd pnpm <cmd>`
- **并行调用入口会撞车**（同时写 `state/root.json` 抛 `IOException`），串行执行即可。
- 根靠向上查找 `.ws-root` 定位，不写死盘符；**受版本控制的文件禁止硬编码盘符**，需要根用 `WS_ROOT`；路径含空格时变量一律加引号。
- 入口下 `TEMP`/`TMP` 被重定向到 U 盘 `.tmp/`，`os.tmpdir()` 不可信；要让产物落系统盘需从 `LOCALAPPDATA` 推。

### 8.2 Node 与包管理
- Node 22.22.2（受管运行时）。包管理用 **pnpm**（corepack 垫片，`package.json` 已声明 `packageManager`）。
- `pnpm-workspace.yaml` 的 `onlyBuiltDependencies: []` 刻意禁掉生命周期脚本；装带二进制的包优先 napi-rs 系（如 `argon2` → `@node-rs/argon2`），避免 node-gyp 源码编译。
- `.npmrc` 固定 registry 为 npmmirror；装依赖按分钟到十分钟量级预留。

### 8.3 数据库（不随盘，换机必重建）
- 根 `docker-compose.yml` → 容器 `fanhe-work-db`，`postgres:16-alpine`，数据在宿主机命名卷 `fanhe-work-pgdata`（**不随 U 盘移动**），端口绑 `127.0.0.1`，排序规则建库时固定 ICU `zh-CN`。
- 换机重建步骤（经入口）：
  ```bash
  docker compose up -d --wait
  cp apps/api/.env.example apps/api/.env      # 填 JWT_SECRET
  ../../infra/portable/ws-run.cmd pnpm db:deploy
  ../../infra/portable/ws-run.cmd pnpm db:seed
  ../../infra/portable/ws-run.cmd pnpm db:ping   # 自检：列出表与行数
  ```
- **迁移目录名字典序 ≠ 实际创建顺序**：现有五个迁移中 `launch_profiles` 依赖 `init` 的 `users`，`launch_history` 依赖 `users` 与 `launch_profiles`，`add_notes` 只依赖 `init` 的 `users` 和自身外键；当前字典序恰好满足这几组依赖，**不能宣称全部迁移互相独立**。新增迁移若引用更晚创建的对象，要查的是迁移间是否真的独立。当前共**十个业务表**（`users` / `roles` / `permissions` / `role_permissions` / `refresh_tokens` / `login_attempts` / `audit_logs` / `launch_profiles` / `launch_history` / `notes`），另加 `_prisma_migrations`。
- **owner 账号**：本机已于 2026-10-11 创建首个 owner（登录名 `fanhe`，显示名「梵禾」，状态 active），强随机口令写在被忽略的 `.tmp/owner-credentials.txt`（`.gitignore` 第 3 行 `.tmp/` 覆盖）。换机后该文件不随盘走，需重新执行 `pnpm db:create-owner` 或走首次初始化引导。

### 8.4 Prisma 7 三处硬性差异（钉 7.10.0，两包同版本，不要 `@latest`）
1. 强制驱动适配器：`@prisma/adapter-pg` + `pg`。
2. 连接串与迁移配置移到 `prisma.config.ts`；生成器改名 `prisma-client`，`output` 必填。
3. `.env` 不再自动加载，需 `import 'dotenv/config'` 且置于首行。

### 8.5 GitHub 与代理（推送必看）
- **GitHub 直连不通，必须走本地代理 `http://127.0.0.1:7897`**（不是 17897，也不是会话里的 59642）。
- **代理不对的症状是「卡住」而不是「报错」**：`git push` 会无限等待、无任何输出，易被误读成凭据过期。判定：`git credential fill` 带 / 不带 `HTTPS_PROXY=http://127.0.0.1:7897` 各跑一次，带了立刻返回、不带就超时，即确认是代理。
- 推送时三个变量一起给，并加 `GIT_TERMINAL_PROMPT=0`：
  ```bash
  GIT_TERMINAL_PROMPT=0 HTTPS_PROXY=http://127.0.0.1:7897 \
  HTTP_PROXY=http://127.0.0.1:7897 ALL_PROXY=http://127.0.0.1:7897 \
  git -c http.proxy=http://127.0.0.1:7897 push origin main
  ```

### 8.6 编码与其他陷阱
- **编码**：bash 写 UTF-8 无 BOM；PowerShell 5.1 的 `Get-Content` 无 BOM 时按系统 ANSI 解码。跨环境传中文清单，读取侧必须显式 `-Encoding UTF8`。
- 原生命令 stderr 被包成 `ErrorRecord`；点源 `ws-env.ps1`（设 `$ErrorActionPreference='Stop'`）后更危险，调用会写 stderr 的工具（如 Prisma）前改回 `Continue`。
- Docker 客户端配置**不重定向**：`DOCKER_CONFIG` 指向空目录会让 `docker compose` 变未知命令。
- 跑 `prisma generate` / 门禁会打断正在跑的 `tsx watch`（删文件导致整进程退出）；先停 dev，或跑完门禁后重启 dev。
- `EADDRINUSE` 通常意味着「已有另一个自己在跑」；清残留要对着命令行按整条链杀，或直接杀 `tsx watch`。

---

## 九、关键文件路径清单

| 用途 | 路径（相对工作空间根） |
| -- | -- |
| 工作空间唯一入口 | `infra/portable/ws-run.cmd` |
| 工作空间机制说明 | `infra/docs/PORTABLE-WORKSPACE.md` |
| 项目根 | `projects/fanhe-work/` |
| 后端代码 | `projects/fanhe-work/apps/api/src/` |
| 启动相关 | `apps/api/src/launch/{agent,profiles,status,history}.ts`、`apps/api/src/routes/launch.ts` |
| 纪要相关 | `apps/api/src/note/notes.ts`、`apps/api/src/routes/notes.ts`、`packages/shared/src/note.ts` |
| 共享包 | `packages/shared/src/`（类型）、`packages/shared/test/` |
| 前端启动 UI | `apps/web/src/components/launch/`、`apps/web/src/lib/{api,launch,relative-time}.ts` |
| Prisma 配置 | `apps/api/prisma.config.ts`、`apps/api/prisma/schema.prisma` |
| 迁移目录 | `apps/api/prisma/migrations/`（5 个） |
| 数据库 compose | `projects/fanhe-work/docker-compose.yml` |
| 环境样例 | `apps/api/.env.example` |
| 测试 | `apps/api/test/{note,launch-history}.test.ts`、`packages/shared/test/{note,launch}.test.mjs`、`apps/web/test/relative-time.test.mjs`、`apps/web/test/e2e-auth.mjs` |
| 诊断脚本 | `projects/fanhe-work/tools/`（`README.md` 说明各脚本用途、归档来由，以及 `.ps1` 必须带 UTF-8 BOM 这条硬性约束） |
| 规划与交接 | `docs/DEVELOPMENT-PLAN.md`、`docs/HANDOFF-2026-10-10.md`、`docs/HANDOFF-2026-10-11.md`、`docs/IMPLEMENTATION-PLAN.md` |
| 环境踩坑（逐机） | `.workbuddy-ai/memory/ENVIRONMENT.md` |
| 测试 / 界面令牌 | `.workbuddy-ai/memory/TESTING.md`、`.workbuddy-ai/memory/UI-TOKENS.md` |

---

## 十、换机续接当日 Checklist

1. **介质就位**：整盘携带 U 盘到新机，或 `git clone` 整个工作空间根（仓库根即工作空间根，不是 `projects/fanhe-work`）。
2. **pnpm 就位**：`corepack enable pnpm`（用 `package.json` 声明的版本）。
3. **Git 信任**：`git config --global --add safe.directory "<工作空间根>"`（卷根 ACL 放宽会导致 `detected dubious ownership`）；确认提交身份为 `梵禾 <dev@fanhe.local>`。
4. **数据库重建**（不随盘）：按 8.3 跑 `docker compose up -d --wait` → 复制 `.env.example` 填 `JWT_SECRET` → `db:deploy` → `db:seed` → `db:ping`。
5. **依赖重建**：经入口 `ws-run.cmd pnpm install`（store 随盘符失效会要求重建，非交互需 `CI=true`）。
6. **构建**：经入口 `pnpm --filter @fanhe/shared build` → `pnpm db:generate`。
7. **首次初始化**：启动后走引导建超级管理员，或 `pnpm db:create-owner` 恢复 owner。
8. **门禁确认**：`ws-run.cmd pnpm test` / `lint` / `typecheck` / `build` / `format:check`；`test` 预期 **227 项**（shared 58 + api 159 + web 10），其中 api 有 **5 项因库里已存在 owner 而设计性跳过**（`setup.test.ts` 的首次初始化用例，属正常，不是失效）；浏览器级 `pnpm --filter @fanhe/web test:e2e` **必须先清库**（脚本要求 `users` 表为空），**截至 T3-06 尚未跑过** —— 脚本里的纪要段断言属于「已写未验证」。
9. **先跑 e2e，再做 T3-07 全文检索**：前者是 T3-06 的收尾，做法与代价见第七节第 1 条；后者的任务定义见 `DEVELOPMENT-PLAN.md` 第三章第 186 行，难点（中文分词）见第七节第 2 条。

---

## 十一、权威文档索引

- `docs/DEVELOPMENT-PLAN.md` — 总体方案、任务表、阶段验收、**第九章逐任务实施判断（9.28~9.32 为阶段三）**。
- `docs/HANDOFF-2026-10-10.md` — 整体进度、设计决策、迁移核验、换机步骤 7.x。
- `docs/HANDOFF-2026-10-11.md` — T3-04 当日补记（已验证、已提交状态）。
- `docs/PROGRESS-REVIEW-2026-10-11.md` — 任务进度盘点（完成 / 进行中 / 未开始、九条风险 R1~R9、下一步优先级）。
- `docs/SYNC-COMPARE-2026-10-11.md` — 工作空间与远端仓库逐项对比（文件结构 / 内容 / 版本状态 / 变更记录四维度）。
- `docs/WORKSPACE-BINDING.md` — 工作空间与远端仓库绑定登记、两条访问链路（本地 git 可读写 / 连接器只读）。
- `docs/IMPLEMENTATION-PLAN.md` — 实施层面的方案对照。
- `infra/docs/PORTABLE-WORKSPACE.md` — 工作空间机制、入口、重定向、换机修复。
- `.workbuddy-ai/memory/ENVIRONMENT.md` — 逐机环境事实与踩坑（代理、编码、TEMP、Docker）。
- `.workbuddy-ai/memory/TESTING.md` / `UI-TOKENS.md` — 测试约定、界面令牌规格。
- `README.md` — 项目说明、迁移表、数据库与 Prisma 7 说明。
