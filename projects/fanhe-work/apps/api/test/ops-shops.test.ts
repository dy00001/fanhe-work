/**
 * 店铺绑定入口的路由测试。
 *
 * 这一层要钉住的不是「能不能创建一行」，而是四件会安静出错的事：
 *
 *   1. **权限**。绑定能改采集配置（端口、槽位），没有 `ops.shop.bind` 的账号必须
 *      403。只测「管理员能绑」等于没测 —— 一个不挂 preHandler 的实现也会全绿。
 *   2. **冲突**。同代号重复绑定、同端口两家店，都必须 409 并指出冲突对象。
 *      放过任何一条，表现都是「两家店抢一个调试端口」，采到的必然是同一个账号。
 *   3. **解绑是软删**。列表里消失、待办里消失，但历史行与 `id` 还在；重新绑定同一
 *      代号要接上原来那行，否则逐日数据会留在一条再也采不到的老记录上。
 *   4. **待办与回写**。绑定即置 `syncRequestedAt`；采集器通过带 token 的回环接口
 *      取待办并回写登录态，回写后界面能读到。
 *
 * 数据用 `zz_test_` 前缀，结束按 code 删除。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { ROLE_CODES, type RoleCode } from '@fanhe/shared'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}
/* 采集接口的密钥在 env.ts 里是 getter，这里设就来得及。 */
const OPS_TOKEN = 'test-ops-ingest-token'
process.env.OPS_INGEST_TOKEN = OPS_TOKEN

/**
 * 槽位表指向临时文件。
 *
 * 不设这个变量时，绑定会写进仓库里真实的 `tools/collector/shops.config.json`：
 * 一次 `pnpm test` 就会给采集器留一条 `zz-test-ops-bind` 槽位，而且 JSON 重新
 * 序列化会把整个文件的排版改掉。首版正是这样污染了真实配置。
 */
const SLOTS_FILE = path.join(os.tmpdir(), `fanhe-ops-slots-${process.pid}.json`)
fs.writeFileSync(
  SLOTS_FILE,
  JSON.stringify(
    { version: 1, defaults: { platform: 'taobao', basePort: 9222 }, shops: [] },
    null,
    2,
  ),
  'utf8',
)
process.env.OPS_SLOTS_FILE = SLOTS_FILE

const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
const TEST_IP = '198.51.100.61'
/* 代号不允许下划线：采集器的 CODE_RE 与共享包的正则同源，测试数据也必须守这条规则。 */
const SHOP_CODE = 'zz-test-ops-bind'
const OTHER_CODE = 'zz-test-ops-bind-other'

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
  console.warn('[ops-shops.test] 数据库不可达，绑定入口的集成测试未执行')
}

