import type { QuoteImportPreviewResponse, QuoteImportPreviewRow, QuoteSource } from '@fanhe/shared'

import { ApiError } from './api'
import { applyQuoteImport, getQuoteUnlockToken } from './quote'
import { validateImportFile, type QuoteImportPhase } from './quote-import-display'
import { uploadQuoteImportFile, type UploadHandle } from './quote-import-upload'
import { withAccessToken } from './session'

/**
 * 批量导入的**任务状态**，放在模块级而不是组件里。
 *
 * ## 为什么必须挪出组件
 *
 * 2026-11-03 用户报「上传过程中切到别的项目，上传直接失败；切回来什么都没有」。
 * 根因就是这一屏的状态原来全在 `QuoteImportPanel` 的 `useState` 里：弹窗一关
 * （它不是全屏页，点遮罩、按 Esc 都会关）、路由一走，组件卸载 → 状态清空 →
 * 请求还在飞，但结果回来时已经没有东西接收它。
 *
 * 卸载不该等于「取消」。上传一份 12MB 的台账要几十秒，这期间人去别的页面看一眼
 * 是正常行为，而不是要放弃这次导入。所以任务状态存在模块级：组件只是一个观察者，
 * 挂载时把当前状态画出来，卸载时什么都不发生。
 *
 * ## 为什么用 `useSyncExternalStore` 而不是 Context
 *
 * Context 需要一个 Provider，而 Provider 只能挂在组件树里 —— 树一旦没了，值也就
 * 没了，等于换了个地方犯同一个错。模块级单例 + `useSyncExternalStore` 是 React
 * 官方给「外部可变源」的接口，重挂载时能直接读到最新快照。
 *
 * ## 并发保护用 epoch
 *
 * 连选两份文件、上传途中取消、识别回来时人已经换了文件 —— 这些都会让「回来的
 * 结果」与「当前的意图」不匹配。每次开始新任务把 epoch 加一，回调里对不上就整条
 * 丢弃。少了这一步，最常见的症状是：先选大文件、嫌慢又选了个小的，最后界面上
 * 显示的是大文件的结果。
 */

export type QuoteImportDone = {
  added: number
  changed: number
  unchanged: number
  total: number
}

export type QuoteImportState = {
  phase: QuoteImportPhase
  /** 正在处理的文件名。确认页与进度条都用它。 */
  fileName: string | null
  /** 文件总字节（来自 XHR 的 `total`，拿不到时退回 `File.size`）。 */
  fileBytes: number
  /** 已上传字节。`uploadPercent` 由它算出来。 */
  uploadedBytes: number
  /** 当前阶段的开始时刻。界面用它算「已用 N 秒」。 */
  phaseStartedAt: number | null
  preview: QuoteImportPreviewResponse | null
  rows: readonly QuoteImportPreviewRow[]
  source: QuoteSource
  error: string | null
  /** 用户主动取消。与失败分开：取消不该是一条红字。 */
  canceled: boolean
  done: QuoteImportDone | null
  /**
   * 每成功导入一次自增。
   *
   * 面板可能在上传途中被关掉再打开，甚至导入完成时它根本没挂载 —— 外层列表要不要
   * 刷新不能只靠「组件里那个 await 回来了」。面板盯着这个数，一旦比它见过的更大
   * 就通知外层重取。
   */
  doneToken: number
}

const EMPTY: QuoteImportState = {
  phase: 'idle',
  fileName: null,
  fileBytes: 0,
  uploadedBytes: 0,
  phaseStartedAt: null,
  preview: null,
  rows: [],
  source: 'sale',
  error: null,
  canceled: false,
  done: null,
  doneToken: 0,
}

let state: QuoteImportState = EMPTY
const listeners = new Set<() => void>()

/** 当前任务代号。任何回调先与它比对，对不上就丢弃。 */
let epoch = 0
let inFlight: UploadHandle | null = null

function publish(next: QuoteImportState): void {
  state = next
  for (const listener of listeners) listener()
}

function patch(changes: Partial<QuoteImportState>): void {
  publish({ ...state, ...changes })
}

