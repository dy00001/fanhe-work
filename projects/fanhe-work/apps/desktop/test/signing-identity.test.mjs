/**
 * 签名身份档案的解析与比对（T6-03d）。
 *
 * ## 为什么这一组值得单独钉住
 *
 * 身份档案是「证书丢了之后，还能不能知道当初签的是哪一张」的唯一依据。它出错的
 * 后果**不会当场报错**：一份坏档案要么被当成「没有档案」（于是证书丢失时照旧
 * 静默新建一张，把已装机器全部废掉），要么被当成「身份一致」（于是打包用的
 * 根本不是那张证书也没人发现）。两种都属于「断言没说话」，只能靠喂坏输入钉住。
 *
 * 直接测 `scripts/signing-identity.mjs` —— 它是纯 ESM，不需要先构建、也不需要
 * Electron，与 `src/*.ts` 那批测试（靠 Node 的类型剥离）同一套路子。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  DEFAULT_IDENTITY_FILE_NAME,
  DEFAULT_SUBJECT,
  SIGNING_IDENTITY_SCHEMA_VERSION,
  SIGNING_TOOLING_VERSION,
  defaultIdentityPath,
  describeIdentity,
  describeIdentityDrift,
  isThumbprint,
  normalizeThumbprint,
  parseSigningIdentity,
  sameIdentity,
  sameThumbprint,
  simpleNameFromSubject,
} from '../scripts/signing-identity.mjs'

/** 本机那张证书的真实形状（指纹取自已发布产物，写全 40 位以免看起来像占位符）。 */
const REAL_THUMBPRINT = '0604B2381B8666C99F247DA7B576A4647601A5A3'
const OTHER_THUMBPRINT = '1111111111111111111111111111111111111111'

/** 造一份形状正确的档案；`overrides` 用来逐字段破坏它。 */
function identityJson(overrides = {}) {
  return JSON.stringify({
    schemaVersion: SIGNING_IDENTITY_SCHEMA_VERSION,
    toolingVersion: SIGNING_TOOLING_VERSION,
    subject: DEFAULT_SUBJECT,
    simpleName: 'Fanhe Work',
    thumbprint: REAL_THUMBPRINT,
    notBefore: '2026-10-13T06:00:00.0000000Z',
    notAfter: '2031-10-13T06:00:00.0000000Z',
    keyAlgorithm: 'RSA',
    keyLength: 2048,
    hashAlgorithm: 'SHA256',
    createdAt: '2026-10-13T06:00:00.0000000Z',
    updatedAt: '2026-10-13T06:00:00.0000000Z',
    history: [],
    ...overrides,
  })
}

// ── 形状：能认出来 ──────────────────────────────────────────────────────

test('解析一份正常的身份档案', () => {
  const result = parseSigningIdentity(identityJson())
  assert.equal(result.ok, true)
  assert.equal(result.identity.subject, DEFAULT_SUBJECT)
  assert.equal(result.identity.simpleName, 'Fanhe Work')
  assert.equal(result.identity.thumbprint, REAL_THUMBPRINT)
  assert.equal(result.identity.toolingVersion, SIGNING_TOOLING_VERSION)
  assert.deepEqual(result.identity.history, [])
})

test('剥掉前导 BOM —— PS 5.1 的 Set-Content -Encoding UTF8 会写它，而 JSON.parse 直接抛', () => {
  const result = parseSigningIdentity(`\uFEFF${identityJson()}`)
  assert.equal(result.ok, true, '带 BOM 的档案必须能被读出来，否则每份档案都会「坏了」')
  assert.equal(result.identity.thumbprint, REAL_THUMBPRINT)
})

test('指纹大小写与空格都归一，比对不受影响', () => {
  const lower = parseSigningIdentity(identityJson({ thumbprint: REAL_THUMBPRINT.toLowerCase() }))
  assert.equal(lower.ok, true)
  assert.equal(lower.identity.thumbprint, REAL_THUMBPRINT, '小写输入应被归一成大写')
})

test('simpleName 缺失时从 subject 推，不因此判档案无效', () => {
  const result = parseSigningIdentity(identityJson({ simpleName: undefined }))
  assert.equal(result.ok, true)
  assert.equal(result.identity.simpleName, 'Fanhe Work')
})

test('历史项被读出来（轮换过的机器要靠它找回旧身份）', () => {
  const result = parseSigningIdentity(
    identityJson({
      history: [
        {
          thumbprint: OTHER_THUMBPRINT,
          subject: DEFAULT_SUBJECT,
          replacedAt: '2026-10-13T07:00:00Z',
          reason: 'rotated-expiring',
        },
      ],
    }),
  )
  assert.equal(result.ok, true)
  assert.equal(result.identity.history.length, 1)
  assert.equal(result.identity.history[0].thumbprint, OTHER_THUMBPRINT)
  assert.equal(result.identity.history[0].reason, 'rotated-expiring')
})

