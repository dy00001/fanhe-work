import {
  PERMISSIONS,
  navPath,
  opsRangeDays,
  parseOpsDate,
  type NavItem,
  type OpsDailyPoint,
  type OpsDashboardResponse,
  type OpsShopBoard,
} from '@fanhe/shared'
import { ChartColumn, Info } from 'lucide-react'
import { useState } from 'react'
import { useSearchParams } from 'react-router'

import { useAuth } from '../auth/useAuth'
import { EmptyState, ErrorState, LoadingState } from '../components/StateView'
import { OpsChannelList } from '../components/ops/OpsChannelList'
import { OpsChip } from '../components/ops/OpsChip'
import { OpsHealthPanel } from '../components/ops/OpsHealthPanel'
import { OpsItemTable } from '../components/ops/OpsItemTable'
import { OpsKpiGrid } from '../components/ops/OpsKpiGrid'
import { OpsMultiLineChart } from '../components/ops/OpsMultiLineChart'
import { OpsPendingPanel } from '../components/ops/OpsPendingPanel'
import { OpsRankList } from '../components/ops/OpsRankList'
import { OpsSection } from '../components/ops/OpsSection'
import { OpsServiceMetrics } from '../components/ops/OpsServiceMetrics'
import { OpsShopBindingPanel } from '../components/ops/OpsShopBindingPanel'
import { OpsShopStrip } from '../components/ops/OpsShopStrip'
import { OpsSummaryGrid } from '../components/ops/OpsSummaryGrid'
import { OpsToolbar } from '../components/ops/OpsToolbar'
import { OpsTrendChart } from '../components/ops/OpsTrendChart'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../components/ui/table'
import { ApiError } from '../lib/api'
import { opsFailureExit } from '../lib/ops'
import {
  chineseDate,
  formatCount,
  formatFen,
  formatPercent,
  freshnessOf,
  shortDate,
} from '../lib/ops-display'
import { buildOpsModuleCards } from '../lib/ops-module-cards'
import {
  OPS_PENDING_ADS,
  OPS_PENDING_CONTENT,
  OPS_PENDING_ITEMS,
  OPS_PENDING_SERVICE,
} from '../lib/ops-pending'
import { OPS_SCREEN_SERIES, type OpsScreenSeriesKey } from '../lib/ops-series'
import {
  opsToolbarNote,
  presetQuery,
  resolvePreset,
  viewFromNav,
  type OpsPreset,
} from '../lib/ops-view'
import { useNow } from '../lib/use-now'
import { useOpsDashboard, useOpsHealth, useOpsShopBoards } from '../lib/use-ops-dashboard'

/**
 * 运营看板（七个入口共用这一个页面）。
 *
 * ## 结构来源
 *
 * 骨架照 `tools/collector/preview/ops-dashboard-preview.html` 落地：
 *
 *   页头（标题 / 副标题 / 店铺分段） → 时间条 → 数据状态说明 → 主体区块 → 页脚
 *
 * 与原型的三处差异，都是「用真实数据替代演示数据」必然带来的：
 *
 *   1. **不生成任何演示值。** 原型对四家分店按主店倍率生成数据并标「演示」；
 *      这里未接入的店显示「—」与「待接入」，切过去看到的是同一套布局的空态。
 *   2. **不提供维度分桶与 A/B 对比。** 它们需要后端按桶聚合，当前接口只给逐日序列，
 *      界面先不摆不生效的开关（记录见 `docs/ops/README.md`）。
 *   3. **不提供月度限额与导出。** 限额的业务含义未定，导出未实现。
 *
 * ## 状态从哪来
 *
 * 七个入口各是一个导航项，地址形如 `/ops/trade?p=30d&shop=fanhe-main`：
 *
 *   区间预设 `p` ∈ 单日 / 近 7 / 近 30 / 本月 / 上月 / 自定义
 *   聚焦店铺 `shop`（五店之一，未接入的也能选）
 *
 * 「当前在哪一页」由 `item.code` 决定，侧栏高亮由 `navPath` 派生 —— 两者同源，
 * 点击侧栏与右侧内容因此天然同步，不需要另存一份选中态。切店与切区间都只改地址栏，
 * 刷新与分享都能复现同一屏。
 */

