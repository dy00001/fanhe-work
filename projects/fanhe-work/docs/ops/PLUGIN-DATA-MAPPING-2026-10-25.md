# 插件数据接入工作台：展示映射与链路替换

> 2026-10-25。上游为 `collect-via-plugin.mjs` + `export-sycm-ingest.mjs`，下游为现有 `ops-ingest.v1` 与看板。
> 本文回答三件事：每条数据落在哪个区块、以什么形式展示、怎么查看；以及旧链路下线后哪些代码不再被调用。

## 一、结论

数据能推到前端，前端不用改一行代码就能显示，因为契约没动。但有两处缩水必须在评审时认下来：

1. **summary 只有 9 项，前端登记了 9 个位置，实际能填 4 个。** 前端 `OPS_SUMMARY_META` 只认 9 个键，我们的 9 项里 5 项是 KPI 用的键（`payAmount`、`payBuyers`、`visitors`、`payRate`、`orderValue`），不在这个网格里；能落进网格的只有 `stayTime`、`pv`、`cartByrCnt`、`payOldByrCnt` 四项。
2. **渠道、地域、搜索词、内容四块全空。** 前端已经写好了四个区块，没有数据就显示空态。

## 二、七个入口与区块结构

看板是单页应用，七个入口共用 `OpsDashboardPage`，靠 URL 参数区分：

```
/ops/<入口>?p=<区间>&shop=<店铺代号>
```

| 入口 | `view` | 区块顺序 | 数据来源 |
|---|---|---|---|
| 数据大屏 | `screen` | 店铺分段 → 五店合计 → 四指标折线 → 模块入口卡 | `shops[]` 与 `series` |
| 交易 | `trade` | KPI 六卡 → 支付金额折线 → 访客折线 → 逐日明细表 | `kpi`、`series`、`daily` |
| 商品 | `items` | 商品表 → 商品健康度待接入清单 | `dimensions.items` |
| 流量 | `flow` | 结构指标网格 → 渠道列表 → 地域 / 搜索词 / 内容三张排行 | `dimensions.summary`、`channels`、`areas`、`keywords`、`content` |
| 服务 | `service` | 六项待接入清单 | 无 |
| 推广 | `ads` | 三项待接入清单 | 无 |
| 内容 | `content` | 三项待接入清单 | 无 |

服务、推广、内容三个入口目前是纯占位，插件数据接进来也不会改变它们，因为对应数据本来就不在契约里。

## 三、逐项映射

### 3.1 逐日四项

| 契约字段 | 来源 | 展示位置 | 形式 |
|---|---|---|---|
| `payAmountFen` | `home-overview` 的 `payAmt` | 交易页 KPI 第一卡、逐日明细第一列、支付金额折线 | 金额，分转元显示 |
| `visitors` | `uv` | KPI 第三卡、逐日明细、访客折线 | 整数 |
| `payBuyers` | `payByrCnt` | KPI 第二卡、逐日明细 | 整数 |
| `itemVisitors` | **无来源** | KPI 第四卡、逐日明细 | 显示「—」 |

`itemVisitors` 是本次唯一的逐日缺口。`home-overview` 走 `/portal/` 系列接口，不返回 `itmUv`。补法是从 `/flow/monitor/overview/overview.json` 取，一条裸探测。

### 3.2 summary 十三项

前端 `OPS_SUMMARY_META` 登记了 9 个键，只渲染登记过的，未登记的静默跳过。所以「上报了几项」与「页面显示几项」不是一回事。

| 前端登记的键 | 中文 | 我们的数据 | 说明 |
|---|---|---|---|
| `bounceRate` | 跳失率 | 缺 | 需 `overview.json` |
| `stayTime` | 平均停留时长 | 有 | `stayTime`，秒 |
| `pv` | 浏览量 | 有 | `pv` |
| `cartByrCnt` | 加购人数 | 有 | `cartByrCnt` |
| `itmAvgPv` | 商品人均浏览量 | 缺 | 需 `overview.json` |
| `newPayByrCnt` | 新买家 | 缺 | 需 `overview.json` |
| `payOldByrCnt` | 老买家 | 有 | `payOldByrCnt` |
| `flowRecommendUv` | 推荐渠道访客 | 缺 | 原 CDP 方案也没有，长期缺口 |
| `flowSearchUv` | 搜索渠道访客 | 缺 | 同上 |

