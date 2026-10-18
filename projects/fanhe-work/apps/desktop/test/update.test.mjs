/**
 * 更新通道状态机的回归测试（T6-03b）。
 *
 * ## 为什么这些用例值得写
 *
 * 更新通道的失败模式几乎都是**状态被错误地覆盖**，而不是算错某个值：
 *
 * - 已下载好的新版因为后台又跑了一次检查而丢失 → 用户点了「重启更新」什么也没发生；
 * - 下载失败把「有哪一版」也一起清掉 → 日志里只剩一个 error，没有任何线索；
 * - 只收到进度就编出一个版本号 → 界面显示一个不存在的版本。
 *
 * 这三种都**不会**在正常路径上出现，也就不会在手工点一遍界面时被发现；而在真机上
 * 复现它们要发两版、等一次下载。所以判据必须是「喂事件序列、断言最终状态」。
 *
 * ## 反例测试
 *
 * 光有正向用例不足以说明断言有效 —— 比如「已就绪后不被抹掉」这一组，如果
 * `applyUpdateEvent` 忽略了 `isReady` 那条短路，用例会不会红？本文件末尾那两条
 * 反例直接构造「故意写错」的期望值，确认断言真的能分辨两种实现。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applyUpdateEvent,
  describeUpdateStatus,
  initialUpdateStatus,
  isReadyToInstall,
} from '../src/update.ts'

/** 按顺序喂一串事件，返回最终状态。 */
function run(events) {
  let status = initialUpdateStatus()
  for (const event of events) status = applyUpdateEvent(status, event)
  return status
}

test('初始态是 idle，且没有已知版本', () => {
  const status = initialUpdateStatus()
  assert.equal(status.phase, 'idle')
  assert.equal(status.version, null)
  assert.equal(status.percent, null)
})

test('检查 → 有新版 → 下载 → 完成，四步到达可安装', () => {
  const status = run([
    { type: 'checking' },
    { type: 'available', version: '0.2.0' },
    { type: 'progress', percent: 42 },
    { type: 'downloaded', version: '0.2.0' },
  ])
  assert.equal(status.phase, 'downloaded')
  assert.equal(status.version, '0.2.0')
  assert.equal(isReadyToInstall(status), true)
})

test('检查完成但没有新版时给出 up-to-date，而不是回到 idle', () => {
  // 「检查过且没有新版」是结论，「还没检查过」是初始态；两者在排障时动作相反。
  const status = run([{ type: 'checking' }, { type: 'not-available' }])
  assert.equal(status.phase, 'up-to-date')
  assert.notEqual(status.phase, 'idle')
})

test('没有新版时不保留上一次检查留下的版本号', () => {
  // 否则界面可能拿着一个过期的版本号显示「有新版」。
  const status = run([
    { type: 'available', version: '0.2.0' },
    { type: 'checking' },
    { type: 'not-available' },
  ])
  assert.equal(status.version, null)
})

test('🔴 已下载的更新不会被后续的检查/失败抹掉', () => {
  const ready = run([
    { type: 'available', version: '0.2.0' },
    { type: 'downloaded', version: '0.2.0' },
  ])

  // 应用开一整天，后台可能又检查了好几次，其中一次可能失败。
  for (const event of [
    { type: 'checking' },
    { type: 'not-available' },
    { type: 'error', detail: '网络不可达' },
    { type: 'progress', percent: 10 },
  ]) {
    const after = applyUpdateEvent(ready, event)
    assert.equal(after.phase, 'downloaded', `事件 ${event.type} 不该改变已就绪状态`)
    assert.equal(after.version, '0.2.0')
    assert.equal(isReadyToInstall(after), true)
  }
})

test('错误保留已知的版本与进度（下载到一半失败是可诊断的）', () => {
  const status = run([
    { type: 'available', version: '0.2.0' },
    { type: 'progress', percent: 37 },
    { type: 'error', detail: '连接被重置' },
  ])
  assert.equal(status.phase, 'error')
  assert.equal(status.version, '0.2.0', '报错的是这次动作，不是「不知道有哪一版」')
  assert.equal(status.percent, 0.37)
  assert.equal(status.detail, '连接被重置')
})

test('只收到进度时把阶段推进到 downloading，但不编造版本号', () => {
  const status = run([{ type: 'progress', percent: 5 }])
  assert.equal(status.phase, 'downloading')
  assert.equal(status.version, null, '只知道有字节在下载，不知道是哪一版')
})

