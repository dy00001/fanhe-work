/**
 * 报价查价的接口行为。
 *
 * 这个模块的风险集中在两处，测试也就围着这两处写：
 *
 * 1. **写路径的准入**。判据是「角色 + 解锁令牌」，**不是一个权限点**（理由见
 *    `src/quote/access.ts` 顶部：`personal.*` 通配会把任何 write 点静默发给全部
 *    业务角色）。这种判据最容易写成恒真 —— 只要请求返回 200 就算通过，而「没带
 *    令牌的人也拿到了 200」在测试里看起来一模一样。所以正例反例成对写：同一个账号、
 *    同一个接口，差一个请求头就必须从 403 变成 200。
 *
 * 2. **口径**。`priceKind` 判错、`includeArchived` 漏掉、改价不 bump 版本号，这三件
 *    事在界面上都看不出异常（界面上仍然是一行价格）。
 *
 * ## 口令表是单行表，测试必须能还原它
 *
 * `quote_access_secrets` 只有一行，失败计数与锁定也挂在这一行上。测试要造「首次
 * 设置」「连错 5 次锁定」这些状态，就必须先清空它 —— 而如果本机已经有一个真的
 * 维护口令，那是用户的数据。所以 `before` 里把整行**快照下来**，`after` 里原样
 * 写回。少了这一步，跑一次测试就把店里的维护口令清掉了，而且不会有任何报错。
 *
 * 条目、图、审计、数据集版本都用 `zz_test_` 前缀 + 快照差集清理，不靠 `deleteMany`
 * 全表扫 —— 库里那 1225 条台账是真实数据。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { QUOTE_LIMITS, ROLE_CODES, type RoleCode } from '@fanhe/shared'

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
const SECRET_PASSWORD = 'kf-9sLx2-qm'
const SECRET_PASSWORD_V2 = 'kf-9sLx2-qm-v2'
/** 与其它集成测试各用一个地址，避免并行跑时互相清掉登录尝试记录。 */
const TEST_IP = '198.51.100.47'

/** 条目 code 前缀。既能被 `deleteMany` 精确圈到，也满足路由的 `^[A-Za-z0-9_-]+$`。 */
const CODE_A = `${TEST_DATA_PREFIX}q_amount`
const CODE_B = `${TEST_DATA_PREFIX}q_archived`
const CODE_C = `${TEST_DATA_PREFIX}q_craft`

/** 1×1 PNG。服务端按魔数判类型，不解码，所以它只需要前四字节是对的。 */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

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
  console.warn('[quote.test] 数据库不可达，查价的集成测试未执行')
}