能显示的 4 项落在流量页的「结构指标」网格里，每格是「标签 + 数值 + 口径提示」，鼠标悬停看 `hint` 文案。

`payAmount`、`payBuyers`、`visitors`、`payRate`、`orderValue` 这 5 项虽然上报了 summary，但前端网格不认，它们的作用是给 KPI 卡提供整段口径值。

### 3.3 商品维度六字段

| 契约字段 | 来源 | 展示位置 | 形式 |
|---|---|---|---|
| `visitors` | `itmUv` | 商品表第一列 | 整数，右对齐 |
| `payBuyers` | `payByrCnt` | 第二列 | 整数 |
| `payRate` | `payRate` | 第三列 | 百分比 |
| `payAmountFen` | `payAmt` | 第四列 | 金额 |
| `cartFen` | `crtAmt` | 第五列 | 金额 |
| `favorites` | `itemCltByrCnt` | 不进表 | 仅存库，前端暂不展示 |

商品表的查看逻辑：

- **排序**：点表头五列任一列切换升降序，默认按支付金额降序。
- **金额列按权限隐藏**：没有 `ops.finance.read` 时，支付金额与加购金额两列不渲染，不是显示零。
- **行数**：接口侧按 `OPS_LIMITS.DIMENSION_TOP` 截前 100，插件侧 `--limit 20`，实际入库取两者较小值。
- **点击行不跳转**：当前没有商品详情页，表格是终点。

### 3.4 渠道、地域、搜索词、内容

四块都在流量页，都是纯展示，没有筛选和跳转。

| 区块 | 数据 | 形式 |
|---|---|---|
| 渠道列表 | `channel` 维度，`visitors`、`payBuyers`、`payRate`、`payAmountFen` | 每行「名称 + 访客数 + 占比条」 |
| 地域分布 | `area` 维度，`visitors`、`ratio` | 排行条，按 `ratio` 显示占比 |
| 搜索词 | `keyword` 维度，`visitors` | 排行条 |
| 内容来源 | `content` 维度，`visitors` | 排行条 |

这四块本次全空。补法见第七节。

### 3.5 KPI 卡的口径切换

六张卡（支付金额、支付买家、访客数、商品访客、支付转化率、客单价）有两条取值路径，由「查询区间是否恰好等于某个快照窗口」决定：

- 相等时用 `summary` 里的整段值，卡片副标题写「整段去重口径，环比取自平台上一等长周期」。
- 不相等时退回逐日求和，副标题写「逐日求和平滑到区间，跨日重复访客会重复计入」。

插件每天只报一天，所以只要查询区间是单日且那天有快照，就走整段口径。查 7 天、30 天时会退回逐日求和。

这条规则前端不判断，由 `apps/api/src/ops/query.ts` 的 `usePeriod` 决定，接插件数据不需要改。

## 四、跳转与筛选关系

看板没有页面级路由跳转，全部状态都压在 URL 上：

| 动作 | 改什么 | 影响范围 |
|---|---|---|
| 点侧栏七个入口 | 路径 `/ops/<入口>` | 换 `view`，重新拉数据 |
| 点店铺分段 | `shop` 参数 | 换店铺，KPI 与各维度全部重取 |
| 点时间条 | `p` 参数或 `from`/`to` | 换区间，`daily` 重新求和 |
| 大屏点模块入口卡 | 路径跳转到对应入口 | 带上当前 `shop` 与 `p` |

刷新与分享都能复现同一屏，因为状态全在地址栏。接插件数据后这套机制不变。

## 五、三店真实数据的覆盖度

用 2026-10-24 的实际采集结果跑 `export-sycm-ingest.mjs`，产出：

| 店铺 | 代号 | daily | item | summary |
|---|---|---|---|---|
| 梵禾 | `fanhe-main` | 1 行 | 5 行 | 9 项 |
| 简作 | `s3` | 1 行 | 0 行 | 9 项 |
| 雅素 | `s2` | 0 行 | 0 行 | 0 项 |

雅素全空是因为采集时插件断连，不是映射问题。简作缺 item 是因为 `item-list` 没跑成。

梵禾这一份可以完整演示：交易页 KPI 四卡里三卡有数、商品页五列全有、流量页结构指标四格有数、渠道与地域搜索词四块空。

