# 千牛运营数据接入梵禾 Work 技术方案

> 版本：v1，2026-10-19
> 前置文档：`F:/qianniu-shuju/docs/千牛店铺数据抓取与运营分析方案.md`（采集通道选型与指标口径）
> 本文只回答一件事：那些数据怎么长进梵禾，并且能点。

---

## 0. 结论

四句话。

**第一，落地位置已经存在。** 共享包的导航清单里，`/ops/dashboard`（运维信息平台下的「数据看板」）当前 `planned: true`，规划说明写的是「订单量、交付周期、返工率等运营指标的图表展示」。这个需求不需要新增一级导航，只需要把这个占位项做实。

**第二，采集器必须独立于 Electron 主进程先跑起来。** 主进程没有用户会话，也没有数据库凭据，它能做的事限定在静态托管、反代和启动进程。把采集塞进主进程会先卡在鉴权设计上，而这个设计属于 AI 工作台 P1 的范围。数据看板不应该被一个未完成的模块阻塞。

**第三，入库走回环 HTTP，不走直连数据库。** 采集器只负责拿数据，清洗与写库留在 API 侧。理由是清洗规则会被反复调整，改完重启 API 即可，不用重新打包采集器，也不必让两个进程共用 Prisma 客户端的版本。

**第四，图表不引入 ECharts。** 前端目前没有任何图表依赖，shadcn 体系配 Recharts 的改造成本最低，颜色可以直接吃 `index.css` 里的令牌。ECharts 会带进第二套主题系统，与「令牌唯一来源」这条红线冲突。

---

## 1. 现状核对

以下事实来自实际读代码，不是推断。

| 项目 | 实际情况 | 对方案的影响 |
| --- | --- | --- |
| 路由 | `react-router` 8.4.0，`AppRoutes` 由 `NAV_ITEMS` 派生，模块页走 `ModuleRoute` 分派 | 新增页面只需改 `planned` 与分派分支，路由表不用动 |
| 占位项 | `/ops/dashboard` 已存在，`planned: true` | 无需新增导航编号，`OPS_SLOT_1/2/3` 可留给后续子页 |
| 权限模块 | `PERMISSION_MODULES = ['system', 'personal']` | 必须新增 `ops` 模块，否则导航可见性无法按权限收敛 |
| 角色 | OWNER / ADMIN / MEMBER / VIEWER，ADMIN 与 MEMBER 的授权是 `personal.*` | 运营数据默认对 MEMBER 不可见，需要显式追加授权 |
| 数据模型 | 13 张表，命名 PascalCase，`@map` 到 snake_case，主键 `uuid(7)`，时间列 `Timestamptz(3)` | 新表沿用同一套约定，不另立风格 |
| API | Fastify 5，`buildApp` 里逐个 `registerXxxRoutes`，权限走 `requirePermission` | 新增 `registerOpsRoutes` 一行注册 |
| 图表 | 无任何图表库 | 需要新增依赖，作体积评估 |
| 桌面主进程 | 有 `agent.ts`（启动进程）、`credential-vault.ts`、`launch-login-click.ts` | 本地自动化有先例，但都在主进程内且不依赖用户会话 |
| 门禁 | `test → lint → typecheck → format:check`，基线 530 项 | 新增用例会让基线变动，验收要写清新基线数 |

有一处需要特别指出。`launch/loopback.ts` 已经在做回环来源校验，这是现成的鉴权基础。采集器与 API 同机，走回环加共享密钥，不需要新造一套用户体系。

---

## 2. 三个必须先定的技术选择

### 2.1 采集器放在哪

| 方案 | 实现方式 | 优势 | 代价 |
| --- | --- | --- | --- |
| A. Electron 主进程内 | 新增 `apps/desktop/src/ecom-collector.ts`，随 app 启动 | 生命周期跟随 app，可做「立即采集」按钮，与 `agent.ts` 同构 | 主进程无用户会话，写库要么新造机器级凭据，要么让渲染层代转，后者等于把采集逻辑拆两半 |
| B. 独立 Node 进程 + 计划任务 | `tools/collector/` 下的 `.mjs`，Windows 任务计划每日触发 | 零鉴权改造，采集挂了不影响 API，与 `tools/checks/*.mjs` 风格一致 | 用户看不到它在跑，需要靠数据新鲜度兜底 |
| C. 服务端 Fastify 内 | 定时任务挂在 API 进程 | 写库最直接 | 服务端通常不在装了千牛的机器上，拿不到登录态，直接排除 |