test('进度归一化：0~100 收成 0~1，越界夹住，非有限值归 null', () => {
  assert.equal(run([{ type: 'progress', percent: 0 }]).percent, 0)
  assert.equal(run([{ type: 'progress', percent: 50 }]).percent, 0.5)
  assert.equal(run([{ type: 'progress', percent: 100 }]).percent, 1)
  assert.equal(run([{ type: 'progress', percent: -5 }]).percent, 0)
  assert.equal(run([{ type: 'progress', percent: 130 }]).percent, 1)
  // 非有限值一律归 null（「拿不到进度」），**不夹成 1**。
  // 把一个坏值说成「下载完了」比不显示进度更糟：界面会据此提示「新版已就绪」，
  // 而实际上下载可能根本没开始。NaN 参与的比较全为假，留着它还会让下游的
  // `>= 100` 判断永远不成立，看起来像进度条卡住。
  assert.equal(run([{ type: 'progress', percent: Number.NaN }]).percent, null)
  assert.equal(run([{ type: 'progress', percent: Number.POSITIVE_INFINITY }]).percent, null)
  assert.equal(run([{ type: 'progress', percent: Number.NEGATIVE_INFINITY }]).percent, null)
})

test('不可用形态给出 unsupported，并带上原因', () => {
  const status = run([{ type: 'unsupported', detail: '开发态不检查更新' }])
  assert.equal(status.phase, 'unsupported')
  assert.equal(status.detail, '开发态不检查更新')
  assert.equal(isReadyToInstall(status), false)
})

test('只有 downloaded 才允许安装 —— 其它阶段一律拒绝', () => {
  for (const events of [
    [],
    [{ type: 'checking' }],
    [{ type: 'available', version: '0.2.0' }],
    [{ type: 'progress', percent: 90 }],
    [{ type: 'not-available' }],
    [{ type: 'error', detail: 'x' }],
    [{ type: 'unsupported', detail: 'x' }],
  ]) {
    assert.equal(isReadyToInstall(run(events)), false)
  }
})

test('日志行只写出有值的字段，不用 null 占位', () => {
  const line = describeUpdateStatus(initialUpdateStatus())
  assert.equal(line, '阶段=idle')
  assert.ok(!line.includes('版本='), '没有版本号时不该出现「版本=null」')

  const downloading = describeUpdateStatus({
    phase: 'downloading',
    version: '0.2.0',
    percent: 0.42,
    detail: '',
  })
  assert.ok(downloading.includes('进度=42%'))
  assert.ok(downloading.includes('版本=0.2.0'))
})

// ─── 反例：确认上面的断言不是恒真的 ────────────────────────────────────────
//
// 这一组针对的是「🔴 已下载的更新不会被抹掉」那条。做法是构造一个**故意漏掉
// isReady 短路**的等价实现，断言它与真实实现给出不同结果 —— 如果两者结果一样，
// 就说明那条断言其实什么都没守住。

test('反例：漏掉 isReady 短路的实现会被这条用例抓住', () => {
  /** 与 applyUpdateEvent 同形，但去掉了「已就绪就不再变」的那条短路。 */
  function naive(current, event) {
    if (event.type === 'checking')
      return { phase: 'checking', version: null, percent: null, detail: '' }
    if (event.type === 'error')
      return {
        phase: 'error',
        version: current.version,
        percent: current.percent,
        detail: event.detail,
      }
    return current
  }

  const ready = { phase: 'downloaded', version: '0.2.0', percent: 1, detail: '' }
  assert.equal(isReadyToInstall(applyUpdateEvent(ready, { type: 'error', detail: 'x' })), true)
  assert.equal(
    isReadyToInstall(naive(ready, { type: 'error', detail: 'x' })),
    false,
    '缺了短路的实现必须给出不同结论',
  )
})

test('反例：把非有限进度归一成 0 而不是 null，会被进度用例抓住', () => {
  const withZero = { phase: 'downloading', version: null, percent: 0, detail: '' }
  const real = applyUpdateEvent(initialUpdateStatus(), { type: 'progress', percent: Number.NaN })
  assert.equal(real.percent, null)
  assert.notEqual(
    real.percent,
    withZero.percent,
    'null 与 0 必须能分辨 —— 前者是「拿不到」，后者是「刚开始」',
  )
})

/* ---------------- 字节级进度：大小、速度、时间（0.1.6） ---------------- */

/**
 * 这一组守的是「界面上那几个数字是不是真的来自事件」。
 *
 * 失败模式都很安静：速度恒为 0（看起来像卡死）、总大小被一次缺字段的进度冲成 null
 * （「剩余时间」闪一下就没了）、完成态停在 99%（用户以为还差一点）。它们都不会抛错。
 */

const MB = 1024 * 1024

