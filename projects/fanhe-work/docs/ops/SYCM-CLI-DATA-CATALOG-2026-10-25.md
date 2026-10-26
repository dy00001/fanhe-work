# sycm-cli 可采集数据全清单

> 生成日期 2026-10-25。依据为本地安装副本 `runtime/sycm-cli`（commit 0dbf911）的源码、`tb/platforms/sycm/fields.json` 字段字典与实测输出。
> 适用范围：当前只装了生意参谋模块，共 55 个命令，全部只读，接口域限于 `sycm.taobao.com`。

## 零、先看总量

| 维度 | 数量 |
|---|---|
| 命令 | 55 个 |
| 接口路径（源码内可见） | 49 条 |
| 字段字典条目 | 189 条，其中 verified 130 条、candidate 59 条 |
| 中文名已破译 | 161 条，未破译 28 条（`cn` 与字段码相同） |
| 覆盖业务域 | 9 个 |

字段字典的 `status` 含义：`verified` 是作者实测核对过中文名与口径的，`candidate` 是中文名尚未破译、直接拿字段码顶替的。用 `candidate` 字段前必须自己验证。

## 一、店铺大盘（4 命令，62 字段）

| 命令 | 接口 | 说明 |
|---|---|---|
| `home-overview` | `/portal/coreIndex/new/overview/v3.json` | 按日大盘，返回 `self`、`rivalAvg`、`rivalGood` 三档对标 |
| `home-trend` | `/portal/coreIndex/new/trend/v3.json` | 同一批字段的时序数组 |
| `home-table` | 同上，逐日循环调用 | 多日并排大表，每格带较上一周期变化 |
| `grow-factor` | `/portal/board/grow/factor/overview.json` | 增长因子，广告、直播、新品、会员各贡献多少成交 |

`home-overview` 的 62 个字段（实测 `self` 返回 57 个，`rivalAvg`、`rivalGood` 各 46 个）：

**支付与转化**
`payAmt` 支付金额、`netPaymentAmount` 净支付金额、`uv` 访客数、`payByrCnt` 支付买家数、`payRate` 支付转化率、`pv` 浏览量、`payItmCnt` 支付件数、`payPct` 客单价、`subPayOrdSubCnt` 支付子订单数、`subPayOrdAmt` 支付子订单金额、`payOrdCnt` 支付订单数

**加购与收藏**
`cartByrCnt` 加购人数、`cartCnt` 加购件数（SKU 级）、`cartItemCnt` 加购件数（店铺/订单聚合口径）、`cltItmCnt` 商品收藏人数

**老客与复购**
`rePurchasePayAmount` 老客复购金额、`payOldByrCnt` 老客复购人数、`hasPurchaseUbyCntRate` 老客复购率、`hasPurchasedUbyCnt` 复购人数、`olderPayAmt` 老客支付金额、`hasBuyPayGmv`、`noBuyPayGmv`、`noPurchaseBuyCnt`、`hasPurchaseNewUv`

**退款与售后**
`rfdSucAmt` 退款金额（完结时间）、`payShopRfdAmt` 退款金额（支付时间）、`payAmtRfdRate` 金额退款率、`ordRfdRate` 订单退款率、`realPayrealRfdRate` 签收退款率、`sucRefundRate` 退款成功率、`rfdFinshDur` 退款处理时长（天）

**服务与物流**
`wwReplyManualAvgTimeLen` 旺旺人工响应时长（秒）、`consultRate` 咨询率、`slrRespRate` 平台判责率、`disputeDutyRatio`、`gotInTime24hRate` 24 小时揽收及时率、`gotInTime48hRate`、`avgSignTimeHh` 物流到货时长（小时）、`postTimeLenHour`、`wwGoodCstEvaRate` 好评率

**推广花费**
`p4pExpendAmt` 关键词推广费、`cubeAmt` 精准人群推广费、`feedCharge` 智能场景花费、`adStrategyAmt` 全站推广花费（旧字段）、`admCostFamtQzt` 全站推广花费、`tkExpendAmt` 淘宝客佣金、`zzExpendAmt`

