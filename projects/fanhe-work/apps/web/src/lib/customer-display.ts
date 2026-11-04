import {
  CUSTOMER_STAGE_META,
  ORDER_STAGE_DEFS,
  compareStage,
  type CustomerAmounts,
  type CustomerStage,
  type CustomerStepDto,
  type RegionScope,
} from '@fanhe/shared'

/**
 * 客户平台的展示规则。
 *
 * **全部是纯函数，写在这里而不是写进组件。** 组件里的判断只有开浏览器才验得了，
 * 而这一层的错误恰恰都是「看起来正常」的那一类：金额少两位、进度条算到 100%
 * 因为分母用了已完成的环数、回退的客户在列表上显示成已完结。抽出来才有办法
 * 在提交前用断言钉住，理由与 `case-library-display.ts` 相同。
 *
 * 颜色只用令牌类名（`text-primary`、`bg-destructive/10` 等），不写死十六进制 ——
 * 亮暗两套主题各有一份令牌，写死颜色等于只做了一半。
 */

// ---------------------------------------------------------------------------
// 金额
// ---------------------------------------------------------------------------

/**
 * 分转「元」的显示文本。
 *
 * **null 与 0 必须分开。** null 是「还没录」，0 是「录了，是零」。两者在金额列上
 * 长得一样（都是空或零），但含义完全相反：前者要人去补，后者是事实。这里刻意让
 * null 显示成「未录入」而不是「—」，因为它确实需要有人动一次手。
 *
 * 三分位用 `Intl.NumberFormat` 而不是手写正则：1680000 分 = 16800 元，手写实现里
 * 最常见的是**先除后取舍**，`(fen / 100).toFixed(2)` 遇到 123456789 分会因为
 * 浮点误差少一分。这里先取整到分再格式化，不经过浮点除法。
 */
export function formatFen(fen: number | null): string {
  if (fen === null) return '未录入'
  const yuan = Math.trunc(fen / 100)
  const cents = Math.abs(fen % 100)
  const grouped = new Intl.NumberFormat('zh-CN').format(yuan)
  return cents === 0 ? `${grouped} 元` : `${grouped}.${String(cents).padStart(2, '0')} 元`
}

/** 万元口径，用于汇总卡。小于 1 万时退回「元」，否则「1.2 万」会被读成 1200。 */
export function formatWan(fen: number | null): string {
  if (fen === null) return '未录入'
  if (Math.abs(fen) < 1_000_000) return formatFen(fen)
  const wan = fen / 1_000_000
  // 保留一位小数就够：汇总卡上的数字精确到百元没有意义，而多两位会让卡片宽度跳动。
  return `${wan.toFixed(1)} 万`
}

/**
 * 订单结算的七个格子，按界面上的显示顺序排。
 *
 * 做成表而不是在 JSX 里手写七段：七个格子里有五个能改、两个只读，顺序与标签
 * 一旦分散在两处（渲染一处、校验一处），迟早会出现「界面上叫已收尾款、保存时写到
 * 已收」这种错位，而它在界面上看不出来。
 *
 * 顺序照业务口径：先说收了几笔（定金、预付款、已收尾款），再看还欠多少（未收尾款），
 * 然后是手续费，最后两个总额。把总额放前面的话，人第一眼看到的是自己最不需要
 * 核对的那两个数字。
 */
export type OrderAmountFieldKey =
  'deposit' | 'prepay' | 'finalReceived' | 'unpaid' | 'fee' | 'contract' | 'received'

export type OrderAmountField = {
  key: OrderAmountFieldKey
  label: string
  field: keyof CustomerAmounts
  /** 能不能人工更正。派生两项为 false。 */
  editable: boolean
  /** 派生项的口径说明，直接显示在数字下面。 */
  formula?: string
}