describe('店铺绑定入口', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  let app: ReturnType<typeof buildApp>
  let adminToken = ''
  let memberToken = ''
  const userIds: string[] = []

  const auth = (token: string) => ({ authorization: `Bearer ${token}` })

  async function createUser(roleCode: RoleCode): Promise<string> {
    const role = await prisma.role.findUnique({ where: { code: roleCode }, select: { id: true } })
    if (role === null) throw new Error(`库里没有 ${roleCode} 角色，先执行 pnpm db:seed`)
    const passwordHash = await hashPassword(TEST_PASSWORD)
    const user = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        passwordHash,
        displayName: '绑定测试',
        roleId: role.id,
      },
      select: { id: true, username: true },
    })
    userIds.push(user.id)
    const result = await login({ username: user.username, password: TEST_PASSWORD, ip: TEST_IP })
    if (!result.ok) throw new Error(`测试账号登录失败：${result.reason}`)
    return result.data.accessToken
  }

  before(async () => {
    await prisma.ecomShop.deleteMany({ where: { code: { in: [SHOP_CODE, OTHER_CODE] } } })
    adminToken = await createUser(ROLE_CODES.ADMIN)
    memberToken = await createUser(ROLE_CODES.MEMBER)
    app = buildApp({ logger: false })
  })

  after(async () => {
    await app.close()
    await prisma.ecomShop.deleteMany({ where: { code: { in: [SHOP_CODE, OTHER_CODE] } } })
    if (userIds.length > 0) await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    /* 心跳是单行表，测试写进去之后不清掉，开发库的界面会一直显示「采集器在线」——
       而那台机器上其实没有常驻进程。 */
    await prisma.opsCollectorHeartbeat.deleteMany({ where: { id: 'watch' } })
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
    fs.rmSync(SLOTS_FILE, { force: true })
  })

  test('没有 ops.shop.bind 的账号不能绑定', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ops/shops',
      headers: auth(memberToken),
      payload: { code: SHOP_CODE, name: '绑定测试店', platform: 'taobao', collectPort: 9401 },
    })
    assert.equal(response.statusCode, 403, response.body)
  })

  test('绑定成功后返回店铺，且带上绑定时刻与待同步标记', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ops/shops',
      headers: auth(adminToken),
      payload: { code: SHOP_CODE, name: '绑定测试店', platform: 'taobao', collectPort: 9401 },
    })
    assert.equal(response.statusCode, 201, response.body)
    const body = JSON.parse(response.body) as {
      shop: {
        code: string
        loginState: string
        boundAt: string | null
        syncRequestedAt: string | null
      }
      slot: { kind: string }
    }
    assert.equal(body.shop.code, SHOP_CODE)
    assert.equal(body.shop.loginState, 'unknown', '刚绑定不该是 needs_login，那会误导人去重新登录')
    assert.notEqual(body.shop.boundAt, null)
    assert.notEqual(body.shop.syncRequestedAt, null, '绑定即请求同步，否则要等下一次定时')
    /* 槽位表已通过 `OPS_SLOTS_FILE` 指向临时文件，所以这里必须是 synced：
       写成「synced 或 manual 都算过」会让「写文件这条路整个坏掉」也全绿。 */
    assert.equal(body.slot.kind, 'synced', response.body)
    const slots = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8')) as {
      shops: Array<{ code: string; port: number; collect: boolean }>
    }
    const slot = slots.shops.find((item) => item.code === SHOP_CODE)
    assert.ok(slot !== undefined, '绑定必须把槽位写进配置文件，否则采集器不认识这家店')
    assert.equal(slot.port, 9401)
    assert.equal(slot.collect, true)
  })

  test('同代号重复绑定返回 409', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ops/shops',
      headers: auth(adminToken),
      payload: { code: SHOP_CODE, name: '另一家', platform: 'taobao', collectPort: 9402 },
    })
    assert.equal(response.statusCode, 409, response.body)
    assert.match(response.body, /已被占用/)
  })

  test('同端口两家店返回 409，并指出占用者', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ops/shops',
      headers: auth(adminToken),
      payload: { code: OTHER_CODE, name: '抢端口', platform: 'taobao', collectPort: 9401 },
    })
    assert.equal(response.statusCode, 409, response.body)
    assert.match(response.body, new RegExp(SHOP_CODE))
  })

  test('端口越界返回 400', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/ops/shops',
      headers: auth(adminToken),
      payload: { code: OTHER_CODE, name: '越界', platform: 'taobao', collectPort: 80 },
    })
    assert.equal(response.statusCode, 400, response.body)
  })

  test('列表里能读到绑定字段', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/ops/shops',
      headers: auth(adminToken),
    })
    assert.equal(response.statusCode, 200, response.body)
    const body = JSON.parse(response.body) as {
      shops: Array<{
        code: string
        collectPort: number | null
        loginState: string
        boundAt: string | null
      }>
    }
    const shop = body.shops.find((item) => item.code === SHOP_CODE)
    assert.ok(shop !== undefined, '刚绑定的店必须出现在列表里')
    assert.equal(shop.collectPort, 9401)
    assert.equal(shop.loginState, 'unknown')
  })

  test('采集器取待办：无 token 401，有 token 能拿到该店', async () => {
    const denied = await app.inject({ method: 'GET', url: '/api/ops/shops/pending' })
    assert.equal(denied.statusCode, 401, denied.body)

    const ok = await app.inject({
      method: 'GET',
      url: '/api/ops/shops/pending',
      headers: { 'x-ops-token': OPS_TOKEN },
    })
    assert.equal(ok.statusCode, 200, ok.body)
    const body = JSON.parse(ok.body) as { codes: string[] }
    assert.ok(body.codes.includes(SHOP_CODE), `待办里应有 ${SHOP_CODE}：${ok.body}`)
  })

  test('采集器回写登录态与失败原因，列表随之变化', async () => {
    const reported = await app.inject({
      method: 'POST',
      url: `/api/ops/shops/${SHOP_CODE}/state`,
      headers: { 'x-ops-token': OPS_TOKEN },
      payload: {
        loginState: 'needs_login',
        lastSyncError: '登录态失效：被重定向到登录页',
        clearSyncRequest: true,
      },
    })
    assert.equal(reported.statusCode, 200, reported.body)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/ops/shops',
      headers: auth(adminToken),
    })
    const body = JSON.parse(listed.body) as {
      shops: Array<{
        code: string
        loginState: string
        lastSyncError: string | null
        syncRequestedAt: string | null
      }>
    }
    const shop = body.shops.find((item) => item.code === SHOP_CODE)
    assert.ok(shop !== undefined)
    assert.equal(shop.loginState, 'needs_login')
    assert.match(String(shop.lastSyncError), /登录态失效/)
    assert.equal(shop.syncRequestedAt, null, '回写时 clearSyncRequest 为真就该清掉待办')

    const pending = await app.inject({
      method: 'GET',
      url: '/api/ops/shops/pending',
      headers: { 'x-ops-token': OPS_TOKEN },
    })
    const pendingBody = JSON.parse(pending.body) as { codes: string[] }
    assert.equal(pendingBody.codes.includes(SHOP_CODE), false, '已处理过的店不该留在待办里')
  })

  test('「立即同步」把待办重新置上', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/ops/shops/${SHOP_CODE}/sync`,
      headers: auth(adminToken),
    })
    assert.equal(response.statusCode, 202, response.body)
    const body = JSON.parse(response.body) as { shop: { syncRequestedAt: string | null } }
    assert.notEqual(body.shop.syncRequestedAt, null)
  })

  test('采集器拉过待办之后，店铺列表里的采集器状态变成在线', async () => {
    /* 上一条待办用例已经用 token 调过 pending，那一次就是心跳。 */
    const listed = await app.inject({
      method: 'GET',
      url: '/api/ops/shops',
      headers: auth(adminToken),
    })
    assert.equal(listed.statusCode, 200, listed.body)
    const body = JSON.parse(listed.body) as {
      collector: { lastSeenAt: string | null; online: boolean }
    }
    assert.equal(body.collector.online, true, listed.body)
    assert.notEqual(body.collector.lastSeenAt, null)
  })

  test('心跳过期之后显示离线，但最后一次心跳时刻仍然保留', async () => {
    /* 直接把心跳改成 10 分钟前。窗口是 3 分钟，这条必然判离线。 */
    await prisma.opsCollectorHeartbeat.update({
      where: { id: 'watch' },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) },
    })

    const listed = await app.inject({
      method: 'GET',
      url: '/api/ops/shops',
      headers: auth(adminToken),
    })
    const body = JSON.parse(listed.body) as {
      collector: { lastSeenAt: string | null; online: boolean }
    }
    assert.equal(body.collector.online, false, '超过窗口就必须判离线，否则这个灯没有意义')
    assert.notEqual(body.collector.lastSeenAt, null, '离线也要能显示「最后一次是什么时候」')
  })

  test('解绑是软删：列表消失、行还在、重新绑定接上同一个 id', async () => {
    const before = await prisma.ecomShop.findUnique({
      where: { code: SHOP_CODE },
      select: { id: true },
    })
    assert.ok(before !== null)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/ops/shops/${SHOP_CODE}`,
      headers: auth(adminToken),
    })
    assert.equal(removed.statusCode, 200, removed.body)

    const listed = await app.inject({
      method: 'GET',
      url: '/api/ops/shops',
      headers: auth(adminToken),
    })
    const body = JSON.parse(listed.body) as { shops: Array<{ code: string }> }
    assert.equal(
      body.shops.some((item) => item.code === SHOP_CODE),
      false,
      '解绑后不该出现在列表里',
    )

    const row = await prisma.ecomShop.findUnique({
      where: { code: SHOP_CODE },
      select: { id: true, enabled: true },
    })
    assert.ok(row !== null, '软删不能删行，历史指标靠 shopId 关联')
    assert.equal(row.enabled, false)

    const rebound = await app.inject({
      method: 'POST',
      url: '/api/ops/shops',
      headers: auth(adminToken),
      payload: { code: SHOP_CODE, name: '绑定测试店', platform: 'taobao', collectPort: 9401 },
    })
    assert.equal(rebound.statusCode, 201, rebound.body)
    const reboundBody = JSON.parse(rebound.body) as { shop: { id: string } }
    assert.equal(reboundBody.shop.id, before.id, '重新绑定必须接上原来那行，否则历史数据悬空')
  })
})
