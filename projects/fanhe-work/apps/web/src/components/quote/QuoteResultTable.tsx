import type { QuoteItemDto } from '@fanhe/shared'

import { describePrice, quoteSourceColor, splitHighlight } from '../../lib/quote-display'

import { QuoteThumb } from './QuoteThumb'

/**
 * 结果表。**逐项对齐静态稿 `报价查价-嵌入静态展示.html` 的 `.tbl`。**
 *
 * ## 为什么不用 `components/ui/table`
 *
 * 那一套在 `<table>` 外面又套了一层 `overflow-x-auto` 的 div。后果有两个，都不报错：
 *
 * 1. **表头不再吸顶。** `position: sticky` 相对最近的滚动容器定位，而这一层自己就是
 *    滚动容器（`overflow:auto` 就算不滚也算）—— 表头贴着它不动，外面真正在滚的是
 *    `.tbl-wrap`，于是一往下翻表头就没了。
 * 2. **选中行的底色被吃掉。** 它的 `TableRow` 带 `data-[state=selected]:bg-muted`，
 *    属性选择器的优先级高于我们那个普通 `bg-[color-mix(...)]`，选中一行只会变成灰底。
 *
 * 原生的 `table` + `border-collapse` 与静态稿的 `.tbl` 完全一致，两件事一起消失。
 *
 * ## 列宽照抄静态稿
 *
 * 图 52px · 名称 40% · 型号/规格 15% · 单价 15%（右对齐）· 单位 8% · 来源 16%。
 * 名称列给得最大是因为台账里的名称最长（「EO级实木颗粒板+鲁丽欧松板（精板）门板」），
 * 单价列反而短 —— 金额最多五位数字加一个符号。**不按「金额最重要所以最宽」排**：
 * 单价那列一宽，名称就得折成三行，扫一列下来反而更慢。
 *
 * ## 一行三段各回答一个问题
 *
 * 名称行回答「这是什么」，下面一行 11.5px 的灰字回答「有什么限制」（备注，截 62 字），
 * 型号列回答「是哪一个规格」。同名 15 行的拉篮靠后两段才分得开。
 *
 * ## 三种价格形态在表里长得不一样
 *
 * 金额：`¥668`，等宽数字；规则价（「按所选花色36板的5倍单价计算」）：琥珀色、允许
 * 换行、最宽 158px；空价：`待补价` 圆角标签 —— 留白会被读成「免费」。
 */
/**
 * 来源标签的配色**不在这里定**，走 `quoteSourceColor()`。
 *
 * 这里曾经有一张写死的来源色表（`sale` 青、`craft` 褐、`hardware` 蓝）。主类可自建
 * 之后它有两个毛病，都不报错：
 *
 * 1. 新建的第六个主类进来是 `undefined` —— 标签只剩一圈默认边框、字是继承色，
 *    在表格里像是「没归类」的普通文字；
 * 2. 它与筛选栏用的哈希分配**不是同一套规则**，于是同一个主类在两处的颜色不一样
 *    （「板式工艺收费」左栏青、表格褐）。用户拿颜色当对应关系的判据，对不上就以为
 *    是两样东西。
 *
 * 颜色只能有一个出处，所以整段删掉，改调那个函数。
 */

/** 静态稿把来源标签里的分类名截到 10 个字：再长就把 16% 的列挤爆。 */
const TAG_MAX = 10

/** `.tbl thead th`：底色 card、11.5px、下边一条实线（不是 soft）。 */
const TH =
  'sticky top-0 z-[1] border-b border-border bg-card px-3 py-[9px] text-left text-[11.5px] font-medium whitespace-nowrap text-muted-foreground-weak'

/** `.tbl tbody td`：9/12 内边距、下边一条 soft 分隔线、顶部对齐。 */
const TD = 'border-b border-border-soft px-3 py-[9px] align-top'

