/**
 * 客户档案与订单的集成测试。
 *
 * 需要真实数据库，理由与 `ops.test.ts` 相同：金额裁剪发生在 Prisma 查出来的行上，
 * 用内存替身测等于测替身本身。
 *
 * 这个文件守四件事，每一件都对应一种「界面上看不出来」的坏法：
 *
 *   1. **金额裁剪的位置。** 无 `customer.finance.read` 时整个 `amounts` 为 null，
 *      有权限时连 0 也原样保留。裁判断写在取数路径上（运维看板首版踩过）的表现是
 *      所有人看不到金额而其余字段正常 —— 只测「列表有数据」的用例全绿。
 *   2. **显示名派生。** 地区进显示名、台湾写「中国台湾」、短名裁掉重复尊称。这三条
 *      由契约函数保证，这里验的是**接口层真的调了它**，而不是前端自己拼。
 *   3. **订单初始环节。** 新单必须铺满十四个未到达的环节，且序号从 1 连续。
 *   4. **回退必须填原因。** 主线内倒退而没有原因时返回 `missing_reason`，
 *      否则「客户反悔了」与「之前记错了」在时间轴上分不开。
 *
 * 测试数据统一用 `zz_test_` 前缀的 chatroom，结束时按这个前缀级联删除
 * （订单与环节随客户删除，见 schema 的 onDelete: Cascade）。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import {
  CUSTOMER_ACTIVITY_HOURS,
  ORDER_STAGE_COUNT,
  ROLE_CODES,
  bucketHourlyActivity,
} from '@fanhe/shared'

import { resolveTestDatabaseUrl } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

/**
 * `buildApp` 必须**动态**导入，不能写在 import 区。
 *
 * 静态导入在求值时就会拉起整条依赖链（`env.ts` → 校验 `DATABASE_URL`），而那时
 * 上面的 `process.env.DATABASE_URL` 赋值还没执行 —— `test-env.ts` 先把地址设成了
 * 一个不可达值，于是整片用例都连不上库。这个坑踩过一次：19 条同时变红，看上去
 * 像客户模块坏了，真正的原因是导入顺序。
 */
const { buildApp } = await import('../src/app.js')
const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const {
  createCustomer,
  createOrder,
  getCustomer,
  listCustomers,
  setStage,
  updateCustomer,
  updateStep,
} = await import('../src/customer/customers.js')
const { SYSTEM_VIEWER } = await import('../src/customer/scope.js')

/**
 * 有范围但没有金额权限的观察者。
 *
 * 用 `{ ...SYSTEM_VIEWER }` 派生而不是手写字面量：`CustomerViewer` 以后再加字段时，
 * 手写的那份不会报错，只会静默变成「少了一个事实」。
 */
const NO_FINANCE_VIEWER = { ...SYSTEM_VIEWER, canReadFinance: false }

const PREFIX = 'zz_test_customer_'