推荐 B 先行、A 后补。两者共用同一个采集模块，A 阶段只换调度器与触发入口，采集代码不动。这个顺序与 `launch/agent.ts` 的演进路径一致，那个模块当年也是先在实验版本机服务里跑通，再原样 import 进主进程。

### 2.2 入库走 HTTP 还是直连 PG

推荐 HTTP。理由是职责边界。采集器的产出是「平台给了什么」，清洗规则的产出是「我们怎么理解它」。后者会随口径调整频繁变化，把它放在 API 侧，改一次重启十秒；放在采集器侧，每次都要重新分发脚本，而脚本跑在计划任务里，失败是静默的。

鉴权用两层，都复用现有能力。

1. 来源校验。只接受 `127.0.0.1` / `::1`，逻辑照 `launch/loopback.ts` 抄，不另写。
2. 共享密钥。环境变量 `OPS_INGEST_TOKEN`，请求头带 `x-ops-token`，用 `timingSafeEqual` 比较。它只用于 ingest 这一个路由，不给任何读接口。

不做用户会话校验，因为计划任务里没有用户。也不把这个 token 写进数据库，它属于部署配置。

### 2.3 图表库

| 候选 | 体积（gzip，估计） | 与现有体系的关系 | 判断 |
| --- | --- | --- | --- |
| Recharts | 约 100 至 130KB | 纯 React 组件，颜色可直传 CSS 变量，shadcn 有官方 chart 封装 | 推荐 |
| ECharts | 约 300KB 起，按需引入可降 | 自带 canvas 渲染与主题系统，与 Tailwind 令牌并行 | 否决，两套主题会漂 |
| 手写 SVG | 接近 0 | 完全可控 | 只适合单指标迷你图，多维筛选与 tooltip 会迅速失控 |

体积数字是经验值，落地前用 `vite build` 实测一次再定。Electron 安装包已经不小，这一项要进发版检查清单。

---

## 3. 目标架构

```
┌──────────────────────────────────────────────────────────────┐
│ 本机（装有千牛登录态的 Windows）                               │
│                                                               │
│  计划任务 每日 08:30                                          │
│      │                                                        │
│      ▼                                                        │
│  tools/collector/collect.mjs                                  │
│    · CDP 连本地 Chrome（复用已登录 profile）                    │
│    · 官方报表下载 + 生意参谋接口直取                            │
│    · 原始文件落 data/ecom-raw/YYYY-MM-DD/                      │
│      │                                                        │
│      └── POST /api/ops/ingest  （回环 + x-ops-token）          │
└───────────────────────────┬──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│ Fastify 5                                                     │
│   ops/ingest.ts   校验、清洗、upsert、写 EcomCollectRun         │
│   ops/query.ts    聚合查询，只读                                │
│   routes/ops.ts   对外接口 + requirePermission                  │
└───────────────────────────┬──────────────────────────────────┘
                            │ Prisma
┌───────────────────────────▼──────────────────────────────────┐
│ PostgreSQL  既有 13 表 + ecom_* 10 表                          │
└───────────────────────────┬──────────────────────────────────┘
                            │ GET /api/ops/*
┌───────────────────────────▼──────────────────────────────────┐
│ React 19  /ops/dashboard                                      │
│   指标卡 · 趋势图 · 渠道分解 · 商品表 · 单品抽屉 · 新鲜度徽标    │
│   状态由 URL 承载，点击即下钻                                   │
└──────────────────────────────────────────────────────────────┘
```

架构上唯一的硬约束是采集器必须跑在有登录态的那台机器上，其余都可以调。这一点决定了采集不能放进服务端，也决定了它和用户会话无关。

---

## 4. 数据模型

新增 10 张表，全部 `ecom_` 前缀，与既有表零耦合。`User` 不加反向关系，因为运营数据归属店铺，不归属个人。

### 4.1 两条建模纪律

**只存可加量，比率一律查询时算。** 转化率、客单价、ROI 都不落库。落库就会遇到「分子分母来自不同批次」的漂移，而这类错误在界面上表现为「两个数字对不上」，排查方向会先落到计算公式上，实际原因在采集批次。