// ── 反例：坏档案必须被拒绝，且拒绝的理由要能指出是哪一项 ────────────────

test('反例 · 空 / 非 JSON / 非对象一律拒绝', () => {
  for (const [input, why] of [
    ['', '空文本'],
    ['   \n ', '只有空白'],
    ['not json at all', '不是 JSON'],
    ['{"a":1}', '合法 JSON 但没有 schemaVersion'],
    ['[1,2,3]', '顶层是数组'],
    ['"a string"', '顶层是字符串'],
    ['null', '顶层是 null'],
  ]) {
    const result = parseSigningIdentity(input)
    assert.equal(result.ok, false, `${why} 必须被拒绝`)
    assert.equal(typeof result.reason, 'string')
    assert.ok(result.reason.length > 0, `${why} 被拒绝时必须给出理由`)
  }
})

test('反例 · schemaVersion 不符时明说「可能是更新的工具链写的」', () => {
  const result = parseSigningIdentity(identityJson({ schemaVersion: 2 }))
  assert.equal(result.ok, false)
  assert.match(result.reason, /schemaVersion/)
  assert.match(result.reason, /升级本工具/, '要给出可执行的下一步，而不是只说「不合法」')
})

test('反例 · toolingVersion 必须是 >= 1 的整数', () => {
  for (const bad of [0, -1, 1.5, '2', null, undefined]) {
    const result = parseSigningIdentity(identityJson({ toolingVersion: bad }))
    assert.equal(result.ok, false, `toolingVersion=${JSON.stringify(bad)} 必须被拒绝`)
  }
})

test('反例 · 指纹必须是 40 位十六进制', () => {
  for (const bad of [
    '',
    'ABC',
    REAL_THUMBPRINT.slice(0, 39), // 少一位
    `${REAL_THUMBPRINT}0`, // 多一位
    'G'.repeat(40), // 非十六进制
    null,
    undefined,
  ]) {
    const result = parseSigningIdentity(identityJson({ thumbprint: bad }))
    assert.equal(result.ok, false, `thumbprint=${JSON.stringify(bad)} 必须被拒绝`)
  }
})

test('反例 · 缺 notAfter 要拒绝（没有到期时间就判断不了该不该轮换）', () => {
  const result = parseSigningIdentity(identityJson({ notAfter: '' }))
  assert.equal(result.ok, false)
  assert.match(result.reason, /notAfter/)
})

test('反例 · history 不是数组、或历史项缺字段，都要拒绝', () => {
  assert.equal(parseSigningIdentity(identityJson({ history: null })).ok, false)
  assert.equal(parseSigningIdentity(identityJson({ history: {} })).ok, false)
  // 历史项的指纹坏了 —— 那正是「找回旧身份」要用的字段，不能放过去。
  assert.equal(
    parseSigningIdentity(identityJson({ history: [{ thumbprint: 'xyz', subject: 'CN=a' }] })).ok,
    false,
  )
  assert.equal(
    parseSigningIdentity(identityJson({ history: [{ thumbprint: OTHER_THUMBPRINT, subject: '' }] }))
      .ok,
    false,
  )
})

// ── 比对：这里的两条反例正是本项目踩过的坑 ──────────────────────────────

test('两个空指纹不相等 —— 「都读不到」不等于「一样」', () => {
  assert.equal(sameThumbprint('', ''), false)
  assert.equal(sameThumbprint(null, null), false)
  assert.equal(sameThumbprint(undefined, REAL_THUMBPRINT), false)
  assert.equal(
    sameThumbprint(REAL_THUMBPRINT, REAL_THUMBPRINT.toLowerCase()),
    true,
    '同一张证书的两种写法必须判等',
  )
})

test('主体相同但指纹不同时不算同一身份（本项目踩过的正是这个）', () => {
  const identity = parseSigningIdentity(identityJson()).identity
  assert.equal(
    sameIdentity(identity, { subject: DEFAULT_SUBJECT, thumbprint: OTHER_THUMBPRINT }),
    false,
    '只比主体会漏掉「同主题名下换了一张证书」，而那照样让更新校验失败',
  )
  assert.equal(
    sameIdentity(identity, { subject: DEFAULT_SUBJECT, thumbprint: REAL_THUMBPRINT }),
    true,
  )
  assert.equal(sameIdentity(null, { subject: DEFAULT_SUBJECT, thumbprint: REAL_THUMBPRINT }), false)
})