## 六、链路替换

### 6.1 新增

| 文件 | 职责 |
|---|---|
| `tools/collector/scripts/collect-via-plugin.mjs` | 调 sycm-cli 取数，落盘到 `data/plugin/<代号>/<日期>/` |
| `tools/collector/scripts/export-sycm-ingest.mjs` | 命令输出转 `ops-ingest.v1`，写 `data/payload/<日期>/<代号>.json` |

两个脚本共用一份 49 条命令的序号表，序号必须一致，否则适配器读不到对应文件。

### 6.2 改造

| 对象 | 改动 |
|---|---|
| `run-daily.ps1` | 采集段从 `collect-daily.mjs` 换成 `collect-via-plugin.mjs`，导出段从 `export-daily-ingest.mjs` 换成 `export-sycm-ingest.mjs` |
| `sync-shops.mjs` | 保留轮询与失败分类骨架，把「跑 collect-daily + export-daily-ingest」换成「跑 collect-via-plugin + export-sycm-ingest」 |
| `doctor.mjs` | 检查项从「Edge 端口通不通」换成「插件在线、CLI 可执行、登录态有效」 |

### 6.3 下线

以下文件不再被任何脚本调用。**不删除，移入 `tools/collector/legacy/`**，保留 git 历史与现场参照。

| 文件 | 行数 | 下线理由 |
|---|---|---|
| `collect-daily.mjs` | 525 | CDP 旁路录制，被插件替代 |
| `export-daily-ingest.mjs` | 649 | 17 页原始响应解析，被 `export-sycm-ingest.mjs` 替代 |
| `shop-login.ps1` | 待查 | 不再需要每店独立 profile |
| `shop-cookie-export.ps1`、`shop-cookie-inject.mjs` | 146 + 211 | cookie 迁移工具，随 profile 一起退场 |
| `run-all-shops.ps1` | 待查 | 四店并行的起停编排，插件方案改为串行 |
| `install-sync-task.ps1` | 待查 | 计划任务改为代理调度后重写 |
| `cdp-links.mjs`、`cdp-peek.mjs`、`probe-page.mjs`、`probe.mjs`、`shot.mjs` | 待查 | CDP 调试工具 |

### 6.4 保留

- `ops-ingest.v1` 契约与 `ingestOpsSnapshot`
- `apps/api` 的 `/api/ops/ingest`、`/shops/pending`、`/shops/:code/state`、`/shops/:code/sync`
- 前端全部组件与 `ops-display.ts` 的格式化规则
- `shops.config.json` 的 `code` 与 `name`（这是店铺身份唯一来源）
- `data/daily/` 与 `data/csv30/` 的历史目录，`rawPath` 指向它们，删了没法对账

## 七、缺口补齐顺序

| 阶段 | 补什么 | 补完能点亮什么 |
|---|---|---|
| P1 | `overview.json` 一条裸探测 | 逐日 `itemVisitors`、summary 补到 13 项、结构指标从 4 格变 7 格 |
| P2 | `tree_platform_support` | 流量页渠道列表 |
| P3 | `listAreas` | 流量页地域分布 |
| P4 | `drainageSearch` | 流量页搜索词 |

P1 完成前不要开自动上报，理由见 `PLUGIN-COLLECTOR-PLAN-2026-10-25.md` 第七节：summary 上报几项就把同窗口清到几项。

## 八、验证清单

端到端验证需要三个前提：插件在线、Docker 里数据库在跑、API 与 web 已启动。

1. `node scripts/collect-via-plugin.mjs --date 2026-10-24 --account 梵禾`，确认落盘文件数 49。
2. `node scripts/export-sycm-ingest.mjs --date 2026-10-24 --account 梵禾`，确认 daily 1 行、item 5 行、summary 9 项。
3. `pnpm db:ops-import` 导入 payload，确认 `ecom_collect_runs` 新增一行。
4. 打开看板 `/ops/trade?p=1d&shop=fanhe-main`，确认 KPI 三卡有数、逐日明细一行、商品页五行。
5. 打开 `/ops/flow?p=1d&shop=fanhe-main`，确认结构指标四格有数、渠道与地域搜索词四块空态。
6. 重跑第 3 步，确认 `revised` 为 0、行数不翻倍。

第 6 步是幂等验证，缺了它不能算通过。
