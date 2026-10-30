/**
 * 服务体验页四个（以及将来更多）指标格的取值与口径说明。
 *
 * 为什么抽成纯函数：这一块的对错只有开浏览器才看得出来 —— 该显示真值的位置显示
 * 「待接入」，界面看起来完全正常，没有任何断言会红。抽出来之后可以用 Node 直接
 * 跑断言（同 `ops-module-cards.ts`）。
 *
 * 三条口径决定：
 *
 *   1. **指标清单来自契约**：`OPS_SUMMARY_METRICS` 里 `module === 'service'` 的项。
 *      接一个新指标只改契约，这里自动长出一格；在组件里手写清单必然漂。
 *   2. **有没有数据看 summary 里有没有这一行**，不看契约里的 `pending`。`pending`
 *      是施工状态说明，接了但当天采集失败时它照样是 false，此时该显示「待接入」。
 *   3. **单日口径必须带日期**。客服指标平台只按日出（`dateType=1d`），30 天视图里
 *      显示的是某一天的值。把「10-29 的 100%」放在「近 30 天」的页头下面不加注，
 *      比不显示更容易让人误判。
 */

import {
  OPS_SUMMARY_METRICS,
  opsSummaryMetric,
  type OpsDimensionGroup,
  type OpsMetricUnit,
  type OpsSummaryMetricKey,
} from '@fanhe/shared'

// 相对导入写全 `.ts`：本模块要能在 Node 的 `--experimental-strip-types` 下被单测
// 直接加载（先例见 `ops-module-cards.ts`）。
import { OPS_MODULE_PENDING } from './ops-module-cards.ts'
import { formatCount, formatDuration, formatFen, formatPercent } from './ops-display.ts'

/** 未接入的占位文案。全项目只由 `ops-module-cards.ts` 定义，这里只做转发。 */
export { OPS_MODULE_PENDING }

const UNIT_VALUE: Record<OpsMetricUnit, (value: number) => string> = {
  fen: (value) => formatFen(value, { compact: true }),
  count: (value) => formatCount(value),
  percent: (value) => formatPercent(value, 1),
  minute: (value) => formatDuration(value),
  second: (value) => formatDuration(value),
}

/**
 * 每个指标的来源与口径，悬停可见。
 *
 * 不写进 `OPS_SUMMARY_METRICS`：那份常量是跨进程契约，`hint` 是界面文案，
 * 混进去会让采集端也被迫维护一段中文说明。表里查不到就退化为契约 label。
 */
export const OPS_SERVICE_HINT: Record<string, string> = {
  csThreeMinRate: '千牛 › 客服绩效 › 三分钟人工响应率，取本店（base_avg）行',
  csAvgReplySec: '千牛 › 客服绩效 › 平均响应时长，取本店（base_avg）行，单位秒',
  csConsultUv: '千牛 › 客服绩效 › 咨询人数（去重），取本店（base_avg）行',
  csReplyUv: '千牛 › 客服绩效 › 接待人数（去重），取本店（base_avg）行',
  rateUnrepliedCnt: '卖家中心 › 评价管理 › 待回复，接口尚未录制',
}

export type OpsServiceCell = {
  key: OpsSummaryMetricKey
  label: string
  /** 已格式化好的展示值。`null` 表示这一项还没接进来，界面显示「待接入」。 */
  value: string | null
  hint: string
}

export type OpsServiceView = {
  /** 一段口径说明，挂在区块标题右侧。 */
  note: string
  cells: readonly OpsServiceCell[]
}

export function buildServiceMetrics(group: OpsDimensionGroup | null): OpsServiceView {
  /*
   * 口径说明分三种情况，不能合并成一句：
   *   补进来的 → 必须带具体日期；
   *   本来就是单日窗口 → 说明是单日，但不必强调「补」；
   *   什么都没有 → 直接说没数据，别让四个「待接入」自己去解释。
   */
  const supplemented = group?.supplementedFrom ?? null
  const window = group?.window ?? null
  const note =
    supplemented !== null
      ? `单日口径 · 数据日期 ${supplemented.to}，平台只按日出，不随页面区间累加`
      : window !== null
        ? `${window.from} 单日快照`
        : '还没有客服数据'

  const cells = OPS_SUMMARY_METRICS.filter((spec) => spec.module === 'service').map((spec) => {
    const value = opsSummaryMetric(group, spec.key)
    return {
      key: spec.key,
      label: spec.label,
      value: value === null ? null : UNIT_VALUE[spec.unit](value),
      hint: OPS_SERVICE_HINT[spec.key] ?? spec.label,
    }
  })

  return { note, cells }
}
