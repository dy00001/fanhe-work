# sycm-cli 替换现有采集方式可行性评估

> 评估日期 2026-10-25。对象为 `rakei076/sycm-cli`（75★，2026-10-24 更新，MV3 取数桥 + Python CLI），对照现有 `tools/collector` 的 CDP 旁路录制方案。
> 结论先行：**整体替换不可行；作为旁路补充局部引入可行。**

## 一、结论

三条独立理由，任何一条单独成立都足以否掉整体替换。

1. **维度覆盖对不上。** 现有 6 个维度中只有 `item` 有直接对应命令，`channel`、`area`、`keyword`、`summary` 需要退回到 `api` 裸探测并重写解析器，`content` 被桥的域名白名单硬阻断。
2. **多店并行不可行。** 取数桥是单机单实例模型，配合机器级全局锁与固定端口扫描，与现有四店并行采集在结构上互斥。
3. **退出码语义冲突。** 直接替换后，风控会被现有分类逻辑读成登录失效，触发错误的人工处置。

局部引入可行，且价值明确：客服会话与单品深度分析这两块现有链路完全没有，`sycm-cli` 有成熟命令。

## 二、两套实现的结构差异

| 项目 | 现有 collector | sycm-cli |
|---|---|---|
| 语言与运行时 | Node 22，零外部依赖（内置 http + 全局 WebSocket） | Python 3.10+ 或 uv，7 个第三方包 |
| 浏览器接入 | Edge 每店独立 profile，CDP 调试端口 | Chrome 装 MV3 插件，插件轮询本机端口 |
| 取数方式 | 打开页面，旁路录制页面自己发出的 XHR 响应 | 由插件在页面里代发脚本化请求 |
| 数据形态 | 原始响应原样落盘，解析后置 | 命令级结构化 JSON，字段已提取 `.value` |
| 账号隔离 | 一店一份 profile，DPAPI 绑本机账户 | 一个浏览器内多账号命名切换 |
| 并发 | 四店可并行，各占一个调试端口 | 机器级串行，全局锁排队 |
| 跨域 iframe | 通过 `Target.setAutoAttach` 自动附加子 target | 不涉及，白名单内无该域名 |

## 三、运行环境

现有链路的前置条件是「目标店铺槽位的 Edge 已启动并已登录生意参谋」，`collect-daily.mjs` 自己判登录态并写 `_preflight.json`。整条链路由 Node 承担，随工作区一起走，换机只需要恢复 Node 与 junction。

`sycm-cli` 的前置条件变成三件：Chrome 已登录、插件已加载、Python 环境可用。三者任一缺失都是硬停。插件加载有额外约束，`extension/README.md` 明确要求「插件从哪个文件夹加载，就不要删除或移动那个文件夹」，且 Windows 每次开 Chrome 可能弹「停用开发者模式的扩展程序」。

对工作区的具体影响：

- 新增一整套 Python 运行时与 `.runtime/` 自包含目录，脱离现有 `test`、`lint`、`typecheck`、`format:check` 四道门禁。这部分代码在仓库里等于不受门禁保护。
- `uv` 在沙箱内会把 Python 装到 `AppData\Roaming\uv\python`，其自身文档记录的失败现象是「拒绝访问」，处置方式是改用 `scripts\sycm.cmd doctor`。这与本工作区「沙箱只允许访问工作区」的既有约束是同一类问题。
- 计划任务形态要改。现有 `install-sync-task.ps1` 调的是 Node 脚本，替换后要调 `sycm.cmd`，而 `.cmd` 在非交互计划任务下的工作目录与编码行为需要单独验证。

严重度：中。可解，但要接受第二套工具链长期共存。

## 四、依赖兼容性

`requirements.txt` 实际清单：`browser-cookie3`、`curl-cffi`、`websocket-client`、`mcp~=2.3`、`openpyxl`、`Pillow`、`jinja2`。

逐项判断：

| 依赖 | 用途 | 对本项目的意义 |
|---|---|---|
| `browser-cookie3` | Mac 直读 Chrome cookie | Windows 走插件路径，用不到，但会照装 |
| `curl-cffi` | 非插件路径直调接口 | 同上，Windows 基本闲置 |
| `websocket-client` | 部分接口走 WS | 需确认是否落在生意参谋链路上 |
| `mcp~=2.3` | MCP 接入 | 本项目已有自己的 API 层，用不到 |
| `openpyxl`、`Pillow`、`jinja2` | Excel 与网页报告 | 本项目已有 Excel 与前端能力，重复 |

依赖本身没有版本冲突，因为运行在独立 Python 环境里，与 pnpm monorepo 不共享任何依赖树。真正的成本不是冲突，是冗余：7 个包里有 5 个在本项目路径上用不到，`curl-cffi` 含 C 扩展，需要匹配的二进制 wheel，Python 3.13 下要单独验证。

一个必须提前确认的点：`mcp~=2.3` 这个版本约束较新，需要在实际环境中跑一次 `uv pip install` 确认可解析，不要假设。

严重度：中。不阻断，但引入了一个与 Node 生态平行的依赖面。

