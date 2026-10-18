/**
 * 桌面更新视图的判定回归测试（T7-02b）。
 *
 * ## 这一组要挡住什么
 *
 * 三件「不报错但界面就是不对」的事：
 *
 * 1. **浏览器里冒出更新按钮。** 那里没有更新通道（页面来自服务端，刷新即最新），
 *    显示出来只会让人去找一个不存在的按钮。
 * 2. **该显示的时候不显示。** 下载完了却不出按钮，等于这次更新白下了 —— 而用户
 *    刚在菜单里看到过「服务端已是 vX」。
 * 3. **两侧阶段名漂移。** web 与 desktop 是两个包，阶段名各抄一份；抄错了只会让
 *    某个阶段落进「不认识」的分支，界面上少一条提示，**不报错**。
 *
 * 第 3 条由文件末尾那两条跨包断言钉住：它直接加载 `apps/desktop/src/update.ts`
 * 的状态机，把事件喂进去，再拿产出的状态过 web 侧的校验。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import {
  DESKTOP_UPDATE_PHASES,
  UPDATE_POLL_ACTIVE_MS,
  UPDATE_POLL_ERROR_MS,
  UPDATE_POLL_IDLE_MS,
  UPDATE_STALL_MS,
  buildDesktopUpdateView,
  computeEtaMs,
  formatBytes,
  formatDuration,
  isSameUpdateStatus,
  parseDesktopUpdateStatus,
  updatePollIntervalMs,
} from '../src/lib/desktop-update.ts'
import { detectHost } from '../src/lib/host.ts'

/**
 * 桌面侧的状态机。
 *
 * **web 的测试去 import desktop 的源码，是有意的。** 这一层是 IPC 契约：一边产出、
 * 一边消费，而两侧没有共享的类型来源（web 不依赖 desktop —— 壳反过来依赖 web 的
 * 构建产物）。不这么测的话，「阶段名漂移」只能靠人记得两边一起改。
 * `apps/desktop/src/update.ts` 依赖为零，所以直接加载它没有任何副作用。
 */
import { applyUpdateEvent, initialUpdateStatus } from '../../desktop/src/update.ts'

/** 造一个桌面侧状态。 */
function status(phase, overrides = {}) {
  return { phase, version: null, percent: null, detail: '', ...overrides }
}

// ── 宿主 ────────────────────────────────────────────────────────────────

test('浏览器宿主下任何阶段都不显示', () => {
  for (const phase of DESKTOP_UPDATE_PHASES) {
    const view = buildDesktopUpdateView(
      status(phase, { version: '0.1.2', percent: 0.5, detail: 'x' }),
      'browser',
    )
    assert.deepEqual(view, { kind: 'hidden' }, `浏览器里 ${phase} 不该显示`)
  }
})

test('拿不到状态（IPC 返回了不认识的东西）时不显示', () => {
  assert.deepEqual(buildDesktopUpdateView(null, 'desktop'), { kind: 'hidden' })
  assert.deepEqual(buildDesktopUpdateView(null, 'browser'), { kind: 'hidden' })
})

test('宿主取值与 detectHost 一致（同一个判断不许有两份理解）', () => {
  // `detectHost` 认的是预加载脚本显式暴露的 `isDesktopShell === true`。
  const shellLike = { fanheDesktop: { isDesktopShell: true } }
  const browserLike = { fanheDesktop: undefined }

  assert.equal(detectHost(shellLike), 'desktop')
  assert.equal(detectHost(browserLike), 'browser')

  // 把它的返回值直接喂进来：两个模块对「桌面」这件事一旦分叉，这两条就会红。
  assert.equal(
    buildDesktopUpdateView(status('downloaded', { version: '0.1.2' }), detectHost(shellLike)).kind,
    'ready',
  )
  assert.equal(
    buildDesktopUpdateView(status('downloaded', { version: '0.1.2' }), detectHost(browserLike))
      .kind,
    'hidden',
  )
})

// ── 四个可见形态 ────────────────────────────────────────────────────────

test('没有更新时不显示（idle / up-to-date / unsupported）', () => {
  for (const phase of ['idle', 'up-to-date', 'unsupported']) {
    assert.deepEqual(
      buildDesktopUpdateView(status(phase), 'desktop'),
      { kind: 'hidden' },
      `${phase} 不该在顶栏上占位置`,
    )
  }
})

