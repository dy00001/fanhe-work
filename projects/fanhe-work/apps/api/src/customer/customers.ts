import {
  AUDIT_ACTIONS,
  CUSTOMER_LIMITS,
  CUSTOMER_STAGES,
  activityWindow,
  bucketHourlyActivity,
  buildInitialSteps,
  computeOrderSettlement,
  customerDisplayName,
  customerShortName,
  isStageRegression,
  maskContractTotal,
  maskOrderAmounts,
  normalizeRegion,
  parseOwnerFilter,
  regionScopeOf,
  type CreateCustomerOrderRequest,
  type CreateCustomerRequest,
  type CustomerAmounts,
  type CustomerDetailDto,
  type CustomerListItemDto,
  type CustomerListResponse,
  type CustomerOrderDto,
  type CustomerOwnerDto,
  type CustomerRole,
  type CustomerStage,
  type CustomerSummary,
  type AssignCustomerRequest,
  type RegionScope,
  type SetCustomerStageRequest,
  type UpdateCustomerRequest,
  type UpdateCustomerStepRequest,
  type UpdateOrderAmountsRequest,
} from '@fanhe/shared'

import { recordAudit } from '../audit/audit.js'
import { prisma } from '../db/prisma.js'
/* 值导入，不是 `import type`：下面用 `Prisma.DbNull` 表示「这一列显式写 NULL」，
   那是运行时常量。用 type-only 导入时 tsc 报 TS1361，而这条路径只在
   `legacyBlocks` 缺省时才会走到，单测与冒烟都碰不到。 */
import { Prisma } from '../generated/prisma/client.js'
import { actorOf, roleOf, scopeWhere, SYSTEM_VIEWER, type CustomerViewer } from './scope.js'

/**
 * 客户档案与订单的读写。
 *
 * **隔离由「权限点 × 归属范围」共同承担。** 早期版本的这里写着「数据不属于某个
 * 人，因此没有所有权参数」，那句话在客户平台只有五个账号时成立。现在设计师与
 * 销售各看各的客户，归属必须进 where —— 只靠权限点只能表达「能不能读客户」，
 * 表达不了「能读哪几位客户」。
 *
 * 三条与隔离有关的硬规则，改动这个文件前必须先读：
 *
 *   1. **范围条件只在 `buildCustomerWhere` 里写一次。** 列表、总数、四张图、活跃度
 *      七处共用它，各写一遍的结果是「列表筛了、KPI 没筛」，而那种偏差没有报错。
 *   2. **单条读取一律 `findFirst({ where: { id, ...scopeWhere } })`**，不要
 *      `findUnique` 之后在内存里判归属。后者会让「存在但不属于你」这条路径多一次
 *      查询，且容易在某个分支漏判。
 *   3. **范围判断在字段白名单之前。** 顺序颠倒时，400（字段不合法）与 404（不存在）
 *      的差异会泄露「这个客户确实存在，只是不属于你」。
 *
 * **金额裁剪仍然在这里做，不在路由里。** 裁剪与其余字段的映射写在同一处，
 * 新增一条返回订单的接口时不容易漏掉。判据由路由算好传进来（`viewer.canReadFinance`）。
 *
 * **归属变更写审计。** 与改电话不同，归属变更同时改变「谁能看到这份档案」与
 * 「这单算谁的」，是本期唯一需要追溯的档案改动。
 */

export type CustomerFailureReason =
  | 'not_found'
  | 'invalid_name'
  | 'invalid_region'
  | 'invalid_phone'
  | 'invalid_stage'
  | 'invalid_amount'
  | 'missing_reason'
  | 'duplicate_chatroom'
  | 'duplicate_code'
  /** 提交了不在自己可编辑范围内的字段（例如没有复核权限却改 `reviewStatus`）。 */
  | 'field_not_allowed'
  /** 转派目标账号不存在、已删除或已停用。 */
  | 'invalid_assignee'

export type CustomerResult<T> = { ok: true; data: T } | { ok: false; reason: CustomerFailureReason }

/** 列表筛选条件。`viewer` 必填，其余可选，缺省即不加条件。 */
export type CustomerListFilter = {
  /**
   * 当前账号。**必填，这是本模块最重要的一个类型设计。**
   *
   * 做成可选时，新增一个调用点忘了传，编译器不报错，运行时静默放开全库 ——
   * 界面上完全看不出异常。必填把「每个调用点必须表态」变成编译期约束。
   */
  viewer: CustomerViewer
  // 每个字段都显式带上 `| undefined`：tsconfig 开了
  // `exactOptionalPropertyTypes`，不带的话「传一个可能为 undefined 的值」
  // 与「不传这个字段」在类型上不等价，调用方得先拼一个对象再展开才能通过。
  region?: string | undefined
  scope?: string | undefined
  stage?: string | undefined
  /**
   * 归属筛选。取值见 `parseOwnerFilter`：`mine` / `unassigned` / `designer:<id>` /
   * `sales:<id>`，空即不过滤。
   *
   * **必须走 `buildCustomerWhere`**：KPI、两张环形图、活跃度折线与清单七处共用那一个
   * where。只在清单上过滤的表现是「列表只剩我的客户，看板还是全公司的数字」——
   * 每个数字单独看都对，放在一屏里才互相矛盾，而那种矛盾没有任何报错。
   */
  owner?: string | undefined
  /** 只看待复核。`true` 时限定 `reviewStatus = pending`。 */
  pendingReview?: boolean | undefined
  q?: string | undefined
  /**
   * 时间筛选起点（含）与终点（不含），按 `lastMessageAt` 判定。
   *
   * 锚点选「最近消息时间」的理由：列表那一列显示的就是它，活跃度折线也是按它分桶。
   * 若改用 `createdAt`（入库时间），同一批客户会因为导入批次不同而被切到不同的
   * 时间档里，而界面上看不出任何异常。
   *
   * 代价是 `lastMessageAt` 为空的客户在任何时间筛选下都不出现。这类客户是「还没有
   * 消息的档案」，本来就不该出现在按沟通活跃度切出来的视图里。
   */
  from?: Date | undefined
  to?: Date | undefined
  /** 活跃度窗口的基准时刻。测试注入用，缺省取当前时间。 */
  now?: Date | undefined
  /** `summary` 时只算汇总不查列表行。综合看板用，省掉最多 200 行的往返。 */
  mode?: 'list' | 'summary' | undefined
  limit?: number | undefined
}

/**
 * 列出的列。与 `notes.ts` 同理显式列出，理由不重复。
 *
 * 列表刻意不查 `legacyBlocks` 与订单明细：列表一屏二十行，把每个客户的 JSON 块
 * 都拖出来，单次响应会到几 MB，而界面上一个字都用不到。
 */
const LIST_SELECT = {
  id: true,
  displayName: true,
  shortName: true,
  region: true,
  regionScope: true,
  stage: true,
  stageSource: true,
  reviewStatus: true,
  confidence: true,
  msgRows: true,
  lastMessageAt: true,
  contractTotalFen: true,
  repeatOfId: true,
  /*
   * 双角色归属要连名字一起取，不能只取 id。
   *
   * 需求是「设计师端看到销售是谁，销售端看到设计师是谁」——只给 id 等于不给：
   * 前端没有账号名表，拿 id 只能渲染成一串 UUID，或者再发一次请求查名字
   * （列表二十行就是二十次）。
   */
  designer: { select: { id: true, displayName: true } },
  sales: { select: { id: true, displayName: true } },
  _count: { select: { orders: true, repeats: true } },
} as const

