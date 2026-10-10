# 梵禾 Work

桌面端工作台。分两个阶段交付：实验版在本机调试，网络版改为容器编排加 Tunnel 访问。

规划文档与执行文档分开放置。

| 文档 | 回答的问题 |
| --- | --- |
| [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md) | 做什么、为什么这样选 |
| [docs/DEVELOPMENT-PLAN.md](docs/DEVELOPMENT-PLAN.md) | 按什么顺序做、产出什么、怎样算完成 |

## 技术栈

| 层 | 选型 |
| --- | --- |
| 前端 | React 19 + TypeScript + Vite 8 |
| 样式 | Tailwind CSS 4，界面方向为方案 B 现代极简 |
| 后端 | Node + Fastify 5 |
| 数据 | PostgreSQL + Prisma |
| 外壳 | Electron |
| 包管理 | pnpm workspace |

## 环境要求

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| Node | >= 22 | `engines` 中已声明 |
| pnpm | 10.33.0 | `packageManager` 中已声明 |
| git | 任意近期版本 | 仓库根在工作空间根目录 |
| PostgreSQL | 16 及以上 | 实验版即引入，建议用容器提供 |

## 起步

### 第一步：从工作空间入口进入

**这一步不能跳过。** 工作空间把依赖缓存、临时目录与各工具主目录都重定向到自身内部，重定向由入口脚本注入进程环境。直接打开终端或 IDE 不会继承这些变量，依赖会落到宿主机磁盘上，换一台电脑后状态就散了。

在 PowerShell 中：

```powershell
cd <工作空间根>
. .\infra\portable\ws-env.ps1
cd projects\fanhe-work
```

`ws-env.ps1` 是点源执行（开头的 `.` 不能省），环境变量会注入当前会话。

也可以用命令行一次性执行，但要注意入口脚本会把当前目录切回工作空间根，所以传入的命令必须自带 `cd`。

```cmd
cd /d <工作空间根>
infra\portable\ws-run.cmd cmd /c "cd /d projects\fanhe-work && pnpm install"
```

**不要写 `pnpm -C <目录>`。** `ws-run.ps1` 带 `[CmdletBinding()]`，PowerShell 会把以连字符开头的参数当成它自己的参数解析，`-C` 会被吞成 `-Command` 的缩写并报「找不到接受实际参数」。

### 第二步：安装依赖

```powershell
pnpm install
```

### 第三步：准备数据库

后端在缺少 `DATABASE_URL` 时会直接抛错退出，所以这一步不能跳过。数据库的说明见后面的「数据库」一节。

```powershell
cd apps\api
Copy-Item .env.example .env
cd ..\..
docker compose up -d --wait    # 启动 PostgreSQL 并等到健康
pnpm db:deploy                 # 应用仓库里的迁移
pnpm db:ping                   # 确认连得上、表都在
```

`db:ping` 会打印库中的表与各表行数。`roles` 为 0 是正常的，种子数据在 T1-02 才写入。

### 第四步：启动

```powershell
pnpm dev:all      # 前端与后端并行启动
```

前端编译约需 4 秒，看到以下两行即为就绪。

```
VITE v8.3.4  ready in 4104 ms
Server listening at http://127.0.0.1:8787
```

### 第五步：访问

浏览器打开 <http://127.0.0.1:5173>。

前端开发服务器把 `/api` 代理到 `127.0.0.1:8787`，浏览器侧只有一个来源，开发期不需要配置 CORS。

按 `Ctrl+C` 停止，必要时按两次。

## 常用脚本

在 `projects/fanhe-work` 目录下执行。

| 命令 | 作用 |
| --- | --- |
| `pnpm dev:all` | 前后端并行启动 |
| `pnpm dev` | 只启动前端 |
| `pnpm dev:api` | 只启动后端 |
| `pnpm build` | 全仓构建 |
| `pnpm typecheck` | 全仓类型检查 |
| `pnpm test` | 全仓测试 |
| `pnpm lint` | 全仓静态检查 |
| `pnpm lint:fix` | 静态检查并自动修复 |
| `pnpm format` | 按 Prettier 规则格式化 |
| `pnpm format:check` | 只检查格式，不写入 |