describe('客户档案与订单', { skip: databaseUrl === null ? '数据库不可达' : false }, () => {
  before(async () => {
    await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })
  })

  after(async () => {
    await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })
  })

  /** 建一个测试客户，返回 id。名称带随机后缀，避免同一进程里重名撞唯一约束。 */
  async function seedCustomer(
    suffix: string,
    overrides: Partial<Parameters<typeof createCustomer>[0]> = {},
  ) {
    const result = await createCustomer({
      // 真名不带后缀：唯一性由 chatroom 承担，而真名带上英文后缀会让
      // 「裁掉重复尊称」那条规则失去作用（尊称不再是结尾），测的就不是它了。
      realName: '李月秋李姐',
      region: '青海',
      chatroom: `${PREFIX}${suffix}`,
      ...overrides,
    })
    assert.equal(result.ok, true, `建客户失败：${result.ok ? '' : result.reason}`)
    return result.ok ? result.data : null
  }

  test('显示名由地区 + 裁掉重复姓的短名组成', async () => {
    const customer = await seedCustomer('display')
    assert.ok(customer)
    // 「李月秋李姐」→ 裁掉与姓重复的「李姐」→「李月秋」；地区「青海」进前缀。
    assert.equal(customer.displayName, '青海李月秋')
    assert.equal(customer.shortName, '李月秋')
    assert.equal(customer.regionScope, 'domestic')
    // 人工录入即视为已确认：录进来这件事本身就是人签过字的动作。
    assert.equal(customer.reviewStatus, 'confirmed')
  })

  test('台湾、香港、澳门一律规范成「中国…」，层级为 special-region', async () => {
    const customer = await seedCustomer('tw', { realName: '廖丞婕', region: '台湾' })
    assert.ok(customer)
    assert.equal(customer.region, '中国台湾')
    assert.equal(customer.regionScope, 'special-region')
    assert.equal(customer.displayName, '中国台湾廖丞婕')
  })

  test('海外地区判为 overseas', async () => {
    const customer = await seedCustomer('us', { realName: '糖糖姐', region: '美国' })
    assert.ok(customer)
    assert.equal(customer.regionScope, 'overseas')
    // 叠字昵称不被削：糖糖姐 三个字，裁掉「姐」只剩「糖糖」两个字，属于真实昵称。
    assert.equal(customer.displayName, '美国糖糖姐')
  })

  test('空地区被拒：地区不是可选信息，缺了显示名就少一段', async () => {
    const result = await createCustomer({ realName: '某某', region: '   ' })
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'invalid_region')
  })

  test('同一个微信群不能绑两个客户', async () => {
    await seedCustomer('dup')
    const again = await createCustomer({
      realName: '另一个人',
      region: '青海',
      chatroom: `${PREFIX}dup`,
    })
    assert.equal(again.ok, false)
    assert.equal(again.ok ? '' : again.reason, 'duplicate_chatroom')
  })

  test('新建订单铺满十四个未到达的环节，序号为 1', async () => {
    const customer = await seedCustomer('order')
    assert.ok(customer)

    const created = await createOrder(customer.id, { contractFen: 16_800_000 }, SYSTEM_VIEWER)
    assert.equal(created.ok, true, `建单失败：${created.ok ? '' : created.reason}`)
    assert.ok(created.ok)
    const order = created.data.orders[0]
    assert.ok(order)
    assert.equal(order.steps.length, ORDER_STAGE_COUNT)
    assert.deepEqual(
      order.steps.map((step) => step.idx),
      Array.from({ length: ORDER_STAGE_COUNT }, (_, index) => index + 1),
    )
    for (const step of order.steps) {
      assert.equal(step.reached, false, `${step.name} 不该一开始就是已到达`)
      assert.equal(step.done, false)
    }
    // 人工录入的编号走 ORD- 前缀，与看板编号（BT-01）分开。
    assert.ok(order.code.startsWith('ORD-'), `订单编号应是 ORD- 前缀，实际 ${order.code}`)
  })

  test('第二单的序号为 2、标记复购，且客户级汇总是两单之和', async () => {
    const customer = await seedCustomer('repeat')
    assert.ok(customer)

    await createOrder(customer.id, { contractFen: 100_000 }, SYSTEM_VIEWER)
    const second = await createOrder(customer.id, { contractFen: 250_000 }, SYSTEM_VIEWER)
    assert.ok(second.ok)

    const orders = second.data.orders
    assert.equal(orders.length, 2)
    assert.equal(orders[0]?.seq, 1)
    assert.equal(orders[1]?.seq, 2)
    assert.equal(orders[0]?.isRepeat, false)
    assert.equal(orders[1]?.isRepeat, true)
    // 派生列：100000 + 250000。**不是**按合同减已收推出来的。
    assert.equal(second.data.contractTotalFen, 350_000)
    assert.equal(second.data.hasRepeat, true)
  })

  test('看得到金额时原样返回，包括已收 0 元', async () => {
    const customer = await seedCustomer('fin-visible')
    assert.ok(customer)
    await createOrder(customer.id, { contractFen: 500_000, receivedFen: 0 }, SYSTEM_VIEWER)

    const detail = await getCustomer(customer.id, SYSTEM_VIEWER)
    assert.ok(detail.ok)
    const order = detail.data.orders[0]
    assert.ok(order)
    const amounts = order.amounts
    // `!= null` 同时挡住 undefined 与 null：`orders[0]` 在 noUncheckedIndexedAccess
    // 下可能是 undefined，而 `amounts` 又可能是 null（无权限），两者都要挡。
    assert.ok(amounts != null)
    assert.equal(amounts.contractFen, 500_000)
    // 已收 0 是事实（合同签了钱没到），不能被写成 null 让它看起来像没录。
    assert.equal(amounts.receivedFen, 0)
  })

  test('看不到金额时整个 amounts 为 null，其余字段照常', async () => {
    // **本文件最重要的一条。** 裁判断写在取数路径上的后果是所有人都看不到金额，
    // 而只断言「列表有数据」的用例照样全绿。
    const customer = await seedCustomer('fin-masked')
    assert.ok(customer)
    await createOrder(customer.id, { contractFen: 999_000 }, SYSTEM_VIEWER)

    const detail = await getCustomer(customer.id, NO_FINANCE_VIEWER)
    assert.ok(detail.ok)
    const order = detail.data.orders[0]
    assert.ok(order)
    assert.equal(order.amounts, null)
    // 明细本身不能跟着一起消失：看不到钱，不代表看不到这单走到哪一步。
    assert.equal(order.steps.length, ORDER_STAGE_COUNT)
    assert.equal(order.code.startsWith('ORD-'), true)
    // 客户级汇总同样裁掉。
    assert.equal(detail.data.contractTotalFen, null)
  })

  test('列表的 financeReadable 与裁剪一致，汇总按当前筛选统计', async () => {
    const customer = await seedCustomer('list')
    assert.ok(customer)
    await createOrder(customer.id, { contractFen: 120_000 }, SYSTEM_VIEWER)

    const masked = await listCustomers({ q: customer.shortName, viewer: NO_FINANCE_VIEWER })
    assert.equal(masked.financeReadable, false)
    const row = masked.items.find((item) => item.id === customer.id)
    assert.ok(row, '按短名应能检索到自己')
    assert.equal(row.contractTotalFen, null)

    const visible = await listCustomers({ q: customer.shortName, viewer: SYSTEM_VIEWER })
    assert.equal(visible.financeReadable, true)
    assert.equal(visible.items.find((item) => item.id === customer.id)?.contractTotalFen, 120_000)
    // 汇总按筛选条件算：只命中自己，因此各层级合计应为 1。
    const scopeTotal =
      visible.summary.byScope.domestic +
      visible.summary.byScope.overseas +
      visible.summary.byScope['special-region']
    assert.equal(scopeTotal, visible.total)
  })

  test('填了完成日期即视为已到达，done 也把 reached 带上', async () => {
    const customer = await seedCustomer('step')
    assert.ok(customer)
    const created = await createOrder(customer.id, {}, SYSTEM_VIEWER)
    assert.ok(created.ok)
    const order = created.data.orders[0]
    assert.ok(order)

    const byDate = await updateStep(
      customer.id,
      order.id,
      2,
      { finishedAt: '2026-05-20' },
      SYSTEM_VIEWER,
    )
    assert.ok(byDate.ok, `更新环节失败：${byDate.ok ? '' : byDate.reason}`)
    const step2 = byDate.data.orders[0]?.steps.find((step) => step.idx === 2)
    assert.equal(step2?.finishedAt, '2026-05-20')
    assert.equal(step2?.reached, true, '有完成日期就意味着到达过')
    assert.equal(step2?.done, false, '只有日期没有勾完成，done 不能被顺手置真')

    const byDone = await updateStep(customer.id, order.id, 3, { done: true }, SYSTEM_VIEWER)
    assert.ok(byDone.ok)
    const step3 = byDone.data.orders[0]?.steps.find((step) => step.idx === 3)
    assert.equal(step3?.done, true)
    assert.equal(step3?.reached, true, 'done 必须连带 reached，否则界面显示「未到达但已完成」')
  })

  test('非法日期被拒：2026-02-31 不能静默滚到 3 月', async () => {
    const customer = await seedCustomer('baddate')
    assert.ok(customer)
    const created = await createOrder(customer.id, {}, SYSTEM_VIEWER)
    assert.ok(created.ok)
    const order = created.data.orders[0]
    assert.ok(order)

    const result = await updateStep(
      customer.id,
      order.id,
      1,
      { startedAt: '2026-02-31' },
      SYSTEM_VIEWER,
    )
    assert.equal(result.ok, false)
  })

  test('回退到更早的阶段必须填原因', async () => {
    const customer = await seedCustomer('regress')
    assert.ok(customer)
    await setStage(customer.id, { stage: 'installed' }, SYSTEM_VIEWER)

    const withoutReason = await setStage(customer.id, { stage: 'measured' }, SYSTEM_VIEWER)
    assert.equal(withoutReason.ok, false)
    assert.equal(withoutReason.ok ? '' : withoutReason.reason, 'missing_reason')

    const withReason = await setStage(
      customer.id,
      { stage: 'measured', reason: '复尺后尺寸变化' },
      SYSTEM_VIEWER,
    )
    assert.equal(withReason.ok, true)
    assert.equal(withReason.data.stage, 'measured')
    assert.equal(withReason.data.stageSource, 'manual')
  })

  test('推进不算回退，不要求填原因', async () => {
    const customer = await seedCustomer('forward')
    assert.ok(customer)
    const result = await setStage(customer.id, { stage: 'quoted' }, SYSTEM_VIEWER)
    assert.equal(result.ok, true)
  })

  test('跨到旁支（退款）不算回退，不要求原因', async () => {
    // `isStageRegression` 只比较主线序号，旁支没有序号。退款是终止而非倒退，
    // 两者的原因字段语义不同，不能混用同一条校验。
    const customer = await seedCustomer('refund')
    assert.ok(customer)
    await setStage(customer.id, { stage: 'installed' }, SYSTEM_VIEWER)
    const refund = await setStage(customer.id, { stage: 'refunding' }, SYSTEM_VIEWER)
    assert.equal(refund.ok, true)
  })

  test('改地区后显示名跟着重算，短名同步更新', async () => {
    const customer = await seedCustomer('rename')
    assert.ok(customer)
    assert.equal(customer.displayName, '青海李月秋')

    const updated = await updateCustomer(customer.id, { region: '宁夏' }, SYSTEM_VIEWER)
    assert.ok(updated.ok)
    // 两列一起重算。只改一个会让「显示名 = 地区 + 短名」这条不变式失效。
    assert.equal(updated.data.displayName, '宁夏李月秋')
    assert.equal(updated.data.shortName, '李月秋')
    assert.equal(updated.data.region, '宁夏')
  })

  test('不存在的客户返回 not_found，不抛错', async () => {
    const missing = await getCustomer('00000000-0000-0000-0000-000000000000', SYSTEM_VIEWER)
    assert.equal(missing.ok, false)
    assert.equal(missing.ok ? '' : missing.reason, 'not_found')
  })

  test('订单与客户不匹配时按不存在处理，不能跨客户读到别人的单', async () => {
    const a = await seedCustomer('cross-a')
    const b = await seedCustomer('cross-b')
    assert.ok(a && b)
    const orderOfA = await createOrder(a.id, {}, SYSTEM_VIEWER)
    assert.ok(orderOfA.ok)
    const orderId = orderOfA.data.orders[0]?.id
    assert.ok(orderId)

    // 用 B 的 id 去改 A 的单：必须 404，而不是悄悄改掉别人的进度。
    const result = await updateStep(b.id, orderId, 1, { done: true }, SYSTEM_VIEWER)
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'not_found')
  })

  /*
   * 下面四条守综合看板与客户进度共用的那套口径。它们的错法都不会报错：
   * 时间筛到别的字段上，列表少几个人；金额汇总各算一遍，卡片与环形图对不上；
   * 活跃度把窗口外的时间并进首尾格，折线两端凭空变高。
   */

  test('时间筛选按最近消息时间切，汇总与列表同源', async () => {
    const now = new Date(2026, 9, 30, 15, 0)
    const minute = 60 * 1000
    const hour = 60 * minute
    const day = 24 * hour

    const fresh = await seedCustomer('win-fresh', { realName: '时晓光' })
    const stale = await seedCustomer('win-stale', { realName: '时晓光' })
    assert.ok(fresh && stale)

    await prisma.customer.update({
      where: { id: fresh.id },
      data: {
        lastMessageAt: new Date(now.getTime() - 30 * minute),
        firstMessageAt: new Date(now.getTime() - 3 * hour),
      },
    })
    await prisma.customer.update({
      where: { id: stale.id },
      data: {
        lastMessageAt: new Date(now.getTime() - 40 * day),
        firstMessageAt: new Date(now.getTime() - 400 * day),
      },
    })

    const window = { from: new Date(now.getTime() - 2 * hour), to: now, now }
    const listed = await listCustomers({ q: '时晓光', ...window, viewer: SYSTEM_VIEWER })
    assert.equal(listed.total, 1, '只有最近两小时有消息的那位落在区间内')
    assert.equal(listed.items[0]?.id, fresh.id)

    // 只回汇总时列表为空，但总数与图表数据照常。
    const summaryOnly = await listCustomers({
      q: '时晓光',
      mode: 'summary',
      ...window,
      viewer: SYSTEM_VIEWER,
    })
    assert.equal(summaryOnly.items.length, 0, 'summary 模式不取列表行')
    assert.equal(summaryOnly.total, 1)
    const stageTotal = summaryOnly.summary.byStage.reduce((sum, bucket) => sum + bucket.count, 0)
    assert.equal(stageTotal, 1, '阶段分布必须与 total 对得上')
    assert.equal(summaryOnly.summary.kpi.newInWindow, 0, '首次沟通在 3 小时前，落在两小时窗口外')

    // 不加时间条件时，「窗口内新增」退化成总数。
    const noWindow = await listCustomers({
      q: '时晓光',
      mode: 'summary',
      now,
      viewer: SYSTEM_VIEWER,
    })
    assert.equal(noWindow.total, 2)
    assert.equal(noWindow.summary.kpi.newInWindow, 2)
  })

  test('金额按地区层级汇总，无权限时整组为 null', async () => {
    const domestic = await seedCustomer('amt-dom', { realName: '金算盘' })
    const overseas = await seedCustomer('amt-sea', { realName: '金算盘', region: '美国' })
    assert.ok(domestic && overseas)
    await createOrder(domestic.id, { contractFen: 100_000 }, SYSTEM_VIEWER)
    await createOrder(overseas.id, { contractFen: 250_000 }, SYSTEM_VIEWER)

    const visible = await listCustomers({ q: '金算盘', mode: 'summary', viewer: SYSTEM_VIEWER })
    assert.equal(visible.summary.amountByScope?.domestic, 100_000)
    assert.equal(visible.summary.amountByScope?.overseas, 250_000)
    assert.equal(visible.summary.amountTotalFen, 350_000)

    const masked = await listCustomers({ q: '金算盘', mode: 'summary', viewer: NO_FINANCE_VIEWER })
    // 两个字段必须同生同灭：只裁一个会出现「KPI 有数字、环形图空着」的画面。
    assert.equal(masked.summary.amountByScope, null)
    assert.equal(masked.summary.amountTotalFen, null)
    // 金额被裁掉不影响人数统计。
    assert.equal(masked.total, visible.total)
  })

  test('进行中不含已完结与已流失', async () => {
    const open = await seedCustomer('kpi-open', { realName: '盘点客户' })
    const closed = await seedCustomer('kpi-closed', { realName: '盘点客户' })
    const lost = await seedCustomer('kpi-lost', { realName: '盘点客户' })
    assert.ok(open && closed && lost)

    await prisma.customer.update({ where: { id: closed.id }, data: { stage: 'closed' } })
    await prisma.customer.update({ where: { id: lost.id }, data: { stage: 'lost' } })

    const result = await listCustomers({ q: '盘点客户', mode: 'summary', viewer: SYSTEM_VIEWER })
    assert.equal(result.total, 3)
    assert.equal(result.summary.kpi.inProgress, 1)
  })

  test('活跃度分桶：24 格对齐整点，窗口外的时间不并入首尾格', () => {
    const now = new Date(2026, 9, 30, 15, 7)
    // 窗口是 [10-29 16:00, 10-30 16:00)：末端对齐到「当前小时的下一个小时」。
    const points = bucketHourlyActivity(
      [
        new Date(2026, 9, 29, 16, 0).toISOString(), // 恰好是起点，含
        new Date(2026, 9, 29, 15, 59).toISOString(), // 起点前一分钟，丢弃
        new Date(2026, 9, 30, 14, 30).toISOString(),
        new Date(2026, 9, 30, 15, 5).toISOString(), // 正在进行中的那一小时
        null,
      ],
      now,
    )

    assert.equal(points.length, CUSTOMER_ACTIVITY_HOURS)
    assert.equal(
      points.reduce((sum, point) => sum + point.count, 0),
      3,
      '窗口外的两条必须丢弃，不能被并进首格',
    )
    assert.equal(points[0]?.count, 1, '起点那一格')
    assert.equal(points[22]?.count, 1, '14:00 那一格')
    assert.equal(points[23]?.count, 1, '当前小时')
    assert.equal(new Date(points[23]?.hourStart ?? '').getHours(), 15)
    assert.equal(new Date(points[0]?.hourStart ?? '').getHours(), 16)
  })
})

