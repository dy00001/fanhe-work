import type { OpsShopBoard } from '@fanhe/shared'

import { formatCount, formatFen, formatPercent } from '../../lib/ops-display'
import { cn } from '../../lib/utils'
import { OpsChip } from './OpsChip'
import { OpsSection } from './OpsSection'

/**
 * 五店并列指标带。结构与原型 `.store-strip / .store` 一致：
 * 店名 + 数据状态标 → 支付金额 → 买家 / 访客 / 转化 → 迷你柱。
 *
 * 与原型的两处差别，都是数据现实决定的：
 *
 * 1. **不放大数字的「演示」标，改标「待接入」。** 原型给四家分店按主店倍率生成演示
 *    数据，所以需要「演示」标来提醒；这里没有生成任何数，未接入的店显示「—」与
 *    「待接入」，不存在被误读成真实值的可能。
 * 2. **迷你柱只画有数据的日子。** 原型对演示店按倍率摊到日粒度（还要用最大余数法
 *    避免四舍五入把 8 人摊成 1 人）；这里没有分摊这一步 —— 没有数据就是没有柱子，
 *    比画一排零更诚实。
 *
 * 卡片本身是按钮：点击切换聚焦店，与地址栏 `?shop=` 联动。未接入的店**照样可点**，
 * 点进去看到的是同一套布局的空态，这是「占位处理，交互方式一致」的具体含义。
 */
export function OpsShopStrip(props: {
  boards: readonly OpsShopBoard[]
  selected: string | null
  onSelect: (code: string) => void
}) {
  return (
    <OpsSection
      title="五店并列"
      note={`共 ${props.boards.length} 家 · 点卡片切换聚焦，后续页面同步跟随`}
    >
      {props.boards.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground-weak">还没有登记店铺</p>
      ) : (
        <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {props.boards.map((board) => {
            const active = board.shop.code === props.selected
            return (
              <button
                key={board.shop.code}
                type="button"
                onClick={() => {
                  props.onSelect(board.shop.code)
                }}
                aria-pressed={active}
                title={`${board.shop.name}${board.hasData ? '' : ' · 尚未接入采集'}`}
                className={cn(
                  'flex flex-col gap-2 rounded-xl border bg-card px-3.5 py-3 text-left transition-colors',
                  active ? 'border-primary' : 'border-border hover:border-foreground/25',
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm text-foreground">{board.shop.name}</span>
                  <span className="ml-auto">
                    {board.hasData ? (
                      <OpsChip tone="teal">真实</OpsChip>
                    ) : (
                      <OpsChip tone="muted">待接入</OpsChip>
                    )}
                  </span>
                </span>

                <span className="text-xl font-medium tracking-tight text-foreground tabular-nums">
                  {board.hasData ? formatFen(board.payAmountFen, { compact: true }) : '—'}
                </span>

                <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                  <span>
                    买家{' '}
                    <b className="font-normal text-foreground">{formatCount(board.payBuyers)}</b>
                  </span>
                  <span>
                    访客{' '}
                    <b className="font-normal text-foreground">{formatCount(board.visitors)}</b>
                  </span>
                  <span>
                    转化{' '}
                    <b className="font-normal text-foreground">{formatPercent(board.payRate)}</b>
                  </span>
                </span>

                <Sparkline series={board.series} />
              </button>
            )
          })}
        </div>
      )}
    </OpsSection>
  )
}

/**
 * 近 14 天迷你柱。取区间内最后 14 个有数据的日子，按区间峰值归一。
 *
 * 没有数据时**不画零柱**，留一条浅底说明 —— 一排零柱看起来像「每天都没成交」，
 * 而真实语义是「这家店还没接入」。
 */
function Sparkline(props: { series: OpsShopBoard['series'] }) {
  const points = props.series.filter((point) => point.payAmountFen !== null).slice(-14)
  if (points.length === 0) {
    return (
      <span className="mt-0.5 flex h-4 items-center text-[10px] text-muted-foreground-weak">
        暂无逐日数据
      </span>
    )
  }

  /*
   * 迷你柱按**平方根**压缩。
   *
   * 主图表坚持线性（柱高等于数值），但这里只有 16px 高、纯粹是装饰：10-08 那根
   * 49,000 会把其余十三根压成一条 2px 的灰线，看起来像渲染坏了。压缩只作用在
   * 这一条装饰带上，读数仍由 `title` 给出精确值 —— 这是"形状可以近似、数字不能"
   * 的那一类例外，且做了标注。
   */
  const peak = Math.max(1, ...points.map((point) => Math.sqrt(point.payAmountFen ?? 0)))
  return (
    <span
      className="mt-0.5 flex h-4 items-end gap-[2px]"
      title="近 14 日支付金额，柱高按平方根压缩，仅看趋势"
    >
      {points.map((point) => {
        const value = point.payAmountFen ?? 0
        return (
          <i
            key={point.date}
            title={`${point.date} ${formatFen(point.payAmountFen, { compact: true })}`}
            className={cn('flex-1 rounded-sm', value === 0 ? 'bg-border' : 'bg-m-neutral/45')}
            style={{
              height: `${value === 0 ? 2 : Math.max(3, (Math.sqrt(value) / peak) * 100)}%`,
            }}
          />
        )
      })}
    </span>
  )
}