test('下载中显示版本号与百分比，且不可点', () => {
  const view = buildDesktopUpdateView(
    status('downloading', { version: '0.1.2', percent: 0.42 }),
    'desktop',
  )
  assert.equal(view.kind, 'downloading')
  assert.equal(view.text, '正在下载 v0.1.2 · 42%')
  assert.equal(view.version, '0.1.2')
  assert.equal(view.percent, 0.42)
  // 「不可点」由视图没有 actionLabel 体现：组件对 downloading 渲染的是 div 而不是按钮。
  assert.equal(view.actionLabel, undefined)
  // 也不挂红点：这一态不需要「来看一眼」，它需要的是等。红点的意义是提醒一个
  // 待办动作，而这里没有待办。
  assert.equal(view.dot, undefined)
})

test('🔴 available 是「等你点」而不是「正在下」：带小红点、可点、没有进度', () => {
  const view = buildDesktopUpdateView(status('available', { version: '0.1.2' }), 'desktop')
  assert.equal(view.kind, 'available')
  assert.equal(view.text, '发现新版本 v0.1.2')
  assert.equal(view.actionLabel, '立即更新')
  // 小红点由这一态自己声明，组件不猜。
  assert.equal(view.dot, true)
  // 还没开始下载，进度必须是 null —— 给一个 0% 的进度条会让人以为已经在下。
  assert.equal(view.percent, undefined)
})

test('只知道在下、不知道在下哪一版时也不编造版本号', () => {
  const view = buildDesktopUpdateView(status('downloading', { percent: 0.1 }), 'desktop')
  assert.equal(view.kind, 'downloading')
  assert.equal(view.version, null)
  assert.equal(view.text, '正在下载 新版本 · 10%')
})

test('下载完成时给出可点的按钮，且按钮上带版本号', () => {
  const view = buildDesktopUpdateView(status('downloaded', { version: '0.1.2' }), 'desktop')
  assert.equal(view.kind, 'ready')
  assert.equal(view.version, '0.1.2')
  assert.equal(view.text, '新版本 v0.1.2 已就绪')
  // 按钮上必须能看出装的是哪一版：「我刚看到有 0.1.3，怎么装完还是 0.1.2」是很自然的疑问。
  assert.match(view.actionLabel, /v0\.1\.2/)
  // 这一句是给用户看的承诺，而它成立的前提是 NSIS 不动 userData + 端口被钉住。
  assert.match(view.title, /本地设置与数据都保留/)
  // 就绪也是「有件事等你做」，与 available 一样挂红点 —— 用户离开一会儿回来，
  // 顶栏上那一点是他唯一能看出「有事发生」的线索。
  assert.equal(view.dot, true)
})

test('已下载却拿不到版本号时退回「准备中」，不渲染「更新到 null」', () => {
  const view = buildDesktopUpdateView(status('downloaded'), 'desktop')
  assert.equal(view.kind, 'checking')
})

test('出错时给出可重试的按钮，并把原因写进悬停说明', () => {
  const view = buildDesktopUpdateView(
    status('error', { detail: 'net::ERR_CONNECTION_RESET' }),
    'desktop',
  )
  assert.equal(view.kind, 'failed')
  assert.equal(view.actionLabel, '重试')
  assert.equal(view.detail, 'net::ERR_CONNECTION_RESET')
  assert.match(view.title, /ERR_CONNECTION_RESET/)
})

test('检查中的文案存在（是否显示由 hook 决定，不由本函数决定）', () => {
  // 「正在检查」只在用户主动点「重试」之后才该出现 —— 那条策略在
  // `use-desktop-update.ts` 里（靠 busy 标志），纯函数只负责给出文案。
  const view = buildDesktopUpdateView(status('checking'), 'desktop')
  assert.equal(view.kind, 'checking')
  assert.match(view.text, /检查更新/)
})

test('覆盖了每一个已知阶段（新增阶段必须同时补一条断言）', () => {
  for (const phase of DESKTOP_UPDATE_PHASES) {
    const view = buildDesktopUpdateView(
      status(phase, { version: '0.1.2', percent: 0.5 }),
      'desktop',
    )
    assert.ok(view.kind !== undefined, `阶段 ${phase} 没有映射到任何视图`)
  }
})

// ── IPC 取回来的值的校验 ────────────────────────────────────────────────

