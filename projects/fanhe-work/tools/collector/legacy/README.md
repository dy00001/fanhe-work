# legacy：CDP 采集链路（2026-10-26 下线）

这里存放的是旧采集链路的全部脚本。它们不再被任何流程调用，保留是为了两件事：查历史问题的现场，以及万一新链路出问题时有一个明确的回退参照。

## 为什么下线

旧链路的做法是「Edge 每店独立 profile + CDP 旁路录制 17 个页面」，每页等 60 秒，单店 17 到 25 分钟，还要处理调试端口、profile 绑定、cookie 迁移。新链路改用浏览器插件取数，单条命令 2 到 10 秒，单店 52 条命令约 7 分钟。

更关键的是覆盖面的差别：插件链路能拿到客服对话正文（`fetch-recent`）和单品下钻的十几项指标，旧链路完全没有这部分。

## 文件清单

| 文件 | 原职责 |
|---|---|
| `collect-daily.mjs` | CDP 旁路录制，单店单日 17 页 |
| `export-daily-ingest.mjs` | 把 17 页原始响应转成 `ops-ingest.v1` |
| `run-pipeline.ps1` | 分步编排：采集 → 导出 → 入库 |
| `run-all-shops.ps1` | 四店并行的起停编排 |
| `shop-login.ps1` | 引导每店独立 profile 首次登录 |
| `shop-cookie-export.ps1`、`shop-cookie-inject.mjs` | 登录态在 profile 之间迁移 |
| `install-sync-task.ps1` | 注册 Windows 计划任务 |
| `cdp-links.mjs`、`cdp-peek.mjs`、`probe.mjs`、`probe-page.mjs`、`shot.mjs` | CDP 调试与截图 |

## 替代关系

| 旧 | 新 |
|---|---|
| `collect-daily.mjs` | `scripts/collect-via-plugin.mjs` |
| `export-daily-ingest.mjs` | `scripts/export-sycm-ingest.mjs` |
| `run-pipeline.ps1` | `scripts/run-plugin-daily.ps1` |
| `run-daily.ps1`（默认行为） | 转调 `run-plugin-daily.ps1` |
| `install-sync-task.ps1` | 待重做（计划任务改为代理自调度） |

## 保留未动的部分

- `scripts/check_daily.mjs`、`check_data.mjs`、`verify-daily.mjs`：读的是 `data/daily/` 下的历史响应，用于核对旧数据，与新链路无冲突。
- `data/daily/`、`data/csv30/`：历史原始数据。契约的 `rawPath` 指向它们，删了没法对账。
- `scripts/sync-shops.mjs`：已改造，现在调 `collect-via-plugin.mjs`，不再是旧链路。

## 如果要回退

`run-daily.ps1` 的 `-Script` 参数还在，显式传 `-Script collect-daily.mjs` 会走旧分支。但需要先把本目录的文件搬回 `scripts/`，并且重新装回 Edge 的每店 profile 与调试端口。回退成本不低，只在确认新链路不可用时才做。
