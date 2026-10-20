# 运营数据 · 运行手册

> 版本：v1，2026-10-20
> 适用对象：负责每天让看板有数的人，以及被叫去排查「昨天为什么没数」的人。

---

## 一、每天要做的事

只有两步，都在**装有千牛登录态的那台 Windows** 上。

```powershell
# 1. 采集前一天（17 页全量，约 15 分钟；默认等每页 60 秒）
cd tools\collector
powershell -ExecutionPolicy Bypass -File .\scripts\run-daily.ps1

# 2. 复核（FAIL 表示某页 0 个文件，WARN 表示只有 1 个或小于 800 字节）
node .\scripts\check_daily.mjs --date 2026-10-19
```

然后把数据交给平台侧入库（两条路选一条）：

```powershell
# 0. 首次部署：建四家分店的「占位行」（无数据，界面显示「待接入」）
#    幂等，可重复执行；主店由采集器建档，不在这里创建
cd ..\..\projects\fanhe-work
pnpm db:ops-shops

# A. HTTP（推荐，日常）
#    采集器 → 契约 JSON → POST /api/ops/ingest
#    OPS_INGEST_TOKEN 必须先在 API 侧配好

# B. 直接回填（本机开发 / 新机初始化）
cd tools\collector
node .\scripts\export-ingest.mjs          # 只在已经有 csv30 的情况下用
cd ..\..\projects\fanhe-work
pnpm db:ops-import
```

**当前实现的边界**：日增采集（`data/daily/<日期>/` 的原始 JSON）还没有自动转成契约 JSON 的脚本 —— `export-ingest.mjs` 读的是 `data/csv30` 这份 30 天基线。日增入库前需要一个适配器（`build_csv.py` 的产物 → 契约），这一步尚未编写，属于 B 批采集的同批工作。**不要把「跑完 run-daily」当成「看板会有今天的数据」。**

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

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-daily.ps1 -Target 2026-10-19 -Pages trade-detail,qos-core
```

单日入库时 `window` 与 `daily` 只有一行，`dimensions` 应当为空 —— 维度是整段口径，单日采集拿不到。

### 3.3 校验入库结果

```sql
-- 行数
select count(*) from ecom_daily_metrics;
select dim_type, count(*) from ecom_dimension_snapshots group by 1 order by 1;

-- 金额锚点：30 天合计应等于 10,800,000 分
select sum(pay_amount_fen) from ecom_daily_metrics
where stat_date between '2026-09-19' and '2026-10-18';

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
