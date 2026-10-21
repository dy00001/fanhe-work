/**
 * 运营看板读接口的 ETag 行为。
 *
 * 为什么单独测这一条：ETag 是「切回标签页就静默重取」这个动作能不能成立的前提。
 * 没有它，每次切回来都要拉一遍完整榜单，弱网下会把界面拖回加载态；有了它，内容
 * 没变就是 304、零字节，静默重取才真的是「静默」。
 *
 * 这类断言最容易写成恒真：只要状态码是 200 就通过，而 304 从未发生过。所以这里
 * 三条分开测 —— 首次拿到 ETag、带同一个 ETag 拿到 304、带过期的 ETag 拿到 200。
 * 少测第三条，「永远返回 304」这个坏实现也能全绿。
 *
 * 用 `inject` 走完整路由链路（preHandler、schema、序列化），因为 ETag 是在路由
 * 层加的：直接调 `loadOpsHealth` 测不到它。
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

const TEST_PASSWORD = 'integration-test-password'
/** 与其它集成测试各用一个地址，避免并行跑时互相清掉登录尝试记录。 */
const TEST_IP = '198.51.100.44'
const SHOP_CODE = 'zz_test_ops_etag'

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
  console.warn('[ops-etag.test] 数据库不可达，ETag 的集成测试未执行')
}

describe('运营读接口的 ETag', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  let app: ReturnType<typeof buildApp>
  let token = ''
  let userId = ''

  before(async () => {
    const role = await prisma.role.findUnique({
      where: { code: ROLE_CODES.ADMIN satisfies RoleCode },
      select: { id: true },
    })
    if (role === null) throw new Error('库里没有 admin 角色，先执行 pnpm db:seed')

    /* admin 默认带 ops 三个权限点，owner 之外的账号里只有它能读采集批次。 */
    await prisma.ecomShop.deleteMany({ where: { code: SHOP_CODE } })
    await prisma.ecomShop.create({
      data: {
        code: SHOP_CODE,
        name: 'zz_test_ETag 店铺',
        platform: 'taobao',
        lastCollectedAt: new Date('2026-10-19T00:30:00.000Z'),
      },
    })

    const passwordHash = await hashPassword(TEST_PASSWORD)
    const user = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        passwordHash,
        displayName: 'ETag 测试',
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
    await prisma.ecomShop.deleteMany({ where: { code: SHOP_CODE } })
    if (userId !== '') await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
  })

  const url = `/api/ops/health?shop=${SHOP_CODE}`

  test('首次响应带 ETag，且缓存指令允许私有缓存但必须回源', async () => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    })

    assert.equal(response.statusCode, 200, response.body)
    const etag = response.headers.etag
    assert.equal(typeof etag, 'string', '没有 ETag 就没有 304，静默重取会变成全量重拉')
    assert.ok(String(etag).startsWith('W/"'), `ETag 应为弱校验：${String(etag)}`)

    const cacheControl = String(response.headers['cache-control'] ?? '')
    assert.ok(cacheControl.includes('private'), `响应含裁剪后的金额，必须 private：${cacheControl}`)
    /* max-age=0 是刻意的：60 秒内吃本地缓存会让「刚采完就刷新」看到旧数。 */
    assert.ok(cacheControl.includes('max-age=0'), `必须每次回源验证：${cacheControl}`)
  })

  test('带同一个 ETag 返回 304，且没有响应体', async () => {
    const first = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    })
    const etag = String(first.headers.etag)

    const second = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, 'if-none-match': etag },
    })

    assert.equal(second.statusCode, 304, '内容没变就该是 304，否则静默重取等于全量重拉')
    assert.equal(second.body, '', '304 不能带响应体')
  })

  test('带过期的 ETag 仍返回 200 与完整内容', async () => {
    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}`, 'if-none-match': 'W/"stale-value"' },
    })

    assert.equal(response.statusCode, 200, '过期的 ETag 不能被当成命中，否则界面永远拿不到新数据')
    assert.ok(response.body.length > 0)
  })

  test('ETag 随内容变化，不是按路径算的常量', async () => {
    const before = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    })

    /* 直接改库：加一条采集批次，健康面板的内容必然变。 */
    const shop = await prisma.ecomShop.findUnique({
      where: { code: SHOP_CODE },
      select: { id: true },
    })
    assert.ok(shop !== null)
    await prisma.ecomCollectRun.create({
      data: {
        shopId: shop.id,
        statFrom: new Date('2026-10-19T00:00:00.000Z'),
        statTo: new Date('2026-10-19T00:00:00.000Z'),
        trigger: 'manual',
        source: 'report',
        status: 'succeeded',
        dailyRows: 1,
        dimensionRows: 0,
        finishedAt: new Date('2026-10-19T00:31:00.000Z'),
      },
    })

    const after = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    })

    assert.notEqual(
      before.headers.etag,
      after.headers.etag,
      '内容变了 ETag 必须变，否则浏览器会一直用旧的那份',
    )

    /* 旧 ETag 此时应当被拒绝：它是过期校验，不能命中。 */
    const stale = await app.inject({
      method: 'GET',
      url,
      headers: {
        authorization: `Bearer ${token}`,
        'if-none-match': String(before.headers.etag),
      },
    })
    assert.equal(stale.statusCode, 200, '旧 ETag 在内容变化后必须失效')
  })
})
