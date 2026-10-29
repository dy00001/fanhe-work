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
import { after, before, describe, test } from 'node:test'

import { ORDER_STAGE_COUNT } from '@fanhe/shared'

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
const {
  createCustomer,
  createOrder,
  getCustomer,
  listCustomers,
  setStage,
  updateCustomer,
  updateStep,
} = await import('../src/customer/customers.js')

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

    const created = await createOrder(customer.id, { contractFen: 16_800_000 }, true)
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

    await createOrder(customer.id, { contractFen: 100_000 }, true)
    const second = await createOrder(customer.id, { contractFen: 250_000 }, true)
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
    await createOrder(customer.id, { contractFen: 500_000, receivedFen: 0 }, true)

    const detail = await getCustomer(customer.id, true)
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
    await createOrder(customer.id, { contractFen: 999_000 }, true)

    const detail = await getCustomer(customer.id, false)
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
    await createOrder(customer.id, { contractFen: 120_000 }, true)

    const masked = await listCustomers({ q: customer.shortName }, false)
    assert.equal(masked.financeReadable, false)
    const row = masked.items.find((item) => item.id === customer.id)
    assert.ok(row, '按短名应能检索到自己')
    assert.equal(row.contractTotalFen, null)

    const visible = await listCustomers({ q: customer.shortName }, true)
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
    const created = await createOrder(customer.id, {}, true)
    assert.ok(created.ok)
    const order = created.data.orders[0]
    assert.ok(order)

    const byDate = await updateStep(customer.id, order.id, 2, { finishedAt: '2026-05-20' }, true)
    assert.ok(byDate.ok, `更新环节失败：${byDate.ok ? '' : byDate.reason}`)
    const step2 = byDate.data.orders[0]?.steps.find((step) => step.idx === 2)
    assert.equal(step2?.finishedAt, '2026-05-20')
    assert.equal(step2?.reached, true, '有完成日期就意味着到达过')
    assert.equal(step2?.done, false, '只有日期没有勾完成，done 不能被顺手置真')

    const byDone = await updateStep(customer.id, order.id, 3, { done: true }, true)
    assert.ok(byDone.ok)
    const step3 = byDone.data.orders[0]?.steps.find((step) => step.idx === 3)
    assert.equal(step3?.done, true)
    assert.equal(step3?.reached, true, 'done 必须连带 reached，否则界面显示「未到达但已完成」')
  })

  test('非法日期被拒：2026-02-31 不能静默滚到 3 月', async () => {
    const customer = await seedCustomer('baddate')
    assert.ok(customer)
    const created = await createOrder(customer.id, {}, true)
    assert.ok(created.ok)
    const order = created.data.orders[0]
    assert.ok(order)

    const result = await updateStep(customer.id, order.id, 1, { startedAt: '2026-02-31' }, true)
    assert.equal(result.ok, false)
  })

  test('回退到更早的阶段必须填原因', async () => {
    const customer = await seedCustomer('regress')
    assert.ok(customer)
    await setStage(customer.id, { stage: 'installed' }, true)

    const withoutReason = await setStage(customer.id, { stage: 'measured' }, true)
    assert.equal(withoutReason.ok, false)
    assert.equal(withoutReason.ok ? '' : withoutReason.reason, 'missing_reason')

    const withReason = await setStage(
      customer.id,
      { stage: 'measured', reason: '复尺后尺寸变化' },
      true,
    )
    assert.equal(withReason.ok, true)
    assert.equal(withReason.data.stage, 'measured')
    assert.equal(withReason.data.stageSource, 'manual')
  })

  test('推进不算回退，不要求填原因', async () => {
    const customer = await seedCustomer('forward')
    assert.ok(customer)
    const result = await setStage(customer.id, { stage: 'quoted' }, true)
    assert.equal(result.ok, true)
  })

  test('跨到旁支（退款）不算回退，不要求原因', async () => {
    // `isStageRegression` 只比较主线序号，旁支没有序号。退款是终止而非倒退，
    // 两者的原因字段语义不同，不能混用同一条校验。
    const customer = await seedCustomer('refund')
    assert.ok(customer)
    await setStage(customer.id, { stage: 'installed' }, true)
    const refund = await setStage(customer.id, { stage: 'refunding' }, true)
    assert.equal(refund.ok, true)
  })

  test('改地区后显示名跟着重算，短名同步更新', async () => {
    const customer = await seedCustomer('rename')
    assert.ok(customer)
    assert.equal(customer.displayName, '青海李月秋')

    const updated = await updateCustomer(customer.id, { region: '宁夏' }, true)
    assert.ok(updated.ok)
    // 两列一起重算。只改一个会让「显示名 = 地区 + 短名」这条不变式失效。
    assert.equal(updated.data.displayName, '宁夏李月秋')
    assert.equal(updated.data.shortName, '李月秋')
    assert.equal(updated.data.region, '宁夏')
  })

  test('不存在的客户返回 not_found，不抛错', async () => {
    const missing = await getCustomer('00000000-0000-0000-0000-000000000000', true)
    assert.equal(missing.ok, false)
    assert.equal(missing.ok ? '' : missing.reason, 'not_found')
  })

  test('订单与客户不匹配时按不存在处理，不能跨客户读到别人的单', async () => {
    const a = await seedCustomer('cross-a')
    const b = await seedCustomer('cross-b')
    assert.ok(a && b)
    const orderOfA = await createOrder(a.id, {}, true)
    assert.ok(orderOfA.ok)
    const orderId = orderOfA.data.orders[0]?.id
    assert.ok(orderId)

    // 用 B 的 id 去改 A 的单：必须 404，而不是悄悄改掉别人的进度。
    const result = await updateStep(b.id, orderId, 1, { done: true }, true)
    assert.equal(result.ok, false)
    assert.equal(result.ok ? '' : result.reason, 'not_found')
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