export const ORDER_AMOUNT_FIELDS: readonly OrderAmountField[] = [
  { key: 'deposit', label: '定金', field: 'depositFen', editable: true },
  { key: 'prepay', label: '预付款', field: 'prepayFen', editable: true },
  { key: 'finalReceived', label: '已收尾款', field: 'finalReceivedFen', editable: true },
  {
    key: 'unpaid',
    label: '未收尾款',
    field: 'unpaidFen',
    editable: false,
    formula: '合同总金额 − 定金 − 预付款 − 已收尾款',
  },
  { key: 'fee', label: '手续费', field: 'feeFen', editable: true },
  { key: 'contract', label: '合同总金额', field: 'contractFen', editable: true },
  {
    key: 'received',
    label: '实收金额',
    field: 'receivedFen',
    editable: false,
    formula: '定金 + 预付款 + 已收尾款 − 手续费',
  },
]

/**
 * 金额是否为「异常」。目前只有一种：未收尾款为负。
 *
 * 负数意味着收的钱超过合同额（多收、重复记账、退款没记）。这不是显示格式问题，
 * 是要有人去对账的信号，因此界面给它一个醒目的样式，而不是取绝对值糊过去。
 */
export function isAmountAnomaly(field: OrderAmountField, value: number | null): boolean {
  return field.key === 'unpaid' && value !== null && value < 0
}

/** 可人工更正的五项，更正表单按这个顺序铺。派生两项不在其中。 */
export const EDITABLE_AMOUNT_FIELDS: readonly OrderAmountField[] = ORDER_AMOUNT_FIELDS.filter(
  (field) => field.editable,
)

export type YuanParseResult =
  { ok: true; fen: number } | { ok: false; reason: 'empty' | 'invalid' | 'negative' | 'too-large' }

/**
 * 「元」输入框转分。
 *
 * 三种失败分开返回，因为界面上的处理不同：空串是「没填」，不必报错；非法字符要
 * 就地提示；金额过大要拒绝 —— 那几乎一定是多按了几个零。糊成一种失败，界面只能
 * 说一句「金额不合法」，用户看不出自己错在哪。
 *
 * 允许千分位逗号：从报价单复制过来的数字通常带逗号，要求人先删掉再粘是没必要的摩擦。
 */
export function parseYuanToFen(text: string): YuanParseResult {
  const trimmed = text.trim().replace(/,/g, '')
  if (trimmed === '') return { ok: false, reason: 'empty' }
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) return { ok: false, reason: 'invalid' }
  const value = Number(trimmed)
  if (Number.isNaN(value)) return { ok: false, reason: 'invalid' }
  if (value < 0) return { ok: false, reason: 'negative' }
  // 与路由 schema 的上限一致（1 亿元）。两处都写同一个数量级是有意的：
  // 前端先拦一次，用户不必等一次往返才知道自己多打了一个零。
  if (value > 100_000_000) return { ok: false, reason: 'too-large' }
  // 先乘再取整，且用 Math.round 抵消 0.1 + 0.2 那类浮点表示误差。
  return { ok: true, fen: Math.round(value * 100) }
}

// ---------------------------------------------------------------------------
// 地区与阶段
// ---------------------------------------------------------------------------

/** 地区层级的展示文案。数据库存英文枚举，界面不显示英文。 */
export function scopeLabel(scope: RegionScope): string {
  if (scope === 'special-region') return '港澳台'
  if (scope === 'overseas') return '海外'
  return '国内'
}

export type StageTone = 'neutral' | 'progress' | 'warn' | 'done' | 'danger'

/**
 * 阶段到色调的映射。
 *
 * 分五档而不是给 14 个状态各配一个颜色：颜色多了就没有信息量，一眼扫过去只看到
 * 一片彩色。真正需要一眼分辨的只有五种处境 —— 谈着、在做、有遗留、完结了、
 * 黄了。
 *
 * **退款与流失单独一档（`danger`）。** 它们混进「已完结」是审计里发现的最严重
 * 的一类误判：客户正在要求退定金，界面上却显示已完结。
 */
export function stageTone(stage: CustomerStage): StageTone {
  switch (stage) {
    case 'closed':
      return 'done'
    case 'after_sales':
      return 'warn'
    case 'refunding':
    case 'lost':
      return 'danger'
    case 'contracted':
    case 'producing':
    case 'shipped':
    case 'installed':
      return 'progress'
    default:
      return 'neutral'
  }
}

