/**
 * 客户信息平台的跨进程契约。
 *
 * 这个文件只回答三件事：订单处在哪一档状态、一单生意要经过哪些环节、旧的
 * frontmatter 键怎么折进新枚举。不回答页面长什么样，也不碰数据库。
 *
 * **为什么状态与环节要分成两维。** 现网一共存在四套定义：v1.0 计划的 12 档状态、
 * `navigation.ts` 里的 7 档草稿、`ai_schema` 的 9 个节点键、`订单进度看板.md` 的
 * 14 个流程环节。审计（`docs/CUSTOMER-CRM-DATA-AUDIT-2026-10-29.md`）的结论是四者
 * 的关系为两维而非四选一：环节是横向骨架，所有订单共用同一条流水线；状态是纵向
 * 位置，回答这单现在走到哪。只留状态会丢掉「补件」这条支线，而 4 个有明细的客户
 * 里有 3 个走过补件；只留环节则无法一眼看出订单死活。
 *
 * **为什么主线之外要多两档。** 现网 55 群的 `ai_stage` 里没有任何一群被标为流失或
 * 退款，而人工台账明确列出 6 个流失客户，其中一人正在要求退定金。状态枚举缺这两档
 * 的直接后果是退款纠纷在界面上显示为「已下单」，这是所有误判里后果最重的一类。
 *
 * **为什么映射表放这里而不放前端。** 9 个键是采集脚本的内部实现，键名是英文缩写，
 * 无法直接展示给客户看。折算规则写成纯函数才能被单测覆盖；写进组件里，验证只能靠
 * 开浏览器点一遍。
 */

/**
 * 主线状态。顺序即推进方向，允许回退，回退必须填原因。
 *
 * 12 档与 v1.0 第五章一致，不新增也不合并。合并「已初测」与「方案沟通」会让
 * 复尺这个高争议节点失去独立记录位，而审计显示尺寸精度是客户第一焦虑。
 */
export const CUSTOMER_STAGE_FLOW = [
  'consulting',
  'deposited',
  'measured',
  'designing',
  'design_done',
  'quoted',
  'contracted',
  'producing',
  'shipped',
  'installed',
  'after_sales',
  'closed',
] as const

/**
 * 主线之外的终态。不参与推进序号的比较。
 *
 * `refunding` 与 `lost` 都可能从主线上任何一档跳入，因此没有固定序号。把它们
 * 塞进主线会让「回退」与「终止」混成一件事，回退原因也就失去意义。
 */
export const CUSTOMER_STAGE_OFFFLOW = ['refunding', 'lost'] as const

export const CUSTOMER_STAGES = [...CUSTOMER_STAGE_FLOW, ...CUSTOMER_STAGE_OFFFLOW] as const

export type CustomerStage = (typeof CUSTOMER_STAGES)[number]

export type CustomerStageMeta = {
  /** 展示文案。 */
  label: string
  /** 主线序号，从 1 起。旁支终态为 null。 */
  order: number | null
  /** 是否终态。终态不再接受推进，只接受重开。 */
  terminal: boolean
  /** 一句话解释，用于阶段选择器的副标题。 */
  hint: string
}

/**
 * 状态的展示元数据。文案与色彩分离，颜色属于前端展示层。
 */
export const CUSTOMER_STAGE_META: Record<CustomerStage, CustomerStageMeta> = {
  consulting: { label: '咨询中', order: 1, terminal: false, hint: '已建群，需求尚未明确' },
  deposited: { label: '已下定', order: 2, terminal: false, hint: '收到定金，尚未量尺' },
  measured: { label: '已初测', order: 3, terminal: false, hint: '完成首次测量或复尺' },
  designing: { label: '方案沟通', order: 4, terminal: false, hint: '方案调整中，未定稿' },
  design_done: { label: '方案确定', order: 5, terminal: false, hint: '方案定稿，可转报价' },
  quoted: { label: '已报价', order: 6, terminal: false, hint: '报价已出，等待客户决策' },
  contracted: { label: '已签合同', order: 7, terminal: false, hint: '合同成立，款到或部分到账' },
  producing: { label: '生产中', order: 8, terminal: false, hint: '已排产，工厂加工中' },
  shipped: { label: '已发货', order: 9, terminal: false, hint: '货已离厂或在途' },
  installed: { label: '已安装', order: 10, terminal: false, hint: '安装完毕，含收尾' },
  after_sales: { label: '售后中', order: 11, terminal: false, hint: '补件、补漆、返修未闭环' },
  closed: { label: '已完结', order: 12, terminal: true, hint: '验收完成，问题闭环' },
  refunding: { label: '退款中', order: null, terminal: false, hint: '客户要求退款，尚未处理完' },
  lost: { label: '已流失', order: null, terminal: true, hint: '终止合作，含静默超期' },
}