const DETAIL_SELECT = {
  ...LIST_SELECT,
  realName: true,
  phone: true,
  primaryNickname: true,
  nameSource: true,
  groupFile: true,
  firstMessageAt: true,
  skipImg: true,
  skipVoice: true,
  orders: {
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      code: true,
      seq: true,
      isRepeat: true,
      stage: true,
      stageSource: true,
      contractFen: true,
      depositFen: true,
      prepayFen: true,
      finalReceivedFen: true,
      feeFen: true,
      receivedFen: true,
      unpaidFen: true,
      amountSource: true,
      amountEvidenceDate: true,
      amountEvidenceNote: true,
      steps: {
        orderBy: { idx: 'asc' },
        select: {
          idx: true,
          name: true,
          reached: true,
          done: true,
          startedAt: true,
          finishedAt: true,
          dateImprecise: true,
          note: true,
        },
      },
    },
  },
} as const

/** `@db.Date` 列取出来是 Date，接口一律传 `YYYY-MM-DD` 字符串。 */
function toDateString(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10)
}

type ListRow = {
  id: string
  displayName: string
  shortName: string
  region: string
  regionScope: string
  stage: string
  stageSource: string
  reviewStatus: string
  confidence: string
  msgRows: number
  lastMessageAt: Date | null
  contractTotalFen: number | null
  repeatOfId: string | null
  designer: { id: string; displayName: string } | null
  sales: { id: string; displayName: string } | null
  _count: { orders: number; repeats: number }
}

function toListItem(row: ListRow, viewer: CustomerViewer): CustomerListItemDto {
  const canReadFinance = viewer.canReadFinance
  return {
    id: row.id,
    displayName: row.displayName,
    shortName: row.shortName,
    region: row.region,
    // 库里存的是字符串（理由见 schema 注释：层级标准会变，region 不能变）。
    // 收窄成契约里的联合类型，越界值说明写入路径漏了校验，让它显式落成 domestic
    // 而不是把非法字符串透给前端。
    regionScope:
      row.regionScope === 'overseas' || row.regionScope === 'special-region'
        ? row.regionScope
        : 'domestic',
    stage: row.stage as CustomerStage,
    stageSource: row.stageSource,
    reviewStatus: row.reviewStatus,
    confidence: row.confidence,
    msgRows: row.msgRows,
    lastMessageAt: row.lastMessageAt?.toISOString() ?? null,
    orderCount: row._count.orders,
    contractTotalFen: maskContractTotal(row.contractTotalFen, canReadFinance),
    // 复购有三种形态，三种都要算：
    //   1. 一个客户开了多单（`_count.orders > 1`）—— 最常见，看板上蔣文增一人三单；
    //   2. 复购时另建了群，于是多了第二个客户行，用 `repeatOfId` 指向首单；
    //   3. 首单那一行本身（有别的行指向我）。
    // 只看第 2、3 种会漏掉第 1 种 —— 而第 1 种恰恰是当前数据里的主流形态，
    // 漏掉的表现是「一人三单在列表上看不出是复购」，被当成三个客户。
    hasRepeat: row._count.orders > 1 || row.repeatOfId !== null || row._count.repeats > 0,
    /*
     * 双角色归属整块下发。`myRole` 在服务端算好，前端不要自己拿 id 比对：
     * 归属规则写在两个地方，漂移时的表现是「我」这个标记偶尔消失，且不报错。
     */
    assignment: {
      designerId: row.designer?.id ?? null,
      designerName: row.designer?.displayName ?? null,
      salesId: row.sales?.id ?? null,
      salesName: row.sales?.displayName ?? null,
      myRole: roleOf(
        { designerId: row.designer?.id ?? null, salesId: row.sales?.id ?? null },
        viewer.userId,
      ),
    },
  }
}

function toOrder(
  row: {
    id: string
    code: string
    seq: number
    isRepeat: boolean
    stage: string
    stageSource: string
    contractFen: number | null
    depositFen: number | null
    prepayFen: number | null
    finalReceivedFen: number | null
    feeFen: number | null
    receivedFen: number | null
    unpaidFen: number | null
    amountSource: string | null
    amountEvidenceDate: Date | null
    amountEvidenceNote: string | null
    steps: {
      idx: number
      name: string
      reached: boolean
      done: boolean
      startedAt: Date | null
      finishedAt: Date | null
      dateImprecise: boolean
      note: string | null
    }[]
  },
  canReadFinance: boolean,
): CustomerOrderDto {
  const amounts: CustomerAmounts = {
    contractFen: row.contractFen,
    depositFen: row.depositFen,
    prepayFen: row.prepayFen,
    finalReceivedFen: row.finalReceivedFen,
    feeFen: row.feeFen,
    receivedFen: row.receivedFen,
    unpaidFen: row.unpaidFen,
  }
  return {
    id: row.id,
    code: row.code,
    seq: row.seq,
    isRepeat: row.isRepeat,
    stage: row.stage as CustomerStage,
    stageSource: row.stageSource,
    amounts: maskOrderAmounts(amounts, canReadFinance),
    // 金额来源也一起裁掉。它本身不是金额，但「这单金额来自看板核对」与
    // 「来自模型抽取」这层信息只在能看到金额时才有意义 —— 看不到金额却看到
    // 「低置信度」的标注，只会让人以为界面坏了。
    amountSource: canReadFinance ? row.amountSource : null,
    amountEvidenceDate: canReadFinance ? toDateString(row.amountEvidenceDate) : null,
    amountEvidenceNote: canReadFinance ? row.amountEvidenceNote : null,
    steps: row.steps.map((step) => ({
      idx: step.idx,
      name: step.name,
      reached: step.reached,
      done: step.done,
      startedAt: toDateString(step.startedAt),
      finishedAt: toDateString(step.finishedAt),
      dateImprecise: step.dateImprecise,
      note: step.note,
    })),
  }
}

/** 库里存的是字符串，收窄成契约里的联合类型。越界值落成 domestic，不透给前端。 */
function normalizeScope(value: string): RegionScope {
  return value === 'overseas' || value === 'special-region' ? value : 'domestic'
}

/**
 * 把筛选条件折成一个 Prisma where。
 *
 * **列表、总数、阶段分布、地区分布、金额汇总、新增计数、活跃度分桶，七处共用这一个
 * 函数。** 各写一遍的结果是「筛了地区以后环形图变了但 KPI 没变」这类偏差：每个数字
 * 单独看都合理，放在一屏里才互相矛盾，而那种矛盾没有任何报错。
 */
export function buildCustomerWhere(filter: CustomerListFilter): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = {}

  /*
   * 范围条件放进 `AND` 数组，**不能直接赋给 `where.OR`**。检索也要用 `OR`
   * （三个字段任一命中），两处都写 `OR` 时后写的会静默覆盖前面那个 ——
   * 表现是「按名字搜出来的结果里出现了别人负责的客户」，而界面上不会报错。
   */
  const and: Prisma.CustomerWhereInput[] = []
  if (filter.viewer.scope.kind === 'own') and.push(scopeWhere(filter.viewer.scope))

  if (filter.region) where.region = filter.region
  if (filter.scope) where.regionScope = filter.scope
  if (filter.stage) where.stage = filter.stage

  /*
   * 归属筛选同样进 `AND` 数组，理由与检索那条一样：「我负责的」本身是一个 `OR`
   * （设计师是我或销售是我），直接赋给 `where.OR` 会把检索的 OR 覆盖掉。
   *
   * 「未分配」要求**两栏都为空**，不是「任一为空」。设计师有了、销售没定，这位客户
   * 其实已经有人跟了；按「任一为空」筛，它会同时出现在「未分配」和「张三的客户」
   * 两个视图里，而这两个视图的客户数相加会超过总数。
   */
  const owner = parseOwnerFilter(filter.owner)
  if (owner.kind === 'mine') {
    and.push({
      OR: [{ designerId: filter.viewer.userId }, { salesId: filter.viewer.userId }],
    })
  } else if (owner.kind === 'unassigned') {
    and.push({ designerId: null, salesId: null })
  } else if (owner.kind === 'member') {
    and.push(owner.role === 'designer' ? { designerId: owner.userId } : { salesId: owner.userId })
  }

  if (filter.pendingReview) where.reviewStatus = 'pending'
  if (filter.q) {
    // 检索四项：显示名、短名、真名。用 `mode: 'insensitive'` 是因为英文昵称
    // 大小写不固定（JoJo / jojo 都有人写），而中文不受影响。
    and.push({
      OR: [
        { displayName: { contains: filter.q, mode: 'insensitive' } },
        { shortName: { contains: filter.q, mode: 'insensitive' } },
        { realName: { contains: filter.q, mode: 'insensitive' } },
      ],
    })
  }
  if (filter.from !== undefined || filter.to !== undefined) {
    where.lastMessageAt = {
      ...(filter.from === undefined ? {} : { gte: filter.from }),
      ...(filter.to === undefined ? {} : { lt: filter.to }),
    }
  }
  if (and.length > 0) where.AND = and
  return where
}

