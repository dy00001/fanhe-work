/**
 * 每日同步的测试。
 *
 * 这条链路跑在**别人看不到的地方**（宿主机定时任务），所以它出错时最可能的形态是
 * 「什么都不发生」：每天成功退出、报表全绿，而客户列表上的「628 条消息」永远停在
 * 三月。因此这里的断言刻意分两类：
 *
 *   - **该动的必须动**：消息条数、首末时间、跳过数、群文件名（这部分是事实，
 *     重算永远比旧值准）；
 *   - **不该动的一格都不能动**：金额、订单、已复核客户的阶段、看板来源的阶段。
 *     这类错的表现是「数字变了但看起来合理」，比报错难查得多。
 *
 * 数据统一 `zz_test_sync_` 前缀，用临时目录伪造聊天库，结束时级联删除。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

import { resolveTestDatabaseUrl } from './helpers/db.js'

/* 纯类型导入：编译后被完全擦除，不会触发 `env.ts` 求值，因此可以静态写。
   值导入必须走下面的 `await import()`。 */
import type { CustomerStage } from '@fanhe/shared'
import type { SyncChange } from '../src/customer/sync.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

/* 动态导入，理由见 `customer.test.ts` 顶部：静态导入会先求值 `env.ts`，
   而那时 `DATABASE_URL` 还没被覆盖。 */
const { prisma } = await import('../src/db/prisma.js')
const { insertCustomer, createOrder } = await import('../src/customer/customers.js')
const { syncCustomersFromArchive, diffActiveFields, decideStage, nameFromGroupFile } =
  await import('../src/customer/sync.js')

const PREFIX = 'zz_test_sync_'
const CODE_PREFIX = 'ZZSYNC-'

/** 导入来的客户：待复核 + AI 来源，这是同步要跟的那一类。 */
const AI_ORIGIN = {
  nameSource: 'groupname',
  confidence: 'medium',
  reviewStatus: 'pending',
  stageSource: 'ai_stage',
} as const

/**
 * 一份群文件。默认 3 条消息、`ai_stage` 为「已下单」。
 *
 * `合同金额` 故意写成手机号（真实文件就是这样），配合「同步不得改金额」那条断言。
 */
function makeMd(
  chatroom: string,
  options: {
    rows?: number
    aiStage?: string | null
    skipImg?: number
    contract?: string
  } = {},
): string {
  const rows = options.rows ?? 3
  const aiStage = options.aiStage === undefined ? '已下单' : options.aiStage
  const skipImg = options.skipImg ?? 100
  const contract = options.contract ?? '13847391188'

  const lines: string[] = []
  for (let i = 0; i < rows; i += 1) {
    const day = String(10 + i).padStart(2, '0')
    lines.push(`| 2026-10-${day} 09:30 | 客户 | 第 ${i + 1} 条消息 |`)
  }

  const aiBlock = [
    '---',
    '阶段: 已下单',
    aiStage === null ? 'ai_stage:' : `ai_stage: ${aiStage}`,
    'ai_stage_conf: 0.79',
    'ai_schema: 1.2',
    `合同金额: ${contract}`,
    '已收金额: 157',
    '---',
  ].join('\n')

  const idBlock = ['---', 'title: 测试群', 'msg_count: 628', `username: ${chatroom}`, '---'].join(
    '\n',
  )

  return `${aiBlock}\n${idBlock}\n\n# 测试群\n\n> 已跳过 ${skipImg} 条图片消息（按用户要求不提取图片）\n> 语音消息 4 条，已转录\n\n## 聊天记录\n\n| 时间 | 发送人 | 内容 |\n|------|--------|------|\n${lines.join('\n')}\n`
}

let dir = ''
let aliasesFile = ''

function writeGroup(fileBase: string, text: string): void {
  fs.writeFileSync(path.join(dir, `${fileBase}.md`), text, 'utf8')
}

/** 往临时库目录里放一个群文件，名字取 chatroom 的后半段以免重名。 */
function writeGroupFor(chatroom: string, text: string): void {
  writeGroup(chatroom.replace(PREFIX, '测试群-'), text)
}

/**
 * 建一个待同步的客户。
 *
 * 用**具名参数**而不是按位置传：`stage` 属于 input、`stageSource` 属于 origin，
 * 按位置传时把它们放错地方不会有任何报错 —— 库里的阶段就默默变成了默认值
 * `consulting`，「看板来源不被降级」那条用例因此假绿过一次。
 */