/**
 * 接口层的准入。
 *
 * 只验一件事：**守卫在路由之前生效**。服务层那 18 条测的是业务规则，跑的时候
 * 直接调函数、绕过了 HTTP —— 于是「路由忘了挂 preHandler」这类缺陷一条都测不出来，
 * 而它的后果是任何人都能用一条请求读走全部客户档案。
 *
 * 不验证「member 拿到 403」：那需要造一个真实令牌，而令牌签发那条路径已有独立
 * 测试。这里用「没带令牌一律 401」把「守卫确实挂上了」这件事钉住即可。
 */
describe('客户接口的准入', () => {
  test('未登录时读、写、改都要 401', async () => {
    const app = buildApp({ logger: false })
    try {
      /* 写接口要带上合法请求体：Fastify 先做 schema 校验再走 preHandler，空 body
         会先被 400 拦下 —— 那样测到的是 schema，不是准入。 */
      const cases = [
        { method: 'GET', url: '/api/customers', payload: undefined },
        { method: 'POST', url: '/api/customers', payload: { realName: '某', region: '青海' } },
        {
          method: 'GET',
          url: '/api/customers/00000000-0000-0000-0000-000000000000',
          payload: undefined,
        },
        {
          method: 'PUT',
          url: '/api/customers/00000000-0000-0000-0000-000000000000/stage',
          payload: { stage: 'quoted' },
        },
      ] as const

      for (const entry of cases) {
        // 请求体按需挂上去，不在对象字面量里写 `payload: undefined`：开了
        // exactOptionalPropertyTypes 之后，「没有这个属性」与「显式传 undefined」
        // 不再等价，而 InjectOptions.payload 的取值域不含 undefined。
        const response = await app.inject(
          entry.payload === undefined
            ? { method: entry.method, url: entry.url }
            : { method: entry.method, url: entry.url, payload: entry.payload },
        )
        assert.equal(response.statusCode, 401, `${entry.method} ${entry.url} 应当返回 401`)
      }
    } finally {
      await app.close()
    }
  })
})