/**
 * 时间窗口条件。半开区间，两端都可缺省。
 *
 * 返回的是**字段过滤器**而不是整个 where：调用处要把它挂在 `firstMessageAt` 或
 * `lastMessageAt` 下面，返回 where 会让调用方多套一层 `AND`，而多套的那层一旦
 * 写错，筛选就静默失效。
 */
function timeWindowFilter(from: Date | undefined, to: Date | undefined): { gte?: Date; lt?: Date } {
  return {
    ...(from === undefined ? {} : { gte: from }),
    ...(to === undefined ? {} : { lt: to }),
  }
}

/**
 * 归属筛选的可选项。
 *
 * **只受可见范围约束，不受其余筛选影响。** 用当前筛选算的话，选完「张三」之后
 * 下拉里就只剩张三一个人，换人还得先清空筛选 —— 选项会自己变少这件事在使用者
 * 眼里是 bug。
 *
 * 数据来源是**客户行上的归属列**，不是账号表：账号表里那些从未被指派过客户的
 * 人出现在下拉里，选中之后列表空空如也。为此先 groupBy 出实际出现过的 id，
 * 再回查姓名。
 */
async function listOwners(viewer: CustomerViewer): Promise<CustomerOwnerDto[]> {
  const scopeOnly: Prisma.CustomerWhereInput =
    viewer.scope.kind === 'own' ? { AND: [scopeWhere(viewer.scope)] } : {}

  const [designerGroups, salesGroups] = await Promise.all([
    prisma.customer.groupBy({ by: ['designerId'], where: scopeOnly, _count: { _all: true } }),
    prisma.customer.groupBy({ by: ['salesId'], where: scopeOnly, _count: { _all: true } }),
  ])

  const designerIds = designerGroups
    .map((group) => group.designerId)
    .filter((id): id is string => id !== null)
  const salesIds = salesGroups
    .map((group) => group.salesId)
    .filter((id): id is string => id !== null)
  const ids = [...new Set([...designerIds, ...salesIds])]
  if (ids.length === 0) return []

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true },
  })
  const nameOf = new Map(users.map((user) => [user.id, user.displayName]))

  /*
   * 同一个人可能两条都出现（既是某些客户的设计师，又是另一些客户的销售），
   * 因此这里按角色分别产出，而不是按人去重 —— 两种身份的筛选结果不同。
   */
  const options: CustomerOwnerDto[] = []
  for (const role of ['designer', 'sales'] as CustomerRole[]) {
    const source = role === 'designer' ? designerIds : salesIds
    for (const id of new Set(source)) {
      const name = nameOf.get(id)
      // 账号被硬删除后客户行上的 id 仍在（外键是 SetNull，但那要数据库执行过删除），
      // 查不到姓名时跳过：下拉里出现一个空名字的选项，点下去只会得到一片空白。
      if (name === undefined) continue
      options.push({ id, name, role })
    }
  }

  // 先按角色成组，组内按姓名排。中文用 `localeCompare` 而不是字符码，否则「张」
  // 会排在「安」前面。
  return options.sort((left, right) => {
    if (left.role !== right.role) return left.role === 'designer' ? -1 : 1
    return left.name.localeCompare(right.name, 'zh-CN')
  })
}

/**
 * 列表 + 汇总。
 *
 * **汇总不受筛选条件影响的部分要分开看**：`byStage` 与 `byScope` 都按**当前筛选**
 * 统计，因为综合看板的用途是「筛完地区后看这批人的阶段分布」。若按全库统计，筛选
 * 之后图表不变，用起来会以为筛选没生效。
 *
 * **`mode: 'summary'` 只跳过列表行，不跳过任何汇总。** 综合看板不显示清单，但它的
 * KPI、两个环形图与折线图都来自这里；让两栏各调一个接口的话，筛选语义会在两处
 * 各实现一遍，而两份实现漂移时的表现是「看板与进度页对不上」。
 */
export async function listCustomers(filter: CustomerListFilter): Promise<CustomerListResponse> {
  const canReadFinance = filter.viewer.canReadFinance
  const where = buildCustomerWhere(filter)
  const limit = Math.min(filter.limit ?? CUSTOMER_LIMITS.PAGE_MAX, CUSTOMER_LIMITS.PAGE_MAX)
  const wantItems = filter.mode !== 'summary'
  const now = filter.now ?? new Date()
  const window = activityWindow(now)
  const hasTimeWindow = filter.from !== undefined || filter.to !== undefined

  const rowsPromise: Promise<ListRow[]> = wantItems
    ? (prisma.customer.findMany({
        where,
        select: LIST_SELECT,
        // 「最近有动静的排前面」。一直按 id 排会让列表看起来随机，
        // 而这张表的日常用途是找刚才聊过的那个人。
        orderBy: [{ lastMessageAt: 'desc' }, { createdAt: 'desc' }],
        take: limit,
      }) as unknown as Promise<ListRow[]>)
    : Promise.resolve([])

  const [rows, total, stageGroups, scopeGroups, amountGroups, newInWindow, activityRows, owners] =
    await Promise.all([
      rowsPromise,
      prisma.customer.count({ where }),
      prisma.customer.groupBy({ by: ['stage'], where, _count: { _all: true } }),
      prisma.customer.groupBy({ by: ['regionScope'], where, _count: { _all: true } }),
      prisma.customer.groupBy({ by: ['regionScope'], where, _sum: { contractTotalFen: true } }),
      // 未限定时间时「窗口内新增」就是总数，省掉一次 count。用 null 表达「无需另算」，
      // 不用 0 或 -1 这类哨兵值：它们与真实的计数无法在类型上区分。
      hasTimeWindow
        ? prisma.customer.count({
            where: {
              AND: [where, { firstMessageAt: timeWindowFilter(filter.from, filter.to) }],
            },
          })
        : Promise.resolve(null),
      // 活跃度只看最近 24 小时，与时间筛选取交集。两者用 AND 合并，不展开成一个对象：
      // 展开时后写的 `lastMessageAt` 会静默覆盖前面那个时间筛选。
      prisma.customer.findMany({
        where: { AND: [where, { lastMessageAt: { gte: window.start, lt: window.end } }] },
        select: { lastMessageAt: true },
      }),
      listOwners(filter.viewer),
    ])

  const byScope: Record<RegionScope, number> = { 'special-region': 0, overseas: 0, domestic: 0 }
  for (const group of scopeGroups) {
    byScope[normalizeScope(group.regionScope)] += group._count._all
  }

  const byStage = stageGroups
    .map((group) => ({ stage: group.stage as CustomerStage, count: group._count._all }))
    // 非法档位直接丢掉：它说明库里有一行来自旧契约，让它出现在图表里比丢掉更糟。
    .filter((bucket) => (CUSTOMER_STAGES as readonly string[]).includes(bucket.stage))

  // 进行中从 `byStage` 反推，不另发一次 count。同一个数字在两个地方各算一遍，
  // 口径漂移时表现是「KPI 说 12 位进行中，环形图加起来只有 11 位」。
  const inProgress = byStage
    .filter((bucket) => bucket.stage !== 'closed' && bucket.stage !== 'lost')
    .reduce((sum, bucket) => sum + bucket.count, 0)

  const amountByScope: Record<RegionScope, number> | null = canReadFinance
    ? { 'special-region': 0, overseas: 0, domestic: 0 }
    : null
  if (amountByScope !== null) {
    for (const group of amountGroups) {
      amountByScope[normalizeScope(group.regionScope)] += group._sum.contractTotalFen ?? 0
    }
  }
  const amountTotalFen =
    amountByScope === null
      ? null
      : amountByScope.domestic + amountByScope.overseas + amountByScope['special-region']

  const summary: CustomerSummary = {
    byScope,
    byStage,
    amountByScope,
    amountTotalFen,
    kpi: { inProgress, newInWindow: newInWindow ?? total },
    activity: bucketHourlyActivity(
      activityRows.map((row) => row.lastMessageAt?.toISOString() ?? null),
      now,
    ),
  }

  return {
    items: rows.map((row) => toListItem(row, filter.viewer)),
    total,
    summary,
    financeReadable: canReadFinance,
    /*
     * 范围随响应下发，前端据此决定要不要显示「当前只显示你负责的客户」这条提示
     * 以及归属列。**不要让前端按角色自己算**：一是它拿到的角色与实际权限可能不同
     * （账号级单独授予），二是两处算法漂移时的表现是提示消失，而不是报错。
     */
    scopeKind: filter.viewer.scope.kind,
    owners,
  }
}

