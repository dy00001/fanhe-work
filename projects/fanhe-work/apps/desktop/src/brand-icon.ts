/**
 * 品牌图标的唯一落点。
 *
 * ## 为什么单开一个模块
 *
 * 品牌图标用于任务栏和系统托盘，标题栏使用独立的小尺寸图标。标题栏只有约 16px
 * 的显示空间，复杂印章被系统缩放后细节会糊在一起，因此该位置需要简化的专用图形。
 *
 * ## 为什么是 `app-icon.png` 而不是 `logo.png`
 *
 * `logo.png` 是**品牌原图**（362×391，非方形、白底无 alpha），它的用途是页面内的
 * 品牌位（侧栏品牌行、登录页、favicon），那里按原始比例显示是对的。
 *
 * 任务栏 / 托盘位置给的是**正方形槽位**：非方形图会被按比例塞进去、
 * 两侧留白，小尺寸下看起来像被压扁或带了一条底色。`app-icon.png` 是从原图裁出印章
 * 后重排的 256×256 方图（圆角白底、四角透明），用于任务栏和托盘。
 *
 * 两者都随 web 构建产物投递（`apps/web/public/brand/` → `dist/brand/`），因此这里
 * 只需要一个相对路径，不必让桌面端各自持有二进制资源。
 *
 * ## 为什么要 `distRoot` 参数
 *
 * 与 `paths.ts` 的 `webDistRoot` 同一条理由：路径要能在纯 Node 单测里直接算，
 * 模块内不留 `__dirname`，也不读 `app.isPackaged`。
 */
import { join } from 'node:path'

/**
 * 品牌图标在 web 产物里的相对路径（相对 `dist/brand/` 的父目录）。
 *
 * 与 `electron-builder.yml` 的 `win.icon` 指向**同一个文件**：任务栏图标由 exe 的
 * 图标资源提供，托盘与窗口由这里提供，两处必须是同一枚，否则同一台机器上会出现
 * 「任务栏一个样、托盘另一个样」。
 */
export const BRAND_ICON_RELATIVE = join('brand', 'app-icon.png')

/** 标题栏专用多尺寸图标。小尺寸以简化的印章字母标记绘制，避免系统缩放糊成一团。 */
export const WINDOW_ICON_RELATIVE = join('brand', 'window-icon.ico')

/**
 * 托盘图标的目标边长（px）。
 *
 * 托盘区按 16px 逻辑尺寸渲染（高 DPI 下由系统放大）。原图 256px 直接丢给 `Tray`
 * 会被系统自行缩放，缩出来的边缘比 `nativeImage.resize` 的 LANCZOS 更脏，所以显式
 * 缩一次。给 `width` 与 `height` 两个值而不是只给 `width`：图已经是方的，两个值
 * 相同，但写全之后「这里要的是一个方图标」这件事在读代码时是显式的。
 */
export const TRAY_ICON_WIDTH = 16

/** 品牌图标的绝对路径。`distRoot` 由 `main.ts` 传 `DIST_ROOT`（见 `paths.ts`）。 */
export function brandIconPath(distRoot: string): string {
  return join(distRoot, BRAND_ICON_RELATIVE)
}

/** 标题栏窗口图标的绝对路径。 */
export function windowIconPath(distRoot: string): string {
  return join(distRoot, WINDOW_ICON_RELATIVE)
}