**业务日必须是 `@db.Date`，不能是 `Timestamptz`。** 生意参谋的「日」是自然日，跨时区换算会把 10 月 1 日的单子算到 9 月 30 日。业务日与采集时刻是两个概念，`statDate` 走 Date，`collectedAt` 走 Timestamptz。这条如果一开始写错，后面所有同比环比都会错位一天，而且只在月初月末暴露。

### 4.2 模型定义

```prisma
enum EcomPlatform {
  taobao
  tmall
}

enum EcomCollectSource {
  report
  api
}

enum EcomCollectStatus {
  running
  succeeded
  partial
  failed
}

/// 店铺。当前部署只有一家，表结构保留多店维度，避免将来加店要动全部事实表。
model EcomShop {
  id              String       @id @default(uuid(7)) @db.Uuid
  name            String       @db.VarChar(120)
  platform        EcomPlatform @default(taobao)
  sellerNick      String?      @map("seller_nick") @db.VarChar(80)
  /// 业务日时区。生意参谋按东八区切日，这里固定写死，不跟服务器时区走。
  timezone        String       @default("Asia/Shanghai") @db.VarChar(40)
  enabled         Boolean      @default(true)
  /// 最近一次成功采集完成的时刻。前端新鲜度徽标读这一列。
  lastCollectedAt DateTime?    @map("last_collected_at") @db.Timestamptz(3)
  createdAt       DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime     @updatedAt @map("updated_at") @db.Timestamptz(3)

  metrics   EcomDailyMetric[]
  items     EcomItem[]
  channels  EcomChannelDaily[]
  services  EcomServiceDaily[]
  ads       EcomAdDaily[]
  leads     EcomLead[]
  runs      EcomCollectRun[]
  checks    EcomReconcile[]

  @@map("ecom_shops")
}

/// 商品维度。标题会改，所以存 titleSnapshot 并记 updatedAt，历史分析按 itemId 关联。
model EcomItem {
  id            String   @id @default(uuid(7)) @db.Uuid
  shopId        String   @map("shop_id") @db.Uuid
  /// 平台商品 id，字符串。淘宝的 num_iid 是纯数字，但不要用 BigInt，前端 JSON 会丢精度。
  platformId    String   @map("platform_id") @db.VarChar(64)
  titleSnapshot String   @map("title_snapshot") @db.VarChar(300)
  categoryPath  String?  @map("category_path") @db.VarChar(300)
  /// 是否定制款。定制与非定制的转化逻辑不同，分析时要能分开。
  isCustom      Boolean  @default(false) @map("is_custom")
  listedAt      DateTime? @map("listed_at") @db.Date
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt     DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  shop   EcomShop        @relation(fields: [shopId], references: [id], onDelete: Cascade)
  daily  EcomItemDaily[]

  @@unique([shopId, platformId])
  @@map("ecom_items")
}

/// 店铺日指标。金额单位统一为「分」，整数运算避免浮点累积误差。
model EcomDailyMetric {
  id             String   @id @default(uuid(7)) @db.Uuid
  shopId         String   @map("shop_id") @db.Uuid
  statDate       DateTime @map("stat_date") @db.Date

  visitors       Int      @default(0)
  payBuyers      Int      @default(0) @map("pay_buyers")
  payAmountFen   Int      @default(0) @map("pay_amount_fen")
  refundFen      Int      @default(0) @map("refund_fen")
  refundCount    Int      @default(0) @map("refund_count")

  /// 数据来源。对账时靠这一列区分哪个源写入的。
  source         EcomCollectSource @default(report)
  /// 采集时刻。平台会回溯改数，同一业务日可能有多次写入，这一列用于判断新鲜度。
  collectedAt    DateTime @default(now()) @map("collected_at") @db.Timestamptz(3)
  /// 本次写入是否覆盖了上一次的取值。为 true 说明平台改过数，业务上要能看到。
  revised        Boolean  @default(false)

  shop EcomShop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@unique([shopId, statDate])
  @@index([shopId, statDate])
  @@map("ecom_daily_metrics")
}

/// 商品日指标。行数最大的表，一年约 7 万行，对 PG 无压力。
model EcomItemDaily {
  id           String   @id @default(uuid(7)) @db.Uuid
  shopId       String   @map("shop_id") @db.Uuid
  itemId       String   @map("item_id") @db.Uuid
  statDate     DateTime @map("stat_date") @db.Date

  impressions  Int      @default(0)
  clicks       Int      @default(0)
  visitors     Int      @default(0)
  cartAdds     Int      @default(0) @map("cart_adds")
  favorites    Int      @default(0)
  payItems     Int      @default(0) @map("pay_items")
  payAmountFen Int      @default(0) @map("pay_amount_fen")
  refundFen    Int      @default(0) @map("refund_fen")
  collectedAt  DateTime @default(now()) @map("collected_at") @db.Timestamptz(3)

  shop EcomShop @relation(fields: [shopId], references: [id], onDelete: Cascade)
  item EcomItem @relation(fields: [itemId], references: [id], onDelete: Cascade)

  @@unique([shopId, itemId, statDate])
  @@index([shopId, statDate])
  @@index([itemId, statDate])
  @@map("ecom_item_daily")
}

/// 渠道日指标。channelCode 由采集层归一，不用平台原始字符串。
model EcomChannelDaily {
  id           String   @id @default(uuid(7)) @db.Uuid
  shopId       String   @map("shop_id") @db.Uuid
  statDate     DateTime @map("stat_date") @db.Date
  channelCode  String   @map("channel_code") @db.VarChar(40)
  channelName  String   @map("channel_name") @db.VarChar(80)

  visitors     Int      @default(0)
  payBuyers    Int      @default(0) @map("pay_buyers")
  payAmountFen Int      @default(0) @map("pay_amount_fen")
  collectedAt  DateTime @default(now()) @map("collected_at") @db.Timestamptz(3)

  shop EcomShop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@unique([shopId, statDate, channelCode])
  @@index([shopId, statDate])
  @@map("ecom_channel_daily")
}

/// 客服日指标。定制行业的核心表，询单转化率比支付转化率更有解释力。
model EcomServiceDaily {
  id               String   @id @default(uuid(7)) @db.Uuid
  shopId           String   @map("shop_id") @db.Uuid
  statDate         DateTime @map("stat_date") @db.Date

  consultCount     Int      @default(0) @map("consult_count")
  effectiveInquiry Int      @default(0) @map("effective_inquiry")
  inquiryDeals     Int      @default(0) @map("inquiry_deals")
  avgFirstReplySec Int      @default(0) @map("avg_first_reply_sec")
  collectedAt      DateTime @default(now()) @map("collected_at") @db.Timestamptz(3)

  shop EcomShop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@unique([shopId, statDate])
  @@map("ecom_service_daily")
}

/// 推广日指标。按计划粒度存，聚合到日由查询侧做。
model EcomAdDaily {
  id           String   @id @default(uuid(7)) @db.Uuid
  shopId       String   @map("shop_id") @db.Uuid
  statDate     DateTime @map("stat_date") @db.Date
  planId       String   @map("plan_id") @db.VarChar(64)
  planName     String   @map("plan_name") @db.VarChar(120)

  costFen      Int      @default(0) @map("cost_fen")
  impressions  Int      @default(0)
  clicks       Int      @default(0)
  payAmountFen Int      @default(0) @map("pay_amount_fen")
  collectedAt  DateTime @default(now()) @map("collected_at") @db.Timestamptz(3)

  shop EcomShop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@unique([shopId, statDate, planId])
  @@index([shopId, statDate])
  @@map("ecom_ad_daily")
}

/// 线索。这张表的数据不来自生意参谋，来自客服跟进表，先建表占位。
model EcomLead {
  id            String    @id @default(uuid(7)) @db.Uuid
  shopId        String    @map("shop_id") @db.Uuid
  buyerNick     String?   @map("buyer_nick") @db.VarChar(80)
  sourceChannel String?   @map("source_channel") @db.VarChar(40)
  houseArea     Int?      @map("house_area")
  budgetBand    String?   @map("budget_band") @db.VarChar(40)
  stage         String    @default("inquiry") @db.VarChar(40)
  outcome       String?   @db.VarChar(40)
  lostReason    String?   @map("lost_reason") @db.VarChar(200)
  firstContactAt DateTime? @map("first_contact_at") @db.Timestamptz(3)
  closedAt      DateTime? @map("closed_at") @db.Timestamptz(3)
  createdAt     DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt     DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  shop EcomShop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, stage])
  @@index([shopId, firstContactAt])
  @@map("ecom_leads")
}

/// 采集批次。这张表是这套系统可运维的前提，缺了它就无法回答「昨天为什么没数」。
model EcomCollectRun {
  id           String            @id @default(uuid(7)) @db.Uuid
  shopId       String            @map("shop_id") @db.Uuid
  statDate     DateTime          @map("stat_date") @db.Date
  source       EcomCollectSource
  /// schedule 或 manual。手动触发的采集单列，便于区分责任。
  trigger      String            @default("schedule") @db.VarChar(20)
  status       EcomCollectStatus @default(running)

  rowCount     Int               @default(0) @map("row_count")
  errorCode    String?           @map("error_code") @db.VarChar(60)
  errorMessage String?           @map("error_message") @db.Text
  /// 原始文件相对路径，只记相对路径，盘符会变。
  rawPath      String?           @map("raw_path") @db.VarChar(300)

  startedAt    DateTime          @default(now()) @map("started_at") @db.Timestamptz(3)
  finishedAt   DateTime?         @map("finished_at") @db.Timestamptz(3)
  durationMs   Int?              @map("duration_ms")

  shop EcomShop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@index([shopId, startedAt])
  @@index([shopId, statDate, source])
  @@map("ecom_collect_runs")
}

/// 双源对账结果。报表口径与接口口径的差异超过阈值时置为 warn。
model EcomReconcile {
  id          String   @id @default(uuid(7)) @db.Uuid
  shopId      String   @map("shop_id") @db.Uuid
  statDate    DateTime @map("stat_date") @db.Date
  metricKey   String   @map("metric_key") @db.VarChar(60)
  reportValue Int      @map("report_value")
  apiValue    Int      @map("api_value")
  /// 相对偏差，百分比。超过 2 则 status 为 warn。
  diffPct     Float    @map("diff_pct")
  status      String   @default("ok") @db.VarChar(20)

  shop EcomShop @relation(fields: [shopId], references: [id], onDelete: Cascade)

  @@unique([shopId, statDate, metricKey])
  @@index([shopId, statDate])
  @@map("ecom_reconcile")
}
```