export async function getCustomer(
  id: string,
  viewer: CustomerViewer,
): Promise<CustomerResult<CustomerDetailDto>> {
  const row = await prisma.customer.findFirst({
    where: { id, ...scopeWhere(viewer.scope) },
    select: DETAIL_SELECT,
  })
  if (row === null) {
    await recordDeniedAccess(id, viewer)
    return { ok: false, reason: 'not_found' }
  }

  return { ok: true, data: toDetail(row as unknown as DetailRow, viewer) }
}

type DetailRow = ListRow & {
  realName: string | null
  phone: string | null
  primaryNickname: string | null
  nameSource: string | null
  groupFile: string | null
  firstMessageAt: Date | null
  skipImg: number
  skipVoice: number
  orders: Parameters<typeof toOrder>[0][]
}

function toDetail(row: DetailRow, viewer: CustomerViewer): CustomerDetailDto {
  return {
    ...toListItem(row, viewer),
    realName: row.realName,
    phone: row.phone,
    primaryNickname: row.primaryNickname,
    nameSource: row.nameSource,
    groupFile: row.groupFile,
    firstMessageAt: row.firstMessageAt?.toISOString() ?? null,
    skipImg: row.skipImg,
    skipVoice: row.skipVoice,
    repeatOfId: row.repeatOfId,
    orders: row.orders.map((order) => toOrder(order, viewer.canReadFinance)),
  }
}

/**
 * 记一条行级越权尝试。
 *
 * **只在「这个 id 确实存在、但不在你的范围内」时写。** 不做这个区分的话，
 * 爬虫随机打 id 会把审计表灌满，真正需要看见的试探被淹掉。
 *
 * 这个判断只在 404 分支上多一次 count，正常路径（可见的行）没有额外开销。
 * 它**不改变响应**：对外一律是同一个 404，否则「403 还是 404」本身就泄露存在性。
 */
async function recordDeniedAccess(id: string, viewer: CustomerViewer): Promise<void> {
  if (viewer.scope.kind === 'all') return
  if (!UUID_PATTERN.test(id)) return
  const exists = await prisma.customer.count({ where: { id } })
  if (exists === 0) return
  await recordAudit({
    action: AUDIT_ACTIONS.CUSTOMER_ACCESS_DENIED,
    // 记 failure 而不是 success：审计按 result 过滤时，越权尝试应与正常读取分开。
    result: 'failure',
    actor: actorOf(viewer),
    target: { type: 'customer', id },
  })
}

/** 主键是 uuid7。非法串直接判不存在，避免 Postgres 抛 `invalid input syntax for type uuid`。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 取一条在当前范围内可见的客户。不可见与不存在同形返回 null。
 *
 * 五条写路径（改档案、建订单、改环节、推阶段、转派）统一走它。写路径漏掉范围校验
 * 是本期最危险的缺陷：漏了不会报错，只会让「A 能改 B 的客户」这件事在界面上
 * 完全看不出来。
 */
async function findScopedCustomer(
  id: string,
  viewer: CustomerViewer,
): Promise<{ id: string; stage: string; realName: string | null; region: string } | null> {
  if (!UUID_PATTERN.test(id)) return null
  const row = await prisma.customer.findFirst({
    where: { id, ...scopeWhere(viewer.scope) },
    select: { id: true, stage: true, realName: true, region: true },
  })
  if (row === null) await recordDeniedAccess(id, viewer)
  return row
}

/**
 * 人工录入用的入参。
 *
 * 直接复用共享包的 `CreateCustomerRequest`，不在这里另写一份：导入脚本、路由 schema、
 * 前端表单三处的字段名必须一致，各自定义一遍的结果是「前端填得进去、后端 400」，
 * 而 400 的文案不会告诉你哪个字段名写错了。
 */
export type CreateCustomerInput = CreateCustomerRequest

/**
 * 一条客户记录「从哪来」。
 *
 * 人工录入与批量导入算出来的显示名、短名、地区层级必须完全一致（都是契约函数算的），
 * 但**来源类字段不能一致**：导入进来的是从聊天记录里抽的，51 条本来就该是「待复核」；
 * 人工录的是人签过字的，直接算确认。若让导入走 `createCustomer`，全库会变成
 * `reviewStatus: confirmed` + `confidence: high`，复核队列直接空掉 —— 而界面上
 * 看不出任何异常。
 */
export type CustomerOrigin = {
  nameSource: string
  confidence: string
  reviewStatus: string
  stageSource: string
}

/** 人工录入的来源标记。录进来这件事本身就是人签过字的动作。 */
const MANUAL_ORIGIN: CustomerOrigin = {
  nameSource: 'manual',
  confidence: 'high',
  reviewStatus: 'confirmed',
  stageSource: 'manual',
}

/**
 * 只有导入才会填的档案字段。
 *
 * 单独一组而不是塞进 `CreateCustomerRequest`：这些值前端填不了，也不该让前端能填
 * —— 「消息行数」与「被跳过的图片张数」是采集结果，不是人可以声明的属性。
 */
export type CustomerArchiveExtras = {
  msgRows?: number | undefined
  firstMessageAt?: Date | null | undefined
  lastMessageAt?: Date | null | undefined
  skipImg?: number | undefined
  skipVoice?: number | undefined
  groupFile?: string | null | undefined
  legacyBlocks?: Prisma.InputJsonValue | undefined
  repeatOfId?: string | null | undefined
  /** 导入时可显式指定归属；缺省由创建者身份决定（见 `defaultAssignment`）。 */
  designerId?: string | null | undefined
  salesId?: string | null | undefined
}

/**
 * 新建客户的默认归属。
 *
 * **不默认进公共池。** 设计师自己录进来一位客户，如果两个归属都留空，那一行立刻
 * 落到公共池 —— 而公共池只有持 `customer.scope.read` 的账号看得到。表现是
 * 「刚录完，客户不见了」，且没有任何报错。这是行级隔离上线后最容易踩的一脚。
 *
 * 判据用角色 code 只为决定「记到哪一栏」，不参与可见性：销售录的记 sales，
 * 其余（设计师、以及被单独授予客户权限的成员）记 designer。全局范围的账号
 * 不自动归属 —— 管理员录入的客户本来就该由人来分配。
 */
function defaultAssignment(viewer: CustomerViewer): {
  designerId: string | null
  salesId: string | null
} {
  if (viewer.scope.kind === 'all') return { designerId: null, salesId: null }
  if (viewer.roleCode === 'sales') return { designerId: null, salesId: viewer.userId }
  return { designerId: viewer.userId, salesId: null }
}

function normalizeRegionOrNull(region: string): string | null {
  const trimmed = region.trim()
  if (trimmed === '') return null
  return normalizeRegion(trimmed)
}

