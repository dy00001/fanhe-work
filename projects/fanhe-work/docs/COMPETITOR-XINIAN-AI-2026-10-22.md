# 竞品技术拆解：昔年AI电商（XinianAI）

> 拆解日期 2026-10-22。分析对象为本机安装的 `D:\昔年AI\XinianAI`（快捷方式 `C:\Users\Public\Desktop\昔年AI电商.lnk`）。
> 方法沿用 REA（morluto/rea，rea-agents 6.7.0）的「JavaScript / Electron 应用静态还原」路径：从安装目录取包结构、从 asar 取模块图、从 source map 取原始文件路径与符号、从运行时 userData 取实际行为证据。
> 本文件只记录结构与行为，不含任何账号凭据、Cookie 或密钥值。

---

## 一、结论摘要

1. **产品形态是「远端 Web UI + 本地 RPA 引擎」的混合体。** 界面完全来自 `https://xinianai.com`，本地 `electron/dist` 只有 3.27 MB，真正跑业务的是本地 2.1 MB 的自动化引擎。这意味着界面改动不需要发版，反过来也意味着客户端的信任边界被外包给了服务器。
2. **核心资产是「服务端下发的编排 DSL」，不是客户端代码。** 客户端只带解释器（79 个原子模块 + 17 种节点类型），具体怎么点、点哪里、按什么顺序，全部由 `/api/automation-flows` 按「平台 + 类目 + 客户端版本」下发，带 sha256 校验与本地缓存回退。这是它能同时维护 5 个平台、几十个类目的关键。
3. **多店铺隔离用的是 Electron 持久分区，不是独立浏览器进程。** 每个店铺账号一个 `persist:store-<platform>-<uuid>`，Cookie 与 localStorage 落在 `%APPDATA%\XinianAI\Partitions`。本机实测已有 4 个分区（淘宝 ×2、微信小店、抖店）。
4. **失败兜底做成了三级：自动重试 → AI 决策 → 人工接管。** AI 决策有次数上限和「同一问题重复即停」保护，人工接管是带 checkpoint 与审计日志的受限闭环（最多 5 个动作）。这块设计比大多数同类 RPA 成熟。
5. **工程质量有明显欠账，且构成实际攻击面。** 3 个加载自家域名的应用窗口 `webSecurity: false`；39 个 IPC handler 全部没有 sender 校验；可执行文件**未做代码签名**；生产包内附带 **142 MB source map** 与 **501 MB node_modules**（含 next、drizzle-kit、three 等与客户端无关的包）；exe 的 Company 字段仍是 `GitHub, Inc.`。
6. **REA 复核把上述判断量化了。** 223 个业务文件、76 个被解析、154,661 个 AST 节点、918 个发现项；5 个 BrowserWindow、51 个 IPC 字面通道（39 对全部配对）、45 个暴露的桥接成员、0 处 sender 校验。全目录扫描 45,300 个文件在 7.8 分钟只推进到 10%，所以先裁剪再分析是必要步骤。

---

## 二、应用基本面

| 项 | 值 | 证据 |
|---|---|---|
| 产品名 | 昔年AI电商 | exe VersionInfo |
| 应用版本 | 0.1.80 | `package.json` / exe FileVersion |
| Electron | 41.2.0（Chromium 146.0.7680.179） | exe 内字符串 |
| 安装体积 | 871 MB | `du -sh` |
| app.asar | 505.5 MB / 49,087 个文件 | asar 头解析 |
| app.asar SHA256 | `6A367AA155C585331E8734DE6D56201941DC814C292AAA83F987E1DEF0D032DC` | `Get-FileHash` |
| 代码签名 | **未签名**（`NotSigned`） | `Get-AuthenticodeSignature` |
| 签名主体字段 | Company = `GitHub, Inc.`，Product = 昔年AI电商 | exe VersionInfo |
| 更新源 | `https://xinianai.com/api/client/version/?brandCode=DEFAULT`（generic provider） | `resources/app-update.yml` + `main.js:486` |
| 运行时数据 | `%APPDATA%\XinianAI`（开发版为 `XinianAI-Development`） | `main.js:46` |

