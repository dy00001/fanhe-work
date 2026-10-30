import { CASE_LIBRARY_LIMITS, type CreateCaseUploadItem } from '@fanhe/shared'

/**
 * 把本地图片压成可以上传的两个尺寸。
 *
 * **压缩必须在浏览器做，不能把原图直接送上去。** 手机拍的实景图动辄 4–8MB，一个品类
 * 传几十张就是几百 MB；而这些图在图集里的最大用途是「看清这块柜门的收口」，1600px 已经
 * 绰绰有余。库里存的是压好的 webp，原图不保留 —— 这一点在界面上要说明（见上传后的
 * 提示），因为「传上去的是压缩版」是个用户有权知道的事实。
 *
 * 全程不依赖任何图像库：`createImageBitmap` 解码 + canvas 重绘 + `toBlob` 编码，都是
 * 浏览器内建的，桌面端（Electron 44）与网页端行为一致。
 */

/** 缩略图最长边。与静态清单里 `public/cases/thumbs/` 的那一套同尺寸，网格看起来才一致。 */
export const UPLOAD_THUMB_EDGE = 320

/** 原图最长边。取共享包里的常量，避免「前端压 1000、文档写 1600」这种对不上的说明。 */
export const UPLOAD_FULL_EDGE = CASE_LIBRARY_LIMITS.UPLOAD_EDGE_MAX

/**
 * 按最长边等比缩放后的尺寸。**只缩不放** —— 一张 800px 的图放大到 1600px 只会变糊，
 * 还白白多占一倍空间。
 *
 * 单独抽成纯函数是为了能在门禁里验：等比、取整、不越界这三件事，肉眼看不出来，而
 * 算错的表现是图被拉变形。
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height)
  if (longest <= maxEdge) return { width, height }
  const scale = maxEdge / longest
  return {
    // 至少留 1px：极端长条图（比如 3000×40 的拼接图）短边会算成 0，而 0 高的画布
    // 在 canvas 上是直接报错。
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  }
}

/** 一张准备上传的图，形状与接口请求体一致。 */
export type PreparedUpload = CreateCaseUploadItem

/** 预处理失败的原因。界面按它给不同的提示 —— 三种失败用户能做的事完全不同。 */
export type PrepareFailure = 'not_image' | 'decode_failed' | 'too_large' | 'encode_failed'

export type PrepareResult =
  { ok: true; data: PreparedUpload } | { ok: false; reason: PrepareFailure }

export function describePrepareFailure(reason: PrepareFailure): string {
  switch (reason) {
    case 'not_image':
      return '只能上传图片'
    case 'decode_failed':
      // HEIC 是最常见的这一类：iPhone 默认格式，Chromium 解不了。
      return '这张图解不开，可能是 HEIC 格式，请先转成 JPG 或 PNG'
    case 'too_large':
      return '图片太大，压缩后仍超过单张上限'
    case 'encode_failed':
      return '图片编码失败，请换一张试试'
  }
}

/** 有些浏览器不给 `OffscreenCanvas.toBlob`，统一走一个函数，失败回落到 DOM canvas。 */
async function encodeBitmap(
  bitmap: ImageBitmap,
  maxEdge: number,
  quality: number,
): Promise<Blob | null> {
  const size = fitWithin(bitmap.width, bitmap.height, maxEdge)

  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (context === null) return null
  // 缩小图片时的取样质量。不设的话 Chromium 用低质量的快速缩放，缩到 320px 时
  // 边缘会出现锯齿，而这一档正是网格里最常被看到的那一档。
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(bitmap, 0, 0, size.width, size.height)

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/webp', quality)
  })
}

/**
 * Blob → base64（不带 `data:` 前缀）。
 *
 * 不用 `FileReader.readAsDataURL`：它给出的前缀要再切一次，而切片是又一个会写错的
 * 字符串处理。分块拼接是因为 `String.fromCharCode(...bytes)` 在几十万字节时会爆栈 ——
 * 这个上限（约 12 万参数）正好落在「一张 800KB 的 webp」附近，属于一定会踩到的坑。
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const chunk = 0x8000
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk))
  }
  return btoa(binary)
}

/**
 * 预处理一张用户选中的文件。
 *
 * 顺序是刻意的：先看类型（不必解码就知道它不是图）、再解码（这一步失败通常是格式
 * 不支持）、再压、最后才判体积。反过来先判体积的话，一张 6MB 的 HEIC 会得到「太大」
 * 而真正的问题是「解不开」—— 用户按提示去压缩，压完仍然传不上去。
 */
export async function prepareUpload(file: File): Promise<PrepareResult> {
  if (!file.type.startsWith('image/')) return { ok: false, reason: 'not_image' }
  // 上限只作为快速拒绝：压缩之后才是真正的判据。这里给 4 倍余量，是因为手机原图
  // 常有 8–12MB，而它们压完完全可能只有 200KB，不该在门口就被挡掉。
  if (file.size > CASE_LIBRARY_LIMITS.UPLOAD_BYTES_MAX * 4) {
    return { ok: false, reason: 'too_large' }
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    return { ok: false, reason: 'decode_failed' }
  }

  try {
    // 原图 q0.82：柜体细节（木纹、收口、缝）在图集里主要靠它看，质量再低会出现
    // 明显的块状伪影。缩略图 q0.72：320px 下肉眼看不出差别，而它决定网格首屏的体积。
    const [full, thumb] = await Promise.all([
      encodeBitmap(bitmap, UPLOAD_FULL_EDGE, 0.82),
      encodeBitmap(bitmap, UPLOAD_THUMB_EDGE, 0.72),
    ])
    if (full === null || thumb === null) return { ok: false, reason: 'encode_failed' }
    if (full.size > CASE_LIBRARY_LIMITS.UPLOAD_BYTES_MAX) return { ok: false, reason: 'too_large' }
    if (thumb.size > CASE_LIBRARY_LIMITS.UPLOAD_THUMB_BYTES_MAX) {
      return { ok: false, reason: 'too_large' }
    }

    // 存压好之后的尺寸，而不是原图尺寸：取图接口发出去的就是这张，界面按它留占位，
    // 两者一致才不会出现「占位是 4:3、加载完是 16:9」的跳动。
    const size = fitWithin(bitmap.width, bitmap.height, UPLOAD_FULL_EDGE)
    return {
      ok: true,
      data: {
        data: await blobToBase64(full),
        thumb: await blobToBase64(thumb),
        width: size.width,
        height: size.height,
      },
    }
  } finally {
    // ImageBitmap 占的是解码后的位图内存（一张 4000×3000 约 48MB），不显式释放要等
    // GC；连续选十张时很容易在释放前就撞上内存压力。
    bitmap.close()
  }
}
