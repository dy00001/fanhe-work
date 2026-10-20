import type { NavItem, OpsDailyPoint } from '@fanhe/shared'
import { ChartColumn } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { ModuleHeader } from '../components/ModuleHeader'
import { EmptyState, ErrorState, LoadingState } from '../components/StateView'
import { OpsChannelList } from '../components/ops/OpsChannelList'
import { OpsHealthPanel } from '../components/ops/OpsHealthPanel'
import { OpsItemTable } from '../components/ops/OpsItemTable'
import { OpsKpiGrid } from '../components/ops/OpsKpiGrid'
import { OpsPendingPanel } from '../components/ops/OpsPendingPanel'
import { OpsRankList } from '../components/ops/OpsRankList'
import { OpsSummaryGrid } from '../components/ops/OpsSummaryGrid'
import { OpsTrendChart } from '../components/ops/OpsTrendChart'
import { OpsToolbar } from '../components/ops/OpsToolbar'
import {
  OPS_PENDING_ADS,
  OPS_PENDING_CONTENT,
  OPS_PENDING_ITEMS,
  OPS_PENDING_SERVICE,
} from '../lib/ops-pending'
import { chineseDate, formatCount, formatFen, freshnessOf, shortDate } from '../lib/ops-display'
import { ApiError } from '../lib/api'
import { opsFailureExit } from '../lib/ops'
import { isOpsPreset, isOpsView, presetDays, type OpsPreset, type OpsView } from '../lib/ops-view'
import { useOpsDashboard, useOpsHealth } from '../lib/use-ops-dashboard'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table'

/**
 * 运营数据看板（`/ops/dashboard`）。
 *
 * 这个页面的每一条设计取舍都指向同一件事：**让数字的来源可被追问**。看板上的数
 * 会被拿去和生意参谋对照，对不上时最需要的是「这是哪天的、哪个口径、采到了没有」，
 * 而不是一个更漂亮的图表。因此：
 *
 *   - 每张指标卡带口径徽标（逐日 / 推算 / 整段），点开有解释；
 *   - 维度区块（渠道、商品、地域、搜索词）自带窗口说明，因为整段口径不随区间变；
 *   - 页头有新鲜度与采集记录入口；
 *   - 没有真实数据的板块不给演示数字，给「缺什么、卡在哪」。
 *
 * 视图切换与区间都写进地址栏：刷新不丢、链接可分享、后退符合直觉。
 *
 * **没有引图表库。** 趋势图是手写柱状，理由见 `OpsTrendChart` 顶部。加一个 100KB
 * 的依赖只为一根柱子，同时还会带进第二套主题系统。
 */

