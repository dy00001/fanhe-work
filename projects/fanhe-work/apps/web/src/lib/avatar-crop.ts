/**
 * 头像裁剪的几何与绘制。
 *
 * ## 坐标系（先说清楚，后面每一行都靠它）
 *
 * 三套坐标，转换关系只有一条：
 *
 *   1. **源像素**：原图的像素坐标，原点在图片左上角，单位是原图像素。
 *   2. **显示像素**：图片在裁剪视口里画出来的尺寸，单位是 CSS px。
 *      `显示尺寸 = 源尺寸 × 缩放系数`，缩放系数 `scale` 恒 ≥ `coverScale`。
 *   3. **视口坐标**：那个正方形裁剪框，边长 `view`，原点在它左上角。
 *
 * 状态只有两个数：`zoom`（相对「恰好铺满」的倍数，恒 ≥ 1）与 `offset`（**图片中心
 * 相对视口中心的偏移，显示像素**）。用「中心偏移」而不是「图片左上角坐标」是因为
 * 前者在两个方向上都对称：夹取范围是 ±(显示边长 − 视口边长)/2，正负同号，少一处
 * 容易写反的地方。
 *
 * ## 为什么几何与绘制分开、且几何是纯函数
 *
 * 拖动与缩放每帧都要算这几个值，而它们全是「给几个数、返回几个数」，没有 DOM 依赖。
 * 拆成纯函数之后，边界（图片比视口窄、缩到最小、拖到最边上）可以在 Node 单测里逐个
 * 钉住 —— 而这些边界恰好是手测最难覆盖的：它们只在「刚好拖到底」那一帧才对，
 * 而拖过了会被夹住、看起来又正常了。
 */

/** 尺寸。 */
export type Size = { width: number; height: number }

/** 图片中心相对视口中心的偏移（显示像素）。 */
export type Offset = { x: number; y: number }

/** 一次裁剪的全部状态。 */
export type CropState = {
  /** 相对「恰好铺满视口」的倍数，恒 ≥ 1。 */
  zoom: number
  offset: Offset
}

/**
 * 导出头像的边长（px）。
 *
 * 256 是四的整数次幂、也是 Windows 图标体系里最大的一档；头像在界面上最大只画到
 * 40px，2 倍屏下 80px，256 有足够余量，同时让一张照片的 PNG 落在 100~200 KB。
 */
export const AVATAR_OUTPUT_SIZE = 256

/**
 * 缩放上限（相对「恰好铺满」）。
 *
 * 4 倍是手感与画质的折中：再大就是在放大原图的几个像素，糊得看不出内容；再小则
 * 一张竖长的图裁不出人脸所在的局部。
 */
export const MAX_ZOOM = 4

/**
 * 图片**恰好铺满**正方形视口所需的缩放系数（cover）。
 *
 * 取两个方向的较大值：小者会让图在另一个方向上短一截、露出底色。这也就是
 * `zoom = 1` 的含义 —— 再小就会出现留白，所以 `zoom` 的下界是 1。
 *
 * 源尺寸有 0 时返回 1 而不是 `Infinity`：那是一个坏图，但让调用方拿到 `Infinity`
 * 会在后续每一步都算出 `NaN`，最后表现为「画布全白、控制台没有报错」。
 */
export function coverScale(image: Size, view: number): number {
  if (image.width <= 0 || image.height <= 0 || view <= 0) return 1
  return Math.max(view / image.width, view / image.height)
}

/** 给定缩放状态下的显示尺寸（显示像素）。 */
export function displaySize(image: Size, view: number, zoom: number): Size {
  const scale = coverScale(image, view) * zoom
  return { width: image.width * scale, height: image.height * scale }
}

/**
 * 把 `-0` 归一成 `0`。
 *
 * `-0` 与 `0` 数值上相等、渲染上也一样，但 `Object.is(-0, 0)` 是 `false` —— 而 React
 * 判「状态有没有变」用的正是 `Object.is`。于是夹取出来的 `-0` 会让一次本该被跳过的
 * 重渲染真的发生；调试时看到 `-0` 也容易让人以为哪里算错了。`-0 === 0` 为真，所以
 * 这一句同时兜住了两种情况。
 */
function normalize(value: number): number {
  return value === 0 ? 0 : value
}

/**
 * 把偏移夹取到「图片始终盖满视口」的范围内。
 *
 * 两个方向各自独立：显示边长比视口大多少，中心就能往那边偏多少，超过就露出底色。
 * 显示边长**不大于**视口时（理论上只会在 `zoom < 1` 或坏图时出现）返回 0，
 * 而不是返回负数 —— 负的范围会让 `min > max`，`Math.min/Math.max` 的组合会把偏移
 * 顶到其中一个端点，看起来像图片被莫名推到了角上。
 */
