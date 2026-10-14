# P0 更新通道正向验证 · 操作手册

> **这份手册要闭合全项目唯一未闭环的验收**：`安装 A → 发布 B → 检查 → 下载 → 安装 → 重启，版本变 B`（`docs/T6-03-UPDATE-CHANNEL.md` §八 第 4 条）。
> 两端已就绪：A = `v0.1.0`（2026-10-13 16:0x 发布）、B = `v0.1.1`（同日 17:4x 发布），GitHub Release 资产齐备。
> 🔴 **但「B 端是谁」由发布动作决定，不由本手册决定** —— `0.1.2` 一旦发布，`latest.yml` 就指向它。**先读第 0.6 节选路径。**
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

这一点不影响 §八 第 4 条的验收（那条只要求检查、下载、安装、重启、版本变 B），但做验证的人必须知道，否则会去找一个不存在的按钮。

**`0.1.2` 修掉了按钮那一半，但没修掉「产物陈旧」这件事本身 —— 它换了一张脸又出现了一次。**

- ✅ **按钮回来了。** 发版前跑过 `pnpm --filter @fanhe/web build`，`verify:pack` 断言产物含 `重启更新到` 也确实通过了，所以 `0.1.2` 的客户端里那个按钮是有的。
- ❌ **但版本号是旧的。** 前端产物构建于 **22:41**（当时仓库根版本还是 `0.1.1`），版本号 **22:57** 才提到 `0.1.2`，安装包 **22:54** 打出来 —— 于是包里烧着 `0.1.1`。用户从 GitHub 装了 `0.1.2`，菜单那行显示 `v0.1.1 · 2026-10-14 · dd4e9e6`，**看起来像更新失败**。

🔴 **这是本条最值钱的一课**：既有的三条标记断言（`fanheDesktop` / `重启更新到` / `正在下载`）锚点是**写死的字符串**，所以只能抓住「写它们时想抓的那一次陈旧」；而「逐字节一致」那条比的是**包内副本与源目录**，两边同旧时照样全绿。三条全在、比对全过，包里烧的却是旧版本号。

**现在的判据是绝对的**：产物自报的版本号 == 仓库根 `package.json` 的版本号，不含需要随发版维护的常量。两道关 —— 打包前 `scripts/check-web-build.mjs`（`dist` / `dist:dir` 的第一步，不符即拒绝打包）、打包后 `verify-pack.mjs`「二·补二」。正确顺序是**先定版本号 → 再 `pnpm --filter @fanhe/web build` → 最后 `dist`**，第一步必须早于第二步。

⚠️ **这修不到已经装在别的机器上的 `0.1.0` / `0.1.1` / `0.1.2`** —— 那几台仍只能走「退出再打开」，且菜单版本号仍会显示旧值（它们的产物是陈旧的，而版本号是构建期烧进去的）。**判定装的是哪一版，一律用 exe 的 `VersionInfo.FileVersion`，不要看菜单那行。**

> **但「菜单那行会骗人」这件事本身已经修掉了**（T7-05 续）：桌面态现在优先读外壳 `app.getVersion()` 的运行期值，不再用构建期常量。⚠️ 它**要下一个版本才会在用户机器上生效** —— 当前 `0.1.2` 的产物里还是旧代码。生效之后，菜单那行与 `FileVersion` 应始终一致；**若哪天它们又不一致，那说明产物陈旧又发生了**，此时以 `FileVersion` 为准并去查 `check:web`。

## 0.6　`0.1.2` 发布之后 B 端会变 —— 先选路径

**2026-10-14 补。** 本手册原文按 **A=`v0.1.0` → B=`v0.1.1`** 写。但 `0.1.2` 已经打好包（`apps/desktop/release/fanhe-work-setup-0.1.2.exe`，**112,218,832 字节**，`verify:pack` 43 项全过），**它一发布，GitHub 上的 `latest.yml` 就指向 `0.1.2`**，于是「B 端是谁」由发布动作决定。两条路的操作与判据**都不同**：

| | 路径 A（本手册原文） | 路径 B（`0.1.2` 发布之后） |
| -- | -- | -- |
| A 端 | `v0.1.0` —— **要另装** | `v0.1.1` —— **本机已是** |
| B 端 | `v0.1.1` | `0.1.2` |
| 装哪个根 | **退役旧根** `0604B238…`（`fanhe-work-signing-public-retired-0604b238.cer`） | **新根** `095CB390…`（`fanhe-work-signing-public.cer`） |
| 缓存期望长度 | 112,209,032 | **112,218,832** |
| `FileVersion` 期望 | `0.1.1` | **`0.1.2`** |
| 闭合 §八 第 4 条（端到端正向更新） | ✅ | ✅ |
| 闭合轮换手册 §八 第一条（**同 CN 新证书能否被旧客户端接受**） | ❌ 走的是旧身份 | ✅ **唯一能闭合它的路径** |

