/**
 * 六张模块入口卡里的数字。
 *
 * 抽成纯函数而不是留在页面组件里，是因为这里的对错只有开浏览器才看得出：该显示
 * 真值的位置显示成「待接入」，界面看起来完全正常，也没有任何断言会失败。
 *
 * 取值口径统一为「summary 里有没有这一行」：有就按单位格式化，没有就显示待接入。
 * **不补 0**，也不把 `null` 格式化成破折号 —— 破折号会被读成「这一项有口径、当前
 * 为零」，而实际含义是这一项还没接进来。
 */

import {
  NAV_CODES,
  opsSummaryMetric,
  type NavCode,
  type OpsDashboardResponse,
  type OpsShopBoard,
  type OpsSummaryMetricKey,
} from '@fanhe/shared'

// 相对导入写全 `.ts`：本模块要能在 Node 的 `--experimental-strip-types` 下被单测
// 直接加载，而 Node ESM 不会自动补扩展名（既有先例见 `launch-detect.ts`）。
import { formatCount, formatDuration, formatFen, formatPercent } from './ops-display.ts'

/** 未接入的占位文案。全项目只有这一处定义。 */
export const OPS_MODULE_PENDING = '待接入'

export type OpsModuleCardNumber = { label: string; value: string }

export type OpsModuleCard = {
  code: NavCode
  label: string
  desc: string
  numbers: readonly OpsModuleCardNumber[]
}

export function buildOpsModuleCards(
  data: OpsDashboardResponse,
  shops: readonly OpsShopBoard[],
  current: OpsShopBoard | null,
): readonly OpsModuleCard[] {
  const total = sumFen(shops.map((board) => board.payAmountFen))
  const sold = data.dimensions.items.rows.filter(
    (row) => typeof row.metrics.payAmountFen === 'number' && row.metrics.payAmountFen > 0,
  ).length

  /*
   * 取值 + 标注来源日期。
   *
   * 少数指标平台只按日出（`OPS_DAILY_ONLY_SUMMARY_KEYS`），接口会在
   * `supplementedFrom` 里说明这一行来自哪一天。此时数值后面必须带日期 ——
   * 页头写着「近 30 天」而卡片显示某一天的响应率、却不注明，是把两个口径
   * 混成一句话，比不显示更容易误判。
   */
  const metric = (key: OpsSummaryMetricKey, format: (value: number) => string): string => {
    const group = data.dimensions.summary
    const value = opsSummaryMetric(group, key)
    if (value === null) return OPS_MODULE_PENDING
    const text = format(value)
    const from = group.supplementedFrom
    if (from === null || from === undefined) return text
    if (!(group.supplementedKeys ?? []).includes(key)) return text
    return `${text} · ${from.to.slice(5)}`
  }

  /*
   * 内容来源访客是唯一按「有没有行」判断的一项：它取自 content 维度，不在 summary
   * 里。reduce 的初值是 0，所以必须先判空，否则「没采到」会被显示成「访客为零」。
   */
  const contentVisitors = (): string => {
    const rows = data.dimensions.content.rows
    if (rows.length === 0) return OPS_MODULE_PENDING
    const sum = rows.reduce((acc, row) => {
      const value = row.metrics.visitors
      return acc + (typeof value === 'number' ? value : 0)
    }, 0)
    return formatCount(sum)
  }

  return [
    {
      code: NAV_CODES.OPS_TRADE,
      label: '交易分析',
      desc: '区间重算、逐日明细、转化与客单价',
      numbers: [
        { label: '当前店铺', value: formatFen(current?.payAmountFen ?? null, { compact: true }) },
        { label: '五店合计', value: formatFen(total, { compact: true }) },
      ],
    },
    {
      code: NAV_CODES.OPS_ITEMS,
      label: '商品分析',
      desc: '链接表现、零成交诊断、素材与评分健康',
      numbers: [
        { label: '有成交链接', value: `${sold} / ${data.dimensions.items.rows.length}` },
        { label: '商品基础分', value: metric('itemBaseScore', formatCount) },
      ],
    },
    {
      code: NAV_CODES.OPS_FLOW,
      label: '流量分析',
      desc: '渠道结构、推荐与搜索拆分、地域与搜索词',
      numbers: [
        { label: '推荐访客', value: metric('flowRecommendUv', formatCount) },
        { label: '跳失率', value: metric('bounceRate', (value) => formatPercent(value, 1)) },
      ],
    },
    /*
     * 服务卡的第二格用「平均响应时长」而不是「待回复」。
     *
     * 待回复（`rateUnrepliedCnt`）2026-10-30 已经接进来了（自建千牛模块），所以
     * 原来的理由「卡片上只会常年显示待接入」不再成立 —— 换掉它是**口径上的选择**：
     * 响应率与响应时长同源同批（都是 csp 的 base_avg 行），两个数放在一起回答的是
     * 「回得快不快、快多少秒」；待回复是采集时刻的待办快照，跟这两个数不在一个
     * 时间尺度上（一个是当天的比率，一个是此刻的欠账），拼在一起会让人误读成
     * 「今天待回复了这么多」。待回复在服务页的格子里能看到。
     */
    {
      code: NAV_CODES.OPS_SERVICE,
      label: '服务体验',
      desc: '响应率、响应时长、咨询量、评价与问大家',
      numbers: [
        {
          label: '三分钟响应',
          value: metric('csThreeMinRate', (value) => formatPercent(value, 1)),
        },
        { label: '平均响应', value: metric('csAvgReplySec', (value) => formatDuration(value)) },
      ],
    },
    {
      code: NAV_CODES.OPS_ADS,
      label: '推广投放',
      desc: '关键词推广效率、账户余额、活动报名',
      numbers: [
        {
          label: '推广花费',
          value: metric('kwCost', (value) => formatFen(value, { compact: true })),
        },
        { label: '点击率', value: metric('kwCtr', (value) => formatPercent(value, 1)) },
      ],
    },
    {
      code: NAV_CODES.OPS_CONTENT,
      label: '内容运营',
      desc: '内容曝光到商品点击的转化链路',
      numbers: [
        { label: '内容来源访客', value: contentVisitors() },
        { label: '内容查看', value: metric('contentViewUv', formatCount) },
      ],
    },
  ]
}

/** 金额求和：全部为 null（未接入 / 无权限）时返回 null，不返回 0。 */
function sumFen(values: readonly (number | null)[]): number | null {
  let total = 0
  let seen = false
  for (const value of values) {
    if (value === null) continue
    total += value
    seen = true
  }
  return seen ? total : null
}
