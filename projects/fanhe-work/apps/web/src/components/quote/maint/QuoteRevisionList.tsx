import type { QuoteRevisionDto } from '@fanhe/shared'
import { useCallback, useEffect, useState } from 'react'

import { ApiError } from '../../../lib/api'
import { loadQuoteRevisions } from '../../../lib/quote'
import { describeRevisionChange, formatRevisionTime } from '../../../lib/quote-display'

/**
 * 变更记录。**保留原样**：这一块是审计，不该被这次重构改动。
 *
 * 改价、上下架、换图、分类改名 / 合并、批量导入都写同一张 `quote_revisions`。
 * 分类与导入不是「某一条产品」，它们的 `itemCode` 是 `cat:<source>` 与 `import`，
 * 服务端会把它们翻成「分类 · 销售查价系统」「批量导入」再回来 —— 直接显示
 * `cat:sale` 会让人以为库里有一条叫这个名字的产品。
 */
export function QuoteRevisionList({ reloadToken }: { reloadToken: number }) {
  const [rows, setRows] = useState<QuoteRevisionDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  /** `reloadToken` 变化时重取。写成 void 包装给 effect 用，理由见分类区。 */
  const reload = useCallback(() => {
    void loadQuoteRevisions(50)
      .then((result) => {
        setRows([...result.items])
        setError(null)
      })
      .catch((cause: unknown) => {
        setRows(null)
        setError(cause instanceof ApiError ? cause.message : '变更记录读取失败')
      })
  }, [])

  useEffect(reload, [reload, reloadToken])

  if (error !== null) {
    return <p className="p-4 text-[12.5px] text-destructive">{error}</p>
  }
  if (rows === null) {
    return <p className="p-4 text-[12.5px] text-muted-foreground">读取中…</p>
  }
  if (rows.length === 0) {
    return (
      <p className="p-4 text-[12.5px] leading-[1.8] text-muted-foreground">
        还没有任何记录 —— 台账导入不算变更。在线改价、上下架、换图、分类改名 / 合并、
        批量导入才会写一行。
      </p>
    )
  }

  return (
    <div className="h-full min-h-0 overflow-auto rounded-xl border border-border">
      <table className="w-full border-collapse text-[12.5px]">
        <thead>
          <tr>
            <th className="w-[132px] border-b border-border-soft bg-background px-3 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak">
              时间
            </th>
            <th className="w-[26%] border-b border-border-soft bg-background px-3 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak">
              项目
            </th>
            <th className="w-[24%] border-b border-border-soft bg-background px-3 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak">
              变更
            </th>
            <th className="w-[12%] border-b border-border-soft bg-background px-3 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak">
              操作人
            </th>
            <th className="border-b border-border-soft bg-background px-3 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak">
              原因
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const change = describeRevisionChange(row.field, row.oldValue, row.newValue)
            return (
              <tr key={row.id}>
                <td className="border-b border-border-soft px-3 py-2 align-top whitespace-nowrap text-muted-foreground">
                  {formatRevisionTime(row.createdAt)}
                </td>
                <td className="border-b border-border-soft px-3 py-2 align-top">
                  {row.itemName === '' ? row.itemCode : row.itemName}
                </td>
                <td className="border-b border-border-soft px-3 py-2 align-top">
                  {change.before === '' && change.after === '' ? (
                    <span className="text-muted-foreground-weak">—</span>
                  ) : (
                    <>
                      <span className="text-muted-foreground-weak line-through">
                        {change.before}
                      </span>
                      <span className="mx-1 text-muted-foreground-weak">→</span>
                      <span className="font-medium text-m-teal">{change.after}</span>
                    </>
                  )}
                </td>
                <td className="border-b border-border-soft px-3 py-2 align-top text-muted-foreground">
                  {row.operatorName}
                </td>
                <td className="border-b border-border-soft px-3 py-2 align-top text-muted-foreground">
                  {row.reason === '' ? '—' : row.reason}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
