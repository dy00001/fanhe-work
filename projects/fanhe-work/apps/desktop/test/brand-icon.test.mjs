/**
 * 品牌图标的回归测试。
 *
 * 这一层守的是一件很容易在换机 / 改图之后悄悄坏掉的事：**窗口、任务栏、托盘三处
 * 顶的是不是同一枚、且是方的**。
 *
 * 背景：界面里那个 `logo.png` 是 362×391、白底、无 alpha 的品牌原图，它给页面内的
 * 品牌位用是对的；但标题栏 / 任务栏 / 托盘给的是**正方形槽位**，非方形图会被按方形
 * 重排、四周留白，小尺寸下看着像被压扁或者带了一条底色。所以这三个位置改用
 * `app-icon.png`（256×256、四角透明）。
 *
 * 这里断言四条，每一条都对应一个具体的坏法：
 *   ① 路径拼得对（改目录结构时先坏的是它）；
 *   ② 图是**方的**（非方形就是这个 bug 本身）；
 *   ③ 图**带 alpha 且四角透明**（没有 alpha 的话任务栏深色底上会顶出一块白板）；
 *   ④ `electron-builder.yml` 的 `win.icon` 指向**同一个文件**（不同源就会出现
 *      「任务栏一个样、托盘另一个样」，而这种偏差很难被当成 bug 报出来）。
 *
 * 与其它 desktop 测试同款：直接测 `src/brand-icon.ts` 源码，不构建。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { inflateSync } from 'node:zlib'

import { BRAND_ICON_RELATIVE, TRAY_ICON_WIDTH, brandIconPath } from '../src/brand-icon.ts'

/** `apps/desktop/test` → `apps/web/public/brand/`。 */
const BRAND_DIR = join(import.meta.dirname, '..', '..', 'web', 'public', 'brand')

/**
 * 解析 PNG 的 IHDR，返回 `{ width, height, colorType }`。
 *
 * 只认到第一个块：IHDR 按规范必须是第一个，不需要遍历。
 */
function readPngHeader(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (let i = 0; i < signature.length; i += 1) {
    assert.equal(buffer[i], signature[i], 'PNG 签名不对')
  }
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR', '第一个块不是 IHDR')
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
  }
}

/**
 * 取左上角像素的 RGBA。
 *
 * **第一行第一个像素的过滤器一律退化成「原样」**：Sub / Up / Average / Paeth 四个
 * 过滤器算的都是「当前字节减去某个邻居」，而第一个像素左边与上边都没有数据，四个
 * 公式里的邻居项全部为零。所以解压 IDAT 之后直接读 `[1..4]` 就是它的 RGBA，不必
 * 实现完整的反过滤。用这一条而不是引入一个 PNG 解码依赖。
 */
function readTopLeftPixel(buffer) {
  const parts = []
  let offset = 8
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (type === 'IDAT') parts.push(buffer.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(parts))
  return [raw[1], raw[2], raw[3], raw[4]]
}

test('图标路径拼在 web 产物的 brand/ 下', () => {
  assert.equal(
    brandIconPath(join('E:', 'ws', 'apps', 'web', 'dist')),
    join('E:', 'ws', 'apps', 'web', 'dist', 'brand', 'app-icon.png'),
  )
  assert.equal(BRAND_ICON_RELATIVE, join('brand', 'app-icon.png'))
})

test('托盘图标目标尺寸是正整数且小于原图，缩了才有意义', () => {
  assert.ok(Number.isInteger(TRAY_ICON_WIDTH) && TRAY_ICON_WIDTH > 0)
  assert.ok(TRAY_ICON_WIDTH < 256)
})

test('品牌图标是正方形且不小于 256（低于 256 electron-builder 生成不出 256 那一档）', () => {
  const png = readFileSync(join(BRAND_DIR, 'app-icon.png'))
  const { width, height } = readPngHeader(png)
  assert.equal(width, height, `品牌图标必须是方的，实际 ${width}×${height}`)
  assert.ok(width >= 256, `品牌图标至少 256，实际 ${width}`)
})

test('品牌图标带 alpha 通道，且四角透明', () => {
  const png = readFileSync(join(BRAND_DIR, 'app-icon.png'))
  const { colorType } = readPngHeader(png)
  // 6 = truecolour with alpha。没有 alpha 时任务栏深色底上会顶出一块白板。
  assert.equal(colorType, 6, '品牌图标必须是带 alpha 的 PNG')

  const [r, g, b, a] = readTopLeftPixel(png)
  assert.equal(a, 0, `左上角应当透明，实际 rgba(${r},${g},${b},${a})`)
})

test('打包配置的 win.icon 与窗口/托盘图标同源', () => {
  const yml = readFileSync(join(import.meta.dirname, '..', 'electron-builder.yml'), 'utf8')
  const match = /^\s*icon:\s*(\S+)\s*$/m.exec(yml)
  assert.ok(match !== null, 'electron-builder.yml 里没找到 win.icon')
  assert.equal(
    match[1],
    '../web/public/brand/app-icon.png',
    '任务栏图标（exe 图标资源）与窗口/托盘图标必须指向同一个文件',
  )
})
