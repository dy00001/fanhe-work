# 工作区现状与后续要点

本文件是对 `fanhe Work` 工作区的一次完整勘察记录，供后续任务直接引用。快照日期 2026-10-10，采集方式为逐文件读取加实时状态检查。

| 项目 | 内容 |
| --- | --- |
| 工作空间名称 | fanhe Work |
| 稳定标识 | `fanhe-work-4f2a9c81` |
| 建立日期 | 2026-10-09 |
| 介质 | U 盘，卷标 `WORK`，NTFS，分配单元 4096 字节，容量约 29.3GB |
| 当前挂载点 | `F:/fanhe Work` |
| 状态文件记录 | `E:/fanhe Work`，主机 `DY`，用户 `dy`，Windows 10 Pro |

---

## 一、结构与职责划分

工作区按归属与变更节奏分为两类，物理分开。

| 位置 | 职责 | 维护方 | 变更频率 |
| --- | --- | --- | --- |
| `infra/` | 约束与基础设施 | 机制 | 低，影响面大 |
| `projects/` | 开发程序，每项目一子目录 | 开发者 | 高 |

根目录下不可下移的四项及其原因。

1. `.ws-root` 是机制定位工作空间的标记文件，携带稳定标识，勿删勿改名。
2. `.workbuddy-ai/` 的路径由记忆系统固定，存放长期记忆。
3. `.gitignore`、`.gitattributes`、`.editorconfig` 须位于 git 仓库根才能全局生效。
4. 运行时重定向目录由环境脚本在根生成，属于整个工作空间的运行时状态。

---

## 二、机制文件清单

`infra/portable/` 是可移植机制的全部实现。

| 文件 | 职责 | 关键参数 |
| --- | --- | --- |
| `ws-env.ps1` | PowerShell 环境解析与重定向 | `-NoRepair`、`-Quiet` |
| `ws-env.sh` | bash 环境解析，以子进程调用状态管理器 | `WS_NO_REPAIR`、`WS_QUIET` |
| `ws-run.cmd` | cmd 入口，转发到 `ws-run.ps1` | 透传参数 |
| `ws-run.ps1` | 主入口，在进程内应用环境后执行命令，保留调用者目录 | `-Shell` |
| `ws-run.sh` | bash 入口，保留调用者目录 | 无参数时打印环境 |
| `ws-state.ps1` | 状态管理器，双信号比较的唯一实现 | `-Root`、`-NoRepair`、`-Quiet` |
| `ws-repair.ps1` | 修复例程与工具链健康检查 | `-Reason`、`-CheckOnly` |
| `ws-doctor.ps1` | 审计，扫硬编码盘符、统计体积、比对泄漏 | `-Baseline`、`-Leak` |
| `ws-locate.ps1` | 跨盘符定位，匹配 `.ws-root` | `-MaxDepth`、`-MarkerId` |
| `config/.npmrc` | 工作区级 npm 配置，用 `${WS_ROOT}` 变量 | 无盘符 |
| `config/.yarnrc.yml` | 工作区级 Yarn Berry 配置 | 无盘符 |
| `state/root.json` | 逐机状态，变化检测判据 | 不纳入版本控制 |

`infra/docs/` 是三份机制文档。

| 文档 | 内容 |
| --- | --- |
| `PORTABLE-WORKSPACE.md` | 机制目标、覆盖范围、三层触发、预期效果、需规避场景、验证记录 |
| `FILESYSTEM-OPTIONS.md` | 摆脱 exFAT 约束的三条路径对比与决策建议 |
| `NTFS-MIGRATION.md` | NTFS 迁移操作手册与执行记录，含 4GB 限制澄清 |

---

## 三、机制运行方式

三层触发，逐层兜底。

1. **自定位**。入口脚本用自身位置向上查找 `.ws-root` 标记推导根目录，不写死层级，盘符变化完全透明。
2. **变化检测**。`ws-state.ps1` 每次启动比较两个独立信号，任一不一致即调用 `ws-repair.ps1`。根变化对应盘符改变，主机变化对应换电脑而盘符可能相同。
3. **定位兜底**。`ws-locate.ps1` 扫描全部已挂载卷，用标记文件定位，用于工具或快捷方式仍指向旧路径时的手工恢复。

环境重定向覆盖临时目录、XDG 三类根、Python、Node 生态、JVM 生态、Rust、Go、编译缓存、浏览器与 Electron 二进制、NuGet、日志。全部为进程级变量，不修改宿主机环境。Docker 的客户端配置不在此列，原因是它存的是上下文与 CLI 插件而非可重建的缓存，重定向会让 `docker compose` 失效，详见 `PORTABLE-WORKSPACE.md`。

健康检查可随时单独运行，只报告不修改。

```powershell
infra\portable\ws-repair.ps1 -CheckOnly
```

---

## 四、当前实时状态

勘察时工作区的实际状态如下，与文档描述存在若干需要留意的差异。