/** 色调对应的类名。只引用令牌，不写死颜色。 */
export function toneClass(tone: StageTone): string {
  switch (tone) {
    case 'done':
      return 'bg-primary/10 text-primary'
    case 'progress':
      return 'bg-secondary text-secondary-foreground'
    case 'warn':
      return 'bg-muted text-foreground'
    case 'danger':
      return 'bg-destructive/10 text-destructive'
    default:
      return 'bg-muted text-muted-foreground'
  }
}

/** 阶段文案。中文名集中在契约里，界面不另写一份。 */
export function stageLabel(stage: CustomerStage): string {
  return CUSTOMER_STAGE_META[stage]?.label ?? stage
}

// ---------------------------------------------------------------------------
// 环节进度
// ---------------------------------------------------------------------------

export type OrderProgress = {
  /** 已完成环节数。 */
  done: number
  /** 已到达环节数（含已完成）。 */
  reached: number
  /** 总环节数，取自契约，不写死 14。 */
  total: number
  /** 百分比，0..100 的整数。 */
  percent: number
}

/**
 * 订单进度。
 *
 * **分母是全部环节，不是「已到达的环节」。** 用后者算出来永远是 100%，而这种
 * 进度条在界面上看起来完全正常 —— 它只是没有信息量。这类错法一旦上线，很少有人
 * 会去质疑「为什么每一单都是满的」。
 *
 * 百分比按 `done` 算，不按 `reached`：客户关心的是「做到哪一步」而不是「碰过哪几步」。
 */
export function orderProgress(steps: readonly CustomerStepDto[]): OrderProgress {
  const total = steps.length
  const done = steps.filter((step) => step.done).length
  const reached = steps.filter((step) => step.reached).length
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  return { done, reached, total, percent }
}

export type StepSection = {
  key: string
  title: string
  /** 分段说明。补件段与其余段语义不同（只有判定为「有补件」时才走），需要一句话讲清。 */
  hint: string
  steps: readonly CustomerStepDto[]
}

/**
 * 把十四环节按语义切成四段。
 *
 * 切分依据来自契约里的 `kind` 与序号：
 *
 *   1. 主流程 1–9：从接入到安装，每单必走；
 *   2. 判定 10：「是否有补件」，不产生交付物，只决定后面会不会启用；
 *   3. 补件 11–13：判定为「有」才走；
 *   4. 完结 14。
 *
 * 一次性铺十四行会让「补件那三行空着」看起来像漏填，而不是「这单没有补件」。
 * 分段之后，空段可以直接收起。
 */
export function splitStepSections(steps: readonly CustomerStepDto[]): readonly StepSection[] {
  const pick = (from: number, to: number) =>
    steps.filter((step) => step.idx >= from && step.idx <= to)
  const decisionIdx = ORDER_STAGE_DEFS.find((def) => def.kind === 'decision')?.index ?? 10
  return [
    {
      key: 'main',
      title: '主流程',
      hint: '接入、测量、设计、合同、生产、出货、运输、送货、安装',
      steps: pick(1, decisionIdx - 1),
    },
    {
      key: 'decision',
      title: '补件判定',
      hint: '判定为「有补件」才启用后面三环',
      steps: pick(decisionIdx, decisionIdx),
    },
    {
      key: 'spare',
      title: '补件处理',
      hint: '补件生产、补件发货、售后上门',
      steps: pick(decisionIdx + 1, 13),
    },
    {
      key: 'close',
      title: '完结',
      hint: '验收与订单关闭',
      steps: pick(14, 14),
    },
  ]
}

// ---------------------------------------------------------------------------
// 时间与排序
// ---------------------------------------------------------------------------

