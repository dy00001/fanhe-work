/**
 * 首次初始化的集成测试。
 *
 * 需要真实数据库。「是否已初始化」的判定、并发下的串行化、账号落库后的形态，都
 * 依赖真实的事务与锁，用内存替身测不出真伪。
 *
 * 这个文件对库的状态敏感：从零初始化的用例要求库里没有 owner 角色账号。库里已经
 * 有 owner 时（可能是真实数据）**跳过**这些用例而不是删掉它，删除别人的账号不是
 * 测试该做的事。
 *
 * 因此本套测试必须**串行**执行，package.json 的 test 脚本带 --test-concurrency=1。
 * 判据是「全库没有 owner」，这是一个全局单例状态；而 permission.test.ts 需要建一个
 * owner 角色的账号来验证 owner 专属权限。两个文件并行跑时，那边建的 owner 会落在这边
 * 的判定与断言之间，于是 status 报已初始化、初始化请求全部被拒。并行跑过一次，表现是
 * 「空库」用例断言失败，而库里其实干干净净 —— 这种时序问题不会稳定复现，只会偶尔红。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'

import {
  ALL_PERMISSIONS,
  normalizeUsername,
  isValidUsername,
  PASSWORD_MIN_LENGTH,
  ROLE_CODES,
} from '@fanhe/shared'

import { resolveTestDatabaseUrl } from './helpers/db.js'

// test-env.ts 已经把 DATABASE_URL 指向一个不可达地址，这里在 env.ts 被求值之前
// 换回真实值。下面一律用动态 import，静态 import 会被提升到本段之前执行。
const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
/** RFC 5737 的 TEST-NET-2 段。本文件独占一个地址，清理时能精确圈定。 */
const TEST_IP = '198.51.100.30'

/** 初始化时提交的账号名，带大写与首尾空白，用于验证归一。 */
const OWNER_SUBMITTED_USERNAME = '  Admin.Ops  '
/** 归一后的账号名。 */
const OWNER_USERNAME = 'admin.ops'

