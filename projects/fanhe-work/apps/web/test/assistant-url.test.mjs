/**
 * 助手地址拼装的回归测试。
 *
 * 这一层守的是两件**在界面上不报错**的事：配色不跟随、历史串号。两者都不是崩溃，
 * 只表现为「看起来怪」和「看到别人的对话」，而后者要等真的看见才知道出了事。
 *
 * 五个值钱的断言：
 *   ① 已有 query 时用 `&` 接，不把原参数顶掉 —— 覆盖 `VITE_ASSISTANT_URL` 带上
 *      自己的参数是本地调试的常规做法，拼错只会让人以为「开发环境坏掉了」。
 *   ② 没令牌时整段不出现，**不是** `t=` 空值。空值在助手那边是「无效令牌」，
 *      与「没有身份」走不同分支。
 *   ③ 令牌必须转义。签发用的是 base64url，理论上不含 `+/=`，但换一种签名实现就有
 *      可能含 —— 那时手拼字符串会得到一个被截断的令牌，而表现只是「历史不隔离」。
 *   ④ hash 必须留在 query 之后。
 *   ⑤ **宿主标记恒在**，包括拿不到令牌时。助手那一侧靠它判断「该不该清掉上一次
 *      留在浏览器里的令牌」：没有它，一次取令牌失败会把这一轮对话记到前一个人名下。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ASSISTANT_HOST_MARKER, buildAssistantUrl } from '../src/lib/assistant-url.ts'

const BASE = 'https://ai.fanhe.dpdns.org'

test('无已有 query 时用 ? 接参数', () => {
  const url = buildAssistantUrl({ baseUrl: BASE, theme: 'dark', token: null })
  assert.equal(url, `${BASE}?theme=dark&host=fanhe`)
})

test('已有 query 时用 & 接，且不覆盖原参数', () => {
  const url = buildAssistantUrl({ baseUrl: `${BASE}/?foo=1`, theme: 'light', token: null })
  assert.equal(url, `${BASE}/?foo=1&theme=light&host=fanhe`)
})

test('有令牌时带上 t', () => {
  const url = buildAssistantUrl({ baseUrl: BASE, theme: 'light', token: 'abc.def-ghi' })
  const parsed = new URL(url)
  assert.equal(parsed.searchParams.get('t'), 'abc.def-ghi')
  assert.equal(parsed.searchParams.get('theme'), 'light')
})

test('令牌为 null 时整段不出现，而不是 t 空值', () => {
  const url = buildAssistantUrl({ baseUrl: BASE, theme: 'light', token: null })
  assert.equal(new URL(url).searchParams.has('t'), false)
})

test('令牌为空串时同样整段不出现', () => {
  const url = buildAssistantUrl({ baseUrl: BASE, theme: 'light', token: '' })
  assert.equal(new URL(url).searchParams.has('t'), false)
})

test('令牌里的保留字符被转义，解析后仍是原值', () => {
  const token = 'a+b/c=d&e'
  const url = buildAssistantUrl({ baseUrl: BASE, theme: 'dark', token })
  // 原样出现在 query 里就会被当成两个参数，解析回来必然不等。
  assert.equal(new URL(url).searchParams.get('t'), token)
  assert.equal(new URL(url).searchParams.get('theme'), 'dark')
})

test('hash 留在 query 之后', () => {
  const url = buildAssistantUrl({ baseUrl: `${BASE}#/chat`, theme: 'dark', token: null })
  assert.equal(url, `${BASE}?theme=dark&host=fanhe#/chat`)
})

test('宿主标记恒在，拿不到令牌时也在', () => {
  for (const token of [null, '', 'x.y-z']) {
    const url = buildAssistantUrl({ baseUrl: BASE, theme: 'light', token })
    assert.equal(new URL(url).searchParams.get('host'), ASSISTANT_HOST_MARKER)
  }
})
