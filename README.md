# fanhe Work

可移动工作空间。整个目录存放在 U 盘上，会在不同电脑之间轮换使用。

## 目录划分

工作空间分为两类内容，物理分开，边界清晰。

```
E:\fanhe Work\
├── infra/                  约束与基础设施，由机制维护
│   ├── portable/           机制脚本、配置与运行时状态
│   └── docs/               机制文档
├── projects/               开发程序，由开发者维护
├── .workbuddy-ai/          长期记忆，路径由记忆系统固定
├── .ws-root                工作空间定位标记，勿删
├── README.md               本文件
├── .editorconfig           编辑器约定
├── .gitattributes          换行与二进制约定
├── .gitignore              忽略规则
└── .cache/ .tmp/ .local/ .config/ logs/ .venv/ runtime/
    .gradle/ .m2/ .cargo/ .rustup/ .go/ .nuget/ .docker/   运行时重定向目标
```

划分依据是归属与变更节奏。`infra/` 随机制演进，变更频率低而影响面大；`projects/` 随业务迭代，变更频繁。两者分开可以降低误操作概率，也让审计与备份的边界保持清晰。

根目录下的 `.ws-root`、`.workbuddy-ai/`、`.gitignore`、`.gitattributes`、`.editorconfig` 不能下移。`.ws-root` 是机制定位工作空间的标记，`.workbuddy-ai/` 的路径由记忆系统固定，后三者在 git 仓库根才能全局生效。运行时重定向目录由环境脚本在根生成，属于整个工作空间的运行时状态，不归入任何一类内容。

## 重要约定

1. 所有开发操作都从 `infra/portable/` 下的入口脚本进入，环境重定向才会生效。
2. 受版本控制的文件里不允许出现盘符。需要根目录时用环境变量 `WS_ROOT`。
3. 路径含空格，脚本中所有变量必须加引号。
4. 介质已由 exFAT 迁移为 NTFS，具备符号链接、硬链接与日志能力。

## 入口

Windows 命令行。

```
infra\portable\ws-run.cmd <命令>
infra\portable\ws-run.cmd -Shell
infra\portable\ws-doctor.ps1
```

bash 或 Git Bash。

```bash
source infra/portable/ws-env.sh
./infra/portable/ws-run.sh <命令>
```

换到新电脑后的标准动作。

```
infra\portable\ws-run.cmd --version
infra\portable\ws-doctor.ps1
```

## 机制文件

| 文件 | 用途 |
| --- | --- |
| `infra/portable/ws-env.ps1` | 环境解析，PowerShell |
| `infra/portable/ws-env.sh` | 环境解析，bash |
| `infra/portable/ws-run.cmd` | cmd 入口 |
| `infra/portable/ws-run.ps1` | PowerShell 入口 |
| `infra/portable/ws-run.sh` | bash 入口 |
| `infra/portable/ws-repair.ps1` | 换机修复例程 |
| `infra/portable/ws-doctor.ps1` | 审计工具 |
| `infra/portable/ws-locate.ps1` | 跨盘符定位 |

## 文档

| 文档 | 内容 |
| --- | --- |
| `infra/docs/PORTABLE-WORKSPACE.md` | 机制的目标、适用范围、触发方式与需规避场景 |
| `infra/docs/FILESYSTEM-OPTIONS.md` | 摆脱 exFAT 约束的三条路径对比 |
| `infra/docs/NTFS-MIGRATION.md` | NTFS 迁移操作手册与执行记录 |
