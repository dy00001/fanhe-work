/**
 * 默认区间的锚点必须跟着店铺走。
 *
 * 这个文件补的是一个**多店之后才会显形**的缺陷。首版 `latestCoveredDate` 不带店铺，
 * 取的是全库最大的业务日。单店时期两者等价，所以当时怎么测都对；五店都有数据之后，
 * 看板看的是哪一家、锚点却是「谁家最新算谁家」—— 一旦被看的那家落后于别的店，
 * 它的默认区间就整体越过自己的数据末日，首屏出现一段空白窗口。
 *
 * 这类缺陷的可怕之处在于**全程没有任何错误**：接口 200、字段齐全、KPI 有值（只是
 * 窗口偏了几天）。所以下面的断言必须能证伪 —— 第一条就是反例，把
 * `latestCoveredDate` 改回不带 `where` 的聚合，它会立刻红：
 *
 *   - 落后店的答案是 10-12，全局最大是 10-18，两个数字不一样。
 *
 * 反过来，如果为了「修好第一条」而把所有调用都改成按店，五店并列那张表又会坏：
 * 它同屏比较五家，锚点必须是全库最大。所以第 6、7 条把这两个口径**同时**钉住 ——
 * 只测其中一个，另一个方向上的错误就没有守卫。
 *
 * 数据带 `zz_test_` 前缀，结束按 code 级联删除（`ecom_daily_metrics` 的
 * `onDelete: Cascade`）。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { ROLE_CODES, type RoleCode } from '@fanhe/shared'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const { buildApp } = await import('../src/app.js')
const { latestCoveredDate, latestCoveredDateAllShops } = await import('../src/ops/query.js')

/** 落后店：数据止于 10-12，而全库最大是 10-18。 */
const LAG_CODE = 'zz_test_anchor_lag'
/** 领先店：数据止于 10-18，也就是全库最大那天。 */
const LEAD_CODE = 'zz_test_anchor_lead'
/** 有店铺、没逐日数据：锚点应为 null，而不是退回全局最大。 */
const EMPTY_CODE = 'zz_test_anchor_empty'

const TEST_PASSWORD = 'integration-test-password'
/** 与其它集成测试各用一个地址，避免并行跑时互相清掉登录尝试记录。 */
const TEST_IP = '198.51.100.45'

const asDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`)

async function databaseReachable(): Promise<boolean> {
  if (databaseUrl === null) return false
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

const reachable = await databaseReachable()

if (!reachable) {
  console.warn('[ops-anchor.test] 数据库不可达，锚点口径的集成测试未执行')
}

describe('默认区间锚点按店取值', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  let app: ReturnType<typeof buildApp>
  let token = ''
  let userId = ''

  before(async () => {
    const role = await prisma.role.findUnique({
      where: { code: ROLE_CODES.ADMIN satisfies RoleCode },
      select: { id: true },
    })
    if (role === null) throw new Error('库里没有 admin 角色，先执行 pnpm db:seed')

    await prisma.ecomShop.deleteMany({ where: { code: { in: [LAG_CODE, LEAD_CODE, EMPTY_CODE] } } })

    const lag = await prisma.ecomShop.create({
      data: { code: LAG_CODE, name: 'zz_test_落后店', platform: 'taobao' },
      select: { id: true },
    })
    const lead = await prisma.ecomShop.create({
      data: { code: LEAD_CODE, name: 'zz_test_领先店', platform: 'taobao' },
      select: { id: true },
    })
    await prisma.ecomShop.create({
      data: { code: EMPTY_CODE, name: 'zz_test_空店', platform: 'taobao' },
    })

    await prisma.ecomDailyMetric.createMany({
      data: [
        { shopId: lag.id, statDate: asDate('2026-10-10'), visitors: 10 },
        { shopId: lag.id, statDate: asDate('2026-10-12'), visitors: 12 },
        { shopId: lead.id, statDate: asDate('2026-10-16'), visitors: 16 },
        { shopId: lead.id, statDate: asDate('2026-10-18'), visitors: 18 },
      ],
    })

    const passwordHash = await hashPassword(TEST_PASSWORD)
    const user = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        passwordHash,
        displayName: '锚点测试',
        roleId: role.id,
      },
      select: { id: true, username: true },
    })
    userId = user.id

    const result = await login({ username: user.username, password: TEST_PASSWORD, ip: TEST_IP })
    if (!result.ok) throw new Error(`测试账号登录失败：${result.reason}`)
    token = result.data.accessToken

    app = buildApp({ logger: false })
  })

  after(async () => {
    await app.close()
    /* `zz_test_anchor_newest` 在用例内清理，这里再兜一次：中途异常退出也不留脏数据。 */
    await prisma.ecomShop.deleteMany({
      where: { code: { in: [LAG_CODE, LEAD_CODE, EMPTY_CODE, 'zz_test_anchor_newest'] } },
    })
    if (userId !== '') await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
  })

  test('落后店的锚点是它自己的 10-12，不是全库最大的 10-18', async () => {
    /* 反例断言：函数若忽略 shopId，这里会拿到 10-18。 */
    assert.equal(await latestCoveredDate(LAG_CODE), '2026-10-12')
  })

  test('领先店的锚点仍是 10-18（按店取值没有把「最新」这件事改坏）', async () => {
    assert.equal(await latestCoveredDate(LEAD_CODE), '2026-10-18')
  })

  test('有店铺但没逐日数据时返回 null，不借用别家店的最新日期', async () => {
    assert.equal(await latestCoveredDate(EMPTY_CODE), null)
  })

  test('店铺不存在时返回 null，调用方退回以今天为锚', async () => {
    assert.equal(await latestCoveredDate('zz_test_anchor_absent'), null)
  })

  test('全店口径取全库最大，供五店并列表使用', async () => {
    /*
     * 这里不能写死一个日期：库里还有真实店铺的数据，而真实数据每天都在往前长，
     * 「全库最大」只可能由库自己回答。所以拿一次独立聚合作为期望值。
     *
     * 这条断言守的是「并列口径没被顺手改成按店」，**守不住**「默认店恰好最新」那种
     * 巧合 —— 本机默认店（主店）就是最新的一家，两种口径此刻同值。真正把两个口径
     * 钉开的是下面第 6 条：落后店的看板必须止于 10-12，而不是 10-18。
     */
    const row = await prisma.ecomDailyMetric.aggregate({ _max: { statDate: true } })
    const expected = row._max.statDate?.toISOString().slice(0, 10) ?? null
    assert.equal(await latestCoveredDateAllShops(), expected)
    /* 并且不早于任何一家店的数据末日，否则并列表会把最新那天裁掉。 */
    assert.ok(
      expected !== null && expected >= '2026-10-18',
      `全库最大应覆盖测试造的领先店：${String(expected)}`,
    )
  })

  test('看板接口：带 shop 时区间止于该店数据末日', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/ops/dashboard?shop=${LAG_CODE}&days=7`,
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as { range: { from: string; to: string }; days: number }
    /* 修前这里是 10-12 ~ 10-18，整整 7 天窗口里前 5 天对这家店都是空的。 */
    assert.equal(body.range.to, '2026-10-12', `区间末日应跟着店铺走：${JSON.stringify(body.range)}`)
    assert.equal(body.range.from, '2026-10-06')
    assert.equal(body.days, 7)
  })

  test('非默认店比默认店新时，并列口径跟着最新的走，而不是跟着默认店', async () => {
    /*
     * 上一条在本机会同值通过，因为默认店恰好也是最新的一家 —— 那种断言看着绿，
     * 其实分不清两种口径。这里临时造一家「比默认店更新一天」的店，两种口径才被
     * 真正分开：并列接口若被改成按店取，答案会退回默认店的日期。
     *
     * 用「当前全库最大 + 1 天」而不是写死一个远期日期：造出来的行只比真实数据新
     * 一天，即便清理失败也只让并列表窗口后移一天，不会把看板推到几年后。
     */
    const newestCode = 'zz_test_anchor_newest'
    const before = await prisma.ecomDailyMetric.aggregate({ _max: { statDate: true } })
    const base = before._max.statDate ?? asDate('2026-10-18')
    const newer = new Date(base.getTime() + 86_400_000)

    const newest = await prisma.ecomShop.create({
      data: { code: newestCode, name: 'zz_test_最新店', platform: 'taobao' },
      select: { id: true },
    })
    await prisma.ecomDailyMetric.create({
      data: { shopId: newest.id, statDate: newer, visitors: 1 },
    })

    try {
      const newerIso = newer.toISOString().slice(0, 10)
      assert.equal(await latestCoveredDateAllShops(), newerIso)

      /* 默认店（启用中、最早建档）不是最新那家，两种口径的答案必须不同。 */
      const defaultAnchor = await latestCoveredDate(null)
      assert.notEqual(
        defaultAnchor,
        newerIso,
        '这条用例的前提没成立：默认店恰好也是最新的，两种口径分不开',
      )

      const response = await app.inject({
        method: 'GET',
        url: '/api/ops/overview-shops?days=7',
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(response.statusCode, 200, response.body)
      const body = response.json() as { range: { to: string } }
      assert.equal(
        body.range.to,
        newerIso,
        '并列口径取的是全库最大；退回默认店的日期说明被改成按店取值了',
      )
    } finally {
      await prisma.ecomShop.deleteMany({ where: { code: newestCode } })
    }
  })

  test('并列接口：不带 shop 时区间止于全库最大，五店同用一个窗口', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ops/overview-shops?days=7',
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as { range: { from: string; to: string }; days: number }

    /* 期望值同样取自库，理由见上一条。 */
    const row = await prisma.ecomDailyMetric.aggregate({ _max: { statDate: true } })
    const expected = row._max.statDate?.toISOString().slice(0, 10) ?? null
    assert.equal(body.range.to, expected)
    /* 窗口长度必须真的是 7 天：锚点对了但 span 算错，同样会少看几天。 */
    assert.equal(body.days, 7)
    const span =
      (Date.parse(`${body.range.to}T00:00:00.000Z`) -
        Date.parse(`${body.range.from}T00:00:00.000Z`)) /
      86_400_000
    assert.equal(span, 6, `7 天窗口的起止应相差 6 天：${JSON.stringify(body.range)}`)
  })
})