describe('报价查价', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  let app: ReturnType<typeof buildApp>

  /** designer：有 `personal.quote.read`，写路径必须凭令牌。 */
  let designerToken = ''
  let designerUserId = ''
  /** 第二个 designer：用来证明令牌与人绑定。 */
  let otherDesignerToken = ''
  /** owner：直入，且是唯一能设口令的角色。 */
  let ownerToken = ''
  let ownerUserId = ''
  let auditUserId = ''

  let unlockToken = ''
  let versionAfterOwnerEdit = ''

  /**
   * 口令表的快照。测试会把它清空，结束时原样写回。
   *
   * 这里刻意经一层本地函数取类型，而不是写 `ReturnType<typeof prisma.xxx.findMany>`：
   * Prisma 的 `findMany` 是泛型方法，`ReturnType` 取到的是泛型未定的那一版，落到
   * `unknown` / `never` 上，后面 `createMany({ data: snapshot })` 就过不了类型检查。
   * 非泛型的本地函数返回类型是具体模型，各字段也正好是 `createMany` 要的形状。
   */
  async function snapshotSecrets() {
    return prisma.quoteAccessSecret.findMany()
  }
  async function snapshotSessions() {
    return prisma.quoteUnlockSession.findMany()
  }

  let secretSnapshot: Awaited<ReturnType<typeof snapshotSecrets>> = []
  let sessionSnapshot: Awaited<ReturnType<typeof snapshotSessions>> = []
  let datasetIdsBefore: string[] = []
  /** 本轮建的用户 id。清理按 id 精确删，不用前缀 —— 前缀是本文件与别的测试共用的。 */
  const createdUserIds: string[] = []

  async function createUser(
    roleCode: RoleCode,
    displayName: string,
  ): Promise<{
    id: string
    username: string
  }> {
    const role = await prisma.role.findUnique({ where: { code: roleCode }, select: { id: true } })
    if (role === null) throw new Error(`库里没有 ${roleCode} 角色，先执行 pnpm db:seed`)
    const passwordHash = await hashPassword(TEST_PASSWORD)
    const user = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        passwordHash,
        displayName,
        roleId: role.id,
      },
      select: { id: true, username: true },
    })
    createdUserIds.push(user.id)
    return user
  }

  async function tokenFor(username: string): Promise<string> {
    const result = await login({ username, password: TEST_PASSWORD, ip: TEST_IP })
    if (!result.ok) throw new Error(`测试账号登录失败：${result.reason}`)
    return result.data.accessToken
  }

  /** 清掉失败计数与锁定。锁定是全局的，一个用例造出来的锁会卡住后面所有用例。 */
  async function resetSecretLock(): Promise<void> {
    await prisma.quoteAccessSecret.updateMany({ data: { failCount: 0, lockedUntil: null } })
  }

  function authed(token: string): Record<string, string> {
    return { authorization: `Bearer ${token}` }
  }

  before(async () => {
    secretSnapshot = await snapshotSecrets()
    sessionSnapshot = await snapshotSessions()
    await prisma.quoteUnlockSession.deleteMany()
    await prisma.quoteAccessSecret.deleteMany()

    datasetIdsBefore = (await prisma.quoteDataset.findMany({ select: { id: true } })).map(
      (row) => row.id,
    )

    // 上一轮跑挂了可能留下残留，先清一次，再建。
    await prisma.quoteItem.deleteMany({ where: { code: { startsWith: TEST_DATA_PREFIX } } })
    await prisma.quoteItemImage.deleteMany({
      where: { imageKey: { startsWith: TEST_DATA_PREFIX } },
    })
    await prisma.quoteRevision.deleteMany({ where: { itemCode: { startsWith: TEST_DATA_PREFIX } } })

    // **只清带前缀的 owner**，不清带前缀的全部账号：前缀是本文件与别的集成测试
    // 共用的，全清会误删同时段别的文件建的账号。清 owner 是因为它必须清 ——
    // `case-library/scope.ts` 用 `findFirst(role = owner)` 定归属，多留一个测试
    // owner 会让案例库的归属在两次运行之间漂走，而且不报错。
    await prisma.user.deleteMany({
      where: { username: { startsWith: TEST_DATA_PREFIX }, role: { code: ROLE_CODES.OWNER } },
    })

    const currentVersion = (
      await prisma.quoteDataset.findFirst({
        orderBy: { importedAt: 'desc' },
        select: { version: true },
      })
    )?.version
    if (currentVersion === undefined) {
      throw new Error('库里没有任何数据集版本，先执行 pnpm db:quote-import')
    }

    await prisma.quoteItem.createMany({
      data: [
        {
          code: CODE_A,
          source: 'sale',
          category: `${TEST_DATA_PREFIX}柜体`,
          name: 'zzqt 免漆柜体',
          model: '',
          spec: '展开面积',
          unit: '㎡',
          unitRaw: '㎡',
          priceKind: 'amount',
          priceFen: 66800,
          priceText: '668',
          status: 'active',
          datasetVersion: currentVersion,
        },
        {
          code: CODE_B,
          source: 'sale',
          category: `${TEST_DATA_PREFIX}柜体`,
          name: 'zzqt 停用项',
          model: 'M-1',
          spec: '',
          unit: '㎡',
          unitRaw: '㎡',
          priceKind: 'multiplier',
          priceFen: null,
          priceText: '按投影面积 1.5 倍',
          status: 'archived',
          datasetVersion: currentVersion,
        },
        {
          code: CODE_C,
          source: 'craft',
          category: `${TEST_DATA_PREFIX}工艺`,
          name: 'zzqt 工艺项',
          model: '',
          spec: '按米',
          unit: '米',
          unitRaw: '米',
          priceKind: 'per_meter',
          priceFen: 10000,
          priceText: '100/米',
          status: 'active',
          datasetVersion: currentVersion,
        },
      ],
    })

    const designer = await createUser(ROLE_CODES.DESIGNER satisfies RoleCode, '查价测试设计师')
    designerUserId = designer.id
    designerToken = await tokenFor(designer.username)

    const other = await createUser(ROLE_CODES.DESIGNER satisfies RoleCode, '查价测试设计师乙')
    otherDesignerToken = await tokenFor(other.username)

    const owner = await createUser(ROLE_CODES.OWNER satisfies RoleCode, '查价测试超管')
    ownerUserId = owner.id
    ownerToken = await tokenFor(owner.username)

    // 审计里的 operatorId 指向 owner，清理时按 userId 删。
    auditUserId = ownerUserId

    app = buildApp({ logger: false })
  })

  after(async () => {
    await app.close()

    await prisma.quoteRevision.deleteMany({
      where: { OR: [{ itemCode: { startsWith: TEST_DATA_PREFIX } }, { operatorId: auditUserId }] },
    })
    await prisma.quoteItemImage.deleteMany({
      where: { imageKey: { startsWith: TEST_DATA_PREFIX } },
    })
    await prisma.quoteItem.deleteMany({ where: { code: { startsWith: TEST_DATA_PREFIX } } })
    // 只删本轮新建的数据集版本：库里那一条是导入台账写的。
    await prisma.quoteDataset.deleteMany({
      where: {
        id: {
          notIn:
            datasetIdsBefore.length === 0
              ? ['00000000-0000-0000-0000-000000000000']
              : datasetIdsBefore,
        },
      },
    })

    await prisma.quoteUnlockSession.deleteMany()
    await prisma.quoteAccessSecret.deleteMany()
    // 原样写回快照。@updatedAt 与 createdAt 都显式给值，否则还原出来的行看起来
    // 像刚被改过，用户会以为口令被人动过。
    if (secretSnapshot.length > 0) {
      await prisma.quoteAccessSecret.createMany({ data: secretSnapshot })
    }
    if (sessionSnapshot.length > 0) {
      await prisma.quoteUnlockSession.createMany({ data: sessionSnapshot })
    }

    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
  })

  // ---------------------------------------------------------------- 读路径

  test('未登录不能读', async () => {
    for (const url of ['/api/quote/meta', '/api/quote/search']) {
      const response = await app.inject({ method: 'GET', url })
      assert.equal(response.statusCode, 401, url)
    }
  })

  test('designer 能读 meta，分类与版本都在里面', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/quote/meta',
      headers: authed(designerToken),
    })
    assert.equal(response.statusCode, 200, response.body)

    const body = response.json() as {
      version: string
      itemCount: number
      categories: readonly { source: string; name: string; count: number }[]
      hasSecret: boolean
    }
    assert.equal(typeof body.version, 'string')
    assert.ok(body.version.length > 0, 'meta 必须带版本号，前端据此判断手里的价格还成不成立')
    assert.ok(
      body.categories.some((item) => item.name === `${TEST_DATA_PREFIX}工艺`),
      '分类清单要包含本轮造的那一类',
    )
    assert.equal(body.hasSecret, false, '本轮开始时口令表是空的')

    // 价格随时可能变，任何一层缓存都等于给旧价。
    assert.equal(response.headers['cache-control'], 'no-store')
  })

  test('搜索按名称命中，默认不含已停用', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/quote/search?q=zzqt',
      headers: authed(designerToken),
    })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as { total: number; items: readonly { code: string }[] }
    const codes = body.items.map((item) => item.code)
    assert.ok(codes.includes(CODE_A))
    assert.ok(!codes.includes(CODE_B), '默认搜索不能带出已停用的行')
  })

  test('includeArchived 才带出停用行', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/quote/search?q=zzqt&includeArchived=true',
      headers: authed(designerToken),
    })
    const body = response.json() as { items: readonly { code: string; status: string }[] }
    const archived = body.items.find((item) => item.code === CODE_B)
    assert.ok(
      archived !== undefined,
      '显式要求时停用行必须出现，否则「上个月这条为什么查不到」答不了',
    )
    assert.equal(archived.status, 'archived')
  })

  test('搜索按来源过滤，且不串源', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/quote/search?q=zzqt&source=craft',
      headers: authed(designerToken),
    })
    const body = response.json() as { items: readonly { code: string; source: string }[] }
    assert.equal(body.items.length, 1)
    assert.equal(body.items[0]?.code, CODE_C)
    assert.equal(body.items[0]?.source, 'craft')
  })

  test('分类清单只统计在售行', async () => {
    // 上面那些用例会把 CODE_B 停用掉，但分类统计是 groupBy active —— 这里用
    // meta 的 categories 走一次，确认停用行的分类不会被算进去。
    const response = await app.inject({
      method: 'GET',
      url: '/api/quote/meta',
      headers: authed(designerToken),
    })
    const body = response.json() as { categories: readonly { name: string; count: number }[] }
    const craft = body.categories.find((item) => item.name === `${TEST_DATA_PREFIX}工艺`)
    assert.equal(craft?.count, 1)
  })

  test('详情：找不到给 404，找得到给整条', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: `/api/quote/items/${TEST_DATA_PREFIX}not_exist`,
      headers: authed(designerToken),
    })
    assert.equal(missing.statusCode, 404)

    const found = await app.inject({
      method: 'GET',
      url: `/api/quote/items/${CODE_A}`,
      headers: authed(designerToken),
    })
    assert.equal(found.statusCode, 200, found.body)
    const body = found.json() as { item: { code: string; priceKind: string; priceFen: number } }
    assert.equal(body.item.priceKind, 'amount')
    assert.equal(body.item.priceFen, 66800)
  })

  test('code 不合规直接 400，不落到查询层', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/quote/items/%E4%B8%AD%E6%96%87code',
      headers: authed(designerToken),
    })
    assert.equal(response.statusCode, 400, '业务键只允许 [A-Za-z0-9_-]，中文不该进到查库那一步')
  })

  // ---------------------------------------------------------------- 写路径准入

  test('designer 没有令牌不能改价', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/quote/items/${CODE_A}`,
      headers: authed(designerToken),
      payload: { priceFen: 60000 },
    })
    assert.equal(response.statusCode, 403, response.body)
    assert.equal((response.json() as { error: string }).error, 'forbidden')

    // 关键的一条：被拒绝时价格**一个字都没动**。
    const row = await prisma.quoteItem.findUnique({
      where: { code: CODE_A },
      select: { priceFen: true },
    })
    assert.equal(row?.priceFen, 66800)
  })

  test('designer 不是 owner，不能设口令', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/access-secret',
      headers: authed(designerToken),
      payload: { password: SECRET_PASSWORD },
    })
    assert.equal(response.statusCode, 403, response.body)
  })

  test('owner 首次设置口令，重复设置被拒', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/quote/access-secret',
      headers: authed(ownerToken),
      payload: { password: SECRET_PASSWORD },
    })
    assert.equal(created.statusCode, 200, created.body)
    assert.deepEqual(created.json(), { ok: true, version: 1 })

    const again = await app.inject({
      method: 'POST',
      url: '/api/quote/access-secret',
      headers: authed(ownerToken),
      payload: { password: SECRET_PASSWORD },
    })
    // 首次设置与轮换分开，是为了让界面能给「改口令会让其他设备失效」这句确认。
    assert.equal(again.statusCode, 409)
    assert.equal((again.json() as { error: string }).error, 'secret_exists')

    const state = await app.inject({
      method: 'GET',
      url: '/api/quote/access-state',
      headers: authed(designerToken),
    })
    const body = state.json() as {
      direct: boolean
      hasSecret: boolean
      unlockedUntil: string | null
    }
    assert.equal(body.direct, false)
    assert.equal(body.hasSecret, true)
    assert.equal(body.unlockedUntil, null)
  })

  test('owner 不带令牌就能改价，并且版本号与审计都跟着变', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/api/quote/meta',
      headers: authed(ownerToken),
    })
    const versionBefore = (before.json() as { version: string }).version

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/quote/items/${CODE_A}`,
      headers: authed(ownerToken),
      payload: { priceFen: 60000, reason: '台账调价' },
    })
    assert.equal(response.statusCode, 200, response.body)

    const body = response.json() as { version: string; item: { priceFen: number } }
    assert.equal(body.item.priceFen, 60000)
    assert.notEqual(body.version, versionBefore, '改了价必须换版本号，否则前端会继续显示旧价')

    versionAfterOwnerEdit = body.version

    const revisions = await prisma.quoteRevision.findMany({
      where: { itemCode: CODE_A, field: 'price' },
      select: {
        oldValue: true,
        newValue: true,
        reason: true,
        operatorId: true,
        unlockSessionId: true,
      },
    })
    assert.equal(revisions.length, 1)
    assert.equal(revisions[0]?.oldValue, '66800分')
    assert.equal(revisions[0]?.newValue, '60000分')
    assert.equal(revisions[0]?.reason, '台账调价')
    assert.equal(revisions[0]?.operatorId, ownerUserId)
    // owner 直入，没有解锁会话可挂 —— 这一栏为空正是「他不需要口令」的证据。
    assert.equal(revisions[0]?.unlockSessionId, null)
  })

  test('口令输错会被计数，第 5 次起锁定', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/quote/unlock',
      headers: authed(designerToken),
      payload: { password: 'wrong-password-1' },
    })
    assert.equal(first.statusCode, 401, first.body)
    const firstBody = first.json() as { error: string; failCount: number }
    assert.equal(firstBody.error, 'invalid_password')
    assert.equal(firstBody.failCount, 1)

    for (let attempt = 2; attempt <= QUOTE_LIMITS.UNLOCK_FAIL_LIMIT; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/quote/unlock',
        headers: authed(designerToken),
        payload: { password: `wrong-password-${attempt}` },
      })
      assert.equal(response.statusCode, 401, `第 ${attempt} 次`)

      if (attempt === QUOTE_LIMITS.UNLOCK_FAIL_LIMIT) {
        const body = response.json() as { lockedUntil?: string }
        assert.equal(typeof body.lockedUntil, 'string', '到达上限时响应要带上锁定截止时间')
      }
    }

    // 锁已经是「锁着」的状态，下一次连口令都不验。
    const locked = await app.inject({
      method: 'POST',
      url: '/api/quote/unlock',
      headers: authed(designerToken),
      payload: { password: SECRET_PASSWORD },
    })
    assert.equal(locked.statusCode, 429, '锁定期间用正确口令也必须被拒，否则锁定形同虚设')
    assert.equal((locked.json() as { error: string }).error, 'locked')
  })

  test('清掉锁定后正确口令换到令牌', async () => {
    await resetSecretLock()

    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/unlock',
      headers: authed(designerToken),
      payload: { password: SECRET_PASSWORD },
    })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as { unlockToken: string; expiresAt: string }
    assert.ok(body.unlockToken.length >= 32, '令牌不能是短串')
    assert.ok(new Date(body.expiresAt).getTime() > Date.now())
    unlockToken = body.unlockToken

    // 库里只有哈希，明文只在这一次响应里出现。
    const stored = await prisma.quoteUnlockSession.findMany({ select: { tokenHash: true } })
    assert.equal(stored.length, 1)
    assert.notEqual(stored[0]?.tokenHash, unlockToken)
    assert.match(String(stored[0]?.tokenHash), /^[0-9a-f]{64}$/)
  })

  test('带令牌的 designer 能改价，审计记到解锁会话上', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/quote/items/${CODE_A}`,
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: { priceText: '1.5 倍', reason: '改成倍率' },
    })
    assert.equal(response.statusCode, 200, response.body)

    const body = response.json() as {
      item: { priceKind: string; priceFen: number | null; priceText: string }
    }
    // 换形态这条路最容易写错：沿用旧形态会得到「金额 668，原文 1.5 倍」这种
    // 自相矛盾的行，界面上显示 ¥668，而写进去的是倍率。
    assert.equal(body.item.priceKind, 'multiplier')
    assert.equal(body.item.priceFen, null)
    assert.equal(body.item.priceText, '1.5 倍')

    const revision = await prisma.quoteRevision.findFirst({
      where: { itemCode: CODE_A, field: 'price' },
      orderBy: { createdAt: 'desc' },
      select: { unlockSessionId: true, operatorId: true },
    })
    assert.equal(revision?.operatorId, designerUserId)
    assert.notEqual(
      revision?.unlockSessionId,
      null,
      '凭口令改价必须留下会话，否则审计答不出「谁改的」',
    )
  })

  test('令牌与人绑定：换个账号拿着同一串不能用', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/quote/items/${CODE_C}`,
      headers: { ...authed(otherDesignerToken), 'x-quote-unlock': unlockToken },
      payload: { priceFen: 12345 },
    })
    assert.equal(
      response.statusCode,
      403,
      '一人解锁全办公室通行是最容易漏的一条，令牌必须与签发它的账号绑定',
    )
    const row = await prisma.quoteItem.findUnique({
      where: { code: CODE_C },
      select: { priceFen: true },
    })
    assert.equal(row?.priceFen, 10000)
  })

  test('换图：非图片字节被拒，合法 PNG 落库且键用条目自己的 code', async () => {
    const bogus = await app.inject({
      method: 'POST',
      url: `/api/quote/items/${CODE_C}/image`,
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: {
        data: Buffer.from('not an image').toString('base64'),
        thumb: PNG_BASE64,
        width: 10,
        height: 10,
      },
    })
    assert.equal(bogus.statusCode, 400, '类型按魔数判，客户端说什么都不算')
    assert.equal((bogus.json() as { error: string }).error, 'invalid_image')

    const response = await app.inject({
      method: 'POST',
      url: `/api/quote/items/${CODE_C}/image`,
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: { data: PNG_BASE64, thumb: PNG_BASE64, width: 1, height: 1 },
    })
    assert.equal(response.statusCode, 200, response.body)

    const body = response.json() as {
      version: string
      image: { key: string; bindType: string; mime: string }
    }
    assert.equal(body.image.key, CODE_C, '手工上传的图用条目自己的 code 当键，不能污染同族的其他行')
    assert.equal(body.image.bindType, 'manual')
    assert.equal(body.image.mime, 'image/png', 'mime 由服务端读魔数得出')

    const item = await prisma.quoteItem.findUnique({
      where: { code: CODE_C },
      select: { imageKey: true },
    })
    assert.equal(item?.imageKey, CODE_C)
  })

  test('取图：要登录、缓存不能是 immutable、ETag 带版本', async () => {
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/quote/images/${CODE_C}?variant=full`,
    })
    assert.equal(anonymous.statusCode, 401)

    const response = await app.inject({
      method: 'GET',
      url: `/api/quote/images/${CODE_C}?variant=full`,
      headers: authed(designerToken),
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal(response.headers['content-type'], 'image/png')

    const cacheControl = String(response.headers['cache-control'] ?? '')
    // 案例图的 itemId 每次新生成，所以能 `immutable`；这里的 imageKey 是复用的，
    // 同一条目换图后 URL 不变 —— 写成 immutable 就等于「换了图，客户那边还是旧图」。
    assert.ok(
      !cacheControl.includes('immutable'),
      `imageKey 会被复用，不能 immutable：${cacheControl}`,
    )
    assert.ok(cacheControl.includes('max-age=86400'), cacheControl)
    // ETag 里带变体名，前端换 `?variant=` 时缓存不会串。
    const etag = String(response.headers.etag ?? '')
    assert.match(etag, /^(W\/)?"[^"]+"$/, `ETag 必须是合法的引号串：${etag}`)
    assert.ok(etag.includes('-full'), `ETag 要区分缩略图与原图：${etag}`)

    const missing = await app.inject({
      method: 'GET',
      url: `/api/quote/images/${TEST_DATA_PREFIX}no_such_image`,
      headers: authed(designerToken),
    })
    assert.equal(missing.statusCode, 404)
  })

  test('解绑只清指向，手工图被作废后取不到', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/quote/items/${CODE_C}/image`,
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
    })
    assert.equal(response.statusCode, 200, response.body)

    const item = await prisma.quoteItem.findUnique({
      where: { code: CODE_C },
      select: { imageKey: true },
    })
    assert.equal(item?.imageKey, null)

    const image = await app.inject({
      method: 'GET',
      url: `/api/quote/images/${CODE_C}`,
      headers: authed(designerToken),
    })
    assert.equal(image.statusCode, 404, '解绑之后旧 URL 不能还看得到图')
  })

  test('停用：默认搜索不再出现，重复停用被拒', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/quote/items/${CODE_C}/status`,
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: { status: 'archived', reason: '下架' },
    })
    assert.equal(response.statusCode, 200, response.body)
    assert.equal((response.json() as { item: { status: string } }).item.status, 'archived')

    const search = await app.inject({
      method: 'GET',
      url: '/api/quote/search?q=zzqt&source=craft',
      headers: authed(designerToken),
    })
    assert.equal((search.json() as { items: unknown[] }).items.length, 0)

    const again = await app.inject({
      method: 'POST',
      url: `/api/quote/items/${CODE_C}/status`,
      headers: { ...authed(ownerToken) },
      payload: { status: 'archived' },
    })
    assert.equal(again.statusCode, 409, '状态没有变化不该算成功，否则审计里会多出一条假变更')
  })

  test('改价校验：没有价格字段、负数、超长说明都被挡下', async () => {
    const cases: readonly { payload: Record<string, unknown>; status: number; label: string }[] = [
      { payload: { reason: '只写说明' }, status: 400, label: '没有任何价格字段' },
      { payload: { priceFen: -1 }, status: 400, label: '负数金额' },
      { payload: { priceFen: 100_000_001 }, status: 400, label: '超出上限' },
      { payload: { priceFen: 1.5 }, status: 400, label: '非整数分' },
      {
        payload: { priceFen: 100, reason: 'x'.repeat(QUOTE_LIMITS.REASON_MAX + 1) },
        status: 400,
        label: '说明超长',
      },
    ]

    for (const item of cases) {
      const response = await app.inject({
        method: 'PATCH',
        url: `/api/quote/items/${CODE_A}`,
        headers: authed(ownerToken),
        payload: item.payload,
      })
      assert.equal(response.statusCode, item.status, `${item.label}：${response.body}`)
    }
  })

  test('轮换口令：版本加一，旧令牌立刻失效', async () => {
    const rotated = await app.inject({
      method: 'PUT',
      url: '/api/quote/access-secret',
      headers: authed(ownerToken),
      payload: { password: SECRET_PASSWORD_V2 },
    })
    assert.equal(rotated.statusCode, 200, rotated.body)
    assert.deepEqual(rotated.json(), { ok: true, version: 2 })

    const withOldToken = await app.inject({
      method: 'PATCH',
      url: `/api/quote/items/${CODE_A}`,
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: { priceFen: 99900 },
    })
    assert.equal(
      withOldToken.statusCode,
      403,
      '改口令必须让所有旧令牌失效，否则「口令换了」只是一句口头承诺',
    )

    const withNewPassword = await app.inject({
      method: 'POST',
      url: '/api/quote/unlock',
      headers: authed(designerToken),
      payload: { password: SECRET_PASSWORD_V2 },
    })
    assert.equal(withNewPassword.statusCode, 200, withNewPassword.body)

    // 版本号是判断「手里的价还成不成立」的唯一依据，这一轮改过价，它必须变过。
    const meta = await app.inject({
      method: 'GET',
      url: '/api/quote/meta',
      headers: authed(ownerToken),
    })
    assert.notEqual((meta.json() as { version: string }).version, versionAfterOwnerEdit)
  })
})
