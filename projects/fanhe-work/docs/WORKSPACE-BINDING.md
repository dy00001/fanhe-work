# 工作区与远端仓库的绑定登记

> 记录时间 2026-10-11 14:20。本文件登记移动工作空间与 GitHub 远端仓库的绑定关系，供换机、换账户与故障排查时对照。路径一律以工作空间根为基准，不写盘符。

---

## 一、绑定关系

| 项目 | 值 |
| --- | --- |
| 远端仓库 | `https://github.com/dy00001/fanhe-work.git` |
| 仓库可见性 | 公开 |
| 默认分支 | `main` |
| 工作区根 | `.ws-root` 所在目录，与仓库检出根重合 |
| 提交身份 | `梵禾 <dev@fanhe.local>` |
| 传输协议 | HTTPS，经本地代理出站 |

工作区根与仓库根为同一目录。`infra/`、`projects/` 与根级配置文件同处一个仓库内受版本控制。

## 二、分支约定

| 分支 | 定位 | 本地跟踪 |
| --- | --- | --- |
| `main` | 主线，保持可交付 | 是，跟踪 `origin/main` |
| `dev` | 开发分支 | 是，跟踪 `origin/dev` |

两个分支在 2026-10-11 时同源。主线推进后 `dev` 需按需跟进或重建。

## 三、两条独立链路

访问该远端存在两条互不共享凭据的链路。

| 维度 | 链路 B 本地 git | 链路 A WorkBuddy 连接器 |
| --- | --- | --- |
| 端点 | `github.com` HTTPS | `api.githubcopilot.com/mcp/` |
| 凭据 | 细粒度 PAT，经 GCM 存储 | 服务端代管，本地无凭据文件 |
| 权限 | 读写 | 只读，写入被拒 |
| 适用场景 | 日常提交与推送 | 助手经 API 读取仓库内容 |

链路 B 的凭据配置在 `~/.gitconfig`，属逐机逐用户，换机后必须重新配置。链路 A 的授权范围与权限级别在 GitHub 网页侧的 App 安装设置中调整，本地无法代劳。

## 四、换机与故障排查

1. 换机后先跑 `infra\portable\ws-doctor.ps1` 检查工作区完整性。
2. 重新配置 `~/.gitconfig` 的 `credential.helper` 与代理项。
3. 用 `git ls-remote --heads origin` 验证读权限。
4. 用 `git push --dry-run origin main` 验证写权限，该命令走完整认证流程而不实际写入。
5. 连接器侧若出现 404，检查 `https://github.com/settings/installations` 中的仓库访问范围。

## 五、本次核验记录

核验时间 2026-10-11 14:20。

| 测试项 | 结果 |
| --- | --- |
| 本地读远端 | 通过，返回 `refs/heads/main` 与 `refs/heads/dev` |
| 本地写远端 | 通过，推送区间 `ea119ab..e5a1953` |
| 连接器身份识别 | 通过，账号 `dy00001` |
| 连接器读仓库根 | 通过，返回 7 个条目 |
| 连接器写仓库 | 未通过，`403 Resource not accessible by integration` |

两点结论。

第一，连接器的仓库访问范围已覆盖目标仓库。此前记录的 404 不再复现，`get_file_contents` 可正常读取仓库根目录。

第二，连接器的权限级别为只读。写入返回 403，原因落在 App 安装的权限授予上，需要人工在 GitHub 网页侧处理。处理路径为 `https://github.com/settings/installations`，找到对应条目进入 Configure，在 Permissions 一节把 Contents 由 Read 调整为 Read and write。该动作不改变仓库访问范围，两者是独立的设置项。

写权限对当前目标是可选项。日常提交与推送由链路 B 承担，链路 A 只用于助手读取远端内容。