/** 喂一串进度事件，返回最终状态。 */
function runProgress(samples) {
  let status = applyUpdateEvent(initialUpdateStatus(), { type: 'available', version: '0.2.0' })
  for (const sample of samples) status = applyUpdateEvent(status, { type: 'progress', ...sample })
  return status
}

test('第一条进度用上游自报的速度起头（本地还没有两个样本）', () => {
  const status = runProgress([
    { percent: 1, transferred: 1 * MB, total: 100 * MB, bytesPerSecond: 2 * MB, at: 1000 },
  ])
  assert.equal(status.transfer?.bytesPerSecond, 2 * MB)
  assert.equal(status.transfer?.startedAt, 1000)
  assert.equal(status.transfer?.updatedAt, 1000)
})

test('之后的速度由本地样本平滑得出，而不是照抄上游', () => {
  const status = runProgress([
    { percent: 1, transferred: 1 * MB, total: 100 * MB, bytesPerSecond: 1 * MB, at: 1000 },
    // 一秒内多下了 2 MB：瞬时 2 MB/s，与上一拍的 1 MB/s 按 0.35 混合 → 1.35 MB/s
    { percent: 3, transferred: 3 * MB, total: 100 * MB, bytesPerSecond: 99 * MB, at: 2000 },
  ])
  const speed = status.transfer?.bytesPerSecond ?? 0
  assert.ok(Math.abs(speed - 1.35 * MB) < 1024, `期望约 1.35 MB/s，实际 ${speed}`)
})

test('🔴 字节数不涨时速度衰减而不是立刻归零（一次卡顿不该把读数打到 0）', () => {
  const status = runProgress([
    { percent: 3, transferred: 3 * MB, total: 100 * MB, bytesPerSecond: 2 * MB, at: 1000 },
    { percent: 3, transferred: 3 * MB, total: 100 * MB, at: 2000 },
  ])
  const speed = status.transfer?.bytesPerSecond ?? 0
  assert.ok(speed > 0, '卡一拍之后速度应仍有正值')
  assert.ok(speed < 2 * MB, '速度必须下降，否则界面上看不出网络已经停了')
})

test('总大小某一次没给时沿用上一次，不被冲成 null', () => {
  const status = runProgress([
    { percent: 10, transferred: 10 * MB, total: 100 * MB, at: 1000 },
    { percent: 11, transferred: 11 * MB, at: 2000 },
  ])
  assert.equal(status.transfer?.total, 100 * MB, '总大小在一次下载里是常量')
})

test('没有字节数时 transfer 保持 null，只靠百分比（旧行为不退化）', () => {
  const status = runProgress([{ percent: 42 }])
  assert.equal(status.transfer, null)
  assert.equal(status.percent, 0.42)
})

test('下载失败时保留已下载量，能说出「下到 42 MB 断了」', () => {
  const downloading = runProgress([
    { percent: 42, transferred: 42 * MB, total: 100 * MB, bytesPerSecond: 2 * MB, at: 1000 },
  ])
  const failed = applyUpdateEvent(downloading, {
    type: 'error',
    detail: 'net::ERR_CONNECTION_RESET',
  })
  assert.equal(failed.phase, 'error')
  assert.equal(failed.transfer?.transferred, 42 * MB)
  assert.equal(failed.percent, 0.42)
  assert.match(describeUpdateStatus(failed), /已下载=42\.0\/100\.0MB/)
})

test('完成态把已下载量对齐到总大小（不显示 99%）', () => {
  const downloading = runProgress([
    { percent: 99.7, transferred: 99.7 * MB, total: 100 * MB, at: 1000 },
  ])
  const done = applyUpdateEvent(downloading, { type: 'downloaded', version: '0.2.0', at: 2000 })
  assert.equal(done.transfer?.transferred, 100 * MB)
  assert.equal(done.transfer?.bytesPerSecond, null, '完成之后速度不再有意义')
  assert.equal(done.percent, 1)
})

test('新一轮下载开始时清掉上一轮的字节数（否则会先显示 100% 再跳回 0%）', () => {
  const downloading = runProgress([
    { percent: 42, transferred: 42 * MB, total: 100 * MB, at: 1000 },
  ])
  const next = applyUpdateEvent(downloading, { type: 'available', version: '0.3.0' })
  assert.equal(next.transfer, null)
  assert.equal(next.percent, null)
})

test('日志行写出已下载与速度，且不出现 null 占位', () => {
  const status = runProgress([
    { percent: 42, transferred: 42 * MB, total: 100 * MB, bytesPerSecond: 2.5 * MB, at: 1000 },
  ])
  const line = describeUpdateStatus(status)
  assert.match(line, /已下载=42\.0\/100\.0MB/)
  assert.match(line, /速度=2\.5MB\/s/)
  assert.equal(line.includes('null'), false)
})