**路径 B 严格更强，且准备成本更低。** 三条理由：

1. **本机已经是 `v0.1.1`**（2026-10-14 实测 `D:\fanhe work\@fanhedesktop`，`FileVersion=0.1.1`），路径 B **不用卸载重装**；路径 A 要先卸掉再装 `v0.1.0`（安装包在 `release/` 里有）。
2. **本机 `Root` 与 `TrustedPublisher` 里新旧两个根都在**（实测各 2 条 `CN=Fanhe Work`：`095CB390…` 与 `0604B238…`），所以它**同时**能接受旧身份与新身份签的包 —— 路径 B 的直接前提已满足，**步骤 1 可以整节跳过**。
3. 🔴 **路径 B 能把轮换手册 §八 第一条从「源码级论证」变成「端到端实测」。** 那一条现在写的是「同 CN、不同指纹的新证书签的包**能否被旧客户端接受** —— **没有实测过**」。路径 B 就是那一次实测；**路径 A 做不到这一点**（它全程走旧身份）。

**路径 B 的代价（如实记）**：`latest` 一旦指向 `0.1.2`，**「`0.1.0` → `0.1.1`」这条原始路径就再也做不了了**（除非删 Release 或改 `latest.yml`）。但那条要证明的东西被路径 B 同样覆盖、且覆盖更多，**不算损失**。

### 路径 B 操作（本机；实测值已填）

**步骤 0　先判断缓存里那个 `installer.exe` 是什么版本**

本机实测缓存目录里有一个 `installer.exe`，**112,209,032 字节 = `v0.1.1` 安装包**（MTIME 2026-10-13 19:38）。**它有两种含义，处理方式相反**：

| 它是 | 含义 | 处理 |
| -- | -- | -- |
| **已下好的新版**（版本 > 当前已装） | updater 会直接复用，**「下载」这一步不会真的发生** | **删掉**，否则验证失去意义 |
| **当前已装版本**（本机即如此：已装 `v0.1.1`，缓存里就是 `v0.1.1` 的包） | 它是**差分下载必需的「旧文件」** | **留着** —— 删了就只能整包下载（109.6 MB 而不是 2.8 MB） |

🔴 **判据是比对版本号，不是「见到就删」。** 本机属于第二种，**留着**。

⚠️ **另一种残留会让差分算错**：缓存里的 `current.blockmap`。若它来自上一次**已经下过新版本**的会话，差分算法会把它当成「旧 blockmap」，于是新旧完全相同、算出 `To download: 0 KB (0%)`，再因 sha512 不符而回退整包（实测踩到过）。**做法：确认 `current.blockmap` 与当前已装版本对应；不确定就删掉它，让 updater 从发布源重新取旧 blockmap。**

**步骤 1　跳过。** 两个根都在（见上）。

**步骤 2　先打一次探针（推荐，最省事）**

探针只做「检查 + 下载」，**不改本机软件**（刻意关掉了退出时自动安装），所以可以先打，确认 `阶段=downloaded 版本=0.1.2` 再走真实路径：

```bash
env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS "D:/fanhe work/@fanhedesktop/梵禾 Work.exe" --update-probe --expect-downloaded --no-sandbox
```

期望 `[update-probe] 阶段=downloaded 版本=0.1.2` / `是否可安装=是` / `PASS`。

🔴 **若这里报 `阶段=error` + `Sign verification failed`** —— 说明新根没在本机生效，回步骤 1 复查 `signing:trust-check`（期望退出码 0、`TRUST_ROOT=True`）。**这一行正是轮换手册 §八 第一条要变成实测的那一层**：本机已装 `v0.1.1`（旧客户端），要接受的 `0.1.2` 是新身份签的 —— 探针说 PASS，那一条就闭合了。

**步骤 2′　纯用户路径（验收原文走这条）**

1. 启动 `v0.1.1` → 自动检查一次（**界面无可见变化**，见第 0.5 节）
2. 等下载：缓存目录出现 `installer.exe`，**期望 112,218,832 字节**
3. **退出应用**（触发 `autoInstallOnAppQuit`）
4. 重新打开 → 步骤 4 验版本

**步骤 4　版本判据改为 `0.1.2`**

```powershell
(Get-Item "D:\fanhe work\@fanhedesktop\梵禾 Work.exe").VersionInfo.FileVersion   # 期望 0.1.2
```

