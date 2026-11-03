import {
  type QuoteImportPreviewResponse,
  type QuoteImportPreviewRow,
  type QuoteSource,
  type QuoteSourceDto,
} from '@fanhe/shared'
import { CheckCircle2, FileUp, LoaderCircle, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { ApiError } from '../../../lib/api'
import { applyQuoteImport, loadQuoteSources, previewQuoteImport } from '../../../lib/quote'

/**
 * 批量导入：选文件 → 识别 → 逐条核对 → 确认导入。
 *
 * ## 为什么识别结果必须可编辑
 *
 * 识别一定会错，而且错得很安静：分类是合并单元格时只有第一行带值、备注里带逗号
 * 会让 CSV 整行右移、PDF 抽出来的列顺序靠猜。这些错**都不会让导入失败**，只会
 * 让库里多出一批名字对、分类错的产品 —— 而查价的人按分类筛选，从此就找不到它们。
 *
 * 所以中间这一步不是「确认对话框」，是一张**可编辑的草稿表**：能改、能删、能看见
 * 每行的来源行号。
 *
 * ## 一次只导一个来源
 *
 * 业务键里带 `source`，一份文件混两个来源会让同一行算成两个键。文件里没有来源这
 * 一列（台账的三种来源是三份不同的表），所以由人在导入前指定。
 *
 * ## 导入与识别是两个接口
 *
 * 识别接口一行都不写库。这条边界让「选错文件」的代价只是多点一次，而不是往库里
 * 灌一批错行。
 */
export function QuoteImportPanel({ onChanged }: { onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [preview, setPreview] = useState<QuoteImportPreviewResponse | null>(null)
  const [rows, setRows] = useState<QuoteImportPreviewRow[]>([])
  const [source, setSource] = useState<QuoteSource>('sale')
  const [sources, setSources] = useState<readonly QuoteSourceDto[]>([])
  const [phase, setPhase] = useState<'idle' | 'parsing' | 'confirming' | 'applying'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{
    added: number
    changed: number
    unchanged: number
    total: number
  } | null>(null)

  // 来源下拉必须是活的：新建一个主类之后要能往它下面导产品。
  useEffect(() => {
    void loadQuoteSources()
      .then((result) => setSources(result.items))
      .catch(() => setSources([]))
  }, [])

  async function pick(file: File): Promise<void> {
    setPhase('parsing')
    setError(null)
    setDone(null)
    setPreview(null)
    setRows([])
    try {
      const result = await previewQuoteImport(file)
      setPreview(result)
      setRows([...result.rows])
      if (result.suggestedSource !== null) setSource(result.suggestedSource)
      setPhase('confirming')
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '识别失败，请换一份文件试试')
      setPhase('idle')
    }
  }

  function patchRow(index: number, patch: Partial<QuoteImportPreviewRow>): void {
    setRows((current) =>
      current.map((row, position) => (position === index ? { ...row, ...patch } : row)),
    )
  }

  async function submit(): Promise<void> {
    if (preview === null || rows.length === 0) return
    setPhase('applying')
    setError(null)
    try {
      const result = await applyQuoteImport({
        fileName: preview.fileName,
        source,
        rows,
      })
      setDone(result)
      setPreview(null)
      setRows([])
      setPhase('idle')
      onChanged()
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : '导入失败，请重试')
      setPhase('confirming')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 选文件。拖拽与点击都指向同一个 input —— 不写第二套逻辑。 */}
      <div
        onDragOver={(event) => {
          event.preventDefault()
        }}
        onDrop={(event) => {
          event.preventDefault()
          const file = event.dataTransfer.files[0]
          if (file !== undefined) void pick(file)
        }}
        className="mb-3 flex items-center gap-3 rounded-xl border border-dashed border-border bg-background px-4 py-3"
      >
        <FileUp className="size-5 shrink-0 text-muted-foreground-weak" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium">选择台账文件</div>
          <div className="text-[11.5px] text-muted-foreground-weak">
            支持 .xlsx / .csv / .pdf。拖进来或点右边按钮。识别之后先看一遍再导入。
          </div>
        </div>
        <button
          type="button"
          disabled={phase === 'parsing' || phase === 'applying'}
          onClick={() => fileRef.current?.click()}
          className="ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-[9px] border border-border bg-card px-3 text-[12.5px] hover:bg-accent disabled:opacity-50"
        >
          {phase === 'parsing' ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {phase === 'parsing' ? '识别中…' : '选择文件'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv,.pdf,text/csv,application/pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) void pick(file)
          }}
        />
      </div>

      {error !== null && (
        <p role="alert" className="mb-2 text-[12px] text-destructive">
          {error}
        </p>
      )}

      {done !== null && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--m-teal)_30%,var(--border))] bg-[color-mix(in_srgb,var(--m-teal)_7%,transparent)] px-3 py-2 text-[12px]">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-m-teal" />
          <span>
            已导入 {done.total} 行：新增 {done.added}、更新 {done.changed}、未变 {done.unchanged}
            。报价查价那边刷新即可看到。
          </span>
        </div>
      )}

      {preview === null ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">
          <p className="p-4 text-[12.5px] leading-[1.8] text-muted-foreground">
            识别结果会出现在这里。三步：
            <br />
            1. 选文件 → 系统按内置规则读出分类、名称、型号、规格、单价；
            <br />
            2. 逐条核对，改掉认错的行、删掉不该导的行；
            <br />
            3. 选一个来源，确认导入。同一份文件重复导入不会产生重复产品。
          </p>
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
            <span className="text-[12.5px] font-medium">{preview.fileName}</span>
            <span className="rounded border border-border px-1.5 text-[11px] leading-[18px] text-muted-foreground-weak">
              {preview.format.toUpperCase()}
            </span>
            <span className="text-[11.5px] text-muted-foreground-weak">
              识别到 {preview.total} 行
              {preview.total > rows.length ? `，这里显示 ${rows.length} 行` : ''}
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-[11.5px]">
              导入到
              <select
                value={source}
                onChange={(event) => setSource(event.target.value as QuoteSource)}
                className="h-7 rounded-[7px] border border-border bg-card px-1.5 text-[12px]"
                aria-label="导入到哪个来源"
              >
                {sources.map((row) => (
                  <option key={row.code} value={row.code}>
                    {row.name}
                  </option>
                ))}
              </select>
            </span>
          </div>

          {preview.detectedColumns.length > 0 && (
            <p className="mb-2 text-[11.5px] leading-[1.7] text-muted-foreground-weak">
              识别到的列：{preview.detectedColumns.join(' · ')}
            </p>
          )}

          {preview.warnings.length > 0 && (
            <ul className="mb-2 list-disc rounded-xl border border-[color-mix(in_srgb,var(--m-amber)_28%,var(--border))] bg-[color-mix(in_srgb,var(--m-amber)_6%,transparent)] py-1.5 pr-3 pl-6 text-[11.5px] leading-[1.7] text-m-amber">
              {preview.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}

          <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr>
                  <Th className="w-10">行</Th>
                  <Th className="w-[124px]">分类</Th>
                  <Th>名称</Th>
                  <Th className="w-[96px]">型号</Th>
                  <Th className="w-[96px]">规格</Th>
                  <Th className="w-[110px]">价格</Th>
                  <Th className="w-12">单位</Th>
                  <Th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr
                    key={`${row.sourceLine}-${index}`}
                    className={
                      row.warnings.length > 0
                        ? 'bg-[color-mix(in_srgb,var(--m-amber)_5%,transparent)]'
                        : ''
                    }
                  >
                    <Td className="text-[11px] text-muted-foreground-weak tabular-nums">
                      {row.sourceLine}
                    </Td>
                    <Td>
                      <Cell
                        value={row.category}
                        onChange={(value) => patchRow(index, { category: value })}
                        aria-label={`第 ${row.sourceLine} 行分类`}
                      />
                    </Td>
                    <Td>
                      <Cell
                        value={row.name}
                        onChange={(value) => patchRow(index, { name: value })}
                        aria-label={`第 ${row.sourceLine} 行名称`}
                      />
                      {row.warnings.length > 0 && (
                        <div className="mt-0.5 text-[10.5px] text-m-amber">
                          {row.warnings.join(' · ')}
                        </div>
                      )}
                    </Td>
                    <Td>
                      <Cell
                        value={row.model}
                        onChange={(value) => patchRow(index, { model: value })}
                        aria-label={`第 ${row.sourceLine} 行型号`}
                      />
                    </Td>
                    <Td>
                      <Cell
                        value={row.spec}
                        onChange={(value) => patchRow(index, { spec: value })}
                        aria-label={`第 ${row.sourceLine} 行规格`}
                      />
                    </Td>
                    <Td>
                      <Cell
                        value={row.priceText}
                        onChange={(value) => patchRow(index, { priceText: value })}
                        aria-label={`第 ${row.sourceLine} 行价格`}
                      />
                    </Td>
                    <Td>
                      <Cell
                        value={row.unit}
                        onChange={(value) => patchRow(index, { unit: value })}
                        aria-label={`第 ${row.sourceLine} 行单位`}
                      />
                    </Td>
                    <Td>
                      <button
                        type="button"
                        onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                        className="grid size-6 place-items-center rounded-[6px] text-muted-foreground-weak hover:bg-accent hover:text-destructive"
                        aria-label={`删除第 ${row.sourceLine} 行`}
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11.5px] text-muted-foreground-weak">
              将导入 {rows.length} 行到「
              {sources.find((row) => row.code === source)?.name ?? source}」
            </span>
            <button
              type="button"
              disabled={phase === 'applying' || rows.length === 0}
              onClick={() => void submit()}
              className="ml-auto inline-flex h-8 items-center gap-1 rounded-[9px] bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-50"
            >
              {phase === 'applying' ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
              确认导入
            </button>
            <button
              type="button"
              onClick={() => {
                setPreview(null)
                setRows([])
                setError(null)
              }}
              className="inline-flex h-8 items-center rounded-[9px] border border-border px-3 text-[12.5px]"
            >
              放弃
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function Cell({
  value,
  onChange,
  ...rest
}: {
  value: string
  onChange: (value: string) => void
  'aria-label': string
}) {
  return (
    <input
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="h-6 w-full min-w-0 rounded-[5px] border border-transparent bg-transparent px-1 text-[12px] outline-none hover:border-border focus:border-ring focus:bg-card"
      {...rest}
    />
  )
}

function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th
      className={`border-b border-border-soft bg-background px-2 py-1.5 text-left text-[11px] font-medium text-muted-foreground-weak ${className ?? ''}`}
    >
      {children}
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`border-b border-border-soft px-2 py-1 align-top ${className ?? ''}`}>
      {children}
    </td>
  )
}
