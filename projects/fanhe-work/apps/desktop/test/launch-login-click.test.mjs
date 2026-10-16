/**
 * 「唤起客户端之后的窗口侧后置动作」的回归测试。
 *
 * 覆盖三件事：**按软件的开关**（qq / qianniu 开，wechat / custom / 未知关）、
 * **窗口等待真的进了脚本**（2026-10-15 之前这一步缺失，实测恒 `no-window`，等于从来
 * 没生效过）、**平铺布局与各脚本产物的正确性**。
 *
 * 窗口操作那段 PowerShell 只在 Windows 上、且只在已开软件上执行：单测不真正调起它
 * （沙箱非 Windows，且不该依赖外部客户端窗口），只断言脚本产物包含正确的 pid、等待
 * 参数、Enter 虚拟键码与置前台的 P/Invoke。等待参数必须能被断言，否则「等多久」这个
 * 行为没有任何东西在看。
 *
 * 沙箱是 linux/darwin，所以这些测试**不验证 PowerShell 脚本真的能跑**。脚本正确性
 * 靠两件事兜：5.1 兼容纪律有断言钉着，真实执行在 Windows 真机上验（见
 * `docs/LAUNCH-OPTIMIZE-2026-10-15.md` 的实施进度）。这不是「测试不足」，而是把
 * 「能在 CI 里验的」与「只能在真机验的」分清界限。
 *
 * 本文件是 `.mjs`，**不写 TS 语法**：Node 按纯 JS 解析它，非空断言之类的记号会直接
 * 报语法错误。数组取值一律先判存在再断言。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { platform } from 'node:os'

import {
  buildFindWindowScript,
  buildPressEnterScript,
  buildTileWindowsScript,
  buildWorkAreaScript,
  CLICK_LOGIN_WAIT_MS,
  clickLoginAfterLaunch,
  computeTileLayout,
  findProcessWindow,
  parseFindWindowOutput,
  parseTileOutput,
  parseWindowSendOutput,
  parseWorkAreaOutput,
  readWorkArea,
  shouldClickLogin,
  TILE_GAP_PX,
  TILE_MAX_COLUMNS,
  TILE_MIN_SIZE_PX,
  tileWindows,
  waitAndPressEnter,
} from '../src/launch-login-click.ts'

/** 一个普通 1080p 工作区（去掉任务栏后的可用区域）。 */
const WORK_1080 = { x: 0, y: 0, width: 1920, height: 1040 }

/* ---------------- 按软件的开关 ---------------- */

test('shouldClickLogin：qq 与 qianniu 默认开', () => {
  assert.equal(shouldClickLogin('qq'), true)
  assert.equal(shouldClickLogin('qianniu'), true)
})

test('shouldClickLogin：wechat 只唤起、不点登录', () => {
  assert.equal(shouldClickLogin('wechat'), false)
})

test('shouldClickLogin：custom 与未知软件默认关', () => {
  assert.equal(shouldClickLogin('custom'), false)
  assert.equal(shouldClickLogin('something-new'), false)
  assert.equal(shouldClickLogin(''), false)
})

test('CLICK_LOGIN_WAIT_MS：默认等待要能覆盖客户端冷启动', () => {
  // 真机上微信从 spawn 到登录窗立住实测要几秒到十几秒。低于 5 秒的值等于没有等待，
  // 而它曾是「实测恒 no-window」的根因，因此这里给一个下限而不是精确值。
  assert.ok(CLICK_LOGIN_WAIT_MS >= 5000, `默认等待应至少 5 秒，当前 ${CLICK_LOGIN_WAIT_MS}`)
  assert.ok(CLICK_LOGIN_WAIT_MS <= 60000, '默认等待不应长到让用户以为哪里卡住了')
})

/* ---------------- 脚本构造 ---------------- */

test('buildPressEnterScript：把目标 pid 注入脚本', () => {
  const script = buildPressEnterScript(4242)
  assert.ok(script.includes('4242'), '脚本应包含目标 pid')
})