迁移一条，编号沿用时间戳目录。迁移数从 7 变 8，`db:deploy` 之后要跑 `db:ping` 核对表数从 13 变 23。

### 4.3 关于金额用分

平台接口返回的就是分，报表导出的是元。用整数分存储有三个好处，与浮点累加误差无关，与比较有关。两张表求和之后做差值判断，整数比较是精确的，浮点需要给容差，而容差写多少没有依据。展示时在 `lib/ops-display.ts` 里除以 100，这是唯一一次单位换算，不允许在组件里再除一次。

---

## 5. API 设计

新增 `apps/api/src/routes/ops.ts` 与两个服务模块，在 `buildApp` 里注册一行。

| 方法 | 路径 | 用途 | 权限 |
| --- | --- | --- | --- |
| GET | `/api/ops/overview` | 总览指标与趋势序列 | `ops.shop.read` |
| GET | `/api/ops/items` | 商品列表，支持排序筛选分页 | `ops.shop.read` |
| GET | `/api/ops/items/:itemId` | 单品详情与趋势 | `ops.shop.read` |
| GET | `/api/ops/channels` | 渠道分解 | `ops.shop.read` |
| GET | `/api/ops/service` | 客服与询单 | `ops.shop.read` |
| GET | `/api/ops/ads` | 推广花费与产出 | `ops.shop.read` |
| GET | `/api/ops/health` | 数据新鲜度、最近批次、对账告警 | `ops.shop.read` |
| POST | `/api/ops/ingest` | 采集器写入 | 回环 + token |
| POST | `/api/ops/collect` | 手动触发采集 | `ops.collect.run` |
| GET | `/api/ops/export` | 导出 CSV | `ops.shop.read` 且写审计 |

