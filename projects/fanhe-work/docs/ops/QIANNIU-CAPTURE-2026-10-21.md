# 千牛工作台直接取数：可行性验证与技术路径

日期：2026-10-21
范围：在本机已登录的千牛客户端（3 个账号 / 7 个多开实例）内直接获取生意参谋经营数据
结论性质：**实测验证**。文内每条「事实」都标了证据来源，未验证的明确标注「未验证」。

---

## 一、结论先行

| 路径 | 能否拿到结构化数据 | 代价 | 建议 |
| --- | --- | --- | --- |
| A. CEF 注入 / 开 CDP 调试端口 | **不能**（已证伪） | — | 放弃 |
| B. 系统代理 + 本地 CA 中间人 | **能**，且拿到的是页面收到的原始 JSON | 需装根证书 + 改系统代理，侵入性最大 | 仅当你坚持「不登录浏览器」时才走 |
| C. UI 自动化读已渲染界面 | **部分能**（KPI 文本可读，图表 canvas 读不到） | 零证书，但脆弱、慢 | 可作旁路校验 |
| D. Edge 每店独立 profile + CDP 抓响应 | **能**，已在跑 | 每店一次扫码 | **推荐，维持现状** |

一句话：**千牛客户端里没有任何「受支持的取数出口」**。它能把生意参谋渲染给你看，但登录态在内存里、调试端口只对小程序开、自带代理只作用于登录窗口——三条口子全部实测堵死。真要从中取结构化数据，只剩中间人解密一条路。

---

## 二、实测事实与证据

### 2.1 生意参谋确实在千牛窗口内加载

| 事实 | 证据 |
| --- | --- |
| 工作台入口页 | `https://qn.taobao.com/home.htm/op-sycm-data/`（`app.log` 的 `ability.workbench.tab.change`，`fromPluginId=bench`） |
| 实际页面 | `https://sycm.taobao.com/portal/home.htm?spm=...`，由 `PageContainerPresenter.cpp(304) OnNewWindow` 新建窗口打开 |
| 加载成功 | `OnLoadEnd httpStatusCode=200`（`WebControl.cpp(1256)`） |
| 渲染方式 | `WebControl.cpp(729) Create`，即 **CEF webview**，不是小程序 |
| 页面按账号隔离 | 创建参数 `user_identity=3#3965512335`，UID 与账号一一对应 |

也就是说：**千牛的 CEF 里确实有一份有效的生意参谋会话**，能正常打开 `/flow/monitor/overview`、`/cc/item_rank`、`/flow/monitor/shopsource/construction` 等页面——正是我们采集的那 17 个页面里的路径。

### 2.2 登录态是内存态，磁盘上没有

| 检查项 | 结果 |
| --- | --- |
| CEF cookie 库（7 个实例） | 全部 20480 字节，**淘系域名 0 条**，空表 |
| CEF 磁盘缓存 | 只有 Google 拼写词典（`*.bdic`），**没有一条 taobao / sycm / mtop 记录** |
| 浏览历史 | `History` 表 `urls=0` |
| Local Storage | 0.1–0.7KB，无站点数据 |
| 真实凭据位置 | `D:\AliWorkbenchData\AuthSDK\CGX`（3820 字节加密 token） |
| 旁路凭据缓存 | `XNetData\TBCache\xnet_ck_cache.dat`（288 字节，容量上不可能是完整 cookie jar） |

**含义**：千牛用自己的 AuthSDK 登录，登录成功后把会话注入 CEF 的内存 cookie manager，不落盘。所以「关掉千牛、复制 cookie 库、解密导出」这条路从源头就没有东西可拷——这解释了上一轮导出工具为什么拿到空表。

### 2.3 官方调试端口存在，但覆盖不到生意参谋

`D:\千牛\9.97.86N\v8resource\setting.json` 是阿里巴巴官方文档里的调试开关：

