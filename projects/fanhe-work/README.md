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

### 第三步：启动

```powershell
pnpm dev:all      # 前端与后端并行启动
```

前端编译约需 4 秒，看到以下两行即为就绪。

```
VITE v8.3.4  ready in 4104 ms
Server listening at http://127.0.0.1:8787
```

### 第四步：访问

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
| `pnpm lint` | 全仓静态检查 |
| `pnpm lint:fix` | 静态检查并自动修复 |
| `pnpm format` | 按 Prettier 规则格式化 |
| `pnpm format:check` | 只检查格式，不写入 |

提交前建议依次跑 `pnpm lint`、`pnpm typecheck`、`pnpm format:check`。

## 目录结构

```
projects/fanhe-work/
├── apps/
│   ├── web/          React 前端，Vite 开发服务器在 5173
│   ├── api/          Fastify 后端，仅监听回环 8787
│   └── desktop/      Electron 外壳，阶段四启用
├── packages/
│   └── shared/       跨端共享的类型与常量
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

实验版即引入 PostgreSQL，用容器提供，与网络版保持同构。

需要注意一点：**数据库数据留在宿主机或容器卷上，不随 U 盘移动。** 这与工作空间「整体可移动」的前提是有张力的，属于已知取舍。换机后数据库需要单独准备，或从备份恢复。

连接串放在本地环境变量文件中，该文件已被忽略，不要提交。

## 两个已知的版本取舍

**TypeScript 固定在 6.x，不是 7.x。** `typescript-eslint` 8.71.1 的 peer 声明为 `>=4.8.4 <6.1.0`，且遇到 TS 7 是导入即抛错，不是警告。官方给的出路是并行安装第二个 TS 6 编译器供工具链使用。工作区在 32GB U 盘上，并存两套类型系统不划算，因此取 6.0.3。上游支持 TS >= 7.1 后可以再升。

**esbuild 的安装脚本被有意阻止。** pnpm 10 默认阻止依赖的生命周期脚本，`pnpm-workspace.yaml` 里的 `onlyBuiltDependencies` 保持为空是刻意的。esbuild 的二进制由可选依赖包 `@esbuild/win32-x64` 直接提供，postinstall 只是重复校验，在本环境执行必然报 `EBUSY`。代价是每次安装会提示 ignored build scripts，可以忽略。

## 常见问题

**页面打开是空白或提示未连接。** 后端没起来。检查终端里是否有 `Server listening at http://127.0.0.1:8787`，只跑 `pnpm dev` 不会启动后端。

**`127.0.0.1:5173` 连不上。** 开发服务器已显式绑定 IPv4 回环，正常情况下两种地址都通。若仍不通，多半是端口被上一次未正常退出的进程占用，换一个终端重新启动并留意 Vite 输出的实际端口。

**依赖装到了系统盘。** 说明没有从入口进入。检查 `WS_ROOT` 环境变量是否存在，并确认 pnpm 存储落在 `.cache/pnpm-store`。
