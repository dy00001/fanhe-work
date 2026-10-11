# tools —— 诊断与校验脚本

这里放的是开发过程中写下的检查脚本。它们原先散在工作区根目录的 `.tmp\` 下，而
`.tmp\` 是被重定向、随时可清理的临时目录，不适合长期存放。归档时做了两件事：

1. **去掉硬编码盘符。** 原版一律写死 `F:\fanhe Work\...`（更早的一版是 `E:`），
   工作区一旦换盘符或换机器，全部脚本当场失效。现在统一改为向上查找 `.ws-root`
   推导工作区根，符合「受版本控制的文件禁止硬编码盘符」这条工作区约定。
2. **补上 `.tmp\` 目录的建立。** 原版假定输出目录已存在，清理过 `.tmp\` 之后直接跑
   会报「找不到路径」，容易误判成脚本坏了。

## 目录

| 路径 | 用途 | 还能直接用吗 |
| --- | --- | --- |
| `checks\gates.ps1` | 跑全套门禁（prettier write / 共享包构建 / prisma generate / 三个 typecheck / eslint / prettier check），汇总成 `.tmp\gates.txt` | ✅ 能 |
| `checks\drift-check.ps1` | 用 `prisma migrate diff --from-config-datasource` 对比真实库与 `schema.prisma`，判定有无漂移（退出码 0 无漂移 / 2 有漂移） | ✅ 能 |
| `checks\docker-check.ps1` | 检查 `DOCKER_CONFIG` 是否被清、docker 可执行文件位置、`docker compose` 能否跑通 | ✅ 能 |
| `checks\list-node.ps1` | 列出全部 `node.exe` 的 PID / 父 PID / 完整命令行，排查 EADDRINUSE 与残留 dev 服务 | ✅ 能 |
| `checks\tmpdir-probe.mjs` | 打印 `os.tmpdir()` / `TEMP` / `TMP`，确认入口是否把临时目录重定向到了介质上 | ✅ 能 |
| `prisma\prisma-diag.ps1` | `prisma --version` 与 `prisma validate` 的探针 | ✅ 能 |
| `prisma\prisma-gen.ps1` | `prisma generate`，并把 `migrate diff --from-empty` 的完整 DDL 导出到 `.tmp\init.sql` | ✅ 能 |
| `prisma\migrate.ps1` | 应用迁移，并保留应用前后的 `migrate status` 对照 | ✅ 能（主路径已改为 `pnpm db:deploy`） |
| `prisma\verify-migration.mjs` | 在内存 PostgreSQL（PGlite）里执行**第一个迁移**并校验表 / 枚举 / 索引 / 外键 / 约束行为 | ⚠️ 见下 |
| `oneoff\sync-handoff.py` | 一次性改写 `HANDOFF-2026-10-10.md` 的十余处文字 | ❌ 已执行完毕，重复执行会报「匹配 0 处」并退出 |

`verify-migration.mjs` 与 `sync-handoff.py` 都是**快照**，不是通用工具：

- `verify-migration.mjs` 绑定迁移 `20261010150103_init`，断言写死了「六张表 / 两个枚举 /
  22 个索引 / 五个外键」——那是 T1-01 时的库形态。要校验后面的迁移，得改 `MIGRATION`
  并重写断言，而**期望值本身才是要人工想清楚的部分**，脚本只负责把 DDL 真跑一遍。
  它的价值在于回答一个问题：「一个从没被实际执行过的迁移，只是一份文本，不是证据。」
  它**不能**证明真实 PostgreSQL 版本下的行为、`_prisma_migrations` 的记账，以及任何
  并发相关的事。
- `sync-handoff.py` 按「旧串必须恰好匹配 1 处」逐条替换，被执行过之后旧串就不存在了。
  重复执行**不会写坏文件**（匹配数不对就 exit 1），但已无第二次用途。留它是为了记录
  当初到底改了哪几处。

## 为什么不放在 `infra\`

`infra\` 是**工作区机制**层（入口、重定向、换机修复），与具体项目无关。这些脚本的
内容全是 fanhe-work 的项目细节（`apps\api`、`schema.prisma`、pnpm 门禁），放进去会
把两层混在一起。归档位置的这条判断记在 `docs\SYNC-COMPARE-2026-10-11.md` 里。

## 编码：这些 `.ps1` 必须带 UTF-8 BOM

**这条是硬性要求，改文件时别把 BOM 弄丢。** 归档时实测过一轮。

`infra\portable\` 下的 PowerShell 脚本**一行中文都没有**，所以它们无 BOM 也没事。但
PowerShell 5.1 解析无 BOM 的文件时按系统 ANSI（这里是 GBK）解码：一个 UTF-8 的中文字符
被拆成两个 GBK 字符，而 GBK 的**尾字节可以吃掉落在其范围内的 ASCII 字符** ——
包括单引号。于是：

```text
$s = '判定: 无漂移'      # 存成无 BOM 的 UTF-8
                          # 读回来变成  $s = '鏃犳紓绉   ← 结尾引号被吞
