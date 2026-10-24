# 店铺绑定与自动同步

> 2026-10-22 新增。对应代码：`apps/api/src/ops/shop-binding.ts`、`apps/api/src/ops/shop-slots.ts`、`apps/api/src/routes/ops.ts`、`apps/web/src/components/ops/OpsShopBindingPanel.tsx`、`tools/collector/scripts/sync-shops.mjs`

---

## 一、一句话说清它做了什么

在工作台里填四个字段（代号、名称、端口、掌柜），店铺就出现在看板的五店并列里；本机的采集器在下一轮轮询时自动采一次，数据经原有契约入库，看板自动出现该店的数据。**人不需要改配置文件，也不需要手工导入。**

---

## 二、绑定流程与既有逻辑的对接

| 步骤 | 发生什么 | 落点 |
| --- | --- | --- |
| 1 | 点「绑定店铺」，填代号/名称/端口 | `OpsShopBindingPanel` |
| 2 | `POST /api/ops/shops`，权限点 `ops.shop.bind` | `routes/ops.ts` |
| 3 | 校验代号（与采集器同一套正则）、名称、端口范围 | `shared/ops.ts` 的 `validateShopBindInput` |
| 4 | 查重：同代号启用中、同端口占用 → 409 | `shop-binding.ts` |
| 5 | 写 `ecom_shops`，置 `boundAt` 与 `syncRequestedAt` | Prisma |
| 6 | 把槽位写进 `tools/collector/shops.config.json`（能写就写） | `shop-slots.ts` |
| 7 | 采集器轮询待办，跑采集，回写登录态 | `sync-shops.mjs` |
| 8 | 采集产物走原有导出与入库，看板自动生效 | 既有链路，零改动 |

第 8 步是关键：**绑定不新增任何采集或入库代码**。采集器一直按 `code` 认店，看板一直按 `shopId` 出数，绑定只是把这两处原本手工维护的东西变成界面操作。

### 绑定之后怎么登录

绑定不会代登录（登录态绑在本机浏览器 profile 上，服务端代劳必触发风控）。界面上每一行都有「打开登录」：

| 宿主 | 行为 |
| --- | --- |
| 桌面外壳 | 调 `ops:shop-login` 通道，主进程起 `shop-login.ps1 -Shop <code>`，弹出带调试端口的 Edge |
| 浏览器 | 没有本机进程能力，退化成「复制命令」，粘贴到仓库根执行 |
| 找不到脚本 | 通道返回 `collector_missing`，界面把命令与配置落位显示出来，不让按钮点了没反应 |

**装在别的盘时怎么让它找到脚本**：主进程沿自己的安装目录向上找 `.ws-root` 标记
文件，跨盘必然断（实测本机安装目录在 `D:\fanhe work\@fanhedesktop`，工作区在
`E:\fanhe Work`）。这时写一个采集器配置：

```jsonc
// %APPDATA%\梵禾 Work\collector.json（安装态）
// 或工作区的 .config/fanhe-work/collector.json（开发态）
{ "root": "E:\fanhe Work\projects\fanhe-work\tools\collector" }
```

`root` 指向 `tools/collector` 本身或仓库根都认。也可以用环境变量
`FANHE_COLLECTOR_ROOT` 一次性覆盖。配置每次现读，改完不用重启外壳。

代号在主进程会被重新校验（它要拼进命令行，前端校验只算体验）。脚本以独立实参接收 `-Shop <code>`，不做字符串拼接。

### 为什么要写 `shops.config.json`

采集器认店靠文件、平台认店靠库，两份事实源是既有设计（采集器必须能在平台不可达时照常跑）。所以绑定必须同时改两处，否则会出现「库里有了、采集器不认识」的半成功状态。

API 跑在容器里时看不到宿主机仓库，这一步会返回 `manual` 并给出可直接粘贴的片段。**这不算绑定失败**：库里已经有这家店，补上槽位后采集器自然能采。

---

## 三、千牛字段与工作台位置的对应