async function seed(
  chatroom: string,
  realName: string,
  options: {
    extras?: Record<string, unknown>
    origin?: Record<string, unknown>
    stage?: CustomerStage
  } = {},
): Promise<void> {
  const result = await insertCustomer(
    {
      chatroom,
      realName,
      region: '成都',
      ...(options.stage === undefined ? {} : { stage: options.stage }),
    },
    { ...AI_ORIGIN, ...options.origin },
    options.extras ?? {},
  )
  assert.equal(result.ok, true, `建客户失败：${JSON.stringify(result)}`)
}

function changeOf(changes: readonly SyncChange[], chatroom: string): SyncChange | undefined {
  return changes.find((item) => item.chatroom === chatroom)
}

describe('同步的纯函数', () => {
  test('空文件一格都不改 —— 这是「抓取失败不能清空客户」的唯一防线', () => {
    const row = {
      id: 'x',
      chatroom: 'a@chatroom',
      displayName: '成都某甲',
      shortName: '某甲',
      reviewStatus: 'pending',
      stage: 'producing',
      stageSource: 'ai_stage',
      msgRows: 628,
      firstMessageAt: new Date('2026-07-13T03:15:00Z'),
      lastMessageAt: new Date('2026-10-28T03:48:00Z'),
      skipImg: 100,
      skipVoice: 5,
      groupFile: '某群.md',
    }
    const patch = diffActiveFields(row, {
      file: '某群.md',
      baseName: '某群',
      chatroom: 'a@chatroom',
      msgRows: 0,
      declaredMsgCount: 628,
      firstMessageAt: null,
      lastMessageAt: null,
      skipImg: 0,
      skipVoice: 0,
      aiStage: '已下单',
      aiStageConf: null,
    })
    assert.deepEqual(patch, {})
  })

  test('群名推导只剥后缀，不猜人名', () => {
    assert.equal(nameFromGroupFile('包头李月秋李姐VIP设计沟通群'), '包头李月秋李姐')
    assert.equal(nameFromGroupFile('绿城沟通群'), '绿城')
    // 认不出后缀就整条留着：猜错的代价是造出查无此人的客户，还会被拿去匹配看板。
    assert.equal(nameFromGroupFile('M世代积家 梵禾设计'), 'M世代积家 梵禾设计')
  })

  test('已复核的客户，阶段一律不跟', () => {
    const decision = decideStage(
      {
        id: 'x',
        chatroom: 'a@chatroom',
        displayName: '成都某甲',
        shortName: '某甲',
        reviewStatus: 'confirmed',
        stage: 'consulting',
        stageSource: 'ai_stage',
        msgRows: 1,
        firstMessageAt: null,
        lastMessageAt: null,
        skipImg: 0,
        skipVoice: 0,
        groupFile: null,
      },
      '已下单',
    )
    assert.deepEqual(decision, { kind: 'hold', reason: 'reviewed' })
  })
})