⚠️ **探针与步骤 2′ 之间必须清一次缓存**，否则步骤 2′ 会复用探针下好的包、跳过下载。

> **`0.1.2` 之后这一点会改善**：`0.1.2` 的前端产物里**已经有可点的更新按钮**（`verify:pack` 断言 `重启更新到` 在包里），所以从 `0.1.2` 往后再做这类验证时，**入口回到「点按钮」**，不必再靠「退出再打开」。第 0.5 节那个缺陷在 `0.1.2` 里已经修掉 —— 但**它修不到已经装在别人机器上的 `0.1.0` / `0.1.1`**，那两台仍只能走退出重开。

### 路径 B 执行记录（2026-10-14）

**已做到哪一步、还差哪一步，都记在这里，避免重复。**

| 环节 | 状态 | 实测 |
| -- | -- | -- |
| `0.1.2` 发布 | ✅ | GitHub Release `v0.1.2`（ID `412862351`，tag → `e40bdfc`）；未认证 by-tag **200**；线上 `latest.yml` 与本地**逐字节一致**；安装包线上 `Content-Length: 112218832` 相符 |
| 四道门禁 | ✅ | test **599 项 0 失败**（shared 108 + api 233 + web 116 + desktop 142）、`lint` / `typecheck` / `format:check` **退出码全 0** |
| 步骤 0 清缓存 | ✅ | 原 `installer.exe`（`v0.1.1` 包）已移出备份；**验证后放回** —— 它是差分下载的「旧文件」 |
| 步骤 1 装新根 | ✅ 跳过 | 本机 `Root` / `TrustedPublisher` 各 2 条，新旧并存 |
| 🔴 步骤 2 探针 | ✅ **PASS** | `阶段=downloaded 版本=0.1.2` / `是否可安装=是` / 退出码 0；日志 **`Signature validated using only CN Fanhe Work.`** |
| 步骤 2′ / 3 / 4 真实路径 | ⏳ **待真人** | 需要「启动 → 下载 → 退出 → 重开 → 验 `FileVersion=0.1.2`」 |

🔴 **探针为什么用「本地验收台」而不是真源**：**从 agent 沙箱启动的 GUI 进程出网被拦**（直连 `ERR_CONNECTION_RESET`；把 `--proxy-server` 指向不存在的端口，错误**不变成** `ERR_PROXY_CONNECTION_FAILED` ⇒ 开关没被采纳）。做法是把安装目录的 `resources/app-update.yml` 临时改成 `provider: generic` + `http://127.0.0.1:8799/`（**保留 `publisherName`，所以发布者校验照旧生效**），用 `python -m http.server` 提供三个资产，**跑完立刻还原**（已与备份逐字节比对 `IDENTICAL`）。

⚠️ **本机系统代理其实是配好的**（`ProxyEnable=1`、`ProxyServer=127.0.0.1:7897`），而 **`HTTP_PROXY` / `HTTPS_PROXY` 对应用无效** —— `electronHttpExecutor` 走 `electron.net`（Chromium 网络栈），**Chromium 不读这两个环境变量**。所以**在正常终端里启动应用时应当能到达 GitHub**；沙箱只是 agent 侧的限制。**这一步请你自己启动应用来做。**

**关于差分下载（判据 6）**：本轮实测到 **计算正确** —— `Full: 109,588.7 KB, To download: 2,806.4 KB (3%)`；但**实际差分传输没走通**，两次回退各有原因，都不是产品缺陷：

| 回退原因 | 出处 |
| -- | -- |
| `Cannot download "…0.1.1.exe.blockmap", status 404` | 验收台最初只放了 `0.1.2` 三个资产，缺旧 blockmap |
| `Server doesn't support Accept-Ranges (response code 200)` | **本地 rig 的 `python -m http.server` 不支持 Range**；真实源实测支持（`206 Partial Content` + `Accept-Ranges: bytes`） |

**所以真实源上的差分下载仍未被端到端跑到**，但两侧的证据都在：计算正确 + 真实源支持 Range。**这一步会随步骤 2′ 一起被真人验证掉**（若日志里不再出现 `Cannot download differentially`，差分即生效）。

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

🔴 **先分清要装哪一个根 —— 2026-10-14 签名身份轮换之后，仓库里那个 `.cer` 已经不是本手册要用的了。**

本手册验的是 **v0.1.0 → v0.1.1**，这两个包都是**旧身份**签的：

