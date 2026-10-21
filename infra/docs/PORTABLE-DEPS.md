# 换机不重装依赖：机制、方案与取舍

> 2026-10-21。针对「工作区放在 U 盘、多台电脑切换、盘符不固定」。
> 实测环境：工作区在 `E:`（NTFS，29.3GB），`projects/fanhe-work` 为 pnpm workspace。
> 配套工具：`infra/portable/ws-links.ps1`（本次新增）。

## 一、结论

1. pnpm 在 Windows 上的依赖树由**绝对路径的 junction** 构成，盘符一变就全部失效。实测这个工作区里有 **29445 个**重解析点。
2. pnpm 没有「用相对路径建 junction」的开关，因为 Windows junction 本身不支持相对目标。这一层**在配置上无解**。
3. 可行的主路有两条：让路径恒定（首选，零改动），或换机后重写链接（已实现，扫描加修复在几十秒级）。

## 二、机制：三处绝对路径

| 位置 | 存了什么 | 换盘后的后果 |
| --- | --- | --- |
| `node_modules/.pnpm/**/node_modules/<pkg>` | Junction 的 Target，形如 `E:\fanhe Work\projects\fanhe-work\node_modules\.pnpm\<pkg>@<ver>\node_modules\<pkg>` | 每条链接指向不存在的路径，`require.resolve` 失败 |
| `node_modules/.pnpm-workspace-state-v1.json` | `projects` 的键，五个包的绝对路径 | pnpm 判定 workspace 结构变了，下次 install 全量重建 |
| `node_modules/.modules.yaml` | `storeDir` 与 `virtualStoreDir` 的绝对路径 | pnpm 报 store 不匹配，要求重建 node_modules |

平台差异是根因。POSIX 上 pnpm 建的是**相对**符号链接（`../.pnpm/...`），换挂载点通常不用重装。Windows 上创建符号链接需要开发者模式或管理员权限，pnpm 退化成 Junction，而 Junction 只有绝对目标。

实测规模：`ws-links.ps1` 扫描出 29445 个链接，覆盖根 `node_modules`、`projects/fanhe-work/node_modules` 以及 `.pnpm` 内部各层。这个量级说明两件事：手工修不现实；在 U 盘上重装要写几万个目录项，慢且伤盘。

## 三、五条方案

### 3.1 方案 A：让路径恒定（首选）

思路是不动 pnpm，让工作区的可见路径永远相同。绝对路径只要不变，junction 就不会断。

**A1 固定盘符。** 每台机器插盘后把卷分配到同一个字母。

```
diskpart
  list volume
  select volume <n>
  assign letter=Z
```

或用 PowerShell：

```powershell
Get-Partition | Where-Object { $_.DriveLetter -eq 'E' } | Set-Partition -NewDriveLetter Z
```

要点：选一个不常用的字母（`Z:` 冲突概率低）。分配一次即可，Windows 会记住卷序列号与盘符的绑定，下次插同一支盘通常自动恢复。

**A2 目录挂载点。** 更彻底，盘符完全不参与。

```powershell
# 查卷的 GUID 路径
mountvol
# 把卷挂到固定目录（需要管理员）
mkdir C:\ws
mountvol C:\ws \\?\Volume{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}\
```

这样工作区路径永远是 `C:\ws\...`，即使 U 盘在别的机器上被分配成 `G:`。关键差别在于：挂载点是重解析点的一种，`GetFinalPathName` 返回的是 `C:\ws\...`，因此 pnpm 记录的绝对路径恒定。

代价是卷 GUID 跟着这支盘走，换一支 U 盘要重新挂一次。

**A1 与 A2 的取舍：** A1 简单，但要求每台机器都不占用那个字母；A2 不受盘符影响，但需要管理员权限与一次卷 GUID 查询。

### 3.2 方案 B：换机后重写链接（兜底，已实现）

`infra/portable/ws-links.ps1` 做三件事：

1. 扫描工作区内各 `node_modules` 的链接，统计断链数，并区分「指向旧根本」与「其他原因」
2. `-Repair` 时把 Target 里的旧根替换成当前根，重建 junction
3. 同步重写 `.pnpm-workspace-state-v1.json` 与 `.modules.yaml` 里的绝对路径

```
# 只检查，不改动
infra\portable\ws-links.ps1

# 修复，旧根从状态文件推断
infra\portable\ws-links.ps1 -Repair

# 布局不是 projects/<名字> 时，显式给旧根
infra\portable\ws-links.ps1 -Repair -PreviousRoot 'F:\fanhe Work'
```

退出码：0 表示无问题或已修完，1 表示仍有问题。

能力边界要说清：

- 只能修「Target 指向旧根、且新根下同名实体存在」的链接。包实体缺失时它报 `package entity missing` 并跳过，那种情况仍要 install。
- 它绕过了 pnpm 的一致性校验。日常 `dev` / `build` / `test` 都能用，但下一次 `pnpm install` 仍会按自己的判断重建。这是设计取舍，不是缺陷。
- 修复用 `[System.IO.Directory]::Delete(path, false)` 只移除重解析点。**不要改成 `Remove-Item -Recurse`**，后者会跟随 junction 并删掉目标内容。