公共查询参数统一为 `shopId`、`from`、`to`，日期格式 `YYYY-MM-DD`。三条约束必须由 schema 强制，不能靠前端自觉。

1. `from` 与 `to` 的跨度上限 366 天。没有上限的区间查询在数据攒够一年后会把 API 拖垮。
2. `to` 不晚于今天，`from` 不早于店铺首条数据日。
3. 分页 `pageSize` 上限 200。

`overview` 返回结构建议固定为四段，前端据此渲染，不各自取数。

```json
{
  "range": { "from": "2026-10-01", "to": "2026-10-18" },
  "kpi": [
    { "key": "gmvFen", "value": 1284500, "prev": 1102300, "deltaPct": 16.5 },
    { "key": "payBuyers", "value": 42, "prev": 38, "deltaPct": 10.5 }
  ],
  "series": [
    { "date": "2026-10-01", "gmvFen": 62000, "visitors": 812 }
  ],
  "flags": {
    "freshness": "fresh",
    "lastCollectedAt": "2026-10-19T08:31:12+08:00",
    "reconcileWarn": 0
  }
}
```

`flags` 这一段容易被省略，它是防止信任崩塌的关键。界面上任何一个数字都可能被拿去和生意参谋对，对不上时用户需要知道「这份数据是哪天几点抓的、有没有对账告警」。把这个信息挂在响应里，前端就不必再单独请求一次健康接口。