export function clampOffset(offset: Offset, display: Size, view: number): Offset {
  const limitX = Math.max(0, (display.width - view) / 2)
  const limitY = Math.max(0, (display.height - view) / 2)
  return {
    x: normalize(Math.min(limitX, Math.max(-limitX, offset.x))),
    y: normalize(Math.min(limitY, Math.max(-limitY, offset.y))),
  }
}

/** 初始状态：恰好铺满、居中。 */
export function createCropState(image: Size, view: number): CropState {
  return { zoom: 1, offset: clampOffset({ x: 0, y: 0 }, displaySize(image, view, 1), view) }
}

/**
 * 改缩放，并让**视口中心对着的那一点保持不动**。
 *
 * 推导只有一行：视口中心对应的源坐标是 `图片半宽 − offset / scale`，要它不变，
 * 新的偏移就是旧偏移乘以缩放比。**不这么做的话**，每次拉滑杆图都会朝视口中心
 * 之外滑走，用户得一边放大一边把图拖回来 —— 那是所有裁剪控件里最常见的粗糙感来源。
 */
export function setZoom(image: Size, view: number, state: CropState, zoom: number): CropState {
  const next = Math.min(MAX_ZOOM, Math.max(1, zoom))
  const ratio = next / state.zoom
  const offset = { x: state.offset.x * ratio, y: state.offset.y * ratio }
  return { zoom: next, offset: clampOffset(offset, displaySize(image, view, next), view) }
}

/** 拖动：在现有偏移上加一段位移，再夹取。 */
export function panBy(
  image: Size,
  view: number,
  state: CropState,
  dx: number,
  dy: number,
): CropState {
  const display = displaySize(image, view, state.zoom)
  const offset = clampOffset({ x: state.offset.x + dx, y: state.offset.y + dy }, display, view)
  return { zoom: state.zoom, offset }
}

/**
 * 视口在**源像素**坐标系里对应的矩形。这就是 `drawImage` 要的九参数里前四个。
 *
 * 由夹取保证 `x ≥ 0` 且 `x + width ≤ 图片宽`（同理纵向），所以绘制时不会取到图外，
 * 也就不会在边缘出现半透明的拉丝。
 */
export function sourceRect(
  image: Size,
  view: number,
  state: CropState,
): { x: number; y: number; width: number; height: number } {
  const scale = coverScale(image, view) * state.zoom
  const side = view / scale
  return {
    x: image.width / 2 - (view / 2 + state.offset.x) / scale,
    y: image.height / 2 - (view / 2 + state.offset.y) / scale,
    width: side,
    height: side,
  }
}

/**
 * 把当前裁剪画到一张画布上。
 *
 * 预览与最终导出**共用这一个函数**：预览用的是同一份几何、同一张原图，只是目标画布
 * 更小。两边各画一套的话，会出现「预览里人脸上沿留了一点头发、存下来却切掉了」这类
 * 差一两像素的偏差 —— 而它只在用户存完之后才发现。
 *
 * 只碰 `document` 的是调用方（拿到 `HTMLCanvasElement`），这里不新建画布，因此这个
 * 模块可以被纯 Node 单测直接 import。
 */
export function drawAvatar(
  source: CanvasImageSource,
  image: Size,
  view: number,
  state: CropState,
  target: HTMLCanvasElement,
  size: number,
): void {
  target.width = size
  target.height = size
  const context = target.getContext('2d')
  if (context === null) return
  const rect = sourceRect(image, view, state)
  context.clearRect(0, 0, size, size)
  context.drawImage(source, rect.x, rect.y, rect.width, rect.height, 0, 0, size, size)
}

/**
 * 按当前裁剪导出 data URL（PNG）。
 *
 * 导出**方形**而不是圆形：界面上头像容器是 `rounded-full overflow-hidden`，圆的形状
 * 由容器裁，数据保持方形之后换个展示形状（比如详情页的大方头像）不用重裁。
 */
export function exportAvatarDataUrl(
  source: CanvasImageSource,
  image: Size,
  view: number,
  state: CropState,
): string | null {
  const canvas = document.createElement('canvas')
  drawAvatar(source, image, view, state, canvas, AVATAR_OUTPUT_SIZE)
  try {
    return canvas.toDataURL('image/png')
  } catch {
    // 画布被污染（理论上不会，图来自本机文件）或环境不支持时返回 null，由调用方
    // 报「保存失败」，而不是把异常抛进 React 的渲染路径。
    return null
  }
}