/**
 * 时间参数走完整 HTTP 链路的那一层。
 *
 * 上面「客户档案与订单」那一段全部直接调 `listCustomers(...)`，**绕过了 Fastify 的
 * querystring schema 校验**。结果是 370 条用例全绿、界面上却点任何一档时间筛选都
 * 「加载失败」—— 页面把 `Date.toISOString()` 拼进了地址，产出
 * `2026-10-01T00:00:00.000Z`，pattern 当场拒收。
 *
 * 这类缺陷只在「前端实际发出的那串字符」与「服务端 schema」的交界处出现，service
 * 层的单元测试和集成测试都碰不到它。所以这一段只做一件事：拿真实的查询字符串去
 * 请求真实的路由。
 */
describe(
  '客户接口的时间参数（走 HTTP）',
  { skip: databaseUrl === null ? '数据库不可达' : false },
  () => {
    const TEST_PASSWORD = 'integration-test-password'
    /** 与 note.test.ts 分开一段地址，清理时互不干扰。 */
    const TEST_IP = '198.51.100.42'
    const createdUserIds: string[] = []

    let app: ReturnType<typeof buildApp>
    let headers: { authorization: string }

    before(async () => {
      const owner = await prisma.role.findUnique({
        where: { code: ROLE_CODES.OWNER },
        select: { id: true },
      })
      if (owner === null) throw new Error('库里没有 owner 角色，先执行 pnpm db:seed')

      const user = await prisma.user.create({
        data: {
          username: `${PREFIX}http_${randomUUID().replaceAll('-', '').slice(0, 16)}`,
          passwordHash: await hashPassword(TEST_PASSWORD),
          displayName: '客户接口时间参数测试',
          roleId: owner.id,
        },
        select: { id: true, username: true },
      })
      createdUserIds.push(user.id)

      const result = await login({ username: user.username, password: TEST_PASSWORD, ip: TEST_IP })
      if (!result.ok) throw new Error(`测试账号登录失败：${result.reason}`)
      headers = { authorization: `Bearer ${result.data.accessToken}` }
      app = buildApp({ logger: false })
    })

    after(async () => {
      await app.close()
      if (createdUserIds.length > 0) {
        await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
      }
      await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
      await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    })

    function list(url: string) {
      return app.inject({ method: 'GET', url, headers })
    }

    test('前端现在会发的短格式能通过校验', async () => {
      /* 这三串就是 `rangeQuery` 的产出形态：本地零点写成日期，带时刻的写到分钟。
       它们是本次修复的目标形态，接口必须全部接受。

       注意 URL 里**不带** `p`：那是前端地址栏的档位参数，只用于两栏之间传状态，
       不发给接口。schema 是 strict 的（见下一条），多发一个就 400。 */
      const urls = [
        '/api/customers?from=2026-10-01&to=2027-01-01&mode=summary',
        '/api/customers?from=2026-10-30&to=2026-10-31',
        '/api/customers?from=2026-10-30T14:00&to=2026-10-30T15:00',
      ]
      for (const url of urls) {
        const response = await list(url)
        assert.equal(response.statusCode, 200, `${url} 应当返回 200，实际 ${response.body}`)
      }
    })

    test('完整 ISO 被拒：这正是那次「加载失败」的形态', async () => {
      /* 记录故障形态，而不是记录「我们期望它好」。接口拒收完整 ISO 是有意的：
       它带 Z，是 UTC，东八区的「本月」会被解释成上月最后一天的 16 点。

       这一层由 Fastify 的 pattern 校验拦下，返回的是标准校验错误体（英文），
       不是路由内自己发的 `invalid_range`。两者都算拒收，区别只在文案来源 ——
       断言按实际来源写，否则测的是一个不存在的约定。 */
      const response = await list('/api/customers?from=2026-10-01T00:00:00.000Z&to=2027-01-01')
      assert.equal(response.statusCode, 400, `完整 ISO 应当被拒，实际 ${response.statusCode}`)
      assert.equal(response.json().code, 'FST_ERR_VALIDATION')
      assert.match(String(response.json().message), /pattern/, '提示应当指向 pattern，便于排查')
    })

    test('多带未声明的参数会被拒：前端加参数必须同步 schema', async () => {
      /* `p` 是地址栏的档位参数。它一旦被误塞进请求，整条列表就 400。这条断言把
       「前端参数集与接口 schema 必须一致」钉住，否则新增一个前端筛选条件忘了
       加 schema，表现又是「界面加载失败」而测试全绿。 */
      const response = await list('/api/customers?p=quarter')
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().code, 'FST_ERR_VALIDATION')
    })

    test('起点不早于终点时拒收，不放过去变成空列表', async () => {
      const response = await list('/api/customers?from=2026-10-31&to=2026-10-01')
      assert.equal(response.statusCode, 400)
      assert.equal(response.json().error, 'invalid_range')
    })

    test('不存在的日期不被静默滚到下个月', async () => {
      const response = await list('/api/customers?from=2026-02-31&to=2026-03-05')
      assert.equal(response.statusCode, 400, `2026-02-31 应当被拒，实际 ${response.statusCode}`)
    })
  },
)