---

## 6. 前端交互设计

### 6.1 URL 是唯一状态源

所有筛选条件进 `searchParams`，不用 `useState`。三个理由，都来自实际使用场景。

第一，从商品表点进单品，再按浏览器后退，应当回到原来的筛选和排序，默认视图只在首次进入时出现。第二，看到异常指标想让人一起看，复制链接就能复现同一屏。第三，梵禾是 Electron 应用，刷新不常见，但外部链接进入和前进后退很常见。

参数约定。

```
/ops/dashboard?from=2026-09-19&to=2026-10-18&metric=gmvFen&channel=search&item=<uuid>&date=2026-10-12
```

`item` 与 `date` 同时存在表示抽屉打开且定位到某一天。参数非法时退回默认值并在页面上给一句提示，不静默失败，否则用户会以为自己点错了。

### 6.2 三层下钻

```
第一层  总览        指标卡 · 趋势 · 渠道分解 · 商品 Top N
   │  点指标卡 / 渠道条 / 某一天
   ▼
第二层  聚焦        趋势切指标 · 商品表按渠道过滤 · 当天明细列表
   │  点商品行
   ▼
第三层  单品抽屉    30 天趋势 · 流量结构 · 成交与退款 · 关联线索
```

第三层用右侧抽屉承载，不开新页面。理由是用户看单品时仍需要对照总览，跳页会丢掉上下文。抽屉宽度建议 480px，与 AI 工作台方案里「运行现场 320px」的克制保持一致。

### 6.3 点击行为表

| 元素 | 点击结果 | URL 变化 |
| --- | --- | --- |
| 指标卡（GMV / 买家数 / 客单价 / 询单转化） | 趋势图切换为该指标的序列，卡片进入选中态 | `metric` |
| 趋势线某一天 | 下方商品表过滤到该日，顶部出现面包屑「10-12」 | `date` |
| 渠道横条 | 商品表按该渠道过滤，KPI 同步重算 | `channel` |
| 商品表表头 | 排序切换，升降序交替 | `sort` `order` |
| 商品行 | 右侧抽屉打开单品详情 | `item` |
| 面包屑任一层 | 退回该层，清掉之后的参数 | 逐级清理 |
| 新鲜度徽标 | 展开采集批次列表与对账明细 | `panel=health` |

空态、加载态、错误态统一走 `StateView.tsx`，与既有约定一致。四个状态若按商品表的需要扩展，参照 `LaunchPanel` / `NotesPanel` 的写法，不新造一套。

### 6.4 组件树

```
pages/OpsDashboardPage.tsx
  components/ops/FreshnessBadge.tsx
  components/ops/RangePicker.tsx
  components/ops/KpiGrid.tsx
    components/ops/KpiCard.tsx
  components/ops/TrendChart.tsx          Recharts
  components/ops/ChannelBars.tsx
  components/ops/ItemTable.tsx
    components/ops/ItemRow.tsx
  components/ops/ItemDrawer.tsx
  components/ops/HealthPanel.tsx
lib/ops.ts          会话感知 + 拆信封 + 错误码分流
lib/ops-display.ts  分转元、比率计算、涨跌配色、日期归一
```

`lib/ops-display.ts` 必须是纯函数，这是既有约定。比率与涨跌色的判断写在组件里，只有开浏览器才能验；写成纯函数就能进 `test/*.test.mjs`。

涨跌配色要注意一件事。中国电商后台的惯例是涨红跌绿，与欧美相反。这个判断集中放在一个函数里，不要在每个组件里各写一遍 `delta > 0 ? 'red' : 'green'`，否则总有一天会有一处写反。

---

## 7. 权限与安全

### 7.1 权限点

`PERMISSION_MODULES` 增加 `ops`，新增七个权限点。完整设计见 `QIANNIU-OPS-PERMISSION-2026-10-19.md`，含金额字段的服务端裁剪、店级数据范围、审计事件与反例测试，这里只留最终矩阵。

