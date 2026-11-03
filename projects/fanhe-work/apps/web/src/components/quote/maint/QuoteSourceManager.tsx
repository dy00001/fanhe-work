import type { QuoteSourceDto } from '@fanhe/shared'
import { Check, LoaderCircle, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'

import { ApiError } from '../../../lib/api'
import { createQuoteSource, deleteQuoteSource, renameQuoteSource } from '../../../lib/quote'

/**
 * 主类（数据来源）管理条。
 *
 * ## 为什么是行内展开，不是一个新对话框
 *
 * 这一屏本身在 Radix Dialog 里，再开一层要重新对层级、Esc、焦点归还三件事 ——
 * 11-03 那轮灯箱问题正是这么来的（点击穿透到底层页面把整个弹窗关了）。
 *
 * ## 为什么「删除」要按两次
 *
 * 服务端只在「这一类下面一条产品都没有」时才允许删，所以拒绝路径很结实；但**通过**
 * 的那条路径是不可逆的。一次点击就删掉一个主类，误触的代价太大。第一次点把按钮换成
 * 「确认删除」，第二次才发请求，移动鼠标或点别处就恢复。
 *
 * ## 为什么只能改名字
 *
 * `code` 是每一条产品业务键的第 0 段，`ledger_prefix` 印在纸质台账上。这两样改了
 * 等于把这一类下所有条目的主键与编号全换掉，而且不报错。界面上不给入口，比给了再
 * 拦一层更诚实。
 */
export function QuoteSourceManager({
  sources,
  activeCode,
  onSelect,
  onResult,
  onClose,
}: {
  sources: readonly QuoteSourceDto[]
  activeCode: string
  onSelect: (code: string) => void
  /** 结果统一交给父级那一条提示区显示 —— 两处提示会争同一个位置。 */
  onResult: (kind: 'ok' | 'error', text: string) => void
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ code: string; name: string; short: string } | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [newShort, setNewShort] = useState('')

  async function run(task: () => Promise<string>): Promise<void> {
    setBusy(true)
    try {
      onResult('ok', await task())
    } catch (cause) {
      onResult('error', cause instanceof ApiError ? cause.message : '操作失败，请重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mb-3 rounded-xl border border-border bg-card p-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-[12.5px] font-medium">主类管理</span>
        <span className="text-[11px] text-muted-foreground-weak">
          主类就是顶部那排页签。新增之后立刻出现在页签里，可以往里传产品。
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex h-7 items-center gap-1 rounded-[7px] px-2 text-[11.5px] text-muted-foreground hover:bg-accent"
        >
          <X className="size-3" />
          收起
        </button>
      </div>

      <div className="max-h-[260px] overflow-auto rounded-lg border border-border-soft">
        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr>
              <Th className="w-[34%]">名称</Th>
              <Th className="w-20">短名</Th>
              <Th className="w-16 text-right">在售</Th>
              <Th className="w-16 text-right">已下架</Th>
              <Th className="w-[188px]">操作</Th>
            </tr>
          </thead>
          <tbody>
            {sources.map((row) => {
              // 单独取出这个局部变量而不是在 JSX 里反复判 `editing !== null`：
              // `editing?.code === row.code` 不会让 TS 窄化 `editing`，后面每处
              // `editing.name` 都要加断言。
              const editingThis = editing !== null && editing.code === row.code ? editing : null
              return (
                <tr key={row.code}>
                  <Td>
                    {editingThis !== null ? (
                      <input
                        autoFocus
                        value={editingThis.name}
                        onChange={(event) =>
                          setEditing({ ...editingThis, name: event.target.value })
                        }
                        maxLength={40}
                        aria-label={`主类「${row.name}」的新名称`}
                        className="h-7 w-full rounded-[7px] border border-ring bg-card px-2 text-[12.5px] outline-none"
                      />
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{row.name}</span>
                        {row.builtin && (
                          <span className="shrink-0 rounded border border-border px-1 text-[10.5px] leading-4 text-muted-foreground-weak">
                            内置
                          </span>
                        )}
                        {activeCode === row.code && (
                          <span className="shrink-0 text-[10.5px] text-m-teal">当前</span>
                        )}
                      </span>
                    )}
                  </Td>
                  <Td>
                    {editingThis !== null ? (
                      <input
                        value={editingThis.short}
                        onChange={(event) =>
                          setEditing({ ...editingThis, short: event.target.value })
                        }
                        maxLength={8}
                        aria-label="短名"
                        className="h-7 w-full rounded-[7px] border border-ring bg-card px-2 text-[12.5px] outline-none"
                      />
                    ) : (
                      <span className="text-muted-foreground">{row.short}</span>
                    )}
                  </Td>
                  <Td className="text-right tabular-nums">{row.itemCount}</Td>
                  <Td className="text-right text-muted-foreground-weak tabular-nums">
                    {row.archivedCount}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      {editingThis !== null ? (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              const draft = editingThis
                              setEditing(null)
                              void run(async () => {
                                await renameQuoteSource({
                                  code: draft.code,
                                  name: draft.name.trim(),
                                  short: draft.short.trim(),
                                })
                                return `已保存「${draft.name.trim()}」`
                              })
                            }}
                            className="inline-flex h-7 items-center gap-1 rounded-[7px] border border-border px-2 text-[11.5px] text-m-teal hover:bg-accent disabled:opacity-40"
                          >
                            <Check className="size-3" />
                            保存
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditing(null)}
                            className="inline-flex h-7 items-center rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setConfirming(null)
                              setEditing({ code: row.code, name: row.name, short: row.short })
                            }}
                            className="inline-flex h-7 items-center gap-1 rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40"
                          >
                            <Pencil className="size-3" />
                            编辑
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            // 删不掉的按钮**不置灰**：置灰等于不解释。点下去由服务端给
                            // 一句「还有 N 条产品」，比一个灰按钮有用得多。
                            onClick={() => {
                              if (!row.deletable && row.deleteBlockedReason !== '') {
                                onResult('error', row.deleteBlockedReason)
                                return
                              }
                              if (confirming !== row.code) {
                                setConfirming(row.code)
                                return
                              }
                              setConfirming(null)
                              void run(async () => {
                                await deleteQuoteSource({ code: row.code })
                                return `已删除主类「${row.name}」`
                              })
                            }}
                            className={
                              confirming === row.code
                                ? 'inline-flex h-7 items-center gap-1 rounded-[7px] bg-destructive px-2 text-[11.5px] text-destructive-foreground disabled:opacity-40'
                                : 'inline-flex h-7 items-center gap-1 rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40'
                            }
                          >
                            {busy && confirming === row.code ? (
                              <LoaderCircle className="size-3 animate-spin" />
                            ) : (
                              <Trash2 className="size-3" />
                            )}
                            {confirming === row.code ? '确认删除' : '删除'}
                          </button>
                          <button
                            type="button"
                            onClick={() => onSelect(row.code)}
                            className="inline-flex h-7 items-center rounded-[7px] px-2 text-[11.5px] text-muted-foreground hover:bg-accent"
                          >
                            查看
                          </button>
                        </>
                      )}
                    </div>
                  </Td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="新主类名称，例如「石材外协」"
          maxLength={40}
          aria-label="新主类名称"
          className="h-8 min-w-0 flex-1 rounded-[9px] border border-border bg-background px-2.5 text-[12.5px] outline-none focus:border-ring focus:bg-card"
        />
        <input
          value={newShort}
          onChange={(event) => setNewShort(event.target.value)}
          placeholder="短名（可空）"
          maxLength={8}
          aria-label="新主类短名"
          className="h-8 w-28 rounded-[9px] border border-border bg-background px-2.5 text-[12.5px] outline-none focus:border-ring focus:bg-card"
        />
        <button
          type="button"
          disabled={busy || newName.trim() === ''}
          onClick={() => {
            const name = newName.trim()
            const short = newShort.trim()
            setNewName('')
            setNewShort('')
            void run(async () => {
              const created = await createQuoteSource(short === '' ? { name } : { name, short })
              onSelect(created.code)
              return `已新建主类「${created.name}」，条目号前缀 ${created.ledgerPrefix}`
            })
          }}
          className="inline-flex h-8 items-center gap-1 rounded-[9px] border border-border bg-card px-3 text-[12.5px] hover:bg-accent disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          新建主类
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-muted-foreground-weak">
        新建后会自动分配条目号前缀（A、B、C…）。前缀与标识写定后不可修改 ——
        改了会让这一类下的产品编号与历史报价全部对不上。
      </p>
    </div>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`border-b border-border-soft bg-background px-3 py-1.5 text-left text-[11.5px] font-medium text-muted-foreground-weak ${className ?? ''}`}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`border-b border-border-soft px-3 py-1.5 ${className ?? ''}`}>{children}</td>
  )
}