/** 逐日明细。交易页用，回答「具体哪一天」的问题。 */
function DailyTable(props: { series: readonly OpsDailyPoint[] }) {
  const rows = [...props.series].reverse()
  return (
    <div className="rounded-xl border border-border bg-card px-5 pt-4 pb-4">
      <h2 className="text-sm font-medium text-foreground">逐日明细</h2>
      <p className="mt-1 text-xs text-muted-foreground-weak">
        按日期倒序 · 四个指标都是当日真值，可直接相加核对
      </p>
      <Table className="mt-3">
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs font-normal text-muted-foreground-weak">日期</TableHead>
            <TableHead className="text-right text-xs font-normal text-muted-foreground-weak">
              支付金额
            </TableHead>
            <TableHead className="text-right text-xs font-normal text-muted-foreground-weak">
              支付买家
            </TableHead>
            <TableHead className="text-right text-xs font-normal text-muted-foreground-weak">
              访客
            </TableHead>
            <TableHead className="text-right text-xs font-normal text-muted-foreground-weak">
              商品访客
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((point) => (
            <TableRow key={point.date}>
              <TableCell className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {chineseDate(point.date)}
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums">
                {formatFen(point.payAmountFen, { compact: true })}
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums">
                {formatCount(point.payBuyers)}
              </TableCell>
              <TableCell className="text-right text-sm tabular-nums">
                {formatCount(point.visitors)}
              </TableCell>
              <TableCell className="text-right text-sm text-muted-foreground tabular-nums">
                {formatCount(point.itemVisitors)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function OpsDashboardPage({ item }: { item: NavItem }) {
  const [params, setParams] = useSearchParams()
  const [healthOpen, setHealthOpen] = useState(false)

  const viewParam = params.get('view')
  const view: OpsView = isOpsView(viewParam) ? viewParam : 'overview'

  const presetParam = params.get('p')
  const preset: OpsPreset = isOpsPreset(presetParam) ? presetParam : '30d'

  const customFrom = params.get('from') ?? ''
  const customTo = params.get('to') ?? ''
  const customReady = preset === 'custom' && customFrom !== '' && customTo !== ''

  const query = customReady
    ? { from: customFrom, to: customTo }
    : { days: preset === 'custom' ? presetDays('30d') : presetDays(preset) }

  const dashboard = useOpsDashboard({
    ...query,
    shop: null,
    enabled: true,
  })

  const data = dashboard.state.status === 'ready' ? dashboard.state.data : null
  const health = useOpsHealth({
    shop: data?.shop.code ?? null,
    enabled: healthOpen && data !== null,
  })

  // 时间基准每次渲染都取当前时刻。用 useMemo 缓存会让「3 小时前」在页面挂了半
  // 天后仍是旧值，而新鲜度这块正是用来判断「数据还新不新」的。
  const now = new Date()
  const freshness = freshnessOf(data?.shop.lastCollectedAt ?? null, now)

  /** 写地址栏。空值一律删掉参数，避免 `?p=&from=` 这种噪声进入分享链接。 */
  const patchParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    setParams(next, { replace: true })
  }

  const rangeLabel =
    data === null
      ? '—'
      : `${shortDate(data.range.from)} ~ ${shortDate(data.range.to)} · ${data.days} 天`

  const rangeNote = customReady
    ? '自定义区间'
    : preset === 'custom'
      ? '请选择起止日期，未选时按近 30 天'
      : '以库里最新一天为终点'

  return (
    <div className="flex flex-col gap-4">
      <ModuleHeader item={item} />

      <OpsToolbar
        view={view}
        onView={(next) => {
          patchParams({ view: next === 'overview' ? null : next })
        }}
        preset={preset}
        onPreset={(next) => {
          if (next === 'custom') {
            // 切到自定义时，把当前实际区间预填进两个输入框。不预填的话两个框是空的，
            // 而「空」在这个页面意味着回落到近 30 天，用户会以为点击没生效。
            patchParams({
              p: 'custom',
              from: data?.range.from ?? customFrom,
              to: data?.range.to ?? customTo,
            })
            return
          }
          patchParams({ p: next === '30d' ? null : next, from: null, to: null })
        }}
        customFrom={customFrom}
        customTo={customTo}
        onCustomRange={(from, to) => {
          patchParams({ p: 'custom', from, to })
        }}
        rangeLabel={rangeLabel}
        rangeNote={rangeNote}
        freshness={freshness}
        lastCollectedAt={data?.shop.lastCollectedAt ?? null}
        healthOpen={healthOpen}
        onToggleHealth={() => {
          setHealthOpen((open) => !open)
        }}
      />

      {healthOpen ? (
        <OpsHealthPanel state={health.state} onReload={health.reload} now={now} />
      ) : null}

      {dashboard.state.status === 'loading' ? <LoadingState label="正在加载运营数据" /> : null}

      {dashboard.state.status === 'error' ? (
        <OpsErrorPanel error={dashboard.state.error} onRetry={dashboard.reload} />
      ) : null}

      {dashboard.state.status === 'ready' && data !== null ? (
        data.flags.dailyDays === 0 && data.dimensions.items.rows.length === 0 ? (
          <EmptyState
            icon={ChartColumn}
            title="这段时间还没有数据"
            description={`库里最新一天是 ${
              data.flags.covered === null ? '暂无' : chineseDate(data.flags.covered.to)
            }。换一个区间，或先跑一次采集。`}
          />
        ) : (
          <div className="flex flex-col gap-3">
            {view === 'overview' ? (
              <>
                <OpsKpiGrid items={data.kpi} />
                <OpsTrendChartPanel view="overview" data={data} />
                <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
                  <OpsChannelList group={data.dimensions.channels} />
                  <OpsItemTable group={data.dimensions.items} limit={6} />
                </div>
              </>
            ) : null}

            {view === 'trade' ? (
              <>
                <OpsKpiGrid items={data.kpi} />
                <OpsTrendChartPanel view="trade" data={data} />
                <DailyTable series={data.series} />
              </>
            ) : null}

            {view === 'items' ? (
              <>
                <OpsItemTable group={data.dimensions.items} />
                <OpsPendingPanel
                  title="商品健康度"
                  intro="违规、评分与素材体检需要逐商品采集，当前页只展示成交与流量表现。以下四项尚未接入。"
                  items={OPS_PENDING_ITEMS}
                />
              </>
            ) : null}

            {view === 'flow' ? (
              <>
                <OpsSummaryGrid group={data.dimensions.summary} title="流量结构指标" />
                <div className="grid items-start gap-3 lg:grid-cols-2">
                  <OpsChannelList group={data.dimensions.channels} />
                  <OpsRankList
                    title="地域分布"
                    group={data.dimensions.areas}
                    valueKey="visitors"
                    valueLabel="访客"
                    shareKey="ratio"
                  />
                  <OpsRankList
                    title="搜索词"
                    group={data.dimensions.keywords}
                    valueKey="visitors"
                    valueLabel="访客"
                  />
                  <OpsRankList
                    title="内容来源"
                    group={data.dimensions.content}
                    valueKey="visitors"
                    valueLabel="访客"
                  />
                </div>
              </>
            ) : null}

            {view === 'service' ? (
              <OpsPendingPanel
                title="服务体验"
                intro="客服绩效与评价数据都在千牛后台，登录态已有，缺的是页面路径与接口录制。以下六项尚未接入。"
                items={OPS_PENDING_SERVICE}
              />
            ) : null}

            {view === 'ads' ? (
              <OpsPendingPanel
                title="推广投放"
                intro="万相台无界是独立后台，需要单独登录一次才能复用会话。以下三项尚未接入。"
                items={OPS_PENDING_ADS}
              />
            ) : null}

            {view === 'content' ? (
              <OpsPendingPanel
                title="内容运营"
                intro="光合平台是独立后台，且已知内容板块接口抓到但不渲染数据面板。以下三项尚未接入。"
                items={OPS_PENDING_CONTENT}
              />
            ) : null}

            <p className="px-1 text-[11px] leading-relaxed text-muted-foreground-weak">
              数据来源：生意参谋 / 千牛后台采集，采集器在 tools/collector。
              整段口径的区块（渠道、商品、地域、搜索词、结构指标）窗口固定，不随上方区间变。
            </p>
          </div>
        )
      ) : null}
    </div>
  )
}

/** 趋势区块。总览只放金额，交易页并列放金额与访客 —— 两条纵轴各自独立。 */
function OpsTrendChartPanel(props: {
  view: 'overview' | 'trade'
  data: { series: readonly OpsDailyPoint[] }
}) {
  if (props.view === 'overview') {
    return <OpsTrendChart series={props.data.series} metric="payAmountFen" />
  }
  return (
    <div className="grid gap-3 xl:grid-cols-2">
      <OpsTrendChart series={props.data.series} metric="payAmountFen" />
      <OpsTrendChart series={props.data.series} metric="visitors" />
    </div>
  )
}

/**
 * 加载失败。按错误码给出不同的出口说明 —— 重试对「没有权限」没有意义，
 * 对「还没配置店铺」也没有，给出重试按钮只会让人反复点。
 */
function OpsErrorPanel(props: { error: unknown; onRetry: () => void }) {
  const error = props.error instanceof ApiError ? props.error : null
  const exit = error === null ? 'retry' : opsFailureExit(error)
  const message = error === null ? '无法加载运营数据，请稍后重试' : error.message

  if (exit === 'forbidden') {
    return (
      <ErrorState
        title="没有查看运营数据的权限"
        description="需要 ops.shop.read 权限。请联系管理员在账号上授予后再进入。"
      />
    )
  }

  if (exit === 'missing') {
    return (
      <EmptyState
        icon={ChartColumn}
        title="还没有配置店铺"
        description="库里没有店铺记录。先在采集机上跑一次采集，数据会自动建档。"
      />
    )
  }

  return <ErrorState description={message} onRetry={props.onRetry} />
}
