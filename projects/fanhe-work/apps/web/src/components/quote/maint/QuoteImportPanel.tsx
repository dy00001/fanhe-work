import {
  QUOTE_LIMITS,
  type QuoteImportPreviewRow,
  type QuoteSource,
  type QuoteSourceDto,
} from '@fanhe/shared'
import { CheckCircle2, FileUp, LoaderCircle, RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { loadQuoteSources } from '../../../lib/quote'
import {
  elapsedSeconds,
  formatMegabytes,
  importProgressLabel,
  uploadPercent,
} from '../../../lib/quote-import-display'
import {
  cancelImportUpload,
  discardImportTask,
  getImportTaskSnapshot,
  patchImportRow,
  removeImportRow,
  setImportSource,
  startImportUpload,
  submitImportTask,
  subscribeImportTask,
} from '../../../lib/quote-import-task'

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
 * ## 状态不在这棵树里
 *
 * 这一屏的状态全在 `lib/quote-import-task.ts` 的模块级单例里，组件只是观察者。
 * 理由很具体：2026-11-03 用户在上传途中切到别的页面，回来时进度、结果、改过的
 * 行全没了 —— 那些状态原来挂在 `useState` 上，组件一卸载就跟着走。**卸载不等于
 * 取消**，一份 12MB 的台账要传几十秒，中途去看点别的属于正常操作。
 *
 * ## 两段进度
 *
 * 「上传」有真实百分比（XHR 的 `upload.onprogress` 给的是已发字节），「识别」没有 ——
 * 那一段在服务端，一次请求一个结果，中间没有可观测的刻度。所以第二段画不确定态
 * 加已用秒数，而不是编一个百分比出来。
 */
export function QuoteImportPanel({ onChanged }: { onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement | null>(null)
  const task = useSyncExternalStore(
    subscribeImportTask,
    getImportTaskSnapshot,
    getImportTaskSnapshot,
  )
  const [sources, setSources] = useState<readonly QuoteSourceDto[]>([])
  /** 确认页的「已用秒数」需要一个心跳；只在跑着的阶段才开。 */
  const [now, setNow] = useState(() => Date.now())
  /** 上次通知外层刷新的 doneToken。跨挂载保留，所以用 ref 而不是 state。 */
  const seenDoneToken = useRef(task.doneToken)

  // 来源下拉必须是活的：新建一个主类之后要能往它下面导产品。
  useEffect(() => {
    void loadQuoteSources()
      .then((result) => setSources(result.items))
      .catch(() => setSources([]))
  }, [])

  // 导入成功时通知外层重取列表。**放在 effect 里而不是 submit 的 then 里**：
  // 完成时这个组件可能根本没挂载（人已经切走了），回到这一屏时才补上刷新。
  useEffect(() => {
    if (task.doneToken === seenDoneToken.current) return
    seenDoneToken.current = task.doneToken
    onChanged()
  }, [task.doneToken, onChanged])

  /*
   * 三个「跑着」的阶段收窄成一个联合类型。
   *
   * `busy` 这个布尔值用在别处（按钮禁用、心跳），但传给进度条时必须带上联合类型：
   * 进度条只在这三段出现，`idle` / `confirming` 下面没有它的渲染路径。
   */
  const busyPhase =
    task.phase === 'uploading' || task.phase === 'analyzing' || task.phase === 'applying'
      ? task.phase
      : null
  const busy = busyPhase !== null
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [busy])

  const percent = uploadPercent(task)
  const seconds = elapsedSeconds(task, now)

  function pick(file: File): void {
    void startImportUpload(file)
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
          if (file !== undefined) pick(file)
        }}
        className="mb-3 flex items-center gap-3 rounded-xl border border-dashed border-border bg-background px-4 py-3"
      >
        <FileUp className="size-5 shrink-0 text-muted-foreground-weak" />
        <div className="min-w-0">
          <div className="text-[13px] font-medium">选择台账文件</div>
          <div className="text-[11.5px] text-muted-foreground-weak">
            支持 .xlsx / .csv / .pdf，单个文件不超过{' '}
            {Math.round(QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX / 1024 / 1024)}MB。拖进来或点右边按钮。
          </div>
        </div>
        <button
          type="button"
          disabled={task.phase === 'applying'}
          onClick={() => fileRef.current?.click()}
          className="ml-auto inline-flex h-8 shrink-0 items-center gap-1 rounded-[9px] border border-border bg-card px-3 text-[12.5px] hover:bg-accent disabled:opacity-50"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
          {task.phase === 'uploading' ? '上传中…' : '选择文件'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xlsx,.csv,.pdf,text/csv,application/pdf"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file !== undefined) pick(file)
          }}
        />
      </div>

      {busyPhase !== null && (
        <UploadProgress
          phase={busyPhase}
          fileName={task.fileName}
          percent={percent}
          uploadedBytes={task.uploadedBytes}
          fileBytes={task.fileBytes}
          seconds={seconds}
          // 写入阶段不能取消：那一步已经在改库，「取消」只会让人以为没写进去。
          onCancel={busyPhase === 'applying' ? null : cancelImportUpload}
        />
      )}

      {task.error !== null && (
        <p role="alert" className="mb-2 text-[12px] text-destructive">
          {task.error}
        </p>
      )}

      {task.canceled && (
        <p className="mb-2 flex items-center gap-1.5 text-[12px] text-muted-foreground-weak">
          <RotateCcw className="size-3.5" />
          已取消这次上传。文件没有传到服务器，也没有任何东西写进库里。
        </p>
      )}

      {task.done !== null && (
        <div className="mb-2 flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--m-teal)_30%,var(--border))] bg-[color-mix(in_srgb,var(--m-teal)_7%,transparent)] px-3 py-2 text-[12px]">
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-m-teal" />
          <span>
            已导入 {task.done.total} 行：新增 {task.done.added}、更新 {task.done.changed}、未变{' '}
            {task.done.unchanged}。报价查价那边刷新即可看到。
          </span>
        </div>
      )}

      {task.preview === null ? (
        <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border">
          <p className="p-4 text-[12.5px] leading-[1.8] text-muted-foreground">
            识别结果会出现在这里。三步：
            <br />
            1. 选文件 → 系统按内置规则读出分类、名称、型号、规格、单价；
            <br />
            2. 逐条核对，改掉认错的行、删掉不该导的行；
            <br />
            3. 选一个来源，确认导入。同一份文件重复导入不会产生重复产品。
            <br />
            <span className="text-muted-foreground-weak">
              上传与识别期间可以先去别的页面，任务在后台继续，回到这一屏还能看到进度与结果。
            </span>
          </p>
        </div>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-background px-3 py-2">
            <span className="text-[12.5px] font-medium">{task.preview.fileName}</span>
            <span className="rounded border border-border px-1.5 text-[11px] leading-[18px] text-muted-foreground-weak">
              {task.preview.format.toUpperCase()}
            </span>
            <span className="text-[11.5px] text-muted-foreground-weak">
              识别到 {task.preview.total} 行
              {task.preview.total > task.rows.length ? `，这里显示 ${task.rows.length} 行` : ''}
            </span>
            <span className="ml-auto flex items-center gap-1.5 text-[11.5px]">
              导入到
              <select
                value={task.source}
                onChange={(event) => setImportSource(event.target.value as QuoteSource)}
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

          {task.preview.detectedColumns.length > 0 && (
            <p className="mb-2 text-[11.5px] leading-[1.7] text-muted-foreground-weak">
              识别到的列：{task.preview.detectedColumns.join(' · ')}
            </p>
          )}

          {task.preview.warnings.length > 0 && (
            <ul className="mb-2 list-disc rounded-xl border border-[color-mix(in_srgb,var(--m-amber)_28%,var(--border))] bg-[color-mix(in_srgb,var(--m-amber)_6%,transparent)] py-1.5 pr-3 pl-6 text-[11.5px] leading-[1.7] text-m-amber">
              {task.preview.warnings.map((warning) => (
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
                {task.rows.map((row, index) => (
                  <DraftRow key={`${row.sourceLine}-${index}`} row={row} index={index} />
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-2 flex items-center gap-2">
            <span className="text-[11.5px] text-muted-foreground-weak">
              将导入 {task.rows.length} 行到「
              {sources.find((row) => row.code === task.source)?.name ?? task.source}」
            </span>
            <button
              type="button"
              disabled={task.phase === 'applying' || task.rows.length === 0}
              onClick={() => void submitImportTask()}
              className="ml-auto inline-flex h-8 items-center gap-1 rounded-[9px] bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-50"
            >
              {task.phase === 'applying' ? (
                <LoaderCircle className="size-3.5 animate-spin" />
              ) : null}
              {task.phase === 'applying' ? '写入中…' : '确认导入'}
            </button>
            <button
              type="button"
              onClick={discardImportTask}
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

/**
 * 上传 / 识别两段的进度。
 *
 * 第一段有真实百分比，第二段只能是「不确定」+ 已用秒数：识别在服务端一次完成，
 * 中间没有可观测的刻度。这里宁可不画，也不画一个匀速爬到 99% 再卡住的假进度。
 */
function UploadProgress({
  phase,
  fileName,
  percent,
  uploadedBytes,
  fileBytes,
  seconds,
  onCancel,
}: {
  phase: 'uploading' | 'analyzing' | 'applying'
  fileName: string | null
  percent: number | null
  uploadedBytes: number
  fileBytes: number
  seconds: number
  onCancel: (() => void) | null
}) {
  const label = importProgressLabel(phase, percent, seconds)

  return (
    <div className="mb-2 rounded-xl border border-border bg-background px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="min-w-0 truncate text-[12px]">{fileName ?? '文件'}</span>
        <span className="shrink-0 text-[11.5px] text-muted-foreground-weak">{label}</span>
        {onCancel !== null && (
          <button
            type="button"
            onClick={onCancel}
            className="ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] border border-border px-2 text-[11.5px] text-muted-foreground hover:bg-accent"
          >
            <X className="size-3" />
            取消
          </button>
        )}
      </div>

      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-accent">
        {phase === 'uploading' && percent !== null ? (
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-200"
            style={{ width: `${String(percent)}%` }}
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="上传进度"
          />
        ) : (
          <div
            className="h-full w-full animate-pulse rounded-full bg-primary opacity-60"
            role="progressbar"
            aria-label={phase === 'uploading' ? '上传进度' : '识别进度'}
          />
        )}
      </div>

      {phase === 'uploading' && (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground-weak tabular-nums">
          <span>
            {formatMegabytes(uploadedBytes)} / {formatMegabytes(fileBytes)}
          </span>
          <span className="ml-auto">可以切到别的页面，传完会自动接着识别</span>
        </div>
      )}
    </div>
  )
}

/** 草稿表的一行。抽出来只是为了让上面的主渲染少一层缩进。 */
function DraftRow({ row, index }: { row: QuoteImportPreviewRow; index: number }) {
  return (
    <tr
      className={
        row.warnings.length > 0 ? 'bg-[color-mix(in_srgb,var(--m-amber)_5%,transparent)]' : ''
      }
    >
      <Td className="text-[11px] text-muted-foreground-weak tabular-nums">{row.sourceLine}</Td>
      <Td>
        <Cell
          value={row.category}
          onChange={(value) => patchImportRow(index, { category: value })}
          aria-label={`第 ${String(row.sourceLine)} 行分类`}
        />
      </Td>
      <Td>
        <Cell
          value={row.name}
          onChange={(value) => patchImportRow(index, { name: value })}
          aria-label={`第 ${String(row.sourceLine)} 行名称`}
        />
        {row.warnings.length > 0 && (
          <div className="mt-0.5 text-[10.5px] text-m-amber">{row.warnings.join(' · ')}</div>
        )}
      </Td>
      <Td>
        <Cell
          value={row.model}
          onChange={(value) => patchImportRow(index, { model: value })}
          aria-label={`第 ${String(row.sourceLine)} 行型号`}
        />
      </Td>
      <Td>
        <Cell
          value={row.spec}
          onChange={(value) => patchImportRow(index, { spec: value })}
          aria-label={`第 ${String(row.sourceLine)} 行规格`}
        />
      </Td>
      <Td>
        <Cell
          value={row.priceText}
          onChange={(value) => patchImportRow(index, { priceText: value })}
          aria-label={`第 ${String(row.sourceLine)} 行价格`}
        />
      </Td>
      <Td>
        <Cell
          value={row.unit}
          onChange={(value) => patchImportRow(index, { unit: value })}
          aria-label={`第 ${String(row.sourceLine)} 行单位`}
        />
      </Td>
      <Td>
        <button
          type="button"
          onClick={() => removeImportRow(index)}
          className="grid size-6 place-items-center rounded-[6px] text-muted-foreground-weak hover:bg-accent hover:text-destructive"
          aria-label={`删除第 ${String(row.sourceLine)} 行`}
        >
          <Trash2 className="size-3" />
        </button>
      </Td>
    </tr>
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
