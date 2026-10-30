# 千牛取数模块（自建）

厂商交付的 `runtime/sycm-cli` 里只有生意参谋和万相台两个取数工具（`tb modules` 能列出来
的就这两个，`modules enable qianniu` 直接回「这个包里没有」）。运营看板上「评价待回复」
「问大家待回答」这两项一直标着「待接入」，缺的就是这一层。所以自己补了一个。

**源码在仓库里，运行时是装出来的。** `runtime/` 在 `.gitignore` 里（第三方包不入库），
模块源码放在本目录 `module/`，用 `install.mjs` 装进运行时。换机器后跑一次就恢复。

```bash
node tools/qianniu-module/install.mjs          # 安装 / 更新
node tools/qianniu-module/install.mjs --check  # 只比对，不一致退出码 1
```

运行时目录靠向上找 `.ws-root` 定位（盘符会在 E:/F: 之间变，不能写死）；也可以用
`SYCM_CLI_DIR` 直接指定。

## 装好后有什么

```bash
scripts\qianniu.cmd doctor              # 自检：登录态 + 三个接口各打一枪
scripts\qianniu.cmd review-pending      # 待商家回复的评价（总数 + 明细）
scripts\qianniu.cmd ask-pending         # 问大家待回答（要翻页统计）
scripts\qianniu.cmd refund-overview     # 退款/售后的待处理单量
scripts\qianniu.cmd api <mtop.api.name> # 通用只读直通，给以后加接口用
```

接口细节、三个坑、以及「哪些还没接」都写在 `module/tools/qianniu.md` 里（安装后会出现在
运行时的 `tools/qianniu.md`）。

## 实测（2026-10-30，梵禾主店，登录账号「梵禾定制家具:小阳」）

| 项 | 结果 |
|---|---|
| `doctor` | 3/3 项可用 |
| 评价待回复 | 48 条 |
| 问大家 | 共 104 条，已答 88，待回答 16（全部是 2026-10-08 的「是否能提供设计图？」） |
| 退款待处理 | 全部 0 / 24 小时内 0 / 待举证 0 …（10 个格子全 0） |

## 为什么走 MTOP 而不是页面接口

插件桥给千牛放行的只有 `h5api.m.taobao.com/h5/` 和一条 ASCP 代理（见
`extension/unpacked/background.js` 里的 `myseller.taobao.com` 那一项），**页面 HTML 不放行**。
所以这一层只能签 MTOP —— 好在签名算法 `core/mtop.py` 里本来就有（达摩盘在用）。

`Platform.write_re` 与插件的 `WRITE`、`read_allow` 与插件的 `READS` 是两套并行护栏，
**必须同步改**；只改一边会出现「命令行放过、插件拦下」或反过来。

## 光合平台：这次没做，原因记在这里

「内容运营」那三项（内容查看人数 / 内容商品点击人数 / 内容活动人数）原本想一起接，
查下来卡在两处：

1. **域名不是 `guang.taobao.com`**（那个域名现在直接跳淘宝首页）。真实入口是
   `guanghe.taobao.com`：创作者看 `creator.guanghe.taobao.com`，商家看 `b.guanghe.taobao.com`，
   两个都要求登录（匿名访问 302 到登录页或注册检查页）。
2. **插件不放行这个域**。`background.js` 的 SITES 里没有 guanghe 这一项，插件会直接拒发。
   要接得先加一项（launch 用 `https://guanghe.taobao.com/robots.txt`），而插件是浏览器里
   加载的，**改完必须去 edge://extensions 点一次刷新**才生效 —— 这一步只能人来点。

公开能拿到的 `guanghe.taobao.com` 静态资源只有一个「招募/入驻」预览站
（`g.alicdn.com/mtb-guang/guanghe-preview/0.0.5/js/main.js`，12 个页面全是 activity/servicejoin 之类），
**不含商家内容数据页**，所以拿不到接口名。

另一条更省事的路：**生意参谋自己有「内容概况 / 内容榜单 / 素材分析」**（`35-menu.json` 里
能查到这些菜单名），而生意参谋是已经打通、插件放行整域的那个工具。缺的只是接口路径。
要补的话，在已登录的浏览器里打开「内容概况」看一眼它的 XHR 请求名即可，之后用
`scripts\sycm.cmd api <path>` 就能验证 —— 比给插件加域更轻。

## 接进采集器与看板（2026-10-30）

两条命令已经进日增：`collect-via-plugin.mjs` 的 `QIANNIU_CMDS`，序号 **56 / 57**，
排在六条裸探测（50～55）之后。设成写死的序号而不是自增，是因为适配器按序号找文件：
插在中间会让后面几条错位，而且**不报错**（读到隔壁那条，字段全空）。

回包 → 看板的映射在 `export-sycm-ingest.mjs` 的 `appendQianniu`：

| 命令 | 回包字段 | 契约键 | 看板位置 |
|---|---|---|---|
| `review-pending` | `total` | `rateUnrepliedCnt` | 服务体验 › 待回复 |
| `ask-pending` | `pending` | `wendaPendingCnt` | 服务体验 › 问大家待答 |

三条必须守住的判断，都在 `appendQianniu` 里有注释：

1. **只允许「今天 / 昨天」两个窗口，回填更早的日期整块跳过**。这两个是**采集那一刻
   的待办快照**，平台没有历史口径。日常那一轮本来采的就是 T-1（`run-daily.ps1` 默认
   `AddDays(-1)`），所以记在 T-1 上是可以接受的 —— 服务页整页都是 T-1 口径。要挡的是
   `--date 2026-10-01` 这类回填：照填会让半个月前的窗口突然冒出「今天欠 48 条」。
   偏差最多一天，是有意的取舍。
2. **登录账号对不上就丢弃**。文件里的 `account.nick` 与槽位的 `pluginAccount` 逐字比，
   对不上写进 notes 不入库。这是串店的唯一防线，因为千牛接口不认「你以为是谁」。
3. **千牛的失败不改退出码**。它依赖「浏览器登录了卖家中心」，与生意参谋登录态是两回事；
   混进 `bad` 会让二三店每天以 exit=2 收场，红到没人看。现在单独打一行。

看板侧（`packages/shared/src/ops.ts`）：两项都进 `OPS_SUMMARY_METRICS`
（`module: 'service'`），并进 `OPS_DAILY_ONLY_SUMMARY_KEYS` —— 区间视图从最近一份
单日快照补齐并标注数据日期，因为**待办数跨天相加没有含义**。