async function databaseReachable(): Promise<boolean> {
  if (databaseUrl === null) {
    return false
  }
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

const reachable = await databaseReachable()

let ownerCountBefore = 0
if (reachable) {
  ownerCountBefore = await prisma.user.count({ where: { role: { code: ROLE_CODES.OWNER } } })
}
const cleanStart = ownerCountBefore === 0

if (!reachable) {
  // 必须显式出声。describe 的 skip 只会让整个 suite 从统计里消失，总数变少而
  // skipped 与 fail 都是 0，输出全绿。静默跳过会把「没跑」显示成「跑过了」。
  console.warn('[setup.test] 数据库不可达，首次初始化的集成测试未执行')
} else if (!cleanStart) {
  console.warn('[setup.test] 库里已存在 owner 账号，从零初始化的用例将跳过')
}

// 纯函数部分不依赖数据库，单独一组，库不可达时照样运行。
describe('账号名归一与校验', () => {
  test('归一去掉首尾空白并转为小写', () => {
    assert.equal(normalizeUsername('  Admin.Ops  '), 'admin.ops')
    assert.equal(normalizeUsername('ABC'), 'abc')
    assert.equal(normalizeUsername('already.clean'), 'already.clean')
  })

  test('归一不处理中间的空格，这类输入留给合法性校验拒绝', () => {
    assert.equal(normalizeUsername('ad min'), 'ad min')
    assert.equal(isValidUsername(normalizeUsername('ad min')), false)
  })

  test('长度与字符集不符合时判定为非法', () => {
    const invalid = [
      '',
      'ab',
      '-abc',
      '.abc',
      '_abc',
      'abc def',
      '中文账号',
      'admin@ops',
      'a'.repeat(65),
    ]
    for (const input of invalid) {
      assert.equal(isValidUsername(normalizeUsername(input)), false, `应拒绝：${input}`)
    }
  })

  test('合法账号名被接受', () => {
    for (const input of ['abc', 'admin.ops', 'user_01', 'a-b-c', 'a'.repeat(64)]) {
      assert.equal(isValidUsername(normalizeUsername(input)), true, `应接受：${input}`)
    }
  })
})

describe('首次初始化', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  let app: ReturnType<typeof buildApp>

  before(() => {
    app = buildApp({ logger: false })
  })

  after(async () => {
    await app.close()
    if (createdUserIds.length > 0) {
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
  })

  function initialize(payload: Record<string, unknown>) {
    return app.inject({ method: 'POST', url: '/api/setup/initialize', payload })
  }

  test(
    '空库时状态查询返回未初始化',
    { skip: cleanStart ? false : '库里已存在 owner' },
    async () => {
      const response = await app.inject({ method: 'GET', url: '/api/setup/status' })
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().initialized, false)
    },
  )

  test(
    '并发初始化只创建一个 owner，账号名被归一',
    { skip: cleanStart ? false : '库里已存在 owner' },
    async () => {
      const payload = {
        username: OWNER_SUBMITTED_USERNAME,
        password: TEST_PASSWORD,
        displayName: '超级管理员',
      }

      // 两个请求同时发出。没有咨询锁时它们会各自读到「还没有 owner」，创建出两个
      // 超级管理员，而流程不报任何错。
      const responses = await Promise.all([initialize(payload), initialize(payload)])

      const created = responses.filter((response) => response.statusCode === 201)
      const rejected = responses.filter((response) => response.statusCode === 409)

      assert.equal(created.length, 1, '并发初始化必须恰好一个成功')
      assert.equal(rejected.length, 1)
      assert.equal(rejected[0]?.json().error, 'already_initialized')

      const winner = created[0]
      assert.ok(winner !== undefined)
      if (winner === undefined) return

      const body = winner.json() as { id: string; username: string; displayName: string }
      // 提交的是 '  Admin.Ops  '，落库的必须是归一后的形式。
      assert.equal(body.username, OWNER_USERNAME)
      assert.equal(body.displayName, '超级管理员')
      createdUserIds.push(body.id)

      const ownerCount = await prisma.user.count({ where: { role: { code: ROLE_CODES.OWNER } } })
      assert.equal(ownerCount, 1, '并发初始化之后库里只应有一个 owner')

      const stored = await prisma.user.findUnique({
        where: { id: body.id },
        select: { username: true, passwordHash: true, role: { select: { code: true } } },
      })
      assert.ok(stored !== null)
      if (stored === null) return
      assert.equal(stored.username, OWNER_USERNAME)
      assert.equal(stored.role.code, ROLE_CODES.OWNER)
      assert.notEqual(stored.passwordHash, TEST_PASSWORD)
      assert.match(stored.passwordHash, /^\$argon2id\$/)
    },
  )

  test(
    '初始化后状态查询返回已初始化',
    { skip: cleanStart ? false : '库里已存在 owner' },
    async () => {
      const response = await app.inject({ method: 'GET', url: '/api/setup/status' })
      assert.equal(response.statusCode, 200)
      assert.equal(response.json().initialized, true)
    },
  )

  test('已初始化时再次调用被拒绝，且不会新增账号', async () => {
    const beforeCount = await prisma.user.count({ where: { role: { code: ROLE_CODES.OWNER } } })

    const response = await initialize({
      username: 'second.owner',
      password: TEST_PASSWORD,
      displayName: '第二个管理员',
    })

    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error, 'already_initialized')

    const afterCount = await prisma.user.count({ where: { role: { code: ROLE_CODES.OWNER } } })
    assert.equal(afterCount, beforeCount)
  })

  test('账号名不符合规则时返回 400', async () => {
    for (const username of ['ab', '-abc', '中文账号', 'admin@ops']) {
      const response = await initialize({
        username,
        password: TEST_PASSWORD,
        displayName: '测试',
      })
      assert.equal(response.statusCode, 400, `应拒绝：${username}`)
      assert.equal(response.json().error, 'invalid_username')
    }
  })

  test('密码短于下限时被 schema 拒绝', async () => {
    const response = await initialize({
      username: 'short.password.owner',
      password: 'a'.repeat(PASSWORD_MIN_LENGTH - 1),
      displayName: '测试',
    })
    assert.equal(response.statusCode, 400)
  })

  test('缺少字段或多出字段都被拒绝', async () => {
    const missing = await initialize({ username: 'nobody', password: TEST_PASSWORD })
    assert.equal(missing.statusCode, 400)

    const extra = await initialize({
      username: 'nobody',
      password: TEST_PASSWORD,
      displayName: '测试',
      role: 'owner',
    })
    assert.equal(extra.statusCode, 400)
  })

  test(
    '初始化创建的 owner 可以登录，且拥有全部权限',
    { skip: cleanStart ? false : '库里已存在 owner' },
    async () => {
      // 登录时提交的仍是大写形式，验证归一在登录侧同样生效。
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'Admin.Ops', password: TEST_PASSWORD },
        remoteAddress: TEST_IP,
      })
      assert.equal(loginResponse.statusCode, 200)

      const tokens = loginResponse.json() as { accessToken: string; user: { role: string } }
      assert.equal(tokens.user.role, ROLE_CODES.OWNER)

      const meResponse = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${tokens.accessToken}` },
      })
      assert.equal(meResponse.statusCode, 200)

      const me = meResponse.json() as { permissions: string[] }
      assert.equal(me.permissions.length, ALL_PERMISSIONS.length)
    },
  )
})
