/**
 * 客户行的「按人隔离」与「公共池归类」的集成测试。
 *
 * 需要真实数据库，理由与 `customer.test.ts` 相同：范围条件是拼进 Prisma `where`
 * 的，用内存替身测等于测替身自己。
 *
 * 这个文件守四件事，每件对应一种「界面上看不出来」的坏法：
 *
 *   1. **越权一律 404，不是 403。** 403 等于告诉调用方「这个 id 存在，只是你没权」，
 *      于是可以拿 id 枚举出全库客户名。判据是状态码本身，不是响应体文案。
 *   2. **双角色两侧显示一致。** 同一个客户，设计师打开看到销售是谁，销售打开看到
 *      设计师是谁，名字必须逐字相同。坏法是把归属算在前端，两处各算一遍。
 *   3. **金额跟着行范围走，不跟着角色走。** 设计师与销售都拿到了 `finance.read`，
 *      所以「看不到金额」只可能发生在「行本来就不该打开」时 —— 那是 404，不是 null。
 *      如果哪天有人把金额裁到取数路径上，这条会在「自己名下也看不到金额」处红，
 *      而 KPI 依旧正常。
 *   4. **已复核的归类不会被重跑覆盖。** 复核是人签过的字。坏法是重跑时无条件 upsert，
 *      于是每天早上同步一次，人工判断就被悄悄推翻，而界面上只看到「结论又变了」。
 *
 * 测试数据统一用 `zz_test_scope_` 前缀，结束时按前缀级联删除。**公共池用例一律按
 * 自己的 customerId 限定范围**：库里有 58 位真实公共池客户，按「随便找一条待复核」
 * 去跑会改掉别人的归属。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import {
  PERMISSIONS,
  ROLE_CODES,
  ROLE_PERMISSIONS,
  hasPermission,
  type RoleCode,
} from '@fanhe/shared'

import { resolveTestDatabaseUrl } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

/**
 * 与 `customer.test.ts` 同一套理由：静态导入会在 `DATABASE_URL` 赋值之前求值整条
 * 依赖链，于是整片用例连不上库、看上去像模块坏了。
 */
const { buildApp } = await import('../src/app.js')
const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const { assignCustomer, createCustomer, createOrder, getCustomer } =
  await import('../src/customer/customers.js')
const { SYSTEM_VIEWER } = await import('../src/customer/scope.js')
const { classifyPool, listAssignableUsers, listPool, reviewPoolSuggestion } =
  await import('../src/customer/pool.js')

const PREFIX = 'zz_test_scope_'
const TEST_PASSWORD = 'integration-test-password'
/** 与其它文件分开一段地址，`login_attempts` 与审计清理时互不干扰。 */
const TEST_IP = '198.51.100.77'

/**
 * 按角色造一个观察者。
 *
 * 权限来源是 `ROLE_PERMISSIONS`，也就是种子写进库的那份展开结果 —— 手写一份
 * `{ canAssign: false }` 之类的字面量会在权限表调整后静默变成错的，而用例照样绿。
 * 表达式与 `viewerFromRequest` 逐条对应，差异只在这里不经过 Fastify。
 */
function viewerOf(user: { id: string; displayName: string }, roleCode: RoleCode) {
  const granted = ROLE_PERMISSIONS[roleCode]
  return {
    userId: user.id,
    displayName: user.displayName,
    roleCode,
    scope: hasPermission(granted, PERMISSIONS.CUSTOMER_SCOPE_READ)
      ? ({ kind: 'all' } as const)
      : ({ kind: 'own', userId: user.id } as const),
    canReadFinance: hasPermission(granted, PERMISSIONS.CUSTOMER_FINANCE_READ),
    canReview: hasPermission(granted, PERMISSIONS.CUSTOMER_IMPORT_REVIEW),
    canAssign: hasPermission(granted, PERMISSIONS.CUSTOMER_SCOPE_WRITE),
  }
}