test('buildPressEnterScript：包含「置前台 + 敲 Enter」的关键调用', () => {
  const script = buildPressEnterScript(99)
  assert.ok(script.includes('SetForegroundWindow'), '应带到前台')
  assert.ok(script.includes('EnumWindows'), '应枚举顶层窗口按 pid 挑')
  assert.ok(script.includes('keybd_event'), '应发送按键')
  assert.ok(script.includes('0x0D'), 'Enter 的虚拟键码 VK_RETURN 应为 0x0D')
  assert.ok(script.includes('Write-Output'), '应通过 stdout 回报状态')
})

test('buildPressEnterScript：真的在等窗口（2026-10-15 修的根因）', () => {
  const script = buildPressEnterScript(7)
  // 原实现在 spawn 那一刻就找一次窗口、找不到就退出，于是恒 no-window。
  // 现在必须是一个带超时的轮询循环，且找到后还要过一轮稳定期复查。
  assert.ok(script.includes('$deadline'), '应有等待超时判据')
  assert.ok(script.includes('while ($true)'), '应是轮询循环而不是一次性查找')
  assert.ok(script.includes('Start-Sleep -Milliseconds $pollMs'), '应按间隔轮询')
  assert.ok(script.includes('Start-Sleep -Milliseconds $stabilityMs'), '窗口出现后应有稳定期')
  assert.ok(/&\s*\$findWindow/.test(script), '稳定期之后应复查窗口是否还在')
})

test('buildPressEnterScript：等待参数可注入且进到脚本里', () => {
  const script = buildPressEnterScript(1, { timeoutMs: 2500, pollMs: 50, stabilityMs: 100 })
  assert.ok(script.includes('$timeoutMs = 2500'), '超时应注入脚本')
  assert.ok(script.includes('$pollMs = 50'), '轮询间隔应注入脚本')
  assert.ok(script.includes('$stabilityMs = 100'), '稳定期应注入脚本')
})

test('buildPressEnterScript：不使用 PS7 专有语法（系统自带的是 5.1）', () => {
  const script = buildPressEnterScript(7)
  // `0u` / `0ul` 这类无符号字面量后缀是 PowerShell 7 才有的；5.1 会把 `0u` 当命令名，
  // 报「无法将"0u"识别为 cmdlet」，整段脚本在窗口回调里直接炸掉（真机踩过）。
  assert.equal(/\b0u\b/.test(script), false, '不得出现 0u 字面量（PS 5.1 不认）')
  assert.equal(/\b0ul\b/i.test(script), false, '不得出现 0ul 字面量（PS 5.1 不认）')
  // 无符号初值应写成 [uint32]$x = 0。
  assert.ok(script.includes('[uint32]'), '无符号初值应显式声明 [uint32]')
})