/**
 * 流程环节模板。顺序即流水线，第 10 环是判定节点。
 *
 * 14 环节取自 `订单进度看板.md` 第一节，一字不改。第 10 环「是否有补件」的性质
 * 与其余 13 环不同：它不产生交付物，只决定后面三环是否启用。审计显示补件在这一批
 * 客户里占比很高，把判定节点当常规流转会让没有补件的订单也留三个空环节。
 */
export type OrderStageDef = {
  /** 环节序号，从 1 起。 */
  index: number
  /** 稳定键，入库时使用。 */
  key: string
  /** 展示文案。 */
  label: string
  /** 节点性质。`decision` 表示判定节点，不产生交付物。 */
  kind: 'flow' | 'decision'
  /** 完成标志，用于人工确认时的对照。 */
  doneWhen: string
}

export const ORDER_STAGE_DEFS: readonly OrderStageDef[] = [
  {
    index: 1,
    key: 'intake',
    label: '客户订单接入',
    kind: 'flow',
    doneWhen: '群建立且需求进入沟通',
  },
  { index: 2, key: 'measure', label: '测量', kind: 'flow', doneWhen: '尺寸回传设计师并确认' },
  { index: 3, key: 'design', label: '设计', kind: 'flow', doneWhen: '方案定稿可转报价' },
  { index: 4, key: 'contract', label: '合同', kind: 'flow', doneWhen: '合同款到账' },
  { index: 5, key: 'production', label: '生产', kind: 'flow', doneWhen: '货品完工待发' },
  { index: 6, key: 'dispatch', label: '出货', kind: 'flow', doneWhen: '货品离厂' },
  { index: 7, key: 'transport', label: '运输', kind: 'flow', doneWhen: '抵达目的地城市或仓' },
  { index: 8, key: 'delivery', label: '送货', kind: 'flow', doneWhen: '货到客户现场' },
  { index: 9, key: 'install', label: '安装', kind: 'flow', doneWhen: '安装完毕' },
  {
    index: 10,
    key: 'spare_decision',
    label: '是否有补件',
    kind: 'decision',
    doneWhen: '判定为是或否',
  },
  { index: 11, key: 'spare_production', label: '补件生产', kind: 'flow', doneWhen: '补件完工' },
  { index: 12, key: 'spare_shipping', label: '补件发货', kind: 'flow', doneWhen: '补件送达' },
  { index: 13, key: 'after_sales_visit', label: '售后上门', kind: 'flow', doneWhen: '问题闭环' },
  { index: 14, key: 'close', label: '完结', kind: 'flow', doneWhen: '订单关闭' },
] as const

export const ORDER_STAGE_COUNT = ORDER_STAGE_DEFS.length

/**
 * 九个旧节点键到新状态的折算表。
 *
 * 一对多是常态：`access`（建群）与 `needs`（需求明确）都落在咨询中，`payment`
 * （收款）与 `order`（下单）都落在已签合同。一对多的部分不丢信息，原始键与日期
 * 仍存在 `legacy_blocks` 里，只是不再作为独立状态存在。
 */
export const CUSTOMER_LEGACY_STAGE_KEYS = [
  'access',
  'needs',
  'design',
  'quote',
  'payment',
  'order',
  'production',
  'install',
  'service',
] as const

export type CustomerLegacyStageKey = (typeof CUSTOMER_LEGACY_STAGE_KEYS)[number]

const LEGACY_TO_STAGE: Record<CustomerLegacyStageKey, CustomerStage> = {
  access: 'consulting',
  needs: 'consulting',
  design: 'designing',
  quote: 'quoted',
  payment: 'contracted',
  order: 'contracted',
  production: 'producing',
  install: 'installed',
  service: 'after_sales',
}

/**
 * 把旧节点键折成新状态。认不出的键返回 null，不兜底成咨询中。
 *
 * 兜底会把「解析失败」伪装成「客户刚建群」这类正常状态，两种情况的处理方式完全
 * 不同：前者要修解析器，后者不需要任何动作。返回 null 让调用方必须显式处理。
 */
export function mapLegacyStageKey(key: string): CustomerStage | null {
  const normalized = key.trim().toLowerCase()
  return (LEGACY_TO_STAGE as Record<string, CustomerStage>)[normalized] ?? null
}

/**
 * 主线序号。旁支终态返回 null。
 */
export function customerStageOrder(stage: CustomerStage): number | null {
  return CUSTOMER_STAGE_META[stage].order
}

/**
 * 判断是否回退。两端都在主线且目标序号小于来源序号即为回退。
 *
 * 服务端用它决定是否强制要求原因。跨到旁支（退款、流失）不算回退，那是终止而非
 * 倒退，两者的原因字段与审计语义不同。
 */
