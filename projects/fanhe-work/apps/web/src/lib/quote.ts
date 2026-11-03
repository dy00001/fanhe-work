import type {
  CreateQuoteCategoryRequest,
  CreateQuoteItemRequest,
  MergeQuoteCategoryRequest,
  QuoteAccessStateResponse,
  QuoteCategoryListResponse,
  QuoteImageMutationResponse,
  QuoteImportApplyRequest,
  QuoteImportApplyResponse,
  QuoteImportPreviewResponse,
  QuoteItemDto,
  QuoteItemResponse,
  QuoteItemStatus,
  QuoteLedgerStatsDto,
  QuoteMetaResponse,
  QuoteRevisionListResponse,
  QuoteSearchResponse,
  RenameQuoteCategoryRequest,
  ReorderQuoteCategoriesRequest,
  UpdateQuoteItemRequest,
  UploadQuoteImageRequest,
} from '@fanhe/shared'

import { ApiError } from './api'
import {
  createQuoteCategoryRequest,
  createQuoteItemRequest,
  mergeQuoteCategoryRequest,
  quoteAccessStateRequest,
  quoteCategoriesRequest,
  quoteImageRequest,
  quoteImportApplyRequest,
  quoteImportPreviewRequest,
  quoteItemRequest,
  quoteMetaRequest,
  quoteRevisionsRequest,
  quoteSearchRequest,
  quoteSecretRequest,
  quoteStatsRequest,
  quoteUnlockRequest,
  removeQuoteImageRequest,
  renameQuoteCategoryRequest,
  reorderQuoteCategoriesRequest,
  setQuoteItemStatusRequest,
  updateQuoteItemRequest,
  uploadQuoteImageRequest,
  type QuoteSearchQuery,
} from './api'
import { describePrepareFailure, prepareUpload } from './case-upload'
import { withAccessToken } from './session'

/**
 * 报价查价的前端数据层。
 *
 * 三层分工与其余模块一致：`api.ts` 拼地址，`session.ts` 管令牌，这里把两件事拼起来
 * 并把服务端的信封拆掉。
 *
 * ## 解锁令牌单独存
 *
 * 它放在 `sessionStorage` 而不是内存里，是因为**刷新一次就要重输口令**是不能接受的：
 * 30 分钟有效期本来就该跨刷新。放 `localStorage` 又太长 —— 关掉浏览器还留着，等于
 * 把「临时开锁」变成「永久开锁」。`sessionStorage` 正好落在两者之间：同一标签页内
 * 刷新不丢，关掉就没了。
 *
 * 存的是 `{ token, expiresAt }`。**读取时先看 `expiresAt`**，过期就当场删掉并返回
 * null，而不是把令牌送上去等一个 403 —— 后者会让界面把「口令过期」显示成「没有权限」，
 * 而这两件事对用户是两种完全不同的处理（一个是再输一次，一个是找管理员）。
 *
 * ## 图片走 object URL，且有缓存
 *
 * 取图接口要 Bearer 令牌，`<img>` 带不了请求头，所以每张图都要先 fetch 成 Blob。
 * 结果列表滚动时同一个 `imageKey` 会被重复请求，因此按 `key:variant:version` 缓存 ——
 * 版本号在键里，换图之后自动拿到新的一张，不必手动失效。
 */

const UNLOCK_STORAGE_KEY = 'fanhe.quote.unlock'

type StoredUnlock = { token: string; expiresAt: string }