**停留与其他**
`stayTime` 平均停留时长、`followStayTime`、`interestPortalUv`、`consultingUv`、`cstTransRate`、`cstUserCnt`、`shopCustomer`、`livePayAmt`、`allContentSupplyScale`、`productCoverage`、`releaseItmCnt` 在架商品数、`postVideoCheckCnt`、`buyAmtRatio`、`reVisitAmtRatio`、`statDate`、`userId`

后 12 个字段中文名未破译，`fields.json` 里 `cn` 与字段码相同，使用前需要自己对照页面核实。

## 二、客单价与订单结构（4 命令）

| 命令 | 接口 | 取什么 |
|---|---|---|
| `order-overview` | `/portal/order/index/v2.json` | 连带率、平均购买件数、客单价 |
| `order-trend` | `/portal/order/indexTrend/v2.json` | 上述指标的时序 |
| `order-distribution` | `/portal/order/distribute.json` | 客单价分布 |
| `order-recommend` | `/portal/order/recommend.json` | 搭配推荐 |

## 三、商品排行与品类（7 命令）

| 命令 | 接口 | 取什么 |
|---|---|---|
| `item-list` | `/cc/item/view/top.json` | 商品排行，实测单次返回 50 个字段 |
| `cate-list` | `/cc/cockpit/marcro/cate.json` | 品类 360，含 children 树 |
| `spu-list` | `/cc/spu/list.json` | 商品集分析，支付金额、件数、件单价 |
| `interval-analysis` | `/cc/interval/list.json` | 按价格带、支付件数、支付金额分段 |
| `macro-monitor` | `/cc/cockpit/marcro/core/live/overview.json` | 全店商品实时大盘，12 项 |
| `problem-alarm` | `/cc/prolemitem/statistics.json` 加 `/cc/exp/stock/out.json` | 质量问题、缺货、高价限流计数与缺货明细 |
| `item-relate` | `/cc/item/relate/analysis.json` | 连带分析，主商品与关联商品 |

`item-list` 字段字典收录 17 项：`payAmt` 支付金额、`payByrCnt` 支付买家数、`payRate` 支付转化率、`payItmCnt` 支付件数、`payPct` 客单价、`subPayOrdAmt`、`itmUv` 商品访客数、`itemCartCnt` 商品加购件数、`itemCltByrCnt` 商品收藏人数、`stayTimeAvg` 平均停留时长、`itmBounceRate` 商品详情页跳出率、`seGuideUv` 搜索引导访客数、`seGuidePayByrCnt` 搜索引导支付买家数、`seGuidePayRate` 搜索引导支付转化率、`sucRefundAmt` 成功退款金额、`uvAvgValue` 访客平均价值、`item` 商品对象（含标题、主图、详情链接、类目）。

`macro-monitor` 的 12 项：`payAmt`、`payByrCnt`、`payRate`、`payItmCnt`、`itmUv`、`itemCartCnt`、`itemCltByrCnt`、`itmPv` 商品浏览量、`miniDetailUv` 微详情访客数、`itemCartByrCnt` 商品加购人数、`visitCartRate` 访问加购转化率、`visitCltRate` 访问收藏转化率。

## 四、单品下钻（15 命令）

| 命令 | 接口 | 取什么 |
|---|---|---|
| `item-search` | `/cc/common/item/search.json` | 按标题、商品 ID、URL、货号搜商品，拿 itemId |
| `item-360` | `/cc/item/sale/overview.json` 加 `/cc/diagnose/coreIndex.json` | 单品核心指标、环比、销售总览 |
| `item-sku-list` | `/cc/item/sale/sku/list.json` | 各 SKU 加购、支付金额、件数、买家数；`--live` 换 `/cc/live/v2/item/sale/sku/list.json` 取库存、售罄率、可售天数 |
| `item-flow-source` | `/flow/item/source/tree/support.json` | 单品流量来源树，多级，含 uv、pv、收藏、加购、支付买家、支付金额、转化率 |
| `item-refund` | `/csp/api/refund/item/reason/list/v2.json` 加 `/cc/refund/item/sku/list.json` 加 `/cc/refund/item/prop/list.json` | 退款原因分布、各 SKU 退款、各属性退款 |
| `item-profile` | `/cc/item/archive/profile.json` | 客群画像 10 个维度，只支持单日 |
| `item-loss-risk` | `/mc/item/customers/lossrisk.json` | 客户流失去向，含友商 |
| `item-detail` | `/cc/item/detail/analysis/overview.json` 加 `/cc/item/detail/analysis/list.json` | 详情页 11 项核心指标（带同行均值与优秀），逐屏数据 11 个楼层 |
| `item-price` | `/cc/item/price/info.json` 加 `/mc/item/price/band/info/v3.json` | 价格定位与类目各价格带大盘 |
| `item-title` | `/cc/item/v2/getTitleWords.json` 加 `/cc/item/title/v2/word/recommend.json` | 标题每个词的搜索访客、零引导词、推荐词 |
| `item-bundle` | `/cc/item/bundle/recommend.json` 加 `/cc/item/bundle/sellerRecommend.json` | 关联搭配，系统推荐与卖家自选 |
| `item-content` | `/s_content/forcc/video/single/item/list.json` | 关联视频与内容的种草点击、收藏、加购、支付 |
| `item-service` | `/domain/oneQuery.json` | 单品服务体验 18 项 |
| `video-list` | `/cc/video/detail/list.json` | 各商品视频曝光、点击、播放、完播、成交 |
| `item-report` | `/cc/item/sale/trend.json` 加上述单品接口 | 七页单品诊断报告，单文件网页加 xlsx |