test('校验 IPC 拿回来的未知值，形状不对返回 null', () => {
  for (const bad of [
    null,
    undefined,
    'downloaded',
    [],
    {},
    { phase: 'unknown-phase' },
    { phase: 3 },
  ]) {
    assert.equal(parseDesktopUpdateStatus(bad), null, `${JSON.stringify(bad)} 不该被接受`)
  }
})

test('percent 越界或不是数字时归 null（不画一条意义不明的进度条）', () => {
  for (const bad of [NaN, Infinity, -0.1, 1.5, '0.5', null]) {
    const parsed = parseDesktopUpdateStatus(status('downloading', { percent: bad }))
    assert.equal(parsed.percent, null, `percent=${String(bad)} 该归 null`)
  }
  assert.equal(parseDesktopUpdateStatus(status('downloading', { percent: 0 })).percent, 0)
  assert.equal(parseDesktopUpdateStatus(status('downloading', { percent: 1 })).percent, 1)
})

test('空版本号按「没有版本号」处理（空串在界面上与「版本是空」分不出来）', () => {
  assert.equal(parseDesktopUpdateStatus(status('downloaded', { version: '' })).version, null)
  assert.equal(parseDesktopUpdateStatus(status('downloaded', { version: 3 })).version, null)
})

// ── 轮询节奏 ────────────────────────────────────────────────────────────

test('轮询间隔按阶段自适应，不可用的通道直接停掉', () => {
  assert.equal(updatePollIntervalMs(status('downloading', { percent: 0.3 })), UPDATE_POLL_ACTIVE_MS)
  assert.equal(updatePollIntervalMs(status('available')), UPDATE_POLL_ACTIVE_MS)
  assert.equal(updatePollIntervalMs(status('checking')), UPDATE_POLL_ACTIVE_MS)
  assert.equal(updatePollIntervalMs(status('error')), UPDATE_POLL_ERROR_MS)
  assert.equal(updatePollIntervalMs(status('idle')), UPDATE_POLL_IDLE_MS)
  assert.equal(
    updatePollIntervalMs(status('downloaded', { version: '0.1.2' })),
    UPDATE_POLL_IDLE_MS,
  )
  // 0 表示停止：开发态与冒烟态下没有可等的东西，一直轮询只是白耗。
  assert.equal(updatePollIntervalMs(status('unsupported')), 0)
  assert.equal(updatePollIntervalMs(null), UPDATE_POLL_IDLE_MS)
})

test('🔴 内容没变时视为同一个状态（否则轮询定时器会被无限重置）', () => {
  // 轮询每 30 秒拿回一个内容相同的新对象。直接 setState 会让 React 因引用变化而重渲染，
  // 而重渲染又重建定时器 —— 「每 30 秒查一次」于是变成「每 30 秒重置一次计时」，
  // 永远不会真的推进。这条断言钉住的就是那个静默失效。
  const a = status('up-to-date')
  const b = status('up-to-date')
  assert.notEqual(a, b)
  assert.equal(isSameUpdateStatus(a, b), true)

  assert.equal(isSameUpdateStatus(null, null), true)
  assert.equal(isSameUpdateStatus(a, null), false)
  assert.equal(isSameUpdateStatus(null, a), false)

  assert.equal(
    isSameUpdateStatus(
      status('downloading', { percent: 0.1 }),
      status('downloading', { percent: 0.2 }),
    ),
    false,
  )
  assert.equal(
    isSameUpdateStatus(
      status('downloaded', { version: '0.1.2' }),
      status('downloaded', { version: '0.1.3' }),
    ),
    false,
  )
})

// ── 跨包契约：两侧的阶段名不许漂移 ──────────────────────────────────────

