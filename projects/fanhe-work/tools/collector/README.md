# 千牛运营数据采集器（tools/collector）

本目录是「千牛运营数据」板块的**采集端**。它只做一件事：从生意参谋 / 千牛后台把前一天的数据取下来，
落成原始文件，再按统一契约交给平台侧入库。它不属于梵禾 Work 的运行时（不进 API 进程、不进 Electron 主进程），
也不参与前端构建。

## 一、为什么单独一层

三个理由，都是踩过的：

1. **采集必须跑在有登录态的机器上。** 生意参谋有 baxia 风控，页面内注入 `fetch` / `XMLHttpRequest` 一律
   返回 `TypeError: Failed to fetch`。唯一可行路径是让页面自己发请求，再从 CDP 的 `Network` 事件旁路截取
   响应体。这条路要求一台开着带调试端口的 Edge、且已人工登录的 Windows 机器。
2. **清洗规则会反复调，采集代码不该跟着重打包。** 口径（哪个字段是逐日、哪个是整段）改一次，只重启 API
   即可；采集器本身不用重新分发。
3. **采集挂了不能拖垮平台。** 采不到数据只表现为「看板停在昨天」，API 与页面照常可用，新鲜度徽标会变黄。

## 二、目录

```
tools/collector/
├─ scripts/                     采集 / 探针 / 校验 / 转换 / 截图
│  ├─ collect-daily.mjs         ★ 日增采集（只抓前一天），输出 data/daily/<日期>/
│  ├─ collect.mjs               30 天基线采集，csv30 的来源，不要日常跑
│  ├─ check_daily.mjs           日增门禁：按页判 PASS / WARN / FAIL，有空采时退出码 1
│  ├─ probe-page.mjs            单页探针：页面发了哪些请求、统计时间是什么
│  ├─ run-daily.ps1             一条命令串起「起 Edge → 采集 → 收尾」
│  ├─ build_preview_data.mjs    csv30 → 原型页面常量（视觉对照用）
│  ├─ check_data.mjs            页面常量与 csv30 对账（11 组 + 4 个金额锚点）
│  ├─ build_csv.py              原始 JSON → CSV
│  ├─ build_xlsx.py             CSV → 多页签报表（需要 openpyxl 解释器）
│  ├─ shots-all.ps1             无头 Edge 批量截图（不需要调试端口）
│  └─ lib/preview-source.mjs    页面数据与对账共用的唯一取数入口
├─ data/csv30/                  ★ 2026-09-19 ~ 2026-10-18 的 30 天基线，17 个模块目录 67 张 CSV
│                               这是回填与回归的**唯一可信输入**，入库桥接读的就是它
├─ data/ingest/                 由 csv30 导出的入库契约 JSON（可重生成，不进版本库）
├─ preview/                     原型单文件 HTML，视觉与交互的参照物
├─ docs/                        采集口径与页面设计的原始文档，见第六节
├─ start-edge-debug.cmd         起一个带 9222 调试端口的 Edge（采集前置）
└─ .gitattributes               全目录按字节原样存储（CSV 带 BOM，行尾不能改写）
```

`data/raw*/`、`data/daily/`、`.browser-profile*/`、`preview/*.png`、`output/*.xlsx` 都不进版本库。

## 三、与平台的边界

数据只朝一个方向流，契约是 `apps/api/src/ops/ingest.ts` 的入参（同时定义在 `packages/shared/src/ops.ts`）。

```
生意参谋后台
   │  CDP 旁路录制（脚本在这里，只在有登录态的机器上跑）
   ▼
data/daily/<日期>/<模块>/NN_<接口>.json     原始响应，原样落盘，不改写
   │  scripts/build_csv.py  或  scripts/export-ingest.mjs（回填）
   ▼
契约 JSON（ops-ingest.v1）
   │  POST /api/ops/ingest   （回环 + x-ops-token）
   ▼
PostgreSQL  ecom_* 四张表  →  GET /api/ops/*  →  /ops/dashboard
```

三条边界纪律：

- **采集端不做去重与合并。** 一天一个目录，覆盖写。增量、去重、`revised` 判定都在 API 侧，
  因为那里才看得到「上一版是什么」。
- **采集端不碰数据库、不认 Prisma。** 契约 JSON 是唯一交接物，两边可以独立演进。
- **金额一律换成「分」。** 平台接口返回分，报表导出元。换算只发生一次，在导出契约时完成，
  之后任何一层都不再乘除 100。

## 四、日常运行

```powershell
# 采前一天（默认 T-1），17 页全量
powershell -ExecutionPolicy Bypass -File .\scripts\run-daily.ps1

# 只采两页、指定日期
powershell -ExecutionPolicy Bypass -File .\scripts\run-daily.ps1 -Pages trade-detail,qos-core -Target 2026-10-19

# 采完复核（FAIL 判定为某页 0 个文件，WARN 为只有 1 个或小于 800 字节）
node .\scripts\check_daily.mjs --date 2026-10-19
```

前置条件，缺一不可：

1. Edge 存在（脚本按 32 位 / 64 位 / 用户级三处依次探测）。
2. Node 22 以上（脚本用原生 `WebSocket`）。
3. 已人工登录生意参谋。`.browser-profile` 里的 cookie 由 Windows DPAPI 加密，**换机器必然失效**，
   每台机器都要跑一次 `start-edge-debug.cmd` 手动登录。脚本从不保存账号密码。

## 五、常见故障的判据

| 现象 | 先看什么 | 结论 |
| --- | --- | --- |
| 采集用时很短，文件数是 1、大小 183 字节 | 那个文件是不是 `ipoll/activity/getCurrentTime` | 是则页面根本没发业务请求，等待时间不够（默认 60 秒） |
| 某页一直空 | `_manifest.json` 里这页的 `bodyHead` | 面包屑停在业务模块说明路由通了，问题在数据没加载；被弹回首页才需要改导航 |
| 端口起不来 | `netstat -ano | findstr 9222` | 为空说明存根进程占着同一个 user-data-dir，参数被吞了 |
| 页面数据与后台对不上 | `check_data.mjs` 的四个金额锚点 | 锚点先过，再查采集批次；不要先去改计算公式 |

## 六、口径文档（改动前必读）

| 文档 | 作用 |
| --- | --- |
| `docs/新增指标采集映射清单.md` | 20 项指标的采集落点、字段命名、六批实施顺序 |
| `docs/看板原型交付说明-v3.md` | 页面结构、四档口径（逐日 / 折算 / 整段 / 演示）、交互约定 |
| `docs/千牛店铺数据抓取与运营分析方案.md` | 通道选型与指标定义的最初论证 |
| `docs/项目架构与问题分析-2026-10-20-第二轮.md` | 现有 20 个脚本逐个说明，改脚本前先读 |
| `docs/大屏切店数据异常分析与整改方案-2026-10-20.md` | 切店缩放的口径陷阱（12 组常量必须同步缩放） |
| `docs/服务体验数据加载异常分析与整改-2026-10-20.md` | 服务板块为什么长期没有真实值 |
| `docs/HANDOFF-2026-10-19.md` | 换机恢复的完整步骤（含 12 个坑的复现条件） |

平台侧的契约、运行手册与路线图在 `projects/fanhe-work/docs/ops/`，两边文档不互相抄，只互相指。
