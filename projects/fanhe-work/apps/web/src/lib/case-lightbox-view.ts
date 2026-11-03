/**
 * 放大查看的视图几何。**全是纯函数，不碰 DOM。**
 *
 * 缩放与平移是这一层唯一的难点：以指针为锚点缩放、放大后不能把图拖出可视区、
 * 鼠标滚轮与触屏捏合要落在同一条曲线上。这些规则写进组件里就只能靠在浏览器里
 * 滚几下验证，而人在浏览器里很难判断「锚点到底偏了 3 像素还是没偏」。抽出来以后
 * 它们可以断言，包括那条最容易被写错的不变量：**缩放前后，指针下的那个图点不动。**
 *
 * 坐标系约定（整个模块只认这一种）：
 *   - 原点在**舞台中心**，向下向右为正。
 *   - `x` / `y` 是图片中心相对舞台中心的像素偏移。
 *   - `scale` 以「适配尺寸」为 1，即图片在不放大的时候刚好装进舞台。
 *   - 因此图片上一个点 `p`（相对图片中心、未缩放）的屏幕位置是 `offset + p * scale`。
 */

/** 舞台（可视区）与内容（图片布局尺寸）的尺寸，单位都是像素。 */
export type LightboxSize = { readonly width: number; readonly height: number }

/** 缩放视图。`scale === 1 && x === 0 && y === 0` 就是「刚打开这张图」。 */
export type LightboxView = { readonly scale: number; readonly x: number; readonly y: number }

export const LIGHTBOX_IDENTITY: LightboxView = { scale: 1, x: 0, y: 0 }

/**
 * 下限是 1（适配尺寸）。
 *
 * 允许缩到 1 以下只是把图变小、四周留出更多深色背景，看不到任何新信息；而在触控板上
 * 这类「缩没了」的状态很容易被误触出来，用户还得想办法找回原大小。所以下限就钉在
 * 「整张图刚好在屏幕里」，缩小的能力体现在「从放大态退回来」。
 */
export const LIGHTBOX_SCALE_MIN = 1

/**
 * 上限 5 倍。案例图的用途是看板材纹理与缝隙细节，手机上原图放大 3 倍左右就够看清；
 * 再往上只是把几个像素摊成一片色块，同时让平移变得极难定位（可用拖动的行程只剩边缘
 * 几个像素），所以到 5 倍为止。
 */
export const LIGHTBOX_SCALE_MAX = 5

/** 滚轮灵敏度。指数映射下每 100 像素（鼠标一格）约改变 20%。 */
const WHEEL_INTENSITY = 0.0022

/** 指针位移超过这个距离才算「拖动」，用来区分点击与手抖。 */
export const LIGHTBOX_DRAG_THRESHOLD = 3

export function clampLightboxScale(scale: number): number {
  // `NaN` 会让整条链路上的比较全部为假，视图从此卡住不动，因此在这里挡住。
  // 无穷大不必特判：`Math.min` / `Math.max` 会把它夹到上下限，那是它该有的结果。
  if (Number.isNaN(scale)) return LIGHTBOX_SCALE_MIN
  return Math.min(LIGHTBOX_SCALE_MAX, Math.max(LIGHTBOX_SCALE_MIN, scale))
}

/** 是否处于「原样适配」状态。用来决定百分比按钮要不要亮起来。 */
export function isLightboxReset(view: LightboxView): boolean {
  return view.scale <= LIGHTBOX_SCALE_MIN && view.x === 0 && view.y === 0
}

/**
 * 把偏移夹在「图片边缘不离开舞台边缘」之内。
 *
 * 当图片在某个方向上比舞台小（放大不足或图片本身很宽），该方向的偏移只能为 0 ——
 * 否则图片会飘到一边，另一侧露出一块空白，看起来像加载失败。
 */
export function constrainLightboxView(
  view: LightboxView,
  content: LightboxSize,
  stage: LightboxSize,
): LightboxView {
  const scale = clampLightboxScale(view.scale)
  if (scale <= LIGHTBOX_SCALE_MIN) return { scale, x: 0, y: 0 }

  /**
   * 尺寸还没测出来（图片仍在解码）时**不做夹取**。
   *
   * 此时 `content` 是 0，任何夹取都会把偏移压成 0：用户在第一帧就开始滚轮放大，
   * 锚点算出来的位移会被立刻抹平，表现为「滚了但没往指针那边放大」。等 onLoad
   * 之后会再夹一次，那时才真正收敛。
   */
  if (content.width <= 0 || content.height <= 0 || stage.width <= 0 || stage.height <= 0) {
    return { scale, x: view.x, y: view.y }
  }

  const limitX = Math.max(0, (content.width * scale - stage.width) / 2)
  const limitY = Math.max(0, (content.height * scale - stage.height) / 2)
  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, view.x)),
    y: Math.min(limitY, Math.max(-limitY, view.y)),
  }
}

/**
 * 以某个锚点为中心缩放到 `nextScale`。
 *
 * 锚点 `anchor` 是相对舞台中心的屏幕坐标（通常就是指针位置）。不变量是：缩放前后，
 * 锚点下方的那块图像内容保持不动。推导：设图片上的点 `p` 满足
 * `anchor = view.offset + p * view.scale`，要求缩放后仍成立，解出新的 `offset`。
 *
 * 没有这条规则，滚轮放大就变成「围绕图片中心放大」，用户想看的那块内容会往视野外跑，
 * 每次都要再拖回来 —— 这是放大查看体验里最容易被抱怨的一点。
 */