提交前建议依次跑 `pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm format:check`。

数据库相关的命令会连接 PostgreSQL，需要先按下一节的说明准备好 `apps/api/.env`。

| 命令 | 作用 |
| --- | --- |
| `pnpm db:ping` | 连接自检，列出库中的表与各表行数 |
| `pnpm db:validate` | 只校验 schema 语法，不连库 |
| `pnpm db:generate` | 由 schema 生成 Prisma 客户端到 `apps/api/src/generated/prisma` |
| `pnpm db:migrate` | 开发期创建并应用迁移 |
| `pnpm db:deploy` | 只应用已有迁移，不创建新迁移，用于部署 |
| `pnpm db:seed` | 写入权限点与内置角色，可重复执行 |
| `pnpm db:studio` | 打开数据浏览器 |

`db:generate` 的产物已被忽略，不进版本控制。`build` 与 `typecheck` 都会先跑一次 `prisma generate`，所以新克隆的仓库不需要额外准备步骤。

## 目录结构

```
projects/fanhe-work/
├── apps/
│   ├── web/          React 前端，Vite 开发服务器在 5173
│   ├── api/          Fastify 后端，仅监听回环 8787
│   │   └── prisma/   数据模型与迁移；客户端生成到 src/generated/prisma
│   └── desktop/      Electron 外壳，阶段四启用
├── packages/
│   └── shared/       跨端共享的类型与常量，构建产物在 dist，测试在 test
├── data/             本地数据与数据库卷，不纳入版本控制
└── docs/             规划文档、执行文档与 UI 预览稿
```

## 强制约定

以下五条来自工作空间机制，违反后问题往往延迟暴露。

