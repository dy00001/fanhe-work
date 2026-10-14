# P0 更新通道正向验证 · 操作手册

> **这份手册要闭合全项目唯一未闭环的验收**：`安装 A → 发布 B → 检查 → 下载 → 安装 → 重启，版本变 B`（`docs/T6-03-UPDATE-CHANNEL.md` §八 第 4 条）。
> 两端已就绪：A = `v0.1.0`（2026-10-13 16:0x 发布）、B = `v0.1.1`（同日 17:4x 发布），GitHub Release 资产齐备。
> 关联：`docs/WORK-STATUS.md` §4.1、`docs/PHASE-SUMMARY-2026-10-13.md` §4.1。
> 整理于 2026-10-14。

## 零、为什么必须真人点这一次

自动化已经验过的部分：

- **反例①**（改 `latest.yml` 的 sha512 → updater 拒绝）✅ 离线验收台跑通。
- **反例②**（同一个包、逐字节不变、只把自签根移出 `CurrentUser\Root` → `Status` 由 `0` 变 `1` → 拒绝）✅ 跑通，因变量只有信任根，是干净的对照。
- **反例⑤**（缺 blockmap → 差分回退整包）✅ 每轮复现。
- **静态正向**（`latest.yml` 的 sha512 / size 与实际安装包一致）✅。

**没验的是「一次真实的、跨版本的、端到端成功的更新」。** 上面全部是「拒绝路径」或「静态一致性」，而正向路径要证明的是：真的能从 A 升到 B，并且**差分下载**在真实发布源上可用（`0.1.0.exe.blockmap` 已发布，此前每次都是因为缺它而回退整包）。这件事必须在一台真实装有 A 的机器上发生一次。

## 一、两种机器不能混

| | 打包机（开发机） | 目标机（接收更新的机器） |
| -- | -- | -- |
| 有什么 | 私钥在 `CurrentUser\My` | 只有公钥 `.cer` |
| 跑什么 | `pnpm --filter @fanhe/desktop signing:cert` | `pnpm --filter @fanhe/desktop signing:trust` |
| 会不会创建证书 | 会 | **不会** |

🔴 **在目标机上跑 `signing:cert` 会把那台机器的更新永久弄坏。** 它会在那台机器上生成一张**新**证书，新证书的根与已发布包的签名者（`CN=Fanhe Work` / `0604B238…`）不是同一个根，装了也没用。已发布包需要的是**原始那一个根**。

**本手册只用目标机路径，全程不需要私钥。**

## 二、目标机操作步骤

### 步骤 0　确认现状

在目标机上跑（PowerShell）：

```powershell
# 装的是不是 v0.1.0？下面这行在装完后会变成 0.1.1，是本手册的判据。
(Get-Item "<安装目录>\梵禾 Work.exe").VersionInfo.FileVersion

# 这台机器信不信任原始签名根？期望 0 条。
(Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -eq 'CN=Fanhe Work' }).Count
(Get-ChildItem Cert:\CurrentUser\TrustedPublisher | Where-Object { $_.Subject -eq 'CN=Fanhe Work' }).Count
```

安装目录通常是 `%LOCALAPPDATA%\Programs\@fanhedesktop`，也可能是安装时手选的路径（本机实测为 `D:\fanhe work\@fanhedesktop`）。

### 步骤 1　装信任根

拿 `fanhe-work-signing-public.cer`（在仓库的 `apps/desktop/scripts/` 下，已纳入版本控制，指纹 `0604B2381B8666C99F247DA7B576A4647601A5A3`，**不含私钥**）。两条路选一条。

**路线 A　目标机上有这个仓库**（推荐，可复查）

```powershell
# 经工作空间入口调用，串行执行，不要并发
pnpm --filter @fanhe/desktop signing:trust-check   # 只读自检：退出码 0 = 能收到用该证书签的更新
pnpm --filter @fanhe/desktop signing:trust         # 装根（TrustedPublisher + Root），不建证书
pnpm --filter @fanhe/desktop signing:trust-check   # 复查，期望 TRUST_ROOT=True、退出码 0
```

**路线 B　目标机上没有仓库**

把那个 `.cer` 拷过去，然后：

