import { QUOTE_LIMITS } from '@fanhe/shared'

/**
 * 批量导入的**展示规则**：纯函数，不 import 任何会碰网络或浏览器 API 的模块。
 *
 * 它们被单独放一份的理由与其它 `*-display.ts` 一样：这些规则写在组件里，就只有
 * 打开浏览器、选对文件、等上传跑到一半才能验；放在这里，一个 `node --test` 就能
 * 把边界（0 字节、刚好等于上限、总量未知、阶段未开始）全部走一遍。
 *
 * 这里也是「两段进度」的口径所在：**上传有真实百分比，识别没有**。
 */

export type QuoteImportPhase = 'idle' | 'uploading' | 'analyzing' | 'confirming' | 'applying'

/** 算进度只需要这几个数，不必把整个任务状态传进来。 */
export type QuoteImportProgressView = {
  phase: QuoteImportPhase
  fileBytes: number
  uploadedBytes: number
  phaseStartedAt: number | null
}

/** 收得下的扩展名。`.xls` 不在里面：老格式的解析路径完全是另一套，没有实现。 */
export const IMPORT_ACCEPTED_SUFFIXES = ['.xlsx', '.csv', '.pdf'] as const

/**
 * 选文件时的前置校验。返回一句中文提示，或 `null` 表示通过。
 *
 * **这一步必须在发请求之前。** 旧实现没有任何前置判断：12.25MB 的台账照样编成
 * 17MB 传上去，传完才被服务端按「超过 8MB」拒掉。走公网时传完 17MB 要几十秒，
 * 而客户端自己的超时先到 —— 于是界面上写的是「服务器超时」，与真正的原因
 * （文件太大）毫无关系。用户 2026-11-03 报的那条就是这么来的。
 */
export function validateImportFile(file: { name: string; size: number }): string | null {
  const lower = file.name.toLowerCase()
  if (!IMPORT_ACCEPTED_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return '只认 Excel（.xlsx）、CSV 与 PDF。旧版 .xls 请另存为 .xlsx 再导入。'
  }
  if (file.size === 0) return '这个文件是空的'
  if (file.size > QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX) {
    const limit = Math.round(QUOTE_LIMITS.IMPORT_FILE_BYTES_MAX / 1024 / 1024)
    return `文件 ${formatMegabytes(file.size)}，超过 ${String(limit)}MB 上限。请拆分或另存为更小的文件`
  }
  return null
}

/** `12.3MB` / `340KB`。小文件用 KB 显示，否则会出现「0.0MB」。 */
export function formatMegabytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${String(Math.max(0, Math.round(bytes / 1024)))}KB`
  const mb = bytes / 1024 / 1024
  return mb >= 10 ? `${String(Math.round(mb))}MB` : `${mb.toFixed(1)}MB`
}

/**
 * 上传百分比。
 *
 * 只有 `uploading` 这一段有真实数字；`analyzing` 之后一律 100（那一段已经过去）。
 * 总字节未知时返回 `null`，让界面画不确定态，而不是画一个永远停在 0% 的条。
 */
export function uploadPercent(view: QuoteImportProgressView): number | null {
  if (view.phase !== 'uploading') return 100
  if (view.fileBytes <= 0) return null
  const ratio = view.uploadedBytes / view.fileBytes
  if (!Number.isFinite(ratio)) return null
  return Math.max(0, Math.min(100, Math.floor(ratio * 100)))
}

/** 当前阶段已用秒数。阶段没开始（idle / confirming）时返回 0。 */
export function elapsedSeconds(view: QuoteImportProgressView, now: number): number {
  if (view.phaseStartedAt === null) return 0
  return Math.max(0, Math.floor((now - view.phaseStartedAt) / 1000))
}

/**
 * 进度条下面那行字。
 *
 * 「识别中」后面只跟已用秒数，不给百分比 —— 那一段在服务端一次完成，中间没有
 * 可观测的刻度。编一个匀速爬到 99% 的假进度，比不显示更糟：人会等它爬到 100，
 * 而它永远到不了。
 */
export function importProgressLabel(
  phase: QuoteImportPhase,
  percent: number | null,
  seconds: number,
): string {
  if (phase === 'uploading') {
    return percent === null ? '正在上传' : `正在上传 ${String(percent)}%`
  }
  if (phase === 'analyzing') return `服务器识别中 · 已 ${String(seconds)} 秒`
  if (phase === 'applying') return `正在写入数据库 · 已 ${String(seconds)} 秒`
  return ''
}