describe('每日同步', { skip: databaseUrl === null ? '数据库不可达' : false }, () => {
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fanhe-chat-'))
    aliasesFile = path.join(dir, '..', `fanhe-aliases-${process.pid}.json`)
    fs.writeFileSync(aliasesFile, JSON.stringify({ excludedGroups: ['广告群'] }), 'utf8')
  })

  beforeEach(async () => {
    await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })
    await prisma.customerOrder.deleteMany({ where: { code: { startsWith: CODE_PREFIX } } })
    for (const name of fs.readdirSync(dir)) fs.rmSync(path.join(dir, name))
  })

  after(async () => {
    await prisma.customer.deleteMany({ where: { chatroom: { startsWith: PREFIX } } })
    await prisma.customerOrder.deleteMany({ where: { code: { startsWith: CODE_PREFIX } } })
    fs.rmSync(dir, { recursive: true, force: true })
    if (fs.existsSync(aliasesFile)) fs.rmSync(aliasesFile)
  })

  test('活跃字段无条件跟着文件走：条数、首末时间、跳过数、群文件名', async () => {
    const chatroom = `${PREFIX}active`
    await seed(chatroom, '测试甲', {
      extras: { msgRows: 1, skipImg: 2, skipVoice: 0, groupFile: '旧名.md' },
    })
    writeGroupFor(chatroom, makeMd(chatroom, { rows: 5, skipImg: 120 }))

    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    const row = await prisma.customer.findUnique({
      where: { chatroom },
      select: {
        msgRows: true,
        skipImg: true,
        skipVoice: true,
        groupFile: true,
        firstMessageAt: true,
        lastMessageAt: true,
      },
    })
    assert.equal(row?.msgRows, 5)
    assert.equal(row?.skipImg, 120)
    assert.equal(row?.skipVoice, 4)
    assert.equal(row?.groupFile, `${chatroom.replace(PREFIX, '测试群-')}.md`)
    // 首条是 2026-10-10 09:30（本地），末条 10-14 09:30。
    assert.equal(row?.firstMessageAt?.getDate(), 10)
    assert.equal(row?.lastMessageAt?.getDate(), 14)

    const change = changeOf(report.changes, chatroom)
    assert.notEqual(change, undefined)
    // 文件名也变了：改名后要跟着改，否则排障时对不上文件。
    assert.equal(change?.fields.includes('groupFile'), true)
  })

  test('抓取失败留下空文件：不清空条数，也不改阶段', async () => {
    const chatroom = `${PREFIX}empty`
    await seed(chatroom, '测试乙', { extras: { msgRows: 628, skipImg: 100 } })
    writeGroupFor(chatroom, makeMd(chatroom, { rows: 0, aiStage: '已下单' }))

    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    const row = await prisma.customer.findUnique({
      where: { chatroom },
      select: { msgRows: true, skipImg: true, stage: true, firstMessageAt: true },
    })
    // 628 → 0 会让这个客户看起来「很久没说话」，而实际是同步写坏的。
    assert.equal(row?.msgRows, 628)
    assert.equal(row?.skipImg, 100)
    // 空文件里的 ai_stage 可能是上一轮的残留，不能拿它推阶段。
    assert.equal(row?.stage, 'consulting')
    assert.equal(report.stageHeld.empty_file >= 1, true)
  })

  test('未复核且来源是 AI 的客户：阶段跟着 AI 走', async () => {
    const chatroom = `${PREFIX}follow`
    await seed(chatroom, '测试丙', { stage: 'consulting' })
    writeGroupFor(chatroom, makeMd(chatroom, { aiStage: '已下单' }))

    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    const row = await prisma.customer.findUnique({
      where: { chatroom },
      select: { stage: true, stageSource: true },
    })
    assert.equal(row?.stage, 'producing')
    assert.equal(row?.stageSource, 'ai_stage')
    assert.equal(report.stageChanged >= 1, true)
  })

  test('已复核的客户：即使 AI 判断变了，阶段也不动', async () => {
    const chatroom = `${PREFIX}reviewed`
    await seed(chatroom, '测试丁', {
      origin: { reviewStatus: 'confirmed' },
      stage: 'consulting',
    })
    writeGroupFor(chatroom, makeMd(chatroom, { aiStage: '已下单' }))

    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    const row = await prisma.customer.findUnique({ where: { chatroom }, select: { stage: true } })
    // 人签过字的阶段不能再被模型改 —— 否则 `customer.import.review` 这个权限点没有意义。
    assert.equal(row?.stage, 'consulting')
    assert.equal(report.stageHeld.reviewed >= 1, true)
  })

  test('看板来源的客户：阶段不降级成 AI 判断', async () => {
    const chatroom = `${PREFIX}board`
    await seed(chatroom, '测试戊', { origin: { stageSource: 'board' }, stage: 'shipped' })
    writeGroupFor(chatroom, makeMd(chatroom, { aiStage: '方案设计' }))

    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    const row = await prisma.customer.findUnique({ where: { chatroom }, select: { stage: true } })
    assert.equal(row?.stage, 'shipped')
    assert.equal(report.stageHeld.board_authority >= 1, true)
  })

  test('金额与订单一格都不碰 —— md 里的金额是手机号', async () => {
    const chatroom = `${PREFIX}money`
    await seed(chatroom, '测试己', { extras: { msgRows: 1 } })
    const created = await prisma.customer.findUnique({ where: { chatroom }, select: { id: true } })
    assert.notEqual(created, null)
    if (created === null) return
    await createOrder(created.id, { contractFen: 3780000, receivedFen: 0 }, true, {
      code: `${CODE_PREFIX}01`,
    })
    writeGroupFor(chatroom, makeMd(chatroom, { contract: '13847391188' }))

    await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    const customer = await prisma.customer.findUnique({
      where: { chatroom },
      select: { contractTotalFen: true },
    })
    const order = await prisma.customerOrder.findUnique({
      where: { code: `${CODE_PREFIX}01` },
      select: { contractFen: true, receivedFen: true },
    })
    // 37800 元是人工核对过的；文件里那个「合同金额」是李姐的手机号。
    assert.equal(customer?.contractTotalFen, 3780000)
    assert.equal(order?.contractFen, 3780000)
    assert.equal(order?.receivedFen, 0)
  })

  test('新群自动建成待复核客户，地区留「待确认」', async () => {
    const chatroom = `${PREFIX}new`
    writeGroup('新房客VIP设计沟通群', makeMd(chatroom))

    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    assert.equal(report.created, 1)
    const row = await prisma.customer.findUnique({
      where: { chatroom },
      select: {
        realName: true,
        region: true,
        displayName: true,
        reviewStatus: true,
        confidence: true,
        msgRows: true,
        stage: true,
        stageSource: true,
      },
    })
    assert.equal(row?.realName, '新房客')
    // 不猜地区：猜错会造出一个查无此人的客户，还要被拿去匹配看板。
    assert.equal(row?.region, '待确认')
    assert.equal(row?.displayName, '待确认新房客')
    assert.equal(row?.reviewStatus, 'pending')
    // `none` 而不是 `low`：这里没有任何身份判断依据，要与「AI 抽出来待确认」分开。
    assert.equal(row?.confidence, 'none')
    assert.equal(row?.msgRows, 3)
  })

  test('排除清单里的群不建客户，空文件也不建', async () => {
    writeGroup('广告群', makeMd(`${PREFIX}ad`))
    writeGroup('抓取失败的群VIP设计群', makeMd(`${PREFIX}broken`, { rows: 0 }))

    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    assert.equal(report.created, 0)
    const reasons = report.skippedNew.map((item) => item.reason).sort()
    assert.deepEqual(reasons, ['empty_file', 'excluded'])
    const count = await prisma.customer.count({
      where: { chatroom: { in: [`${PREFIX}ad`, `${PREFIX}broken`] } },
    })
    assert.equal(count, 0)
  })

  test('重跑幂等：第二遍同一个客户不出现在变化列表里', async () => {
    const chatroom = `${PREFIX}idem`
    await seed(chatroom, '测试庚', { extras: { msgRows: 1 } })
    writeGroupFor(chatroom, makeMd(chatroom, { rows: 4 }))

    const first = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })
    assert.notEqual(changeOf(first.changes, chatroom), undefined)

    const second = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })
    assert.equal(changeOf(second.changes, chatroom), undefined)
    assert.equal(second.created, 0)
  })

  test('库里有的客户、目录里没有文件：只报告，不删除', async () => {
    const chatroom = `${PREFIX}orphan`
    // 要有 `groupFile` 才算「文件消失了」。手工录入的客户本来就没有群文件，
    // 若也列进报告，这份报告每天都有一串固定噪音，真正的异常会被淹掉。
    await seed(chatroom, '测试辛', { extras: { msgRows: 7, groupFile: '消失的群.md' } })
    // 目录留空，模拟文件被误删或换了存放目录。
    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    assert.equal(report.missingFile.includes('成都测试辛'), true)
    const row = await prisma.customer.findUnique({ where: { chatroom }, select: { msgRows: true } })
    // 客户是资产：文件没了不等于客户没了。
    assert.equal(row?.msgRows, 7)
  })

  test('手工录入的客户不算「文件消失」', async () => {
    // 人工录入走 `createCustomer`，chatroom 是 `manual:` 前缀、没有群文件。
    const manualChatroom = `${PREFIX}manual`
    await seed(manualChatroom, '测试手工')
    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: false })

    assert.equal(report.missingFile.includes('成都测试手工'), false)
  })

  test('干跑只算不写', async () => {
    const chatroom = `${PREFIX}dry`
    await seed(chatroom, '测试壬', { extras: { msgRows: 1 } })
    writeGroupFor(chatroom, makeMd(chatroom, { rows: 9 }))

    const report = await syncCustomersFromArchive({ chatDir: dir, aliasesFile, dryRun: true })

    assert.equal(report.dryRun, true)
    assert.notEqual(changeOf(report.changes, chatroom), undefined)
    const row = await prisma.customer.findUnique({ where: { chatroom }, select: { msgRows: true } })
    assert.equal(row?.msgRows, 1, '干跑不许写库')
  })
})