| 权限点 | 含义 | OWNER | ADMIN | MEMBER | VIEWER |
| --- | --- | --- | --- | --- | --- |
| `ops.shop.read` | 页面准入与非金额指标 | 有 | 有 | 默认无 | 无 |
| `ops.finance.read` | 金额类字段 | 有 | 有 | 默认无 | 无 |
| `ops.shop.export` | 导出 CSV | 有 | 有 | 无 | 无 |
| `ops.lead.read` | 线索列表与详情 | 有 | 有 | 默认无 | 无 |
| `ops.lead.write` | 编辑线索 | 有 | 有 | 无 | 无 |
| `ops.collect.read` | 采集批次与对账告警 | 有 | 有 | 无 | 无 |
| `ops.collect.run` | 手动触发采集 | 有 | 无 | 无 | 无 |

MEMBER 默认全无，理由是店铺 GMV 与客单价属于经营机密。需要时由 owner 单独授予 `ops.shop.read`，此时该账号能看到商品表现但看不到金额，这个组合正是拆分 `ops.finance.read` 的目的。

ADMIN 的授权在 `ROLES` 里要逐组写 `ops.shop.*`、`ops.lead.*`、`ops.collect.*`，**不能写 `ops.*`**。通配符会连带授予 `ops.finance.read`，等于把「管理员」变成「能看到全部金额的人」而没人注意到。

新增权限点后必须重跑一次种子（`apps/api/src/db/seed.ts`，可重复执行）。漏跑不会报错，`role_permissions` 里没有新关联，界面上表现为「权限配了不生效」，看起来像权限算法出错。这个坑要写进部署清单。

### 7.2 安全边界

- 采集器不保存账号密码，登录一律人工完成，脚本只复用已建立的会话。这条与 `qianniu-verification-flow` 的既有共识一致。
- `OPS_INGEST_TOKEN` 只进环境变量，不进数据库、不进 git。`.env.compose` 与 `.env` 各加一行占位，真实值只在本机。回环校验只是纵深防御，真正的门是 token，因为桌面壳反代之后所有请求的远端地址都可能是回环。
- 原始 JSON 含买家昵称等个人信息，`data/ecom-raw/` 必须进 `.gitignore`，且导出功能默认脱敏昵称。
- 金额裁剪必须在服务端的投影层完成，前端不渲染只是体验。无权限时金额字段返回 `null` 并置入响应的 `masked` 数组，前端据此渲染「无权限」占位。**0 与 null 必须区分**，否则用户会把「看不到」理解成「当天没成交」。
- 手动触发采集与导出写 `AuditLog`，记操作者。自动采集不写审计，它由 `EcomCollectRun` 承担可观测性，两者分工不同。权限变更的审计见权限专章。

---

## 8. 与 AI 工作台的衔接

这套表建好之后，AI 工作台的 P1 可以直接把它们注册成三个只读工具。

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `ops.metric.query` | 指标、区间、维度 | 聚合结果与来源说明 |
| `ops.item.top` | 区间、排序字段、数量 | 商品排行 |
| `ops.health.check` | 无 | 新鲜度与对账告警 |

这属于顺手收益，不构成现在的设计约束。唯一需要现在就守住的是一条：查询逻辑放在 `ops/query.ts` 里，路由只负责参数校验与权限，这样将来注册工具时可以直接调服务函数，不必绕 HTTP。

反过来说，如果现在把查询逻辑写进路由处理器，P1 到来时会被迫复制一份，而复制出来的两份迟早不一致。

---

## 9. 实施分期

工时按熟悉现有代码库的一名全栈估算，不含测试联调缓冲。

### P0 数据能进库（3 至 4 人日）

- `schema.prisma` 新增 10 表与枚举，出一条迁移
- `ops/ingest.ts` 清洗与 upsert，含 `revised` 判定
- `routes/ops.ts` 只做 ingest 一个路由，含回环与 token 校验
- `tools/collector/` 骨架，先只采生意参谋店铺经营日报

验收：手工跑一次采集，`ecom_daily_metrics` 有当天行；重复跑一次不产生新行，`revised` 为 false；把 token 改错，接口返回 401 且不写库。第三条是反例测试，按既有方法论必须做。

### P1 能看能点（4 至 5 人日）