`item-service` 的 18 项：`validReplyUv` 有效接待人数、`preSaleConsultCnt` 售前咨询人数、`preSaleConsultRate` 售前咨询率、`preSaleDealCnt` 售前成交人数、`afterSaleConsultCnt` 售后咨询人数、`afterSaleFstSolutionRate` 售后首次解决率、`actRmkCnt` 主动评价数、`wdjVocCnt` 问大家原声量、`rfdSucCnt` 成功退款笔数，以及对应的同类均值字段。

`item-detail` 的 11 项：`itemExposeUv` 曝光人数、`itemInteractUv` 互动人数、`itemCartUv` 加购人数、`itemCollectUv` 收藏人数、`itemOrderUv` 下单人数、`itemPayUv` 支付人数、`itemLossUv` 跳失人数、`itemLossRate` 跳失率、`itemAvgStayTime` 平均停留时长、`itemCartConvertRate` 加购转化率、`itemPayConvertRate` 支付转化率。

## 五、新品追踪（3 命令）

| 命令 | 接口 | 取什么 |
|---|---|---|
| `new-product-list` | `/cc/new/product/item/list.json` | 新品明细 10 项，含发布时间、新客 uv、新客加购、新客支付 |
| `new-product-overview` | `/cc/new/product/overview.json` | 顶部汇总卡 |
| `new-product-trend` | `/cc/new/product/trend.json` | 趋势图，本店与行业两组时序 |

## 六、交易与退款（5 命令）

| 命令 | 接口 | 取什么 |
|---|---|---|
| `sale-shop-list` | `shop/sale/analysis/list` | 商品维度销售排行，店铺销售额、客服销售额、静默销售额 |
| `sale-item-list` | `item/sale/detail/list` | 订单明细，下单时间、金额、买家、客服、是否静默 |
| `refund-item-list` | `shop/refund/item/list` | 退款商品明细，完结金额、笔数、率、原因 |
| `refund-all-list` | `refund/all/detail/list`，`--by ord-pay` 换 `refund/all/detail/ord-pay/list` | 逐笔退款，含订单号与原付款时间 |
| `refund-origin-analysis` | 同上，做归因汇总 | 按原付款日与退款场景追溯 |

## 七、客服与服务（8 命令）

| 命令 | 接口 | 取什么 |
|---|---|---|
| `reception-list` | `ww/consultation/detail/list` | 接待明细，开始结束时间、买家、客服、是否回复 |
| `evaluation-list` | `evaluation/detail/list` | 邀评明细，含评价星级 |
| `sale-cs-list` | `ww/sale/detail/list` | 客服销售明细 |
| `inquiry-loss-list` | `inquiry/loss/list` | 询单流失明细 |
| `slow-rsps-list` | `slow/rsps/detail/list` | 慢响应明细 |
| `list` | `ww/consultation/detail/list` | 某日会话列表，不含消息内容 |
| `detail` | 同上 | 单个会话的全部消息，自动翻页 |
| `fetch-recent` | 上述两者组合 | 某日 N 个会话加完整对话，输出 `sessions[].meta` 与 `sessions[].messages` |

