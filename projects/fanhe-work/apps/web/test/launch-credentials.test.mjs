/**
 * 启动配置「账号密码」的回归测试（P1）。
 *
 * 这个模块的价值全在**意图解释**上：密码永不出主进程，编辑态拿不回已保存的密码，于是
 * 「用户改没改密码」必须靠显式信号判断。半填状态若被判成「保持旧密码」，结果是新账号配
 * 着旧密码 —— 一个静默的错误登录，比明确报错糟得多。这里的断言把那条边界钉住。
 *
 * 桥的分支用注入的假 `window` 驱动：桌面态三条通道、浏览器态回落都覆盖到，且**不真的
 * 碰 Electron**。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { LAUNCH_CREDENTIAL_LIMITS, supportsAccountLogin } from '@fanhe/shared'

import {
  applyCredentialIntent,
  decideCredentialAction,
  deleteProfileCredential,
  describeCredentialOutcome,
  fetchCredentialStatus,
  profileSupportsAccountLogin,
  saveProfileCredential,
} from '../src/lib/launch-credentials.ts'

/* ------------------------------------------------------------------ *
 * 一、软件开关
 * ------------------------------------------------------------------ */

test('账号密码字段只对账号密码登录的软件出现', () => {
  assert.equal(profileSupportsAccountLogin('qq'), true)
  assert.equal(profileSupportsAccountLogin('qianniu'), true)
  // 微信是扫码登录，没有可代填的框；自定义程序的登录方式无从假定。
  assert.equal(profileSupportsAccountLogin('wechat'), false)
  assert.equal(profileSupportsAccountLogin('custom'), false)
  // 未知标识一律按不支持处理：多填一个框比少填一个框安全，但这里宁可保守。
  assert.equal(profileSupportsAccountLogin('telegram'), false)
  assert.equal(profileSupportsAccountLogin(''), false)
})

test('软件开关与共享包同一份，不另列清单', () => {
  // 桌面外壳的 shouldClickLogin 用的是同一个 supportsAccountLogin；这份断言的价值在于
  // **清单本身发生变化时会在这里现形**，而不是等两侧漂移后才在真机上发现。
  assert.deepEqual(
    ['wechat', 'qq', 'qianniu', 'custom'].filter((software) => supportsAccountLogin(software)),
    ['qq', 'qianniu'],
  )
})

/* ------------------------------------------------------------------ *
 * 二、意图解释：这个模块最重要的一块
 * ------------------------------------------------------------------ */

test('两个框都空 = 不动已保存的凭据', () => {
  const decision = decideCredentialAction({ account: '', password: '', clear: false })
  assert.deepEqual(decision, { action: 'keep' })
})

test('两个框都填 = 覆盖', () => {
  const decision = decideCredentialAction({ account: ' 12345 ', password: 'p@ss', clear: false })
  assert.deepEqual(decision, { action: 'save', account: '12345', password: 'p@ss' })
})

test('账号两端空白被去掉，密码原样保留', () => {
  // 密码的首尾空白可能是它本身的一部分，.trim() 掉会让用户存一个登录不上的密码。
  const decision = decideCredentialAction({ account: '  abc  ', password: '  pw  ', clear: false })
  assert.deepEqual(decision, { action: 'save', account: 'abc', password: '  pw  ' })
})

test('只填账号 = 拒绝，且理由说清「密码不会被回传」', () => {
  // 这是整套方案里最值钱的一条：放行的话用户会拿到「新账号 + 旧密码」。
  const decision = decideCredentialAction({ account: '12345', password: '', clear: false })
  assert.equal(decision.action, 'reject')
  assert.match(decision.message, /不会被回传/)
})

test('只填密码 = 拒绝', () => {
  const decision = decideCredentialAction({ account: '', password: 'pw', clear: false })
  assert.equal(decision.action, 'reject')
})

test('勾了清除 = 删除', () => {
  const decision = decideCredentialAction({ account: '', password: '', clear: true })
  assert.deepEqual(decision, { action: 'delete' })
})

test('清除与填写互斥：同时出现时拒绝，不挑一个执行', () => {
  for (const input of [
    { account: '12345', password: '', clear: true },
    { account: '', password: 'pw', clear: true },
    { account: '12345', password: 'pw', clear: true },
  ]) {
    const decision = decideCredentialAction(input)
    assert.equal(decision.action, 'reject', `应当拒绝 ${JSON.stringify(input)}`)
    assert.match(decision.message, /只能选一个/)
  }
})