采集端不读千牛客户端进程（CEF 不开调试端口、cookie 库是空表，详见 `QIANNIU-CAPTURE-2026-10-21.md`），读的是**生意参谋 Web 后台**，用 CDP 旁路录制接口响应。

| 千牛/生意参谋来源 | 原始接口特征 | 契约字段 | 库列 | 工作台位置 |
| --- | --- | --- | --- | --- |
| 支付金额 | `overview.json` 的 `payAmt` | `daily.payAmountFen` | `ecom_daily_metrics.pay_amount_fen` | KPI「支付金额」、趋势图 |
| 访客数 | `overview.json` | `daily.visitors` | `visitors` | KPI「访客数」、趋势图 |
| 支付买家数 | `overview.json` | `daily.payBuyers` | `pay_buyers` | KPI「支付买家数」 |
| 商品访客数 | `listareas` | `daily.itemVisitors` | `item_visitors` | KPI「商品访客数」 |
| 商品表现 | `item_view_top` | `dimensions[type=item]` | `ecom_dimension_snapshots` | 商品表现表 |
| 渠道结构 | `tree_platform_support` | `dimensions[type=channel]` | 同上 | 渠道列表 |
| 地域分布 | 地域页接口 | `dimensions[type=area]` | 同上 | 地域排行 |
| 搜索词 | `drainagesearch` | `dimensions[type=keyword]` | 同上 | 关键词榜 |
| 内容/直播 | 内容页接口 | `dimensions[type=content]` | 同上 | 内容板块 |
| 客单价、跳失率、停留时长、加购人数 | 各页整段值 | `dimensions[type=summary]` | 同上 | 概览摘要（整段口径，界面带徽标） |
| 店铺身份 | 采集器 `--shop <code>` | `shop.code` / `shop.name` | `ecom_shops` | 五店指标带、店铺切换 |
| 采集批次 | 采集器每次运行 | 不经契约 | `ecom_collect_runs` | 数据健康面板 |

两条纪律必须记住：

- **空不等于零。** 没采到的字段写 `null`，不补 0。补 0 会让日均被系统性拉低，且从数字上看不出来。
- **名称逐字一致。** ingest 的 upsert 会用 payload 里的 `name` 覆盖库里的名字，写错就是给店铺改名。

---

## 四、同步的触发时机与频率

| 触发 | 时机 | 说明 |
| --- | --- | --- |
| 绑定即同步 | 绑定成功后 1 分钟内 | 采集器轮询到 `syncRequestedAt` 就排进这一轮 |
| 手动同步 | 点「立即同步」 | 只置时间戳，不等待结果；界面显示「等待采集器」 |
| 每日定时 | 每天固定时刻 | 由计划任务跑 `run-daily.ps1` 或 `sync-shops.mjs` |
| 补采 | 人为指定日期 | `--date` 参数 |

**不承诺实时。** 生意参谋的日指标是 T+1，页面上本来就没有当天的最终值。任何方案都突破不了这条线，所以界面文案写「上次采集」，不写「实时」。

---

## 五、失败怎么处理

失败原因由采集器回写 `lastSyncError`，界面直接显示，不用翻脚本日志。

| 现象 | 回写 | 界面提示与下一步 |
| --- | --- | --- |
| 端口无响应 | `unknown` | 采集浏览器未启动，跑 `shop-login.ps1 -Shop <code>` |
| 退出码 3（被重定向到登录页） | `needs_login` | 去采集浏览器里登录一次 |
| 退出码 4（页面没加载出来） | `unknown` | 查 Edge、端口、首启向导，**不要重新登录** |
| 导出失败 | `authenticated` | 原始响应不完整，查 `data/daily/<code>/<日期>` |
| 入库被拒 | `authenticated` | 显示服务端给出的原因（窗口不合法、行数超限等） |
| 槽位缺失 | `unknown` | 把片段补进 `shops.config.json` |

`clearSyncRequest` 只在「这一轮确实处理过」时为真：采集中途崩溃不清待办，下一轮自动重试。

### 先跑自检，再逐项排查

「看板没有数」有五种可能，分散在库与机器两处。一条命令会把它们拼成一张表：