1. **入口唯一。** 开发操作一律经 `infra/portable/` 下的入口进入，否则环境重定向不生效。
2. **禁止盘符。** 受版本控制的文件里不允许出现 `C:\` 这类盘符。需要工作空间根目录时用环境变量 `WS_ROOT`。这条同样适用于文档中的路径示例。
3. **路径含空格。** 工作空间路径 `fanhe Work` 含空格，脚本中所有变量必须加引号。历史上曾因未加引号产生游离目录。
4. **文本文件显式指定编码。** bash 写出的文件是 UTF-8 无 BOM，而 Windows PowerShell 5.1 的 `Get-Content` 在无 BOM 时按系统 ANSI 代码页解码，含中文的清单会整体解错。读取侧必须显式写 `-Encoding UTF8`。
5. **`data/` 不进版本控制。** 本地数据与数据库卷都在其中，已由 `.gitignore` 覆盖。

## 数据库

实验版即引入 PostgreSQL 16 及以上，用容器提供，与网络版保持同构。

需要注意一点：**数据库数据留在宿主机或容器卷上，不随 U 盘移动。** 这与工作空间「整体可移动」的前提是有张力的，属于已知取舍。换机后数据库需要单独准备，或从备份恢复。

### 启动数据库

数据库由项目根目录的 `docker-compose.yml` 定义，容器名 `fanhe-work-db`，镜像 `postgres:16-alpine`。

```powershell
docker compose up -d --wait    # 启动并等到健康检查通过
docker compose down            # 停止，保留数据
docker compose down -v         # 停止并删除数据卷，会清空数据库
```

`--wait` 会等到 `pg_isready` 通过再返回，而不是等到容器进程起来。迁移依赖这一点，否则会在 initdb 还没结束时就去连库。

数据存在宿主机命名卷 `fanhe-work-pgdata`，不在工作空间目录里。**PostgreSQL 的随机 IO 很重，而工作空间在闪存 U 盘上，既慢又有写入寿命限制**，所以数据不落在介质上。代价就是换机后要重新 `up` 一次。

端口绑定在 `127.0.0.1` 而非 `0.0.0.0`，与 api 仅监听回环的做法一致。

**排序规则在建库时就固定为 ICU 的 `zh-CN`**，不是默认的 `C`。`C` 排序按 UTF-8 字节序比较，对中文相当于按码位排，列表里的中文姓名不会按拼音顺序出现。实测差别：ICU `zh-CN` 给出 `陈 < 李 < 王 < 张`，`C` 给出 `张 < 李 < 王 < 陈`。这一项事后更改需要重建数据库，所以放在建库时就定好。

### 连接串放在哪里

`apps/api/.env`，已被忽略，不要提交。首次使用从模板复制：

```powershell
cd apps\api
Copy-Item .env.example .env
```

换一台机器就改这一处，指向那一台的 PostgreSQL 实例。

### Prisma 7 与 6.x 的三处差异

升级到 7 之后这三处都会让人踩坑，写在这里省去翻文档。

1. **SQL 提供方必须配驱动适配器。** 7 起不再自带 Rust 查询引擎，PostgreSQL 要装 `@prisma/adapter-pg` 与 `pg`，实例化时传入：

   ```typescript
   const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
   const prisma = new PrismaClient({ adapter })
   ```

2. **配置从 schema 移到 `prisma.config.ts`。** `datasource` 块里只剩 `provider`，连接串、影子库地址、迁移目录与 seed 命令都在配置文件里。生成器也换了名字，`prisma-client-js` 变成 `prisma-client`，并且 `output` 成为必填项。

3. **`.env` 不再自动加载。** 配置文件里必须自己 `import 'dotenv/config'`，而且它得是第一条 import，晚于 `prisma/config` 就读不到变量。另外 `prisma migrate diff` 的 `--to-schema-datamodel` 已改名为 `--to-schema`。

### 迁移流程

首次拿到数据库时：

```powershell
docker compose up -d --wait   # 启动数据库并等到健康
pnpm db:deploy                # 应用仓库里已有的迁移
pnpm db:seed                  # 写入权限点与内置角色
pnpm db:ping                  # 确认连得上、表都在
```

改了 `apps/api/prisma/schema.prisma` 之后：

```powershell
pnpm db:migrate    # 生成新迁移并应用，随后自动跑一次种子
```

`db:migrate` 走的是 `prisma migrate dev`，而 `prisma.config.ts` 里的 `migrations.seed` 指向种子脚本，所以迁移完成后会自动执行它。

仓库里的首个迁移 `20261010150103_init` 建立六张账号权限表，已应用到 PostgreSQL 16.15，并用 `prisma migrate diff --from-config-datasource --to-schema` 确认无漂移（差异为空）。同一份 DDL 也曾在 PGlite 上执行过，那是数据库还不可达时的验证手段。

判断库结构与 schema 是否一致，可以用这条命令，输出为空即一致：

```powershell
pnpm --filter @fanhe/api exec prisma migrate diff `
  --from-config-datasource --to-schema prisma/schema.prisma --script
```

### 种子数据

`pnpm db:seed` 只写三类数据：11 个权限点、4 个内置角色、以及角色与权限的关联（展开后共 29 条）。

**不创建任何账号。** 超级管理员由首次初始化引导创建（T1-08），在界面里由人设定用户名与密码。种子里塞一个带默认口令的管理员是最常见的一类事故来源：它会在每台部署过的机器上都存在，而且没人记得改。

权限点与角色都以 `code` 为键 upsert，所以改了名称或说明后重跑即生效。角色权限关联做差集同步——新增缺失的、删除多余的。四个内置角色的授权完全由代码定义，所以「多余」就是确实该移除的。同步时只处理代码里定义过的角色，将来支持自建角色后，那些角色的授权不会被种子脚本抹掉。

种子数据的事实来源是 `packages/shared/src/permissions.ts`，脚本不重复写一份常量。因此运行前 `@fanhe/shared` 必须先构建；根目录的 `pnpm db:seed` 与 `pnpm db:migrate` 会先构建一次，直接调用 api 内的脚本则不会。

当前各角色的授权数：

| 角色 | code | rank | 权限点数 |
| --- | --- | --- | --- |
| 超级管理员 | `owner` | 100 | 11 |
| 管理员 | `admin` | 80 | 9 |
| 成员 | `member` | 50 | 6 |
| 只读访客 | `viewer` | 10 | 3 |

授权模式支持五种写法，通配符的吃法取决于位置：末尾的 `*` 吞掉剩余全部段（`personal.*` 覆盖 `personal.note.read`），非末尾的 `*` 只匹配一段（`personal.*.read` 表示「personal 下任意对象的 read」）。两者必须区分开，否则只读角色会静默拿到写权限。展开只在种子阶段做一次，运行时只做精确匹配。