test('buildPressEnterScript：Add-Type 的 here-string 首尾换行必须保留', () => {
  const script = buildPressEnterScript(3)
  // PowerShell 要求 `@"` 之后紧跟换行、`"@` 独占一行。把 P/Invoke 源码 trim 掉首尾
  // 换行会让 `@"` 直接顶上 `using System;`，解析立即失败，而失败只发生在真机上。
  assert.ok(script.includes('Add-Type @"\n'), '@" 之后必须紧跟换行')
  assert.ok(/\n"@/.test(script), '"@ 必须独占一行')
})

test('buildFindWindowScript：只取窗口不按键（微信多开用）', () => {
  const script = buildFindWindowScript(321)
  assert.ok(script.includes('321'), '脚本应包含目标 pid')
  assert.ok(script.includes('$found.ToInt64()'), '应把窗口句柄回传')
  // 一个键都不该发：微信是扫码登录，敲 Enter 只会干扰扫码头。
  // 断言的是「调用形态」而不是符号名 —— P/Invoke 声明里同样含 `keybd_event` 与
  // `SetForegroundWindow` 这两个名字，按名字断言会把声明也当成调用。
  assert.equal(script.includes('[Win32LoginClick]::keybd_event'), false, '不应当发送任何按键')
  assert.equal(script.includes('[Win32LoginClick]::SetForegroundWindow'), false, '不应当抢前台')
  // 但等待逻辑必须与「敲 Enter」那条完全一致，否则两者的窗口判据会分叉。
  assert.ok(script.includes('$deadline'), '应共用同一段等待逻辑')
  assert.ok(script.includes('$stabilityMs'), '应共用稳定期复查')
})

test('buildWorkAreaScript：读的是工作区而不是整个屏幕', () => {
  const script = buildWorkAreaScript()
  assert.ok(script.includes('0x0030'), 'SPI_GETWORKAREA 应为 0x0030')
  assert.ok(script.includes('SystemParametersInfo'), '应调 SystemParametersInfo')
  assert.ok(script.includes('Write-Output'), '应回传区域')
})

test('buildTileWindowsScript：空输入也不炸且回报 moved=0', () => {
  const script = buildTileWindowsScript([])
  assert.ok(script.includes('"moved":0'), '空输入应直接回报 0')
  assert.ok(script.includes('Add-Type'), '仍应是一段合法脚本')
})

test('buildTileWindowsScript：把每个句柄与坐标写进脚本', () => {
  const script = buildTileWindowsScript([
    { hwnd: 111, x: 0, y: 0, width: 400, height: 300 },
    { hwnd: 222, x: 408, y: 0, width: 400, height: 300 },
  ])
  assert.ok(script.includes('@(111, 0, 0, 400, 300)'), '应写入第一个窗口')
  assert.ok(script.includes('@(222, 408, 0, 400, 300)'), '应写入第二个窗口')
  assert.ok(script.includes('SetWindowPos'), '应调用 SetWindowPos')
})

test('buildTileWindowsScript：不改 z 序、不抢焦点', () => {
  const script = buildTileWindowsScript([{ hwnd: 111, x: 0, y: 0, width: 400, height: 300 }])
  // SWP_NOZORDER(0x4) | SWP_NOACTIVATE(0x10) = 0x14。抢焦点会让「排布」这个动作
  // 本身打断用户，而这里只是把 N 个登录窗排开，没有理由带到前台。
  assert.ok(script.includes('0x0014'), 'uFlags 应为 SWP_NOZORDER | SWP_NOACTIVATE')
})

test('buildTileWindowsScript：不使用 PS7 专有语法', () => {
  const script = buildTileWindowsScript([{ hwnd: 111, x: 0, y: 0, width: 400, height: 300 }])
  assert.equal(/\b0u\b/.test(script), false, '不得出现 0u 字面量（PS 5.1 不认）')
})

/* ---------------- 平铺布局 ---------------- */

test('computeTileLayout：空输入与非法输入返回空数组', () => {
  assert.deepEqual(computeTileLayout(0, WORK_1080), [])
  assert.deepEqual(computeTileLayout(-3, WORK_1080), [])
  assert.deepEqual(computeTileLayout(Number.NaN, WORK_1080), [])
  // 工作区退化时不给位置：调用方拿不到合法坐标，于是不会去动窗口。
  assert.deepEqual(computeTileLayout(2, { x: 0, y: 0, width: 0, height: 0 }), [])
  assert.deepEqual(computeTileLayout(2, { x: 0, y: 0, width: -100, height: 400 }), [])
})

test('computeTileLayout：单个窗口占满工作区', () => {
  const layout = computeTileLayout(1, WORK_1080)
  assert.equal(layout.length, 1)
  assert.deepEqual(layout[0], { x: 0, y: 0, width: 1920, height: 1040 })
})

test('computeTileLayout：两个窗口左右并排，各占一半', () => {
  const layout = computeTileLayout(2, WORK_1080)
  assert.equal(layout.length, 2)
  // (1920 - 8) / 2 = 956
  assert.deepEqual(layout[0], { x: 0, y: 0, width: 956, height: 1040 })
  assert.deepEqual(layout[1], { x: 956 + TILE_GAP_PX, y: 0, width: 956, height: 1040 })
})

test('computeTileLayout：两个窗口不重叠、都在工作区内', () => {
  const layout = computeTileLayout(2, WORK_1080)
  for (const rect of layout) {
    assert.ok(rect.x + rect.width <= WORK_1080.width, '右边界不得超出工作区')
    assert.ok(rect.y + rect.height <= WORK_1080.height, '下边界不得超出工作区')
  }
  const left = layout[0]
  const right = layout[1]
  assert.ok(left.x + left.width <= right.x, '两个窗口不得水平重叠')
})

test('computeTileLayout：3 个窗口是 2 列 2 行，第一行放两个', () => {
  const layout = computeTileLayout(3, WORK_1080)
  assert.equal(layout.length, 3)
  const firstRow = layout.filter((rect) => rect.y === 0)
  assert.equal(firstRow.length, 2, '第一行应放两个')
  // 第三个落到第二行第一列。
  assert.ok(layout[2].y > 0, '第三个应在第二行')
  assert.equal(layout[2].x, 0, '第三个应在第一列')
})

test('computeTileLayout：5 个窗口排成 3 列 2 行', () => {
  const layout = computeTileLayout(5, WORK_1080)
  assert.equal(layout.length, 5)
  const columns = new Set(layout.map((rect) => rect.x)).size
  const rows = new Set(layout.map((rect) => rect.y)).size
  assert.equal(columns, 3, '应为 3 列')
  assert.equal(rows, 2, '应为 2 行')
})

test('computeTileLayout：大量窗口也保持矩形不越界', () => {
  const count = 12
  const layout = computeTileLayout(count, WORK_1080)
  assert.equal(layout.length, count)
  for (const rect of layout) {
    assert.ok(rect.width >= TILE_MIN_SIZE_PX, '单元格不得小于最小可用尺寸')
    assert.ok(rect.height >= TILE_MIN_SIZE_PX, '单元格不得小于最小可用尺寸')
    assert.ok(rect.x + rect.width <= WORK_1080.width, '右边界不得超出工作区')
    assert.ok(rect.y + rect.height <= WORK_1080.height, '下边界不得超出工作区')
  }
  const columns = new Set(layout.map((rect) => rect.x)).size
  assert.ok(columns <= TILE_MAX_COLUMNS, '列数应封顶')
})

test('computeTileLayout：尊重非零起点（副屏挂在主屏上方或左侧）', () => {
  const layout = computeTileLayout(2, { x: -1920, y: 0, width: 1920, height: 1040 })
  assert.equal(layout[0].x, -1920, '第一个窗口应落在工作区左边界')
  assert.ok(layout[1].x >= -1920, '第二个窗口不得跑到工作区之外')
})

test('computeTileLayout：窗口数量远超列数上限时按行铺开', () => {
  // 二维码的识别面积比「格子是否填满」重要，因此列数封顶、行数增长。
  const layout = computeTileLayout(30, WORK_1080)
  const columns = new Set(layout.map((rect) => rect.x)).size
  assert.ok(columns <= TILE_MAX_COLUMNS, `列数应封顶 ${TILE_MAX_COLUMNS}，当前 ${columns}`)
  assert.ok(layout[0].width >= TILE_MIN_SIZE_PX, '封顶后每格仍应可用')
  assert.equal(layout.length, 30, '每个窗口都要有一个位置')
})

/* ---------------- 输出解析 ---------------- */

test('parseWindowSendOutput：成功与失败都能解析出等待时长', () => {
  assert.deepEqual(parseWindowSendOutput('{"sent":true,"waitedMs":2341}'), {
    sent: true,
    reason: 'sent',
    waitedMs: 2341,
  })
  assert.deepEqual(parseWindowSendOutput('{"sent":false,"reason":"no-window","waitedMs":15000}'), {
    sent: false,
    reason: 'no-window',
    waitedMs: 15000,
  })
})

test('parseWindowSendOutput：没有 waitedMs 的成功省略该字段', () => {
  // `exactOptionalPropertyTypes`：给 undefined 与不给是两回事，这里要的是后者。
  assert.deepEqual(parseWindowSendOutput('{"sent":true}'), { sent: true, reason: 'sent' })
})

test('parseWindowSendOutput：畸形输出按失败处理且不抛', () => {
  const badInputs = [
    '',
    '   ',
    'not json',
    '{"sent":"yes"}',
    '{"sent":true,"reason":"no-window"}',
    'null',
    '[]',
  ]
  for (const raw of badInputs) {
    const parsed = parseWindowSendOutput(raw)
    assert.equal(parsed.sent, false, `输入 ${JSON.stringify(raw)} 不应判成已发送`)
  }
})

test('parseFindWindowOutput：hwnd 必须是非零整数', () => {
  assert.deepEqual(parseFindWindowOutput('{"sent":true,"hwnd":123456,"waitedMs":120}'), {
    hwnd: 123456,
    reason: 'found',
    waitedMs: 120,
  })
  const badHandles = [
    '{"sent":true,"hwnd":0}',
    '{"sent":true,"hwnd":-5}',
    '{"sent":true,"hwnd":1.5}',
    '{"sent":true,"hwnd":"123"}',
  ]
  for (const raw of badHandles) {
    const parsed = parseFindWindowOutput(raw)
    assert.equal(parsed.hwnd, null, `输入 ${raw} 不应给出可用句柄`)
    assert.equal(parsed.reason, 'failed')
  }
  assert.deepEqual(parseFindWindowOutput('{"sent":false,"reason":"no-window"}'), {
    hwnd: null,
    reason: 'no-window',
  })
})

test('parseWorkAreaOutput：区域非法时归 null，绝不返回可疑值', () => {
  assert.deepEqual(parseWorkAreaOutput('{"left":0,"top":0,"width":1920,"height":1040}'), {
    x: 0,
    y: 0,
    width: 1920,
    height: 1040,
  })
  assert.deepEqual(parseWorkAreaOutput('{"left":-1920,"top":0,"width":1920,"height":1040}'), {
    x: -1920,
    y: 0,
    width: 1920,
    height: 1040,
  })
  const badInputs = [
    '',
    'garbage',
    '{"left":0,"top":0,"width":0,"height":400}',
    '{"left":0,"top":0,"width":1920}',
    '{"left":"0","top":0,"width":1920,"height":1040}',
    'null',
  ]
  for (const raw of badInputs) {
    assert.equal(parseWorkAreaOutput(raw), null, `输入 ${raw} 应判为不可用区域`)
  }
})

test('parseTileOutput：解析排布数量，失败归 0', () => {
  assert.deepEqual(parseTileOutput('{"moved":3}'), { moved: 3 })
  assert.deepEqual(parseTileOutput('{"moved":2.7}'), { moved: 2 })
  assert.deepEqual(parseTileOutput('{"moved":-1}'), { moved: 0, reason: 'failed' })
  assert.deepEqual(parseTileOutput('garbage'), { moved: 0, reason: 'failed' })
})

/* ---------------- 执行侧 ---------------- */

test('执行侧：非 Windows 一律原样返回，不抛也不卡', async () => {
  if (platform() === 'win32') return
  assert.deepEqual(await waitAndPressEnter(1), { sent: false, reason: 'unsupported-platform' })
  assert.deepEqual(await findProcessWindow(1), { hwnd: null, reason: 'unsupported-platform' })
  assert.deepEqual(await tileWindows([1, 2]), { moved: 0, reason: 'unsupported-platform' })
  assert.equal(await readWorkArea(), null)
})

test('tileWindows：少于两个窗口直接跳过', async () => {
  if (platform() === 'win32') return
  // 单个窗口没有排布可言。这条路径在 Windows 上同样成立，因此在这里先钉住返回值。
  assert.deepEqual(await tileWindows([42]), { moved: 0 })
})

test('clickLoginAfterLaunch：非 Windows 直接拦下、不操作窗口', async () => {
  // 沙箱是 linux/darwin，平台守门应在到达 PowerShell 之前返回，不抛、不卡。
  if (platform() === 'win32') return
  const result = await clickLoginAfterLaunch('qq', 1234)
  assert.deepEqual(result, { attempted: false, reason: 'unsupported-platform' })
})

test('clickLoginAfterLaunch：关掉的软件（wechat）即使有 pid 也不点', async () => {
  const result = await clickLoginAfterLaunch('wechat', 1234)
  assert.equal(result.attempted, false)
  assert.equal(result.reason, 'disabled')
})

test('clickLoginAfterLaunch：未知软件按关处理，不碰窗口', async () => {
  const result = await clickLoginAfterLaunch('something-new', 1234)
  assert.equal(result.attempted, false)
  assert.equal(result.reason, 'disabled')
})
