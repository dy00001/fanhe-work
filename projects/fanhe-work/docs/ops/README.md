# 运营数据看板（ops）· 模块说明

> 版本：v1，2026-10-20
> 对应导航：运维信息平台 › 数据看板（`/ops/dashboard`）
> 对应代码：`apps/api/src/ops`、`apps/api/src/routes/ops.ts`、`apps/web/src/components/ops`、`apps/web/src/pages/OpsDashboardPage.tsx`、`tools/collector`

---

## 一、这个模块是什么

把淘宝 / 天猫店铺在千牛与生意参谋后台的经营数据，变成梵禾 Work 里一个可以点、可以问「这个数哪来的」的页面。

它由三段组成，三段之间只有一处交接点：

```
① 采集端  tools/collector        跑在有千牛登录态的 Windows 上，产出契约 JSON
        │                         （CDP 旁路录制，不进任何构建产物）
        ▼   ops-ingest.v1
② 服务端  apps/api/src/ops       校验收货 → 落 ecom_* 四张表 → 按权限出读模型
        │                         （写入两条路：POST /api/ops/ingest 与 db:ops-import）
        ▼   GET /api/ops/dashboard
③ 前端    apps/web/.../ops       URL 承载状态 → 指标卡 / 趋势 / 维度表 / 待接入清单
```

**三个边界，越界就出问题：**

| 边界 | 规则 | 越界的后果 |
| --- | --- | --- |
| 采集端 ↔ 服务端 | 只传契约 JSON，采集端不碰数据库、不认 Prisma | 两套清洗规则分叉，「回填的数」与「每天采的数」在去重与 `revised` 上不一致 |
| 服务端 ↔ 前端 | 单位换算（分 → 元）只在 `lib/ops-display.ts` 发生一次 | 某一张卡差 100 倍，而且只有那一张看得出来 |
| 口径 ↔ 界面 | 每个指标带档位（逐日 / 推算 / 整段），界面必须显示 | 用户把整段值当区间值读，切区间时数字不动却没人解释 |

---

## 二、这次接入做了什么（以及没做什么）

**做了：**

1. 采集器与 30 天基线数据整目录迁入 `tools/collector`（含 67 张 CSV、20 个脚本、10 份口径文档、原型页面）。
2. 数据模型落地：`ecom_shops` / `ecom_daily_metrics` / `ecom_dimension_snapshots` / `ecom_collect_runs` 四张表，一条迁移（`20261020135517_add_ops_metrics`）。
3. 入库两条路：日常走 `POST /api/ops/ingest`（回环 + 共享密钥），历史回填走 `pnpm db:ops-import`（共用同一个写入函数）。
4. 读接口：`GET /api/ops/dashboard`（含指标卡、逐日序列、五组维度、新鲜度）、`GET /api/ops/health`（采集批次）、`GET /api/ops/shops`。
5. 前端页面：七个视图（总览 / 交易 / 商品 / 流量 / 服务 / 推广 / 内容），状态全部写进地址栏；没有真实数据的三个板块显示「缺哪几个数、卡在哪一批」。
6. 权限：新增 `ops` 模块与三个权限点，金额与页面准入分离。
7. 30 天基线已入库并通过四个金额锚点核对（支付金额 ¥108,000、逐日求和、商品金额相加三条路径一致）。

**没做（明确的欠账，不要误以为已具备）：**

| 缺的东西 | 现状 | 归属 |
| --- | --- | --- |
| 服务 / 推广 / 内容三个板块的数据 | 页面显示待接入清单，无演示数字 | B / C / D / E 批采集 |
| 分店 2 至 5 | 表结构已留 `shop_id`，数据为空 | F 批，需 4 套授权 |
| 商品健康（违规、评分、素材） | 同上 | C 批 |
| 导出 CSV、手动触发采集 | 未实现（权限点也未加） | 后续 |
| 单品下钻抽屉 | 未实现，商品表可排序不可下钻 | 后续 |
| 图表库 | 未引入，趋势图是手写柱状 | 有意为之，见下 |

