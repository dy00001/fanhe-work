/**
 * 三个模块的只读取数。**只调用各自领域已有的服务函数，不新写 SQL。**
 *
 * 这条约束是有意的：汇报里的数字必须与看板上的数字同源。一旦这里另写一份查询，
 * 「看板说 37 位客户、汇报说 35 位」这种差异会长期存在，而且谁都说不出哪边对。
 * 复用服务的代价是拿到的结构比需要的多，多出来的字段在这里被丢掉 —— 丢掉比不传
 * 更容易发现：结构体是白名单，编译器会盯着。
 */

import type { FastifyRequest } from 'fastify'

import type { PermissionCode } from '@fanhe/shared'
import type {
  AssistantCustomerSnapshot,
  AssistantOpsSnapshot,
  AssistantQuoteSnapshot,
} from '@fanhe/shared'

import { viewerFromRequest } from '../customer/scope.js'
import { listCustomers } from '../customer/customers.js'
import { loadOpsShopBoards } from '../ops/query.js'
import { readCollectorStatus } from '../ops/collector-heartbeat.js'
import { getLedgerStats, getMeta, listRevisions } from '../quote/store.js'

/** 汇报的回看窗口。上界 90 天：再长就等于「季度总结」，那是另一套口径。 */
export const ASSISTANT_DAYS_MIN = 1
export const ASSISTANT_DAYS_MAX = 90
export const ASSISTANT_DAYS_DEFAULT = 7

/**
 * 把天数换成 `YYYY-MM-DD` 的半开区间（含起点、含终点）。
 *
 * 用本地日期而不是 UTC：采集入库与看板的日期都是按本地零点切的，用 UTC 拼会在
 * 时区偏移 8 小时的情况下把首日切掉 8 小时，表现为「今天的数字一直偏小」。
 */
export function rangeOfDays(days: number, now: Date = new Date()): { from: string; to: string } {
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const start = new Date(end)
  start.setDate(start.getDate() - (Math.max(1, Math.trunc(days)) - 1))
  return { from: toDateString(start), to: toDateString(end) }
}

function toDateString(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${value.getFullYear()}-${month}-${day}`
}

/** 运营快照。金额由 `loadOpsShopBoards` 内部按 `ops.finance.read` 裁剪，这里不再判一次。 */
export async function collectOps(
  viewer: { permissions: readonly PermissionCode[] },
  range: { from: string; to: string },
  days: number,
): Promise<AssistantOpsSnapshot> {
  const [boards, collector] = await Promise.all([
    loadOpsShopBoards({
      range,
      viewer: { permissions: viewer.permissions },
    }),
    readCollectorStatus(),
  ])

  const shops = boards.shops.map((board) => ({
    code: board.shop.code,
    name: board.shop.name,
    hasData: board.hasData,
    coveredDays: board.coveredDays,
    payAmountFen: board.payAmountFen,
    payBuyers: board.payBuyers,
    visitors: board.visitors,
    payRate: board.payRate,
    masked: board.masked,
  }))

  /**
   * 合计只在**全部店铺都有金额**时给出。
   *
   * 部分店被打码时把剩下的加起来更糟：那个数字看起来像全店 GMV，实际漏了几家，
   * 而读者不会去核对分母。宁可给 `null` 让汇报写「部分店铺无金额权限，合计不适用」。
   */
  const allMasked = shops.some((shop) => shop.masked)
  const totalPayAmountFen = allMasked
    ? null
    : shops.reduce<number>((sum, shop) => sum + (shop.payAmountFen ?? 0), 0)
  const totalPayBuyers = shops.reduce<number>((sum, shop) => sum + (shop.payBuyers ?? 0), 0)

  return {
    range,
    days,
    shops,
    totalPayAmountFen,
    totalPayBuyers,
    collect: {
      online: collector.online,
      lastSeenAt: collector.lastSeenAt,
      emptyShops: shops.filter((shop) => !shop.hasData).map((shop) => shop.name),
    },
  }
}

/**
 * 客户快照。
 *
 * 行级范围（`own` / `all`）由 `viewerFromRequest` 决定，与客户列表页用的是同一份
 * 判定 —— 管理员拿到的是全库，某天给设计师开了这个能力，他拿到的就是自己名下。
 */
export async function collectCustomer(
  request: FastifyRequest,
  range: { from: string; to: string },
): Promise<AssistantCustomerSnapshot> {
  const viewer = viewerFromRequest(request)
  if (viewer === null) throw new Error('客户视图不可用：认证上下文缺失')

  const from = new Date(`${range.from}T00:00:00`)
  const to = new Date(`${range.to}T23:59:59`)

  const page = await listCustomers({
    viewer,
    from,
    to,
    mode: 'summary',
    limit: 1,
  })

  /**
   * 待复核数单独查一次，并且**只在能看到公共池时**查。
   *
   * 不持有 `customer.scope.read` 的账号，池子对它是空集（池子的定义就是「不属于
   * 任何人」）—— 给出 0 会被读成「没有待复核」，而实际是「你看不到池子」。
   */
  let pendingReview: number | null = null
  if (viewer.scope.kind === 'all') {
    const pending = await listCustomers({ viewer, pendingReview: true, mode: 'summary', limit: 1 })
    pendingReview = pending.total
  }

  return {
    total: page.total,
    scopeKind: page.scopeKind,
    financeReadable: page.financeReadable,
    byStage: page.summary.byStage.map((bucket) => ({ stage: bucket.stage, count: bucket.count })),
    byRegion: Object.entries(page.summary.byScope).map(([region, count]) => ({ region, count })),
    amountTotalFen: page.summary.amountTotalFen,
    inProgress: page.summary.kpi.inProgress,
    newInWindow: page.summary.kpi.newInWindow,
    pendingReview,
  }
}

/**
 * 报价台账快照。**只给规模与缺口，不给任何单价。**
 *
 * `listRevisions` 返回的每条记录里带 `oldValue` / `newValue`，改价记录的这两项就是
 * 单价。这里只按 `field` 计数、把值丢掉 —— 报价的改价权限是「角色 + 口令」两段式，
 * 不属于权限点体系；把单价塞进汇报等于绕开那层口令。
 */
const REVISION_SAMPLE = 200

export async function collectQuote(now: Date = new Date()): Promise<AssistantQuoteSnapshot> {
  const [stats, meta, revisions] = await Promise.all([
    getLedgerStats(),
    getMeta(),
    listRevisions(REVISION_SAMPLE),
  ])

  const since = now.getTime() - 7 * 24 * 60 * 60 * 1000
  const recent = revisions.items.filter((item) => Date.parse(item.createdAt) >= since)

  const actions = new Map<string, number>()
  for (const item of recent) {
    actions.set(item.field, (actions.get(item.field) ?? 0) + 1)
  }

  return {
    exact: stats.exact,
    family: stats.family,
    manual: stats.manual,
    noImage: stats.noImage,
    imageFiles: stats.imageFiles,
    unbound: stats.unbound,
    categories: meta.categories.length,
    sources: meta.sources.length,
    recentRevisions: recent.length,
    revisionActions: [...actions.entries()].map(([action, count]) => ({ action, count })),
  }
}