```powershell
certutil -user -addstore -f Root "<路径>\fanhe-work-signing-public.cer"
certutil -user -addstore -f TrustedPublisher "<路径>\fanhe-work-signing-public.cer"
```

必须用 `certutil`。`Import-Certificate` 在非交互会话里要弹根证书确认框，会报「此操作中不允许使用 UI」。

两个库的分工：`Root` 让证书链变**可信**（这一条决定 updater 放不放行）；`TrustedPublisher` 只抑制「未知发布者」弹窗。缺前者会**静默**失败，缺后者只是可能弹窗。

### 步骤 2　启动客户端

打开「梵禾 Work」，登录。

### 步骤 3　点更新

顶栏会出现一个**可点的更新按钮**（T7-02b 做的；不是旧版那句纯提示）。流程是「检查 → 有更新 → 下载（带进度）→ 点此重启更新」。

### 步骤 4　验证

重启后，先跑脚本判据：

```powershell
(Get-Item "<安装目录>\梵禾 Work.exe").VersionInfo.FileVersion   # 期望 0.1.1
```

再核对应用内版本。**注意菜单里那行版本号是 Vite 构建期常量，更新成功后可能仍显示旧号**，它不是判据。权威判据是 `app.getVersion()`，它等于 asar 内 `package.json` 的 `version`，与上面那行 exe `FileVersion` 同源。

### 步骤 5　附带验证「更新后本地存储不丢」

这是 T7-02 之后加严的验收条件。做法：

1. 更新**前**，在客户端里建一条可辨认的数据（例如一条纪要，内容写 `P0-BEFORE`）。
2. 走完更新并重启。
3. 确认那条数据仍在。

⚠️ **前置**：壳必须已经跑在**稳定端口**上（T7-02a）。否则「设置是否还在」这个观察本身会被存储分区漂移污染。自检方式是看偏好文件 `%APPDATA%\梵禾 Work\shell-origin.json` 是否稳定，或重启两次确认端口不变。

## 三、判据汇总

| # | 判据 | 期望 | 说明 |
| -- | -- | -- | -- |
| 1 | 顶栏出现可点的更新按钮 | 是 | 说明 `GET /api/version` 取到 `0.1.1` 且判定为 `outdated` |
| 2 | 下载完成且未报 `sha512 checksum mismatch` | 是 | 完整性层 |
| 3 | 未报 `Sign verification failed` | 是 | 发布者层，取决于步骤 1 是否做对 |
| 4 | exe `FileVersion` | `0.1.1` | **主判据** |
| 5 | 更新前建的数据仍在 | 是 | T7-02 加严的条件 |
| 6 | 下载日志是否走了差分 | 观察项 | 出现 `Cannot download differentially` 即回退整包，说明 blockmap 未被用上 |

## 四、常见失败与含义

| 现象 | 含义 | 处理 |
| -- | -- | -- |
| 点更新后报 `Sign verification failed, installer signed with incorrect certificate` | 信任根没装上，或装到了别的库 | 回步骤 1；`signing:trust-check` 会指出缺哪一环 |
| 完全没有「有更新」按钮 | 取不到版本清单，或版本判定不是 `outdated` | 检查能否访问更新源 |
| 报 `sha512 checksum mismatch` | 下载到的包与 `latest.yml` 不符 | 网络或代理问题；重试 |
| `Cannot download differentially, fallback to full download ... status 404` | 差分不可用，回退整包 | **不算失败**，但说明 blockmap 没被用上，值得记一笔 |
| 更新后设置像是丢了 | 端口漂移导致存储分区变了（T7-02 的老问题） | 检查 `shell-origin.json`；这是 T7-02a 要防的，不该再发生 |

## 五、做完之后要回填什么

1. `docs/T6-03-UPDATE-CHANNEL.md` §八.1 表格里第 4 条由 ⏳ 改为 ✅，并记下实际观察（尤其是差分是否生效）。
2. `docs/WORK-STATUS.md` §4.1 与头部「当前阶段」把这一项从「未闭环」移出。
3. `docs/DEVELOPMENT-PLAN.md` 头部「当前状态」与 `docs/PHASE-SUMMARY-2026-10-13.md` §4.1。
4. 若差分真的生效（不再出现回退整包），把「差分下载的正验」也一并标为已完成。
