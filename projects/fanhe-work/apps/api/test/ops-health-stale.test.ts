/**
 * 「采集记录停在 running 太久」的回归测试（批次 2.2）。
 *
 * 要防的是一个静默的假象：进程在入库中途死掉、补写 `failed` 也失败时，库里会留下
 * 一条永远是 `running` 的记录。界面把它显示成「采集中」，而运维看到「正在采」就
 * 不会去查 —— 这条记录的危害不是数据错，是**把故障伪装成进展**。
 *
 * 三条断言各自守一件事：
 *
 *   1. 超过阈值 → `stale: true`，但 `status` 仍是 `running`（不改写库里的审计事实）。
 *   2. 没超阈值 → `stale: false`，慢一点的正常批次不能被报成中断。
 *   3. 别的状态时间再久 → 恒 `false`，历史记录不能因为「老」就变成故障。
 *
 * 判定基准时间由 `loadOpsHealth` 的第三个参数注入，不靠等十分钟。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import { OPS_LIMITS } from '@fanhe/shared'

import { resolveTestDatabaseUrl } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { loadOpsHealth } = await import('../src/ops/query.js')

const SHOP_CODE = 'zz_test_ops_stale'
const NOW = Date.parse('2026-10-21T12:00:00.000Z')
const LIMIT = OPS_LIMITS.COLLECT_RUNNING_TIMEOUT_MS

const asDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

describe('采集记录超时判定', { skip: databaseUrl === null ? '数据库不可达' : false }, () => {
  let shopId = ''

  before(async () => {
    await prisma.ecomShop.deleteMany({ where: { code: SHOP_CODE } })
    const shop = await prisma.ecomShop.create({
      data: { code: SHOP_CODE, name: 'zz_test_采集超时', platform: 'taobao' },
      select: { id: true },
    })
    shopId = shop.id

    const mk = (status: 'running' | 'succeeded', startedOffsetMs: number) =>
      prisma.ecomCollectRun.create({
        data: {
          shopId,
          statFrom: asDate('2026-10-20'),
          statTo: asDate('2026-10-20'),
          trigger: 'schedule',
          source: 'report',
          status,
          startedAt: new Date(NOW + startedOffsetMs),
          finishedAt: status === 'succeeded' ? new Date(NOW + startedOffsetMs + 120) : null,
          durationMs: status === 'succeeded' ? 120 : null,
        },
        select: { id: true },
      })

    // 超时的那条：比阈值多 1 毫秒。
    await mk('running', -LIMIT - 1)
    // 正常在跑的那条：只过去 1 分钟。
    await mk('running', -60_000)
    // 同年龄但已完成的那条：不该被判超时。
    await mk('succeeded', -LIMIT - 1)
  })

  after(async () => {
    await prisma.ecomShop.deleteMany({ where: { code: SHOP_CODE } })
    await prisma.$disconnect()
  })

  test('超过阈值的 running 标为 stale，但状态本身不改写', async () => {
    const health = await loadOpsHealth(SHOP_CODE, 20, NOW)
    assert.ok(health !== null)

    const stale = health.runs.find((run) => run.stale)
    assert.ok(stale !== undefined, '应当有一条被判为超时')
    // 审计事实是库里那条 `running`，不能在读路径上篡改成 failed ——
    // 那会让「补写失败」与「真的失败」在库里长得一样。
    assert.equal(stale.status, 'running')
    assert.equal(stale.stale, true)
    assert.equal(stale.finishedAt, null)
  })

  test('未超阈值的 running 不标 stale', async () => {
    const health = await loadOpsHealth(SHOP_CODE, 20, NOW)
    assert.ok(health !== null)

    const fresh = health.runs.find(
      (run) => run.status === 'running' && Date.parse(run.startedAt) > NOW - LIMIT,
    )
    assert.ok(fresh !== undefined, '应当有一条一分钟前开始的 running')
    assert.equal(fresh.stale, false)
  })

  test('已完成的记录无论多老都不标 stale', async () => {
    const health = await loadOpsHealth(SHOP_CODE, 20, NOW)
    assert.ok(health !== null)

    const done = health.runs.find((run) => run.status === 'succeeded')
    assert.ok(done !== undefined)
    assert.equal(done.stale, false)
    // 与它同时长的那条 running 是超时的，两者必须不同 —— 这正是「按状态而非按年龄」的判据。
    assert.equal(health.runs.filter((run) => run.stale).length, 1)
  })
})