test('长度卡在上限内放行，超一字符就拒', () => {
  const account = 'a'.repeat(LAUNCH_CREDENTIAL_LIMITS.ACCOUNT_MAX)
  const password = 'p'.repeat(LAUNCH_CREDENTIAL_LIMITS.PASSWORD_MAX)
  assert.deepEqual(decideCredentialAction({ account, password, clear: false }), {
    action: 'save',
    account,
    password,
  })

  const tooLong = decideCredentialAction({
    account: `a${account}`,
    password,
    clear: false,
  })
  assert.equal(tooLong.action, 'reject')
  assert.match(tooLong.message, new RegExp(`${LAUNCH_CREDENTIAL_LIMITS.ACCOUNT_MAX} 个字符`))

  const tooLongPassword = decideCredentialAction({
    account,
    password: `p${password}`,
    clear: false,
  })
  assert.equal(tooLongPassword.action, 'reject')
  assert.match(
    tooLongPassword.message,
    new RegExp(`${LAUNCH_CREDENTIAL_LIMITS.PASSWORD_MAX} 个字符`),
  )
})

test('长度按 UTF-16 码元算，与主进程的归一同一把尺', () => {
  // 主进程的 normalizeCredentialInput 用 `account.length`（码元）。这里用同一把尺，
  // 才不会出现「界面说刚好、主进程说超了」。
  const account = '用'.repeat(LAUNCH_CREDENTIAL_LIMITS.ACCOUNT_MAX)
  const password = '密'.repeat(LAUNCH_CREDENTIAL_LIMITS.PASSWORD_MAX)
  assert.equal(decideCredentialAction({ account, password, clear: false }).action, 'save')
  const over = decideCredentialAction({
    account: `用${account}`,
    password,
    clear: false,
  })
  assert.equal(over.action, 'reject')
})

/* ------------------------------------------------------------------ *
 * 三、宿主分流
 * ------------------------------------------------------------------ */

/** 临时把 `window` 换成桌面态，返回还原函数。 */
function withDesktopWindow(bridge) {
  const previous = globalThis.window
  globalThis.window = { fanheDesktop: bridge }
  return () => {
    if (previous === undefined) delete globalThis.window
    else globalThis.window = previous
  }
}

test('浏览器态：查状态回落成「加密不可用」，不回落成「都没有密码」', async () => {
  const reply = await fetchCredentialStatus(['p1', 'p2'])
  assert.deepEqual(reply, { items: [], encryptionAvailable: false })
})

test('浏览器态：保存与删除都明确拒绝，并说明需要桌面外壳', async () => {
  const saved = await saveProfileCredential({
    profileId: 'p1',
    account: 'a',
    password: 'b',
  })
  assert.equal(saved.ok, false)
  assert.equal(saved.reason, 'unsupported_host')
  assert.match(saved.detail, /桌面外壳/)

  const removed = await deleteProfileCredential('p1')
  assert.equal(removed.ok, false)
  assert.equal(removed.reason, 'unsupported_host')
})

test('桌面态：三条通道都走桥', async () => {
  const calls = []
  const restore = withDesktopWindow({
    isDesktopShell: true,
    getCredentialStatus: async (ids) => {
      calls.push(['status', ids])
      return {
        items: [{ profileId: ids[0], state: 'saved', accountMasked: '138****8888', label: '' }],
        encryptionAvailable: true,
      }
    },
    saveCredential: async (input) => {
      calls.push(['save', input])
      return { ok: true }
    },
    deleteCredential: async (profileId) => {
      calls.push(['delete', profileId])
      return { ok: true }
    },
  })

  try {
    const reply = await fetchCredentialStatus(['p1'])
    assert.equal(reply.encryptionAvailable, true)
    assert.equal(reply.items[0].accountMasked, '138****8888')

    await saveProfileCredential({ profileId: 'p1', account: 'a', password: 'b', label: 'QQ' })
    await deleteProfileCredential('p1')
  } finally {
    restore()
  }

  assert.equal(calls.length, 3)
  assert.deepEqual(calls[0], ['status', ['p1']])
  assert.equal(calls[1][0], 'save')
  assert.equal(calls[1][1].account, 'a')
  assert.equal(calls[1][1].label, 'QQ')
  assert.deepEqual(calls[2], ['delete', 'p1'])
})

test('桌面态但桥上是旧版外壳（没有这三个方法）时按浏览器态处理', async () => {
  const restore = withDesktopWindow({ isDesktopShell: true })
  try {
    assert.equal((await fetchCredentialStatus(['p1'])).encryptionAvailable, false)
    assert.equal(
      (await saveProfileCredential({ profileId: 'p1', account: 'a', password: 'b' })).ok,
      false,
    )
  } finally {
    restore()
  }
})

