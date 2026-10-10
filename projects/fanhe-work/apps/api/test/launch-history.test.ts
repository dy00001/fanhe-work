/**
 * 启动记录与路径状态的测试。
 *
 * 这两件事服务于界面上的两句话：「这条配置的路径现在还能不能用」与「它多久没成功
 * 启动过了」。前者是一次 `stat`，后者只能靠落库的历史 —— 进程创建那一刻的信息没有
 * 别的地方会留下来。
 *
 * 一半用例走完整路由链路（`inject`），因为要验证的是「接口给出的事实对不对」：
 * 状态接口的归属隔离、启动失败时记的是哪一种结果、去重命中时该不该记。另一半直接
 * 调 service 或直接写库，因为那些场景造不出来 —— 「最近一次失败但上一次成功」需要
 * 两条时间上分开的记录，「超出保留条数」需要写入超过上限的行数。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

import { ROLE_CODES, type LaunchProfileStatus, type RoleCode } from '@fanhe/shared'
import type { LightMyRequestResponse } from 'fastify'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

// test-env.ts 已经把 DATABASE_URL 指向一个不可达地址，这里在 env.ts 被求值之前
// 换回真实值。下面一律用动态 import，静态 import 会被提升到本段之前执行。
const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { inspectExecutablePath } = await import('../src/launch/agent.js')
const { recordLaunchRun } = await import('../src/launch/history.js')
const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
/** RFC 5737 的 TEST-NET-2 段。本文件独占一个地址，清理时能精确圈定。 */
const TEST_IP = '198.51.100.42'

/** 一个真实存在的文件：跑测试的这个 Node 自己。跨平台且一定存在。 */
const NODE_PATH = process.execPath
/** 一个存在、确实是文件、但操作系统无法执行的路径。用来区分「不可用」的两种含义。 */
const NON_EXECUTABLE_FILE = fileURLToPath(new URL('../package.json', import.meta.url))
/**
 * 一条绝对路径，且保证不存在。
 *
 * 用盘符写法而不是临时目录：它要能通过服务端的「是不是绝对路径」形态校验（那条
 * 校验跨平台认盘符、UNC 与 `/` 开头的写法），而随机的文件名保证它真的不存在。
 */
const MISSING_PATH = `C:\\zz_test_missing\\${randomUUID().slice(0, 8)}.exe`

// ---------------------------------------------------------------------------
// 路径检查。不依赖数据库，因此不随集成测试一起跳过。
// ---------------------------------------------------------------------------

describe('可执行文件路径检查', () => {
  test('存在的文件判为可用', async () => {
    assert.equal(await inspectExecutablePath(NODE_PATH), 'ok')
  })

  test('不存在的路径判为不可用', async () => {
    assert.equal(await inspectExecutablePath(MISSING_PATH), 'missing')
  })

  test('目录判为不可用', async () => {
    // 从资源管理器复制路径时选到文件夹是很常见的错误，而 `stat` 成功并不代表这个
    // 路径能被启动 —— 判据是「存在**且是文件**」，只看存在性会把它放过去。
    assert.equal(
      await inspectExecutablePath(fileURLToPath(new URL('..', import.meta.url))),
      'missing',
    )
  })

  test('是文件但不可执行仍判为可用', async () => {
    // 判据里没有「可执行」这一条：它在各平台上不是同一件事（Windows 看扩展名、
    // Unix 看权限位），而真正能不能起来只有 `spawn` 知道。这里回答的是「路径本身
    // 有没有写错」，把它与「能不能起来」混为一谈会让这条判断在跨平台上不可靠。
    assert.equal(await inspectExecutablePath(NON_EXECUTABLE_FILE), 'ok')
  })
})

// ---------------------------------------------------------------------------
// 集成测试
// ---------------------------------------------------------------------------

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

if (!reachable) {
  // 必须显式出声。describe 的 skip 只会让整个 suite 从统计里消失，总数变少而
  // skipped 与 fail 都是 0，输出全绿。静默跳过会把「没跑」显示成「跑过了」。
  console.warn('[launch-history.test] 数据库不可达，启动记录与路径状态的集成测试未执行')
}

