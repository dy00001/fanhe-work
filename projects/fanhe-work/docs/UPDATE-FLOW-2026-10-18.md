# 更新流程：四步与四道缺口

> 2026-10-18 实施。范围：从「发现新版」到「重启完成更新」的整条链路。关联 `apps/desktop/src/main.ts`（通道与 IPC）、`apps/desktop/src/update.ts`（状态机）、`apps/web/src/lib/desktop-update.ts`（视图）、`apps/web/src/lib/use-desktop-update.ts`（轮询与动作）、`apps/web/src/components/UpdateNotice.tsx`（渲染）。

## 一、要求的四步

1. 检测到新版本时，右上角显示小红点。
2. 用户点击后开始下载并拉取更新文件。
3. 下载完成后静默处理，并提示用户更新。
4. 用户确认后自动完成更新并重启应用。

## 二、改动前的实现与差异

改动前的通道是「查到了就直接下」，四步里有两步对不上、两步缺界面。

| 步骤 | 改动前 | 判定 |
| --- | --- | --- |
| ① 红点 | 无红点。`available` 与 `downloading` 在视图层被合并，渲染成一条「正在下载 v0.1.5…」的灰底窄条 | **缺** |
| ② 点击才开始下 | `autoUpdater.autoDownload = true`，主进程启动查一次就自己开下。用户点之前包已在下载，甚至可能已经下完 | **相反** |
| ③ 静默处理 + 提示 | `update-downloaded` → `ready` 态，顶栏出现「重启更新到 v0.1.5」 | 已满足 |
| ④ 确认后更新 | `ready` 按钮的 `onClick` 直接调 `installUpdate` → `quitAndInstall`。**没有确认这一步** | **缺** |

第 ② 步的问题最要紧，因为它让第 ① 步无从存在：既然检测到就已经在下了，「等你点」这个状态在状态机里根本没有位置，视图层只能把它塞进 `downloading`。所以三处缺口不是三个独立的小修，是同一件事的三个断面。

另外两处顺带确认（原本就是对的，本次未动）：

- `autoInstallOnAppQuit = true`：用户点「稍后」之后正常退出应用，下次启动即是新版。这条让「稍后」不是「永不」。
- 安装走 NSIS，不动 `userData`，端口被钉住 —— 「本地设置与数据都保留」这句承诺成立的前提。

## 三、改了什么

### 主进程（`main.ts`）

- `autoDownload` 由 `true` 改为 `false`。原注释给的理由是「用户点重启更新时不该再等一次下载」，代价是**检测到新版就开始吃带宽**，而用户可能正在开会、正在跑别的下载、或者根本不想现在更新 —— 他连一个「稍后」都没得选。
- 新增 `update:download` IPC。两个决定：
  - **不等下载结束就返回。** 一次 112 MB 要几十秒到几分钟，让 IPC 挂在那里会让渲染进程的 `await` 悬上几分钟，中间任何一次组件卸载都变成泄漏。进度走 `update:status` 轮询，这里只负责「踢一脚」。
  - **只在 `available` / `error` 两态接受。** 已下完再下是浪费；`idle` 时下载说明上游还没告诉我们有哪一版，那时 `downloadUpdate()` 会抛「Please check update first」。

### 桥接（`preload.ts` / `vite-env.d.ts`）

新增 `downloadUpdate()`。至此检查、下载、安装三件事各自一个入口，`checkForUpdates` 的注释同步改成「只检查，不下载、不安装」。

### 视图（`desktop-update.ts`）

`available` 从 `downloading` 里拆出来，成为独立一态：`dot: true`、`actionLabel: '立即更新'`、**没有 `percent`**。

给 `0%` 的进度条会让人以为已经在下。`ready` 也补上 `dot: true` —— 两态都是「有件事等你做」，红点由视图声明，组件不猜。

### 轮询与动作（`use-desktop-update.ts`）

新增 `download()`，`act()` 按形态分派（`available` → 下载、`ready` → 安装、`failed` → 重查）。`busy` 复用原有那个：主进程不等下载完就返回，所以点击后仍会拿到 `available`，真正的 `downloading` 要等第一次进度事件；中间这一小段靠 `busy` 兜住（按钮置灰、文案「正在开始…」），否则用户会以为没点上而连点几次。

### 渲染（`UpdateNotice.tsx`）

- `UnreadDot`：`pointer-events-none`（点在红点上要等于点在按钮上，否则按钮会「点不中」）+ `ring-2 ring-background`（顶栏背景是浅色，没有 ring 的红点贴在边框上会糊成一团）。
- `available`：`outline` 按钮（不是主色 —— 它还不是「现在必须做」的事），红点挂在 `relative` 外壳上。
- `ready`：点按钮先开 `Dialog`（「稍后」/「立即重启更新」），不再直接退出。直接退出会让正在填的表单、正在跑的输入丢掉，而用户只是想看看有什么更新。

## 四、为什么红点不能只靠 `available` 一个状态

用户离开工位一小时回来，顶栏上唯一能看出「有事发生」的线索就是那一点。所以它挂的判据是「**有待办动作**」，不是「有新版」：

- `available`（等你点下载）→ 有
- `ready`（等你确认重启）→ 有
- `downloading`（正在下，无可做之事）→ 无
- `failed` → 无（重试是兜底，不是待办；一直红着会变成噪音）

`downloading` 不挂红点这条也写进了用例，因为它是三者里最容易被「顺手都加上」破坏的一条。

## 五、验证

- 视图 225 项（web 全量，含新增断言）：`available` 是「等你点」而不是「正在下」（带红点、可点、无进度）、`ready` 也带红点、`downloading` 不带红点。
- 主进程 287 项、api 241 项（5 项数据库不可达跳过）、shared 108 项，全过。
- `typecheck` / `lint` / `format:check` 全绿。
- **未覆盖**：真实一次「发现 → 点击 → 下载 → 确认 → 重启」的端到端外观。它需要先发一版 0.1.6，再在装有 0.1.5 的机器上升级才能看到 —— 面板与红点的最终形态要等那一步。