```json
{
  "log_level": 1,
  "debug": {
    "*": { "enable": false, "framework": 9224, "app": 9225 }
  }
}
```

它是**小程序（Windmill 运行时）**的调试端口。实测这台机器上跑过的小程序 appId 只有 `2134` 和 `10000990`（`app.log` 的 `[MINIAPP]` 段），**生意参谋不在其中**——它是 `WebControl`。所以即使打开这个开关，9224/9225 上也不会出现 sycm 页面。

当前 9225 未监听，CEF 启动参数里也没有 `--remote-debugging-port`，没有 `DevToolsActivePort` 文件。

### 2.4 自带代理配置只作用于登录窗口

`D:\AliWorkbenchData\System\proxy.xml`（`bUse` / `type` / `host` / `port`）看似是给整客户端用的代理。实测：

1. 备份原文件，改为 `bUse=1, type=0, host=127.0.0.1, port=8899`，起一个只记录域名、原样 TCP 转发的代理；
2. 启动一个**新的**千牛窗口（不动已有窗口）；
3. 结果：**代理 0 条连接**；
4. 改 `type=1` 再启动一个新窗口：**仍然 0 条连接**。

日志给出了原因——代理只在登录流程被读取：

```
[LOGIN #global#0][login_uic_init][ "Proxy"=Proxy,type=0 ][AppUICLoginService.cpp(851)]
[LOGIN #global#0][uiclogin][ type=0,"SetProxy"=SetProxy ][UICServiceWin.cpp(553)]
[LOGIN #global#0][uiclogin][ "DoLoginProxy"=DoLoginProxy ][UICServiceWin.cpp(769)]
```

`UICServiceWin` 是统一登录中心窗口。**网页浏览流量不走这个代理。**

（实验已完整回滚：`proxy.xml` 恢复原内容，测试窗口与其 CEF 子进程全部关闭，原 6 个实例、3 个账号未受影响。）

### 2.5 客户端有反篡改与内置远程诊断