| 身份 | 指纹 | 用在哪 | 公钥在哪 |
| -- | -- | -- | -- |
| **旧（本手册用这个）** | `0604B2381B8666C99F247DA7B576A4647601A5A3` | v0.1.0 / v0.1.1（本手册的 A 与 B） | `apps/desktop/scripts/fanhe-work-signing-public-retired-0604b238.cer`（**退役存档**） |
| 新（2026-10-14 轮换） | `095CB390A4CD0A64EF89B4364CC095A6A8A2A9BB` | 0.1.2 及以后 | `apps/desktop/scripts/fanhe-work-signing-public.cer`（当前身份） |

**`signing:trust` 装的是当前身份那一个**，所以本手册**不要用它** —— 它会装成新根，而 v0.1.1 是旧身份签的，装错根照样被判 `UnknownError`。**本步骤用 `certutil` 手工装退役的那一个。**

```powershell
# 装旧根（本手册需要的那一个）。必须用 certutil —— Import-Certificate 在非交互会话里
# 要弹根证书确认框，会报「此操作中不允许使用 UI」。
certutil -user -addstore -f Root "<路径>\fanhe-work-signing-public-retired-0604b238.cer"
certutil -user -addstore -f TrustedPublisher "<路径>\fanhe-work-signing-public-retired-0604b238.cer"

# 复查：期望 Root 与 TrustedPublisher 里各有一条 CN=Fanhe Work
(Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -eq 'CN=Fanhe Work' }) |
  Select-Object Thumbprint, NotAfter
```

**期望看到 `0604B2381B8666C99F247DA7B576A4647601A5A3`。** 若只看到 `095CB390…`，说明装错了那一个 —— 那是给 0.1.2 用的。

> **本机（打包机）现在两个根都有**（轮换时新根随 `signing:cert` 装进本机，旧根此前已装），所以**直接就能验**，不必再做这一步。这一步是给**另一台机器**准备的。

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

⚠️ **下表按路径 A（`0.1.0` → `0.1.1`）写。走路径 B（`0.1.1` → `0.1.2`）时，第 1 与第 4 条的期望值要换**：缓存长度 **112,218,832**、`FileVersion` **`0.1.2`**。其余各条不变。见第 0.6 节的对照表。

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
| 找不到「更新按钮」 | **只对 `v0.1.0` / `v0.1.1` 成立**（那两个包带的是旧前端产物）；**`0.1.2` 起有按钮** | 见第 0.5 节，走「退出再打开」 |
| 报 `net::ERR_CONNECTION_RESET` / `ERR_CONNECTION_TIMED_OUT` | **网络层，与签名无关**：到 GitHub 的连通性不通 | 先确认代理。🔴 **`HTTP_PROXY` / `HTTPS_PROXY` 对应用无效** —— 它走 `electron.net`（Chromium），**只认系统代理与 `--proxy-server`**。查 `HKCU:\…\Internet Settings` 的 `ProxyEnable` / `ProxyServer`；本机实测 `1` / `127.0.0.1:7897` |

## 五、做完之后要回填什么

1. `docs/T6-03-UPDATE-CHANNEL.md` §八.1 表格里第 4 条由 ⏳ 改为 ✅，并记下实际观察（尤其是差分是否生效）。
2. `docs/WORK-STATUS.md` §4.1 与头部「当前阶段」把这一项从「未闭环」移出。
3. `docs/DEVELOPMENT-PLAN.md` 头部「当前状态」与 `docs/PHASE-SUMMARY-2026-10-13.md` §4.1。
4. 若差分真的生效（不再出现回退整包），把「差分下载的正验」也一并标为已完成。
5. 把第 0.5 节那个缺陷记进待办 —— **`0.1.2` 已经修掉它**（产物含 `重启更新到`），剩下要记的是「已装 `0.1.0` / `0.1.1` 的机器仍无按钮」这一既成事实。
6. 🔴 **若走的是路径 B（`0.1.1` → `0.1.2`），还要回填两处**：
   - ✅ **`docs/SIGNING-ROTATION-RUNBOOK.md` §八第一条已改为已实测**（2026-10-14，探针 `阶段=downloaded 版本=0.1.2` + 日志 `Signature validated using only CN Fanhe Work.`）。
   - ✅ 同手册「执行记录」表已补本轮结果；「目标机装新根」一行已按「本机两个根并存」划掉。
7. ⏳ **只有做完步骤 2′/3/4（真人）之后**，下面三处才能动 —— **目前都还是 ⏳，别提前改**：
   - `docs/T6-03-UPDATE-CHANNEL.md` §八.1 第 4 条。
   - `docs/WORK-STATUS.md` §4.1 与头部「当前阶段」。
   - `docs/DEVELOPMENT-PLAN.md` 头部「当前状态」与 `docs/PHASE-SUMMARY-2026-10-13.md` §4.1。