/** ISO 时间转「2026-05-20 14:32」。取本地时区，不用 `toISOString` 的 UTC。 */
export function formatDateTime(iso: string | null): string {
  if (iso === null || iso === '') return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 只有日期时（环节节点）用这个，不补一个假的时间。 */
export function formatDate(value: string | null): string {
  return value === null || value === '' ? '—' : value
}

/**
 * 活跃度：从「最近消息」再往前说一步 —— 这单还在动，还是已经凉了。
 *
 * 列表里那一列原本只有 `2026-10-28 11:48`，看上去每个客户都在同一天说过话，
 * 差别全藏在日期里，要一行一行读才知道谁在沉默。这里把它折成一句话。
 *
 * **按自然日算，不按毫秒。** 昨晚 23:50 的消息距今不到 10 小时，按毫秒算会得出
 * 「今天」；而人说的「今天」是日历上的今天。同步每天只跑一次，日期差本来也只需
 * 精确到天。
 */
export type ActivityLevel = 'active' | 'warm' | 'idle' | 'cold' | 'unknown'

export type Activity = {
  label: string
  level: ActivityLevel
}

const DAY_MS = 24 * 60 * 60 * 1000

/** 取本地零点，用于把「距今多少毫秒」换成「差几个自然日」。 */
function startOfLocalDay(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

export function activityOf(lastMessageAt: string | null, nowMs: number): Activity {
  if (lastMessageAt === null || lastMessageAt === '') {
    return { label: '没有消息', level: 'unknown' }
  }
  const last = new Date(lastMessageAt)
  if (Number.isNaN(last.getTime())) return { label: '没有消息', level: 'unknown' }

  const now = new Date(nowMs)
  // `Math.round` 而不是 `floor`：跨夏令时的一天是 23 或 25 小时，直接除会有 ±1 的漂移。
  const days = Math.round((startOfLocalDay(now) - startOfLocalDay(last)) / DAY_MS)

  // 未来时间（时钟不同步、或手工改过库）按「今天」处理，不显示「-3 天前」。
  if (days <= 0) return { label: '今天有消息', level: 'active' }
  if (days === 1) return { label: '昨天有消息', level: 'active' }
  if (days <= 7) return { label: '近一周有消息', level: 'active' }
  if (days <= 30) return { label: `${days} 天前`, level: 'warm' }
  if (days <= 180) return { label: `${Math.floor(days / 30)} 个月前`, level: 'idle' }
  return { label: '超过半年没动', level: 'cold' }
}

/** 活跃度对应的文字色。沉默越久越显眼，但不用红色警报——它只是「很久没聊」。 */
export function activityClass(level: ActivityLevel): string {
  switch (level) {
    case 'active':
    case 'warm':
      return 'text-muted-foreground'
    case 'idle':
      // 用 `foreground` 而不是加深的 muted：这一档要「看起来比上面重一点」，
      // 但项目里没有现成的第三级灰，硬造一个会绕过令牌。
      return 'text-foreground'
    case 'cold':
      return 'text-destructive'
    default:
      return 'text-muted-foreground'
  }
}

export type StageBucket = { stage: CustomerStage; count: number }

/**
 * 阶段分布的展示序列：补齐零值并按主线顺序排。
 *
 * 服务端只回有数据的档位（省得每次都发 14 行）。界面要不要补零取决于用途 ——
 * 这里补零，因为综合看板的一排阶段标签需要稳定的顺序与宽度，缺档会让标签在
 * 刷新后跳位。已流失、退款中排在最后，它们不属于推进序列。
 */
export function fillStageBuckets(
  buckets: readonly StageBucket[],
  stages: readonly CustomerStage[],
): readonly StageBucket[] {
  const counts = new Map(buckets.map((bucket) => [bucket.stage, bucket.count]))
  return stages
    .map((stage) => ({ stage, count: counts.get(stage) ?? 0 }))
    .sort((a, b) => compareStage(a.stage, b.stage))
}

/**
 * 复核状态的标签。只对「没签过字」的那批返回文案，已确认的返回 null。
 *
 * 已确认不显示任何东西：列表上一大半是「已确认」，每行都挂一个绿标只会变成噪音。
 * 需要强调的是例外 —— 待复核与已驳回。
 */
export function reviewLabel(reviewStatus: string, confidence: string): string | null {
  if (reviewStatus === 'rejected') return '已驳回'
  if (reviewStatus !== 'pending') return null
  // 置信度跟着一起显示：同样是「待复核」，「模型很确定」与「基本是猜的」
  // 需要花的复核力气完全不同，混成一句话会让人以为两者一样。
  return confidence === 'low' || confidence === 'none' ? '待复核 · 低置信' : '待复核'
}

// ---------------------------------------------------------------------------
// 环形图与折线图
// ---------------------------------------------------------------------------

/**
 * 一段弧。`fraction` 是占全环的比例，`start` 是它在环上的起点比例。
 *
 * 用比例而不是角度或像素：SVG 的 `<circle pathLength={100}>` 之后，
 * `stroke-dasharray` 的单位就是百分之一圈，比例可以直接填进去，不必再乘 2πr。
 * 半径改了也不用重算。
 *
 * 总数为 0 时返回全零，不平均分配。平均分配会让「一位客户都没有」画出一个满环，
 * 那是最容易被当成「有数据」的一种空态。
 */
export type DonutArc = { fraction: number; start: number }

export function donutArcs(values: readonly number[]): readonly DonutArc[] {
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0)
  if (total <= 0) return values.map(() => ({ fraction: 0, start: 0 }))

  let cursor = 0
  return values.map((value) => {
    const fraction = Math.max(value, 0) / total
    const arc = { fraction, start: cursor }
    cursor += fraction
    return arc
  })
}

/** 比例转百分比文案。整数就写整数，避免「33.0%」这种假精度。 */
export function percentText(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction <= 0) return '0%'
  const percent = fraction * 100
  return percent >= 10 || Number.isInteger(percent)
    ? `${Math.round(percent)}%`
    : `${percent.toFixed(1)}%`
}