- `/ops/dashboard` 总览、趋势、商品表
- 单品抽屉
- URL 状态与面包屑
- 新鲜度徽标与健康面板
- `planned` 置为 false，`ModuleRoute` 补一条分派分支
- 权限点与角色授权

验收：从总览点渠道条，商品表被过滤且 KPI 重算；点商品行进抽屉，后退回到原筛选；复制链接在新窗口打开，状态一致；用 MEMBER 账号访问 `/ops/dashboard`，落到无权限页。

### P2 补维度（3 至 4 人日）

- 渠道、客服、推广三张表的采集与页面
- 双源对账与告警
- CSV 导出与审计
- 手动触发采集（含「再等一会儿」的排队提示，不做真实时）

验收：连续七天无人工干预跑通；制造一次对账偏差，页面上能看到告警；导出文件打开后中文不乱码。

### P3 可选，回到主进程

把采集迁进 `apps/desktop/src/ecom-collector.ts`，加「立即采集」按钮。前置条件是 AI 工作台 P1 的桌面桥就绪。这一期可以无限期推迟，独立进程方案本身能长期跑。

---

## 10. 风险清单

| 风险 | 等级 | 表现 | 应对 |
| --- | --- | --- | --- |
| 采集器静默死亡 | 高 | 页面还有数，但停在三天前 | 新鲜度徽标按小时分档，超 26 小时转黄、超 48 小时转红，并在首页通知里挂一条 |
| 平台回溯改数 | 高 | 昨天的 GMV 今天变了 | upsert 覆盖并置 `revised`，页面在该日打点标记 |
| 口径与后台对不上 | 高 | 用户拿梵禾数字质疑生意参谋 | 双源对账，偏差超 2% 在健康面板暴露，不隐藏 |
| 时区错位 | 中高 | 月初月末数据错一天 | `statDate` 用 Date 类型，日期运算集中在 `ops-display.ts` |
| 图表库体积 | 中 | 安装包变大 | 落地前实测，超预期就退回手写 SVG 只做趋势 |
| 新增迁移影响既有用例 | 中 | 门禁基线变化 | 迁移单独一笔提交，跑完四道门禁再动前端 |
| 主进程方案被提前启动 | 中 | 卡在鉴权设计上，看板延期 | P0 至 P2 与主进程解耦，任何主进程改动不进入本方案路径 |
| 单店假设被打破 | 低 | 加第二家店时事实表要改 | `shopId` 已进全部事实表，加店只是多一行 `ecom_shops` |

---

## 11. 对既有约定的影响

五项，都要在合并前处理。

1. 迁移数 7 变 8，表数 13 变 23，`db:ping` 的枚举输出会变。交接文档里的这处数字要同步更新。
2. 门禁基线 530 项会上升。新增用例至少覆盖三处，比率计算的纯函数、日期归一、权限过滤。跑完四道门禁后把新基线写回交接文档。
3. `.gitignore`、`eslint.config.js` 的 `ignores`、`.prettierignore` 三处都要加 `data/ecom-raw/`。只加 `.gitignore` 会让 lint 扫到几万个 JSON 文件。
4. 导航项 `DASHBOARD` 的 `planned` 改为 false 之后，`summary` 文案要改，它现在写的是「订单量、交付周期、返工率」，与实际页面内容不符。改文案属于共享包改动，与前端改动分两笔提交。
5. `react-router` 的版本是 8.4.0，与 7 的差异对本方案没有影响，但新页面的路由挂载要沿用 `MODULE_SUB_ROUTES` 的写法，不要在 `routes.tsx` 里另开一条平级路由。

---

## 12. 参考来源

本方案的梵禾侧事实全部来自实际代码，路径如下。

| 结论 | 依据文件 |
| --- | --- |
| 占位项与导航派生 | `packages/shared/src/navigation.ts` |
| 权限模块与角色授权 | `packages/shared/src/permissions.ts` |
| 模块路由分派 | `apps/web/src/routes.tsx` |
| 路由注册与鉴权 | `apps/api/src/app.ts`、`apps/api/src/routes/notes.ts` |
| 回环校验先例 | `apps/api/src/launch/loopback.ts` |
| 主进程本地自动化先例 | `apps/api/src/launch/agent.ts`、`apps/desktop/src/agent.ts` |
| 数据模型约定 | `apps/api/prisma/schema.prisma` |
| 前端依赖现状 | `apps/web/package.json` |

采集通道与指标口径的依据见前置文档，此处不重复引用。
