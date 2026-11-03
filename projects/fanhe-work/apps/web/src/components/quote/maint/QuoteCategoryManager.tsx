import {
  QUOTE_SOURCES,
  QUOTE_SOURCE_NAMES,
  type QuoteCategoryDto,
  type QuoteSource,
} from '@fanhe/shared'
import { ArrowDown, ArrowUp, Check, LoaderCircle, Pencil, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { ApiError } from '../../../lib/api'
import {
  createQuoteCategory,
  loadQuoteCategories,
  mergeQuoteCategory,
  renameQuoteCategory,
  reorderQuoteCategories,
} from '../../../lib/quote'

/**
 * 分类维护：改名、合并、新建、排序。
 *
 * ## 为什么合并用行内展开，不再套一层对话框
 *
 * 这一屏本身已经是 Radix Dialog 里的内容。再开一个 Dialog 就是「对话框套对话框」，
 * 层级、Esc、焦点归还三件事都要重新对一遍 —— 而 11-03 那轮灯箱问题正是这么来的。
 * 行内展开只多一行 DOM，没有这些边界。
 *
 * ## 排序用上下箭头，不用拖拽
 *
 * 拖拽要引一个库、要处理键盘可达性、还要在触屏上另做一套。分类数在 40 上下，
 * 一次挪一位够用；箭头是原生按钮，键盘与读屏都能操作。
 *
 * ## 顺序只写本端，服务端收到的是「完整顺序」
 *
 * 每次上移下移都把整串名字发上去。只发「把 A 移到 B 前面」那种增量协议，在并发
 * 编辑时会得到两种都说得通的解释，而结果是顺序看起来没变。
 */
export function QuoteCategoryManager({ onChanged }: { onChanged: () => void }) {
  const [source, setSource] = useState<QuoteSource>('sale')
  const [items, setItems] = useState<QuoteCategoryDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [editing, setEditing] = useState<{ name: string; draft: string } | null>(null)
  const [merging, setMerging] = useState<{ from: string; to: string } | null>(null)
  const [newName, setNewName] = useState('')

  /**
   * 重取分类清单。
   *
   * `refresh` 返回 Promise（写操作后要 `await` 它，确保列表在提示出现之前已经新了），
   * `reload` 是它的一层 void 包装，专门给 effect 用。
   *
   * **必须写成 `.then` 链，不能写成 `async` 函数**：`react-hooks/set-state-in-effect`
   * 会把 async 函数体里的 `setState` 判成「在 effect 里同步调用」，而 `.then` 回调
   * 它能认出是异步的。`QuotePanel` 的 `refreshAccess` 是同一个形状。
   */
  const refresh = useCallback(
    (): Promise<void> =>
      loadQuoteCategories()
        .then((result) => {
          setItems([...result.items])
          setError(null)
        })
        .catch((cause: unknown) => {
          setItems(null)
          setError(cause instanceof ApiError ? cause.message : '分类读取失败')
        }),
    [],
  )

  const reload = useCallback(() => {
    void refresh()
  }, [refresh])

  useEffect(reload, [reload])

  const rows = (items ?? []).filter((row) => row.source === source)
  const names = rows.map((row) => row.name)

  /** 写操作的统一包装：置忙、清提示、失败给一句人话。 */
  async function run(task: () => Promise<string>): Promise<void> {
    setBusy(true)
    setNotice(null)
    try {
      const text = await task()
      setNotice({ kind: 'ok', text })
      await refresh()
      onChanged()
    } catch (cause) {
      setNotice({
        kind: 'error',
        text: cause instanceof ApiError ? cause.message : '操作失败，请重试',
      })
    } finally {
      setBusy(false)
    }
  }

  function move(index: number, delta: number): void {
    const next = index + delta
    if (next < 0 || next >= rows.length) return
    const order = [...names]
    const [moved] = order.splice(index, 1)
    if (moved === undefined) return
    order.splice(next, 0, moved)

    // 先改本端顺序，再发请求：等一个来回才动的列表，在连续点箭头时会跳。
    const reordered = new Map(order.map((name, position) => [name, position]))
    setItems((current) =>
      (current ?? []).map((row) =>
        row.source === source
          ? { ...row, sortOrder: reordered.get(row.name) ?? row.sortOrder }
          : row,
      ),
    )
    void run(async () => {
      await reorderQuoteCategories({ source, order })
      return '顺序已保存'
    })
  }

  async function submitRename(): Promise<void> {
    if (editing === null) return
    const to = editing.draft.trim()
    if (to === '' || to === editing.name) {
      setEditing(null)
      return
    }
    const from = editing.name
    setEditing(null)
    await run(async () => {
      const result = await renameQuoteCategory({ source, from, to })
      return `已改名，${result.moved} 条产品跟着改了`
    })
  }

  async function submitMerge(): Promise<void> {
    if (merging === null || merging.to === '') return
    const { from, to } = merging
    setMerging(null)
    await run(async () => {
      const result = await mergeQuoteCategory({ source, from, to })
      return `已把「${from}」合并到「${to}」，${result.moved} 条产品`
    })
  }

  async function submitCreate(): Promise<void> {
    const name = newName.trim()
    if (name === '') return
    setNewName('')
    await run(async () => {
      await createQuoteCategory({ source, name })
      return `已新建分类「${name}」`
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 来源切换。三个来源的分类是各自独立的顺序，所以先选来源再排。 */}
      <div className="mb-3 flex items-center gap-1.5">
        {QUOTE_SOURCES.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={source === value}
            onClick={() => {
              setSource(value)
              setEditing(null)
              setMerging(null)
            }}
            className={
              source === value
                ? 'inline-flex h-8 items-center rounded-[9px] bg-secondary px-3 text-[13px] font-medium'
                : 'inline-flex h-8 items-center rounded-[9px] px-3 text-[13px] text-muted-foreground hover:bg-accent'
            }
          >
            {QUOTE_SOURCE_NAMES[value]}
          </button>
        ))}
        <span className="ml-auto text-[11.5px] text-muted-foreground-weak">
          {rows.length} 个分类 · 上下箭头调顺序
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">
        {error !== null ? (
          <p className="p-4 text-[12.5px] text-destructive">{error}</p>
        ) : items === null ? (
          <p className="p-4 text-[12.5px] text-muted-foreground">读取中…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-[12.5px] text-muted-foreground">
            这个来源还没有分类。在下面新建一个，或先导入产品。
          </p>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                <Th className="w-10">#</Th>
                <Th>分类名称</Th>
                <Th className="w-16 text-right">产品</Th>
                <Th className="w-[132px]">顺序</Th>
                <Th className="w-[168px]">操作</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={row.name} className="align-middle">
                  <Td className="text-muted-foreground-weak tabular-nums">{index + 1}</Td>
                  <Td>
                    {editing?.name === row.name ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          autoFocus
                          value={editing.draft}
                          onChange={(event) =>
                            setEditing({ name: row.name, draft: event.target.value })
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void submitRename()
                            if (event.key === 'Escape') setEditing(null)
                          }}
                          className="h-7 min-w-0 flex-1 rounded-[7px] border border-ring bg-card px-2 text-[12.5px] outline-none"
                          aria-label="分类新名称"
                        />
                        <button
                          type="button"
                          onClick={() => void submitRename()}
                          className="grid size-7 place-items-center rounded-[7px] text-m-teal hover:bg-accent"
                          aria-label="保存名称"
                        >
                          <Check className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditing(null)}
                          className="grid size-7 place-items-center rounded-[7px] text-muted-foreground hover:bg-accent"
                          aria-label="取消改名"
                        >
                          <X className="size-3.5" />
                        </button>
                      </div>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <span className="truncate">{row.name}</span>
                        {!row.persisted && (
                          <span className="shrink-0 rounded border border-border px-1 text-[10.5px] leading-4 text-muted-foreground-weak">
                            未排序
                          </span>
                        )}
                      </span>
                    )}
                  </Td>
                  <Td className="text-right text-muted-foreground tabular-nums">{row.count}</Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                        className="grid size-7 place-items-center rounded-[7px] border border-border text-muted-foreground hover:bg-accent disabled:opacity-40"
                        aria-label={`上移「${row.name}」`}
                      >
                        <ArrowUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={busy || index === rows.length - 1}
                        onClick={() => move(index, 1)}
                        className="grid size-7 place-items-center rounded-[7px] border border-border text-muted-foreground hover:bg-accent disabled:opacity-40"
                        aria-label={`下移「${row.name}」`}
                      >
                        <ArrowDown className="size-3.5" />
                      </button>
                    </div>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setMerging(null)
                          setEditing({ name: row.name, draft: row.name })
                        }}
                        className="inline-flex h-7 items-center gap-1 rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40"
                      >
                        <Pencil className="size-3" />
                        改名
                      </button>
                      <button
                        type="button"
                        disabled={busy || rows.length < 2}
                        onClick={() => {
                          setEditing(null)
                          setMerging({
                            from: row.name,
                            to: rows.find((other) => other.name !== row.name)?.name ?? '',
                          })
                        }}
                        className="inline-flex h-7 items-center rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40"
                      >
                        合并
                      </button>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 合并的目标选择。展开在列表下方而不是行内：行内会被表格的列宽挤成一条。 */}
      {merging !== null && (
        <div className="mt-2 flex items-center gap-2 rounded-xl border border-[color-mix(in_srgb,var(--m-amber)_30%,var(--border))] bg-[color-mix(in_srgb,var(--m-amber)_6%,transparent)] px-3 py-2">
          <span className="text-[12.5px]">
            把「<b className="font-medium">{merging.from}</b>」合并到
          </span>
          <select
            value={merging.to}
            onChange={(event) => setMerging({ from: merging.from, to: event.target.value })}
            className="h-8 rounded-[8px] border border-border bg-card px-2 text-[12.5px]"
            aria-label="合并目标分类"
          >
            {rows
              .filter((row) => row.name !== merging.from)
              .map((row) => (
                <option key={row.name} value={row.name}>
                  {row.name}（{row.count}）
                </option>
              ))}
          </select>
          <span className="text-[11.5px] text-muted-foreground-weak">
            合并后「{merging.from}」这个名字会消失，产品全部改挂到目标分类
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void submitMerge()}
            className="ml-auto inline-flex h-8 items-center rounded-[9px] bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-50"
          >
            {busy ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
            确认合并
          </button>
          <button
            type="button"
            onClick={() => setMerging(null)}
            className="inline-flex h-8 items-center rounded-[9px] border border-border px-2.5 text-[12.5px]"
          >
            取消
          </button>
        </div>
      )}

      <div className="mt-2 flex items-center gap-2">
        <input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void submitCreate()
          }}
          placeholder="新建分类，例如「阳台柜」"
          maxLength={80}
          className="h-8 min-w-0 flex-1 rounded-[9px] border border-border bg-background px-2.5 text-[12.5px] outline-none focus:border-ring focus:bg-card"
          aria-label="新分类名称"
        />
        <button
          type="button"
          disabled={busy || newName.trim() === ''}
          onClick={() => void submitCreate()}
          className="inline-flex h-8 items-center gap-1 rounded-[9px] border border-border bg-card px-3 text-[12.5px] hover:bg-accent disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          新建分类
        </button>
      </div>

      {notice !== null && (
        <p
          role={notice.kind === 'error' ? 'alert' : 'status'}
          className={
            notice.kind === 'error'
              ? 'mt-2 text-[11.5px] text-destructive'
              : 'mt-2 text-[11.5px] text-m-teal'
          }
        >
          {notice.text}
        </p>
      )}
    </div>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`border-b border-border-soft bg-background px-3 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak ${className ?? ''}`}
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