export function QuoteResultTable({
  rows,
  selectedCode,
  keyword,
  onSelect,
  onOpenImage,
}: {
  rows: readonly QuoteItemDto[]
  selectedCode: string | null
  /** 已防抖的关键词。高亮按它算，不按输入框里的即时值 —— 否则边打字边跳。 */
  keyword: string
  onSelect: (code: string) => void
  onOpenImage: (item: QuoteItemDto) => void
}) {
  return (
    /* 列宽写在 `th` 的内联 `style` 上，与静态稿第 644–646 行逐字一致。
       **不用 `colgroup`。** `table-layout` 是 auto，`<col>` 的宽度只是建议值，
       而 `th`/`td` 上的宽度会同时抬高该列的最小宽度 —— 两者在「内容比列宽」时的
       收敛结果不同，这正是结果表偶发横向滚动条的来源。 */
    <table className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          <th className={`${TH} pr-0`} style={{ width: '52px' }}>
            <span className="sr-only">商品图</span>
          </th>
          <th className={TH} style={{ width: '40%' }}>
            名称
          </th>
          <th className={TH} style={{ width: '15%' }}>
            型号 / 规格
          </th>
          <th className={`${TH} text-right`} style={{ width: '15%' }}>
            单价
          </th>
          <th className={TH} style={{ width: '8%' }}>
            单位
          </th>
          <th className={TH} style={{ width: '16%' }}>
            来源
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((item) => {
          const price = describePrice(item)
          const active = item.code === selectedCode
          const color = quoteSourceColor(item.source)
          return (
            <tr
              key={item.code}
              onClick={() => {
                onSelect(item.code)
              }}
              className={[
                'cursor-pointer hover:bg-accent',
                active ? 'bg-[color-mix(in_srgb,var(--m-teal)_6%,var(--card))]' : '',
              ].join(' ')}
            >
              <td className={`${TD} pr-0`} style={{ width: '52px' }}>
                <QuoteThumb
                  item={item}
                  onOpen={() => {
                    onOpenImage(item)
                  }}
                />
              </td>

              <td className={TD}>
                <div className="leading-[19px] font-medium">
                  {splitHighlight(item.name, keyword).map((segment, index) =>
                    segment.hit ? (
                      <mark key={index} className="bg-transparent text-inherit">
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={index}>{segment.text}</span>
                    ),
                  )}
                </div>
                {item.note !== '' && (
                  <div className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground-weak">
                    {item.note.length > 62 ? `${item.note.slice(0, 62)}…` : item.note}
                  </div>
                )}
                {/* 计价方式单独一行，排在备注之后 —— 静态稿 1111–1112 行就是这个次序。
                    它是「这条按什么算」，属于补充信息，不该抢在名称上面。 */}
                {item.pricingMode !== '' && (
                  <div className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground-weak">
                    {item.pricingMode}
                  </div>
                )}
              </td>

              <td className={TD}>
                <div>
                  {item.model === '' ? (
                    <span className="text-muted-foreground-weak">—</span>
                  ) : (
                    item.model
                  )}
                </div>
                {item.spec !== '' && (
                  <div className="mt-0.5 text-[11.5px] leading-4 text-muted-foreground-weak">
                    {item.spec}
                  </div>
                )}
              </td>

              <td className={`${TD} text-right tabular-nums`}>
                {price.tone === 'amount' ? (
                  <span className="font-medium whitespace-nowrap">{price.primary}</span>
                ) : price.tone === 'empty' ? (
                  <span className="inline-block rounded-full border border-border px-1.5 text-[11px] whitespace-nowrap text-m-amber">
                    待补价
                  </span>
                ) : (
                  <span className="inline-block max-w-[158px] text-right text-[11.5px] leading-4 whitespace-normal text-m-amber">
                    {price.primary}
                  </span>
                )}
              </td>

              <td className={TD}>{item.unit === '' ? '—' : item.unit}</td>

              <td className={TD}>
                <span
                  title={item.category}
                  style={{
                    borderColor: `color-mix(in srgb, ${color} 34%, var(--border))`,
                    color,
                  }}
                  className="inline-block rounded-full border px-1.5 text-[11px] whitespace-nowrap"
                >
                  {item.category.length > TAG_MAX
                    ? `${item.category.slice(0, TAG_MAX)}…`
                    : item.category}
                </span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