### 3.3 方案 C：依赖外置，每台机器一份

U 盘只放源码、lockfile 与配置，`node_modules` 落在本机磁盘。换机后不要重装，只是每台机器各自保留一份。

实现有两条路：

1. 把 `projects/fanhe-work/node_modules` 做成 junction 指向本机固定目录（如 `C:\ws-deps\fanhe-work`）。缺点是这个 workspace 有 5 处 `node_modules`（根加四个包），要逐个处理。
2. 整个 `projects/fanhe-work` 不进 U 盘，U 盘只保留 git 对象，每台机器 clone 到本机。改动靠 git 同步。

第 2 条更干净，也顺手解决了 U 盘写入量过大的问题。代价是未提交的改动不随盘走。

### 3.4 方案 D：换 node 链接器（配置能做的事到此为止）

| 配置项 | 作用 | 能否解决盘符问题 |
| --- | --- | --- |
| `node-linker=hoisted` | 扁平化，第三方依赖变真实目录 | 部分。workspace 包之间仍是链接 |
| `node-linker=pnp` | 无 node_modules，用 `.pnp.cjs` 映射 | 理论可行，Vite 与 Electron 生态风险高 |
| `inject-workspace-packages=true` | workspace 包复制而非链接 | 配合 hoisted 可接近零链接，但改源码要重装 |
| `package-import-method=copy` | store 到 node_modules 用复制而非硬链接 | 否。不影响 junction |
| `virtual-store-dir` | 改 `.pnpm` 位置 | 否。仍是绝对路径 |
| `store-dir` | 改 store 位置 | 否。`.modules.yaml` 仍记绝对路径 |

结论：把这些配置叠起来最多把链接数从两万多降到几千，代价是失去 pnpm 的依赖隔离优势，且改一处 workspace 源码要重装。不推荐作为主方案。

### 3.5 方案 E：换平台或容器（不适合日常）

WSL2 下 pnpm 用相对符号链接，盘符问题自动消失。但 NTFS U 盘经 drvfs 挂载需要开 `metadata` 选项才能建链接，而 USB 介质叠加 drvfs 转换后，Vite 的热更新会明显变慢。

容器同理，容器内路径永远 `/repo`，但 Windows 上的 Docker 访问 USB 存储性能更差。

这两个方案适合做 CI 复现环境，不适合作为 U 盘上的日常开发位。

## 四、配置项清单

| 配置 | 位置 | 取值建议 | 理由 |
| --- | --- | --- | --- |
| `.ws-root` 标记 | 工作区根 | 保留 | 已有机制，按标记定位根，与盘符无关 |
| `store-dir` | `ws-env.ps1` 推导 `.cache/pnpm-store` | 保持在工作区内 | 随盘迁移，包实体不丢，重装时不必下载 |
| `node-linker` | 不设 | 保持默认 isolated | 换 hoisted 只减少链接，不能归零 |
| `package-import-method` | 不设 | 保持默认 | 同卷硬链接已生效，实测 nlink 大于 1 |
| `onlyBuiltDependencies` | `pnpm-workspace.yaml` | 保持现状 | 与盘符无关，但重装时会跑这些脚本 |

## 五、迁移后的最小验证

顺序按「越早失败越省时间」排列。

**第一步，定位正确。** 经入口跑一条命令，确认根解析到当前盘。

```
..\..\infra\portable\ws-run.cmd pnpm store path
```

判据：输出落在 `<当前根>\.cache\pnpm-store\v10`。若指向 `%LOCALAPPDATA%`，说明入口没生效。

**第二步，链接完整。** 这一步是本次新增的，之前没有对应检查。

```
powershell -NoProfile -ExecutionPolicy Bypass -File infra\portable\ws-links.ps1
```

判据：退出码 0，输出 `link check passed`。若有断链，先看它是「指向旧根」还是「实体缺失」，前者用 `-Repair`，后者要 install。

**第三步，真实解析。** 链接存在不等于能解析，要从包的视角验证。

```
cd projects\fanhe-work
node -e "console.log(require.resolve('typescript/bin/tsc'))"
```

判据：打印出一个存在于当前盘的真实路径。只看 junction 是否存在会被悬空链接骗过。

**第四步，store 一致。**

```
..\..\infra\portable\ws-run.cmd pnpm store path
```

与 `node_modules/.modules.yaml` 里的 `storeDir` 逐字比对。不一致会报 `ERR_PNPM_UNEXPECTED_STORE`。

**第五步，最小编译。** 只跑 shared 的 tsc，不碰数据库。

```
..\..\infra\portable\ws-run.cmd pnpm --filter @fanhe/shared build
```

判据：退出码 0，`packages/shared/dist` 时间戳更新。这一步失败通常是符号链接解析问题，不是代码问题。