/**
 * 把入参收敛成可以落库的三个字段，并给出拒绝理由。
 *
 * 单独抽出来是因为**干跑要能复用**：导入脚本的 `--dry-run` 需要回答「这 53 条会不会
 * 被拒」，而一个真的去写库的校验算不上校验。写成两套判断则必然分叉 —— 干跑说没问题、
 * 真跑报 `invalid_region`，那是最难解释的一类不一致。
 */
export function normalizeCustomerInput(
  input: CreateCustomerInput,
):
  | { ok: true; value: { realName: string; region: string; phone: string } }
  | { ok: false; reason: CustomerFailureReason } {
  const realName = input.realName.trim()
  if (realName === '' || realName.length > CUSTOMER_LIMITS.REAL_NAME_MAX) {
    return { ok: false, reason: 'invalid_name' }
  }
  const region = normalizeRegionOrNull(input.region)
  if (region === null || region.length > CUSTOMER_LIMITS.REGION_MAX) {
    return { ok: false, reason: 'invalid_region' }
  }
  const phone = input.phone?.trim() ?? ''
  if (phone.length > CUSTOMER_LIMITS.PHONE_MAX) return { ok: false, reason: 'invalid_phone' }
  if (input.stage !== undefined && !(CUSTOMER_STAGES as readonly string[]).includes(input.stage)) {
    return { ok: false, reason: 'invalid_stage' }
  }
  return { ok: true, value: { realName, region, phone } }
}

/**
 * 写入一条客户。人工录入与批量导入共用这一处校验与派生。
 *
 * 显示名与短名不接受调用方传入，一律由这里算：规则改了以后重算一遍即可，库里那两列
 * 始终是可再生字段。两个入口各写一遍校验的结果是「导入进来 80 字的真名」这类越界
 * 数据，而它只在列表里显示成挤成一行的文本，不会报错。
 */
export async function insertCustomer(
  input: CreateCustomerInput,
  origin: CustomerOrigin,
  extras: CustomerArchiveExtras = {},
  viewer: CustomerViewer = SYSTEM_VIEWER,
): Promise<CustomerResult<CustomerDetailDto>> {
  const normalized = normalizeCustomerInput(input)
  if (!normalized.ok) return { ok: false, reason: normalized.reason }
  const { realName, region, phone } = normalized.value

  const chatroom = input.chatroom?.trim() ?? ''
  const finalChatroom = chatroom === '' ? `manual:${crypto.randomUUID()}` : chatroom

  const exists = await prisma.customer.findUnique({
    where: { chatroom: finalChatroom },
    select: { id: true },
  })
  if (exists !== null) return { ok: false, reason: 'duplicate_chatroom' }

  const project = input.project?.trim() ?? ''
  const fallback = defaultAssignment(viewer)
  const created = await prisma.customer.create({
    data: {
      chatroom: finalChatroom,
      displayName: customerDisplayName(region, realName, project === '' ? undefined : project),
      shortName: customerShortName(realName, region),
      region,
      regionScope: regionScopeOf(region),
      realName,
      phone: phone === '' ? null : phone,
      primaryNickname: input.primaryNickname?.trim() || null,
      nameSource: origin.nameSource,
      confidence: origin.confidence,
      reviewStatus: origin.reviewStatus,
      stage: input.stage ?? 'consulting',
      stageSource: origin.stageSource,
      designerId: extras.designerId ?? fallback.designerId,
      salesId: extras.salesId ?? fallback.salesId,
      groupFile: extras.groupFile ?? null,
      msgRows: extras.msgRows ?? 0,
      firstMessageAt: extras.firstMessageAt ?? null,
      lastMessageAt: extras.lastMessageAt ?? null,
      skipImg: extras.skipImg ?? 0,
      skipVoice: extras.skipVoice ?? 0,
      /* 没有 `ai_schema` 原始块时写 `DbNull` 而不是 `null`：Prisma 的 JSON 列里
         「JSON null」与「SQL NULL」是两件事，用 `null` 会在库里存成 `"null"` 这个
         合法的 JSON 值，于是「这个客户没有原始块」变成「有一个值为 null 的块」。 */
      legacyBlocks: extras.legacyBlocks ?? Prisma.DbNull,
      repeatOfId: extras.repeatOfId ?? null,
    },
    select: { id: true },
  })

  return getCustomer(created.id, viewer)
}

export async function createCustomer(
  input: CreateCustomerInput,
  viewer: CustomerViewer = SYSTEM_VIEWER,
): Promise<CustomerResult<CustomerDetailDto>> {
  return insertCustomer(input, MANUAL_ORIGIN, {}, viewer)
}

export type UpdateCustomerInput = UpdateCustomerRequest

export async function updateCustomer(
  id: string,
  input: UpdateCustomerInput,
  viewer: CustomerViewer,
): Promise<CustomerResult<CustomerDetailDto>> {
  /*
   * 先判范围，再判字段。**顺序不能反**：先判字段时，两次响应（400 字段越界 /
   * 404 不存在）的差异会泄露「这个客户确实存在，只是不属于你」。顺序错了不会
   * 有任何测试变红，只能靠评审发现。
   */
  const current = await findScopedCustomer(id, viewer)
  if (current === null) return { ok: false, reason: 'not_found' }

  /*
   * 复核状态不在普通编辑范围内。它决定一条机器猜测能不能当正式档案用，
   * 因此只给持 `customer.import.review` 的账号。
   *
   * 拒绝时返回 400 而不是静默忽略：静默忽略会让用户以为保存成功，而那颗
   * 变更从来没有落库 —— 这类「看起来成功了」的失败最难发现。
   */
  if (input.reviewStatus !== undefined && !viewer.canReview) {
    return { ok: false, reason: 'field_not_allowed' }
  }

  const data: Prisma.CustomerUpdateInput = {}

  if (input.realName !== undefined) {
    const realName = input.realName.trim()
    if (realName === '' || realName.length > CUSTOMER_LIMITS.REAL_NAME_MAX) {
      return { ok: false, reason: 'invalid_name' }
    }
    data.realName = realName
  }
  if (input.region !== undefined) {
    const region = normalizeRegionOrNull(input.region)
    if (region === null || region.length > CUSTOMER_LIMITS.REGION_MAX) {
      return { ok: false, reason: 'invalid_region' }
    }
    data.region = region
    data.regionScope = regionScopeOf(region)
  }
  if (input.phone !== undefined) {
    const phone = input.phone?.trim() ?? ''
    if (phone.length > CUSTOMER_LIMITS.PHONE_MAX) return { ok: false, reason: 'invalid_phone' }
    data.phone = phone === '' ? null : phone
  }
  if (input.primaryNickname !== undefined) {
    data.primaryNickname = input.primaryNickname?.trim() || null
  }
  if (input.reviewStatus !== undefined) data.reviewStatus = input.reviewStatus

  // 改名或改地区都要重算显示名与短名。**两列同时重算**：只改一个会让
  // 「显示名是地区+短名」这条不变式失效，而失效的表现是同一个客户在两个页面上
  // 名字不同 —— 这种偏差不会报错。
  const nextRegion = (data.region as string | undefined) ?? current.region
  const nextName = (data.realName as string | undefined) ?? current.realName ?? ''
  if (input.realName !== undefined || input.region !== undefined) {
    data.displayName = customerDisplayName(nextRegion, nextName)
    data.shortName = customerShortName(nextName, nextRegion)
  }

  if (Object.keys(data).length === 0) return getCustomer(id, viewer)

  await prisma.customer.update({ where: { id }, data })
  return getCustomer(id, viewer)
}

/** 合同额变化后重算客户级汇总。派生列，任何地方都不直接写。 */
async function recomputeContractTotal(customerId: string): Promise<void> {
  const aggregate = await prisma.customerOrder.aggregate({
    where: { customerId },
    _sum: { contractFen: true },
  })
  await prisma.customer.update({
    where: { id: customerId },
    data: { contractTotalFen: aggregate._sum.contractFen ?? null },
  })
}