export function isStageRegression(from: CustomerStage, to: CustomerStage): boolean {
  const a = customerStageOrder(from)
  const b = customerStageOrder(to)
  if (a === null || b === null) return false
  return b < a
}

/**
 * 阶段推进是否合法。用于服务端校验，同一档重复提交视为无变化，不报错。
 */
export function canTransition(from: CustomerStage, to: CustomerStage): boolean {
  return from === to || CUSTOMER_STAGES.includes(to)
}

/**
 * 阶段分布统计的排序键。主线按序号，旁支排在其后。
 */
export function compareStage(a: CustomerStage, b: CustomerStage): number {
  const oa = customerStageOrder(a) ?? Number.MAX_SAFE_INTEGER
  const ob = customerStageOrder(b) ?? Number.MAX_SAFE_INTEGER
  if (oa !== ob) return oa - ob
  return a.localeCompare(b)
}

// ---------------------------------------------------------------------------
// 客户显示名
// ---------------------------------------------------------------------------
// 规则见 docs/CUSTOMER-CRM-IDENTITY-RULES-2026-10-29.md 的 B7 节。
// 58 个客户里「李姐」有 3 个、「郑哥」有 2 个，去掉地区就直接无法辨认，
// 因此显示名一律由 `地区 + 短名` 构成，地区不是附属信息而是区分主键。

/** 尊称白名单。顺序影响裁剪：先匹配长的，避免「女士」被「女」抢先。 */
export const CUSTOMER_HONORIFICS = ['先生', '女士', '姐', '哥', '总'] as const

/**
 * 地区名规范化。台湾、香港、澳门按国家规定写成「中国台湾」等，不可省略前缀。
 */
export function normalizeRegion(region: string): string {
  const SOVEREIGN: Record<string, string> = {
    台湾: '中国台湾',
    香港: '中国香港',
    澳门: '中国澳门',
  }
  return SOVEREIGN[region] ?? region
}

/** 地区所属层级，用于列表筛选分组。 */
export type RegionScope = 'special-region' | 'overseas' | 'domestic'

const OVERSEAS_REGIONS = new Set([
  '美国',
  '加拿大',
  '澳大利亚',
  '新西兰',
  '新加坡',
  '马来西亚',
  '意大利',
  '西班牙',
  '英国',
  '法国',
  '德国',
  '日本',
  '韩国',
  '越南',
  '泰国',
  '缅甸',
  '柬埔寨',
  '迪拜',
])

export function regionScopeOf(region: string): RegionScope {
  if (
    region.startsWith('中国台湾') ||
    region.startsWith('中国香港') ||
    region.startsWith('中国澳门')
  ) {
    return 'special-region'
  }
  return OVERSEAS_REGIONS.has(region) ? 'overseas' : 'domestic'
}

/**
 * 从「客户全名」推出短名，供拼接显示名使用。
 *
 * 只做一件事：裁掉与姓重复的尊称后缀。例如「李月秋李姐」→「李月秋」。
 * 三条保护，缺一条就会削掉真实客户名（2026-10-29 实测踩过）：
 *   1. 非纯中文名一律原样返回 —— 否则「JoJo女士」会被削成「JoJ」。
 *   2. 尊称前不足 3 字不裁剪 —— 「糖糖姐」「甜甜」这类两字名保持原样。
 *   3. 紧邻尊称的字与前一个字相同时视为叠字，不裁剪 —— 否则「lyra粥粥姐」「王小甜甜姐」会被削。
 */
export function customerShortName(raw: string, region?: string): string {
  let name = raw.trim()
  // 先剥掉残留的地区前缀，否则「成都」+「成都乔哥」会拼成「成都成都乔哥」
  const normalized = region ? normalizeRegion(region.trim()) : ''
  if (normalized && name.startsWith(normalized)) name = name.slice(normalized.length).trim()
  if (region && name.startsWith(region.trim())) name = name.slice(region.trim().length).trim()
  if (!name) return raw.trim()
  if (!/^[\u4e00-\u9fa5]+$/.test(name)) return name

  for (const honor of CUSTOMER_HONORIFICS) {
    if (!name.endsWith(honor)) continue
    const core = name.slice(0, -honor.length)
    if (core.length < 3) break
    const surname = core.slice(-1)
    const rest = core.slice(0, -1)
    if (rest.slice(-1) === surname) break
    if (rest.includes(surname)) return rest
  }
  return name
}

/**
 * 拼接列表与详情页使用的显示名。地区已规范化，短名已裁剪重复姓。
 *
 * `project` 用于同一客户多项目时区分，例如复购第二单显示为
 * 「秦皇岛肖女士（阿那亚三期）」。
 */
export function customerDisplayName(region: string, name: string, project?: string): string {
  const normalized = normalizeRegion(region.trim())
  const base = customerShortName(name, region)
  const head = normalized + base
  return project ? `${head}（${project}）` : head
}
