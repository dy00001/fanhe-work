/**
 * 「后台编辑口令」入口的接线、校验与提示。
 *
 * ## 这一条为什么值得单独测
 *
 * 它是在**唯一能改这把锁**的地方。改坏了不会报错：入口对谁都显示（别人点开被拒，
 * 以为自己被降权）、长度校验少一位（设了个 3 位口令也能存进去）、两次输入不比对
 * （打成自己都记不住的一串，之后所有设备都得再来一次）。
 *
 * 而这些在浏览器里逐条点一遍的成本很高 —— 要先登录超管、再进维护台。所以这里把
 * 「谁看得见」「什么条件下按钮才可点」「成功后说哪句话」都钉在源码上。
 *
 * 最要紧的一条是**判据用角色还是用 direct**：服务端两者现在等价，但 `direct` 表达
 * 的是「能写价格」，而这里要的是「谁是那个能设锁的人」。将来给 admin 开直写价格时，
 * 用 `direct` 做判据会把改口令的权限一起放宽，且没有任何提示。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { QUOTE_LIMITS } from '@fanhe/shared'

/** 注释里可以大段讨论这些写法（本文件自己就写了），只有落在代码里的才算数。 */
function readCode(url) {
  const source = readFileSync(url, 'utf8')
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const MAINT = readCode(new URL('../src/components/quote/QuoteMaintPanel.tsx', import.meta.url))
const SECRET = readCode(
  new URL('../src/components/quote/maint/QuoteSecretPanel.tsx', import.meta.url),
)
const ACCESS = readCode(new URL('../../api/src/quote/access.ts', import.meta.url))
const ROUTES = readCode(new URL('../../api/src/routes/quote.ts', import.meta.url))

// ---------------------------------------------------------------------------
// 可见性：只有超管
// ---------------------------------------------------------------------------

test('入口判据是角色 owner，不是 direct', () => {
  assert.match(
    MAINT,
    /const isOwner = access !== null && access\.role === ROLE_CODES\.OWNER/,
    '入口可见性必须按角色判。用 direct 的话，将来给 admin 开直写价格会把「改口令」一起放开',
  )
})

test('按钮与展开条都挂在 isOwner 下', () => {
  assert.match(
    MAINT,
    /\{isOwner && \(\s*<button/,
    '入口按钮要包在 isOwner 里。别人看到按钮只会点开再被拒，等于给了一个坏消息的入口',
  )
  assert.match(
    MAINT,
    /\{secretOpen && isOwner && \(/,
    '展开条要同时判「点了按钮」与「是超管」—— 少判一个，非超管也能把面板挂出来',
  )
})

test('收起即卸载，不靠 effect 重置', () => {
  assert.match(
    MAINT,
    /\{secretOpen && isOwner && \(\s*<QuoteSecretPanel/,
    '面板要按条件挂载。常驻 + useEffect 清 state 会撞 set-state-in-effect，且重开第一帧闪旧内容',
  )
  assert.doesNotMatch(
    SECRET,
    /useEffect/,
    '口令面板里不该有 effect：状态靠挂载清空，长度与一致性都是渲染时算出来的',
  )
})

// ---------------------------------------------------------------------------
// 校验：非空、至少 6 位、两次一致
// ---------------------------------------------------------------------------

test('长度取自共享常量，不写死数字', () => {
  assert.match(SECRET, /QUOTE_LIMITS\.PASSWORD_MIN/)
  assert.match(SECRET, /QUOTE_LIMITS\.PASSWORD_MAX/)
  for (const literal of ['>= 8', '< 8', '=== 8', '>= 6', '< 6', 'length < 6']) {
    assert.ok(
      !SECRET.includes(literal),
      `口令面板里出现了写死的长度判断「${literal}」。改 QUOTE_LIMITS 时它会悄悄不同步`,
    )
  }
})

test('用户拍板的长度是 6 位', () => {
  // 2026-11-03 用户原话：「长度要求 6 位数以上就OK」。
  assert.equal(QUOTE_LIMITS.PASSWORD_MIN, 6)
  assert.ok(QUOTE_LIMITS.PASSWORD_MAX >= QUOTE_LIMITS.PASSWORD_MIN)
})

test('两次输入必须一致才允许提交', () => {
  const canSubmit = SECRET.match(/const canSubmit =\s*([\s\S]{0,260}?)\n\n/)
  assert.ok(canSubmit !== null, 'canSubmit 的写法变了，改这条断言')
  const body = canSubmit[1]
  assert.match(body, /normalizedConfirm === normalized/, '确认框不比对，手滑打错就存进去了')
  assert.match(body, /normalized\.length >= min/, '长度下限没进提交条件')
  assert.match(body, /!busy/, '提交中要禁用，否则会连发两次改口令')
})

test('首尾空格被规整掉，纯空格不算口令', () => {
  assert.match(SECRET, /const normalized = password\.trim\(\)/, '前端提交前要 trim')
  assert.match(ACCESS, /function normalizePassword\(password: string\): string/)
  // 设口令与解锁必须用同一套规整，否则「设的时候带尾随空格、解锁不带」会永远进不去。
  const uses = ACCESS.match(/normalizePassword\(/g) ?? []
  assert.ok(uses.length >= 3, '设口令、轮换、解锁三处都要走 normalizePassword')
  // 纯空格的护栏就是这次 trim：6 个空格 trim 完是空串，长度 0 撞下限。
  // 曾经在这里写过一个 `password !== ''`，反例注入时发现它是冗余的 —— 删掉它，
  // 「纯空格不算口令」这条仍然成立（`apps/api/test/quote.test.ts` 有用例钉住行为）。
})

test('服务端的长度错误走中文，不交给 schema 拦', () => {
  const schema = ROUTES.match(/const SET_SECRET_BODY_SCHEMA = \{[\s\S]*?\n\} as const/)
  assert.ok(schema !== null, 'SET_SECRET_BODY_SCHEMA 的写法变了')
  assert.ok(
    !/minLength: QUOTE_LIMITS\.PASSWORD_MIN/.test(schema[0]),
    'schema 拦下时是英文的 body/password must NOT have fewer than 6 characters',
  )
  assert.match(schema[0], /minLength: 1/, '只留「非空」这一条形状校验')
  assert.match(ROUTES, /invalid_password_shape: `口令长度需在/)
})

// ---------------------------------------------------------------------------
// 提交与提示
// ---------------------------------------------------------------------------

test('首次走 create、已有走 rotate，不混成一个接口', () => {
  assert.match(
    SECRET,
    /saveQuoteSecret\(normalized, hasSecret \? 'rotate' : 'create'\)/,
    '两条路径的失败语义不同：首次设置重复提交是 409，轮换不是',
  )
})

test('成功后说清「谁会失效」，并通知父级重拉状态', () => {
  assert.match(SECRET, /onSaved\(\)/, '不通知父级，界面上的「已设过口令」会停在旧值')
  assert.match(
    SECRET,
    /其他设备上已打开的维护权限立刻失效/,
    '改口令的后果必须写出来，否则用户不知道同事那边要重新输',
  )
  assert.match(SECRET, /超管直入不受影响/, '要让超管知道他自己这台不用重输')
})

test('失败分三种说法：权限不足 / 状态过期 / 其他', () => {
  assert.match(SECRET, /caught\.status === 403/)
  assert.match(SECRET, /只有超级管理员能修改后台编辑口令/)
  assert.match(SECRET, /caught\.status === 409/)
  assert.match(SECRET, /收起后重开一次再试/, '409 多半是界面上的 hasSecret 过期了，要指路')
  assert.match(SECRET, /caught\.message/, '其余情况用服务端原话，别自己编')
})