| 检查项 | 实际结果 | 说明 |
| --- | --- | --- |
| 挂载盘符 | `F:` | 状态文件记录为 `E:`，两者不一致 |
| git 仓库 | 不存在 | 有 `.gitignore`、`.gitattributes`、`.editorconfig`，但未执行 `git init` |
| Python 虚拟环境 | `.venv/` 为空 | 无 `pyvenv.cfg`，健康检查会报告未建立 |
| 便携运行时 | `runtime/` 为空 | 当前依赖宿主机工具链 |
| 缓存与数据目录 | `.cache` 仅 4KB，其余均为 0 | 尚未安装过依赖，属全新状态 |
| `logs/` | 空 | 无历史日志 |
| `projects/` | 仅 `fanhe-work/docs/IMPLEMENTATION-PLAN.md` | 无代码，只有方案文档 |

盘符不一致是当前最值得注意的一点。`state/root.json` 记录的是 `E:`，而本次挂载为 `F:`。下次经入口脚本启动时，根变化信号会命中，自动输出告警并以 `reason = relocation` 调用修复例程，随后把状态文件更新为 `F:`。这属于机制的预期行为，无需人工干预。

---

## 五、已有资源

1. 一套已验证的可移植机制，覆盖盘符自适应、写入内聚、变化检测、修复与审计。
2. 三份机制文档，含设计依据、边界条件与验证记录。
3. 一份完整项目实施方案 `projects/fanhe-work/docs/IMPLEMENTATION-PLAN.md`（v1.0），含需求解构、技术选型、10 款 UI 候选、布局规格、三板块设计、权限模型、数据模型、六阶段路线图、风险清单与待决策事项。
4. 三份长期记忆，`MEMORY.md` 与两份日志，沉淀了全部约定与踩坑记录。
5. 一套根级配置，换行规范、编码规范、忽略规则齐备。

---

## 六、限制条件

| 类别 | 限制 | 影响与应对 |
| --- | --- | --- |
| 文件系统 | 符号链接依赖开发者模式 | 本机已开启，`core.symlinks` 已改为 true。该能力属于主机而非工作区，换到未开启开发者模式的机器上 git 会退化为写普通文件 |
| 文件系统 | ACL 跨机无效 | 卷根已放宽为 Everyone 完全控制，写入范围依靠重定向加审计 |
| 硬件 | 32GB U 盘，闪存颗粒 | 随机 IO 弱且有写入寿命，重型构建产物应移出或重定向 |
| 路径 | 工作区路径含空格 | 脚本中所有变量必须加引号 |
| 约定 | 受版本控制的文件禁止出现盘符 | 需要根目录时使用 `WS_ROOT` |
| 约定 | 入口唯一 | 直接启动 IDE 不会继承重定向 |
| 编码 | bash 与 Windows PowerShell 编码差异 | 跨环境传递含中文路径的文本，读取侧显式指定 UTF-8 |
| 工具探测 | Store 别名桩与 `.ps1` 转发脚本 | 需按 `\WindowsApps\` 过滤并只认可 `.exe`、`.cmd`、`.bat` |

---

## 七、未完成事项

按优先级排列。

1. **确认新盘可用后清理备份** `D:\_ws-migration`，含诊断文件。
2. **换 USB 硬盘盒加 SSD**，需确认桥接芯片支持 UASP 与 TRIM 透传。

已于 2026-10-10 完成的三项，原先列在这里。

- 开发者模式已开启（`AllowDevelopmentWithoutDevLicense` 由未设置改为 1），两个环境脚本与仓库本地配置中的 `core.symlinks` 已由 false 改为 true。
- NTFS 长路径支持此前已是 1，无需处理。
- git 仓库已在工作区根建立，三份根级配置已生效。

原第 5 项「补 `CARGO_TARGET_DIR`」已作废。桌面外壳在决策门 G4 中定为 Electron，不再需要 Rust 工具链。

---

## 八、待决策事项

`IMPLEMENTATION-PLAN.md` 第十二章列出五项，需确认后才能进入阶段零。

1. UI 方案选哪一款，建议先定三个方向再定具体库。
2. 前端技术栈，推荐 React。
3. 桌面外壳，推荐 Tauri 2 并把套壳后置，若不愿引入 Rust 改用 Electron。
4. 实验版数据库，推荐 SQLite 单机文件。
5. 一键登录的安全边界，是否接受只做唤起而不自动填密。

---

## 九、后续任务可直接沿用的要点

1. 任何开发操作从 `infra/portable/ws-run.cmd` 或 `ws-run.sh` 进入，环境重定向才会生效。
2. 新增技术栈时，只在 `ws-env.ps1` 与 `ws-env.sh` 的映射表各加一行，不另写逻辑。
3. 新增需要根目录的脚本，沿用向上查找 `.ws-root`，不要写死层级。
4. 换机后的标准动作序列为 `ws-run.cmd --version`、`ws-repair.ps1 -CheckOnly`、`ws-doctor.ps1`。
5. 项目内的本机绝对路径（如启动配置中的可执行文件路径）只存运行时数据库，数据库纳入忽略规则。
6. 权限校验只在服务端执行，前端只承担体验职责。
