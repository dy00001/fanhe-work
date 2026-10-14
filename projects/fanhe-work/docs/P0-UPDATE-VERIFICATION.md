# P0 更新通道正向验证 · 操作手册

> **这份手册要闭合全项目唯一未闭环的验收**：`安装 A → 发布 B → 检查 → 下载 → 安装 → 重启，版本变 B`（`docs/T6-03-UPDATE-CHANNEL.md` §八 第 4 条）。
> 两端已就绪：A = `v0.1.0`（2026-10-13 16:0x 发布）、B = `v0.1.1`（同日 17:4x 发布），GitHub Release 资产齐备。
> 关联：`docs/WORK-STATUS.md` §4.1、`docs/PHASE-SUMMARY-2026-10-13.md` §4.1。
> 整理于 2026-10-14，同日按实测修正过一次（见第 0.5 节）。
> 🔴 **若发新版被「找不到证书」卡住**，那是另一个问题，见 **`docs/SIGNING-ROTATION-RUNBOOK.md`**（签名身份轮换手册）。本手册**全程不需要私钥**，不受那个阻塞影响。

## 零、为什么必须真人点这一次

自动化已经验过的部分：

- **反例①**（改 `latest.yml` 的 sha512 → updater 拒绝）已跑通。
- **反例②**（同一个包、逐字节不变、只把自签根移出 `CurrentUser\Root` → `Status` 由 `0` 变 `1` → 拒绝）已跑通，因变量只有信任根，是干净的对照。
- **反例⑤**（缺 blockmap → 差分回退整包）每轮复现。
- **静态正向**（`latest.yml` 的 sha512 / size 与实际安装包一致）已验。

**没验的是「一次真实的、跨版本的、端到端成功的更新」。** 上面全部是拒绝路径或静态一致性。正向路径要证明的是：真的能从 A 升到 B，并且**差分下载**在真实发布源上可用（`0.1.0.exe.blockmap` 已发布，此前每次都是因为缺它而回退整包）。这件事必须在一台真实装有 A 的机器上发生一次。

## 0.5　先知道一件事：已发布客户端没有更新按钮

**这一节是 2026-10-14 实测补上的，做验证前务必先读。**

v0.1.0 与 v0.1.1 两个安装包**带着旧的前端产物**。原因是打包链路 `dist` 只跑 `sync-version.mjs && tsc && electron-builder`，**不重建 web**；发布前没有先跑 `pnpm --filter @fanhe/web build`，于是打进包里的是更早一次的 `apps/web/dist`。

实测证据（本机安装的 v0.1.1）：在 `resources/web/` 里检索「更新」相关文案，只命中一句

```
已是 ${n}，刷新页面即可更新
```

这是**浏览器宿主**那一支的文案；检索「重启」二字，**零命中**。也就是说：

1. 桌面态**没有可点的更新按钮**（T7-02b 做的那个按钮没有进这个包）。
2. 显示的那句话是**错的**。外壳加载的是内置产物，刷新页面不会让版本变化。

**但更新仍然会发生。** 主进程的 `wireAutoUpdater()`（v0.1.0 与 v0.1.1 都有）在启动后自动检查一次，并且

- `autoUpdater.autoDownload = true`，有新版就自动下载；
- `autoUpdater.autoInstallOnAppQuit = true`，下载好的新版会在**应用退出时**装上。

**所以这条链路在已发布客户端上的实际入口是「退出应用再打开」，而不是点按钮。**

这一点不影响 §八 第 4 条的验收（那条只要求检查、下载、安装、重启、版本变 B），但做验证的人必须知道，否则会去找一个不存在的按钮。**这个缺陷要在下一个版本里修**，做法是发版前先 `pnpm --filter @fanhe/web build` 再 `dist`。

## 一、两种机器不能混