### 体积构成（这是最直观的工程问题）

| 分类 | 文件数 | 体积 | 占比 |
|---|---|---|---|
| `node_modules` | 48,851 | 501.0 MB | 99.1% |
| `electron/dist`（真正的业务代码） | 222 | 3.27 MB | 0.65% |
| `resources`（图标、配置） | 13 | 1.23 MB | 0.24% |
| 其中 `.map` 文件 | 10,053 | 142.2 MB | 28.1% |

`node_modules` 里最大的几个包：`next` 132 MB、`@ffmpeg/core` 61.7 MB、`js-tiktoken` 21.4 MB、`date-fns` 20.9 MB、`lucide-react` 20 MB、`@img/sharp-win32-x64` 19 MB、`three` 14 MB、`ag-psd` 12 MB、`drizzle-kit` 9.7 MB。共 624 个包。

`next`、`drizzle-kit`、`@langchain/core`、`tencentcloud-sdk-nodejs`、`@alicloud/*` 这些明显属于服务端或构建期依赖，客户端运行时不 `require`。判断依据：`electron/dist` 下 66 个 js 文件的全部 `require` 目标里只出现 `electron`、`electron-updater`、`xlsx`、`sharp` 和内部模块。这说明打包时直接拷了整个 monorepo 的 `node_modules`（`package.json` 的 `name` 字段仍是 `"projects"`，未改成产品名）。

---

## 三、REA 复核数据

用 REA 6.7.0 的 `analyze-javascript-application` 对客户端业务代码跑了一遍，拿到的是可引用的结构化结论，用来交叉验证上面的人工判读。

**执行记录**

| 轮次 | 输入 | 规模 | 耗时 | 结果 |
|---|---|---|---|---|
| 第 1 轮 | `D:\昔年AI\XinianAI`（完整安装目录） | 45,300 个待处理文件 | 7 分 48 秒只推进到 4,750/45,300（约 90 文件/分钟） | 按此速率需约 8 小时，已中止 |
| 第 2 轮 | 裁剪后的 `electron/dist` + `package.json` | 223 个文件 / 3.7 MB | 61 秒 | 成功，输出 153 MB JSON |

**第 2 轮的关键指标**（`normalized_result.summary` / `.statistics`）

| 指标 | 值 |
|---|---|
| 解析的 JavaScript 文件 | 76（跳过 0，解析失败 0） |
| 访问的 AST 节点 | 154,661 |
| 发现项（findings） | 918 |
| 应用图 | 1,151 节点 / 1,582 边 |
| BrowserWindow 构造点 | 5 |
| webPreferences 显式项 | 27 |
| preload 入口 | 3 |
| contextBridge API | 1（`electronAPI`），暴露成员 45 |
| IPC 字面通道 | 51 |
| 主进程 handler | 39，渲染端 invoke 39，全部成对 |
| 渲染端监听器 | 12 |
| 动态通道 / 未配对通道 | 0 / 0 |
| **handler 内的 sender 校验** | **0 处** |
| 原生插件绑定 | 0 |
| 完整性矛盾 | 0 |

REA 自己声明的分析边界（`limitations`）：CommonJS/ESM 的绑定关系只从惰性语法恢复、只在已清点的产物容器内解析；Electron API 身份依赖已证明的词法别名；任意调用副作用与运行时注册不评估。换句话说，这些数字是「静态可见的」，不代表运行时全貌。

**这轮复核修正了两处人工判读**：