客服对话是这套工具里唯一能拿到聊天正文的能力，`messages` 每条含发送时间、发送方、接收方、正文、消息 ID。

## 八、内容与直播（3 命令）

| 命令 | 接口 | 取什么 |
|---|---|---|
| `live-guide-overview` | `/flow/new/live/guide/trend/overview.json` | 直播实时引导汇总卡 |
| `live-guide-trend` | `/flow/new/live/guide/trend.json` | 今日与昨日趋势 |
| `preheating-metrics` | `/portal/shop/preheating/dashboard/metrics.json` | 预热看板 |

## 九、导出与工具（5 命令）

| 命令 | 作用 |
|---|---|
| `excel` | 一条命令走完申请导出、排队、取 OSS 链接、下载四步，支持 7 个 preset |
| `excel-tasks` | 列出最近导出任务，含失败与排队中 |
| `menu` | 拉当前生意参谋完整菜单地图，接口 `/oneauth/api/getMenuV2.json` |
| `doctor` | 检查登录态与插件连通 |
| `api` | 通用只读探测，`api <path> --param k=v`，可调任意 sycm 域下接口 |

## 十、拿不到的东西

**跨域 iframe 里的应用。** 内容分析的真实应用挂在 `web.taobao.com/s-guanghe-creator`，插件 `SITES` 只登记了 `dmp.taobao.com`、`myseller.taobao.com`、`sycm.taobao.com`、`one.alimama.com`、`item.taobao.com` 五个发射台，这个域不在其中。现有 CDP 方案靠 `Target.setAutoAttach` 附加子 target 才能取到。

**千牛客户端的本地数据。** 插件只能取网页后台，取不到客户端本地库。聊天记录走 `ww/consultation/detail/list` 是后台接口，与客户端本地库是两回事。

**未安装模块的平台。** 扩展本身支持千牛（`myseller`）、达摩盘（`dmp`）、万相台（`one.alimama`）、竞品评价（`item.taobao`）四个域，但 CLI 当前只装了 sycm 模块。要扩能力得跑 `tb modules enable alimama` 之类，会额外下载模块包。

## 十一、口径警告，用之前必须知道

| 字段或命令 | 问题 |
|---|---|
| `payAmtRfdRate`、`ordRfdRate`、`payShopRfdAmt` | 近 7 天仍在累积，T-6 都没收完，禁止用近 7 天数据下结论 |
| `realPayrealRfdRate` 签收退款率 | T-3 才有数值，两周以上才稳定 |
| `item-360` 的 `*Cmpt` | 量级与自店值完全不符，口径未核实，不可当同行对比 |
| `item-profile` | 只支持单日，多日会被服务端静默返回空数组 |
| `item-profile` 的成交人群与搜索人群 | 样本量门槛 300 人，小流量商品永远为空 |
| `item-loss-risk` 的 `customerCnt` | 多日区间会被服务端静默去掉 |
| `item-title` 的零引导词 | 表现为缺列，不是数值 0 |
| `spu-list` | 只支持单日，多日返回 param check error |
| `macro-monitor`、`problem-alarm` | 实时快照，`--date` 完全不生效 |
| `item-content` | 默认近 30 天，内容效果看单日没有意义 |
| `new-product-overview`、`new-product-trend` | 显式传 7 天或 30 天区间会报 1003 |
| 日期窗口 | 只支持 1、7、15、30 天，其他宽度服务端以 code 1003 拒绝 |

## 十二、与工作台契约的交叉对照

工作台日增需要 5 个数据块，这套工具的直接覆盖情况：

| 数据块 | 字段数 | 直接覆盖 | 缺什么 |
|---|---|---|---|
| 逐日 | 4 | 3 | `itemVisitors` |
| 整段 summary | 13 | 9 | `itemVisitors`、`bounceRate`、`itmAvgPv`、`newPayByrCnt` |
| item 维度 | 6 | 6 | 无 |
| channel 维度 | 4 | 0 | 全部，需裸探测 `tree_platform_support` |
| area 维度 | 4 | 0 | 全部，需裸探测 `listAreas` |
| keyword 维度 | 2 | 0 | 全部，需裸探测 `drainageSearch` |

缺的 5 个指标全部来自 `/flow/monitor/overview` 的 `overview.json`，一条裸探测可以补齐。
