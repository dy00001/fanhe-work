# 版本迭代方案 `0.1.5`

本版三件事：修侧栏折叠态的图标对齐，把首页「一键启动」从「启动选中一条」改成「启动全部已配置」，并在启动 QQ / 千牛后自动填写本机已保存的账号密码。

## 一、侧栏折叠态图标对齐

- 折叠态一级导航图标改用与分组、底部工具图标相同的居中布局，共用侧栏水平中线。
- Tooltip 由外层容器承接，保留 React Router `NavLink` 的 `className` 回调，避免 Radix Slot 把回调写成 DOM class 文本。
- Electron 运行时实测三项一级导航与分组图标中心均为 x=35.5px，侧栏宽 72px。

## 二、一键启动改为批量

- 首页主卡的大按钮从「启动当前选中（或首个）实例」改为「启动全部已配置实例」；托盘里每枚图标上的小火箭仍可单独启动该一条。
- 批量结果按成功 / 失败汇总，失败项带出具体软件名与原因，不再只给一句「启动失败」。
- 桌面态走 `window.fanheDesktop.runLaunchProfiles` 单次桥调用，浏览器态回落为逐条请求后聚合。
- 启动进行中禁用单条火箭按钮，避免重复触发同一条配置。

## 三、启动后自动填写账号密码（P1 续）

- 新增 `fillLoginFieldsAfterLaunch`：在目标进程自己的登录窗里定位账号框、密码框并提交，覆盖 QQ 与千牛。
- 凭据由主进程凭据库解密后**经子进程 stdin** 送入 PowerShell，不进命令行、不进临时文件、不进日志，也不经 IPC 回传渲染进程。
- 输入前有两道门：窗口宽高比必须与目标软件登录页相符（偏差超过 0.18 即放弃），目标窗口必须确实在前台（否则整段停止，避免把密码敲进别的窗口）。
- 脚本正文被抽成 `buildFillLoginScript` 以便单测钉住：凭据只从 stdin 读、比值门在第一次输入之前、前台校验在第一次点击之前、不使用 PowerShell 7 专有语法。
- 本机加密存储不可用或该配置没有保存凭据时，跳过填写并记一条日志，不阻塞启动。

## 四、标题栏使用专用图标

- 新增 `apps/web/public/brand/window-icon.ico`（多尺寸），仅用于窗口标题栏；任务栏与托盘继续用 `app-icon.png`。
- 标题栏只有约 16px，完整印章缩到那个尺寸会糊成一团，因此标题栏改用一个简化的字母标记。

## 五、启动器的控制台窗口显隐

- `windowsHide` 从一律 `false` 改为按目标类型分（`needsHiddenConsole`）：`.exe` 不隐藏（隐藏启动标记会让部分 GUI 客户端把主窗口一起藏起来，而 `spawn` 仍报成功），`.cmd` / `.bat` / 脚本隐藏（否则闪一个黑框）。
- 这条同时守住 0.1.4 之前的行为，避免「修好 GUI 被藏」又换回「脚本闪黑框」。

## 六、版本与发布

- 仓库根版本 `0.1.5`，`apps/desktop/package.json` 由 `sync-version.mjs` 同步。
- 发版顺序：提版本号 → `pnpm --filter @fanhe/web build` → `pnpm --filter @fanhe/desktop dist`。
- 发布目标：GitHub Release `v0.1.5`，三资产（exe / blockmap / latest.yml）。
- 发布前跑四道门禁与 `verify:sign` + `verify:pack`，发布后核对未认证 by-tag 200、线上 `latest.yml` 与本地逐字节一致、线上 exe 的 sha512 与 `latest.yml` 声明一致。