| | 打包机（开发机） | 目标机（接收更新的机器） |
| -- | -- | -- |
| 有什么 | 私钥在 `CurrentUser\My` | 只有公钥 `.cer` |
| 跑什么 | `pnpm --filter @fanhe/desktop signing:cert` | `pnpm --filter @fanhe/desktop signing:trust` |
| 会不会创建证书 | 会 | **不会** |

🔴 **在目标机上跑 `signing:cert` 会把那台机器的更新永久弄坏。** 它会在那台机器上生成一张新证书，新证书的根与已发布包的签名者（`CN=Fanhe Work` / `0604B238…`）不是同一个根，装了也没用。已发布包需要的是**原始那一个根**。

**本手册只用目标机路径，全程不需要私钥。**

## 二、目标机操作步骤

### 步骤 0　确认现状

```powershell
# 装的是不是 v0.1.0？装完后这里会变成 0.1.1，是本手册的主判据。
(Get-Item "<安装目录>\梵禾 Work.exe").VersionInfo.FileVersion

# 这台机器信不信任原始签名根？期望都是 0 条。
(Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -eq 'CN=Fanhe Work' }).Count
(Get-ChildItem Cert:\CurrentUser\TrustedPublisher | Where-Object { $_.Subject -eq 'CN=Fanhe Work' }).Count

# 更新缓存是不是空的？热的缓存会让「下载」这一步被跳过，验证就失去意义。
Get-ChildItem "$env:LOCALAPPDATA\@fanhedesktop-updater" -Recurse -File -ErrorAction SilentlyContinue
```

安装目录通常是 `%LOCALAPPDATA%\Programs\@fanhedesktop`，也可能是安装时手选的路径（本机实测为 `D:\fanhe work\@fanhedesktop`）。

🔴 **缓存目录里若有 `installer.exe`，先清掉它。** 实测本机该目录躺着一个 112,209,032 字节的 `installer.exe`，正是 v0.1.1 安装包的大小。缓存是热的，updater 会直接复用，**下载这一步就不会真的发生**，而「差分下载」恰恰是这次验证要证明的东西。删之前确认该目录里只有这一个缓存文件。

### 步骤 1　装信任根

拿 `fanhe-work-signing-public.cer`（仓库 `apps/desktop/scripts/` 下，已纳入版本控制，指纹 `0604B2381B8666C99F247DA7B576A4647601A5A3`，**不含私钥**）。两条路选一条。

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

### 步骤 2　纯用户路径验证（推荐，最贴近验收原文）

1. **启动**「梵禾 Work」v0.1.0 并登录。启动后它会自动检查一次更新（**界面上不会有任何可见变化**，见第 0.5 节）。
2. **等下载完成。** 观察缓存目录，出现 `installer.exe` 即下载完成：

   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\@fanhedesktop-updater" -Recurse -File -ErrorAction SilentlyContinue |
     Select-Object Name, Length, LastWriteTime
   ```

   期望长度 112,209,032（与 GitHub Release 上 `fanhe-work-setup-0.1.1.exe` 一致）。若日志里出现 `Cannot download differentially`，说明回退了整包下载。
3. **退出应用。** 这一步触发 `autoInstallOnAppQuit`，新版会被静默装上（可能看到安装进度）。
4. **重新打开**，走步骤 4 验版本。

### 步骤 3　探针路径（诊断用，可选）

v0.1.0 与 v0.1.1 都内置了 `--update-probe` 模式，它只做「检查 + 下载」这一件事，并把结果打出来。**它刻意关掉了退出时自动安装**，所以是一个只读动作，不会改这台机器上的软件。

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS "<安装目录>/梵禾 Work.exe" --update-probe --expect-downloaded --no-sandbox
```

两个 `-u` 不能省，否则打包态会退化成裸 Node。期望输出含：

```
[update-probe] 阶段=downloaded 版本=0.1.1
[update-probe] 是否可安装=是
[update-probe] PASS
```

退出码 0。若报 `阶段=error`，`说明=` 那一行会给出原因（签名不符 / 校验失败 / 网络）。