## 五、端口对接

这是最容易在纸面上看漏、在联调时卡住的一节。

**端口分配。** `bridge.py` 里 `DEFAULT_PORT_RANGE = (47831, 47840)`，逐个尝试取第一个可用端口。现有端口占用是 8787（api）、5173（web）、9222 起（Edge CDP，每店一个）。47831 到 47840 与现有占用不冲突。

**握手协议。** 插件在 `background.js` 里把 `PORTS` 硬编码成同样这 10 个端口，`findBridge()` 顺序探测，返回第一个 `/hello` 应答且 `app` 匹配 `^[a-z]+-cli$` 的服务。也就是说，一台机器上只会有一个 CLI 服务被认到，先起来的那个赢。

**鉴权。** 请求必须带 `X-Dmp-Bridge: <插件 ID>` 自定义头，或预检时带 `chrome-extension://<ID>` 的 Origin。允许的 ID 是硬编码两个，`gifdenhgccikkfbodclkdbohicghfhco`（开发包，manifest 里带固定公钥）与 `ecahndljpkaakkjofejgcjnikikcemni`（商店版）。这条设计对我们是正面的，普通网页伪造不了来源。

**私有网络访问。** 服务端在预检与响应里都设了 `Access-Control-Allow-Private-Network: true`。这是 Chrome PNA 的必需项，漏了会在新版 Chrome 上被拦，`sycm-cli` 已经处理。

**真正的冲突在并发。** `_lock_path()` 的注释写得很直白：「排队锁：整台电脑一把（插件只有一个，装了几份工具也要排同一个队）」。配合 `BridgeLock.WAIT = 15 * 60`，第二个命令要排队等前一个跑完。

叠加 `saw_instance()` 与 `_check_instance()`：一旦检测到两个插件实例在线，命令行直接抛 `PluginChanged`，本次数据作废。而我们的多店方案是四个 Edge profile 同时开着。四个 profile 都装插件，就是四个实例，必然作废；只给一个 profile 装，那另外三店就没有取数通道。

用 `BRIDGE_PORT` 环境变量绕开锁也不行，插件只扫 47831 到 47840 这 10 个固定端口，换到范围外它永远找不到服务。

严重度：阻断。这是架构层面的互斥，不是配置能绕过的。

## 六、数据反馈

现有契约是 `ops-ingest.v1`，逐日一行加维度快照。`EcomDailyMetric` 四个字段：`payAmountFen`、`visitors`、`payBuyers`、`itemVisitors`。`EcomDimensionType` 六个取值：`item`、`channel`、`area`、`keyword`、`content`、`summary`。

按 `required-endpoints.mjs` 声明的六个必须接口逐个对照：

| 维度 | 现有必须接口 | sycm-cli 对应 | 判定 |
|---|---|---|---|
| item | `item_view_top` | `item-list`，同用 `/cc/item/view/top.json` | 直接对应，接口一致 |
| channel | `tree_platform_support` | 无店铺级命令，`item-flow-source` 是单品级 | 需 `api` 裸探测并重写解析 |
| area | `listareas` | 无店铺级命令，`item-profile --by province` 是单品级 | 需 `api` 裸探测并重写解析 |
| keyword | `drainagesearch` | 无店铺级命令，`item-title` 是单品级 | 需 `api` 裸探测并重写解析 |
| content | 跨域 iframe `web.taobao.com` | 插件 `SITES` 无该域名 | 硬阻断 |
| summary | qos 四页 | `item-service` 是单品级 | 需 `api` 裸探测并重写解析 |

`content` 这一条是硬阻断。现有采集器的注释记录了实测结论：「内容页 / 服务体验页的真实应用挂在跨域 iframe 里（实测 content-overview 的 iframe 是 `https://web.taobao.com/s-guanghe-creator/asset-overview`）」，采集器靠 `Target.setAutoAttach` 附加子 target 才能拿到。插件的 `SITES` 只登记了 `dmp.taobao.com`、`myseller.taobao.com`、`sycm.taobao.com`、`one.alimama.com`、`item.taobao.com` 五个发射台，`web.taobao.com` 不在其中，`bridge.py` 的 `_url()` 也会按 `Platform.hosts` 前缀拒绝。这条路径在插件模型下没有对应实现。

**逐日指标**反而最容易接。`home-overview` 直接给 `payAmt`、`uv`、`payByrCnt`，与 `payAmountFen`、`visitors`、`payBuyers` 一一对应。`itemVisitors` 需要另找来源，`home-overview` 不直接提供，需实测确认。

**单位换算**是明确的坑。现有契约用「分」，`payAmt` 是「元」。`ingest.ts` 的注释写着「单位换算在采集侧的导出契约里完成了，再换一次就会有人把分当元乘除两遍」。适配层必须只在一处乘 100。

**退出码语义冲突**是最危险的一条，因为它不报错，只误诊。