test('web 侧阶段清单与 desktop 侧 UpdatePhase 联合完全一致', () => {
  const source = readFileSync(new URL('../../desktop/src/update.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export type UpdatePhase =')
  const end = source.indexOf('export type UpdateStatus', start)
  assert.ok(start >= 0 && end > start, '在 apps/desktop/src/update.ts 里找不到 UpdatePhase 的定义')

  const declared = [
    ...new Set([...source.slice(start, end).matchAll(/'([a-z][a-z-]*)'/g)].map((m) => m[1])),
  ]
  assert.deepEqual(
    [...declared].sort(),
    [...DESKTOP_UPDATE_PHASES].sort(),
    '两侧阶段名不一致 —— 多出来的那个会落进「不认识」的分支，界面上少一条提示且不报错',
  )
})

test('desktop 状态机产出的每个阶段，web 侧都能原样解析', () => {
  // 每条序列都从初始态出发，单独走到一个阶段 —— 不能串成一条：状态机有一条不变量是
  // 「已下载之后其他事件一律不改状态」，串起来会走不到 unsupported / error。
  const sequences = [
    [],
    [{ type: 'checking' }],
    [{ type: 'available', version: '0.1.2' }],
    [{ type: 'progress', percent: 42 }],
    [{ type: 'downloaded', version: '0.1.2' }],
    [{ type: 'not-available' }],
    [{ type: 'unsupported', detail: '开发态不检查更新' }],
    [{ type: 'error', detail: 'boom' }],
  ]

  const seen = new Set()
  for (const events of sequences) {
    let current = initialUpdateStatus()
    for (const event of events) current = applyUpdateEvent(current, event)
    seen.add(current.phase)

    const parsed = parseDesktopUpdateStatus(current)
    assert.notEqual(parsed, null, `阶段 ${current.phase} 过不了 web 侧的校验`)
    assert.deepEqual(parsed, current, `阶段 ${current.phase} 经过校验后字段变了`)
    // 并且必须映射到一个真正的视图，而不是抛错。
    assert.ok(buildDesktopUpdateView(parsed, 'desktop').kind !== undefined)
  }

  assert.deepEqual([...seen].sort(), [...DESKTOP_UPDATE_PHASES].sort())
})

/* ---------------- 下载详情：大小、速度、已用/剩余时间、停住（0.1.6） ---------------- */

/**
 * 这一组守的是「面板上那几个数字」。
 *
 * 它们的失败模式全是「看着正常但读数是错的」：把 1024 当 1000 用（界面写 112 MB、
 * 资源管理器写 107 MB）、速度未知时显示「剩余 0 秒」、卡住之后「已用 00:18」不再
 * 走动。这三种都不会抛错，只能在用例里钉住。
 */

const MB = 1024 * 1024

/** 造一个「正在下载」的状态。 */
function downloadingStatus(overrides = {}) {
  return {
    phase: 'downloading',
    version: '0.2.0',
    percent: 0.42,
    detail: '',
    transfer: {
      transferred: 42 * MB,
      total: 100 * MB,
      bytesPerSecond: 2 * MB,
      startedAt: 1_000_000,
      updatedAt: 1_000_000 + 18_000,
    },
    ...overrides,
  }
}

test('formatBytes 用 1024 进制，与资源管理器一致', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(20 * 1024), '20 KB')
  assert.equal(formatBytes(112 * MB), '112 MB')
  assert.equal(formatBytes(2.5 * MB), '2.5 MB')
  assert.equal(formatBytes(1.5 * 1024 * MB), '1.5 GB')
  assert.equal(formatBytes(null), '—')
  assert.equal(formatBytes(Number.NaN), '—')
})

test('formatDuration：一分钟以内直接写秒，超过写 mm:ss，再长写 h:mm:ss', () => {
  assert.equal(formatDuration(18_000), '18 秒')
  assert.equal(formatDuration(0), '0 秒')
  assert.equal(formatDuration(89_000), '1:29')
  assert.equal(formatDuration(3_723_000), '1:02:03')
  assert.equal(formatDuration(null), '—')
  assert.equal(formatDuration(-1), '—')
})

test('computeEtaMs：速度未知或为 0 时返回 null，绝不返回 0', () => {
  assert.equal(computeEtaMs(42 * MB, 100 * MB, null), null)
  assert.equal(computeEtaMs(42 * MB, 100 * MB, 0), null)
  assert.equal(computeEtaMs(42 * MB, null, 2 * MB), null)
  // 58 MB / 2 MB/s = 29 秒
  assert.equal(computeEtaMs(42 * MB, 100 * MB, 2 * MB), 29_000)
  // 已经下满：剩余 0，是确定的
  assert.equal(computeEtaMs(100 * MB, 100 * MB, 2 * MB), 0)
  // 超过一天的估算没有决策价值
  assert.equal(computeEtaMs(0, 100 * 1024 * MB, 1), null)
})

test('下载中：面板拿到大小、速度、已用与剩余时间', () => {
  const view = buildDesktopUpdateView(downloadingStatus(), 'desktop', 1_000_000 + 18_000)
  assert.equal(view.kind, 'downloading')
  assert.equal(view.transferred, 42 * MB)
  assert.equal(view.total, 100 * MB)
  assert.equal(view.speed, 2 * MB)
  assert.equal(view.elapsedMs, 18_000)
  assert.equal(view.etaMs, 29_000)
  assert.equal(view.stalled, false)
  assert.equal(view.sizeText, '42 MB / 100 MB')
  assert.equal(view.metaText, '2 MB/s · 已用 18 秒 · 剩余 29 秒')
})