1. 5 个 `BrowserWindow` 里，`webSecurity: false` 只出现在 3 个加载 `xinianai.com` 的应用窗口（主窗口、客户登录窗、授权窗）。另外 2 个店铺窗口（`storeSessionManager.js:542` 账号窗、`:1099` 概览采集窗）用的是 `session: fromPartition(account.partition)`、`sandbox: true`、`contextIsolation: true`、**不挂 preload**、且没有关闭 `webSecurity`。所以隔离设计是分层的：特权窗口与平台后台窗口分离，风险面比「全部关掉同源策略」小。
2. IPC 面比 preload 里看到的更完整：51 个字面通道、39 对 handler/invoke 全部配对、0 个动态通道。**但 39 个 handler 里没有一处校验 `event.senderFrame`**，即主进程不验证调用方来自哪个 frame。配合「远程 UI + `webSecurity: false`」，一旦远端页面被注入脚本，39 个特权方法全部可直接调用。这是本次拆解里最值得警惕的一处设计缺口。

**顺带一个工具层面的观察**：REA 的 JavaScript 应用分析器默认不排除 `node_modules`，也没有增量缓存，面对 500 MB 级 Electron 包时整目录扫描不具备可操作性。实际用法应该是先自己裁剪出运行期代码再喂给它。它输出的 evidence 结构（`evidence_id` / `authority: shipped-artifact` / `confidence` / `limitations`）确实做到了「每个结论都能追到产物与行号」，这一点比通用 grep 强很多。

---

## 四、架构拆解

### 4.1 三层结构

```
远端 Web（xinianai.com / 白标绑定域名）
        │  整个 UI 由服务器提供，客户端只做壳
        ▼
Electron 主进程（3.27 MB）
   ├─ 窗口与托盘、自动更新、下载目录、遥测心跳（5 分钟）
   ├─ 39 个 ipcMain.handle（店铺会话、上架任务、视频渲染、白标绑定）
   └─ 自动化引擎（2.1 MB，73 个 js 模块）
          ├─ adapters/  5 个平台适配器（抖音/快手/微信/拼多多/淘宝）
          ├─ dsl/       流程加载器 + 校验器 + 节点执行器（800 KB）
          ├─ modules/   79 个原子动作定义
          ├─ recovery/  卡页恢复与诊断
          ├─ takeover/  AI 人工接管闭环
          └─ listing/   上架任务编排与档案校验
        ▼
各平台商家后台（fxg.jinritemai.com / s.kwaixiaodian.com / store.weixin.qq.com / mms.pinduoduo.com / myseller.taobao.com）
```

### 4.2 界面来自远端，客户端是特权壳

`main.js:132-137` 里 `getServerUrl()` 只有两个分支：开发态 `http://localhost:5000`，生产态 `https://xinianai.com`。主窗口 `loadURL(initialUrl)` 直接加载这个地址。

白标能力通过 `resources/white-label.json` 实现（`appName` / `windowTitle` / `iconFile` / `brandCode`），当前安装包没有这个文件，走默认品牌。首次启动若没有 `clientBinding`，会打开 `/client-login` 让用户绑定自己的域名，绑定结果写进 `config.json`。本机 `config.json` 显示已绑定 `https://xinianai.com/`，绑定时间 2026-10-09。

**辩证看**：这套设计让「一套代码卖给多个贴牌客户」变得极低成本，界面改版零发版。代价是客户端把执行特权（写文件、跑 RPA、上传素材）交给了一个它无法验证的远端页面。

### 4.3 店铺会话：一店一分区

`storeSessionManager.js:438` 用 `persist:store-${platform}-${id}` 作为 partition。账号元数据存在 `%APPDATA%\XinianAI\store-automation\store-accounts.json`，字段为 `id / ownerId / platform / displayName / partition / status / lastKnownUrl / shopName / storeId`。

本机实测 4 个账号：

| 平台 | 店铺名 | 状态 |
|---|---|---|
| taobao-shop | 梵禾复古家居馆 | needs_login |
| taobao-shop | 梵禾系统家居企业店 | needs_login |
| wechat-shop | （未命名） | unknown |
| douyin-shop | （未命名） | unknown |