function readStoredUnlock(): StoredUnlock | null {
  try {
    const raw = window.sessionStorage.getItem(UNLOCK_STORAGE_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<StoredUnlock>
    if (typeof candidate.token !== 'string' || typeof candidate.expiresAt !== 'string') return null
    return { token: candidate.token, expiresAt: candidate.expiresAt }
  } catch {
    // 隐私模式下 sessionStorage 会直接抛 —— 不能让它把整个面板带崩，退化成
    // 「本次会话内不记住解锁」即可。
    return null
  }
}

/** 当前的解锁令牌。过期（或本来就没有）返回 null。 */
export function getQuoteUnlockToken(): string | null {
  const stored = readStoredUnlock()
  if (stored === null) return null
  if (new Date(stored.expiresAt).getTime() <= Date.now()) {
    clearQuoteUnlock()
    return null
  }
  return stored.token
}

export function storeQuoteUnlock(token: string, expiresAt: string): void {
  try {
    window.sessionStorage.setItem(UNLOCK_STORAGE_KEY, JSON.stringify({ token, expiresAt }))
  } catch {
    // 存不进去只影响「刷新后是否还记得」，不影响本次已经拿到的那把钥匙。
  }
}

export function clearQuoteUnlock(): void {
  try {
    window.sessionStorage.removeItem(UNLOCK_STORAGE_KEY)
  } catch {
    // 同上，忽略。
  }
}

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

export function loadQuoteMeta(): Promise<QuoteMetaResponse> {
  return withAccessToken((token) => quoteMetaRequest(token))
}

export function searchQuotes(query: QuoteSearchQuery): Promise<QuoteSearchResponse> {
  return withAccessToken((token) => quoteSearchRequest(token, query))
}

export function loadQuoteItem(code: string): Promise<QuoteItemResponse> {
  return withAccessToken((token) => quoteItemRequest(token, code))
}

export function loadQuoteAccessState(): Promise<QuoteAccessStateResponse> {
  return withAccessToken((token) => quoteAccessStateRequest(token))
}

/** 台账现状：绑定档位分布、图文件数、孤儿图数。只有打开维护面板时才取。 */
export function loadQuoteStats(): Promise<QuoteLedgerStatsDto> {
  return withAccessToken((token) => quoteStatsRequest(token))
}

/** 最近的改价 / 停用 / 换图记录。 */
export function loadQuoteRevisions(limit = 20): Promise<QuoteRevisionListResponse> {
  return withAccessToken((token) => quoteRevisionsRequest(token, limit))
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

/**
 * 用口令换令牌，并记住它。
 *
 * **失败时不吞错**：调用方要按错误码分流（口令错 / 锁定 / 还没设口令），三种的处理
 * 完全不同。`ApiError.body` 里带着服务端给的 `failCount` 与 `lockedUntil`。
 */
export function unlockQuote(password: string): Promise<{ expiresAt: string }> {
  return withAccessToken(async (token) => {
    const result = await quoteUnlockRequest(token, password)
    storeQuoteUnlock(result.unlockToken, result.expiresAt)
    return { expiresAt: result.expiresAt }
  })
}

export function saveQuoteSecret(
  password: string,
  mode: 'create' | 'rotate',
): Promise<{ version: number }> {
  return withAccessToken(async (token) => {
    const result = await quoteSecretRequest(token, password, mode)
    return { version: result.version }
  })
}

export function saveQuotePrice(
  code: string,
  input: UpdateQuoteItemRequest,
): Promise<{ version: string; item: QuoteItemDto }> {
  return withAccessToken(async (token) => {
    const result = await updateQuoteItemRequest(token, code, input, getQuoteUnlockToken())
    return { version: result.version, item: result.item as QuoteItemDto }
  })
}

export function saveQuoteStatus(
  code: string,
  status: QuoteItemStatus,
  reason: string,
): Promise<{ version: string; item: QuoteItemDto }> {
  return withAccessToken(async (token) => {
    const result = await setQuoteItemStatusRequest(
      token,
      code,
      { status, reason },
      getQuoteUnlockToken(),
    )
    return { version: result.version, item: result.item as QuoteItemDto }
  })
}

export type QuoteImagePrepareFailure = 'not_image' | 'decode_failed' | 'too_large' | 'encode_failed'

/**
 * 本地图片 → 可上传的两个尺寸。复用案例库那个压缩器。
 *
 * **不把原图直接送上去**：手机直出 4–8MB，而灯箱要的是「看清结构」，2400px 足够；
 * 更重要的是服务端有 6MB 的硬上限，超了会在传输末尾才失败。
 */
export async function prepareQuoteImage(
  file: File,
): Promise<
  { ok: true; item: UploadQuoteImageRequest } | { ok: false; message: string; reason: string }
> {
  const result = await prepareUpload(file)
  if (!result.ok) {
    return {
      ok: false,
      reason: result.reason as QuoteImagePrepareFailure,
      message: describePrepareFailure(result.reason),
    }
  }
  return {
    ok: true,
    item: {
      // 只挑四个字段。压缩器那边给的是案例库的形状（还带 `mime` / `thumbWidth` /
      // `thumbHeight`），但**这三个由服务端自己算**：MIME 读魔数比信客户端声明的可靠，
      // 缩略图尺寸按 320 长边自己推。客户端能声明的字段越少，能填错的地方越少。
      data: result.data.data,
      thumb: result.data.thumb,
      width: result.data.width,
      height: result.data.height,
    },
  }
}

export function uploadQuoteImage(
  code: string,
  input: UploadQuoteImageRequest,
): Promise<QuoteImageMutationResponse> {
  return withAccessToken((token) =>
    uploadQuoteImageRequest(token, code, input, getQuoteUnlockToken()),
  )
}

export function removeQuoteImage(code: string): Promise<{ version: string }> {
  return withAccessToken((token) => removeQuoteImageRequest(token, code, getQuoteUnlockToken()))
}

// ---------------------------------------------------------------------------
// 维护台：分类 / 产品 / 批量导入
// ---------------------------------------------------------------------------

export function loadQuoteCategories(): Promise<QuoteCategoryListResponse> {
  return withAccessToken((token) => quoteCategoriesRequest(token))
}

export function createQuoteCategory(
  input: CreateQuoteCategoryRequest,
): Promise<{ name: string; count: number; sortOrder: number }> {
  return withAccessToken((token) => createQuoteCategoryRequest(token, input, getQuoteUnlockToken()))
}

export function renameQuoteCategory(
  input: RenameQuoteCategoryRequest,
): Promise<{ version: string; moved: number }> {
  return withAccessToken((token) => renameQuoteCategoryRequest(token, input, getQuoteUnlockToken()))
}

export function mergeQuoteCategory(
  input: MergeQuoteCategoryRequest,
): Promise<{ version: string; moved: number }> {
  return withAccessToken((token) => mergeQuoteCategoryRequest(token, input, getQuoteUnlockToken()))
}

export function reorderQuoteCategories(
  input: ReorderQuoteCategoriesRequest,
): Promise<{ updated: number }> {
  return withAccessToken((token) =>
    reorderQuoteCategoriesRequest(token, input, getQuoteUnlockToken()),
  )
}

export function createQuoteItem(input: CreateQuoteItemRequest): Promise<{ version: string }> {
  return withAccessToken((token) => createQuoteItemRequest(token, input, getQuoteUnlockToken()))
}

/**
 * File → 纯 base64。
 *
 * **不能写 `btoa(String.fromCharCode(...bytes))`**：8MB 的文件展开成 800 万个参数，
 * 直接 `RangeError: Maximum call stack size exceeded`。按 32KB 分块拼。
 */
async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  const CHUNK = 0x8000
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return btoa(binary)
}

/** 识别文件，**一行都不写库**。结果给确认页。 */
export async function previewQuoteImport(file: File): Promise<QuoteImportPreviewResponse> {
  const data = await fileToBase64(file)
  return withAccessToken((token) =>
    quoteImportPreviewRequest(token, { fileName: file.name, data }, getQuoteUnlockToken()),
  )
}

export function applyQuoteImport(
  input: QuoteImportApplyRequest,
): Promise<QuoteImportApplyResponse> {
  return withAccessToken((token) => quoteImportApplyRequest(token, input, getQuoteUnlockToken()))
}

// ---------------------------------------------------------------------------
// 图片字节
// ---------------------------------------------------------------------------

const imageCache = new Map<string, string>()
const inflight = new Map<string, Promise<string | null>>()

function imageCacheKey(key: string, variant: 'thumb' | 'full', version: string | null): string {
  return `${key}\u001f${variant}\u001f${version ?? ''}`
}

/**
 * 取一张图并转成 object URL。失败返回 null（界面画占位，不弹错）。
 *
 * 失败不抛的理由：一张图挂了不该让整张结果表变成错误页。图是辅助信息，价格才是。
 */
export function loadQuoteImageUrl(
  key: string,
  variant: 'thumb' | 'full',
  version: string | null,
): Promise<string | null> {
  const cacheKey = imageCacheKey(key, variant, version)
  const cached = imageCache.get(cacheKey)
  if (cached !== undefined) return Promise.resolve(cached)

  const running = inflight.get(cacheKey)
  if (running !== undefined) return running

  const task = withAccessToken(async (token) => {
    try {
      const blob = await quoteImageRequest(token, key, variant, version)
      const url = URL.createObjectURL(blob)
      imageCache.set(cacheKey, url)
      return url
    } catch {
      return null
    } finally {
      inflight.delete(cacheKey)
    }
  })
  inflight.set(cacheKey, task)
  return task
}

/**
 * 释放所有缓存过的 object URL。
 *
 * 面板关闭时调用。不调用的后果不是「坏掉」，而是每打开一次面板，这些 blob 就一直
 * 挂在文档上，直到整页刷新 —— 一次会话开关十次就是十几 MB 的常驻内存。
 */
export function releaseQuoteImages(): void {
  for (const url of imageCache.values()) URL.revokeObjectURL(url)
  imageCache.clear()
}

/** 写操作失败时界面该给哪个出口。判据取决于服务端定义的错误码取值域。 */
export type QuoteWriteExit = 'unlock' | 'secret' | 'gone' | 'retry'

export function quoteWriteExit(error: ApiError): QuoteWriteExit {
  const code = error.code
  if (code === 'forbidden') return 'unlock'
  if (code === 'no_secret') return 'secret'
  if (error.status === 404) return 'gone'
  return 'retry'
}
