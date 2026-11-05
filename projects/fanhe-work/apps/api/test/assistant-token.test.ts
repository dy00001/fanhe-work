/**
 * 助手身份令牌签发器的单元测试。
 *
 * 不连数据库：这段逻辑只做签名，出错也不会报错，而是**静默地算错人**。因此这里守的
 * 是三件在运行时看不出异常的事：
 *
 *   ① **载荷字段名与 EvoFlow 侧一致**。它读的是 `username` 与 `webui_user_id`，
 *      少一个字段它就走「合成主体」分支（不落库），多一个拼错的字段则什么都不会发生 ——
 *      两种都表现为「隔离没生效」，日志里一行提示都没有。
 *   ② **用户名小写化**。EvoFlow 用 `sanitize_user_asset_id(username)` 派生主体 id，
 *      那是小写化的结果。若这里保留大小写，`Yang` 与 `yang` 会在首次请求时各建一条
 *      身份映射，最后指向同一份历史。
 *   ③ **换一个密钥就验不过**。这条守的是「梵禾的会话密钥没有被误用成这一把」——
 *      两者混用的后果是两边的令牌可以互相顶替。
 *
 * 验证用 `jose` 而不是 `PyJWT`，因为校验的语义相同（HS256 签名 + exp），而这里
 * 拉不起 Python。真要核对 PyJWT 的行为，对着 `webui/auth.py` 的 `verify_jwt` 读一遍。
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { jwtVerify } from 'jose'

import { signAssistantToken } from '../src/auth/assistant-token.js'

const SECRET = 'a'.repeat(64)
const USER_A = {
  userId: '0192f0aa-1111-7000-8000-aaaaaaaaaaaa',
  username: 'guoyao',
  roleCode: 'admin',
}
const USER_B = {
  userId: '0192f0aa-2222-7000-8000-bbbbbbbbbbbb',
  username: 'fanhe-01',
  roleCode: 'member',
}

async function decode(token: string, secret = SECRET) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), {
    algorithms: ['HS256'],
  })
  return payload
}

describe('signAssistantToken', () => {
  test('载荷字段与 EvoFlow 的读取路径一致', async () => {
    const { token } = await signAssistantToken({ ...USER_A, secret: SECRET })
    const payload = await decode(token)

    assert.equal(payload.sub, USER_A.userId)
    assert.equal(payload.username, USER_A.username)
    assert.equal(payload.webui_user_id, USER_A.userId)
    assert.equal(payload.principal_id, USER_A.username)
    assert.equal(payload.auth_method, 'fanhe')
    // 角色只作携带、不作判据：EvoFlow 的组织管理员由它自己的 admin_grants 表决定。
    // 这里断言它确实在载荷里，是为了排查「他为什么能进设置页」时不用回梵禾再查一遍。
    assert.equal(payload.fanhe_role, 'admin')
    assert.equal(typeof payload.iat, 'number')
    assert.equal(typeof payload.exp, 'number')
  })

  test('用户名小写化，且两个账号得到不同身份', async () => {
    const upper = await signAssistantToken({ ...USER_A, username: 'GuoYao', secret: SECRET })
    const lower = await signAssistantToken({ ...USER_A, secret: SECRET })
    const other = await signAssistantToken({ ...USER_B, secret: SECRET })

    const [a, b, c] = await Promise.all([
      decode(upper.token),
      decode(lower.token),
      decode(other.token),
    ])

    assert.equal(a.username, 'guoyao')
    assert.equal(a.principal_id, 'guoyao')
    assert.equal(a.sub, b.sub, '同一个账号两次签发应当指向同一个主体')
    assert.notEqual(b.sub, c.sub)
    assert.notEqual(b.username, c.username)
  })

  test('换密钥就验不过', async () => {
    const { token } = await signAssistantToken({ ...USER_A, secret: SECRET })
    await assert.rejects(() => decode(token, 'b'.repeat(64)))
  })

  test('有效期是 30 天，且 expiresAt 与 exp 对齐', async () => {
    const { token, expiresAt } = await signAssistantToken({ ...USER_A, secret: SECRET })
    const payload = await decode(token)
    assert.equal(expiresAt, Number(payload.exp) * 1000)
    assert.equal(Number(payload.exp) - Number(payload.iat), 30 * 24 * 60 * 60)
  })
})
