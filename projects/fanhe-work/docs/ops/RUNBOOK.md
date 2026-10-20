# 运营数据 · 运行手册

> 版本：v1，2026-10-20
> 适用对象：负责每天让看板有数的人，以及被叫去排查「昨天为什么没数」的人。

---

## 一、每天要做的事

四步，前三步在**装有千牛登录态的那台 Windows** 上，第四步在平台侧。

```powershell
# 1. 采集前一天（17 页全量，约 15 分钟；默认等每页 60 秒）
cd tools\collector
powershell -ExecutionPolicy Bypass -File .\scripts\run-daily.ps1

# 2. 复核（FAIL 表示某页 0 个文件，WARN 表示只有 1 个或小于 800 字节）
node .\scripts\check_daily.mjs --date 2026-10-19

# 3. 原始响应 → 契约（窗口 = 那一天）
node .\scripts\export-daily-ingest.mjs
```

第三步会打印一张覆盖率表，逐块说明「拿到了几行、来自哪个文件、为什么没有」：

```
  商品        5 行  09_cc_item_view_top.json
  地域       10 行  06_bda_visitor_distribution_listAreas.json
  搜索词     10 行  05_v4_shop_wordAide_drainageSearch.json
  渠道          无  未采到 tree_platform_support  ← 未采到渠道树（本日只采到总览）
  结构指标   13 行  02_new_guide_trend_overview.json

  逐日  1 行  金额 0.00 元  访客 67  买家 0
  维度  38 行
  写入  data\ingest\ops-daily-2026-10-19.json

  下一步（在 projects/fanhe-work 下）：
    pnpm db:ops-import "...\tools\collector\data\ingest\ops-daily-2026-10-19.json"
```

**退出码要当判据，不要只看「有没有报错」**：`0` 齐全、`2` 已产出但缺块（照上面第 3 步的表逐行看，缺的那块直接影响看板哪个区块）、`1` 无法产出（目录不对、日期与目录名不一致、认不出总览）。第 3 步用 `--strict` 时 `2` 也按失败处理，适合挂进计划任务。

```powershell
# 4. 入库（在 projects\fanhe-work 下；用绝对路径，入库脚本的工作目录是 apps\api）
cd ..\..\projects\fanhe-work
pnpm db:ops-import "E:\fanhe Work\projects\fanhe-work\tools\collector\data\ingest\ops-daily-2026-10-19.json"
```

**首次部署只需多做一步**：建四家分店的「占位行」（无数据，界面显示「待接入」），幂等，可重复执行；主店由采集器建档，不在这里创建。

```powershell
pnpm db:ops-shops
```

### 1.1 历史回填（30 天基线，新机或库被重建时）

```powershell
cd tools\collector
node .\scripts\export-ingest.mjs          # 读 data/csv30，产出 30 天窗口的契约
cd ..\..\projects\fanhe-work
pnpm db:ops-import                        # 不传路径时默认读 data/ingest/ops-ingest.json
```

两条通道共用同一个写入函数，因此回填与日增只差「窗口」与 `trigger` 字段（`backfill` / `schedule`），其余行为一致。

**边界仍然存在**：`run-daily.ps1` 不会自动调用第 3、4 步 —— 采集失败时不该连带写库，且写库要连平台侧的库。所以「跑完 run-daily」依然**不等于**「看板有今天的数据」，中间这两步要人（或计划任务）接着走。

---

## 二、前置条件（缺一不可）

| 条件 | 判据 | 缺失时的现象 |
| --- | --- | --- |
| Edge 已安装 | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` 存在 | 脚本报「找不到 Edge」 |
| Node ≥ 22 | `node -v` | 脚本语法错误（用了原生 WebSocket） |
| 已人工登录生意参谋 | 打开 `start-edge-debug.cmd` 后能看到后台首页 | 采集全是登录页，文件数极少 |
| 平台侧已建表 | `docker exec fanhe-work-db psql -U fanhe -d fanhe_work -c "\dt ecom_*"` 有四张表 | 入库报 `P2021 table does not exist` |

**登录态逐机失效**：`.browser-profile` 里的 cookie 由 Windows DPAPI 加密，密钥绑定本机账户。换电脑必须重新登录一次。脚本从不保存账号密码。

---

## 三、日报与回填的正确用法

### 3.1 回填 30 天基线（新机 / 库被重建）

```powershell
cd tools\collector
node .\scripts\export-ingest.mjs          # → data/ingest/ops-ingest.json
cd ..\..\projects\fanhe-work
pnpm db:ops-import                        # 读默认路径
```

判据：输出里 `逐日行 30`、`维度行 50`、`被改写天数 0`。重跑一次仍是这三个数字（幂等），若 `被改写天数` 大于 0，说明库里已有不同的值，先查是不是窗口重叠。

### 3.2 只补某一天

采集与入库都可以按天单独跑：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-daily.ps1 -Target 2026-10-19 -Pages trade-detail,flow-overview,item-rank
cd tools\collector
node .\scripts\export-daily-ingest.mjs --date 2026-10-19
```

**补采与首次采集写的是同一批行。** 同一业务日重复入库不会新增逐日行（`@@unique([shopId, statDate])`），只在值不同的时候把 `revised` 置真 —— 平台会回溯改数，这一列是那件事唯一的痕迹。判据是 `被改写天数`：正常情况下补同一天应为 `0`；为 `1` 说明平台改过数，属预期。

