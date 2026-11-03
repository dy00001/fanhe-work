import type { QuoteImportPreviewResponse } from '@fanhe/shared'

import { ApiError, apiEndpoint, toApiError } from './api'

/**
 * 批量导入的**上传**这一段。用 XHR，不用 `fetch`。
 *
 * ## 为什么必须退回 XHR
 *
 * `fetch` 到现在也没有上传进度事件。`ReadableStream` 的请求体只在 Chromium 里
 * 可用，且拿到的仍然是「写进去多少」，与「服务端收了多少」不是一回事。XHR 的
 * `upload.onprogress` 是唯一能给出真实百分比的接口 —— 而这一屏最缺的就是它：
 * 12MB 的台账在普通宽带上要几十秒，界面上只有一个转圈时，人只会得出「卡死了」
 * 的结论，然后去切页面。
 *
 * ## 为什么请求体是原始字节
 *
 * 旧实现是 `{ fileName, data: base64 }`。base64 让 12.25MB 的台账变成 17MB，
 * 多出来的 40% 全压在传输上 —— 而传输正是这条链路唯一的慢变量（服务端解析
 * 同一份文件实测 135ms）。原始字节还能让浏览器直接读文件，不必先把整个文件读进
 * 内存再编一遍字符串。
 *
 * 文件名走 `x-quote-file-name` 头，URL 编码。HTTP 头按 Latin-1 传，中文文件名
 * 直接塞进去会变成乱码。
 */
export type UploadProgress = {
  /** 已发出的字节数。 */
  loaded: number
  /** 文件总字节数。`lengthComputable` 为假时是 0，调用方要判。 */
  total: number
}

export type UploadHandle = {
  /** 成功时给出识别结果；失败时给出 `ApiError`。 */
  done: Promise<QuoteImportPreviewResponse>
  /** 掐掉这次上传。会以 `cancelled` 的 `ApiError` 结束，调用方不必特殊处理。 */
  cancel: () => void
}

/** 上传 + 服务端识别的总上限。超过就当作失败，不留一个永不 settle 的 Promise。 */
export const QUOTE_IMPORT_UPLOAD_TIMEOUT_MS = 300_000

export function uploadQuoteImportFile(input: {
  file: File
  accessToken: string
  unlockToken: string | null
  onProgress: (progress: UploadProgress) => void
}): UploadHandle {
  const xhr = new XMLHttpRequest()
  let cancelled = false

  const done = new Promise<QuoteImportPreviewResponse>((resolve, reject) => {
    xhr.open('POST', apiEndpoint('/api/quote/import/preview'))
    xhr.timeout = QUOTE_IMPORT_UPLOAD_TIMEOUT_MS
    xhr.setRequestHeader('accept', 'application/json')
    // 原始字节。服务端为这个类型挂了「原样收字节」的解析器（见 routes/quote.ts）。
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.setRequestHeader('x-quote-file-name', encodeURIComponent(input.file.name))
    xhr.setRequestHeader('authorization', `Bearer ${input.accessToken}`)
    if (input.unlockToken !== null) {
      xhr.setRequestHeader('x-quote-unlock', input.unlockToken)
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return
      input.onProgress({ loaded: event.loaded, total: event.total })
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as QuoteImportPreviewResponse)
        } catch {
          // 2xx 但正文不是 JSON：多半是网关塞了一张 HTML 的 200 页。
          reject(new ApiError(0, 'bad_response', '服务器返回的内容不是识别结果', null))
        }
        return
      }
      const retryAfter = xhr.getResponseHeader('retry-after')
      reject(toApiError(xhr.status, xhr.responseText, retryAfter ?? undefined))
    }

    // `onerror` / `ontimeout` / `onabort` 三个必须分开：在 XHR 里它们都表现为
    // 「没有响应」，但对人说的是三件不同的事（网络断了 / 太慢 / 我自己取消的）。
    xhr.onerror = () => {
      reject(new ApiError(0, 'network_error', '无法连接服务器，请确认后端已启动', null))
    }
    xhr.ontimeout = () => {
      const seconds = Math.round(QUOTE_IMPORT_UPLOAD_TIMEOUT_MS / 1000)
      reject(new ApiError(0, 'timeout', `上传或识别超过 ${seconds} 秒没有完成`, null))
    }
    xhr.onabort = () => {
      reject(new ApiError(0, 'cancelled', '已取消这次上传', null))
    }

    xhr.send(input.file)
  })

  return {
    done,
    cancel: () => {
      if (cancelled) return
      cancelled = true
      xhr.abort()
    },
  }
}