export function OpsDashboardPage({ item }: { item: NavItem }) {
  const [params, setParams] = useSearchParams()
  const [healthOpen, setHealthOpen] = useState(false)
  const [seriesOn, setSeriesOn] = useState<readonly OpsScreenSeriesKey[]>(
    OPS_SCREEN_SERIES.map((series) => series.key),
  )
  const { can } = useAuth()
  // 没有采集权限时连请求都不发：那一发必然 403，只会留下一条控制台红字。
  const canReadHealth = can(PERMISSIONS.OPS_COLLECT_READ)

  const view = viewFromNav(item.code)
  const presetParam = params.get('p')
  const customFrom = params.get('from') ?? ''
  const customTo = params.get('to') ?? ''
  // 两端都必须是合法日期且顺序正确，否则当作没有自定义区间 —— 一个 `from=abc`
  // 不该把整页打回「近 30 天」而不出声，也不该把非法值原样送给服务端。
  const custom =
    parseOpsDate(customFrom) !== null &&
    parseOpsDate(customTo) !== null &&
    opsRangeDays({ from: customFrom, to: customTo }) > 0
      ? { from: customFrom, to: customTo }
      : null
  const preset: OpsPreset = resolvePreset(presetParam, custom)
  const shopCode = params.get('shop')

  /* 第一份响应之前还不知道数据覆盖范围：固定天数类预设直接交给服务端的 `days`；
     月份类先按 30 天取一份，拿到 `flags.covered` 后再换成真正的月份区间。 */
  const dashboard = useOpsDashboard({
    ...presetQuery(preset, null, custom),
    shop: shopCode,
    enabled: view !== null,
  })

  const data = dashboard.state.status === 'ready' ? dashboard.state.data : null
  /*
   * 换店途中：屏幕上是上一家店的数，新数据还在路上。**不加视觉提示**（请求通常
   * 几十毫秒，闪现一行「正在切换」比不闪更晃眼），只给辅助技术一个 `aria-busy`。
   * 用户能看到的即时反馈来自店铺卡高亮 —— 它读的是地址栏，点下去立刻变。
   */
  const switching = dashboard.state.status === 'ready' && dashboard.state.switching === true
  const coverage = data?.flags.covered ?? null
  const query = presetQuery(preset, coverage, custom)

  const boards = useOpsShopBoards({ ...query, enabled: view !== null })
  const shops = boards.state.status === 'ready' ? (boards.state.data?.shops ?? []) : []
  const selectedCode = shopCode ?? shops[0]?.shop.code ?? null
  const selectedBoard = shops.find((board) => board.shop.code === selectedCode) ?? null
  const selectedShop = data?.shop ?? selectedBoard?.shop ?? null

  const health = useOpsHealth({
    shop: selectedShop?.code ?? null,
    enabled: healthOpen && data !== null && canReadHealth,
  })

  /* 每分钟推进一次。写 `new Date()` 的话，「现在」会冻在渲染那一刻 —— 页面不重渲染
     就永远显示「数据新鲜」，哪怕它已经是两天前的数据。 */
  const now = useNow()
  const freshness = freshnessOf(selectedShop?.lastCollectedAt ?? null, now)

  /** 写地址栏。空值删除参数，避免 `?p=&shop=` 这类噪声进入分享链接。 */
  const patchParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params)
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === '') next.delete(key)
      else next.set(key, value)
    }
    setParams(next, { replace: true })
  }

  if (view === null) {
    return (
      <EmptyState
        icon={ChartColumn}
        title={item.label}
        description="这个入口还没有对应的看板，请检查导航清单与路由分派的映射。"
      />
    )
  }

  const rangeFrom = data?.range.from ?? customFrom
  const rangeTo = data?.range.to ?? customTo
  const rangeLabel =
    data === null
      ? '—'
      : `${shortDate(data.range.from)} ~ ${shortDate(data.range.to)} · ${data.days} 天`
  const subline =
    data === null
      ? item.summary
      : `${shops.length > 0 ? `${shops.length} 家店铺 · ` : ''}${data.range.from} ~ ${data.range.to}（${data.days} 天）${
          selectedShop === null ? '' : ` ｜ 当前高亮 ${selectedShop.name}`
        }`

  return (
    <div className="flex flex-col gap-3" aria-busy={switching || undefined}>
      {/* ── 页头：标题 + 副标题 + 店铺分段（原型 page-head + storeSeg） ── */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-medium tracking-tight text-foreground">{item.label}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{subline}</p>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {shops.length === 0 ? null : (
            <>
              <span className="text-xs text-muted-foreground-weak">店铺</span>
              <div className="inline-flex flex-wrap rounded-lg border border-border p-0.5">
                {shops.map((board) => {
                  const active = board.shop.code === selectedCode
                  return (
                    <button
                      key={board.shop.code}
                      type="button"
                      aria-selected={active}
                      title={board.hasData ? board.shop.name : `${board.shop.name} · 尚未接入采集`}
                      onClick={() => {
                        patchParams({ shop: board.shop.code })
                      }}
                      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs transition-colors ${
                        active
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {board.shop.name}
                      {board.hasData ? null : (
                        <i
                          className={`inline-block size-1.5 rounded-full ${
                            active ? 'bg-primary-foreground/70' : 'bg-m-amber'
                          }`}
                        />
                      )}
                    </button>
                  )
                })}
              </div>
            </>
          )}

          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              className={`inline-block size-1.5 rounded-full ${
                freshness.level === 'fresh'
                  ? 'bg-m-teal'
                  : freshness.level === 'stale'
                    ? 'bg-m-amber'
                    : freshness.level === 'old'
                      ? 'bg-destructive'
                      : 'bg-border'
              }`}
            />
            {freshness.label}
          </span>

          <button
            type="button"
            onClick={() => {
              setHealthOpen((open) => !open)
            }}
            aria-expanded={healthOpen}
            className="rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            采集记录
          </button>
        </div>
      </div>

      {/* ── 店铺绑定与管理。默认收起，且只有持有 `ops.shop.bind` 的账号能看到。 ── */}
      <OpsShopBindingPanel />

      {/* ── 时间条：七个入口同一套控件，口径差异写在右侧说明里 ── */}
      <OpsToolbar
        preset={preset}
        onPreset={(next) => {
          patchParams({ p: next === '30d' ? null : next, from: null, to: null })
        }}
        from={rangeFrom}
        to={rangeTo}
        onFrom={(value) => {
          patchParams({ p: 'custom', from: value, to: rangeTo })
        }}
        onTo={(value) => {
          patchParams({ p: 'custom', from: rangeFrom, to: value })
        }}
        coverageFrom={coverage?.from ?? null}
        coverageTo={coverage?.to ?? null}
        note={opsToolbarNote(view, rangeLabel)}
      />

      {healthOpen ? (
        <OpsHealthPanel
          state={health.state}
          onReload={health.reload}
          now={now}
          allowed={canReadHealth}
        />
      ) : null}

      {dashboard.state.status === 'loading' ? <LoadingState label="正在加载运营数据" /> : null}
      {dashboard.state.status === 'error' ? (
        <OpsErrorPanel error={dashboard.state.error} onRetry={dashboard.reload} />
      ) : null}

      {data !== null ? (
        <>
          {/* 空店铺：不隐藏区块，只在最上方说明「为什么都是空的」，布局与有数据时一致。 */}
          {data.flags.dailyDays === 0 && data.dimensions.items.rows.length === 0 ? (
            <ShopPendingNotice shopName={data.shop.name} />
          ) : null}

          {view === 'screen' ? (
            <ScreenView
              data={data}
              shops={shops}
              selectedCode={selectedCode}
              onSelectShop={(code) => {
                patchParams({ shop: code })
              }}
              seriesOn={seriesOn}
              onToggleSeries={(key) => {
                setSeriesOn((current) =>
                  current.includes(key)
                    ? current.filter((entry) => entry !== key)
                    : [...current, key],
                )
              }}
            />
          ) : null}

          {view === 'trade' ? <TradeView data={data} /> : null}

          {view === 'items' ? (
            <div className="flex flex-col gap-3">
              <OpsItemTable group={data.dimensions.items} />
              <OpsPendingPanel
                title="商品健康度"
                intro="违规、评分与素材体检需要逐商品采集，当前页只展示成交与流量表现。以下四项尚未接入。"
                items={OPS_PENDING_ITEMS}
              />
            </div>
          ) : null}

          {view === 'flow' ? (
            <div className="flex flex-col gap-3">
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
                  unavailable="生意参谋没有「内容来源访客」这个口径，内容数据在「内容运营」页（视频分析的曝光 / 点击 / 有效播放）。"
                />
              </div>
            </div>
          ) : null}

          {view === 'service' ? (
            <div className="flex flex-col gap-3">
              <OpsServiceMetrics group={data.dimensions.summary} />
              <OpsPendingPanel
                title="服务体验 · 缺口"
                intro="响应与接待已经接入（见上方六格），评价待回复与问大家待答也已接上。剩下的服务保障状态随 E 批一起跑。"
                items={OPS_PENDING_SERVICE}
              />
            </div>
          ) : null}

          {view === 'ads' ? (
            <OpsPendingPanel
              title="推广投放"
              intro="万相台登录态已确认可用，但本店近一周关键词推广没有投放记录（各场景花费均为 0），余额接口也在返回「系统异常」。以下三项仍未入库。"
              items={OPS_PENDING_ADS}
            />
          ) : null}

          {view === 'content' ? (
            <div className="flex flex-col gap-3">
              <OpsSummaryGrid
                group={data.dimensions.summary}
                title="内容表现"
                keys={['contentExposeUv', 'contentClkUv', 'contentPlayUv']}
                note="区间累计 · 取自生意参谋 › 内容 › 视频分析，按内容条数合计（同一人看多条会重复计）"
              />
              <OpsPendingPanel
                title="内容运营 · 缺口"
                intro="曝光 / 点击 / 有效播放已接（见上方三格），来源是生意参谋的视频分析，不是光合。光合只在「内容活动人数」这一项上还有独立口径，尚未接入。"
                items={OPS_PENDING_CONTENT}
              />
            </div>
          ) : null}

          <OpsFooter collectedAt={data.flags.lastCollectedAt} />
        </>
      ) : null}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════
   数据大屏：五店并列 → 合计 → 四指标趋势 → 模块入口卡
   ══════════════════════════════════════════════════════════════════════════ */

function ScreenView(props: {
  data: OpsDashboardResponse
  shops: readonly OpsShopBoard[]
  selectedCode: string | null
  onSelectShop: (code: string) => void
  seriesOn: readonly OpsScreenSeriesKey[]
  onToggleSeries: (key: OpsScreenSeriesKey) => void
}) {
  const { data } = props
  const amount = sumFen(props.shops.map((board) => board.payAmountFen))
  const buyers = sumFen(props.shops.map((board) => board.payBuyers))
  const visitors = sumFen(props.shops.map((board) => board.visitors))
  const current = props.shops.find((board) => board.shop.code === props.selectedCode) ?? null

  const modules = buildOpsModuleCards(data, props.shops, current)

  return (
    <div className="flex flex-col gap-3">
      {/* 数据状态条：原型 demo-note。这里不说「演示」，说清哪部分真实、哪部分待接入。 */}
      <div className="flex items-start gap-2 rounded-xl border border-border bg-card px-4 py-3">
        <OpsChip tone="neutral">数据状态</OpsChip>
        <p className="text-xs leading-relaxed text-muted-foreground">
          本页是<b className="font-medium text-foreground">五店总览</b>：底部合计与模块卡里的
          「五店合计」是五家相加，不随高亮切换；店铺卡与折线图按店展示，切店后同步刷新。
          已接入采集的店铺标「真实」，其余标「待接入」并显示「—」，不填任何演示值。
          {data.flags.masked.includes('payAmount') ? (
            <span className="text-m-amber">
              {' '}
              当前账号没有 ops.finance.read 权限，金额一律显示「无权限」。
            </span>
          ) : null}
        </p>
      </div>

      <OpsShopStrip
        boards={props.shops}
        selected={props.selectedCode}
        onSelect={props.onSelectShop}
      />

      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground-weak">
        五店合计支付金额{' '}
        <b className="font-medium text-foreground">{formatFen(amount, { compact: true })}</b>
        ，买家合计 <b className="font-medium text-foreground">
          {formatCount(buyers)}
        </b>，访客合计 <b className="font-medium text-foreground">{formatCount(visitors)}</b>。
        点店铺卡切换聚焦，其余六个入口同步跟随。
      </p>

      <OpsSection
        title={`${current?.shop.name ?? '当前店铺'} 四指标趋势 · 按日`}
        note="四条曲线各自按区间峰值归一，只比趋势不比高低"
      >
        <OpsMultiLineChart
          series={data.series}
          enabled={props.seriesOn}
          onToggle={props.onToggleSeries}
        />
        <div className="mt-2 text-[11px] text-muted-foreground-weak">
          区间合计{' '}
          <b className="font-normal text-foreground">
            {formatFen(data.kpi.find((kpi) => kpi.key === 'payAmount')?.value ?? null, {
              compact: true,
            })}
          </b>{' '}
          · 访客{' '}
          <b className="font-normal text-foreground">
            {formatCount(data.kpi.find((kpi) => kpi.key === 'visitors')?.value ?? null)}
          </b>{' '}
          · 买家{' '}
          <b className="font-normal text-foreground">
            {formatCount(data.kpi.find((kpi) => kpi.key === 'payBuyers')?.value ?? null)}
          </b>{' '}
          · 转化率{' '}
          <b className="font-normal text-foreground">
            {formatPercent(data.kpi.find((kpi) => kpi.key === 'payRate')?.value ?? null)}
          </b>
        </div>
      </OpsSection>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {modules.map((entry) => (
          <a
            key={entry.code}
            href={navPath(entry.code)}
            className="flex flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-foreground/25"
          >
            <span className="flex items-center gap-1.5 text-sm text-foreground">
              {entry.label}
              <span className="ml-auto text-muted-foreground-weak">›</span>
            </span>
            <span className="flex flex-col gap-1 text-[11px] text-muted-foreground">
              {entry.numbers.map((row) => (
                <span key={row.label} className="flex items-baseline gap-1">
                  <span>{row.label}</span>
                  <b className="ml-auto font-normal text-foreground tabular-nums">{row.value}</b>
                </span>
              ))}
            </span>
            <span className="text-[11px] leading-relaxed text-muted-foreground-weak">
              {entry.desc}
            </span>
          </a>
        ))}
      </div>
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════════════
   交易分析：KPI → 趋势 → 逐日明细
   ══════════════════════════════════════════════════════════════════════════ */

function TradeView(props: { data: OpsDashboardResponse }) {
  return (
    <div className="flex flex-col gap-3">
      <OpsKpiGrid items={props.data.kpi} />
      <div className="grid items-start gap-3 xl:grid-cols-2">
        <OpsTrendChart series={props.data.series} metric="payAmountFen" />
        <OpsTrendChart series={props.data.series} metric="visitors" />
      </div>
      <DailyTable series={props.data.series} />
    </div>
  )
}

function DailyTable(props: { series: readonly OpsDailyPoint[] }) {
  const rows = [...props.series].reverse()
  return (
    <OpsSection title="逐日明细" note="按日期倒序 · 四个指标都是当日真值，可直接相加核对">
      <Table>
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
    </OpsSection>
  )
}

/* ══════════════════════════════════════════════════════════════════════════
   公共小件
   ══════════════════════════════════════════════════════════════════════════ */

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

function ShopPendingNotice(props: { shopName: string }) {
  return (
    <div className="flex items-start gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-3">
      <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground-weak" />
      <p className="text-sm leading-relaxed text-muted-foreground">
        <span className="text-foreground">{props.shopName}</span>{' '}
        尚未接入采集数据。下方区块按同一套布局占位，数字显示为「—」，不填任何演示值。
        接入方式：该店铺完成授权后，采集器按店铺代号写入即可，无需改代码。
      </p>
    </div>
  )
}

function OpsFooter(props: { collectedAt: string | null }) {
  return (
    <p className="px-1 text-[11px] leading-relaxed text-muted-foreground-weak">
      数据来源：生意参谋 / 千牛后台采集（tools/collector）。
      {props.collectedAt === null
        ? ' 当前店铺还没有成功采集记录。'
        : ` 上次成功采集 ${new Date(props.collectedAt).toLocaleString('zh-CN')}。`}
      整段口径的区块（渠道、商品、地域、搜索词、结构指标）窗口固定，不随上方区间变。
    </p>
  )
}

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
        description="库里没有店铺记录。先在采集机上跑一次采集，或执行 pnpm db:ops-shops 建占位店铺。"
      />
    )
  }

  return <ErrorState description={message} onRetry={props.onRetry} />
}
