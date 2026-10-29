/**
 * 店铺绑定入参的校验规则。
 *
 * 这一层拒绝的每一条都对应一种「会安静出事」的情况，所以每条都要有反例：
 *
 *   - code 不合法 → 采集器 `loadShops()` 直接抛错，整个采集端起不来；
 *   - name 含换行 → 写进 ingest 后会把一个字段拆成两行；
 *   - 端口越界或重复 → Edge 起不来，或两家店抢同一个调试端口（采到的必然是同一个账号）。
 *
 * 只测格式与范围，不测查重：查重要读库，属于路由层的测试。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OPS_COLLECT_PORT_MAX,
  OPS_COLLECT_PORT_MIN,
  OPS_COLLECTOR_ONLINE_WINDOW_MS,
  OPS_SHOP_CODE_PATTERN,
  isCollectorOnline,
  isOpsLoginState,
  validateShopBindInput,
  validateShopStateReport,
} from '../dist/ops.js'

const valid = {
  code: 'fanhe-main',
  name: '梵禾',
  platform: 'taobao',
  collectPort: 9222,
}

test('合法入参被原样接受，并补齐可选字段', () => {
  const result = validateShopBindInput(valid)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.code, 'fanhe-main')
  assert.equal(result.value.sellerNick, null)
  assert.equal(result.value.collectPort, 9222)
})

test('代号规则与采集器一致：小写字母、数字、连字符，且不以连字符开头', () => {
  assert.equal(OPS_SHOP_CODE_PATTERN.test('fanhe-main'), true)
  assert.equal(OPS_SHOP_CODE_PATTERN.test('s2'), true)
  assert.equal(OPS_SHOP_CODE_PATTERN.test('Fanhe'), false, '大写会被采集器的 CODE_RE 拒掉')
  assert.equal(OPS_SHOP_CODE_PATTERN.test('-main'), false, '以连字符开头会让目录名以点开头')
  assert.equal(OPS_SHOP_CODE_PATTERN.test('主店'), false)
  assert.equal(OPS_SHOP_CODE_PATTERN.test(''), false)
})

test('代号不合法时给出可读原因，而不是抛错', () => {
  const result = validateShopBindInput({ ...valid, code: '主店' })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.message, /店铺代号/)
})

test('名称含换行或制表符一律拒绝', () => {
  for (const name of ['梵禾\n定制', '梵禾\t店', '  ']) {
    const result = validateShopBindInput({ ...valid, name })
    assert.equal(result.ok, false, `应拒绝：${JSON.stringify(name)}`)
  }
})

test('端口必须在采集端口段内，且不接受字符串以外的隐式转换陷阱', () => {
  assert.equal(validateShopBindInput({ ...valid, collectPort: OPS_COLLECT_PORT_MIN }).ok, true)
  assert.equal(validateShopBindInput({ ...valid, collectPort: OPS_COLLECT_PORT_MAX }).ok, true)
  assert.equal(validateShopBindInput({ ...valid, collectPort: OPS_COLLECT_PORT_MIN - 1 }).ok, false)
  assert.equal(validateShopBindInput({ ...valid, collectPort: OPS_COLLECT_PORT_MAX + 1 }).ok, false)
  assert.equal(validateShopBindInput({ ...valid, collectPort: 9222.5 }).ok, false)
  assert.equal(
    validateShopBindInput({ ...valid, collectPort: '9222' }).ok,
    true,
    '表单传字符串是常态',
  )
})

test('端口可以不给：界面不再让人填，由写库那一层分配', () => {
  /* 端口对插件链路取数没有作用（那是旧 CDP 链路的产物），但采集器的槽位表仍
     要求参与采集的店有唯一端口。所以「不给」不等于「可以没有」—— 校验层只把
     null 传下去，分配发生在 `bindShop`。 */
  const withoutPort = { code: 'fanhe-main', name: '梵禾', platform: 'taobao' }

  const result = validateShopBindInput(withoutPort)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.collectPort, null, '没给就是 null，交给写库层分配')

  assert.equal(
    validateShopBindInput({ ...withoutPort, collectPort: '' }).ok,
    true,
    '空串同「没给」',
  )
  assert.equal(validateShopBindInput({ ...withoutPort, collectPort: null }).ok, true)
})

test('平台只接受枚举值', () => {
  assert.equal(validateShopBindInput({ ...valid, platform: 'jd' }).ok, false)
})

test('登录态只接受三档，拼错的值不会被静默当成 unknown', () => {
  assert.equal(isOpsLoginState('unknown'), true)
  assert.equal(isOpsLoginState('authenticated'), true)
  assert.equal(isOpsLoginState('needs_login'), true)
  assert.equal(isOpsLoginState('ok'), false)
  assert.equal(isOpsLoginState(null), false)
})

test('状态上报缺 code 或登录态非法时拒绝', () => {
  assert.equal(
    validateShopStateReport({
      code: 'fanhe-main',
      loginState: 'authenticated',
      clearSyncRequest: true,
    }).ok,
    true,
  )
  assert.equal(validateShopStateReport({ code: '', loginState: 'authenticated' }).ok, false)
  assert.equal(validateShopStateReport({ code: 'fanhe-main', loginState: 'yes' }).ok, false)
})

test('状态上报的时间必须是可解析的时刻', () => {
  const bad = validateShopStateReport({
    code: 'fanhe-main',
    loginState: 'authenticated',
    collectedAt: '昨天',
  })
  assert.equal(bad.ok, false)

  const good = validateShopStateReport({
    code: 'fanhe-main',
    loginState: 'authenticated',
    collectedAt: '2026-10-22T14:00:00.000Z',
    clearSyncRequest: true,
  })
  assert.equal(good.ok, true)
  if (!good.ok) return
  assert.equal(good.value.clearSyncRequest, true)
})

test('失败原因被截断到 500 字符，避免一次异常把列写爆', () => {
  const result = validateShopStateReport({
    code: 'fanhe-main',
    loginState: 'needs_login',
    lastSyncError: 'x'.repeat(2000),
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.lastSyncError.length, 500)
})

test('clearSyncRequest 只认布尔真值：字符串 "false" 不能清掉待办', () => {
  const result = validateShopStateReport({
    code: 'fanhe-main',
    loginState: 'authenticated',
    clearSyncRequest: 'false',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.value.clearSyncRequest, false)
})

test('采集器在线判定：窗口边界与异常输入', () => {
  const now = Date.parse('2026-10-22T12:00:00.000Z')
  const at = (offsetMs) => new Date(now - offsetMs).toISOString()

  assert.equal(isCollectorOnline(null, now), false, '没有心跳就是不在线')
  assert.equal(isCollectorOnline(at(0), now), true)
  assert.equal(
    isCollectorOnline(at(OPS_COLLECTOR_ONLINE_WINDOW_MS), now),
    true,
    '正好等于窗口算在线',
  )
  assert.equal(isCollectorOnline(at(OPS_COLLECTOR_ONLINE_WINDOW_MS + 1), now), false)
  assert.equal(isCollectorOnline('不是时间', now), false)

  /* 时钟倒退：心跳时间在「未来」。按在线处理 —— 更可能是本机时钟被调过，
     而不是采集器在撒谎。这条写反会让整块面板长期显示离线。 */
  assert.equal(isCollectorOnline(at(-60_000), now), true)
})
