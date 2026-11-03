import type { QuoteBindType, QuoteItemStatus, QuotePriceKind } from '@fanhe/shared'

/**
 * 查价面板的展示规则。**全是纯函数，不碰 React、不碰 DOM。**
 *
 * 抽出来的理由与 `case-library-display.ts` 相同：这些规则写进组件里就只能靠在浏览器
 * 里点开看，而「1.5 倍被显示成 ¥1.5」这种错恰恰看起来很正常 —— 人在界面上很难
 * 判断一行价格是「格式不对」还是「这行数据就是这样」。抽出来以后它们可以断言。
 *
 * 这里也放「同名多行怎么区分」：拉篮按宽度分成 15 行，光看名称一模一样，靠型号与
 * 规格那一列才分得开。这属于展示规则，不属于数据。
 */

/** 分 → 元。整数不带 `.00`。 */
export function formatYuan(fen: number): string {
  const yuan = fen / 100
  return Number.isInteger(yuan) ? String(yuan) : yuan.toFixed(2)
}

export type QuotePriceTone = 'amount' | 'text' | 'empty'

export type QuotePriceView = {
  /** 主串。金额形态是 `¥668`，其余是原文。 */
  primary: string
  /** 紧跟主串的单位后缀，如 `/㎡`、`/米`。没有就是空串。 */
  suffix: string
  /** 形态说明，详情页用。列表里不显示。 */
  caption: string
  tone: QuotePriceTone
}

/** 价格形态的中文名，用于详情页的角标。 */
const PRICE_KIND_LABELS: Record<QuotePriceKind, string> = {
  amount: '单价',
  per_meter: '按米计价',
  multiplier: '倍率',
  rule: '按规则计',
  empty: '待补价',
}

export function describePriceKind(kind: QuotePriceKind): string {
  return PRICE_KIND_LABELS[kind]
}

/**
 * 一行价格该怎么显示。
 *
 * **形态决定一切，数值只是素材。** 台账里「1.5 倍」的 1.5 与「668 元」的 668 在
 * 数据库里都是数字，只有 `priceKind` 能区分。早年不分形态的实现把「1.5 倍」渲染成
 * `¥1.5`，界面上完全看不出异常 —— 只有拿它算过一次报价的人才知道错了。
 */
export function describePrice(item: {
  priceKind: QuotePriceKind
  priceFen: number | null
  priceText: string
  unit: string
}): QuotePriceView {
  const unit = item.unit.trim()

  switch (item.priceKind) {
    case 'amount':
      if (item.priceFen === null) {
        return { primary: '待补价', suffix: '', caption: PRICE_KIND_LABELS.empty, tone: 'empty' }
      }
      return {
        primary: `¥${formatYuan(item.priceFen)}`,
        suffix: unit === '' ? '' : `/${unit}`,
        caption: PRICE_KIND_LABELS.amount,
        tone: 'amount',
      }
    case 'per_meter':
      return {
        primary: item.priceFen === null ? item.priceText : `¥${formatYuan(item.priceFen)}`,
        suffix: '/米',
        caption: PRICE_KIND_LABELS.per_meter,
        tone: item.priceFen === null ? 'text' : 'amount',
      }
    case 'multiplier':
      return {
        primary: item.priceText.trim(),
        // 倍率没有单位可加 —— 加一个「/倍」只会让它更像金额。
        suffix: '',
        caption: PRICE_KIND_LABELS.multiplier,
        tone: 'text',
      }
    case 'rule':
      return {
        primary: item.priceText.trim(),
        suffix: '',
        caption: PRICE_KIND_LABELS.rule,
        tone: 'text',
      }
    case 'empty':
      return { primary: '待补价', suffix: '', caption: PRICE_KIND_LABELS.empty, tone: 'empty' }
  }
}

/** 图与型号的对应方式。`family` 必须说清楚，否则客户会以为是这个规格自己的图。 */
const BIND_LABELS: Record<QuoteBindType, string> = {
  exact: '本品项图',
  family: '同系列图',
  manual: '手工上传',
}

export function describeBindType(bindType: QuoteBindType): string {
  return BIND_LABELS[bindType]
}