describe('启动记录与路径状态', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  const roleIds = new Map<RoleCode, string>()
  let passwordHash = ''
  let app: ReturnType<typeof buildApp>

  before(async () => {
    for (const code of [ROLE_CODES.MEMBER, ROLE_CODES.VIEWER]) {
      const role = await prisma.role.findUnique({ where: { code }, select: { id: true } })
      if (role === null) {
        throw new Error(`库里没有 ${code} 角色，先执行 pnpm db:seed`)
      }
      roleIds.set(code, role.id)
    }
    passwordHash = await hashPassword(TEST_PASSWORD)
    app = buildApp({ logger: false })
  })

  after(async () => {
    await app.close()
    if (createdUserIds.length > 0) {
      // 先删历史再删配置与账号。外键是级联的，这里显式写出来是为了让「清理了什么」
      // 在代码里看得见，而不是靠级联规则去推。
      await prisma.launchHistory.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.launchProfile.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    // 本文件用 login 取令牌，会顺带写入登录尝试与审计。
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
  })

  /** 建一个指定角色的账号并登录，返回访问令牌。 */
  async function signIn(roleCode: RoleCode): Promise<{ userId: string; token: string }> {
    const roleId = roleIds.get(roleCode)
    if (roleId === undefined) {
      throw new Error(`未知角色：${roleCode}`)
    }

    const user = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        passwordHash,
        displayName: '启动记录测试',
        roleId,
      },
      select: { id: true, username: true },
    })
    createdUserIds.push(user.id)

    const result = await login({ username: user.username, password: TEST_PASSWORD, ip: TEST_IP })
    if (!result.ok) {
      throw new Error(`测试账号登录失败：${result.reason}`)
    }
    return { userId: user.id, token: result.data.accessToken }
  }

  function authHeader(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` }
  }

  /** 建一条配置，返回它的 id 与显示名（记录里存的是名字的快照，要对得上）。 */
  async function createProfile(
    token: string,
    executablePath: string = NODE_PATH,
  ): Promise<{ id: string; name: string }> {
    const name = `记录测试 ${randomUUID().slice(0, 8)}`
    const response = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(token),
      payload: {
        software: 'custom',
        name,
        executablePath,
        args: ['-e', 'process.exit(0)'],
      },
    })
    assert.equal(response.statusCode, 201)
    return { id: response.json().profile.id, name }
  }

  async function runProfile(token: string, id: string): Promise<LightMyRequestResponse> {
    return await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${id}/run`,
      headers: authHeader(token),
    })
  }

  async function statusOf(token: string): Promise<LaunchProfileStatus[]> {
    const response = await app.inject({
      method: 'GET',
      url: '/api/launch/profiles/status',
      headers: authHeader(token),
    })
    assert.equal(response.statusCode, 200)
    return response.json().statuses
  }

  function statusFor(statuses: LaunchProfileStatus[], profileId: string): LaunchProfileStatus {
    const found = statuses.find((item) => item.profileId === profileId)
    if (found === undefined) {
      throw new Error(`状态里没有 ${profileId}`)
    }
    return found
  }

  test('启动成功后写入一条成功记录，名字与路径取当时的快照', async () => {
    const { userId, token } = await signIn(ROLE_CODES.MEMBER)
    const profile = await createProfile(token)

    const response = await runProfile(token, profile.id)
    assert.equal(response.statusCode, 200)
    const pid = response.json().pid

    const rows = await prisma.launchHistory.findMany({ where: { profileId: profile.id } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.outcome, 'success')
    assert.equal(rows[0]?.pid, pid)
    assert.equal(rows[0]?.startedAt.toISOString(), response.json().startedAt)
    assert.equal(rows[0]?.profileName, profile.name)
    assert.equal(rows[0]?.executablePath, NODE_PATH)
    assert.equal(rows[0]?.userId, userId)
  })

  test('路径不存在时启动失败，并写入一条失败记录', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const profile = await createProfile(token, MISSING_PATH)

    const response = await runProfile(token, profile.id)
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error, 'executable_missing')

    const rows = await prisma.launchHistory.findMany({ where: { profileId: profile.id } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.outcome, 'executable_missing')
    // 进程没有被创建，因此没有 pid。写成 0 或 -1 都会让「这条到底起没起来」变得
    // 需要靠约定去解释，而 null 是数据库里表达「没有」的那一种。
    assert.equal(rows[0]?.pid, null)
  })

  test('文件存在但不可执行时启动失败，并写入一条失败记录', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const profile = await createProfile(token, NON_EXECUTABLE_FILE)

    const response = await runProfile(token, profile.id)
    assert.equal(response.statusCode, 500)
    assert.equal(response.json().error, 'spawn_failed')

    const rows = await prisma.launchHistory.findMany({ where: { profileId: profile.id } })
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.outcome, 'spawn_failed')
    assert.equal(rows[0]?.pid, null)
  })

  test('启动记录遇到外键错误时不抛异常，但会记录日志', async () => {
    const { userId } = await signIn(ROLE_CODES.MEMBER)
    const profileId = randomUUID()
    const logs: { context: unknown; message: string | undefined }[] = []
    const logger = {
      error(context: unknown, message?: string): void {
        logs.push({ context, message })
      },
    }

    // 用真实的外键错误覆盖写入失败，不改表结构，也不替换全局 logger 或数据库客户端。
    assert.equal(await prisma.launchProfile.findUnique({ where: { id: profileId } }), null)
    await assert.doesNotReject(async () => {
      await recordLaunchRun(
        {
          userId,
          profileId,
          profileName: '不存在的启动配置',
          executablePath: NODE_PATH,
          outcome: 'success',
          pid: 4321,
        },
        { logger },
      )
    })

    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.message, '启动记录写入失败')
    const context = logs[0]?.context
    assert.ok(typeof context === 'object' && context !== null)
    assert.ok('profileId' in context)
    assert.equal(context.profileId, profileId)
    assert.ok('err' in context && context.err instanceof Error)
    assert.ok('code' in context.err)
    assert.equal(context.err.code, 'P2003')
    assert.equal(await prisma.launchHistory.count({ where: { userId } }), 0)
  })

  test('命中去重窗口的请求不写第二条记录', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const profile = await createProfile(token)

    const first = await runProfile(token, profile.id)
    const second = await runProfile(token, profile.id)
    assert.equal(first.statusCode, 200)
    assert.equal(second.statusCode, 200)
    assert.equal(second.json().deduplicated, true)

    // 两次调用只有一个进程，因此只该有一条记录。记两条会让界面上的「上次启动」
    // 看起来像是启动了两次，而实际上第二次什么都没发生。
    const rows = await prisma.launchHistory.findMany({ where: { profileId: profile.id } })
    assert.equal(rows.length, 1)
  })

  test('状态接口给出每条配置的路径状态与最近一次启动', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const healthy = await createProfile(token)
    const broken = await createProfile(token, MISSING_PATH)

    assert.equal((await runProfile(token, healthy.id)).statusCode, 200)

    const statuses = await statusOf(token)

    const healthyStatus = statusFor(statuses, healthy.id)
    assert.equal(healthyStatus.pathState, 'ok')
    assert.equal(healthyStatus.lastRun?.outcome, 'success')
    assert.notEqual(healthyStatus.lastSuccessAt, null)

    const brokenStatus = statusFor(statuses, broken.id)
    assert.equal(brokenStatus.pathState, 'missing')
    // 从未启动过与「启动过但失败」是两回事，界面上的文案也不同。
    assert.equal(brokenStatus.lastRun, null)
    assert.equal(brokenStatus.lastSuccessAt, null)
  })

  test('已启动的配置软删除后不再出现在状态里，但历史仍保留', async () => {
    const { userId, token } = await signIn(ROLE_CODES.MEMBER)
    const profile = await createProfile(token)

    assert.equal((await runProfile(token, profile.id)).statusCode, 200)
    assert.equal(statusFor(await statusOf(token), profile.id).lastRun?.outcome, 'success')
    const beforeDelete = await prisma.launchHistory.findMany({ where: { profileId: profile.id } })
    assert.equal(beforeDelete.length, 1)

    const response = await app.inject({
      method: 'DELETE',
      url: `/api/launch/profiles/${profile.id}`,
      headers: authHeader(token),
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.json().removed, true)

    const statuses = await statusOf(token)
    assert.ok(!statuses.some((item) => item.profileId === profile.id))
    const deleted = await prisma.launchProfile.findUnique({ where: { id: profile.id } })
    assert.ok(deleted !== null)
    assert.equal(deleted.userId, userId)
    assert.notEqual(deleted.deletedAt, null)
    // 删掉的是当前列表里的配置，不是过去已经发生的启动；快照也不应跟着消失。
    const rows = await prisma.launchHistory.findMany({ where: { profileId: profile.id } })
    assert.deepEqual(rows, beforeDelete)
    assert.equal(rows[0]?.profileName, profile.name)
    assert.equal(rows[0]?.executablePath, NODE_PATH)
  })

  test('最近一次是失败时，仍能给出上一次成功的时间', async () => {
    const { userId, token } = await signIn(ROLE_CODES.MEMBER)
    const profile = await createProfile(token)

    // 直接写库而不是调两次启动：要验证的是「两条时间上分开的记录怎么读」，而通过
    // 接口造出这个序列需要绕开去重窗口（成功会被缓存 3 秒），那会让用例变慢且脆。
    const succeededAt = new Date(Date.now() - 60_000)
    const failedAt = new Date(Date.now() - 10_000)
    await prisma.launchHistory.createMany({
      data: [
        {
          userId,
          profileId: profile.id,
          profileName: profile.name,
          executablePath: NODE_PATH,
          outcome: 'success',
          pid: 1234,
          startedAt: succeededAt,
        },
        {
          userId,
          profileId: profile.id,
          profileName: profile.name,
          executablePath: NODE_PATH,
          outcome: 'spawn_failed',
          pid: null,
          startedAt: failedAt,
        },
      ],
    })

    const status = statusFor(await statusOf(token), profile.id)
    assert.equal(status.lastRun?.outcome, 'spawn_failed')
    // 这一列正是「这条配置多久没成功启动过了」需要的那一句。
    assert.equal(status.lastSuccessAt, succeededAt.toISOString())
  })

  test('库里出现认不出的结果码时按失败处理', async () => {
    const { userId, token } = await signIn(ROLE_CODES.MEMBER)
    const profile = await createProfile(token)

    // 只可能来自手工改库或回滚到旧版本。判松的后果是把这种行显示成「启动成功」，
    // 那是最坏的结果 —— 用户会以为程序起来了。
    await prisma.launchHistory.create({
      data: {
        userId,
        profileId: profile.id,
        profileName: profile.name,
        executablePath: NODE_PATH,
        outcome: 'SUCCESS',
        pid: 1,
      },
    })

    const status = statusFor(await statusOf(token), profile.id)
    assert.equal(status.lastRun?.outcome, 'spawn_failed')
  })

  test('状态只覆盖自己的配置', async () => {
    const alice = await signIn(ROLE_CODES.MEMBER)
    const bob = await signIn(ROLE_CODES.MEMBER)
    const aliceProfile = await createProfile(alice.token)
    const bobProfile = await createProfile(bob.token)

    const statuses = await statusOf(alice.token)
    const ids = statuses.map((item) => item.profileId)
    assert.ok(ids.includes(aliceProfile.id))
    assert.ok(!ids.includes(bobProfile.id))
  })

  test('只读访客能读状态，但不能启动', async () => {
    const member = await signIn(ROLE_CODES.MEMBER)
    const profile = await createProfile(member.token)

    const viewer = await signIn(ROLE_CODES.VIEWER)
    // 读得到：路径失效是关于「他自己那份列表」的事实，不含任何改动。
    const statuses = await statusOf(viewer.token)
    assert.deepEqual(statuses, [])

    const response = await runProfile(viewer.token, profile.id)
    // 403 而不是 404：被挡下的是这个角色没有写权限，与配置存不存在无关。
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error, 'forbidden')
  })

  test('没有配置时状态是空数组', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    assert.deepEqual(await statusOf(token), [])
  })

  test('超出保留条数的旧记录会被清掉', async () => {
    const { userId, token } = await signIn(ROLE_CODES.MEMBER)
    const profile = await createProfile(token)

    // 上限压到 2，否则这条用例要写入五百行才谈得上「超出」。
    const options = { maxPerUser: 2 }
    for (const outcome of ['success', 'spawn_failed', 'success'] as const) {
      await recordLaunchRun(
        {
          userId,
          profileId: profile.id,
          profileName: profile.name,
          executablePath: NODE_PATH,
          outcome,
          pid: outcome === 'success' ? 4321 : null,
        },
        options,
      )
    }

    const rows = await prisma.launchHistory.findMany({
      where: { profileId: profile.id },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    })
    assert.equal(rows.length, 2)
    // 留下的是最近的两次，最早那条 success 被清掉。
    assert.deepEqual(
      rows.map((row) => row.outcome),
      ['success', 'spawn_failed'],
    )
  })
})