/* ------------------------------------------------------------------ *
 * 四、把意图落到凭据库
 * ------------------------------------------------------------------ */

test('applyCredentialIntent：keep 时一次桥都不调', async () => {
  let called = 0
  const restore = withDesktopWindow({
    isDesktopShell: true,
    saveCredential: async () => {
      called += 1
      return { ok: true }
    },
    deleteCredential: async () => {
      called += 1
      return { ok: true }
    },
  })
  try {
    const outcome = await applyCredentialIntent('p1', { account: '', password: '', clear: false })
    assert.deepEqual(outcome, { action: 'keep' })
  } finally {
    restore()
  }
  assert.equal(called, 0)
})

test('applyCredentialIntent：保存时账号去空白、密码原样、label 一起过去', async () => {
  let seen = null
  const restore = withDesktopWindow({
    isDesktopShell: true,
    saveCredential: async (input) => {
      seen = input
      return { ok: true }
    },
  })
  try {
    const outcome = await applyCredentialIntent(
      'p1',
      { account: ' 12345 ', password: ' pw ', clear: false },
      'QQ · 工作号',
    )
    assert.deepEqual(outcome, { action: 'saved' })
  } finally {
    restore()
  }
  assert.equal(seen.profileId, 'p1')
  assert.equal(seen.account, '12345')
  assert.equal(seen.password, ' pw ')
  assert.equal(seen.label, 'QQ · 工作号')
})

test('applyCredentialIntent：拒绝时一次桥都不调', async () => {
  let called = 0
  const restore = withDesktopWindow({
    isDesktopShell: true,
    saveCredential: async () => {
      called += 1
      return { ok: true }
    },
    deleteCredential: async () => {
      called += 1
      return { ok: true }
    },
  })
  try {
    const outcome = await applyCredentialIntent('p1', { account: 'a', password: '', clear: false })
    assert.equal(outcome.action, 'rejected')
  } finally {
    restore()
  }
  assert.equal(called, 0)
})

test('applyCredentialIntent：删除走 deleteCredential', async () => {
  const seen = []
  const restore = withDesktopWindow({
    isDesktopShell: true,
    deleteCredential: async (profileId) => {
      seen.push(profileId)
      return { ok: true }
    },
  })
  try {
    const outcome = await applyCredentialIntent('p1', { account: '', password: '', clear: true })
    assert.deepEqual(outcome, { action: 'deleted' })
  } finally {
    restore()
  }
  assert.deepEqual(seen, ['p1'])
})

test('applyCredentialIntent：保存失败不抛错，而是变成结果里的一项', async () => {
  // 调用方此时**已经保存了配置**，抛错会让它把配置也当成失败；正确的做法是提示
  // 「配置已保存，但密码没能保存到本机」。
  const restore = withDesktopWindow({
    isDesktopShell: true,
    saveCredential: async () => ({
      ok: false,
      reason: 'encryption_unavailable',
      detail: '本机系统加密暂不可用，密码未能保存。请重启应用后重试。',
    }),
  })
  try {
    const outcome = await applyCredentialIntent('p1', {
      account: 'a',
      password: 'b',
      clear: false,
    })
    assert.deepEqual(outcome, {
      action: 'failed',
      detail: '本机系统加密暂不可用，密码未能保存。请重启应用后重试。',
    })
  } finally {
    restore()
  }
})

/* ------------------------------------------------------------------ *
 * 五、结果翻成一句能接在配置保存提示后面的话
 * ------------------------------------------------------------------ */

test('describeCredentialOutcome：keep 返回空串，不占一个空段', () => {
  assert.equal(describeCredentialOutcome({ action: 'keep' }), '')
})

test('describeCredentialOutcome：三种动作各有一句，失败那句必须让人明白配置存上了', () => {
  assert.equal(describeCredentialOutcome({ action: 'saved' }), '账号密码已保存到本机')
  assert.equal(describeCredentialOutcome({ action: 'deleted' }), '已清除本机保存的密码')
  assert.equal(
    describeCredentialOutcome({ action: 'failed', detail: '磁盘满了' }),
    '配置已保存，但密码没能保存到本机：磁盘满了',
  )
  assert.equal(
    describeCredentialOutcome({ action: 'rejected', message: '账号与密码需要一起填写。' }),
    '账号与密码需要一起填写。',
  )
})