/**
 * 来源的配色 —— **左栏圆点、结果表标签、详情浮层圆点共用这一份，别再各写一套。**
 *
 * 早先是一张写死的 `{ sale: 青, craft: 褐, hardware: 蓝 }`。主类能自建之后，那张表
 * 对新来源返回 `undefined` —— 圆点变成**透明**，看起来像少画了一个点，而且不报错。
 *
 * 🔴 **2026-11-03 的故障就是这么来的**：只把筛选栏换成了下面的哈希分配，结果表
 * （`QuoteResultTable`）里还留着一份写死表。于是「板式工艺收费」在左栏是青的、在表格
 * 那一列是褐的 —— 两处都「有颜色」、都不报错、都不抛异常，只是对不上。用户拿颜色当
 * 对应关系的判据，对不上就等于告诉他这是两个东西。**颜色只能有一个出处。**
 *
 * 内置三值优先命中固定表：它们的配色是静态稿定的（销售=青、工艺=褐、五金=蓝），已经
 * 用了一个多月，不该因为「改成哈希」而整体换一遍。哈希只负责自定义主类：同样的 code
 * 永远同一个颜色，撞上内置色或彼此撞色都可接受（圆点是辅助，名字才是判据）。
 */
const BUILTIN_SOURCE_COLORS: Readonly<Record<string, string>> = {
  sale: 'var(--m-teal)',
  craft: 'var(--m-amber)',
  hardware: 'var(--m-blue)',
}

const SOURCE_DOT_COLORS = [
  'var(--m-teal)',
  'var(--m-amber)',
  'var(--m-blue)',
  'var(--m-purple)',
] as const

export function quoteSourceColor(code: string): string {
  const builtin = BUILTIN_SOURCE_COLORS[code]
  if (builtin !== undefined) return builtin

  let hash = 0
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 31 + code.charCodeAt(index)) % 100_000
  }
  return SOURCE_DOT_COLORS[hash % SOURCE_DOT_COLORS.length] ?? 'var(--m-neutral)'
}

/** 状态角标。`active` 不显示 —— 绝大多数行都是在售，标出来只是噪声。 */
export function describeStatus(status: QuoteItemStatus): string | null {
  return status === 'archived' ? '已停用' : null
}

/**
 * 同名多行的区分串。
 *
 * 五金表里「诺米拉篮」按宽度分成 15 行，名称一模一样、价格不同。结果行只显示名称
 * 时，用户会以为列表重复了，然后随便点一条 —— 而拿到的是另一个宽度。所以型号与
 * 规格必须跟在名称后面。
 */
export function itemQualifier(item: { model: string; spec: string }): string {
  const parts = [item.model.trim(), item.spec.trim()].filter((part) => part !== '')
  return parts.join(' · ')
}

export type HighlightSegment = { text: string; hit: boolean }

/**
 * 把关键词命中的片段切出来，供结果行加粗。
 *
 * **大小写不敏感、但保留原文大小写**：台账里有 `E0级` 也有 `e0`。切分后原样返回，
 * 不在展示层改写用户的输入或台账的原文。
 *
 * 关键词为空时整串一段，不返回空数组 —— 调用方不必为「有没有关键词」写两个分支。
 */
export function splitHighlight(text: string, keyword: string): HighlightSegment[] {
  const needle = keyword.trim()
  if (needle === '' || text === '') return [{ text, hit: false }]

  const segments: HighlightSegment[] = []
  const lowerText = text.toLowerCase()
  const lowerNeedle = needle.toLowerCase()
  let cursor = 0

  for (;;) {
    const index = lowerText.indexOf(lowerNeedle, cursor)
    if (index === -1) break
    if (index > cursor) segments.push({ text: text.slice(cursor, index), hit: false })
    segments.push({ text: text.slice(index, index + needle.length), hit: true })
    cursor = index + needle.length
  }

  if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false })
  return segments.length === 0 ? [{ text, hit: false }] : segments
}