关于图表：**不引 Recharts 是有意的**。当前只需要「一天一根柱 + 悬停读数」，引入 100KB 依赖会同时带进第二套主题系统，与「令牌唯一来源」冲突。什么时候该引：需要双轴叠加、区间缩放或图例交互时。

---

## 三、目录与归属

```
apps/api/
├─ prisma/schema.prisma                     ecom_* 四表（文件末尾一节）
├─ prisma/migrations/20261020135517_add_ops_metrics/
└─ src/
   ├─ ops/
   │  ├─ date.ts       业务日 ↔ DATE 列（UTC 零点，唯一换算处）
   │  ├─ ingest.ts     校验 + 幂等 upsert + revised 判定 + 批次留痕
   │  └─ query.ts      读模型：聚合、口径分档、金额裁剪、维度选窗
   ├─ routes/ops.ts    参数校验 + 权限门槛 + 回环/token 鉴权
   └─ tools/ops-import.ts  历史回填（绕过 HTTP，共用 ingest.ts）

apps/web/src/
├─ lib/
│  ├─ ops.ts              会话感知 + 拆信封 + 错误码分流
│  ├─ ops-display.ts      纯函数：分转元、比率、涨跌色、日期、排序、新鲜度
│  ├─ ops-view.ts         视图与区间预设（地址栏取值域）
│  ├─ ops-pending.ts      待接入指标清单（对外说明，不参与计算）
│  └─ use-ops-dashboard.ts 加载状态（指纹式，避免 effect 里 setState）
├─ components/ops/        看板专用组件（Section / Chip / KpiGrid / TrendChart /
│                         ChannelList / ItemTable / RankList / SummaryGrid /
│                         PendingPanel / HealthPanel / Toolbar）
└─ pages/OpsDashboardPage.tsx   路由分派之后的页面

packages/shared/src/
├─ ops.ts                 契约类型、限额、日期运算（API 与前端共用）
└─ permissions.ts / navigation.ts   三个权限点 + 看板转正

tools/collector/          见该目录 README（采集端自己的边界与运行方式）
docs/ops/                 本目录：模块说明、数据契约、运行手册
```

规则：**共享包只放「两边都要用且必须一致」的东西**（契约、限额、日期运算）；展示规则一律在 `lib/ops-display.ts`；只有一处使用的东西留在原地。

---

## 四、权限

| 权限点 | 含义 | OWNER | ADMIN | MEMBER | VIEWER |
| --- | --- | --- | --- | --- | --- |
| `ops.shop.read` | 进页面 + 非金额指标 | 有 | 有 | 无 | 无 |
| `ops.finance.read` | 金额类字段 | 有 | 有 | 无 | 无 |
| `ops.collect.read` | 采集批次与新鲜度 | 有 | 有 | 无 | 无 |

- **成员默认一个都没有**：店铺 GMV 与客单价属于经营机密。
- 需要时按账号授予 `ops.shop.read`，此时能看到商品与流量，金额字段被服务端裁掉（返回 `null` 且进 `flags.masked`），界面显示「无权限」而不是 0。
- 裁剪在服务端投影层完成（`ops/query.ts` 的 `applyFinanceMask` / `maskDimensionRows`），前端只是不渲染，不构成安全边界。

**新增权限点后必须重跑种子**：`pnpm db:seed`。漏跑的表现为「权限配了不生效」，看起来像权限算法出错。

容器部署时这条会多一个坑：`migrate` 服务本身就在跑种子，而它来自同一 Dockerfile 的 `migrate` 阶段。**只重建 `api` / `web` 会用旧镜像里的旧权限清单把新授权摘掉**（本次实测日志 `移除授权关联 6`，随后管理员访问看板 403，而 `permissions` 表里三个新点仍在）。改权限点后必须三个镜像一起重建，判据与命令见 `docs/ops/RUNBOOK.md` 第 5.1 节。

---

## 五、数据口径（最容易出错的地方）

四个量可相加，其余不可。这条边界决定了页面能提供什么样的时间筛选。

