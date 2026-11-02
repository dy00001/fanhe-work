import { QUOTE_SOURCE_NAMES, type QuoteItemDto } from '@fanhe/shared'
import { useCallback } from 'react'

import { describePrice, itemQualifier, splitHighlight } from '../../lib/quote-display'
import { cn } from '../../lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'

import { QuoteThumb } from './QuoteThumb'

/**
 * 结果表。
 *
 * ## 为什么是表格，而不是一列卡片
 *
 * 报价是**横向比出来**的：同一个分类下几行挨着，比的是单价与单位。卡片式只把
 * 「名称 + 一个价格」放在一起，型号、规格、单位全被压进副标题，扫一眼看不出差别。
 * 这里的列与静态稿一致：图 · 名称 · 型号/规格 · 单价 · 单位 · 来源。
 *
 * ## 行不是按钮
 *
 * 与 `EventRow` 同一条规矩：行里已经有可点的缩略图，把 `<tr>` 再包成一个按钮会
 * 得到嵌套的可点元素。所以 `tr` 只挂 `onClick` + `tabIndex` + 键盘处理，本身仍是
 * 一个 `row`，读屏念出来的是「表格的一行」而不是「一个按钮」。
 *
 * ## 空值不写成空白
 *
 * 柜体类 571 条没有型号、规格大面积缺失。留空会让人以为这列坏了，写「—」表示
 * 「这一项台账里没有」。两者在数据修复上要做的事完全不同。
 */

/** 分类标签按来源上色。令牌见 `index.css` 的 `--m-teal / --m-amber / --m-blue`。 */
const SOURCE_TEXT: Record<QuoteItemDto['source'], string> = {
  sale: 'text-m-teal',
  craft: 'text-m-amber',
  hardware: 'text-m-blue',
}

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
  /** ↑↓ 在行间移动。表格里用方向键比 Tab 更接近「扫一遍价格」的动作。 */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTableRowElement>, index: number) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const row = rows[index]
        if (row !== undefined) onSelect(row.code)
        return
      }
      const delta = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
      if (delta === 0) return
      event.preventDefault()
      const next = rows[index + delta]
      if (next === undefined) return
      onSelect(next.code)
      // 焦点跟着选中走，否则连按两次方向键焦点还停在原处，第三次就按不动了。
      const siblings = event.currentTarget.parentElement?.children
      const target = siblings?.[index + delta]
      if (target instanceof HTMLElement) target.focus()
    },
    [onSelect, rows],
  )

  return (
    // `min-w` 是给窄屏的兜底：六列在手机上平分出来每列不到 60px，名称会折成
    // 两三行、单价被截成一个字符。`ui/table` 外面那层是 `overflow-x-auto`，
    // 所以设一个下限之后，窄屏是**横向滚动**而不是把内容压扁 —— 报价是横向比的，
    // 压扁了就看不出差别，反而比滚一下更难用。
    <Table className="min-w-[560px] table-fixed">
      <colgroup>
        <col className="w-12" />
        <col className="w-[34%]" />
        <col className="w-[14%]" />
        <col className="w-[20%]" />
        <col className="w-10" />
        <col className="w-[16%]" />
      </colgroup>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="sticky top-0 z-1 h-8 bg-card px-2">
            <span className="sr-only">商品图</span>
          </TableHead>
          <TableHead className="sticky top-0 z-1 h-8 bg-card px-2 text-[11px] font-normal text-muted-foreground-weak">
            名称
          </TableHead>
          <TableHead className="sticky top-0 z-1 h-8 bg-card px-2 text-[11px] font-normal text-muted-foreground-weak">
            型号 / 规格
          </TableHead>
          <TableHead className="sticky top-0 z-1 h-8 bg-card px-2 text-right text-[11px] font-normal text-muted-foreground-weak">
            单价
          </TableHead>
          <TableHead className="sticky top-0 z-1 h-8 bg-card px-2 text-[11px] font-normal text-muted-foreground-weak">
            单位
          </TableHead>
          <TableHead className="sticky top-0 z-1 h-8 bg-card px-2 text-[11px] font-normal text-muted-foreground-weak">
            来源
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((item, index) => {
          const price = describePrice(item)
          const qualifier = itemQualifier(item)
          const sub = [item.note, qualifier].filter((part) => part !== '').join(' · ')
          return (
            <TableRow
              key={item.code}
              tabIndex={0}
              aria-selected={item.code === selectedCode}
              data-state={item.code === selectedCode ? 'selected' : undefined}
              onClick={() => onSelect(item.code)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <TableCell className="px-2 py-2">
                <QuoteThumb
                  item={item}
                  onOpen={() => {
                    onOpenImage(item)
                  }}
                />
              </TableCell>
              <TableCell className="px-2 py-2 whitespace-normal">
                <div className="line-clamp-2 text-sm leading-5">
                  {splitHighlight(item.name, keyword).map((segment, segmentIndex) =>
                    segment.hit ? (
                      <mark
                        key={segmentIndex}
                        className="rounded-sm bg-transparent font-semibold text-foreground underline decoration-1 underline-offset-2"
                      >
                        {segment.text}
                      </mark>
                    ) : (
                      <span key={segmentIndex}>{segment.text}</span>
                    ),
                  )}
                </div>
                {sub !== '' && (
                  <div className="mt-0.5 line-clamp-1 text-[11px] leading-4 text-muted-foreground-weak">
                    {sub}
                  </div>
                )}
              </TableCell>
              <TableCell className="px-2 py-2 whitespace-normal">
                <div className="truncate text-xs text-foreground">
                  {item.model === '' ? '—' : item.model}
                </div>
                {item.spec !== '' && (
                  <div className="mt-0.5 truncate text-[11px] leading-4 text-muted-foreground-weak">
                    {item.spec}
                  </div>
                )}
              </TableCell>
              <TableCell className="px-2 py-2 text-right">
                {/* 规则价是整句话（「按所选花色36板的5倍单价计算 最低单价2800元/平方」），
                    在 140px 的列宽里必然放不下。列表只给一行前缀，全文放 `title`，
                    完整规则在右侧详情里 —— 查价时先看有没有数，再决定要不要读规则。 */}
                <span
                  title={price.primary}
                  className={cn(
                    'block truncate text-sm leading-5 tabular-nums',
                    price.tone === 'amount' ? 'font-medium text-foreground' : '',
                    price.tone === 'text' ? 'text-m-amber' : '',
                    price.tone === 'empty' ? 'text-m-amber' : '',
                  )}
                >
                  {price.primary}
                  {price.suffix !== '' && (
                    <span className="text-[11px] text-muted-foreground-weak">{price.suffix}</span>
                  )}
                </span>
              </TableCell>
              <TableCell className="truncate px-2 py-2 text-xs text-muted-foreground">
                {item.unitRaw === '' ? (item.unit === '' ? '—' : item.unit) : item.unitRaw}
              </TableCell>
              <TableCell className="px-2 py-2">
                <span
                  title={`${QUOTE_SOURCE_NAMES[item.source]} · ${item.category}`}
                  className={cn(
                    'inline-flex max-w-full items-center truncate rounded border border-border px-1 text-[11px] leading-[18px]',
                    SOURCE_TEXT[item.source],
                  )}
                >
                  {item.category}
                </span>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
