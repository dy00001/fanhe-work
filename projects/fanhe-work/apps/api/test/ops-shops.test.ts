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
/**
 * 心跳也用独立主键。
 *
 * 真实那一行由常驻进程每分钟刷新；测试要把它改成过期时间来验离线，如果共用
 * `watch`，`after` 里删掉的就是运行时状态，界面会立刻显示「采集器从未启动」。
 * 首版就是这样，一次 `pnpm test` 之后自检说采集器没启动过。
 */
const HEARTBEAT_ID = 'zz-test-watch'
process.env.OPS_HEARTBEAT_ID = HEARTBEAT_ID

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
const { isShopVisible, listOpsShops } = await import('../src/ops/query.js')

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
    /* 只清自己那行。共用 `watch` 会把运行时状态一起删掉（见文件头）。 */
    await prisma.opsCollectorHeartbeat.deleteMany({ where: { id: HEARTBEAT_ID } })
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
      where: { id: HEARTBEAT_ID },
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

  test('补登记端口：不必解绑，库与槽位表同时更新', async () => {
    /* 早期种子里进来的店没有 collect_port，界面显示「端口未登记」。为了填一个
       数字去解绑再绑定，会把槽位的 collect 先置 false 再打开，属于自造故障窗口。 */
    await prisma.ecomShop.update({ where: { code: SHOP_CODE }, data: { collectPort: null } })

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/ops/shops/${SHOP_CODE}`,
      headers: auth(adminToken),
      payload: { collectPort: 9403 },
    })
    assert.equal(response.statusCode, 200, response.body)

    const body = JSON.parse(response.body) as {
      shop: { collectPort: number | null; enabled: boolean }
      slot: { kind: string }
    }
    assert.equal(body.shop.collectPort, 9403, response.body)
    assert.equal(body.slot.kind, 'synced', response.body)

    /* 摘要里没有 enabled 字段，用「仍在列表里」证明没有被顺手解绑。 */
    const listed = await app.inject({
      method: 'GET',
      url: '/api/ops/shops',
      headers: auth(adminToken),
    })
    const listBody = JSON.parse(listed.body) as { shops: Array<{ code: string }> }
    assert.ok(
      listBody.shops.some((item) => item.code === SHOP_CODE),
      '补登记之后这家店必须还在启用列表里',
    )

    const row = await prisma.ecomShop.findUnique({
      where: { code: SHOP_CODE },
      select: { collectPort: true },
    })
    assert.equal(row?.collectPort, 9403, '库里必须真的写进去')

    const slots = JSON.parse(fs.readFileSync(SLOTS_FILE, 'utf8')) as {
      shops: Array<{ code: string; port: number; collect: boolean }>
    }
    const slot = slots.shops.find((item) => item.code === SHOP_CODE)
    assert.equal(slot?.port, 9403)
    assert.equal(slot?.collect, true, '补登记之后采集器仍应采这家')
  })

  test('补登记时端口被别人占用要拒绝，并说清被谁占', async () => {
    /* 必须真的造一个占位店：库里如果没有别的店用这个端口，200 才是正确结果，
       那样这条用例就成了「什么都没验」。 */
    await prisma.ecomShop.create({
      data: {
        code: OTHER_CODE,
        name: '占位店',
        platform: 'taobao',
        collectPort: 9402,
        enabled: true,
        boundAt: new Date(),
      },
    })

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/ops/shops/${SHOP_CODE}`,
      headers: auth(adminToken),
      payload: { collectPort: 9402 },
    })
    assert.equal(response.statusCode, 409, response.body)
    const body = JSON.parse(response.body) as { error: string; message: string }
    assert.equal(body.error, 'port_conflict')
    assert.match(body.message, new RegExp(OTHER_CODE))
  })

  test('补登记不存在的店返回 404', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/ops/shops/zz-not-there',
      headers: auth(adminToken),
      payload: { collectPort: 9404 },
    })
    assert.equal(response.statusCode, 404, response.body)
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

/**
 * 归属可见性。
 *
 * 直接测函数而不是走 HTTP：HTTP 那层的入口权限点（`ops.shop.bind`）已经单独
 * 验过，这里要验的是「同一个人能看见哪些行」这条规则本身。走 HTTP 还得先造一个
 * 「有 read 没有 bind」的角色，测的东西会跑偏。
 */
describe('店铺归属与可见性', () => {
  const PUBLIC_CODE = 'zz-vis-public'
  const A_CODE = 'zz-vis-a'
  const B_CODE = 'zz-vis-b'
  let userA = ''
  let userB = ''

  before(async () => {
    await prisma.ecomShop.deleteMany({ where: { code: { in: [PUBLIC_CODE, A_CODE, B_CODE] } } })

    const role = await prisma.role.findFirst({ select: { id: true } })
    assert.ok(role !== null, '需要至少一个角色')
    const makeUser = async (username: string) =>
      (
        await prisma.user.create({
          data: {
            username,
            displayName: username,
            passwordHash: 'x',
            roleId: role.id,
          },
          select: { id: true },
        })
      ).id
    userA = await makeUser(`zz-vis-a-${process.pid}`)
    userB = await makeUser(`zz-vis-b-${process.pid}`)

    const base = { platform: 'taobao' as const, enabled: true, boundAt: new Date() }
    await prisma.ecomShop.createMany({
      data: [
        { ...base, code: PUBLIC_CODE, name: '公共店', ownerId: null },
        { ...base, code: A_CODE, name: 'A 的店', ownerId: userA },
        { ...base, code: B_CODE, name: 'B 的店', ownerId: userB },
      ],
    })
  })

  after(async () => {
    await prisma.ecomShop.deleteMany({ where: { code: { in: [PUBLIC_CODE, A_CODE, B_CODE] } } })
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } })
  })

  test('普通账号只看到「自己的 + 公共的」', async () => {
    const shops = await listOpsShops({ userId: userA, canSeeAll: false })
    const codes = shops.map((shop) => shop.code)

    assert.ok(codes.includes(PUBLIC_CODE), '公共店必须可见，否则种子店会一夜之间对所有人消失')
    assert.ok(codes.includes(A_CODE), '自己的店必须可见')
    assert.ok(!codes.includes(B_CODE), '别人的店不该出现')
  })

  test('持绑定权限的账号看到全部', async () => {
    const shops = await listOpsShops({ userId: userA, canSeeAll: true })
    const codes = shops.map((shop) => shop.code)
    assert.ok(codes.includes(B_CODE), '管理员必须看得到别人的店，否则改不了归属')
  })

  test('按代号操作也要判可见性，不能只靠列表过滤', async () => {
    assert.equal(await isShopVisible(A_CODE, { userId: userA, canSeeAll: false }), true)
    assert.equal(await isShopVisible(B_CODE, { userId: userA, canSeeAll: false }), false)
    assert.equal(
      await isShopVisible(B_CODE, { userId: userA, canSeeAll: true }),
      true,
      '管理员看得到全部',
    )
  })

  test('归属显示名跟着账号走', async () => {
    const shops = await listOpsShops({ userId: userA, canSeeAll: true })
    const own = shops.find((shop) => shop.code === A_CODE)
    assert.equal(own?.ownerId, userA)
    assert.ok((own?.ownerName ?? '').startsWith('zz-vis-a'), '界面要显示归属人名而不是 id')
    const publicShop = shops.find((shop) => shop.code === PUBLIC_CODE)
    assert.equal(publicShop?.ownerId, null)
    assert.equal(publicShop?.ownerName, null)
  })
})