登录态判定不只看 URL：微信小店会读页面正文匹配 `登录超时|请重新登录|登录已失效`（`storeSessionManager.js`）。preload 里还有一段专门处理微信小店 QR 登录：它把 `sessionStorage` 镜像进同源 `localStorage`（键 `__xinian_wechat_session_storage__`），因为 Electron 的持久分区在整进程重启后不保留 sessionStorage，每秒同步一次并监听 `pagehide`。

**辩证看**：单进程多分区比「每店一个浏览器实例」省内存、省端口、天然共享主进程调度；代价是任一分区崩溃或渲染进程被污染，影响面比独立进程大。

### 4.4 上架引擎：服务端下发 DSL，本地解释执行

这是整个产品最值得研究的部分。

**下发链路**（`dsl/flowLoader.js`）：
1. 按 `platform` + `categoryId` 请求 `GET /api/automation-flows?platform=&categoryId=&clientVersion=`，带 `Authorization` 与 `x-api-account-id`。
2. 类目回退链：精确类目 → 逐级父类目 → `__platform__` 通用流程。日志会打印「未找到精确类目流程，已回退到父类目」。
3. 三道校验：`environment` 必须与客户端环境一致（production / development 由 `resources/development-build.flag` 判定）、zod schema 校验、`sha256(definition)` 与服务器给的 `checksum` 比对。
4. 通过后写入 `%APPDATA%\XinianAI\store-automation\flow-cache\<sha256(key)>.json`。
5. 网络失败时回退缓存；但 HTTP 404 视为「该类目确实没有流程」，不会复活已删除的流程。授权失败、版本不兼容、校验失败也不允许用缓存掩盖。

**本机缓存的真实流程**（`flow-cache/9e103e7f2bdb9d3765fe6aa5dcb625e8.json`，9.3 KB）：

```
flowId   0c475171-...    version 6    schemaVersion 1    environment production
platform taobao-shop     category 平台通用流程(__platform__)
minClientVersion 0.1.33  publishedAt 2026-10-22 05:27:31Z
17 个顶层节点：
  1 打开上传图片页面   navigate sucai.wangpu.taobao.com → 跳过 → 上传主图
  2 openPublishPage   navigate item.upload.taobao.com/sell/ai/c → 开启 → taobaoSearchPublish
  3 selectCategory    选择类目 → taobaoCategorySelect
  4 requiredAttributeLoop（maxIterations 循环填必填属性）
  5 进入属性页         确认，下一步 ×2 → assert
  6 填写商品主图       selectTaobaoMaterialImages → 切到「基础信息」
  7 fillAttributes     填标题
  8 水洗标             uploadTaobaoMaterialCompositionImages → 输入含量
  9 requiredAttributeLoop
 10 填写非必填属性     fillTaobaoOptionalAttributes
 11 configureSkus      批量导入 → uploadTaobaoSkuTemplate → 确认识别 → 追加规格
 12 上传规格图片       uploadTaobaoSkuImages → 确定
 13 uploadDetailImages selectTaobaoMaterialDetailImages
 14 上传尺码表         uploadTaobaoSizeChartTable
 15 configureSkus      fillTaobaoPriceStock → 销售规格必填属性循环
 16 运费模板           radio/checkbox → selectTaobaoFreightTemplate
 17 publish            提交宝贝信息 → verifyTaobaoPublishResult
```

**节点类型**（`dsl/nodeExecutor.js` 的 `node.type` 分支）：
`navigate` `click` `hover` `input` `select` `check` `scroll` `keypress` `upload` `wait` `assert` `extractMetric` `aiSelect` `attributeSelect` `fillAttributes` `attributeLoop` `forEach` `if` `customModule` `platformAction` `pauseForUser`，以及 60 余个平台专用动作（`taobaoCategorySelect`、`uploadWechatSkuDocument`、`fillKuaishouPriceStock` 等）。

**控件定位是分级的**，`target` 对象里可同时给：
- `semantic` + `text`：语义与可见文本
- `role` + `attributes`：ARIA 角色与属性
- `selectors`：CSS 兜底