| 指标 | 档位 | 能不能按区间重算 |
| --- | --- | --- |
| 支付金额、访客、支付买家、商品访客 | 逐日 | 能（求和） |
| 支付转化率、客单价 | 推算 | 能（相除），但不可跨维度相加 |
| 跳失率、停留时长、加购人数、新老买家、渠道结构、商品排行、地域、搜索词 | 整段 | 不能，带自己的窗口 |
| 服务 / 推广 / 内容的 13 项 | 未接入 | — |

**一个具体的坑，已经写进代码**：当查询区间恰好等于快照窗口时，KPI 用平台的整段去重值（访客 3,890）；区间被改成别的跨度时，退回逐日求和（访客 4,038）。差的 148 是同一个访客在不同日子各算一次的重复。两个数字都对，混用就错。规则在 `ops/query.ts` 的 `usePeriod` 分支，逐日/整段的说明见 `docs/ops/DATA-CONTRACT.md`。

---

## 六、验收基线（2026-10-20）

页面截图（`docs/ops/screenshots/`，1680 宽，浅色主题，真实数据）：

| 文件 | 视图 | 看到什么 |
| --- | --- | --- |
| `overview.png` | 总览 | 六个指标卡带「整段」徽标与环比、支付金额趋势（可切访客/买家）、渠道结构、商品排行前 6 |
| `flow.png` | 流量 | 结构指标（跳失率 69.9%、停留 14.2 秒、加购 108、新老买家 22/69）、渠道、地域、搜索词、内容来源 |
| `service.png` | 服务 | 待接入清单（六项，逐条写后台入口与卡点）与批次进度、已接入指标 |
| `health.png` | 采集记录 | 批次表（窗口 / 方式 / 状态 / 行数 / 耗时 / 错误），展开在任意视图之上 |

- 四道门禁：`test` 892 项 0 失败（shared 119 / web 240 / desktop 287 / api 246，含 5 项设计跳过）、`lint` 0 问题、`typecheck` 通过、`format:check` 通过。
- 迁移数 7 → 8，表数 13 → 17。
- 数据锚点：`ecom_daily_metrics` 30 行、`ecom_dimension_snapshots` 50 行、支付金额合计 10,800,000 分（¥108,000），与 `csv30` 的四处交叉校验一致。
- 接口反例：错 token → 401；未配 token → 503；窗口倒置 → 400；逐日日期越窗 → 400；未登录读接口 → 401。
- 幂等：同一份 payload 连跑两次，第二次 `revisedDays = 0`，行数不变。

新基线要写回 `docs/WORK-STATUS.md`；改门禁数字时连同这一节一起改。

---

## 七、下一步（按依赖排序）

1. **B 批采集**（客服绩效三项 + 评价 + 问大家）：千牛登录态已有，改 `dateType` 参数重跑即可，不需要额外授权。
2. **C 批采集**（违规、商品评分、素材体检）：需要逐商品循环，采集量大，先把单页探针跑通再批量化。
3. **D 批**（万相台 + 光合）：需要两套独立登录态，要人配合扫码。这一批决定推广与内容两块能否转真实。
4. **单品下钻**：商品表加右侧抽屉，URL 参数 `item=<dimKey>`。
5. **导出与手动采集**：加 `ops.shop.export` / `ops.collect.run` 两个权限点，导出写审计。
6. **分店 F 批**：需要 4 套店铺授权；表结构已就绪，接入即多行 `ecom_shops`。

---

## 八、相关文档

| 文档 | 内容 |
| --- | --- |
| `docs/ops/DATA-CONTRACT.md` | 上报契约逐字段说明、单位、幂等与 `revised` 语义 |
| `docs/ops/RUNBOOK.md` | 每日采集与回填的操作步骤、故障判据 |
| `docs/QIANNIU-OPS-INTEGRATION-2026-10-19.md` | 接入方案（含与本实现的差异：十表收敛为四表） |
| `docs/QIANNIU-OPS-PERMISSION-2026-10-19.md` | 权限设计（七个权限点的完整矩阵，当前落地三个） |
| `tools/collector/README.md` | 采集端目录、运行、故障判据 |
| `tools/collector/docs/` | 采集口径原始文档（映射清单、原型交付说明、架构分析） |