⚠️ **探针与步骤 2 不要连着做而中间不清缓存。** 探针会把包下到同一个缓存目录，接着走步骤 2 时 updater 会直接复用，跳过下载。两者之间请清一次缓存。

### 步骤 4　验证版本

```powershell
(Get-Item "<安装目录>\梵禾 Work.exe").VersionInfo.FileVersion   # 期望 0.1.1
```

**注意菜单里那行版本号是 Vite 构建期常量，更新成功后可能仍显示旧号，它不是判据。** 权威判据是 `app.getVersion()`，它等于 asar 内 `package.json` 的 `version`，与上面那行 exe `FileVersion` 同源。

### 步骤 5　附带验证「更新后本地存储不丢」

这是 T7-02 之后加严的验收条件。

1. 更新**前**，在客户端里建一条可辨认的数据（例如一条纪要，内容写 `P0-BEFORE`）。
2. 走完更新并重启。
3. 确认那条数据仍在。

⚠️ **前置**：壳必须已经跑在**稳定端口**上（T7-02a）。否则「设置是否还在」这个观察本身会被存储分区漂移污染。自检方式是看偏好文件 `%APPDATA%\梵禾 Work\shell-origin.json` 是否稳定，或重启两次确认端口不变。

## 三、判据汇总

| # | 判据 | 期望 | 说明 |
| -- | -- | -- | -- |
| 1 | 启动后缓存目录出现 `installer.exe` | 是，112,209,032 字节 | 证明「检查 + 下载」这一段真的走了 |
| 2 | 未报 `sha512 checksum mismatch` | 是 | 完整性层 |
| 3 | 未报 `Sign verification failed` | 是 | 发布者层，取决于步骤 1 是否做对 |
| 4 | exe `FileVersion` | `0.1.1` | **主判据** |
| 5 | 更新前建的数据仍在 | 是 | T7-02 加严的条件 |
| 6 | 是否走了差分下载 | 观察项 | 出现 `Cannot download differentially` 即回退整包，说明 blockmap 未被用上 |

## 四、常见失败与含义

| 现象 | 含义 | 处理 |
| -- | -- | -- |
| 报 `Sign verification failed, installer signed with incorrect certificate` | 信任根没装上，或装到了别的库 | 回步骤 1；`signing:trust-check` 会指出缺哪一环 |
| 启动后缓存目录一直是空的 | 取不到版本清单，或版本判定不是 `outdated` | 用步骤 3 的探针看 `阶段=`，它会说明卡在哪 |
| 报 `sha512 checksum mismatch` | 下载到的包与 `latest.yml` 不符 | 网络或代理问题；重试 |
| `Cannot download differentially, fallback to full download ... status 404` | 差分不可用，回退整包 | **不算失败**，但说明 blockmap 没被用上，值得记一笔 |
| 退出应用后版本没变 | `autoInstallOnAppQuit` 没生效，或退出方式绕过了它 | 用正常关窗退出，不要用任务管理器强杀 |
| 更新后设置像是丢了 | 端口漂移导致存储分区变了（T7-02 的老问题） | 检查 `shell-origin.json`；这是 T7-02a 要防的，不该再发生 |
| 找不到「更新按钮」 | 正常现象，已发布客户端没有这个按钮 | 见第 0.5 节，走「退出再打开」 |

## 五、做完之后要回填什么

1. `docs/T6-03-UPDATE-CHANNEL.md` §八.1 表格里第 4 条由 ⏳ 改为 ✅，并记下实际观察（尤其是差分是否生效）。
2. `docs/WORK-STATUS.md` §4.1 与头部「当前阶段」把这一项从「未闭环」移出。
3. `docs/DEVELOPMENT-PLAN.md` 头部「当前状态」与 `docs/PHASE-SUMMARY-2026-10-13.md` §4.1。
4. 若差分真的生效（不再出现回退整包），把「差分下载的正验」也一并标为已完成。
5. 把第 0.5 节那个缺陷（已发布客户端无更新按钮、文案错误）记进下一版的待办。
