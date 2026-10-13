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
