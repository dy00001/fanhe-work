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

/**
 * 新增产品**不能**用固定 code —— 它由服务端按五元组算成 `sale-<digest>`，不带
 * `zz_test_` 前缀。所以清理只能靠产品名圈：两个名字都带前缀，按 `name.startsWith`
 * 就能把本文件建的条目、图、审计一次收干净。
 */
const NEW_ITEM_NAME = `${TEST_DATA_PREFIX}新增带图产品`
const BAD_ITEM_NAME = `${TEST_DATA_PREFIX}新增坏图产品`

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

  /**
   * 清掉本文件通过「新增产品」建出来的行。
   *
   * 那些行的 code 是服务端算的 `sale-<digest>`，**不以测试前缀开头** —— 只按 code
   * 前缀清理会留下三条真实感的条目（和它们的图），跑第二次也不报错，只是库里慢慢
   * 多出一堆「新增带图产品」。所以按产品名圈。删的顺序必须是 审计 → 图 → 条目：
   * 后两者没有外键，但反过来的话，一旦中途失败就再也找不到该删哪些图了。
   */
  async function purgeManualItems(): Promise<void> {
    const stale = await prisma.quoteItem.findMany({
      where: { name: { in: [NEW_ITEM_NAME, BAD_ITEM_NAME] } },
      select: { code: true },
    })
    const codes = stale.map((row) => row.code)
    if (codes.length === 0) return
    await prisma.quoteRevision.deleteMany({ where: { itemCode: { in: codes } } })
    await prisma.quoteItemImage.deleteMany({ where: { imageKey: { in: codes } } })
    await prisma.quoteItem.deleteMany({ where: { code: { in: codes } } })
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
    await purgeManualItems()

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
    // 本轮新建的分类行与主类行。分类表没有外键约束，条目删掉之后这些行会一直留着，
    // 下次打开维护台就会多出几个空分类。
    await prisma.quoteCategory.deleteMany({ where: { name: { startsWith: TEST_DATA_PREFIX } } })
    await prisma.quoteSourceRow.deleteMany({ where: { name: { startsWith: TEST_DATA_PREFIX } } })
    await purgeManualItems()
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

  test('新增产品带图：一次提交、图键用新算出的 code、取图取得到', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/items',
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: {
        source: 'sale',
        category: `${TEST_DATA_PREFIX}柜体`,
        name: NEW_ITEM_NAME,
        spec: '带图规格',
        unit: '㎡',
        priceText: '888',
        image: { data: PNG_BASE64, thumb: PNG_BASE64, width: 1, height: 1 },
      },
    })
    assert.equal(response.statusCode, 200, response.body)

    const body = response.json() as {
      version: string
      item: {
        code: string
        ledgerNo: string
        imageKey: string | null
        imageVersion: string | null
      }
    }
    assert.match(body.item.ledgerNo, /^M\d+$/, '手工新增用 M 号段，不混进台账号 A/B/C')
    // 图键必须是**服务端刚算出来的**那个 code。客户端拿不到它，所以这条也顺带
    // 证明「图随条目一次提交」这条路是通的 —— 分成两步就得先拿到 code。
    assert.equal(body.item.imageKey, body.item.code, '图键要用条目自己的 code，不能挂到产品族上')
    assert.notEqual(body.item.imageVersion, null, '响应里没有图版本，前端无法拼缓存键')

    // 只断言 `imageKey` 不够：它可能只是字段被改了、字节根本没写进去。取一次图
    // 才算证明「关联正确」。
    const image = await app.inject({
      method: 'GET',
      url: `/api/quote/images/${body.item.code}?variant=thumb`,
      headers: authed(designerToken),
    })
    assert.equal(image.statusCode, 200, image.body)
    assert.equal(image.headers['content-type'], 'image/png')

    const row = await prisma.quoteItemImage.findFirst({
      where: { imageKey: body.item.code, isActive: true },
      select: { bindType: true, uploadedBy: true, byteSize: true, thumbWidth: true },
    })
    assert.equal(row?.bindType, 'manual', '手工上传记 manual，与台账导入的 exact / family 分开')
    assert.equal(row?.uploadedBy, designerUserId)
    assert.equal(row?.byteSize, Buffer.from(PNG_BASE64, 'base64').length)
    // 1×1 的图不该被放大，缩略图尺寸按只缩不放算。
    assert.equal(row?.thumbWidth, 1)
  })

  test('新增产品带非法图：整条不落库，只报 invalid_image', async () => {
    const countBefore = await prisma.quoteItem.count({ where: { name: BAD_ITEM_NAME } })

    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/items',
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: {
        source: 'sale',
        category: `${TEST_DATA_PREFIX}柜体`,
        name: BAD_ITEM_NAME,
        priceText: '100',
        image: {
          data: Buffer.from('not an image').toString('base64'),
          thumb: PNG_BASE64,
          width: 1,
          height: 1,
        },
      },
    })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal((response.json() as { error: string }).error, 'invalid_image')

    // 这条是这个用例的重点：校验在写库之前。反过来的话会留下一条没有图的产品，
    // 而操作员看到的是「保存失败」，不会想到库里已经多了一条。
    const countAfter = await prisma.quoteItem.count({ where: { name: BAD_ITEM_NAME } })
    assert.equal(countAfter, countBefore, '图被拒时不能留下一条没有图的产品')
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

  // ------------------------------------------------------- 主类与两种合并

  /**
   * 重新解锁。
   *
   * 上一组用例最后改了维护口令，按设计**所有旧令牌当场作废** —— 这正是那条用例
   * 要证明的事。所以这里的每一次写都必须换一个新令牌，否则拿到的是 403，而 403
   * 看起来像「权限没配好」，会把人引到完全错误的地方去查。
   */
  test('重新解锁：上一组用例改过口令，旧令牌已作废', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/unlock',
      headers: authed(designerToken),
      payload: { password: SECRET_PASSWORD_V2 },
    })
    assert.equal(response.statusCode, 200, response.body)
    unlockToken = (response.json() as { unlockToken: string }).unlockToken
  })

  /**
   * 造一条测试条目。
   *
   * `ledgerNo` 由调用方给且必须递减有序：产品合并的「继承哪一条」是按条目号取第一条
   * 有价的，三个空串会让那个规则退化成「数据库返回顺序」—— 断言就会偶发失败。
   */
  async function seedItem(input: {
    code: string
    category: string
    name: string
    ledgerNo: string
    priceKind?: string
    priceFen?: number | null
    priceText?: string
  }): Promise<void> {
    await prisma.quoteItem.create({
      data: {
        code: input.code,
        source: 'sale',
        category: input.category,
        name: input.name,
        model: '',
        spec: '',
        ledgerNo: input.ledgerNo,
        unit: '㎡',
        unitRaw: '㎡',
        priceKind: input.priceKind ?? 'amount',
        priceFen: input.priceFen === undefined ? 10_000 : input.priceFen,
        priceText: input.priceText ?? '100',
        status: 'active',
        datasetVersion: 'zztest',
      },
    })
  }

  async function listSourceCodes(): Promise<string[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/quote/sources',
      headers: authed(designerToken),
    })
    assert.equal(response.statusCode, 200, response.body)
    return (response.json() as { items: { code: string }[] }).items.map((row) => row.code)
  }

  test('主类：新建 → 改名 → 删除，列表实时跟着变', async () => {
    const write = { ...authed(designerToken), 'x-quote-unlock': unlockToken }

    const created = await app.inject({
      method: 'POST',
      url: '/api/quote/sources',
      headers: write,
      payload: { name: `${TEST_DATA_PREFIX}石材外协`, short: '石材' },
    })
    assert.equal(created.statusCode, 200, created.body)
    const made = created.json() as {
      code: string
      name: string
      ledgerPrefix: string
      deletable: boolean
    }
    // code 要进 URL 路径与每一条产品的业务键，只能是纯小写 ASCII。
    assert.match(made.code, /^[a-z0-9]{1,16}$/, '生成的主类标识进不了 URL 就全盘不能用')
    assert.equal(made.deletable, true, '刚建的空主类必须可删 —— 否则这个功能等于不可用')
    assert.equal(made.ledgerPrefix.length <= 2, true, '条目号前缀是 2 个字符的列')

    assert.ok(
      (await listSourceCodes()).includes(made.code),
      '新建的主类没进列表，界面上就是「点了新建但没出现」',
    )

    const renamed = await app.inject({
      method: 'PATCH',
      url: '/api/quote/sources',
      headers: write,
      payload: { code: made.code, name: `${TEST_DATA_PREFIX}石材外协改`, short: '石改' },
    })
    assert.equal(renamed.statusCode, 200, renamed.body)
    assert.equal((renamed.json() as { name: string }).name, `${TEST_DATA_PREFIX}石材外协改`)

    const removed = await app.inject({
      method: 'POST',
      url: '/api/quote/sources/delete',
      headers: write,
      payload: { code: made.code },
    })
    assert.equal(removed.statusCode, 200, removed.body)
    assert.ok(
      !(await listSourceCodes()).includes(made.code),
      '删掉的主类还在列表里 —— 界面刷新一次它就又出现了',
    )
  })

  test('主类：内置那三类下面有产品，删不掉且说明原因', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/sources/delete',
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: { code: 'sale' },
    })
    // 409 而不是 403：请求没错，是这个主类下面还有东西。
    assert.equal(response.statusCode, 409, response.body)
    assert.equal((response.json() as { error: string }).error, 'has_items')
  })

  /**
   * 这一条是整个「主类搬进库」功能的判官。
   *
   * `source` 字段在 JSON Schema 里只校验形状（`^[a-z0-9_]+$`），取值域查库。谁把它
   * 改回 `enum: [...QUOTE_SOURCES]`，新建的主类就再也装不了产品，报的是
   * 「must be equal to one of the allowed values」—— 而那个值明明就印在界面的
   * tab 上。这种改动 typecheck 与 lint 都拦不住，只有真发一次写请求才看得见。
   */
  test('新建的主类能装产品、名字跟着下发；乱填的来源在写路径上被拒', async () => {
    const write = { ...authed(designerToken), 'x-quote-unlock': unlockToken }

    const created = await app.inject({
      method: 'POST',
      url: '/api/quote/sources',
      headers: write,
      payload: { name: `${TEST_DATA_PREFIX}岩板外协`, short: '岩板' },
    })
    assert.equal(created.statusCode, 200, created.body)
    const code = (created.json() as { code: string }).code

    const added = await app.inject({
      method: 'POST',
      url: '/api/quote/items',
      headers: write,
      payload: {
        source: code,
        category: `${TEST_DATA_PREFIX}岩板台面`,
        name: 'zzq 岩板台面',
        priceText: '398',
      },
    })
    assert.equal(added.statusCode, 200, added.body)

    const searched = await app.inject({
      method: 'GET',
      url: `/api/quote/search?source=${code}`,
      headers: authed(designerToken),
    })
    assert.equal(searched.statusCode, 200, searched.body)
    const found = (searched.json() as { items: { sourceName: string; sourceShort: string }[] })
      .items
    assert.equal(found.length, 1, '新建主类下的产品查不到 —— 这个主类等于摆设')
    // 结果浮层那行「规格 · 出处」要的是真名与短名，不是 code。
    assert.equal(found[0]?.sourceName, `${TEST_DATA_PREFIX}岩板外协`)
    assert.equal(found[0]?.sourceShort, '岩板')

    // 形状对、库里没有：不能悄悄写进去，否则查价页永远筛不出这一条。
    const ghost = await app.inject({
      method: 'POST',
      url: '/api/quote/items',
      headers: write,
      payload: {
        source: 'nope404',
        category: `${TEST_DATA_PREFIX}柜体`,
        name: 'zzq 幽灵产品',
        priceText: '1',
      },
    })
    assert.equal(ghost.statusCode, 400, ghost.body)
    assert.equal((ghost.json() as { error: string }).error, 'invalid_source')

    // 下架之后 `itemCount` 归零，但那一行还在库里、还挂着历史报价单的条目号。
    // 判据只看 itemCount 就会把这个主类判成可删，删完历史报价单上的编号查不到
    // 任何东西，而且不会有任何报错。
    const off = await app.inject({
      method: 'POST',
      url: `/api/quote/items/${(added.json() as { item: { code: string } }).item.code}/status`,
      headers: write,
      payload: { status: 'archived', reason: '下架' },
    })
    assert.equal(off.statusCode, 200, off.body)

    const sources = await app.inject({
      method: 'GET',
      url: '/api/quote/sources',
      headers: authed(designerToken),
    })
    const row = (
      sources.json() as {
        items: { code: string; itemCount: number; archivedCount: number; deletable: boolean }[]
      }
    ).items.find((entry) => entry.code === code)
    assert.equal(row?.itemCount, 0, '下架后不该还算在售')
    assert.equal(row?.archivedCount, 1)
    assert.equal(row?.deletable, false, '只剩已下架条目的主类不可删 —— 条目没被物理删过')

    const refused = await app.inject({
      method: 'POST',
      url: '/api/quote/sources/delete',
      headers: write,
      payload: { code },
    })
    assert.equal(refused.statusCode, 409, refused.body)
    assert.equal((refused.json() as { error: string }).error, 'has_items')
  })

  test('分类多选合并：选中的三个并成一个，产品一条不少', async () => {
    const catA = `${TEST_DATA_PREFIX}多选甲`
    const catB = `${TEST_DATA_PREFIX}多选乙`
    const catC = `${TEST_DATA_PREFIX}多选丙`
    const target = `${TEST_DATA_PREFIX}多选合`
    const codes = [`${TEST_DATA_PREFIX}mm1`, `${TEST_DATA_PREFIX}mm2`, `${TEST_DATA_PREFIX}mm3`]

    await seedItem({ code: codes[0] ?? '', category: catA, name: 'zzq 多选一', ledgerNo: 'M101' })
    await seedItem({ code: codes[1] ?? '', category: catB, name: 'zzq 多选二', ledgerNo: 'M102' })
    await seedItem({ code: codes[2] ?? '', category: catC, name: 'zzq 多选三', ledgerNo: 'M103' })

    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/categories/merge-many',
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: { source: 'sale', from: [catA, catB, catC], to: target },
    })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as { moved: number; to: string; from: string[] }
    assert.equal(body.moved, 3, '三条产品都该被挪过来')
    assert.equal(body.to, target)

    const moved = await prisma.quoteItem.findMany({
      where: { code: { in: codes } },
      select: { category: true },
    })
    assert.equal(moved.length, 3, '产品被删掉了 —— 合并只该改挂，不该删行')
    assert.ok(
      moved.every((row) => row.category === target),
      '还有条目留在旧分类名上：筛选栏按新名列出、点进去却是空的',
    )

    const left = await prisma.quoteCategory.findMany({
      where: { source: 'sale', name: { in: [catA, catB, catC] } },
    })
    assert.equal(left.length, 0, '合并后源分类还留在表里，列表上会看到三个空壳')
  })

  test('分类多选合并：只选一个被判 too_few，不做静默改名', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/categories/merge-many',
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: { source: 'sale', from: [`${TEST_DATA_PREFIX}多选合`], to: 'x' },
    })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal((response.json() as { error: string }).error, 'too_few')
  })

  test('产品合并：保留一条、其余下架，价格从被合并条继承', async () => {
    const category = `${TEST_DATA_PREFIX}产品合并`
    const keep = `${TEST_DATA_PREFIX}mi1`
    const other1 = `${TEST_DATA_PREFIX}mi2`
    const other2 = `${TEST_DATA_PREFIX}mi3`

    await seedItem({
      code: keep,
      category,
      name: 'zzq 合并保留条',
      ledgerNo: 'M201',
      priceKind: 'empty',
      priceFen: null,
      priceText: '',
    })
    await seedItem({
      code: other1,
      category,
      name: 'zzq 合并甲',
      ledgerNo: 'M202',
      priceFen: 12_800,
      priceText: '128',
    })
    await seedItem({
      code: other2,
      category,
      name: 'zzq 合并乙',
      ledgerNo: 'M203',
      priceFen: 9_900,
      priceText: '99',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/items/merge',
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: { source: 'sale', category, codes: [keep, other1, other2], keep },
    })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as { archived: number; inherited: string[]; kept: string }
    assert.equal(body.archived, 2)
    assert.equal(body.kept, keep)
    assert.ok(
      body.inherited.includes('价格'),
      '保留条本来没价，应该从被合并条继承 —— 不继承的话合并等于把价弄丢了',
    )

    const rows = await prisma.quoteItem.findMany({
      where: { code: { in: [keep, other1, other2] } },
      select: { code: true, status: true, priceFen: true },
    })
    assert.equal(rows.length, 3, '合并只能下架、不能物理删除 —— 历史报价单上的编号还要能查到东西')
    const kept = rows.find((row) => row.code === keep)
    assert.equal(kept?.status, 'active')
    assert.equal(kept?.priceFen, 12_800, '继承该取条目号最小的那条有价的')
    assert.equal(rows.filter((row) => row.status === 'archived').length, 2)
  })

  test('产品合并：跨分类被拒，不会顺手改分类', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/items/merge',
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      payload: {
        source: 'sale',
        category: `${TEST_DATA_PREFIX}产品合并`,
        codes: [`${TEST_DATA_PREFIX}mi1`, `${TEST_DATA_PREFIX}mm1`],
        keep: `${TEST_DATA_PREFIX}mi1`,
      },
    })
    assert.equal(response.statusCode, 400, response.body)
    assert.equal((response.json() as { error: string }).error, 'cross_category')
  })

  // -------------------------------------------------------------------------
  // 删除：分类与产品
  // -------------------------------------------------------------------------

  async function listCategoryNames(): Promise<string[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/quote/categories',
      headers: authed(designerToken),
    })
    assert.equal(response.statusCode, 200, response.body)
    return (response.json() as { items: { name: string }[] }).items.map((row) => row.name)
  }

  test('删除分类：空分类能删且从列表消失；有产品的分类被拒，产品一条不动', async () => {
    const write = { ...authed(designerToken), 'x-quote-unlock': unlockToken }
    const empty = `${TEST_DATA_PREFIX}空壳分类`
    const occupied = `${TEST_DATA_PREFIX}有货分类`
    const code = `${TEST_DATA_PREFIX}dc1`

    const created = await app.inject({
      method: 'POST',
      url: '/api/quote/categories',
      headers: write,
      payload: { source: 'sale', name: empty },
    })
    assert.equal(created.statusCode, 200, created.body)
    await seedItem({ code, category: occupied, name: 'zzq 删分类用', ledgerNo: 'M301' })

    const removed = await app.inject({
      method: 'POST',
      url: '/api/quote/categories/delete',
      headers: write,
      payload: { source: 'sale', name: empty },
    })
    assert.equal(removed.statusCode, 200, removed.body)
    assert.ok(
      !(await listCategoryNames()).includes(empty),
      '删掉的空分类还在列表里 —— 界面刷新一次它就又出现了',
    )

    // 有产品的分类：409，而且一条产品都不能少。删掉分类会让那些产品挂在一个
    // 列表里查不到、筛选栏里也没有的名字下，到时候连删都找不到入口。
    const refused = await app.inject({
      method: 'POST',
      url: '/api/quote/categories/delete',
      headers: write,
      payload: { source: 'sale', name: occupied },
    })
    assert.equal(refused.statusCode, 409, refused.body)
    assert.equal((refused.json() as { error: string }).error, 'has_items')
    assert.equal(await prisma.quoteItem.count({ where: { code } }), 1)

    // 不存在的分类：404，而不是假装成功。「删了两次」应该看到「找不到了」。
    const again = await app.inject({
      method: 'POST',
      url: '/api/quote/categories/delete',
      headers: write,
      payload: { source: 'sale', name: empty },
    })
    assert.equal(again.statusCode, 404, again.body)
  })

  test('删除产品：物理删掉、图跟着删、审计留整行快照', async () => {
    const write = { ...authed(designerToken), 'x-quote-unlock': unlockToken }
    const category = `${TEST_DATA_PREFIX}删产品`
    const code = `${TEST_DATA_PREFIX}di1`

    await seedItem({ code, category, name: 'zzq 待删产品', ledgerNo: 'M401', priceText: '128' })
    await prisma.quoteItemImage.create({
      data: {
        imageKey: code,
        data: new Uint8Array([1, 2, 3]),
        thumb: new Uint8Array([1]),
        mime: 'image/png',
        width: 1,
        height: 1,
        thumbWidth: 1,
        thumbHeight: 1,
        byteSize: 3,
        bindType: 'manual',
      },
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/items/delete',
      headers: write,
      payload: { source: 'sale', code },
    })
    assert.equal(response.statusCode, 200, response.body)
    const body = response.json() as { name: string; imageRemoved: boolean; wasArchived: boolean }
    assert.equal(body.name, 'zzq 待删产品')
    assert.equal(body.imageRemoved, true, '这一条自己有图，删除时应当连图一起清掉')
    assert.equal(body.wasArchived, false)

    assert.equal(await prisma.quoteItem.count({ where: { code } }), 0, '删除必须是真的删掉')
    assert.equal(
      await prisma.quoteItemImage.count({ where: { imageKey: code } }),
      0,
      '图留在库里就成了孤儿：没有任何条目指向它，但还占着几百 KB',
    )

    // 审计是这条产品唯一还存在的记录 —— 少了它，「删除」与「什么都没留下」就没区别。
    const audit = await prisma.quoteRevision.findFirst({
      where: { itemCode: code, field: 'deleted' },
      select: { oldValue: true },
    })
    assert.ok(audit !== null, '删除没有留下审计')
    assert.match(audit.oldValue ?? '', /名称=zzq 待删产品/)
    assert.match(audit.oldValue ?? '', /条目号=M401/)

    // 变更记录面板要能正常渲染这条新字段，不能因为 field 取值不认识就 500。
    const revisions = await app.inject({
      method: 'GET',
      url: '/api/quote/revisions?limit=20',
      headers: authed(designerToken),
    })
    assert.equal(revisions.statusCode, 200, revisions.body)
  })

  test('删除产品：不属于当前主类时被拒，跨主类删不掉', async () => {
    const code = `${TEST_DATA_PREFIX}di2`
    await seedItem({
      code,
      category: `${TEST_DATA_PREFIX}删产品`,
      name: 'zzq 跨类删',
      ledgerNo: 'M402',
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/quote/items/delete',
      headers: { ...authed(designerToken), 'x-quote-unlock': unlockToken },
      // 这条是 sale 的产品，用一个别的来源去删。界面上列表还没刷新时会走到这里。
      payload: { source: 'craft', code },
    })
    assert.equal(response.statusCode, 403, response.body)
    assert.equal((response.json() as { error: string }).error, 'wrong_source')
    assert.equal(await prisma.quoteItem.count({ where: { code } }), 1, '被拒绝时不能顺手删掉')
  })
})