例如流程里 `{"semantic":"确认，下一步","text":"确认，下一步", ...}`，以及 `{"attributes":{"type":"radio"},...}`。这种「语义优先、选择器兜底」的写法，正是它能扛住平台改版的关键。

**底层输入走 CDP**：`nodeExecutor.js` 里 `sendCommand('Input.dispatchMouseEvent')` 出现 86 次、`Runtime.evaluate` 55 次、`Page.setInterceptFileChooserDialog` 20 次、`DOM.setFileInputFiles` 17 次、`Input.dispatchKeyEvent` 8 次。上传文件靠拦截文件选择对话框 + CDP 直接塞路径，绕开了原生对话框。

### 4.5 失败处理三级兜底

`core/listingTaskEngine.js` 的主循环写得很清楚：

1. **步骤级重试**：`MAX_STEP_RETRIES = 1`，只对 `recoverable: true` 的失败重试。
2. **AI 决策**：返回 `ai_resolution_required` 时，调用 `POST /api/store-automation/resolve-field`（`ai/fieldResolver.js`）。有 `aiResolutionCount < 100` 上限，且用 `kind:semanticTarget:sourceValue:platformField` 做去重键，同一问题重复出现立刻转 `waiting_for_user` 并附原因 `ai_resolution_repeated`。
3. **卡页恢复**：`recoverFromStuck`，`MAX_RECOVERY_ATTEMPTS = 3`。
4. **人工接管**：`takeover/takeoverController.js` 跑受限闭环 `observe → align → decide → act → verify`，`maxActions = 5`。每次动作写审计（phase 枚举：`started` / `alignment` / `decision` / `action` / `handoff` / `failed`），checkpoint 存 `%APPDATA%\XinianAI\store-automation\takeover-checkpoints`。
5. **断点续跑**：`context.completedSteps` 集合，重入时跳过已完成步骤。任务可 `pause` / `resume` / `cancel` / `confirm-publish`，`confirmPublish` 是独立的人工确认闸门。

### 4.6 数据面：概览指标从哪来

`storeSessionManager.js` 里硬编码的抓取入口：

| 平台 | 页面 |
|---|---|
| 抖店 | `compass.jinritemai.com/shop`（看板）、`fxg.jinritemai.com/ffa/mshop/homepage/index`、`/ffa/fund-control/account-center`、`/ffa/fxg-bill/tax-bill`、`/ffa/morder/receipt/list`、`/ffa/content/shop_deposit` |
| 快手小店 | `s.kwaixiaodian.com/zone/home`、`/zone/fund/accounting/overview`、`/zone/fund/accounting/unsettled-bill`、`syt.kwaixiaodian.com/zones/home` |
| 微信小店 | `store.weixin.qq.com/shop/home`、`/shop/statistics/transaction`、`/shop/funds/home`、`/shop/setting/profile` |
| 拼多多 | `mms.pinduoduo.com` |
| 淘宝 | `myseller.taobao.com/home.htm` |

取值手段是 `Accessibility.getFullAXTree` + `Page.captureScreenshot`（`storeSessionManager.js` 的 CDP 调用），即读无障碍树而不是解析 DOM。这比选择器解析稳，代价是 AX 树在大页面上体积很大。

并发按机器资源自适应（`main.js:900`）：内存 < 8 GB 或 CPU < 4 核时系数 0.5，抖店/快手默认 4 并发，微信/拼多多/淘宝默认 2 并发。

### 4.7 更新与遥测