| 退出码 | 现有 `collect-daily.mjs` | `sycm-cli` |
|---|---|---|
| 0 | 全部采到 | 成功 |
| 1 | 参数错误 | 无法产出 |
| 2 | 有页面重试后仍偏薄 | 登录失效 |
| 3 | 登录态检查未通过 | 触发风控 |
| 4 | 页面没加载出来 | 未定义 |

`sync-shops.mjs` 的失败分类是按现有语义写的，退出码 3 映射到「登录态失效，去采集浏览器里登录一次」。直接替换后，风控会被读成登录失效，界面会让人去重新登录一个其实有效的账号。这与 10-20 那次「把账号限流当成脚本 bug 查了很久」是同型误判，只是方向反过来。

严重度：高。契约重写的工作量本身可估，误诊的代价不可估。

## 七、请求节奏与风控模型

这一条需要辩证看。

`sycm-cli` 的护栏是 1.8 到 3.5 秒随机间隔、200 次请求提醒、风控词熔断（`滑块`、`验证码`、`操作过于频繁`、`请重新登录`）、连续 2 次 HTTP 失败即停。它需要这些护栏，因为它的取数方式是脚本化请求，请求形态集中。

现有方案走的是「打开页面让页面自己发请求」，天然接近人工浏览，所以没有请求级护栏也能长期稳定。代价是慢，17 页每页等 60 秒，单店一轮 17 到 25 分钟，且页面加载不稳定要靠重试自愈。

换句话说，护栏多不构成优势，那是取数方式带来的必要成本。替换后单店会更快，但请求形态更集中，风控面从「页面加载失败」变成「请求被判定为高频」。这两种失败的可观测性不一样，前者有 `_preflight.json` 和 manifest 留痕，后者只有退出码 3。

严重度：中。需要重新建立失败样本基线，不能沿用现有判据。

## 八、可行的引入方式

不做整体替换，做两条旁路。

**旁路一：客服会话。** `fetch-recent --date --limit --out` 一条命令拿到会话列表加完整对话，输出结构已文档化。现有 17 页里没有任何客服对话能力，`qos-*` 只覆盖服务体验指标。这块独立价值最高，且不需要接 `ops-ingest`，落本地文件供分析即可。

**旁路二：单品深度分析。** `item-360`、`item-sku-list`、`item-flow-source`、`item-refund`、`item-detail`、`item-title`、`item-service` 这一组。现有 `item-rank` 只有排行，没有单品下钻。

两条旁路的接入约束：

- 独立目录，不进 `data/daily/<shop>/<date>/`，避免污染现有 manifest 与校验。
- 不接 `ops-ingest.v1`，先作为分析输入。
- 只在一个浏览器 profile 里启用插件，且不与四店并行采集同时跑，否则触发实例冲突。

## 九、如果要长期演进，值得吸收的是设计而非运行时

三条，按价值排序。

1. **请求级账号一致性校验。** `BridgeSession` 每次请求前后比对 `who` 与 `whoAfter`，中途换号直接作废整条命令；`instance` 编号再兜一层。现有方案靠 manifest 里的 `shop` 字段与目录隔离，属于批次级校验，没有请求级校验。
2. **只读接口白名单的粒度。** 插件按平台登记 `ALLOWED` 前缀、`POSTS` 精确路径、`WRITE` 写操作词，三层叠加。现有方案用 `DATA` 与 `NOISE` 两条正则做白名单，粒度粗，靠 `WRITE` 词表这道护栏是缺的。
3. **把现场写进结果。** 每次结果附带 `tab`、`attempts`、`ms`、`plugin_ms`，排查「发射台停在别处」这类问题时有据可查。现有方案把现场写进 manifest，思路一致，可以互相借鉴字段。

## 十、决策建议

**短期（本次不动）：** 不引入。理由是多店并行这条结构冲突无法在配置层解决，而现有链路 2026-10-24 刚发到 0.3.4，处于稳定期。

**中期（如果客服质检或单品诊断进需求）：** 按第八节做旁路，单店串行，独立目录。

**长期（如果考虑整体迁移）：** 前置条件是先解决多店账号模型。要么放弃四店并行改串行，要么等上游支持多实例。在此之前整体替换的收益抵不过重写解析层与重建失败基线的成本。

**不建议做的事：** 把 `sycm-cli` 的命令输出直接塞进 `ops-ingest.v1`。五个维度需要裸探测重写、单位换算只有一处能改、退出码语义需要重新映射，这三件事同时做，出错时无法区分是解析错还是语义错。

## 附：证据索引

- 桥接协议与端口：`rakei076/sycm-cli` 的 `tb/core/bridge.py`
- 插件端口扫描与白名单：`extension/unpacked/background.js`、`extension/unpacked/manifest.json`
- 依赖清单：`requirements.txt`
- 命令覆盖：`功能清单.md`、`tools/sycm.md`
- 现有采集：`tools/collector/scripts/collect-daily.mjs`、`scripts/sync-shops.mjs`、`scripts/lib/required-endpoints.mjs`
- 入库契约：`apps/api/src/ops/ingest.ts`、`apps/api/prisma/schema.prisma`（`EcomDailyMetric`、`EcomDimensionSnapshot`）、`packages/shared/src/ops.ts`