**单日 payload 的 `dimensions` 不是空的。** 窗口等于那一天：商品是当天的 Top 5、地域与搜索词是当天的分布、结构指标（跳失率、停留时长、加购人数）是当天的整段值。这些小窗口快照不会挤掉 30 天快照 —— 读接口按「与查询区间重叠最多」挑快照（`pickSnapshotIndex`），查「近 30 天」时仍然用 30 天那一份，查单日时才用单日那一份。

### 3.3 校验入库结果

```sql
-- 行数
select count(*) from ecom_daily_metrics;
select dim_type, count(*) from ecom_dimension_snapshots group by 1 order by 1;

-- 金额锚点一：30 天基线合计应等于 10,800,000 分（2026-09-19 ~ 2026-10-18）
select sum(pay_amount_fen) from ecom_daily_metrics
where stat_date between '2026-09-19' and '2026-10-18';

-- 金额锚点二：日增进来的某一天
select stat_date, pay_amount_fen, visitors, pay_byers, revised
from ecom_daily_metrics where stat_date = '2026-10-19';

-- 窗口是否两套并存（应当同时看到 30 天与逐日两种窗口）
select dim_type, stat_from, stat_to, count(*)
from ecom_dimension_snapshots group by 1, 2, 3 order by 1, 3 desc;

-- 最近批次
select trigger, status, daily_rows, dimension_rows, started_at, error_message
from ecom_collect_runs order by started_at desc limit 5;
```

---

## 四、故障判据

先分类，再动手。四类问题的长相很像，但改法完全不同。

| 现象 | 先看 | 结论 |
| --- | --- | --- |
| 看板数字停在几天前 | 页头新鲜度 + 采集记录面板 | 超过 26 小时 = 当天采集没跑成；超过 48 小时 = 采集机没开机 |
| 某页采集文件数是 1、大小 183 字节 | 那个文件是不是 `ipoll/activity/getCurrentTime` | 是则页面没发业务请求，等待时间不够（默认 60 秒） |
| 采集页面一直空 | `_manifest.json` 里该页的 `bodyHead` | 面包屑停在业务模块 = 路由通了，问题在数据没加载；被弹回首页才改导航方式 |
| 看板数字与后台对不上 | 先确认区间是否等于快照窗口 | 等于则用整段值（与后台一致）；不等于则用逐日求和（跨日重复访客会多算） |
| 页面显示「无权限」 | 账号是否有 `ops.finance.read` | 这是设计行为，不是缺陷；找管理员授予 |
| 页面整块报错、提示没有权限 | `ops.shop.read` | 成员默认没有此权限 |
| 接口 503 `ingest_disabled` | API 环境变量 `OPS_INGEST_TOKEN` | 未配置。设好重启 API，不影响读接口 |
| 接口 401 `invalid_token` | 采集器与服务端的 token 是否一致 | 不一致。token 只存环境变量，不入库不入 git |
| 接口 403 `forbidden_origin` | 请求来源地址 | 采集器必须与 API 同机（回环） |
| 接口 400 `invalid_daily` | 报错里的日期 | 该日期不在 `window` 内，改窗口或拆批次 |
| `db:ops-import` 报 `P2021` | `prisma migrate status` | 迁移没跑。`pnpm db:deploy` |

---

## 五、改代码后的最小验证

```powershell
# 门禁（必须在 projects/fanhe-work 下跑，且 DB 容器在跑）
pnpm test; pnpm lint; pnpm typecheck; pnpm format:check

# 迁移与种子（改了 schema 或 permissions 时）
pnpm db:deploy
pnpm db:seed

# 页面（改了前端时：构建产物 + 强重建容器，不是热更新）
pnpm build
..\..\infra\portable\ws-compose.cmd up -d --force-recreate api web
curl --noproxy '*' -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/
```

**本机 curl 必须带 `--noproxy '*'`**：不带时请求被送进代理，返回 HTTP 000 或 `upstream connect failed`，看起来像服务没起来。

### 5.1 改权限点或角色授权时，必须同时重建 migrate 镜像

`migrate` 服务跑的是「迁移 + 种子」，而它来自**同一个 Dockerfile 的另一个阶段**（`target: migrate`）。加权限点后只重建 `api` 与 `web`，`migrate` 还是旧镜像，它的种子脚本拿着**旧权限清单**去同步角色授权，于是日志里出现：

```
移除授权关联 6        ← 把刚加的三个 ops 权限点从 owner 与 admin 上摘掉
```

现象是「接口 403，权限配了不生效」，而 `permissions` 表里那三个点好端端地在（种子只删关联，不删权限点）。**判据是查库计数，不是看种子输出**：

```sql
select r.code, count(*) from role_permissions rp join roles r on r.id = rp.role_id group by 1;
-- 期望：owner 15、admin 12、member 6、viewer 3
```

正确的重建顺序（三个镜像一起）：

```powershell
..\..\infra\portable\ws-compose.cmd build migrate api web
..\..\infra\portable\ws-compose.cmd up -d --force-recreate migrate api web
```

---

## 六、何时该改契约

不改契约就能做的事：新增一个维度类型（`dim_type` 加枚举值 + 生产者多一段）、新增一个 `summary` 指标（加一行）、调整展示（改 `ops-display.ts`）。

必须改契约的事：改字段名、改单位、改窗口语义、把不可加的量放进 `daily`。第三种尤其危险：一旦跳失率进了 `daily`，区间求和会给出「跳失率 2100%」这种数字，而图表会照常画出来。

流程见 `docs/ops/DATA-CONTRACT.md` 第八节。
