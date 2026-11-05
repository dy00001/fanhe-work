/**
 * `GET /api/assistant/token` 的集成测试。
 *
 * 走真实登录，因为这条接口的价值全在「拿到的令牌里是谁」——用假的 authContext 替身
 * 测不出用户名是否正确落进 JWT，而用户名错了的表现不是报错，是**历史记到别人名下**。
 *
 * 三个断言：
 *   ① 登录后拿到的令牌能验签，且 `sub` / `username` / `webui_user_id` 与账号一致；
 *   ② 未配置密钥时返回 503 而不是 500 —— 502/500 会让监控把它当成服务故障，
 *      而它其实是「这个部署没开这个功能」，页面此时应当退回共享身份并照常可用；
 *   ③ 未登录返回 401，且**不签发任何东西**。
 *
 * 需要真实数据库（建账号、登录），库不可达时整体跳过并显式出声。
 */
import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { jwtVerify } from 'jose'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { buildApp } = await import('../src/app.js')

/** 测试专用的签名密钥。与真实部署无关，只在这一轮里用。 */
const TEST_SECRET = 't'.repeat(64)
const TEST_PASSWORD = 'integration-test-password'

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
  // 必须显式出声：describe 的 skip 只会让 suite 从统计里消失，总数变少而 fail 为 0，
  // 输出仍是全绿。静默跳过等于把「没跑」显示成「跑过了」。
  console.warn('[assistant-route.test] 数据库不可达，身份桥接口的集成测试未执行')
}

describe('助手身份桥接口', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  let userId = ''
  let username = ''
  let accessToken = ''
  const originalSecret = process.env.ASSISTANT_JWT_SECRET

  before(async () => {
    process.env.ASSISTANT_JWT_SECRET = TEST_SECRET

    const role = await prisma.role.findUnique({ where: { code: 'member' }, select: { id: true } })
    if (role === null) {
      throw new Error('库里没有 member 角色，先执行 pnpm db:seed')
    }

    username = `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`
    const user = await prisma.user.create({
      data: {
        username,
        passwordHash: await hashPassword(TEST_PASSWORD),
        displayName: '身份桥测试账号',
        roleId: role.id,
      },
      select: { id: true },
    })
    userId = user.id
    createdUserIds.push(user.id)

    const app = buildApp({ logger: false })
    try {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username, password: TEST_PASSWORD },
      })
      assert.equal(login.statusCode, 200)
      accessToken = login.json().accessToken
    } finally {
      await app.close()
    }
  })

  after(async () => {
    if (createdUserIds.length > 0) {
      // 审计留痕先把 actor 置空，否则外键会挡住账号删除（onDelete: SetNull 只对
      // 级联生效，这里显式清理更直白）。按 actorId 清，不是因为字段叫 userId ——
      // 审计表用的是 actor_id，写错一个字段名就会让整个 after 钩子抛错，
      // 而抛错的后果是**测试账号留在库里**，且用例仍然全绿。
      await prisma.auditLog.deleteMany({ where: { actorId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    if (originalSecret === undefined) {
      delete process.env.ASSISTANT_JWT_SECRET
    } else {
      process.env.ASSISTANT_JWT_SECRET = originalSecret
    }
    await prisma.$disconnect()
  })

  test('登录后签出的令牌能被验签，且身份就是当前账号', async () => {
    const app = buildApp({ logger: false })
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/assistant/token',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      assert.equal(response.statusCode, 200)
      // 不能缓存：过期的令牌比没有令牌更糟，它的失效表现是「看到别人的对话」。
      assert.equal(response.headers['cache-control'], 'no-store')

      const body = response.json()
      const { payload } = await jwtVerify(body.token, new TextEncoder().encode(TEST_SECRET), {
        algorithms: ['HS256'],
      })

      assert.equal(payload.sub, userId)
      assert.equal(payload.username, username.toLowerCase())
      assert.equal(payload.webui_user_id, userId)
      assert.equal(body.expiresAt, Number(payload.exp) * 1000)
    } finally {
      await app.close()
    }
  })

  test('未配置密钥时返回 503，页面可以退回共享身份', async () => {
    const app = buildApp({ logger: false })
    const saved = process.env.ASSISTANT_JWT_SECRET
    delete process.env.ASSISTANT_JWT_SECRET
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/api/assistant/token',
        headers: { authorization: `Bearer ${accessToken}` },
      })
      assert.equal(response.statusCode, 503)
      assert.equal(response.json().error, 'assistant_not_configured')
    } finally {
      process.env.ASSISTANT_JWT_SECRET = saved
      await app.close()
    }
  })

  test('未登录返回 401，且响应里没有令牌', async () => {
    const app = buildApp({ logger: false })
    try {
      const response = await app.inject({ method: 'GET', url: '/api/assistant/token' })
      assert.equal(response.statusCode, 401)
      assert.equal(response.json().token, undefined)
    } finally {
      await app.close()
    }
  })
})