export type CreateOrderInput = CreateCustomerOrderRequest

/**
 * 一个环节的历史明细。导入专用，人工录入时十四个环一律从「未到达」起步。
 *
 * 日期写成 `YYYY-MM-DD` 字符串而不是 `Date`：这份结构直接对应预览 JSON 里的形状，
 * 在调用边界转换一次比让日期对象穿过两层函数更容易看出哪一步在解析。
 */
export type OrderStepSeed = {
  idx: number
  reached: boolean
  done: boolean
  startedAt?: string | null | undefined
  finishedAt?: string | null | undefined
  dateImprecise?: boolean | undefined
  note?: string | null | undefined
}

/**
 * 导入时随订单一起落库的历史细节。
 *
 * 每一项都对应一个「自动生成的值是错的」的场景：编号要保留看板编号（`TW-01`）、
 * 序号要按原顺序、阶段是订单自己的而不是客户的当前阶段、金额来源要写清是看板
 * 证据还是净化后的 ai_schema。不给这些覆盖位，导入就只能先把订单建出来再逐条改，
 * 中间那一段是错的数据，且出错时找不到是哪一步写坏的。
 */
export type OrderImportDetail = {
  code?: string | undefined
  seq?: number | undefined
  stage?: string | undefined
  stageSource?: string | undefined
  amountSource?: string | undefined
  amountConfidence?: string | null | undefined
  amountEvidenceDate?: string | null | undefined
  amountEvidenceNote?: string | null | undefined
  steps?: readonly OrderStepSeed[] | undefined
}

/** 金额只认「非负整数分」。与客户入参同一个理由抽出来给干跑用。 */
export function normalizeOrderAmounts(
  input: CreateOrderInput,
): { ok: false; reason: CustomerFailureReason } | null {
  for (const value of [
    input.contractFen,
    input.depositFen,
    input.prepayFen,
    input.finalReceivedFen,
    input.feeFen,
    input.receivedFen,
    input.unpaidFen,
  ]) {
    if (value === undefined || value === null) continue
    if (!Number.isInteger(value) || value < 0) return { ok: false, reason: 'invalid_amount' }
  }
  return null
}

/**
 * 新建订单，同时铺好十四个环节。
 *
 * **序号与编号在这里生成，不接受调用方指定。** 序号是「同一客户内的第几单」，
 * 由数据库的唯一约束 `(customerId, seq)` 兜底；编号全局唯一，取当前最大编号加一。
 * 让前端传这两个值，等于把「两个人同时新建订单」变成一个必然撞号的操作。
 * 唯一的例外是 `detail`（导入专用），它带的正是历史事实，不是并发写入的猜测。
 */
export async function createOrder(
  customerId: string,
  input: CreateOrderInput,
  viewer: CustomerViewer,
  detail?: OrderImportDetail,
): Promise<CustomerResult<CustomerDetailDto>> {
  // 现状这里只判「客户存在」，没判归属 —— 也就是 A 能给 B 的客户建单。
  // 建单会改客户级合同额汇总，等于间接改了别人名下的数字。
  const customer = await findScopedCustomer(customerId, viewer)
  if (customer === null) return { ok: false, reason: 'not_found' }

  const amountInvalid = normalizeOrderAmounts(input)
  if (amountInvalid !== null) return amountInvalid

  /*
   * 派生两项按公式算，除非这是导入路径且它自己带了历史数字。
   *
   * `detail !== undefined` 表示调用来自导入脚本，那时 `receivedFen` / `unpaidFen`
   * 是看板与 ai_schema 里的既成事实，重算等于用今天的公式改写昨天的账。人工录入
   * 没有 `detail`，一律走公式 —— 「新建订单时合同填了 10 万，未收却显示未录入」
   * 是最容易被当成 bug 报上来的一种表现。
   */
  const settlement = computeOrderSettlement({
    contractFen: input.contractFen ?? null,
    depositFen: input.depositFen ?? null,
    prepayFen: input.prepayFen ?? null,
    finalReceivedFen: input.finalReceivedFen ?? null,
    feeFen: input.feeFen ?? null,
  })
  const useSettlement = detail === undefined

  const lastSeq = await prisma.customerOrder.aggregate({
    where: { customerId },
    _max: { seq: true },
  })
  const seq = detail?.seq ?? (lastSeq._max.seq ?? 0) + 1

  // 编号取全局最大。用 `ORD-` 前缀与看板编号（BT-01）分开，两者不会互相顶号。
  const lastCode = await prisma.customerOrder.findFirst({
    where: { code: { startsWith: CUSTOMER_LIMITS.ORDER_CODE_PREFIX } },
    orderBy: { code: 'desc' },
    select: { code: true },
  })
  const lastNumber =
    lastCode === null
      ? 0
      : Number.parseInt(lastCode.code.slice(CUSTOMER_LIMITS.ORDER_CODE_PREFIX.length), 10) || 0
  const code =
    detail?.code ?? `${CUSTOMER_LIMITS.ORDER_CODE_PREFIX}${String(lastNumber + 1).padStart(3, '0')}`

  /* 环节先按模板铺满十四行，再用导入明细覆盖给出的那几个。**顺序不能反**：
     模板是分母，缺哪个环意味着「这个环没走到」，而不是「这个环不存在」——
     后者会让进度条的分母变小，看上去反而更接近完成。 */
  const seeded = new Map((detail?.steps ?? []).map((step) => [step.idx, step]))
  const steps = buildInitialSteps().map((template) => {
    const seed = seeded.get(template.idx)
    if (seed === undefined) {
      return {
        idx: template.idx,
        name: template.name,
        reached: template.reached,
        done: template.done,
        dateImprecise: template.dateImprecise,
        note: template.note,
      }
    }
    const startedAt = parseDateValue(seed.startedAt)
    const finishedAt = parseDateValue(seed.finishedAt)
    return {
      idx: template.idx,
      name: template.name,
      /* `done` 连带 `reached`，与 `updateStep` 同一条依赖：历史数据里出现过
         「完成日期有、到达标记没有」的行，照抄会在界面上显示成「未到达但已完成」，
         那种行看起来像渲染 bug。 */
      reached: seed.reached || seed.done,
      done: seed.done,
      startedAt: startedAt === 'invalid' ? null : startedAt,
      finishedAt: finishedAt === 'invalid' ? null : finishedAt,
      dateImprecise: seed.dateImprecise ?? false,
      note: seed.note?.trim() || null,
    }
  })

  await prisma.customerOrder.create({
    data: {
      code,
      customerId,
      seq,
      isRepeat: seq > 1,
      // 新单继承客户当前阶段。理由：客户级阶段是「这个客户走到哪」，新开一单
      // 通常意味着继续推进，而不是退回咨询中。退回由阶段推进接口显式去做。
      stage: detail?.stage ?? customer.stage,
      stageSource: detail?.stageSource ?? 'manual',
      contractFen: input.contractFen ?? null,
      depositFen: input.depositFen ?? null,
      prepayFen: input.prepayFen ?? null,
      finalReceivedFen: input.finalReceivedFen ?? null,
      feeFen: input.feeFen ?? null,
      receivedFen: useSettlement ? settlement.receivedFen : (input.receivedFen ?? null),
      unpaidFen: useSettlement ? settlement.unpaidFen : (input.unpaidFen ?? null),
      amountSource:
        detail?.amountSource ??
        (input.contractFen === undefined || input.contractFen === null ? 'none' : 'manual'),
      amountConfidence:
        detail?.amountConfidence ??
        (input.contractFen === undefined || input.contractFen === null ? null : 'high'),
      amountEvidenceDate: parseDateValue(detail?.amountEvidenceDate) ?? null,
      amountEvidenceNote: detail?.amountEvidenceNote?.trim() || null,
      steps: { create: steps },
    },
    select: { id: true },
  })

  await recomputeContractTotal(customerId)
  return getCustomer(customerId, viewer)
}