- 更新：`electron-updater` + generic provider，feed 为 `/api/client/version/?brandCode=<brand>`。启动时检查并**自动下载**，运行期与手动检查只提示不下载；每 30 分钟复检一次。下载完成后先 flush 所有店铺会话再 `quitAndInstall`（避免 NSIS 起不来）。
- 遥测：`POST /api/client/analytics/event`，`eventType` 为 `client_open` / `client_heartbeat`，5 分钟一次，携带 `installationId`（首次启动生成的 `client_<uuid>`）、`clientVersion`、`platform`、`arch`。
- 视频渲染：本地 `ffmpeg`（`@ffmpeg-installer/ffmpeg` 或 `resources/ffmpeg/ffmpeg.exe`），逐段切片 + concat，单段超时 30 分钟，进度通过 `video-editing:progress` 回传，支持取消。

---

## 五、工程质量与安全面

| 问题 | 证据 | 影响 |
|---|---|---|
| 3 个应用窗口 `webSecurity: false` | `main.js` 出现 3 次（主窗口/登录窗/授权窗）；2 个店铺窗口未关闭 | 关闭同源策略后，远端页面里的任意 XSS 都能跨域读取，配合 39 个 IPC 特权方法，等于把本机能力暴露给网页内容。店铺窗口是隔离的，风险面小于「全部关闭」 |
| 可执行文件未签名 | `Get-AuthenticodeSignature` → NotSigned | SmartScreen 拦截、企业环境无法白名单、更新链路缺少发布者验证 |
| 生产包附带完整 source map | 73 个非依赖 map，共 142 MB | 原始文件路径与符号名全部泄露（`../../automation/storeSessionManager.ts`）。本次拆解的文件名、目录分层就是直接从这里读出来的。好消息是 map 里**没有** `sourcesContent`，源码正文未泄露 |
| 打包了整个 monorepo 依赖 | 501 MB node_modules / 624 包 | 安装包 871 MB，更新包体大，冷启动慢，攻击面变大（依赖漏洞全部随包发行） |
| 39 个 handler 全部无 sender 校验 | REA `sender_validation_observations: 0` | 主进程不验证调用方 frame，任何能执行脚本的 frame 都能调用特权方法 |
| `ownerId` 由渲染进程传入 | 39 个 handler 里 `activateStoreOwner(ownerId)` | 主进程信任渲染进程给的所有者身份。在当前信任模型下等价，但一旦远端页面被攻破，跨账号越权只差一个参数 |
| 更新 feed 可被白标配置改写 | `whiteLabelBuildConfig.brandCode` 拼进 feed URL | 贴牌方若被入侵，可把更新源指向自己的域名 |
| exe 元数据未清理 | Company = `GitHub, Inc.` | 品牌细节，不影响功能 |
| `sandbox: true` + `contextIsolation: true` + `nodeIntegration: false` | `main.js:341-347` | 这三项做对了，preload 只暴露白名单方法，没有直接给 `require` |

**没有发现的**：客户端代码里没有硬编码的云厂商 AccessKey（`LTAI` / `AKIA` / `accessKeySecret` 命中数为 0），阿里云与 AWS SDK 虽在包里但未在客户端路径调用，推测是服务端依赖被一起打包。

---

## 六、对梵禾 Work 的可借鉴点

按「拿来就能用」到「需要改造」排序。

### 值得直接借鉴

1. **编排流程与执行器分离，流程由服务端下发。** 梵禾现在的采集端（`tools/collector/`）是脚本 + 配置，页面一改就得发版。把「怎么点」抽成带版本号的 JSON DSL、按平台 + 类目下发、带 sha256 校验与本地缓存，可以把平台改版的响应周期从「发版」压到「改配置」。
2. **语义定位器 + 多级回退。** `semantic/text/role/attributes/selectors` 五选组合，比单一 CSS 选择器抗改版得多。梵禾的 `pageHelpers` 可以直接引入这层抽象。
3. **AI 兜底要有次数上限和重复检测。** 「同一问题第二次出现就停下交人」这个规则能防住 AI 在两个错误选项之间来回横跳。这是很实用的工程约束。
4. **断点续跑靠 `completedSteps` 集合。** 上架类长流程必须能从中断处继续，否则重跑一次成本太高。
5. **每店独立持久分区。** 梵禾现在用 Edge profile + CDP（一店一 profile），隔离性更好但资源开销大、依赖外部浏览器。Electron 内建 `persist:store-*` 分区是另一条路，可以只在自己打包的客户端里用。
6. **人工接管带 checkpoint 与审计。** `observe → decide → act → verify` + 最多 5 个动作 + 审计事件流，比「弹个窗让人自己点」可控得多。

