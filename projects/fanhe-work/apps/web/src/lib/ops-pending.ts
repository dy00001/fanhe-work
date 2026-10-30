/**
 * 尚未接入的指标清单。
 *
 * 这份清单存在的理由，是**让「空着」这件事有解释**。服务、推广、内容三个板块目前
 * 没有真实数据，如果页面只显示一片空白，使用者会以为是接口坏了；如果显示演示数字，
 * 他会拿去做决策。两者都比不上「明确告诉他差哪几个数、卡在哪一步」。
 *
 * 内容直接对应 `tools/collector/docs/新增指标采集映射清单.md` 的 20 项表格。
 * **两份不会自动同步**：那份文档是采集侧的施工清单（会随实施进度改），这份是界面
 * 上的对外说明（只在状态变化时改）。改动时以文档为准，改完顺手更新这里，并在提交
 * 信息里写明是哪几项转了真实。
 *
 * 键名与 `packages/shared/src/ops.ts` 的 `OPS_SUMMARY_METRICS` 同源：那份常量决定
 * 界面从哪里取值（summary 里有没有这一行），这份清单决定页面上怎么解释「为什么还没有」。
 * 状态从 pending 转 ready 时两处一起改，否则会出现「数字已经显示出来，清单还在说没接入」。
 *
 * 状态只有两种取值：`ready` 表示已上真实数据（不该出现在这份清单里），`pending`
 * 表示还没有。刻意不写「预计完成时间」—— 那类字段一旦写上去就会过期，而过期的
 * 计划比没有计划更误导。
 */

export type OpsPendingBatch = 'B' | 'C' | 'D' | 'E' | 'F'

export type OpsPendingItem = {
  name: string
  /** 契约里的字段名。给接手的人一个可以直接搜代码的锚点。 */
  field: string
  /** 后台入口。「为什么还没采」的第一层解释。 */
  backend: string
  batch: OpsPendingBatch
  /** 卡点。空串表示只差跑一次采集。 */
  blockedBy: string
}

/** 服务体验页。 */
export const OPS_PENDING_SERVICE: readonly OpsPendingItem[] = [
  {
    name: '三分钟人工响应率',
    field: 'csThreeMinRate',
    backend: '千牛 › 客服绩效 › 响应',
    batch: 'B',
    blockedBy: '',
  },
  {
    name: '旺旺人工平均响应时长',
    field: 'csFirstRespSec',
    backend: '千牛 › 客服绩效 › 响应',
    batch: 'B',
    blockedBy: '',
  },
  {
    name: '咨询数量',
    field: 'consultCnt',
    backend: '千牛 › 客服绩效 › 咨询量',
    batch: 'B',
    blockedBy: '',
  },
  {
    name: '评价待商家回复',
    field: 'rateUnrepliedCnt',
    backend: '卖家中心 › 评价管理 › 待回复',
    batch: 'B',
    blockedBy: '需补页面路径与接口录制',
  },
  {
    name: '问大家待回答',
    field: 'wendaPendingCnt',
    backend: '千牛 › 问大家 › 待回答',
    batch: 'B',
    blockedBy: '接口不稳定，需 DOM 兜底',
  },
  {
    name: '服务保障状态',
    field: 'protectStatus',
    backend: '商家保障中心 › 我的保障',
    batch: 'E',
    blockedBy: '',
  },
]

/** 推广投放页。 */
export const OPS_PENDING_ADS: readonly OpsPendingItem[] = [
  {
    name: '关键词推广点击率',
    field: 'kwCtr',
    backend: '万相台无界 › 关键词推广 › 报表',
    batch: 'D',
    blockedBy: '需要万相台独立登录态',
  },
  {
    name: '关键词推广花费',
    field: 'kwCost',
    backend: '万相台无界 › 关键词推广 › 账户',
    batch: 'D',
    blockedBy: '需要万相台独立登录态',
  },
  {
    name: '万象台账户余额',
    field: 'wxtBalance',
    backend: '万相台无界 › 账户 › 余额',
    batch: 'D',
    blockedBy: '需要万相台独立登录态',
  },
]

/** 内容运营页。 */
export const OPS_PENDING_CONTENT: readonly OpsPendingItem[] = [
  {
    name: '内容查看人数',
    field: 'contentViewUv',
    backend: '光合平台 › 内容中心 › 数据',
    batch: 'D',
    blockedBy: '需要光合平台独立登录态',
  },
  {
    name: '内容商品点击人数',
    field: 'contentItemClickUv',
    backend: '光合平台 › 内容中心 › 数据',
    batch: 'D',
    blockedBy: '需要光合平台独立登录态',
  },
  {
    name: '内容活动人数',
    field: 'contentActUv',
    backend: '光合平台 › 内容中心 › 活动',
    batch: 'D',
    blockedBy: '需要光合平台独立登录态',
  },
]

/** 商品分析页的健康区块。 */
export const OPS_PENDING_ITEMS: readonly OpsPendingItem[] = [
  {
    name: '全部违规数量',
    field: 'violationCnt',
    backend: '千牛工作台 › 体检中心 › 违规记录',
    batch: 'C',
    blockedBy: '需接口录制 + DOM 兜底',
  },
  {
    name: '商品基础分',
    field: 'itemBaseScore',
    backend: '千牛 › 商品管理 › 商品诊断',
    batch: 'C',
    blockedBy: '需逐商品循环，采集量大',
  },
  {
    name: '商品扶优分',
    field: 'itemBoostScore',
    backend: '千牛 › 商品管理 › 扶优计划',
    batch: 'C',
    blockedBy: '需逐商品循环，采集量大',
  },
  {
    name: '素材完整 / 过期',
    field: 'materialExpiredCnt',
    backend: '千牛 › 商品管理 › 素材体检',
    batch: 'C',
    blockedBy: '需逐商品三态判定',
  },
]

/** 交易与流量里已经接入的部分，写在这里是为了让「已有什么」与「缺什么」同屏可读。 */
export const OPS_READY_SUMMARY: readonly { view: string; metrics: string; note: string }[] = [
  {
    view: '总览 / 交易',
    metrics: '支付金额、支付买家、访客、商品访客',
    note: '逐日真值，可任意区间重算',
  },
  { view: '总览 / 交易', metrics: '支付转化率、客单价', note: '由逐日真值相除，随区间重算' },
  {
    view: '商品',
    metrics: '商品 Top10 的访客、买家、转化率、支付与加购金额',
    note: '整段口径，仅 30 天窗口',
  },
  {
    view: '流量',
    metrics: '渠道结构、地域、搜索词、内容来源、跳失率、停留时长',
    note: '整段口径，不随区间变',
  },
  { view: '推广', metrics: '活动报名是否成功（8 个活动）', note: '已采到，尚未单独成块' },
]

export const OPS_BATCH_TABLE: readonly {
  batch: OpsPendingBatch
  scope: string
  state: 'done' | 'next' | 'blocked'
  note: string
}[] = [
  {
    batch: 'B',
    scope: '客服绩效三项、评价、问大家',
    state: 'next',
    note: '千牛登录态已有，改日期参数即可重跑',
  },
  {
    batch: 'C',
    scope: '违规、商品评分、素材体检',
    state: 'next',
    note: '需逐商品循环，采集量较大',
  },
  {
    batch: 'D',
    scope: '万相台三项、光合三项',
    state: 'blocked',
    note: '需两套独立登录态，要人配合扫码',
  },
  { batch: 'E', scope: '服务保障状态', state: 'next', note: '单字段，随 B 批一起跑' },
  { batch: 'F', scope: '分店 2 至 5 全量', state: 'blocked', note: '需 4 套店铺授权' },
]
