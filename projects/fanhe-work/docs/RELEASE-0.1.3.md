# 版本迭代方案 `0.1.3`

> 合并三类改动，统一发 `0.1.3`：
> 1. **菜单版本号陈旧**（9.63 已完成，本次一并发）—— 界面显示已装 exe 的真实版本。
> 2. **侧边栏收起态图标对齐**（本版新增）—— 收起时所有图标沿同一条垂直中轴线居中。
> 3. **最小化/关闭 → 系统托盘常驻**（本版新增）—— 关窗口不再等于退出，仅托盘右键「退出」才真正关闭。
>
> 配套计划条目：`DEVELOPMENT-PLAN.md` 9.63（版本号修复）、9.64（本迭代）；`WORK-STATUS.md` 4.1.19、4.1.20。

---

## 一、三项改动总览

| # | 问题 | 落点 | 改动性质 | 是否阻塞发布 |
| -- | -- | -- | -- | -- |
| ① | 装了 `0.1.2` 菜单却显示 `0.1.1` | 外壳 + 预加载 + 前端 `version.ts` | 纵深修复（闸门已在 9.62 就位） | 否（已闭环） |
| ② | 侧栏收起态图标没对齐 | 前端 `Sidebar.tsx` | 纯样式对齐 | 否 |
| ③ | 关/最小化直接退出 | 外壳 `main.ts` | 交互行为 | 否 |

---

## 二、② 侧边栏收起态图标对齐

### 修改思路

侧栏收起时是 72px 窄条，结构分三段：品牌行（72px）、导航 `nav`、底部图标行。逐段核对收起态的对齐前提（**占满整宽 `w-full` + 内容 `justify-center`/`place-items-center`**）后发现：

- 品牌行：收起态 `px-0` + `justify-center` ✅ 占满整宽、居中。
- 底部行：收起态 `px-0` + `flex-col items-center` ✅ 占满整宽、居中。
- **导航 `nav`：收起态仍带 `px-3` 左右内边距** ❌ —— 导航项的 hover/active 高亮带比品牌/底部窄一圈，视觉重心因此左移、与其他段不在同一条中轴线上。图标本身虽也 `justify-center`，但容器被内边距收窄，整段的视觉锚点偏了。

修法：**收起态去掉 `nav` 的左右内边距（`px-0`），与品牌行、底部行一致**；展开态保留 `px-3`（内容需要左右留白）。这样每一行在收起态都占满 72px，图标沿同一条垂直中轴线居中，hover/active 高亮带也变成全宽一条，整条侧栏读起来是一个整齐的列。图标尺寸、字号一律不动。

### 关键代码片段（`apps/web/src/components/Sidebar.tsx`）

```tsx
<nav
  className={cn(
    'flex flex-1 flex-col gap-3 pb-3',
    // 折叠态：去掉左右内边距，让每一行都占满 72px 宽、图标沿同一条垂直中轴线居中，
    // 与品牌行（px-0）、底部行（px-0）保持一致，hover/active 高亮也变成全宽一条。
    // 展开态保留 px-3：内容需要左右留白。
    // 折叠态的子项浮层要溢出侧栏，`nav` 的裁剪必须放行，否则浮层被直接切掉。
    collapsed ? 'px-0 overflow-visible' : 'px-3 overflow-x-hidden overflow-y-auto',
  )}
>
```

### 测试要点

- 门禁：`pnpm --filter @fanhe/web test` 全绿（侧栏结构相关用例不退化）；`pnpm lint` / `format:check` 通过。
- 手测（真机或浏览器 e2e）：收起侧栏后，品牌 logo、各导航项图标、分组图标、底部外观三档 / 系统设置 / 通知图标，**都落在同一条垂直中轴线上**；hover 任一项时高亮带为全宽、与其它段等高齐平，不再出现「窄一圈」。

---

## 三、③ 最小化/关闭 → 系统托盘常驻

### 修改思路

原行为：`BrowserWindow` 默认「点 X 销毁窗口、触发退出」「点最小化停在任务栏」。改为**常驻托盘后台**：

- 新增 `Tray`，图标复用前端产物里的品牌 logo（`DIST_ROOT/brand/logo.png`，开发态 `apps/web/dist/brand/logo.png`、打包态 `resources/web/brand/logo.png`）。与任务栏图标同枚，不新增二进制资源。
- 左键点击托盘图标 → `showMainWindow()`（恢复并聚焦）。
- 右键托盘 → 菜单：显示窗口 / 退出。
- 窗口 `close` 事件：若不是「真正退出」，则 `preventDefault()` + `window.hide()`，进程继续后台运行。
- 窗口 `minimize` 事件：`window.hide()`，任务栏只留托盘图标一个入口。
- 「真正退出」只来自两条路径，二者都先置 `isQuitting = true`：
  1. 托盘菜单「退出」；
  2. 更新安装 `autoUpdater.quitAndInstall()`（否则窗口 `close` 拦截会把它当成「藏到托盘」而拦下，更新装不上）。
- 另在 `app.on('before-quit')` 统一置 `isQuitting = true`，覆盖系统注销等其它退出路径。
- `app.on('window-all-closed')` 改为**空实现**：常驻托盘的应用窗口「全部关闭」实为隐藏，不应再自动退出；真正的退出不会走到这里再被拦。
- `app.on('activate')`（macOS）改写：若主窗口只是藏在托盘里，直接 `showMainWindow()` 而非新建。
- 冒烟/探针模式**不建托盘**：`new Tray` 在无显示沙箱里会抛，且验收不关心托盘。