### 需要谨慎对待

1. **远程 UI 换取敏捷，代价是把信任边界交出去。** 梵禾是私有化部署产品，界面打包在本地更合适。远程 UI 只适合多租户 SaaS 贴牌场景。
2. **`webSecurity: false` 不要学。** 它解决的是跨域资源加载问题，正确做法是走主进程代理或配置 CSP，而不是关掉同源策略。
3. **不要打整个 node_modules。** 梵禾桌面端已经是 Electron + 独立构建，应保持「只打运行期依赖」，并显式关闭 source map 的产出（`build.sourcemap = false`）。
4. **AX 树取数在超大页面上会爆内存。** 抖店看板这类页面 AX 节点可能上万，建议加节点数上限并退化为定向 DOM 查询。
5. **「服务端下发可执行流程」本身是供应链风险。** 如果梵禾采用，必须保留 checksum、环境校验、版本下限三道闸（昔年这三道都做了，值得照抄）。

---

## 七、合规与边界

本次分析限于本机已安装软件的静态结构还原，目的是理解架构与工程取舍，未做以下动作：绕过登录或鉴权、读取或导出 Cookie 与凭据、注入代码、模拟业务写操作、破解授权。

涉及平台规则的部分需要注意：这类「模拟人工操作商家后台」的工具，在各平台的商家协议里普遍处于灰色地带，平台侧对自动化上架有明确限制条款。评估借鉴时，建议只取「编排 DSL + 语义定位 + 断点续跑 + 人工接管」这套工程方法论，落地到梵禾自己可控的数据通道上。

---

## 八、来源

**外部信源**
- REA 项目主页：https://github.com/morluto/rea
- REA 6.7.0 发布说明：https://github.com/morluto/rea/releases/tag/rea-agents-6.7.0
- REA 官网：https://rea.tools/

**本地证据**
- `D:\昔年AI\XinianAI\resources\app.asar`（505.5 MB，SHA256 见第二节）
- `D:\昔年AI\XinianAI\resources\app-update.yml`
- `D:\昔年AI\XinianAI\XinianAI.exe`（VersionInfo、Authenticode、Electron 版本字符串）
- `%APPDATA%\XinianAI\config.json`
- `%APPDATA%\XinianAI\store-automation\store-accounts.json`
- `%APPDATA%\XinianAI\store-automation\flow-cache\9e103e7f2bdb9d3765fe6aa5dcb625e8.json`
- 从 asar 导出的 `electron/dist/main.js`、`preload.js`、`automation/dsl/flowLoader.js`、`automation/core/listingTaskEngine.js`、`automation/modules/registry.js`、`automation/takeover/takeoverController.js`、`automation/ai/fieldResolver.js`
- 解析脚本：`E:\fanhe Work\.tmp\asar_scan.py`、`asar_deep.py`、`asar_api.py`、`asar_src.py`、`extract_payload.py`

**REA 运行产物**
- 裁剪后的分析输入：`E:\fanhe Work\.tmp\xinian-payload`（223 文件 / 3.7 MB，含 `electron/dist` 全量与 `package.json`）
- REA 输出：`E:\fanhe Work\.tmp\rea-payload.json`（153 MB，含 `evidence_id`、`summary`、`statistics`、`graph` 1151 节点/1582 边、`semantic_graph`）
- 全目录首轮尝试的进度日志：`E:\fanhe Work\.tmp\rea-app.err`（用于得出「90 文件/分钟」这一速率）
- 命令：`npx -y rea-agents@latest analyze-javascript-application <path> --json`