export function subscribeImportTask(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 必须返回同一个引用，直到状态真的变了 —— `useSyncExternalStore` 靠它判等。 */
export function getImportTaskSnapshot(): QuoteImportState {
  return state
}

function describe(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback
}

/**
 * 开始一次「上传 + 识别」。
 *
 * 校验不通过时**一个字节都不发**，直接把提示写在界面上。校验通过之后：上传阶段
 * 用手上的字节数画百分比，`loaded === total` 时切到「识别中」—— 那一刻文件已经
 * 全部交出去，剩下的是服务端在读它。
 */
export async function startImportUpload(file: File): Promise<void> {
  const rejection = validateImportFile(file)
  if (rejection !== null) {
    patch({ phase: 'idle', error: rejection, canceled: false, preview: null, rows: [], done: null })
    return
  }

  // 上一份还在传就先掐掉：两个上传同时在跑时，先回来的那个未必是用户最后选的那个。
  if (inFlight !== null) {
    inFlight.cancel()
    inFlight = null
  }
  epoch += 1
  const mine = epoch

  patch({
    phase: 'uploading',
    fileName: file.name,
    fileBytes: file.size,
    uploadedBytes: 0,
    phaseStartedAt: Date.now(),
    preview: null,
    rows: [],
    error: null,
    canceled: false,
    done: null,
  })

  /*
   * 令牌在一次上传里要「现取」，不能提前拿一次存着：上传可能跑几十秒，而访问令牌
   * 的有效期比这更短。`withAccessToken` 会在 401 时刷新并**重新调用**这段回调，
   * 也就是重新发一份文件 —— 因此 handle 必须建在回调内部，不能建在外面。
   */
  try {
    const preview = await withAccessToken(async (accessToken) => {
      const handle: UploadHandle = uploadQuoteImportFile({
        file,
        accessToken,
        unlockToken: getQuoteUnlockToken(),
        onProgress: (progress) => {
          if (epoch !== mine) return
          const total = progress.total > 0 ? progress.total : file.size
          if (total > 0 && progress.loaded >= total) {
            // 文件已经全部交出去，剩下的是服务端在读它。界面从这一刻起换成
            // 「识别中」——把这两段分开显示，人才知道慢的是哪一段。
            if (state.phase === 'uploading') {
              patch({ phase: 'analyzing', uploadedBytes: total, phaseStartedAt: Date.now() })
            }
            return
          }
          patch({ uploadedBytes: progress.loaded, fileBytes: total })
        },
      })
      inFlight = handle
      return handle.done
    })

    if (epoch !== mine) return
    patch({
      phase: 'confirming',
      preview,
      rows: [...preview.rows],
      source: preview.suggestedSource ?? state.source,
      phaseStartedAt: null,
      uploadedBytes: state.fileBytes,
    })
  } catch (cause) {
    if (epoch !== mine) return
    const canceled = cause instanceof ApiError && cause.code === 'cancelled'
    patch({
      phase: 'idle',
      error: canceled ? null : describe(cause, '识别失败，请换一份文件试试'),
      canceled,
      preview: null,
      rows: [],
      phaseStartedAt: null,
    })
  } finally {
    if (epoch === mine) inFlight = null
  }
}

/** 取消正在进行的上传/识别。已经结束的任务调用它是无操作。 */
export function cancelImportUpload(): void {
  if (inFlight === null) return
  inFlight.cancel()
  inFlight = null
  epoch += 1
  patch({ phase: 'idle', canceled: true, error: null, phaseStartedAt: null, uploadedBytes: 0 })
}

export function patchImportRow(index: number, changes: Partial<QuoteImportPreviewRow>): void {
  patch({
    rows: state.rows.map((row, position) => (position === index ? { ...row, ...changes } : row)),
  })
}

export function removeImportRow(index: number): void {
  patch({ rows: state.rows.filter((_, position) => position !== index) })
}

export function setImportSource(source: QuoteSource): void {
  patch({ source })
}

/** 放弃这次识别结果，回到初始态。 */
export function discardImportTask(): void {
  if (inFlight !== null) {
    inFlight.cancel()
    inFlight = null
  }
  epoch += 1
  publish({ ...EMPTY, doneToken: state.doneToken })
}

/** 把确认过的行写进库。失败时退回确认页，行还在，不用重新识别。 */
export async function submitImportTask(): Promise<void> {
  const current = state
  if (current.preview === null || current.rows.length === 0) return
  const mine = epoch

  patch({ phase: 'applying', error: null, phaseStartedAt: Date.now() })
  try {
    const result = await applyQuoteImport({
      fileName: current.preview.fileName,
      source: current.source,
      rows: current.rows,
    })
    if (epoch !== mine) return
    publish({
      ...EMPTY,
      doneToken: current.doneToken + 1,
      done: result,
    })
  } catch (cause) {
    if (epoch !== mine) return
    patch({
      phase: 'confirming',
      error: describe(cause, '导入失败，请重试'),
      phaseStartedAt: null,
    })
  }
}

/** 测试用：把状态与 epoch 一起复位。 */
export function resetImportTaskForTest(): void {
  epoch += 1
  inFlight = null
  publish(EMPTY)
}