`packages/shared/test/permissions.test.mjs` 覆盖了这些规则，用 Node 内置测试运行器，不引第三方框架。它直接跑 `dist` 产物，因为写进库的就是那份展开结果。

## 三个已知的版本取舍

**TypeScript 固定在 6.x，不是 7.x。** `typescript-eslint` 8.71.1 的 peer 声明为 `>=4.8.4 <6.1.0`，且遇到 TS 7 是导入即抛错，不是警告。官方给的出路是并行安装第二个 TS 6 编译器供工具链使用。工作区在 32GB U 盘上，并存两套类型系统不划算，因此取 6.0.3。上游支持 TS >= 7.1 后可以再升。

**Prisma 取 7.10.0，不是 npm 上标记为 latest 的 8.0.0-rc.22。** `prisma` 包的 `latest` 标签目前指向一个预发布版本，而 `@prisma/client` 的 `latest` 是 7.10.0。两个包必须同版本，因此都钉在 7.10.0。安装时不要用 `@latest`，会把 CLI 拉到 RC 上，与客户端版本错开。

**esbuild 的安装脚本被有意阻止。** pnpm 10 默认阻止依赖的生命周期脚本，`pnpm-workspace.yaml` 里的 `onlyBuiltDependencies` 保持为空是刻意的。esbuild 的二进制由可选依赖包 `@esbuild/win32-x64` 直接提供，postinstall 只是重复校验，在本环境执行必然报 `EBUSY`。代价是每次安装会提示 ignored build scripts，可以忽略。

## 常见问题

**页面打开是空白或提示未连接。** 后端没起来。检查终端里是否有 `Server listening at http://127.0.0.1:8787`，只跑 `pnpm dev` 不会启动后端。

**`127.0.0.1:5173` 连不上。** 开发服务器已显式绑定 IPv4 回环，正常情况下两种地址都通。若仍不通，多半是端口被上一次未正常退出的进程占用，换一个终端重新启动并留意 Vite 输出的实际端口。

**依赖装到了系统盘。** 说明没有从入口进入。检查 `WS_ROOT` 环境变量是否存在，并确认 pnpm 存储落在 `.cache/pnpm-store`。

**`prisma` 命令在 PowerShell 里没有任何输出就中断。** `ws-env.ps1` 设了 `$ErrorActionPreference = 'Stop'`，而 PowerShell 5.1 会把原生命令写到 stderr 的内容包成 `ErrorRecord`，在 Stop 下直接终止脚本。Prisma 每次都会往 stderr 写「已加载配置文件」这类提示，于是脚本在拿到结果前就退出了。两种解法：点源之后把 `$ErrorActionPreference` 改回 `Continue`，或者用 .NET 进程 API 读取双流。经 `pnpm` 转发时更容易踩到，因为多一层进程。

**`docker compose up` 报 `Access is denied` 且日志里出现 `wsl.exe`。** Docker Desktop 的 Linux 引擎通过 `wsl.exe` 启动，该程序若被安全策略列入程序黑名单，引擎起不来。处理方式是在安全中心的「命令安全 → 程序黑名单」里把它移出。这一项在阶段五容器编排时同样会挡路。

**改动 `packages/shared` 后另一个应用没生效。** shared 是构建型包，产物在 `dist`，两个应用消费的是编译结果。根脚本 `dev`、`dev:api`、`dev:all` 都会先构建一次，直接跑 `pnpm --filter @fanhe/api dev` 则会跳过这一步。开发期可以另开一个终端跑 `pnpm dev:shared` 进入监听模式。

**安装依赖慢。** 工作空间的 `infra/portable/config/.npmrc` 已把源固定为 npmmirror，Prisma 引擎与 Electron 二进制的镜像变量也指向同一家。但实测这个环境的瓶颈在网络链路而非源站，单次元数据请求仍要十几到几十秒，换源改善有限。真正的原因是介质为闪存 U 盘，随机写弱。装一次 Prisma 相关的依赖大约需要 20 分钟，属预期范围，用后台任务跑即可。