**第六步，反例确认探针有效。** 这一步不能省，否则「全绿」无法区分「真没问题」与「检查没生效」。

做法：把任意一条 junction 的 Target 改成旧盘符的同名路径，重跑第二步，确认它报出 `broken = 1` 且退出码为 1，再用 `-Repair` 修回。本次已在隔离目录完成这个闭环，记录见第九节。

## 六、方案对比

| 维度 | A1 固定盘符 | A2 目录挂载点 | B 链接重写 | C 依赖外置 | D 换链接器 | E 换平台 |
| --- | --- | --- | --- | --- | --- | --- |
| 换机后是否需要操作 | 一次分配盘符 | 一次挂载 | 一条命令 | 无（首次要装） | 无 | 无 |
| 兼容性 | 全部工具正常 | 全部工具正常，极少数老工具不认挂载点 | 全部工具正常，install 会重建 | 全部工具正常 | hoisted 正常，pnp 风险高 | WSL 下正常，性能下降 |
| 维护成本 | 低 | 中（要管卷 GUID） | 低（脚本已就绪） | 中（每机一份，占空间） | 高（依赖拓扑被改） | 高 |
| U 盘写入量 | 不变 | 不变 | 不变 | 大幅下降 | 不变 | 不变 |
| 失败模式 | 盘符被占用 | 卷 GUID 变更 | 实体缺失时修不了 | 多机状态不一致 | 幽灵依赖、HMR 失效 | 性能不可接受 |
| 适用场景 | 常用字母稳定 | 盘符经常变 | 已断链的现场恢复 | 依赖体积大、机器固定 | 不推荐 | CI 复现 |

## 七、推荐组合

**主方案：A1 固定盘符。** 每台机器把 U 盘分配到 `Z:`，然后在 `ws-env.ps1` 之外不需要任何改动，pnpm 完全无感。

**为什么不用 A2：** 它更纯粹，但需要管理员权限与卷 GUID 维护，而收益（盘符无关）在「每台机器只插同一支盘」的场景里并不明显。

**兜底：B。** 万一在某台机器上盘符没固定住，跑一次 `ws-links.ps1 -Repair`，几十秒恢复，不必重装。

**升级路径：C 的第 2 条。** 如果 U 盘写入成为瓶颈（29445 个目录项的日记开销不小），把仓库迁到本机、U 盘只留 git，这是长期更稳的形态。

落地顺序：

1. 先在一台机器上把盘符固定成 `Z:`，插拔两次确认 Windows 记住了绑定。
2. 跑第五节的六步，确认全绿，并把反例记下来。
3. 在第二台机器上重复第 1 步，插盘后直接跑第二步与第三步，验证不重装即可用。
4. 若第 3 步失败，说明盘符没固定住，用 `-Repair` 兜底，并把失败原因记进 `WORKSPACE-STATUS.md`。

## 八、依赖之外的换机断点

依赖只是「继续原任务」的一部分。以下五项换机后同样会断，且不会在 `ws-links.ps1` 里体现：

| 断点 | 位置 | 换机后的状态 | 处理方式 |
| --- | --- | --- | --- |
| PostgreSQL 数据 | Docker Desktop 命名卷 `fanhe-work-pgdata`，在 WSL2 里 | 不在 U 盘上，换机后是空的 | `pg_dump` 导出到 U 盘，或接受重建后跑迁移与种子 |
| Docker 镜像 | Docker Desktop 本地镜像库 | 不在 U 盘上 | 首次 `compose build`，之后从镜像仓拉 |
| Electron 二进制 | `.cache/electron`（U 盘内） | 随盘走，通常可用 | 失效时 `ensure-electron.mjs` 会自愈 |
| 密钥文件 | `.env.compose`（U 盘内） | 随盘走 | 注意不要跨机共用 `FANHE_JWT_SECRET` |
| Python venv | `.venv` | `pyvenv.cfg` 记录系统解释器绝对路径 | `ws-repair.ps1` 已处理，会重建 shims |

第一条是最容易被忽略的。依赖修好了，`pnpm test` 仍会整片失败，症状是 `P2021` 表不存在，因为库在另一台机器的 Docker 卷里。

## 九、本次实测记录

在隔离目录构造断链，跑完整闭环，结果如下（日志原文）：

```
# 修复前
[links] links total = 1, broken = 1, of which naming the previous root = 1
exit=1

# 修复
[links] links total = 1, broken = 1, of which naming the previous root = 1
[links] rewritten 1 link(s)
exit=0

# 修复后
[links] link check passed, the dependency tree resolves on this host
exit=0
```

真实工作区扫描结果：`links total = 29445`，`fanhe-work: top level links 9 / declared 9`，退出码 0。

过程中发现并修掉了脚本的一个缺陷：第一版把断链统计输出成普通信息行，没有累加问题计数，于是「有断链仍判定通过」。只看退出码会以为检查有效，做了反例才暴露。这条记在这里，提醒后续改动同样的判定逻辑时要重跑反例。