export type UpdateStepInput = UpdateCustomerStepRequest

/** 解析 `YYYY-MM-DD`。不合法返回 `null`，由调用方决定这是「清空」还是「报错」。 */
function parseDateValue(value: string | null | undefined): Date | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime())) return 'invalid'
  // 再比对一次字符串，挡住 `2026-02-31` 这种被 Date 静默滚到下个月的写法。
  if (parsed.toISOString().slice(0, 10) !== value) return 'invalid'
  return parsed
}

/**
 * 更新一个环节。
 *
 * **`done = true` 会连带把 `reached` 置为 true**，反过来不成立。已完成必然意味着
 * 到达过；而「到达未完成」是真实状态（看板里「预安装沟通，完成日期未提及」那一类），
 * 不能被自动补齐。这条依赖写在这里而不是交给前端维持 —— 前端忘了置 reached，
 * 界面上就会显示「未到达但已完成」，那种行看起来像渲染 bug，排查起来很费时。
 */
export async function updateStep(
  customerId: string,
  orderId: string,
  idx: number,
  input: UpdateStepInput,
  viewer: CustomerViewer,
): Promise<CustomerResult<CustomerDetailDto>> {
  // 先判客户归属，再判订单归属。只判后者时，A 可以对 B 的客户名下、自己猜到的
  // orderId 推进环节 —— 而 orderId 会出现在客户详情响应里，猜到并不难。
  if ((await findScopedCustomer(customerId, viewer)) === null) {
    return { ok: false, reason: 'not_found' }
  }

  const order = await prisma.customerOrder.findUnique({
    where: { id: orderId },
    select: { customerId: true },
  })
  if (order === null || order.customerId !== customerId) return { ok: false, reason: 'not_found' }

  const step = await prisma.customerOrderStep.findUnique({
    where: { orderId_idx: { orderId, idx } },
    select: { id: true },
  })
  if (step === null) return { ok: false, reason: 'not_found' }

  const data: Prisma.CustomerOrderStepUpdateInput = {}
  if (input.reached !== undefined) data.reached = input.reached
  if (input.done !== undefined) {
    data.done = input.done
    if (input.done && input.reached === undefined) data.reached = true
  }
  if (input.dateImprecise !== undefined) data.dateImprecise = input.dateImprecise
  if (input.note !== undefined) data.note = input.note?.trim() || null

  for (const key of ['startedAt', 'finishedAt'] as const) {
    if (input[key] === undefined) continue
    const parsed = parseDateValue(input[key])
    if (parsed === 'invalid') return { ok: false, reason: 'invalid_stage' }
    data[key] = parsed
    // 填了日期就意味着到达过。这是同一件事的两种表达，不该要人填两遍。
    if (parsed !== null && input.reached === undefined) data.reached = true
  }

  if (Object.keys(data).length > 0) {
    await prisma.customerOrderStep.update({ where: { id: step.id }, data })
  }
  return getCustomer(customerId, viewer)
}

export type SetStageInput = SetCustomerStageRequest

/**
 * 推进客户阶段。
 *
 * 回退（主线内倒退）**必须填原因**，否则 400。这条限制来自 `customer.ts` 里
 * `isStageRegression` 的设计意图：回退意味着之前记错了或客户反悔了，两种情况都
 * 需要一个可追溯的说法。跨到旁支（退款、流失）不算回退，它们是终止而非倒退。
 *
 * 订单级阶段跟着改：客户只有一个阶段，订单可以有好几张，但**只有最后一张**跟着动。
 * 前面那些单如果已经完结，改它们等于篡改历史。
 */
export async function setStage(
  customerId: string,
  input: SetStageInput,
  viewer: CustomerViewer,
): Promise<CustomerResult<CustomerDetailDto>> {
  if (!(CUSTOMER_STAGES as readonly string[]).includes(input.stage)) {
    return { ok: false, reason: 'invalid_stage' }
  }
  const customer = await findScopedCustomer(customerId, viewer)
  if (customer === null) return { ok: false, reason: 'not_found' }

  const from = customer.stage as CustomerStage
  if (isStageRegression(from, input.stage) && (input.reason ?? '').trim() === '') {
    return { ok: false, reason: 'missing_reason' }
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: { stage: input.stage, stageSource: 'manual' },
  })

  const latestOrder = await prisma.customerOrder.findFirst({
    where: { customerId },
    orderBy: { seq: 'desc' },
    select: { id: true },
  })
  if (latestOrder !== null) {
    await prisma.customerOrder.update({
      where: { id: latestOrder.id },
      data: { stage: input.stage, stageSource: 'manual' },
    })
  }

  return getCustomer(customerId, viewer)
}

/**
 * 更正订单金额。
 *
 * 只收手填五项，派生两项由 `computeOrderSettlement` 算完一起落库。三条规则：
 *
 *   1. **金额属于财务信息。** 没有 `customer.finance.read` 的账号连看都看不到，
 *      自然也谈不上改 —— 这里直接拒成 `field_not_allowed`（400），与档案字段超范围
 *      同一个口径。
 *   2. **先判客户归属，再判订单归属。** `orderId` 会出现在详情响应里，猜到并不难；
 *      只判订单会让 A 改掉 B 的客户名下的账。
 *   3. **不接收派生值。** 前端算的那一份只用于输入过程中的预览，最终以服务端为准。
 *
 * `undefined` 保持原值、`null` 清空，两者必须分开：界面上「没动这个框」与「把这个
 * 框清掉」是两个动作，混成一个就再也清不空一个填错的数字。
 */
export type UpdateOrderAmountsInput = UpdateOrderAmountsRequest

export async function updateOrderAmounts(
  customerId: string,
  orderId: string,
  input: UpdateOrderAmountsInput,
  viewer: CustomerViewer,
): Promise<CustomerResult<CustomerDetailDto>> {
  if (!viewer.canReadFinance) return { ok: false, reason: 'field_not_allowed' }
  if ((await findScopedCustomer(customerId, viewer)) === null) {
    return { ok: false, reason: 'not_found' }
  }

  const order = await prisma.customerOrder.findUnique({
    where: { id: orderId },
    select: {
      customerId: true,
      contractFen: true,
      depositFen: true,
      prepayFen: true,
      finalReceivedFen: true,
      feeFen: true,
    },
  })
  if (order === null || order.customerId !== customerId) return { ok: false, reason: 'not_found' }

  for (const value of [
    input.contractFen,
    input.depositFen,
    input.prepayFen,
    input.finalReceivedFen,
    input.feeFen,
  ]) {
    if (value === undefined || value === null) continue
    if (!Number.isInteger(value) || value < 0) return { ok: false, reason: 'invalid_amount' }
  }

  // `undefined` 表示「这次不动这一项」。写成 `input.x ?? order.x` 会把显式清空
  // （null）也当成「不动」，于是填错的数字永远删不掉。
  const pick = (next: number | null | undefined, current: number | null): number | null =>
    next === undefined ? current : next

  const merged = {
    contractFen: pick(input.contractFen, order.contractFen),
    depositFen: pick(input.depositFen, order.depositFen),
    prepayFen: pick(input.prepayFen, order.prepayFen),
    finalReceivedFen: pick(input.finalReceivedFen, order.finalReceivedFen),
    feeFen: pick(input.feeFen, order.feeFen),
  }
  const settlement = computeOrderSettlement(merged)

  await prisma.customerOrder.update({
    where: { id: orderId },
    data: {
      ...merged,
      ...settlement,
      // 人工动过的数字把来源改成 manual。留着原来的 `board-evidence` 会让「这笔钱
      // 是从看板核对出来的」这条证据失效 —— 它已经被人改过了。
      amountSource: 'manual',
      amountConfidence: 'high',
    },
  })

  // 合同总金额是客户级汇总的来源，改了合同就必须重算，否则看板上的合同额合计
  // 停在旧值，而列表与详情各自显示新值，三个数字互相打架。
  await recomputeContractTotal(customerId)
  return getCustomer(customerId, viewer)
}

