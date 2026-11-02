import type { CustomerSummary } from '@fanhe/shared'

import { formatWan } from '../../lib/customer-display'

/**
 * 综合看板顶部的指标卡。
 *
 * 四个数字全部来自同一个 `summary`，也就是与两张环形图、折线图和列表同一份响应。
 * 各自单独请求的话，「筛了地区以后卡片变了、图没变」这种偏差迟早会出现，而它不报错。
 *
 * **金额被裁掉时写「无权限查看」。** 写 0 会让「看不到」与「确实是零」混成同一个
 * 画面，而后者会让人以为这批客户一单没签。
 */
function countText(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

export function CustomerKpiCards(props: {
  summary: CustomerSummary
  /** 命中筛选的总数，与 `summary` 来自同一份响应。 */
  total: number
  /** 当前时间范围的说明，写进「新增」卡的副标题。 */
  rangeLabel: string
  /** 是否限定了时间范围。没有限定的话，「新增」等于总数，副标题要讲清楚。 */
  hasRange: boolean
}) {
  const { summary } = props
  const amount = summary.amountTotalFen

  const cards = [
    {
      key: 'total',
      label: '客户总数',
      value: countText(props.total),
      hint: '当前筛选条件下的客户数',
    },
    {
      key: 'in-progress',
      label: '进行中',
      value: countText(summary.kpi.inProgress),
      hint: '未完结且未流失',
    },
    {
      key: 'new',
      label: '新增客户',
      value: countText(summary.kpi.newInWindow),
      hint: props.hasRange ? `首次沟通落在${props.rangeLabel}` : '未限定时间范围，等于总数',
    },
    {
      key: 'amount',
      label: '合同额合计',
      value: amount === null ? '无权限查看' : formatWan(amount),
      hint: amount === null ? '需要「查看客户金额」权限' : '当前筛选内客户合同额之和',
    },
  ]

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {cards.map((card) => (
        <div key={card.key} className="rounded-xl border border-border bg-card px-4 py-3.5">
          <p className="text-xs text-muted-foreground">{card.label}</p>
          <p
            className={
              card.key === 'amount' && amount === null
                ? 'mt-1.5 text-base text-muted-foreground-weak'
                : 'mt-1.5 text-2xl font-medium tracking-tight text-foreground tabular-nums'
            }
          >
            {card.value}
          </p>
          <p className="mt-1 text-[11px] text-muted-foreground-weak">{card.hint}</p>
        </div>
      ))}
    </div>
  )
}