export function zoomLightbox(
  view: LightboxView,
  nextScale: number,
  anchor: { readonly x: number; readonly y: number },
  content: LightboxSize,
  stage: LightboxSize,
): LightboxView {
  const scale = clampLightboxScale(nextScale)
  const ratio = scale / view.scale
  return constrainLightboxView(
    {
      scale,
      x: anchor.x - (anchor.x - view.x) * ratio,
      y: anchor.y - (anchor.y - view.y) * ratio,
    },
    content,
    stage,
  )
}

/**
 * 滚轮 → 目标缩放比。
 *
 * 用指数而不是线性叠加：鼠标滚轮一格是 ±100 像素，触控板一次滑动是 ±1 到 ±10 像素，
 * 线性叠加会让两者手感相差一个数量级（触控板上根本推不动）。指数映射让它们落在
 * 同一条曲线上，而且缩放的「感觉」在大倍率下依然均匀。
 */
export function wheelLightboxScale(scale: number, deltaY: number): number {
  if (!Number.isFinite(deltaY)) return clampLightboxScale(scale)
  return clampLightboxScale(scale * Math.exp(-deltaY * WHEEL_INTENSITY))
}

/**
 * 双指捏合 → 目标缩放比。
 *
 * 以「手指按下那一刻的缩放」为基准乘以距离比，而不是每次移动都在当前值上累乘：
 * 后者会把每一次 move 的舍入误差累积起来，松开手指时倍率和手指行程对不上。
 */
export function pinchLightboxScale(
  startScale: number,
  startDistance: number,
  distance: number,
): number {
  if (!(startDistance > 0) || !Number.isFinite(distance)) return clampLightboxScale(startScale)
  return clampLightboxScale(startScale * (distance / startDistance))
}

/** 两点间距离。两指捏合与拖动阈值共用。 */
export function distanceBetween(
  a: { readonly x: number; readonly y: number },
  b: { readonly x: number; readonly y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** 缩放比的展示形式。`2.5` → `250%`。 */
export function formatLightboxZoom(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

// ---------------------------------------------------------------------------
// 旋转
// ---------------------------------------------------------------------------
//
// 旋转只改「怎么看」，不碰图片本身：字节、地址、上传时入库的那一份都不变。因此它必须
// 是纯视图状态 —— 一旦回写到数据里，「旋转一下方便看」就变成了「把客户的图改了」。
//
// 四个方向而不是任意角度：看图时想要的是「横图竖过来看」，按 90° 步进。任意角度会带来
// 一个没有答案的问题 —— 转 37° 之后「适配尺寸」怎么定义，以及要不要记忆那个角度。

/** 允许的四个方向。数组顺序同时是「点右旋会经过的顺序」。 */
export const LIGHTBOX_ROTATIONS = [0, 90, 180, 270] as const

export type LightboxRotation = (typeof LIGHTBOX_ROTATIONS)[number]

/**
 * 把任意角度归一到四个方向。
 *
 * 不是四的倍数的角度（37°、-45°）就近取整到 90° 的倍数。这个函数存在的理由是
 * `-90` 与 `360` 都得落到合法值上：调用方传负数是最自然的写法（「左旋就是减 90」），
 * 而一个 `-90deg` 直接进 CSS 也没问题、进「宽高是否互换」的判断就会算错。
 */
export function normalizeLightboxRotation(deg: number): LightboxRotation {
  if (!Number.isFinite(deg)) return 0
  const steps = Math.round(deg / 90)
  return ((((steps * 90) % 360) + 360) % 360) as LightboxRotation
}

/** 左旋 `-90`、右旋 `+90`。传 0 就是不变。 */
export function rotateLightbox(deg: LightboxRotation, delta: -90 | 0 | 90): LightboxRotation {
  return normalizeLightboxRotation(deg + delta)
}

/** 是否转成了「竖着的」。90° 与 270° 的宽高互换，180° 不换。 */
export function isQuarterTurned(deg: LightboxRotation): boolean {
  return deg % 180 !== 0
}

/**
 * 一张布局尺寸为 `content` 的图，旋转后在屏幕上占多大。
 *
 * 90°/270° 时宽高互换。夹取偏移、算缩放上限都只关心这个尺寸 —— 用未旋转的盒子去算，
 * 放大后往「错的边」拖会被提前夹住，表现为「右下角怎么都拖不到」。
 */
export function lightboxVisualSize(content: LightboxSize, deg: LightboxRotation): LightboxSize {
  return isQuarterTurned(deg)
    ? { width: content.height, height: content.width }
    : { width: content.width, height: content.height }
}

/**
 * 旋转后图片在布局上的上限（给 `max-width` / `max-height` 用）。
 *
 * `content` 的 `max-w-full / max-h-full` 是按**未旋转**的盒子算的：转 90° 之后，视觉
 * 宽度来自布局高度、视觉高度来自布局宽度，原来的约束正好相反。不换的话，一张 4:3 的
 * 横图转过来会比舞台高一截，下缘被 `overflow-hidden` 裁掉（看起来像图坏了）。
 *
 * 舞台还没量出来（首帧 `0`）时返回 0，调用方据此回落到 `100%`。
 */
export function lightboxFitLimit(stage: LightboxSize, deg: LightboxRotation): LightboxSize {
  return isQuarterTurned(deg)
    ? { width: stage.height, height: stage.width }
    : { width: stage.width, height: stage.height }
}
