import type { OpsDimensionGroup, OpsDimensionRow } from '@fanhe/shared'
import { useState } from 'react'

import {
  formatCount,
  formatFen,
  formatPercent,
  metricOf,
  shortDate,
  sortByMetric,
  type SortDirection,
} from '../../lib/ops-display'
import { cn } from '../../lib/utils'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table'
import { OpsSection } from './OpsSection'

/**
 * 商品排行。
 *
 * 排序在客户端做，不在服务端翻页：这一批数据本来就只有十几行（整段口径的 Top N），
 * 分页会让「按加购金额看谁在被反复加入购物车」这类临时判断变得别扭。数据量涨到
 * 需要分页时，接口的 `ops.shop.read` 与这里的列结构都不必改，只换数据源。
 *
 * **金额列在没有 `ops.finance.read` 时整列消失**，而不是显示一列破折号 ——
 * 后者会让人以为「这些商品没有金额」，而前者明确表示「这一项你看不到」。
 * 判断依据是「指标键是否还在」，服务端裁掉金额时会把键一起删掉，见
 * `ops/query.ts` 的 `maskDimensionRows`。
 *
 * 标题列截断到两行。商品标题普遍 30 个字以上，全展开会把行高撑到三倍，一屏只
 * 看得见四行；完整标题放在 `title` 属性里。
 */
type SortKey = 'payAmountFen' | 'visitors' | 'payBuyers' | 'payRate' | 'cartFen'

const COLUMNS: readonly { key: SortKey; label: string; align: 'left' | 'right' }[] = [
  { key: 'visitors', label: '访客', align: 'right' },
  { key: 'payBuyers', label: '买家', align: 'right' },
  { key: 'payRate', label: '转化率', align: 'right' },
  { key: 'payAmountFen', label: '支付金额', align: 'right' },
  { key: 'cartFen', label: '加购金额', align: 'right' },
]

function hasKey(row: OpsDimensionRow, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(row.metrics, key)
}

export function OpsItemTable(props: { group: OpsDimensionGroup; limit?: number }) {
  const [sortKey, setSortKey] = useState<SortKey>('payAmountFen')
  const [direction, setDirection] = useState<SortDirection>('desc')

  const rows = sortByMetric(props.group.rows, sortKey, direction)
  const visible = props.limit === undefined ? rows : rows.slice(0, props.limit)
  const showMoney = visible.some((row) => hasKey(row, 'payAmountFen'))

  const windowLabel =
    props.group.window === null
      ? '无数据'
      : `${shortDate(props.group.window.from)} ~ ${shortDate(props.group.window.to)} 整段`

  const onSort = (key: SortKey) => {
    if (key === sortKey) {
      setDirection(direction === 'desc' ? 'asc' : 'desc')
      return
    }
    setSortKey(key)
    setDirection('desc')
  }

  return (
    <OpsSection title="商品排行" note={`${windowLabel} · 整段口径不随区间变`} className="min-w-0">
      {visible.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground-weak">还没有商品数据</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8 text-xs font-normal text-muted-foreground-weak">
                #
              </TableHead>
              <TableHead className="text-xs font-normal text-muted-foreground-weak">商品</TableHead>
              {COLUMNS.filter((column) => column.key !== 'payAmountFen' || showMoney).map(
                (column) => (
                  <TableHead
                    key={column.key}
                    className="text-right text-xs font-normal text-muted-foreground-weak"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSort(column.key)
                      }}
                      className={cn(
                        'inline-flex items-center gap-1 tabular-nums hover:text-foreground',
                        sortKey === column.key && 'text-foreground',
                      )}
                    >
                      {column.label}
                      {sortKey === column.key ? (
                        <span>{direction === 'desc' ? '↓' : '↑'}</span>
                      ) : null}
                    </button>
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row, index) => (
              <TableRow key={row.key}>
                <TableCell className="text-xs text-muted-foreground-weak tabular-nums">
                  {index + 1}
                </TableCell>
                <TableCell className="max-w-[420px]">
                  <span className="line-clamp-2 text-sm text-foreground" title={row.label}>
                    {row.label}
                  </span>
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {formatCount(metricOf(row, 'visitors'))}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {formatCount(metricOf(row, 'payBuyers'))}
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">
                  {formatPercent(metricOf(row, 'payRate'))}
                </TableCell>
                {showMoney ? (
                  <TableCell className="text-right text-sm tabular-nums">
                    {formatFen(metricOf(row, 'payAmountFen'), { compact: true })}
                  </TableCell>
                ) : null}
                <TableCell className="text-right text-sm tabular-nums">
                  {formatFen(metricOf(row, 'cartFen'), { compact: true })}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </OpsSection>
  )
}