/** 活跃度折线的横轴标签：`14:00`。只到小时，分钟在这里没有意义。 */
export function hourText(hourStart: string): string {
  const date = new Date(hourStart)
  if (Number.isNaN(date.getTime())) return '—'
  return `${String(date.getHours()).padStart(2, '0')}:00`
}

/**
 * 折线的峰值格下标。全为 0 时返回 -1。
 *
 * 返回 -1 而不是 0：0 会让「一格都没有」画成「第一格是峰值」，
 * 图例上就会写出一句「00:00 为 0 位客户」。
 */
export function peakHourIndex(points: readonly { count: number }[]): number {
  let best = -1
  let bestValue = 0
  points.forEach((point, index) => {
    if (point.count > bestValue) {
      bestValue = point.count
      best = index
    }
  })
  return best
}

/** 折线纵轴的上界。全零时给 1，避免除零，同时让零线贴着底边。 */
export function activityCeiling(points: readonly { count: number }[]): number {
  const peak = points.reduce((max, point) => Math.max(max, point.count), 0)
  return peak <= 0 ? 1 : peak
}

// ---------------------------------------------------------------------------
// 双角色归属与公共池
// ---------------------------------------------------------------------------

/** 归属展示需要的字段。与 DTO 解耦，单测里造一个对象就能验。 */
export type AssignmentView = {
  designerName: string | null
  salesName: string | null
  myRole: 'designer' | 'sales' | null
}

export type AssignmentPart = {
  role: 'designer' | 'sales'
  roleLabel: string
  name: string
  /** 当前账号就是这一位。展示成「名字（我）」。 */
  mine: boolean
}

/**
 * 把归属拆成「角色 + 名字」的片段，供界面渲染成两个小标签。
 *
 * **两栏可以同时有值。** 需求是设计师端要看到销售是谁、销售端要看到设计师是谁，
 * 所以不能只渲染「自己对应那一栏」—— 那样一来，设计师看不到销售，双向就断了。
 * 也不能只渲染「对方那一栏」—— 全局范围的管理员两个都要看。
 */
export function assignmentParts(view: AssignmentView): AssignmentPart[] {
  const parts: AssignmentPart[] = []
  if (view.designerName !== null) {
    parts.push({
      role: 'designer',
      roleLabel: '设计师',
      name: view.designerName,
      mine: view.myRole === 'designer',
    })
  }
  if (view.salesName !== null) {
    parts.push({
      role: 'sales',
      roleLabel: '销售',
      name: view.salesName,
      mine: view.myRole === 'sales',
    })
  }
  return parts
}