/**
 * 删除一张订单。
 *
 * 硬删除，十四环节随级联消失。审计里留下编号与金额 —— 审计表不级联，删完之后
 * 「那一单原本记了什么」只有这条记录能回答。
 *
 * 删完必须重算客户级合同额：`contractTotalFen` 是聚合派生列，不重算会让看板上的
 * 合同额合计继续包含一张已经不存在的订单。
 */
export async function deleteOrder(
  customerId: string,
  orderId: string,
  viewer: CustomerViewer,
): Promise<CustomerResult<CustomerDetailDto>> {
  if ((await findScopedCustomer(customerId, viewer)) === null) {
    return { ok: false, reason: 'not_found' }
  }

  const order = await prisma.customerOrder.findUnique({
    where: { id: orderId },
    select: {
      customerId: true,
      code: true,
      seq: true,
      contractFen: true,
      depositFen: true,
      prepayFen: true,
      finalReceivedFen: true,
      feeFen: true,
      receivedFen: true,
      unpaidFen: true,
      steps: { select: { done: true } },
    },
  })
  if (order === null || order.customerId !== customerId) return { ok: false, reason: 'not_found' }

  await prisma.customerOrder.delete({ where: { id: orderId } })
  await recomputeContractTotal(customerId)

  await recordAudit({
    action: AUDIT_ACTIONS.CUSTOMER_ORDER_DELETE,
    actor: actorOf(viewer),
    target: { type: 'customer', id: customerId },
    detail: {
      orderId,
      code: order.code,
      seq: order.seq,
      contractFen: order.contractFen,
      depositFen: order.depositFen,
      prepayFen: order.prepayFen,
      finalReceivedFen: order.finalReceivedFen,
      feeFen: order.feeFen,
      receivedFen: order.receivedFen,
      unpaidFen: order.unpaidFen,
      stepsDone: order.steps.filter((step) => step.done).length,
    },
  })

  return getCustomer(customerId, viewer)
}

/** 删除客户的返回。删完没有详情可回，只需要够界面把那一行摘掉。 */
export type DeletedCustomer = { id: string; displayName: string }

/**
 * 删除一位客户。
 *
 * 三条约束，每条都对应一次「删错了就找不回来」：
 *
 *   1. **要 `customer.scope.write`。** 改档案（`record.write`）是日常动作，设计师
 *      每天都在用；整条删除会连带删掉订单、十四环节与归类记录，把它并进日常写权限
 *      等于让最容易误点的那个按钮没有额外的门槛。这一条与服务层的
 *      `assignCustomer` 同源：只有能把客户在人与人之间转移的账号，才能让它消失。
 *   2. **先判归属范围。** 不可见与不存在同形返回 404，与其余写路径一致。
 *   3. **删前写审计。** 删除会级联清掉所有子表，审计表是唯一不跟着消失的痕迹。
 */
export async function deleteCustomer(
  customerId: string,
  viewer: CustomerViewer,
): Promise<CustomerResult<DeletedCustomer>> {
  if (!viewer.canAssign) return { ok: false, reason: 'field_not_allowed' }
  if (!UUID_PATTERN.test(customerId)) return { ok: false, reason: 'not_found' }

  const row = await prisma.customer.findFirst({
    where: { id: customerId, ...scopeWhere(viewer.scope) },
    select: {
      id: true,
      displayName: true,
      region: true,
      designerId: true,
      salesId: true,
      _count: { select: { orders: true } },
    },
  })
  if (row === null) {
    await recordDeniedAccess(customerId, viewer)
    return { ok: false, reason: 'not_found' }
  }

  await prisma.customer.delete({ where: { id: customerId } })

  await recordAudit({
    action: AUDIT_ACTIONS.CUSTOMER_DELETE,
    actor: actorOf(viewer),
    target: { type: 'customer', id: customerId },
    detail: {
      displayName: row.displayName,
      region: row.region,
      designerId: row.designerId,
      salesId: row.salesId,
      orders: row._count.orders,
    },
  })

  return { ok: true, data: { id: row.id, displayName: row.displayName } }
}

/**
 * 调整客户的负责设计师与销售。
 *
 * 四条约束，每一条都对应一次真实事故的形态：
 *
 *   1. 目标账号必须存在、未删除、`status = active`。指向停用账号等于把客户扔进
 *      黑洞：新负责人登不进来，旧负责人已经看不到。
 *   2. 归属发生变化时 `reason` 必填。归属比阶段更需要说法，因为它同时改变
 *      「谁能看到」与「算谁的」。
 *   3. 写审计 `customer.assignment.change`，detail 记 `{ from, to, reason }`。
 *   4. 无变化直接返回，不报错也不写审计。界面上重复点一次不该产生一条日志。
 *
 * **只由持 `customer.scope.write` 的账号调用。** 这是整条链上唯一能「合法化」
 * 越权的入口 —— 把别人的客户划到自己名下，之后一切读写都合规。因此即便路由
 * 已经挂了守卫，这里仍然自己判一次：service 被别的路径复用时守卫就没了。
 */
export async function assignCustomer(
  customerId: string,
  input: AssignCustomerRequest,
  viewer: CustomerViewer,
  options: { keepSuggestionId?: string | undefined } = {},
): Promise<CustomerResult<CustomerDetailDto>> {
  if (!viewer.canAssign) return { ok: false, reason: 'field_not_allowed' }
  if (!UUID_PATTERN.test(customerId)) return { ok: false, reason: 'not_found' }

  const current = await prisma.customer.findFirst({
    where: { id: customerId, ...scopeWhere(viewer.scope) },
    select: { id: true, designerId: true, salesId: true },
  })
  if (current === null) {
    await recordDeniedAccess(customerId, viewer)
    return { ok: false, reason: 'not_found' }
  }

  const nextDesigner =
    input.designerId === undefined ? current.designerId : (input.designerId ?? null)
  const nextSales = input.salesId === undefined ? current.salesId : (input.salesId ?? null)

  // 无变化：既不报错，也不写审计。重复提交与「点了保存但没改」是同一种情形。
  if (nextDesigner === current.designerId && nextSales === current.salesId) {
    return getCustomer(customerId, viewer)
  }

  const reason = (input.reason ?? '').trim()
  if (reason === '') return { ok: false, reason: 'missing_reason' }

  // 两个目标账号一起校验完再写库：只校验第一个就写，会出现「设计师改了、销售
  // 没改成」这种半完成的归属，而界面上看起来只是一次普通保存。
  for (const targetId of [nextDesigner, nextSales]) {
    if (targetId === null) continue
    const account = await prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, status: true, deletedAt: true },
    })
    if (account === null || account.deletedAt !== null || account.status !== 'active') {
      return { ok: false, reason: 'invalid_assignee' }
    }
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: { designerId: nextDesigner, salesId: nextSales },
  })

  // 归属变了就清掉未复核的归类结果：它描述的是「这条还没人认领时该怎么分」，
  // 认领之后留着只会让下一个人以为系统建议再改一次。
  // 复核路径会把自己那条排除掉（`keepSuggestionId`），否则刚复核完的记录会被
  // 这次清理顺手删掉，审计里留下一条指向已删除行的 id。
  await prisma.customerPoolSuggestion.deleteMany({
    where: {
      customerId,
      status: 'pending',
      ...(options.keepSuggestionId === undefined ? {} : { id: { not: options.keepSuggestionId } }),
    },
  })

  await recordAudit({
    action: AUDIT_ACTIONS.CUSTOMER_ASSIGNMENT_CHANGE,
    actor: actorOf(viewer),
    target: { type: 'customer', id: customerId },
    detail: {
      from: { designerId: current.designerId, salesId: current.salesId },
      to: { designerId: nextDesigner, salesId: nextSales },
      reason,
    },
  })

  return getCustomer(customerId, viewer)
}