```
cd tools/collector
node scripts/doctor.mjs
```

输出五列：店铺、端口、浏览器可达、登录态、最近采集、待办、备注。末尾给结论与待办动作。`--json` 输出合并结果，供脚本判断。

判定分两级，这是有意的：

| 级别 | 含义 | 例子 | 退出码 |
| --- | --- | --- | --- |
| 阻断 | 会让已请求的同步永远等不到结果，或让数据安静地错 | 有待办但浏览器没开、端口与库不一致、库里没有这家店、登录态失效 | 1 |
| 提示 | 下次采集前需要处理，但现在不阻塞 | 夜间浏览器没开且无人请求同步、数据超过一天未更新、上次同步失败 | 0 |

采集浏览器的开关由人决定，凌晨没开是完全正常的。把它当阻断会让这个工具每天晚上都在报警，几次之后就被无视了 —— 一个总是报错的检查等于没有检查。

---

## 六、谁来跑轮询（部署必读）

「绑定后一分钟内自动同步」成立的前提是**有一个常驻进程在轮询待办**。三种起法：

| 方式 | 命令 | 适用 |
| --- | --- | --- |
| 常驻轮询 | `node scripts/sync-shops.mjs --watch 60` | 推荐。绑定后一分钟内生效 |
| 单轮 | `node scripts/sync-shops.mjs` | 手动补一次 |
| 只看待办 | `node scripts/sync-shops.mjs --dry-run` | 排查「为什么没同步」 |

注册成开机任务（推荐，注册脚本会处理好 node 查找、单实例与日志）：

```
powershell -NoProfile -ExecutionPolicy Bypass -File tools\collector\install-sync-task.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\collector\install-sync-task.ps1 -Status
powershell -NoProfile -ExecutionPolicy Bypass -File tools\collector\install-sync-task.ps1 -Remove
```

任务指向 `start-sync-watch.cmd` 而不是直接指向 node：查找 node、单实例守卫、日志轮转都在那个文件里，注册脚本只负责「什么时候启动它」。日志落在 `tools/collector/data/sync-watch.log`，超过 5 MB 轮转一份。

### 为什么用「重复触发 + 实例互斥」而不是「失败重启」

计划任务的「失败时重启」只覆盖调度器自己认定的失败。从外部杀掉进程（任务管理器、内存回收、误杀）之后任务停在 Ready，不会重启 —— 2026-10-23 实测过：杀掉后 `state=Ready`、`lastResult=4294967295`、没有任何 node 进程。

所以改成：登录时触发一次，另加一个每分钟重复的触发器；任务设置「不启动新实例」。若采集器活着，新的启动尝试被调度器直接忽略；若它死了，下一次触发把它拉起来。间隔取 1 分钟而不是 5：任务在跑时调度器根本不会启动新实例，所以密集一点也不花钱，而停机上限被压到一分钟 —— 五分钟的沉默足以让面板没来由地显示「离线」。实测：杀掉进程后 85 秒内自动出现新进程，`state` 回到 Running；另有一次 `0xC000013A`（控制台中断）退出，也在下一分钟被拉起。

两个细节容易踩：

- **重复触发器不能挂在登录触发器上。** 那样设置会被存下来，但 `NextRunTime` 为空、实际不触发（实测）。必须额外建一个 Once 触发器让它一开始就生效。
- **`tsx.cmd` 内部调的是裸 `node`。** 交互式终端里便携运行时的目录在 PATH 上，本地跑一切正常；由计划任务启动时 PATH 是系统基线，那里没有它，表现是「待办读不出来、心跳写不进去」，而界面上只显示「采集器离线」。`sync-shops.mjs` 已把当前 node 所在目录注入子进程 PATH，修的就是这一条。

### 两处必须对上

否则会出现「界面说在同步、采集器一直 401」这种静默失败：

- **传输方式**：默认 `auto`。先试 HTTP，被拒则自动切 DB 直连（见下）。
- **密钥**：`OPS_INGEST_TOKEN` 在容器栈的 `.env.compose` 里配置，脚本会先读环境变量、再读该文件。
- **接口地址**：默认 `http://127.0.0.1:8787`，容器栈把 api 绑在回环的这个端口上。