test('🔴 进度几秒没动就报「已暂停」，且速度不再冒充正常值', () => {
  const status = downloadingStatus()
  const view = buildDesktopUpdateView(status, 'desktop', 1_000_000 + 18_000 + UPDATE_STALL_MS)
  assert.equal(view.kind, 'downloading')
  assert.equal(view.stalled, true)
  assert.match(view.metaText, /^已暂停/)
  assert.equal(view.metaText.includes('MB/s'), false, '停住时不该还写一个速度')
})

test('已经下满但还没收到完成事件时不算停住（那只是上游还没发下一个事件）', () => {
  const status = downloadingStatus({
    percent: 1,
    transfer: {
      transferred: 100 * MB,
      total: 100 * MB,
      bytesPerSecond: 0,
      startedAt: 1_000_000,
      updatedAt: 1_000_000,
    },
  })
  const view = buildDesktopUpdateView(status, 'desktop', 1_000_000 + 60_000)
  assert.equal(view.kind, 'downloading')
  assert.equal(view.stalled, false)
})

test('拿不到字节级事实时，面板不编造大小与速度', () => {
  const view = buildDesktopUpdateView(
    downloadingStatus({ transfer: null, percent: null }),
    'desktop',
    1_000_000,
  )
  assert.equal(view.kind, 'downloading')
  assert.equal(view.sizeText, '正在获取大小…')
  assert.equal(view.metaText, '速度 — · 已用 — · 剩余 —')
})

test('下载中断：失败态带上「已经下到多少」', () => {
  const view = buildDesktopUpdateView(
    { ...downloadingStatus(), phase: 'error', detail: 'net::ERR_CONNECTION_RESET' },
    'desktop',
    1_000_000,
  )
  assert.equal(view.kind, 'failed')
  assert.equal(view.text, '下载中断')
  assert.equal(view.progressText, '42 MB / 100 MB')
  assert.match(view.title, /ERR_CONNECTION_RESET/)
})

test('检查阶段就失败时不显示进度（那时一个字节都没下）', () => {
  const view = buildDesktopUpdateView(
    { phase: 'error', version: null, percent: null, transfer: null, detail: 'ENOTFOUND' },
    'desktop',
    1_000_000,
  )
  assert.equal(view.kind, 'failed')
  assert.equal(view.text, '更新检查失败')
  assert.equal(view.progressText, null)
})

test('下载完成：就绪态带上安装包大小', () => {
  const view = buildDesktopUpdateView(
    {
      phase: 'downloaded',
      version: '0.2.0',
      percent: 1,
      transfer: {
        transferred: 112 * MB,
        total: 112 * MB,
        bytesPerSecond: null,
        startedAt: 1_000_000,
        updatedAt: 1_000_000,
      },
      detail: '',
    },
    'desktop',
    1_000_000,
  )
  assert.equal(view.kind, 'ready')
  assert.equal(view.sizeText, '112 MB')
})

test('字节级事实形状不对时整体归 null（半份数据会画出「0 B / —」的假卡死）', () => {
  const parsed = parseDesktopUpdateStatus({
    phase: 'downloading',
    version: '0.2.0',
    percent: 0.4,
    detail: '',
    transfer: { total: 100 * MB, bytesPerSecond: 2 * MB },
  })
  assert.equal(parsed.transfer, null)
})

test('🔴 字节数变了就是新状态（否则每秒的进度不会触发重渲染）', () => {
  const a = parseDesktopUpdateStatus({
    phase: 'downloading',
    version: '0.2.0',
    percent: 0.4,
    detail: '',
    transfer: {
      transferred: 40 * MB,
      total: 100 * MB,
      bytesPerSecond: 2 * MB,
      startedAt: 1,
      updatedAt: 2,
    },
  })
  const b = parseDesktopUpdateStatus({
    phase: 'downloading',
    version: '0.2.0',
    percent: 0.4,
    detail: '',
    transfer: {
      transferred: 41 * MB,
      total: 100 * MB,
      bytesPerSecond: 2 * MB,
      startedAt: 1,
      updatedAt: 3,
    },
  })
  assert.equal(isSameUpdateStatus(a, b), false)
})