test('主体从 DN 里取 CN，取不到就返回空串', () => {
  assert.equal(simpleNameFromSubject('CN=Fanhe Work'), 'Fanhe Work')
  assert.equal(simpleNameFromSubject('cn=Fanhe Work'), 'Fanhe Work', 'CN 大小写不敏感')
  assert.equal(simpleNameFromSubject('O=Fanhe, CN=Fanhe Work'), 'Fanhe Work', '多段 DN 里找 CN')
  assert.equal(simpleNameFromSubject('O=Fanhe'), '')
  assert.equal(simpleNameFromSubject(''), '')
  assert.equal(simpleNameFromSubject(undefined), '')
})

// ── 漂移描述：要能区分「有意轮换」与「意外丢失」 ────────────────────────

test('身份一致时没有漂移', () => {
  const identity = parseSigningIdentity(identityJson()).identity
  assert.equal(
    describeIdentityDrift(identity, { subject: DEFAULT_SUBJECT, thumbprint: REAL_THUMBPRINT }),
    '',
  )
  assert.equal(describeIdentityDrift(null, { subject: 'x', thumbprint: OTHER_THUMBPRINT }), '')
})

test('换了证书时要说清「已装旧版的机器收不到更新」', () => {
  const identity = parseSigningIdentity(identityJson()).identity
  const text = describeIdentityDrift(identity, {
    subject: DEFAULT_SUBJECT,
    thumbprint: OTHER_THUMBPRINT,
  })
  assert.match(text, /不是档案里的那一张/)
  assert.match(text, new RegExp(REAL_THUMBPRINT))
  // 必须点明后果，否则这就是一个纯技术性的提示。
  assert.match(text, /收不到更新|静默失败/)
  // 而且要说对**原因**：断的是信任根，不是 publisherName。
  // 这两句话混起来过：早期版本写的是「换证书等于换签名主体」，但 publisherName 是从
  // 证书 Subject DN 推出来的（app-builder-lib PublishManager.js:202），同 CN 就同字符串，
  // 换证书根本不会让它变。真正的闸是 electron-updater 只在 Status===0 时才比发布者，
  // 而自签根逐机导入 —— 换证书等于换根。按错的因果去修，会去改一个本来就没问题的配置。
  assert.match(text, /信任根/, '原因必须落在信任根上')
  assert.match(text, /Status/, '要指到真正起作用的那道闸')
  assert.doesNotMatch(
    text,
    /换签名主体/,
    'publisherName 由 Subject DN 推出，同 CN 不会变 —— 说「换了签名主体」是把因果说反了',
  )
})

test('读不到证书与换了证书是两种漂移，描述必须不同', () => {
  const identity = parseSigningIdentity(identityJson()).identity
  const missing = describeIdentityDrift(identity, { subject: '', thumbprint: '' })
  const rotated = describeIdentityDrift(identity, {
    subject: DEFAULT_SUBJECT,
    thumbprint: OTHER_THUMBPRINT,
  })
  assert.match(missing, /读不出/)
  assert.notEqual(missing, rotated, '两种情况的补救动作不同，描述不能混成一句')
})

test('describeIdentity 在无档案时给出可读的占位，而不是 undefined', () => {
  assert.equal(describeIdentity(null), '(无身份档案)')
  const identity = parseSigningIdentity(identityJson()).identity
  const text = describeIdentity(identity)
  assert.match(text, /CN=Fanhe Work/)
  assert.match(text, new RegExp(REAL_THUMBPRINT))
})

// ── 默认路径 ────────────────────────────────────────────────────────────

test('默认档案路径落在 LOCALAPPDATA 下、且不在工作区内', () => {
  const path = defaultIdentityPath({ LOCALAPPDATA: 'C:\\Users\\dy\\AppData\\Local' })
  assert.ok(path.endsWith(`\\${DEFAULT_IDENTITY_FILE_NAME}`), path)
  assert.ok(path.startsWith('C:\\Users\\dy\\AppData\\Local'), path)
  assert.equal(defaultIdentityPath({}), null, '没有 LOCALAPPDATA 时要返回 null，由调用方决定怎么报')
})

test('指纹形状判定的边界', () => {
  assert.equal(isThumbprint(REAL_THUMBPRINT), true)
  assert.equal(isThumbprint(REAL_THUMBPRINT.toLowerCase()), true)
  assert.equal(isThumbprint('06 04 B2 38'), false, '太短，即使格式像也不行')
  assert.equal(normalizeThumbprint(REAL_THUMBPRINT.slice(0, 8)), null)
})