/** 造一条「n 小时前」的时间戳。用相对时间，用例隔几个月也不会失效。 */
function hoursAgo(hours: number): string {
  const at = new Date(Date.now() - hours * 60 * 60 * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
}

describe(
  '客户的按人隔离（走 HTTP）',
  { skip: databaseUrl === null ? '数据库不可达' : false },
  () => {
    const createdUserIds: string[] = []
    let app: ReturnType<typeof buildApp>

    let designer: { id: string; displayName: string }
    let sales: { id: string; displayName: string }
    /** 设计师与销售共管的那位客户。 */
    let sharedId: string
    /** 只在销售名下的客户。 */
    let salesOnlyId: string
    /** 公共池里的客户（两栏皆空）。 */
    let poolId: string

    const headers: Record<'designer' | 'sales' | 'owner', { authorization: string }> = {
      designer: { authorization: '' },
      sales: { authorization: '' },
      owner: { authorization: '' },
    }

    async function createUser(
      roleCode: RoleCode,
      label: string,
    ): Promise<{ id: string; displayName: string; username: string }> {
      const role = await prisma.role.findUnique({ where: { code: roleCode }, select: { id: true } })
      if (role === null) throw new Error(`库里没有 ${roleCode} 角色，先执行 pnpm db:seed`)

      const user = await prisma.user.create({
        data: {
          username: `${PREFIX}${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
          passwordHash: await hashPassword(TEST_PASSWORD),
          displayName: `${PREFIX}${label}`,
          roleId: role.id,
        },
        select: { id: true, displayName: true, username: true },
      })
      createdUserIds.push(user.id)
      return user
    }

    async function signIn(as: 'designer' | 'sales' | 'owner', username: string): Promise<void> {
      const result = await login({ username, password: TEST_PASSWORD, ip: TEST_IP })
      if (!result.ok) throw new Error(`测试账号登录失败：${result.reason}`)
      headers[as] = { authorization: `Bearer ${result.data.accessToken}` }
    }

    before(async () => {
      await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })

      const designerUser = await createUser(ROLE_CODES.DESIGNER, 'designer')
      const salesUser = await createUser(ROLE_CODES.SALES, 'sales')
      const ownerUser = await createUser(ROLE_CODES.OWNER, 'owner')

      designer = { id: designerUser.id, displayName: designerUser.displayName }
      sales = { id: salesUser.id, displayName: salesUser.displayName }

      app = buildApp({ logger: false })

      await signIn('designer', designerUser.username)
      await signIn('sales', salesUser.username)
      await signIn('owner', ownerUser.username)

      /*
       * 三位客户，对应三种归属形态：
       *   - shared：设计师建（自动落到 designer_id），再把销售补上 → 双角色；
       *   - salesOnly：销售建 → 自动落到 sales_id；
       *   - pool：用系统观察者建，两栏皆空 → 公共池。
       *
       * **不直接用 `prisma.customer.create` 插**：那样会绕过 `defaultAssignment`，
       * 而「新建客户自动归到自己那一栏」本身就是要测的行为之一。
       */
      const shared = await createCustomer(
        { realName: '双角色客户', region: '成都', chatroom: `${PREFIX}shared` },
        viewerOf(designer, ROLE_CODES.DESIGNER),
      )
      if (!shared.ok) throw new Error('建双角色客户失败')
      sharedId = shared.data.id
      const assigned = await assignCustomer(
        sharedId,
        { salesId: sales.id, reason: '销售接单' },
        SYSTEM_VIEWER,
      )
      if (!assigned.ok) throw new Error(`补销售归属失败：${assigned.reason}`)

      const salesOnly = await createCustomer(
        { realName: '销售专属客户', region: '成都', chatroom: `${PREFIX}sales` },
        viewerOf(sales, ROLE_CODES.SALES),
      )
      if (!salesOnly.ok) throw new Error('建销售专属客户失败')
      salesOnlyId = salesOnly.data.id

      const pooled = await createCustomer(
        { realName: '公共池客户', region: '成都', chatroom: `${PREFIX}pool` },
        SYSTEM_VIEWER,
      )
      if (!pooled.ok) throw new Error('建公共池客户失败')
      poolId = pooled.data.id

      const order = await createOrder(sharedId, { contractFen: 888_000 }, SYSTEM_VIEWER)
      if (!order.ok) throw new Error('建订单失败')
    })

    after(async () => {
      await app.close()
      await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
      }
      await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
      await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    })

    function list(as: 'designer' | 'sales' | 'owner') {
      return app.inject({ method: 'GET', url: '/api/customers', headers: headers[as] })
    }

    function detail(as: 'designer' | 'sales' | 'owner', id: string) {
      return app.inject({ method: 'GET', url: `/api/customers/${id}`, headers: headers[as] })
    }

    test('新建客户自动归到自己那一栏，不会刚录完就进公共池', async () => {
      const asSales = await detail('sales', salesOnlyId)
      assert.equal(asSales.statusCode, 200, asSales.body)
      const assignment = asSales.json().customer.assignment
      assert.equal(assignment.salesId, sales.id)
      assert.equal(assignment.designerId, null)
      assert.equal(assignment.myRole, 'sales')
    })

    test('设计师与销售看同一位客户，双方名字逐字一致', async () => {
      /* 需求第 1 条的判据：双向可查、两端一致。坏法是把姓名算在前端各算一遍，
       于是「设计师看到销售是自己」这种错只在某个角色的屏幕上出现。 */
      const asDesigner = await detail('designer', sharedId)
      const asSales = await detail('sales', sharedId)
      assert.equal(asDesigner.statusCode, 200, asDesigner.body)
      assert.equal(asSales.statusCode, 200, asSales.body)

      const left = asDesigner.json().customer.assignment
      const right = asSales.json().customer.assignment

      assert.equal(left.designerName, designer.displayName)
      assert.equal(left.salesName, sales.displayName)
      assert.equal(right.designerName, left.designerName)
      assert.equal(right.salesName, left.salesName)
      // `myRole` 各算各的：同一个客户在两个人屏幕上标的是不同身份。
      assert.equal(left.myRole, 'designer')
      assert.equal(right.myRole, 'sales')
    })

    test('设计师看不到销售名下的客户：404，不是 403', async () => {
      /* 403 会告诉调用方「这个 id 存在」，于是可以拿 id 枚举全库。 */
      const response = await detail('designer', salesOnlyId)
      assert.equal(response.statusCode, 404, `应当 404，实际 ${response.statusCode}`)
    })

    test('公共池客户不在任何人的列表里，只出现在全库视角', async () => {
      const asDesigner = list('designer')
      const asSales = list('sales')
      const asOwner = list('owner')

      const idsOf = (response: Awaited<ReturnType<typeof list>>) =>
        (response.json().items as { id: string }[]).map((item) => item.id)

      assert.equal(
        idsOf(await asDesigner).includes(poolId),
        false,
        '公共池客户不应出现在设计师列表',
      )
      assert.equal(idsOf(await asSales).includes(poolId), false, '公共池客户不应出现在销售列表')
      assert.equal(idsOf(await asOwner).includes(poolId), true, '全库视角应当看得到公共池客户')

      // 范围提示条靠它决定要不要显示。算错的后果是提示条不出现，看起来只是「界面少了一块」。
      assert.equal((await asDesigner).json().scopeKind, 'own')
      assert.equal((await asOwner).json().scopeKind, 'all')
    })

    test('自己名下这一单的金额不打码', async () => {
      /* 设计师拿到 `customer.finance.read`，所以金额必须原样返回。若有人把裁剪
       写回取数路径，这条会红在「自己名下也看不到金额」，而 KPI 仍然正常。 */
      const response = await detail('designer', sharedId)
      const order = response.json().customer.orders[0]
      assert.ok(order, '应当有一单')
      assert.ok(order.amounts, '自己名下的单必须能看到金额')
      assert.equal(order.amounts.contractFen, 888_000)
      assert.equal(typeof response.json().customer.contractTotalFen, 'number')
    })

    test('销售有权改自己名下客户的档案，但改不了归属', async () => {
      const edit = await app.inject({
        method: 'PATCH',
        url: `/api/customers/${sharedId}`,
        headers: headers.sales,
        payload: { region: '重庆' },
      })
      assert.equal(edit.statusCode, 200, edit.body)

      /* 归属是整条链上唯一能把越权合法化的入口：划到自己名下之后一切读写都合规。
       守卫必须在处理器之前拦，而不是在处理器里判断 —— 后者漏一个分支就静默放行。 */
      const assign = await app.inject({
        method: 'PATCH',
        url: `/api/customers/${sharedId}/assignment`,
        headers: headers.sales,
        payload: { designerId: sales.id, reason: '想自己跟' },
      })
      assert.equal(assign.statusCode, 403, `改归属应当 403，实际 ${assign.statusCode}`)
    })

    test('设计师读公共池是 403：那不是他的队列', async () => {
      /* 按本人范围过滤之后公共池恒为空集。给设计师一个永远是空的队列，比不给更糟 ——
       会让人以为功能坏了。 */
      const response = await app.inject({
        method: 'GET',
        url: '/api/customers/pool',
        headers: headers.designer,
      })
      assert.equal(response.statusCode, 403, `应当 403，实际 ${response.statusCode}`)
    })
  },
)

describe('公共池归类与复核', { skip: databaseUrl === null ? '数据库不可达' : false }, () => {
  const createdUserIds: string[] = []
  let designer: { id: string; displayName: string }
  let sales: { id: string; displayName: string }

  let chatDir: string
  /** 读到原文的样本客户。 */
  let sampleId: string
  /** 「库里有汇总但读不到原文」的样本客户。 */
  let storedId: string
  /** 错栏用例的样本客户。 */
  let wrongId: string

  /** 读一条建议的原始字段。断言要看的就是「库里到底写成了什么」。 */
  async function readSuggestion(customerId: string) {
    return prisma.customerPoolSuggestion.findUnique({
      where: { customerId },
      select: {
        status: true,
        role: true,
        confidence: true,
        reasons: true,
        reviewNote: true,
        reviewedBy: true,
      },
    })
  }

  before(async () => {
    await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })

    const designerRole = await prisma.role.findUnique({
      where: { code: ROLE_CODES.DESIGNER },
      select: { id: true },
    })
    const salesRole = await prisma.role.findUnique({
      where: { code: ROLE_CODES.SALES },
      select: { id: true },
    })
    if (designerRole === null || salesRole === null) {
      throw new Error('库里没有设计师/销售角色，先执行 pnpm db:seed')
    }

    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const designerUser = await prisma.user.create({
      data: {
        username: `${PREFIX}d_${suffix}`,
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: '归类测试设计师',
        roleId: designerRole.id,
      },
      select: { id: true, displayName: true },
    })
    const salesUser = await prisma.user.create({
      data: {
        username: `${PREFIX}s_${suffix}`,
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: '归类测试销售',
        roleId: salesRole.id,
      },
      select: { id: true, displayName: true },
    })
    createdUserIds.push(designerUser.id, salesUser.id)
    designer = designerUser
    sales = salesUser

    /*
     * 造一个临时聊天库目录。**不读阿阳机器上真实的 D 盘目录**：那里有 60 个群、
     * 几万条消息，用例会慢到不可接受，而且判定结果会随真实数据漂移 ——
     * 那种用例不是断言，是趋势观察。
     */
    chatDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanhe-pool-'))
    const chatroom = `${PREFIX}talk`
    const messages = [
      '| 时间 | 发送人 | 内容 |',
      '| --- | --- | --- |',
      `| ${hoursAgo(4)} | 客户 | 量尺什么时候来 |`,
      `| ${hoursAgo(3)} | 客户 | 图纸今天能出吗 |`,
      `| ${hoursAgo(2)} | 客户 | 复尺约在周四 |`,
      `| ${hoursAgo(1)} | 客户 | 见光板用白色 |`,
    ]
    fs.writeFileSync(
      path.join(chatDir, `${chatroom}.md`),
      ['---', `username: ${chatroom}`, 'msg_count: 4', '---', '', ...messages, ''].join('\n'),
      'utf8',
    )

    const sample = await createCustomer(
      { realName: '归类样本客户', region: '成都', chatroom },
      SYSTEM_VIEWER,
    )
    if (!sample.ok) throw new Error('建归类样本客户失败')
    sampleId = sample.data.id

    /*
     * 第二位：有 `msgRows` 但归档目录里找不到同名群文件 —— 模拟「容器没挂 D 盘」
     * 与「群里改过名」两种真实情况。`msgRows` 只能用 `update` 补，因为人工录入
     * 不经过抓取脚本，条数本来就是 0。
     */
    const stored = await createCustomer(
      { realName: '无原文样本客户', region: '成都', chatroom: `${PREFIX}stored` },
      SYSTEM_VIEWER,
    )
    if (!stored.ok) throw new Error('建无原文样本客户失败')
    storedId = stored.data.id
    await prisma.customer.update({
      where: { id: storedId },
      data: { msgRows: 42, stage: 'measured' },
    })

    const wrong = await createCustomer(
      { realName: '错栏样本客户', region: '成都', chatroom: `${PREFIX}wrong` },
      SYSTEM_VIEWER,
    )
    if (!wrong.ok) throw new Error('建错栏样本客户失败')
    wrongId = wrong.data.id
  })

  after(async () => {
    await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    if (chatDir !== undefined) fs.rmSync(chatDir, { recursive: true, force: true })
  })

  test('读得到原文时按词频判设计师，依据里带出命中的词', async () => {
    const result = await classifyPool({ viewer: SYSTEM_VIEWER, chatDir, customerIds: [sampleId] })
    assert.equal(result.source, 'archive', '临时目录里有群文件，source 应为 archive')
    assert.equal(result.analyzed, 1)
    assert.equal(result.failed, 0)

    const suggestion = await readSuggestion(sampleId)
    assert.ok(suggestion, '应当写出一条建议')
    assert.equal(suggestion.role, 'designer')
    const reasons = suggestion.reasons as { code: string; detail: string }[]
    const keyword = reasons.find((reason) => reason.code === 'keyword-designer')
    assert.ok(keyword, '依据里必须有词频那一条，否则复核的人不知道凭什么判的')
    assert.match(keyword.detail, /量尺×1/, `依据要写出命中明细，实际「${keyword.detail}」`)
    // 读到原文就不该出现「没读到群文件」—— 那条依据是降级信号，不是常态。
    assert.equal(
      reasons.some((reason) => reason.code === 'no-transcript'),
      false,
      '读到原文时不应出现 no-transcript 依据',
    )
    assert.ok(suggestion.confidence > 20, `置信度应高于下限，实际 ${suggestion.confidence}`)
  })

  test('有汇总但读不到原文时置信度封顶 45，并写明「没有读到群文件」', async () => {
    /* 封顶失效的表现是「读不到群文件的客户」看起来和「算得很准」一模一样。
       容器里没挂 D 盘时走的就是这条路 —— `msgRows` 有值说明库里有汇总，
       够出一个结论，但证据只剩阶段与档案字段。 */
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'fanhe-pool-empty-'))
    try {
      const result = await classifyPool({
        viewer: SYSTEM_VIEWER,
        chatDir: empty,
        customerIds: [storedId],
      })
      assert.equal(result.source, 'stored')

      const suggestion = await readSuggestion(storedId)
      assert.ok(suggestion)
      assert.ok(suggestion.confidence <= 45, `应封顶 45，实际 ${suggestion.confidence}`)
      const reasons = suggestion.reasons as { code: string }[]
      assert.ok(
        reasons.some((reason) => reason.code === 'no-transcript'),
        '依据里必须写明没有读到群文件，否则复核的人会以为算得很准',
      )
    } finally {
      fs.rmSync(empty, { recursive: true, force: true })
    }
  })

  test('一条聊天记录都没有时走「默认销售」分支，不假装有依据', async () => {
    /* `msgRows` 为 0 与「读不到原文」是两种不同状态：前者是流程起点（新客户默认
       销售接待），后者是有汇总但缺证据。混成一条的后果是新客户被当成「判过一轮」，
       复核队列里出现一堆置信度 45 的噪音。 */
    const fresh = await createCustomer(
      { realName: '无记录客户', region: '成都', chatroom: `${PREFIX}fresh` },
      SYSTEM_VIEWER,
    )
    assert.ok(fresh.ok)
    await classifyPool({ viewer: SYSTEM_VIEWER, chatDir, customerIds: [fresh.data.id] })

    const suggestion = await readSuggestion(fresh.data.id)
    assert.equal(suggestion?.role, 'sales')
    assert.equal(suggestion?.confidence, 20)
    const reasons = suggestion?.reasons as { code: string }[]
    assert.equal(reasons[0]?.code, 'no-history')
  })

  test('复核必须留一句话', async () => {
    /* 三个月后回看「为什么把他划给设计师」，只有这条注释能回答。判定依据说明的是
       机器怎么想，注释说明的是人怎么想，两者不能互相替代。 */
    const pool = await listPool(SYSTEM_VIEWER)
    const row = pool.items.find((item) => item.id === sampleId)
    assert.ok(row?.suggestion, '样本客户应当在公共池里，且带着一条建议')

    const result = await reviewPoolSuggestion(
      sampleId,
      row.suggestion.id,
      { decision: 'accepted', note: '   ' },
      SYSTEM_VIEWER,
    )
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'missing_reason')
  })

  test('调整归类：按复核人指定的角色落归属，并同步状态', async () => {
    const pool = await listPool(SYSTEM_VIEWER)
    const row = pool.items.find((item) => item.id === sampleId)
    assert.ok(row?.suggestion)

    const result = await reviewPoolSuggestion(
      sampleId,
      row.suggestion.id,
      { decision: 'adjusted', role: 'sales', userId: sales.id, note: '这家一直在谈价格' },
      SYSTEM_VIEWER,
    )
    assert.equal(result.ok, true, result.ok ? '' : result.reason)
    assert.equal(result.ok ? result.data.suggestion.status : '', 'adjusted')

    const detail = await getCustomer(sampleId, SYSTEM_VIEWER)
    assert.ok(detail.ok)
    assert.equal(detail.data.assignment.salesId, sales.id)
    assert.equal(detail.data.assignment.designerId, null)

    // 落了归属之后就不该再出现在公共池里 —— 否则复核完还挂在那儿，看起来像没生效。
    const after = await listPool(SYSTEM_VIEWER)
    assert.equal(
      after.items.some((item) => item.id === sampleId),
      false,
      '已归属的客户不应继续留在公共池',
    )
  })

  test('角色与栏位不符时拒收：销售不能被记进 designer_id', async () => {
    /* 记进去不会报错，但需求第 1 条的「设计师端看到对应的销售」会显示成同一个人 ——
       看起来像数据错乱，实际是归类时选错了栏。 */
    await classifyPool({ viewer: SYSTEM_VIEWER, chatDir, customerIds: [wrongId] })
    const pool = await listPool(SYSTEM_VIEWER)
    const row = pool.items.find((item) => item.id === wrongId)
    assert.ok(row?.suggestion, '错栏样本应当有一条建议')

    const result = await reviewPoolSuggestion(
      wrongId,
      row.suggestion.id,
      { decision: 'adjusted', role: 'designer', userId: sales.id, note: '试一下错栏' },
      SYSTEM_VIEWER,
    )
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'invalid_assignee')

    // 拒收不能留下半截状态：归属没落，建议仍然是待复核。
    const suggestion = await readSuggestion(wrongId)
    assert.equal(suggestion?.status, 'pending')
    const detail = await getCustomer(wrongId, SYSTEM_VIEWER)
    assert.ok(detail.ok)
    assert.equal(detail.data.assignment.designerId, null)
  })

  test('驳回后重跑不覆盖；force 才重算', async () => {
    /* 本文件最重要的一条。重跑无条件 upsert 的后果是每天早上同步一次，人工判断
       被悄悄推翻，而界面上只看到「结论又变了」，没有任何报错。

       **用「驳回」而不是「采用」来验**：采用与调整都会落归属，客户随即离开公共池，
       后续重跑连查都查不到（`where` 两栏皆空），也就验不到「不覆盖」。驳回保留在
       池里，才是这条保护真正生效的场景。 */
    const pool = await listPool(SYSTEM_VIEWER)
    const row = pool.items.find((item) => item.id === wrongId)
    assert.ok(row?.suggestion, '错栏样本应当还在公共池里，带着一条待复核建议')

    const rejected = await reviewPoolSuggestion(
      wrongId,
      row.suggestion.id,
      { decision: 'rejected', note: '这家其实该销售跟，先挂着' },
      SYSTEM_VIEWER,
    )
    assert.equal(rejected.ok, true, rejected.ok ? '' : rejected.reason)
    assert.equal(rejected.ok ? rejected.data.suggestion.status : '', 'rejected')

    const rerun = await classifyPool({ viewer: SYSTEM_VIEWER, chatDir, customerIds: [wrongId] })
    assert.equal(rerun.skipped, 1, '已复核且未 force 时应计入 skipped')
    assert.equal(rerun.analyzed, 0, '不该重新分析')

    const unchanged = await readSuggestion(wrongId)
    assert.equal(unchanged?.status, 'rejected', '状态不能被重跑改掉')
    assert.equal(unchanged?.reviewNote, '这家其实该销售跟，先挂着', '人工注释不能被重跑清空')

    /* `force` 的意义是「我知道会覆盖签字，仍然要重算」。它同时也把状态重置为
       pending —— 否则一条「驳回过」的旧结论会带着旧的复核人出现在队列里。 */
    const forced = await classifyPool({
      viewer: SYSTEM_VIEWER,
      chatDir,
      customerIds: [wrongId],
      force: true,
    })
    assert.equal(forced.skipped, 0)
    assert.equal(forced.analyzed, 1, 'force 之后应当重算')

    const reset = await readSuggestion(wrongId)
    assert.equal(reset?.status, 'pending')
    assert.equal(reset?.reviewNote, null)
    assert.equal(reset?.reviewedBy, null)
  })

  test('已落归属的客户不在归类范围里：重跑既不算也不跳过', async () => {
    /* 这条记录一个刻意的取舍：归类只处理「没人认领」的客户。已归属的客户即便
       传了 id 也查不到 —— 否则一次全量重跑会把人工分好的客户重新排序。 */
    const rerun = await classifyPool({
      viewer: SYSTEM_VIEWER,
      chatDir,
      customerIds: [sampleId],
    })
    assert.equal(rerun.analyzed, 0)
    assert.equal(rerun.skipped, 0, '查不到与「跳过」是两种状态，不能混成一个数')
  })

  test('可指派名单只含设计与销售两类账号', async () => {
    /* 系统账号列表要 `system.user.read`，业务角色没有这个点。而且指派一个人不需要
       知道他什么时候登录过、属于哪个部门。 */
    const result = await listAssignableUsers()
    assert.ok(result.users.length >= 2)
    for (const user of result.users) {
      assert.ok(
        user.role === 'designer' || user.role === 'sales',
        `名单里出现了 ${user.role}：${user.displayName}`,
      )
    }
    // 名单里应当有本文件造的那两位，否则「按角色筛账号」这件事没被真正执行。
    const ids = result.users.map((user) => user.id)
    assert.ok(ids.includes(designer.id), '名单里应有测试设计师')
    assert.ok(ids.includes(sales.id), '名单里应有测试销售')
  })

  test('同负载时按 id 排序：两次调用结果一致', async () => {
    /* 不排序的后果是两次跑出来的建议是不同的人，复核人刷新一次就看到另一个名字，
       会以为规则不稳定。这里验的是可观测面：同一时刻两次调用顺序完全一致。 */
    const first = await listAssignableUsers()
    const second = await listAssignableUsers()
    assert.deepEqual(
      first.users.map((user) => user.id),
      second.users.map((user) => user.id),
    )
  })
})
