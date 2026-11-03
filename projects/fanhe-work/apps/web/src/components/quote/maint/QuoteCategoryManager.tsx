import type { QuoteCategoryDto, QuoteSourceDto } from '@fanhe/shared'
import {
  ArrowDown,
  ArrowUp,
  Check,
  GitMerge,
  LoaderCircle,
  Pencil,
  Plus,
  Settings2,
  Trash2,
  X,
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useState } from 'react'

import { ApiError } from '../../../lib/api'
import {
  createQuoteCategory,
  deleteQuoteCategory,
  loadQuoteCategories,
  loadQuoteSources,
  mergeQuoteCategories,
  mergeQuoteCategory,
  renameQuoteCategory,
  reorderQuoteCategories,
} from '../../../lib/quote'

import { QuoteCategoryProducts } from './QuoteCategoryProducts'
import { QuoteSourceManager } from './QuoteSourceManager'

/**
 * 分类维护：主类、改名、单条合并、多选合并、排序、分类内产品合并。
 *
 * ## 为什么合并用行内展开，不再套一层对话框
 *
 * 这一屏本身已经是 Radix Dialog 里的内容。再开一个 Dialog 就是「对话框套对话框」，
 * 层级、Esc、焦点归还三件事都要重新对一遍 —— 而 11-03 那轮灯箱问题正是这么来的
 * （点图片把整个面板关了）。行内展开只多一行 DOM，没有这些边界。
 *
 * ## 两种合并是两件事，入口必须分开
 *
 * - **合并分类**：把一个分类下的产品整体改挂到另一个分类，分类少一个、产品数不变。
 * - **合并产品**：把同一个分类里的几条产品收成一条，分类不变、产品数变少。
 *
 * 放在同一个按钮里，用户没法确认自己点的是哪一种。所以：分类级的合并在勾选后出现在
 * 列表下方，产品级的合并要点「N 条」展开到那个分类里。
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
  const [sources, setSources] = useState<readonly QuoteSourceDto[] | null>(null)
  const [source, setSource] = useState('sale')
  const [items, setItems] = useState<QuoteCategoryDto[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  const [editing, setEditing] = useState<{ name: string; draft: string } | null>(null)
  const [merging, setMerging] = useState<{ from: string; to: string } | null>(null)
  /** 哪一行正处于「确认删除」状态。删除不可逆，所以要两次点击。 */
  const [deleting, setDeleting] = useState<string | null>(null)
  const [newName, setNewName] = useState('')

  /** 分类多选。批量合并就靠它。 */
  const [picked, setPicked] = useState<readonly string[]>([])
  const [mergeTo, setMergeTo] = useState('')
  /** 展开了哪个分类的产品列表（同一时间只展开一个，避免几十个请求一起发）。 */
  const [expanded, setExpanded] = useState<string | null>(null)
  const [managingSources, setManagingSources] = useState(false)

  /**
   * 重取分类与主类清单。
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
      Promise.all([loadQuoteCategories(), loadQuoteSources()])
        .then(([categories, sourceList]) => {
          setItems([...categories.items])
          setSources(sourceList.items)
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

  // 主类被删掉之后，当前选中的那个可能已经不存在了 —— 渲染时退回到第一个。
  // 不用 effect 同步：那样会多一帧「空列表」，而且 `set-state-in-effect` 会拦。
  const activeCode =
    sources !== null && sources.some((row) => row.code === source)
      ? source
      : (sources?.[0]?.code ?? source)

  const rows = (items ?? []).filter((row) => row.source === activeCode)
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
        row.source === activeCode
          ? { ...row, sortOrder: reordered.get(row.name) ?? row.sortOrder }
          : row,
      ),
    )
    void run(async () => {
      await reorderQuoteCategories({ source: activeCode, order })
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
      const result = await renameQuoteCategory({ source: activeCode, from, to })
      return `已改名，${result.moved} 条产品跟着改了`
    })
  }

  async function submitMerge(): Promise<void> {
    if (merging === null || merging.to === '') return
    const { from, to } = merging
    setMerging(null)
    await run(async () => {
      const result = await mergeQuoteCategory({ source: activeCode, from, to })
      return `已把「${from}」合并到「${to}」，${result.moved} 条产品`
    })
  }

  /**
   * 多选合并。
   *
   * 目标名默认是「第一个选中的分类」，这正好覆盖最常见的诉求：把 B、C 并进 A，名字
   * 还用 A。想统一成一个新名字就直接在输入框里改。
   */
  async function submitMergeMany(): Promise<void> {
    const to = mergeTo.trim()
    if (picked.length < 2 || to === '') return
    await run(async () => {
      const result = await mergeQuoteCategories({ source: activeCode, from: picked, to })
      setPicked([])
      setMergeTo('')
      setExpanded(null)
      return `已把 ${result.from.length} 个分类合并为「${result.to}」，共 ${result.moved} 条产品`
    })
  }

  async function submitCreate(): Promise<void> {
    const name = newName.trim()
    if (name === '') return
    setNewName('')
    await run(async () => {
      await createQuoteCategory({ source: activeCode, name })
      return `已新建分类「${name}」`
    })
  }

  /**
   * 删分类。
   *
   * 条数在前端就有（行上那个「N 条」），所以有产品时先说人话，不等一个来回 ——
   * 与主类管理条一个套路：删不掉的按钮**不置灰**，点下去给一句原因，置灰等于不解释。
   * 服务端那道 `has_items` 仍然保留，它挡的是「两个人同时操作」。
   *
   * 产品一条都没删，只少了「这个名字 + 它的位置」，所以不 bump 数据集版本。
   */
  async function submitDelete(name: string, count: number): Promise<void> {
    setDeleting(null)
    if (count > 0) {
      setNotice({
        kind: 'error',
        text: `「${name}」下面还有 ${String(count)} 条产品（含已下架）。先把它们合并到别的分类、或逐条删掉，再来删这个分类`,
      })
      return
    }
    // 这一行消失后，勾选、展开、合并目标里都可能还留着它的名字 —— 不清掉的话，
    // 下面的批量合并条会显示一个已经不存在的分类。
    setPicked((current) => current.filter((value) => value !== name))
    setExpanded((current) => (current === name ? null : current))
    setMergeTo((current) => (current === name ? '' : current))
    await run(async () => {
      await deleteQuoteCategory({ source: activeCode, name })
      return `已删除分类「${name}」`
    })
  }

  function togglePick(name: string): void {
    setPicked((current) => {
      const next = current.includes(name)
        ? current.filter((value) => value !== name)
        : [...current, name]
      // 目标名跟着选中项走：取消掉当前目标时退到下一个，全取消就清空。
      setMergeTo((previous) => (next.includes(previous) ? previous : (next[0] ?? '')))
      return next
    })
  }

  function togglePickAll(): void {
    if (picked.length === rows.length) {
      setPicked([])
      setMergeTo('')
      return
    }
    const all = rows.map((row) => row.name)
    setPicked(all)
    setMergeTo((previous) => (all.includes(previous) ? previous : (all[0] ?? '')))
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 主类页签。来源的先后从服务端来，新建的主类排在最后。 */}
      <div className="mb-2 flex items-center gap-1.5">
        {(sources ?? []).map((row) => (
          <button
            key={row.code}
            type="button"
            aria-pressed={activeCode === row.code}
            onClick={() => {
              setSource(row.code)
              setEditing(null)
              setMerging(null)
              setPicked([])
              setMergeTo('')
              setExpanded(null)
            }}
            className={
              activeCode === row.code
                ? 'inline-flex h-8 items-center gap-1.5 rounded-[9px] bg-secondary px-3 text-[13px] font-medium'
                : 'inline-flex h-8 items-center gap-1.5 rounded-[9px] px-3 text-[13px] text-muted-foreground hover:bg-accent'
            }
          >
            {row.name}
            <span className="text-[11px] text-muted-foreground-weak tabular-nums">
              {row.itemCount}
            </span>
          </button>
        ))}
        {sources === null && <span className="text-[12px] text-muted-foreground">读取主类…</span>}
        <button
          type="button"
          onClick={() => setManagingSources((value) => !value)}
          className={
            managingSources
              ? 'ml-auto inline-flex h-8 items-center gap-1 rounded-[9px] bg-secondary px-3 text-[12.5px]'
              : 'ml-auto inline-flex h-8 items-center gap-1 rounded-[9px] border border-border px-3 text-[12.5px] text-muted-foreground hover:bg-accent'
          }
        >
          <Settings2 className="size-3.5" />
          管理主类
        </button>
      </div>

      {managingSources && (
        <QuoteSourceManager
          sources={sources ?? []}
          activeCode={activeCode}
          onSelect={(code) => {
            setSource(code)
            setPicked([])
            setMergeTo('')
            setExpanded(null)
          }}
          onResult={(kind, text) => {
            setNotice({ kind, text })
            if (kind === 'ok') {
              void refresh()
              onChanged()
            }
          }}
          onClose={() => setManagingSources(false)}
        />
      )}

      <div className="mb-1.5 flex items-center gap-2 text-[11.5px] text-muted-foreground-weak">
        <span>{rows.length} 个分类 · 上下箭头调顺序 · 勾选多个可一次合并</span>
        {rows.length > 0 && (
          <button
            type="button"
            onClick={togglePickAll}
            className="ml-auto inline-flex h-6 items-center rounded-[6px] px-1.5 text-[11px] hover:bg-accent"
          >
            {picked.length === rows.length ? '取消全选' : '全选'}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">
        {error !== null ? (
          <p className="p-4 text-[12.5px] text-destructive">{error}</p>
        ) : items === null ? (
          <p className="p-4 text-[12.5px] text-muted-foreground">读取中…</p>
        ) : rows.length === 0 ? (
          <p className="p-4 text-[12.5px] text-muted-foreground">
            这个主类还没有分类。在下面新建一个，或先导入产品。
          </p>
        ) : (
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                <Th className="w-8" />
                <Th className="w-8">#</Th>
                <Th>分类名称</Th>
                <Th className="w-16 text-right">产品</Th>
                <Th className="w-[132px]">顺序</Th>
                <Th className="w-[236px]">操作</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                // Fragment 必须带 key：key 加在内层 `<tr>` 上不算数，React 会为每一行
                // 打印一条 missing key 警告，而开发时那条警告淹没在控制台里没人看。
                <Fragment key={row.name}>
                  <tr className="align-middle">
                    <Td>
                      <input
                        type="checkbox"
                        checked={picked.includes(row.name)}
                        onChange={() => togglePick(row.name)}
                        aria-label={`选择分类「${row.name}」`}
                        className="size-3.5 accent-[var(--primary)]"
                      />
                    </Td>
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
                    <Td className="text-right">
                      {/* 产品数是可以点的：点开就是「在这个分类里合并产品」。 */}
                      <button
                        type="button"
                        onClick={() => setExpanded(expanded === row.name ? null : row.name)}
                        className="inline-flex h-6 items-center rounded-[6px] px-1.5 text-muted-foreground tabular-nums hover:bg-accent hover:text-foreground"
                        aria-expanded={expanded === row.name}
                      >
                        {row.count} 条
                      </button>
                    </Td>
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
                            setDeleting(null)
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
                            setDeleting(null)
                            setMerging({
                              from: row.name,
                              to: rows.find((other) => other.name !== row.name)?.name ?? '',
                            })
                          }}
                          className="inline-flex h-7 items-center gap-1 rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40"
                        >
                          <GitMerge className="size-3" />
                          合并
                        </button>
                        {/* 删除不置灰：有产品时点下去由下面那句话解释为什么删不掉。
                            第一次点击只把按钮换成「确认删除」，第二次才发请求。 */}
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            if (deleting !== row.name) {
                              setEditing(null)
                              setMerging(null)
                              setDeleting(row.name)
                              return
                            }
                            void submitDelete(row.name, row.count)
                          }}
                          className={
                            deleting === row.name
                              ? 'inline-flex h-7 items-center gap-1 rounded-[7px] bg-destructive px-2 text-[11.5px] text-destructive-foreground disabled:opacity-40'
                              : 'inline-flex h-7 items-center gap-1 rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent disabled:opacity-40'
                          }
                          aria-label={
                            deleting === row.name
                              ? `确认删除分类「${row.name}」`
                              : `删除分类「${row.name}」`
                          }
                        >
                          {busy && deleting === row.name ? (
                            <LoaderCircle className="size-3 animate-spin" />
                          ) : (
                            <Trash2 className="size-3" />
                          )}
                          {deleting === row.name ? '确认删除' : '删除'}
                        </button>
                      </div>
                    </Td>
                  </tr>
                  {expanded === row.name && (
                    <tr>
                      <td colSpan={6} className="p-0">
                        <QuoteCategoryProducts
                          source={activeCode}
                          category={row.name}
                          onResult={(kind, text) => setNotice({ kind, text })}
                          onChanged={() => {
                            void refresh()
                            onChanged()
                          }}
                          onClose={() => setExpanded(null)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* 分类级合并的目标选择。展开在列表下方而不是行内：行内会被表格的列宽挤成一条。 */}
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

      {/* 多选合并。勾不到两个时整条不出现 —— 一个永远点不了的按钮只会让人问为什么。 */}
      {picked.length >= 2 && (
        <div className="mt-2 rounded-xl border border-[color-mix(in_srgb,var(--m-purple)_30%,var(--border))] bg-[color-mix(in_srgb,var(--m-purple)_6%,transparent)] px-3 py-2">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px]">
              把选中的 <b className="font-medium">{picked.length}</b> 个分类合并为
            </span>
            <input
              value={mergeTo}
              onChange={(event) => setMergeTo(event.target.value)}
              maxLength={80}
              placeholder="目标分类名，可改成新名字"
              aria-label="批量合并的目标分类名"
              className="h-8 min-w-0 flex-1 rounded-[8px] border border-border bg-card px-2 text-[12.5px] outline-none focus:border-ring"
            />
            <button
              type="button"
              disabled={busy || mergeTo.trim() === ''}
              onClick={() => void submitMergeMany()}
              className="inline-flex h-8 items-center gap-1 rounded-[9px] bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-50"
            >
              {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              合并所选
            </button>
            <button
              type="button"
              onClick={() => {
                setPicked([])
                setMergeTo('')
              }}
              className="inline-flex h-8 items-center rounded-[9px] border border-border px-2.5 text-[12.5px]"
            >
              取消
            </button>
          </div>
          <p className="mt-1 text-[11px] text-muted-foreground-weak">
            已选：{picked.join('、')}。合并后这 {picked.length} 个分类的产品全部改挂到「
            {mergeTo.trim() === '' ? '目标' : mergeTo.trim()}」，其余名字消失；
            产品一条都不会删，名字也不会被改。
          </p>
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

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`border-b border-border-soft bg-background px-3 py-2 text-left text-[11.5px] font-medium text-muted-foreground-weak ${className ?? ''}`}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <td className={`border-b border-border-soft px-3 py-1.5 ${className ?? ''}`}>{children}</td>
  )
}