| 项 | 说明 |
| --- | --- |
| `D:\千牛\9.97.86N\SafeGuard\` | 反篡改模块目录 |
| `ha-remote-debug` ACCS 服务 | 阿里自己的远程诊断通道（`AccsService.cpp(570)`），不对外开放 |
| 已知社区结论 | 看雪《某宝千牛浏览器开启远程调试》记录：`AliWorkbench.exe` 有反调试，x32dbg 挂上即退出；命令行加 `--remote-debugging-port` 无效（浏览器由程序代码启动），只能改内存 |

### 2.6 数据网关

`app.log` 里 `acs.m.taobao.com` 出现 4710 次，是统一的 mtop 网关；`sycm.taobao.com` 124 次。生意参谋页面的 XHR 走 mtop 协议（`h5api`，带 `_m_h5_tk` token 与 `sign` 签名）。

---

## 三、路径 B：系统代理 + 本地 CA（唯一能拿到结构化数据）

### 3.1 为什么这条路可行

CEF 的启动参数里**没有** `--proxy-server`、也没有 `--no-proxy-server`。Chromium 在两者都缺省时的默认行为是**使用 Windows 系统代理设置**。所以只要把系统代理指向本地，千牛 webview 的请求就会进来。

### 3.2 最小侵入设计

不要全局改代理，用 **PAC 只劫持淘系域名**：

```javascript
function FindProxyForURL(url, host) {
  if (shExpMatch(host, "*.taobao.com") ||
      shExpMatch(host, "*.tmall.com") ||
      shExpMatch(host, "*.alicdn.com") ||
      shExpMatch(host, "*.alibaba.com")) {
    return "PROXY 127.0.0.1:8899; DIRECT";
  }
  return "DIRECT";
}
```

这样只有淘系流量进代理，其他一切照常直连；撤掉 PAC 即恢复。

### 3.3 步骤

1. 生成一张**仅本机使用**的根 CA（有效期设短，如 7 天）；
2. 把 CA 装进 **当前用户**的「受信任的根证书颁发机构」（`Cert:\CurrentUser\Root`，不需要管理员）；
3. 本地起 TLS 终止代理，只解密 `sycm.taobao.com` 与 `acs.m.taobao.com`，其他域名原样隧道；
4. 设 PAC；
5. 在千牛里正常浏览那 17 个页面（人工或 UI 自动化驱动）；
6. 代理侧按 mtop 接口名把响应体落盘，接进现有 `data/daily/<店铺>/<日期>/` 目录结构；
7. **用完立刻卸载 CA、撤掉 PAC**。

### 3.4 这条路能拿到什么

与 Edge 采集完全同构：页面真实收到的 mtop JSON 原文。也就是说现有的 `export-daily-ingest.mjs` → `ops-verify.ts` 整条下游**不用改**，只是把「数据来源」从 CDP 换成代理落盘。

### 3.5 代价与风险（必须你确认）

- 装根证书会短暂降低本机 TLS 安全等级（任何进程都可能被冒充，不只是千牛）；
- 阿里可能对中间人特征做风控（概率低，但不是零）；
- 需要有人真的去点那 17 个页面，否则没有流量——这一点比 Edge 方案更麻烦。

---

## 四、路径 C：UI 自动化读已渲染界面

GitHub 上 `automation9417/qianniu`（★76）用 **Clicknium** 自动化千牛桌面端，`tmwgsicp/dify-on-qianniu`（★149）是同类方案。Clicknium 基于 UIA（Windows UI Automation），自带录制器，不需要手写选择器。

**能做**：读 KPI 卡片的文本（支付金额、访客数、支付买家数等，这些在 DOM 里是文本节点，UIA 有机会拿到）。
**做不到**：ECharts 画在 `<canvas>` 上的趋势曲线——UIA 读不到像素里的数字，只能 OCR 截图。

**未验证**：CEF webview 的可访问性树是否对 UIA 客户端开放。Chromium 在检测到 UIA 客户端连接时才会开启 accessibility，理论可行，但这台机器上没实测过。要验只需装 Clicknium 后对千牛窗口取一次控件树。

**风险最低**（只读、不注入、不装证书），但最脆弱：页面改版、窗口尺寸变化、需要保持窗口在前台。

---

## 五、路径 D：Edge 每店独立 profile（已实现，推荐维持）

现状：一店一 profile、一端口（9222–9225）、一输出目录；`shop-login.ps1` 逐店登录一次，`run-all-shops.ps1` 串行采集。通过 CDP `Network.responseReceived` + `getResponseBody` 直接拿 mtop 响应，与路径 B 拿到的内容一致，但不需要证书、不需要改系统设置、不影响其他软件。

GitHub 上 `rakei076/sycm-cli`（★73）走的是同一思路的另一实现：Windows 上 Chrome 登录态读不到，所以它做了一个**「取数桥」浏览器插件**在已登录的 Chrome 里取数，还支持多账号切换。`sishenhei7/chrome-plugin-sycm`（★22）证明了在 `document_start` 注入 fetch/XHR 钩子拦生意参谋接口是可行的。

**关键判断**：这两个项目的存在反证了一件事——**「从已登录的浏览器里取数」是这个问题的通用解法，而不是「从客户端里取数」**。没有人做千牛客户端直采，因为技术上被堵死了。

---

## 六、数据字段范围与页面 / 接口位置

采集面共 **17 个页面**，全部是 `sycm.taobao.com` 下的路径：

| 页面 | 路径 | 主要产出 |
| --- | --- | --- |
| trade-detail | `/fa/trade/detail` | 支付金额、支付买家、客单价、逐日趋势 |
| trade-refund | `/fa/refund/analysis` | 退款金额、退款率 |
| flow-overview | `/flow/monitor/overview` | 访客数 `uv`、浏览量 `pv`、支付金额 `payAmt` |
| flow-shopsource | `/flow/monitor/shopsource/construction` | 渠道结构（**渠道树接口**） |
| flow-itemsource | `/flow/monitor/itemsource` | 商品流量来源 |
| flow-visitor | `/flow/visitor/analysis` | 地域分布 `listAreas` |
| flow-keyword | `/flow/monitor/keyword_assistant` | 搜索词 |
| item-rank | `/cc/item_rank` | 商品榜 `item_view_top` |
| item-archives | `/cc/item_archives` | 商品档案 |
| item-macro | `/cc/macro_monitor` | 商品宏观 |
| content-overview | `/xsite/contentanalysis/overview_new_v2` | 内容整体 |
| content-live | `/xsite/contentanalysis/lives/performance` | 直播表现 |
| content-channel | `/xsite/contentanalysis/recommend_analysis` | 推荐渠道 |
| qos-core | `/qos/service/core_monitor/new` | 服务体验核心指标 |
| qos-experience | `/qos/frame/cds/experience` | 体验分 |
| qos-performance | `/qos/service/performance/new` | 客服绩效 |
| qos-refund | `/qos/service/refund/monitor` | 退款监控 |

**6 个「必须拿到」的接口**（`scripts/lib/required-endpoints.mjs`，采集端与校验端共用）：

| 页面 | 接口特征 |
| --- | --- |
| flow-overview | `overview.json` |
| flow-shopsource | `tree_platform_support` |
| flow-visitor | `listareas` |
| flow-keyword | `drainagesearch` |
| item-rank | `item_view_top` |
| trade-detail | `gettendency` |

指标口径以 `export-daily-ingest.mjs` 为准：支付金额只认 `flow-overview.payAmt`（单位转分），访客数认 `uv`，浏览量 `pv`，支付买家 `payOrderUserCnt`，商品访客 `itmUv`；逐日趋势取 `gettendency` 并与总览交叉校验，不一致即报错。

---

## 七、登录态复用方式（三条路各自）

| 路径 | 复用方式 | 是否需要取出凭据 |
| --- | --- | --- |
| B 代理 | **不需要取出**。千牛自己维持会话，我们只是被动截获它发出的请求 | 否（这是它最大的优点） |
| C UI 自动化 | 同上，只是读屏幕 | 否 |
| D Edge | 每店在专用 profile 里登录一次，cookie 存几周 | 否 |

**三条路都不需要读 AuthSDK 的加密 token，也不需要 DPAPI 解密。** 上一轮试过的「解 cookie 注入浏览器」已经证明源头无数据，不必再走。

---

## 八、合规与账号安全风险

| 风险 | 说明 | 严重度 |
| --- | --- | --- |
| 中间人解密（B） | 本机短暂降级 TLS；请求内容（含经营数据）经过自有进程 | 中 |
| 风控识别 | 同账号多客户端并发、异常代理链路可能触发验证码/限流 | 中 |
| DLL 注入 / 内存改写 | `SafeGuard` + 反调试，且明确违反用户协议；`wantoper/QianNiuClient_Dll`（★9）这类项目**不建议使用** | 高 |
| 频率 | 17 页 × 3 店串行，每页 60s 等待，本身接近人工浏览节奏；不要并发压测 | 低 |
| 数据范围 | 只取自己店铺、只读不写、不下单不改价不回复 | 低 |

**红线**：不读 AuthSDK token、不注入 DLL、不绕过 SafeGuard、不做写操作、不采集他人店铺。

---

## 九、怎么验证数据真的拿到了

每层都要有**可证伪的判据**，不能只看「有文件」。

### 9.1 路径 B 的判据

1. 代理日志出现 `CONNECT sycm.taobao.com:443` 与 `CONNECT acs.m.taobao.com:443`——**没有这条，后面全部不成立**；
2. 解密后响应体是合法 JSON，且含 `data.uv` / `data.payAmt` 字段；
3. 页面显示的支付金额 × 100 与落盘的 `payAmountFen` **完全相等**；
4. **反例**：故意把 PAC 关掉再刷页面，代理日志必须归零——否则说明你看到的流量来自别处。

### 9.2 路径 C 的判据

1. UIA 树里能定位到「支付金额」标签节点，且相邻节点文本是数字；
2. OCR 出的数字与 UIA 取到的数字一致（两条独立通道互证）；
3. **反例**：把页面切到别的日期，数字必须跟着变——否则你读到的是缓存文本。

### 9.3 路径 D 的判据（已具备）

现有三级退出码 + 两个校验器：`verify-daily.mjs`（采集↔契约）、`ops-verify.ts`（库↔契约）。0 干净 / 2 有缺口可入库 / 1 阻断。已验证过反例：篡改窗口 → 阻断；篡改访客数 → 落库校验红。

### 9.4 跨路径一致性（最重要的一条）

同一店铺同一天，**路径 B 与路径 D 的结果必须逐字段相等**。不相等就是其中一条错了，不允许「取个折中」。这是唯一能证明「千牛里那份数据和我们一直用的那份是同一份」的方法。

---

## 十、建议

1. **主线继续走 D**。它已经跑通、有校验器、零侵入。千牛方案唯一的好处是省 3 次扫码，代价是一张根证书加系统代理，不划算。
2. **如果你坚持要千牛直采**，走 B，并且先用 PAC 把影响面收到淘系域名、CA 有效期压到 7 天、用完即卸。第一步只验「代理能不能看到 sycm 的 CONNECT」，看到了再谈解密。
3. **路径 C 当旁路**：装个 Clicknium 取一次控件树，能读到 KPI 就当人工复核工具用，读不到就放弃，成本不到 10 分钟。
4. **不要再碰 DLL 注入**。

---

## 附：GitHub 参考资料

| 仓库 | ★ | 与本任务的关系 |
| --- | --- | --- |
| [rakei076/sycm-cli](https://github.com/rakei076/sycm-cli) | 73 | 生意参谋只读数据 CLI。Windows 上靠「取数桥」插件在已登录 Chrome 取数，支持多账号切换，可接 MCP。**架构最值得抄** |
| [sishenhei7/chrome-plugin-sycm](https://github.com/sishenhei7/chrome-plugin-sycm) | 22 | 在 `document_start` 注入 fetch/XHR 钩子拦生意参谋接口，已停止维护但技术路线有效 |
| [wangshan9870/sycm-chrome-plugin](https://github.com/wangshan9870/sycm-chrome-plugin) | 7 | 同类插件 |
| [automation9417/qianniu](https://github.com/automation9417/qianniu) | 76 | 用 Clicknium 自动化千牛桌面端，路径 C 的现成参考 |
| [tmwgsicp/dify-on-qianniu](https://github.com/tmwgsicp/dify-on-qianniu) | 149 | Clicknium + Dify 的千牛客服机器人 |
| [cs-lazy-tools/ChatGPT-On-CS](https://github.com/cs-lazy-tools/ChatGPT-On-CS) | 4498 | 多平台客服自动化，含千牛 |
| [wantoper/QianNiuClient_Dll](https://github.com/wantoper/QianNiuClient_Dll) | 9 | DLL 注入实现自动登录。**风险高，不建议使用**，仅作为「此路存在」的记录 |

外部资料：

- 阿里巴巴官方《千牛（Windows 版）真机调试》——小程序调试端口 9225 的官方说明（本报告 §2.3 据此证伪）
- 阿里巴巴官方《IDE 远程调试》——`setting.json` 的 `context & 0x10` 条件
- 看雪《某宝千牛浏览器开启远程调试》——`AliWorkbench.exe` 反调试与命令行参数无效的实测记录