ParserError: 字符串缺少终止符: '。
```

**整个脚本一行都不会执行。** 这条错误在 `.tmp\drift-check.ps1` 与 `.tmp\docker-check.ps1`
上真实存在过 —— 它们当时加过中文，之后就一直跑不起来，而报错信息（「字符串缺少终止符」）
完全指向不了「编码」这个真因。

所以：

- 本目录的 7 个 `.ps1` **全部带 UTF-8 BOM**，已验证 `Parser::ParseFile` 全绿。
- 新增或改写 `.ps1` 时**要么保留 BOM，要么全文只用 ASCII**。两种做法都行，唯独
  「无 BOM + 中文」不行。
- 检查 BOM：`head -c 3 file.ps1 | od -An -tx1` 应输出 `ef bb bf`。
- `.gitattributes` 里 `*.ps1 text eol=crlf`，所以工作区的换行由 git 管，不用手工操心。

`.mjs` 与 `.py` 没有这个问题：Node 与 Python 都默认按 UTF-8 读源码。

## 为什么要用 .NET 进程 API 而不是 `& tool args`

在 PowerShell 5.1 上，`ws-env.ps1` 会把 `$ErrorActionPreference` 设为 `Stop`，而
5.1 把原生命令写到 stderr 的每一行都包成 `ErrorRecord` —— 于是**正常输出也会终止
脚本**。Prisma 与 docker 都会往 stderr 写进度提示，所以这些脚本一律走
`System.Diagnostics.ProcessStartInfo`，把两个流都读到底再判断退出码。

两个附带约束：

- `ProcessStartInfo.ArgumentList` 只在 .NET Core 上存在，这里跑的是 .NET Framework，
  所以参数要手工拼引号 —— 工作区路径含空格，不拼引号会当场断成两个参数。
- `.cmd` 垫片在 `UseShellExecute = $false` 下起不来，所以工具都按
  `node <entry.js>` 调用。`gates.ps1` 里的 `Get-BinPath` 就是为这个写的：从包的
  `package.json` 的 `bin` 字段取真实入口。

## 用法

```powershell
# 从任意目录都可以，脚本自己找得到工作区根
powershell -ExecutionPolicy Bypass -File "projects\fanhe-work\tools\checks\gates.ps1"

# Node 脚本
node "projects\fanhe-work\tools\prisma\verify-migration.mjs"
```

输出统一写在 `<工作区根>\.tmp\` 下，文件名与脚本同名。

>`verify-migration.mjs` 依赖 PGlite（PostgreSQL 的 WASM 版本）。它是 Prisma CLI 的
>传递依赖，**不需要单独安装**，但也不在项目的直接依赖里 —— 如果哪次 `pnpm install`
>之后它消失了，说明 Prisma 换了实现，那时要重新找一条出路。
