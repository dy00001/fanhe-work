# 版本迭代方案 `0.1.5`

本版修复侧边栏折叠态一级导航图标偏左的问题。

## 改动

- 折叠态一级导航图标与分组、底部工具图标共用侧栏水平中线。
- Tooltip 由外层容器承接，保留 React Router `NavLink` 的 `className` 回调，避免 Radix Slot 把回调写成 DOM class 文本。
- Electron 运行时实测三项一级导航与分组图标中心均为 x=35.5px，侧栏宽 72px。

## 版本与发布

- 仓库根版本：`0.1.5`。
- `apps/desktop/package.json` 由 `sync-version.mjs` 与根版本同步。
- 发布目标：GitHub Release `v0.1.5`，安装包资产由 Electron Builder 生成。
- 正式发布前重跑四道门禁、构建安装包、验证签名与 `latest.yml`，并确认 Release 草稿三项资产完整。