/** 「第几版」的展示。导入时间是本地时区，用 `toLocaleString` 而不是手拼 ISO。 */
export function describeDataset(meta: {
  itemCount: number
  imageCount: number
  importedAt: string
}): string {
  const when = meta.importedAt === '' ? '尚未导入' : formatLocalMinute(meta.importedAt)
  return `${meta.itemCount} 条 · ${meta.imageCount} 张图 · ${when}`
}

function formatLocalMinute(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 变更记录的时间列。与数据集那一行同一个格式，读的人不用在两套写法之间换算。 */
export function formatRevisionTime(iso: string): string {
  return formatLocalMinute(iso)
}

/**
 * 一条变更记录的「旧值 → 新值」怎么读。
 *
 * 库里存的是**写入那一刻的展示文本**（`describePrice` 的输出），不是结构化的金额 ——
 * 所以这里不再二次格式化，只把三种字段各自的语义翻译出来：
 *
 * - `price`：原样搬，空值写「—」/「待补价」，因为「从有价变成待补价」本身就是一次
 *   有意义的变更，不能显示成空白；
 * - `status`：`active` / `archived` 对读的人没意义，翻成「在售 / 停用」；
 * - `image`：存的是 imageKey（32 位十六进制），显示出来只是一串乱码，翻成
 *   「原图 → 新图」「原图 → 已解绑」。图本身可以去详情栏看，这里不需要还原 key。
 * - `category`：分类改名 / 合并 / 删除。新值为空串表示「这个分类被删了」，不能
 *   落到下面那个 「待补价」兜底里 —— 那句话在这里毫无意义。
 * - `deleted`：产品被物理删除。旧值是整行快照（名称 / 型号 / 规格 / 条目号 / 价格），
 *   新值恒为空，所以右边写死「已删除」。这一列是那条产品唯一还存在的记录。
 */
export function describeRevisionChange(
  field: string,
  oldValue: string,
  newValue: string,
): { before: string; after: string } {
  if (field === 'status') {
    return {
      before: oldValue === 'archived' ? '停用' : '在售',
      after: newValue === 'archived' ? '停用' : '在售',
    }
  }
  if (field === 'image') {
    return {
      before: oldValue === '' ? '无图' : '原图',
      after: newValue === '' ? '已解绑' : '新图',
    }
  }
  if (field === 'category') {
    return {
      before: oldValue === '' ? '—' : oldValue,
      after: newValue === '' ? '分类已删除' : newValue,
    }
  }
  if (field === 'deleted') {
    return { before: oldValue === '' ? '—' : oldValue, after: '已删除' }
  }
  return {
    before: oldValue === '' ? '—' : oldValue,
    after: newValue === '' ? '待补价' : newValue,
  }
}

/**
 * 解锁状态的文案。
 *
 * 四种状态刻意分开：直接可改（owner）、已解锁、未解锁、锁定中。合成一句「无权限」
 * 会让 owner 看到「你没权限」，而那个人恰恰是唯一一个本来就能改的人。
 */
export type UnlockSituation = 'direct' | 'unlocked' | 'locked' | 'locked-out' | 'no-secret'

export function resolveUnlockSituation(state: {
  direct: boolean
  hasSecret: boolean
  unlockedUntil: string | null
  lockedUntil: string | null
}): UnlockSituation {
  if (state.direct) return 'direct'
  if (!state.hasSecret) return 'no-secret'
  if (state.lockedUntil !== null) return 'locked-out'
  if (state.unlockedUntil !== null) return 'unlocked'
  return 'locked'
}

export function describeUnlockSituation(situation: UnlockSituation): string {
  switch (situation) {
    case 'direct':
      return '超级管理员，可直接维护'
    case 'unlocked':
      return '已解锁，可直接维护'
    case 'locked':
      return '需要维护口令'
    case 'locked-out':
      return '口令已锁定，稍后再试'
    case 'no-secret':
      return '尚未设置维护口令'
  }
}

/** 剩余分钟数，用于「已解锁，剩余 27 分钟」。 */
export function minutesUntil(iso: string | null, now: number = Date.now()): number | null {
  if (iso === null) return null
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return null
  const minutes = Math.ceil((time - now) / 60_000)
  return minutes > 0 ? minutes : 0
}