⚠️ 已知限制：托盘图标沿用非方形、无透明通道的 logo，托盘里会带底色；换一枚方形带 alpha 的 `.ico` 即可（改动只在 `electron-builder.yml` 的 `win.icon` 一行，不影响此处逻辑）。

### 关键代码片段（`apps/desktop/src/main.ts`）

```ts
// 模块级状态
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false

// 在 buildWindow 内，return 之前挂两件事
window.on('close', (event) => {
  if (!isQuitting) {
    event.preventDefault()
    window.hide()
  }
})
window.on('minimize', () => {
  window.hide()
})

// 窗口不存在时新建；存在（藏在托盘）时直接恢复
function showMainWindow(): void {
  if (mainWindow === null) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  const iconPath = join(DIST_ROOT, 'brand', 'logo.png')
  let image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) image = nativeImage.createEmpty()
  else image = image.resize({ width: 16 })
  tray = new Tray(image)
  tray.setToolTip('梵禾 Work')
  tray.on('click', () => showMainWindow())
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示窗口', click: () => showMainWindow() },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit() } },
    ]),
  )
}

// bootstrap 内，窗口建好之后
const window = buildWindow(true)
mainWindow = window
await window.loadURL(`${shellOrigin}/`)
createTray()

// 更新安装：先置位，否则会被 close 拦截拦成「藏到托盘」
isQuitting = true
autoUpdater.quitAndInstall()

// 统一退出钩子 + 窗口全关空实现
app.on('before-quit', () => { isQuitting = true })
app.on('window-all-closed', () => { /* 空：进程靠托盘维持，不在此退出 */ })
```

> 导入需追加：`import { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, shell } from 'electron'`。

### 测试要点

- 门禁：`pnpm --filter @fanhe/desktop typecheck` / `test` / `smoke` 全绿（托盘在冒烟模式不建，不影响 `渲染元素=1 预加载桥=有 console错误=0`）。
- 手测清单（需在装好的客户端真机验证，自动化替代不了）：
  1. 点**最小化** → 窗口消失、任务栏无按钮、托盘出现图标；
  2. 点**关闭（X）** → 同上，进程仍在（任务管理器可见其 `梵禾 Work.exe`）；
  3. **左键**托盘图标 → 窗口恢复并聚焦；
  4. **右键**托盘图标 → 弹出「显示窗口」「退出」；
  5. 仅点**「退出」** → 进程真正结束（托盘图标消失、进程退出）；
  6. 更新下载完成后点安装 → 进程退出并完成安装（`isQuitting` 已置位，不被 `close` 拦截拦下）。

---

## 四、① 菜单版本号陈旧（9.63 已闭环，本次一并发）

- **现象**：装了 `0.1.2`，菜单那行却显示 `v0.1.1 · 2026-10-14 · dd4e9e6`。装进去的确实是 `0.1.2`（注册表 `DisplayVersion` 与 exe `FileVersion` 双判据），错的是界面那行字。
- **根因**：版本号是 Vite **构建期**从仓库根 `package.json` 文本替换进产物；那次构建排在版本号提升之前，包里烧着旧号。
- **修法（纵深，不替代 9.62 的构建闸门）**：界面「本机是哪一版」改读运行期 `app.getVersion()`（主进程 `ipcMain.on('app:version')` → 预加载 `ipcRenderer.sendSync('app:version')` → `window.fanheDesktop.appVersion`）。
  - 🔴 第一版走 `webPreferences.additionalArguments` 传参、预加载 `require` 本地模块，**被冒烟当场拦下**（沙箱化预加载不能 `require` 本地模块，整条桥消失），后改 IPC 方案。
  - `use-version-check.ts` 的本机清单 `version` 同步改用 `resolveAppVersion()`，否则壳里产物陈旧时会**假提示有更新**。
- **配套机械闸门**：`scripts/check-web-build.mjs`（打包前前置闸，产物自报版本 == 仓库根版本）、`verify-pack.mjs`「二·补二」。

---

## 五、发布顺序（沿用 T6-03a 纪律）

1. 改仓库根 `package.json` 版本为 `0.1.3` 并提交（桌面端 `apps/desktop/package.json` 由 `sync-version.mjs` 在打包时同步，勿手改）。
2. `pnpm --filter @fanhe/web build` —— **先构建前端**，产物烧入 `0.1.3`。
3. `pnpm --filter @fanhe/desktop dist` —— 先过 `check:web` 闸门（不符即拒绝），再过 `verify:pack`。
4. 签名（打包机跑 `signing:cert`）+ 发布 GitHub Release 草稿 → 置公开。
5. 真机收尾：在已装 `v0.1.1`/`v0.1.2` 的机器上验证 ③ 的托盘手测清单与更新通道（见 §三测试要点第 6 条）。

> ⚠️ 版本号顺序铁律：**先定版本号（改仓库根）→ 再构建前端 → 最后 `dist`**。反了会导致包里烧着旧版本号（`v0.1.2` 即因此）。判据是「产物自报版本 == 仓库根版本」，由 `check:web` 机械保证。
