import { createHash } from 'node:crypto'

/**
 * 报价条目的业务键。
 *
 * ## 为什么不用自增号或 uuid
 *
 * 台账每次调价都会整表重导。自增号会随行序变化而错位（在中间删一行，后面全部
 * 平移一格），uuid 更是每次都新生成 —— 两者都会让「上个月那条价今天变成多少」
 * 问不出来，而审计与图片绑定正是按这个键去引用的。业务键由台账自己的五列算出，
 * 同一行数据无论导几次都得到同一个串。
 *
 * ## 为什么键是哈希而不是可读的拼接
 *
 * 第一版用的是「来源 + 分类 + 名称 + 型号 + 规格」用 U+001F 拼起来（控制字符在
 * 台账里不会出现，不会有分隔符歧义）。但它随即撞上一个更硬的约束：**这个键会
 * 出现在 URL 里**（`/api/quote/items/:code`、`/api/quote/images/:key`）。控制字符
 * 进路径要 `%1F` 编码，而前面还隔着一层 Cloudflare 隧道 —— 转发时把控制字符剥掉
 * 是代理的常见行为，届时接口会 404，且看不出是被谁剥的。
 *
 * 所以键必须是纯 ASCII 且 URL 安全。改成 `前缀-16 位十六进制` 之后长度固定 22，
 * 肉眼还能按前缀分出是销售、工艺还是五金。代价是「从键反查是哪一条」要去库里查
 * —— 而这件事本来就该查库，因为键里没有价格、而「这条现在多少钱」才是真问题。
 *
 * ## 撞了怎么办
 *
 * 64 位摘要 + 1225 条，撞键概率约 3×10⁻¹⁴，可以按不撞处理。但导入器仍然会检查
 * 「同一个键对应了不同的五元组」，那种情况只可能是台账里有两条完全同名的行 ——
 * 这时导入器会给后一条加序号，并把这件事打进导入报告，而不是静默覆盖。
 */
const DIGEST_LENGTH = 16

/** 与 `quote_items.code` 的列宽一致（`前缀-16` 共 22，留足余量）。 */
export const QUOTE_ITEM_CODE_MAX = 64

export type QuoteItemKeyParts = {
  source: string
  category: string
  name: string
  model: string
  spec: string
  /**
   * 同一条台账里第几次出现（0 基）。台账确实有完全同名的行 —— 板式工艺里同品类
   * 同名、但说明与收费不同的两项。去重会丢项，靠名称匹配又分不开，所以把它们编
   * 成 `#2`、`#3` 接在键材料末尾：重导一次序号不变，键也不变。
   */
  occurrence?: number
}

/** 折叠空白。台账里有全角空格与连续空格，不折叠会让「同一行」算出两个键。 */
function normalizePart(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function digest(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, DIGEST_LENGTH)
}

/**
 * 条目的键。
 *
 * 五列一起参与：只用名称会把「拉篮 300」和「拉篮 400」算成一条，而它们价格不同、
 * 图也不同；加上型号与规格之后，同名的 15 行（拉篮按宽度分行）各自成键。
 */
export function buildQuoteItemCode(parts: QuoteItemKeyParts): string {
  const base = [parts.source, parts.category, parts.name, parts.model, parts.spec]
    .map(normalizePart)
    .join('\u001f')
  const occurrence = parts.occurrence ?? 0
  const raw = occurrence === 0 ? base : `${base}\u001f#${occurrence + 1}`
  return `${parts.source}-${digest(raw)}`
}

/**
 * 产品族的键。图的归属用这个，不用条目的 code。
 *
 * 150 张图要覆盖 499 条条目：拉篮按宽度分成 15 行，图是同一张。按条目 code 挂图
 * 等于把同一份字节存 15 份；按「来源 + 分类 + 名称」挂，同族只存一份，而「这个
 * 规格有没有自己的图」由绑定方式回答，不靠数行数。
 *
 * **型号故意不在族键里。** 主架与篮体是两行两图，但它们的名称本来就不同；把型号
 * 放进来反而会让「同名但型号留空」的行掉出本族，而那种行在销售表里是常态。
 */
export function buildQuoteFamilyKey(parts: {
  source: string
  category: string
  name: string
}): string {
  const raw = [parts.source, parts.category, parts.name].map(normalizePart).join('\u001f')
  return `fam-${digest(raw)}`
}