/**
 * 一行文本版的归属。列表列宽有限，两个标签放不下时用它兜底，也用于导出与复制。
 *
 * 「公共池」与「未分配」是同一件事的两种说法，这里统一成「公共池」：它同时是
 * 一个功能名（公共池归类），用户点进去就能看到待办，比「未分配」更可操作。
 */
export function assignmentSummary(view: AssignmentView): string {
  const parts = assignmentParts(view)
  if (parts.length === 0) return '公共池'
  return parts
    .map((part) => `${part.roleLabel} ${part.name}${part.mine ? '（我）' : ''}`)
    .join(' · ')
}

/** 角色名。归类结果与归属两处共用，避免一处写「设计」另一处写「设计师」。 */
export function poolRoleLabel(role: 'designer' | 'sales'): string {
  return role === 'designer' ? '设计师' : '销售'
}

/**
 * 置信度的展示档位。
 *
 * 分三档而不是直接显示百分数：复核的人要做的是「这条要不要看一眼」，「72%」
 * 回答不了这个问题，而「需人工判断」可以。具体数字仍然显示，但只作为副文本。
 *
 * **这里不再有「陈旧证据上限 60」**：那个封顶已从引擎移除（它让排序正好反过来 ——
 * 真实 92 分的强结论被压到 60，和平局混在一起）。数据新旧改由 `confidenceHint`
 * 单独标注，阈值只剩「差距明显」这一层含义。
 */
export function confidenceLevel(confidence: number): 'high' | 'medium' | 'low' {
  if (confidence >= 70) return 'high'
  if (confidence >= 50) return 'medium'
  return 'low'
}

export function confidenceLabel(confidence: number): string {
  const level = confidenceLevel(confidence)
  if (level === 'high') return '可以直接采用'
  if (level === 'medium') return '建议看一眼'
  return '需人工判断'
}

/** `confidenceHint` 只关心依据码，不关心文案与分值，所以收窄成这个形状。 */
type ReasonCodeLike = { code: string }

export type PoolConfidenceHint = {
  /**
   * `none` 是独立的一档，不是「比 low 更低」。
   *
   * 平局时引擎确实给了方向（按阶段先验），但它**没有算出来的把握**。把这种情况
   * 并入 low，界面就会显示「0%，需人工判断」——读起来像「引擎有一点点把握」，
   * 而事实是「引擎没结论」。这两种状态给复核的人的心理预期完全不同。
   */
  tone: 'high' | 'medium' | 'low' | 'none'
  /** 主标签。 */
  label: string
  /** 是否在标签旁显示百分数。0 分不显示：写成「0%」会被当成一个测量结果。 */
  showScore: boolean
  /** 需要额外解释时的一句话，否则为 null。 */
  note: string | null
}

/**
 * 公共池建议的置信度提示。
 *
 * 把三件事分开说清楚，不再用一个数字背两层含义：
 *   - 证据有多一致 → `tone` / `label` / `showScore`
 *   - 证据有多旧   → `stale` 依据码（引擎不再因此压分）
 *   - 判决口径     → `note`
 */
export function confidenceHint(
  confidence: number,
  reasons: readonly ReasonCodeLike[],
): PoolConfidenceHint {
  const stale = reasons.some((reason) => reason.code === 'stale')

  if (confidence <= 0) {
    return {
      tone: 'none',
      label: '证据不足',
      showScore: false,
      note: stale
        ? '两侧证据互相抵消，按当前阶段给了方向；群聊也已超过 90 天没有新消息，请人工指派'
        : '两侧证据互相抵消，按当前阶段给了方向，请人工指派',
    }
  }

  if (stale) {
    return {
      tone: confidenceLevel(confidence),
      label: `${confidenceLabel(confidence)}（数据较旧）`,
      showScore: true,
      note: '群聊最近 90 天没有新消息，结论来自较早的对话，可能已经不再适用',
    }
  }

  return {
    tone: confidenceLevel(confidence),
    label: confidenceLabel(confidence),
    showScore: true,
    note: null,
  }
}
