import { QUOTE_LIMITS, type UploadQuoteImageRequest } from '@fanhe/shared'

import { blobToBase64, encodeBitmap, fitWithin } from './case-upload'

/**
 * 报价商品图的预处理。
 *
 * 与 `lib/case-upload.ts` 共用「解码 → 缩放 → 编码」三步（那个文件里的
 * `encodeBitmap`），但阈值与失败提示另写一套：案例库装的是施工实景，图集里要看清
 * 收口，所以按 1600 长边压；报价产品图在查价面板里最大也就显示到 600px 左右，压到
 * 1600 已经把木纹留够了，再大只是让 1225 行的库多占几百 MB。
 *
 * ## 为什么要在这里就把格式挡掉
 *
 * 服务端只认 JPEG / PNG / WebP 三种魔数（`store.ts` 的 `detectImageMime`）。理论上
 * 「能解码就压成 webp」也能落库，但两种不该放进来：
 *
 * - **GIF**：`createImageBitmap` 只解第一帧，用户传一张动图会得到一张静图，而他
 *   以为自己传的是动图 —— 这种「悄悄少了一半内容」比直接拒绝糟。
 * - **SVG**：它能带脚本，而这张图会被浏览器按 `image/*` 直接渲染。
 *
 * 拒绝的理由写进提示里，让人知道该去转成什么，而不是只看到「格式不支持」。
 */

/**
 * 允许的文件类型。**`accept` 与白名单必须同源**：只改一个，会出现「选择框里能挑
 * 出 HEIC、拖进来才被拒」这种不一致。
 */
export const QUOTE_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'] as const

export const QUOTE_IMAGE_ACCEPT = QUOTE_IMAGE_MIMES.join(',')

/** 扩展名兜底。`file.type` 偶尔为空（某些来源拖进来的文件没有 MIME）。 */
const EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'] as const

/**
 * 原图长边。服务端上限是 `QUOTE_LIMITS.IMAGE_EDGE_MAX`（2400），这里压到 1600 ——
 * 产品图没有需要 2400 的细节，而它决定了库里 1225 条图的总体积。
 */
export const QUOTE_IMAGE_EDGE = 1600

/**
 * 原文件体积的快速拒绝线。
 *
 * 真正的判据是**压缩之后**的字节数，所以这里给 4 倍余量：手机原图常有一张 8–12MB，
 * 压完可能只有 150KB，不该在门口就被挡掉。挡的是「显然不是照片」的量级（比如把
 * 一个 50MB 的 PSD 拖进来）。
 */
export const QUOTE_IMAGE_FILE_BYTES_MAX = QUOTE_LIMITS.IMAGE_BYTES_MAX * 4

export type QuoteImageFailure =
  'empty' | 'bad_type' | 'decode_failed' | 'too_large' | 'encode_failed'

export type PreparedQuoteImage = {
  /** 形状与 `POST /api/quote/items` 的 `image` 字段逐字一致。 */
  request: UploadQuoteImageRequest
  /** 缩略图的 data URL，直接给 `<img src>` 用。就是最终落库的那张。 */
  previewUrl: string
  /** 压缩后的原图字节数，界面用来显示「已压到 xxx」。 */
  byteSize: number
}

export type PrepareQuoteImageResult =
  { ok: true; value: PreparedQuoteImage } | { ok: false; reason: QuoteImageFailure }

/**
 * 失败提示。
 *
 * 四种失败用户要做的事完全不同：格式不对要去转格式、太大要换图、解不开多半是
 * HEIC、编码失败只能重试。给一句「上传失败」等于让他自己猜。
 */
export function describeQuoteImageFailure(reason: QuoteImageFailure): string {
  switch (reason) {
    case 'empty':
      return '这个文件是空的，换一张试试'
    case 'bad_type':
      return '只支持 JPG、PNG、WebP 三种格式。iPhone 的 HEIC 请先转成 JPG'
    case 'decode_failed':
      return '这张图解不开，可能是 HEIC 或文件损坏，请转成 JPG / PNG 后重试'
    case 'too_large':
      return `图片太大：原图不能超过 ${formatMegabytes(QUOTE_IMAGE_FILE_BYTES_MAX)}，压缩后不能超过 ${formatMegabytes(QUOTE_LIMITS.IMAGE_BYTES_MAX)}`
    case 'encode_failed':
      return '图片处理失败，请换一张试试'
  }
}

/** 把字节数说成人话。「6291456 字节」这种提示没人会换算。 */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`
}

export function formatKilobytes(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))}KB`
}

/** 按扩展名兜底判断。只在 `file.type` 为空时用。 */
function extensionAllowed(name: string): boolean {
  const lower = name.toLowerCase()
  return EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * 预处理一张用户选中的文件。
 *
 * 顺序是刻意的，与案例图那份同理：**先看类型**（不必解码就知道它不该进来）、
 * **再解码**（这一步失败通常是 HEIC）、**再压**、**最后判体积**。反过来先判体积的
 * 话，一张 8MB 的 HEIC 会得到「太大」，而真正的问题是「解不开」—— 用户按提示去
 * 压，压完仍然传不上去。
 */
export async function prepareQuoteImage(file: File): Promise<PrepareQuoteImageResult> {
  if (file.size === 0) return { ok: false, reason: 'empty' }

  const declared = file.type.toLowerCase()
  const typeOk =
    declared === ''
      ? extensionAllowed(file.name)
      : (QUOTE_IMAGE_MIMES as readonly string[]).includes(declared)
  if (!typeOk) return { ok: false, reason: 'bad_type' }
  if (file.size > QUOTE_IMAGE_FILE_BYTES_MAX) return { ok: false, reason: 'too_large' }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { ok: false, reason: 'decode_failed' }
  }

  try {
    const [full, thumb] = await Promise.all([
      encodeBitmap(bitmap, QUOTE_IMAGE_EDGE, 0.82),
      encodeBitmap(bitmap, QUOTE_LIMITS.THUMB_WIDTH, 0.72),
    ])
    if (full === null || thumb === null) return { ok: false, reason: 'encode_failed' }
    // 判据是压缩之后的字节数 —— 服务端按解码后的长度卡这条线，两边必须一致。
    if (full.size > QUOTE_LIMITS.IMAGE_BYTES_MAX) return { ok: false, reason: 'too_large' }

    // 存压好之后的尺寸，不是原图尺寸：取图接口发出去的就是这张，界面按它留占位，
    // 两者一致才不会出现「占位是 4:3、加载完是 16:9」的跳动。
    const size = fitWithin(bitmap.width, bitmap.height, QUOTE_IMAGE_EDGE)
    const thumbBase64 = await blobToBase64(thumb)
    // 编码回落：`toBlob(cb, 'image/webp')` 在少数环境会返回 PNG。前缀跟着实际类型
    // 走，否则预览是一块空白，而库里存的字节其实是对的。
    const thumbMime = thumb.type === '' ? 'image/webp' : thumb.type

    return {
      ok: true,
      value: {
        request: {
          data: await blobToBase64(full),
          thumb: thumbBase64,
          width: size.width,
          height: size.height,
        },
        previewUrl: `data:${thumbMime};base64,${thumbBase64}`,
        byteSize: full.size,
      },
    }
  } finally {
    // 解码后的位图占的是内存（4000×3000 约 48MB），不显式释放要等 GC。选图区可以
    // 连点着换好几张，很容易在释放前撞上内存压力。
    bitmap.close()
  }
}