### 怎么知道采集器在不在跑

面板里店铺列表上方有一行状态：`采集器在线` / `采集器离线` / `采集器从未启动`。

心跳不设独立接口，**「有人来拉待办」本身就是心跳**：常驻进程每一轮都会问「有没有待同步的店」，那个动作已经证明它还活着。HTTP 与 DB 直连两条路各写一次同一个 `touchCollectorHeartbeat`，所以换传输方式不会让心跳断掉。

判定窗口是 3 分钟（`OPS_COLLECTOR_ONLINE_WINDOW_MS`），即容忍两次丢拍。三态分开是有意的：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| 采集器在线 | 3 分钟内有心跳 | 无需动作 |
| 采集器离线 | 有历史心跳但已超窗口 | 进程掉了，重启常驻任务 |
| 采集器从未启动 | 一次心跳都没有 | 还没注册计划任务，按上一节的命令起一次 |

把后两者合成一句「离线」，会让人去重启一个从来没存在过的进程。

### 为什么容器化之后走 DB 直连

采集入口的鉴权是「token + 回环」。容器化之后宿主机经 `127.0.0.1:8787` 进来，容器看到的源地址是 docker 网关（172.x），`isLoopbackAddress` 判否，接口按设计返回 `403 forbidden_origin`。这不是配置错误：那条校验本来就不接受跨网络边界的调用。而采集器必须跑在宿主机上（要连本机 Edge 的调试端口），永远在边界之外。

所以 `sync-shops.mjs` 有两条传输路径，`auto` 会先试 HTTP、被拒后自动降级，并在日志里说明原因：

| 传输 | 读待办 | 入库 | 回写状态 |
| --- | --- | --- | --- |
| `http` | `GET /api/ops/shops/pending` | `POST /api/ops/ingest` | `POST /api/ops/shops/:code/state` |
| `local` | `tsx src/tools/ops-shop-pending.ts` | `tsx src/tools/ops-import.ts` | `tsx src/tools/ops-shop-state.ts` |

两条路走的是同一批函数（`listPendingShopCodes` / `ingestOpsSnapshot` / `reportShopState`），不存在两套校验或两种口径。这与既有的 `db:ops-import` 是同一个思路：计划任务不该被 HTTP 可用性绑架。

强制指定用 `--transport local` 或 `--transport http`；`--transport http` 时被拒就直接失败，不做降级，便于排查密钥问题。

没配密钥时 `POST /api/ops/ingest` 与待办接口都返回 503，这是设计行为（看板与页面不受影响）。此时绑定仍然成功，同步会在下一轮自动改走 DB 直连。

## 七、多店铺的隔离与归属

| 层 | 隔离键 | 越界的后果 |
| --- | --- | --- |
| 数据库 | `ecom_shops.code`（唯一） + `shopId` 外键 | 两家店的数据混在一行 |
| 浏览器 | 一店一个 `user-data-dir`、一个调试端口 | 后登录的店把前一家顶下线，采到的数据顶着别人的名字 |
| 采集产物 | `data/daily/<code>/<日期>` | 覆盖另一家店的原始响应 |
| 平台侧 | `collectPort` 唯一约束（启用中的店） | 两家店抢同一个调试端口 |
| 权限 | `ops.shop.read` 看数、`ops.shop.bind` 改配置 | 能看报表的人顺手改掉采集链路 |

`--shop` 与目录所属店不一致时导出脚本直接 `exit 1`：串店不会报错，只表现为主店数字翻倍。

---

## 八、尚未覆盖的部分

- **首次登录仍需人工。** 绑定不会自动登录：登录态绑定在本机浏览器 profile 上，服务端代劳会立刻触发风控。
- **容器部署下槽位要手工补。** 界面上会给出片段。
- **按人归属尚未实现。** 当前所有持有 `ops.shop.read` 的账号看到同一批店铺；`ecom_shops` 没有 owner 列。
