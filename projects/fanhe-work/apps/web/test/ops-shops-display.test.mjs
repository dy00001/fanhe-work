/**
 * 店铺同步状态的展示规则。
 *
 * 这些规则决定「这块显示红还是灰」，而颜色与措辞只要写进 JSX 就只能开浏览器才能验。
 * 这里逐条钉住判定顺序，因为顺序写反不会报错，只会让人做错动作：
 *
 *   - 「已请求、采集器还没来」必须优先于「上次失败」，否则用户会立刻再点一次同步；
 *   - 刚绑定（`unknown`）不能显示成红色，否则会被引导去重新登录一个没问题的账号；
 *   - 失败原因要原样带出来，界面据此显示可执行的下一步。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  LOGIN_STATE_META,
  collectorView,
  loginDetail,
  needsPortRegistration,
  shopSlotText,
  shopSyncView,
} from '../src/lib/ops-display.ts'

const NOW = new Date('2026-10-22T12:00:00.000Z')

function shop(overrides = {}) {
  return {
    id: 'id-1',
    code: 'fanhe-main',
    name: '梵禾',
    platform: 'taobao',
    sellerNick: null,
    timezone: 'Asia/Shanghai',
    lastCollectedAt: null,
    boundAt: null,
    loginState: 'unknown',
    loginCheckedAt: null,
    collectPort: 9222,
    syncRequestedAt: null,
    lastSyncError: null,
    ...overrides,
  }
}

test('待处理的同步优先于失败原因：否则用户会重复点「立即同步」', () => {
  const view = shopSyncView(
    shop({ syncRequestedAt: '2026-10-22T11:58:00.000Z', lastSyncError: '上次失败' }),
    NOW,
  )
  assert.equal(view.label, '等待采集器')
  assert.equal(view.tone, 'warn')
})

test('没有待办时，失败原因优先于新鲜度', () => {
  const view = shopSyncView(
    shop({
      lastSyncError: '采集浏览器未启动（端口 9222 无响应）',
      lastCollectedAt: '2026-10-20T00:00:00.000Z',
    }),
    NOW,
  )
  assert.equal(view.label, '同步失败')
  assert.equal(view.tone, 'error')
  assert.match(view.detail, /端口 9222/)
})

test('从没采过的店是「尚未同步」而不是失败', () => {
  const view = shopSyncView(shop(), NOW)
  assert.equal(view.label, '尚未同步')
  assert.equal(view.tone, 'muted')
})

test('新鲜度复用看板同一套阈值：26 小时内算新鲜，超过两天算过期', () => {
  const fresh = shopSyncView(shop({ lastCollectedAt: '2026-10-22T00:00:00.000Z' }), NOW)
  assert.equal(fresh.tone, 'ok')
  assert.match(fresh.detail, /上次采集/)

  const old = shopSyncView(shop({ lastCollectedAt: '2026-10-19T00:00:00.000Z' }), NOW)
  assert.equal(old.tone, 'warn')
  assert.match(old.label, /两天/)
})

test('刚绑定的登录态是灰色「未校验」，不是红色错误', () => {
  assert.equal(LOGIN_STATE_META.unknown.tone, 'muted')
  assert.equal(LOGIN_STATE_META.needs_login.tone, 'error')
  assert.equal(loginDetail(shop()), LOGIN_STATE_META.unknown.hint)
})

test('登录态第二行显示校验时刻，绿点旁边才有时间参照', () => {
  const detail = loginDetail(
    shop({ loginState: 'authenticated', loginCheckedAt: '2026-10-22T09:30:00.000Z' }),
  )
  assert.match(detail, /校验于/)
  assert.match(detail, /09:30|17:30/, `本地时刻应可读：${detail}`)
})

test('副标题把代号与端口合成一行；端口缺失时明确说出来', () => {
  assert.equal(shopSlotText(shop()), 'fanhe-main · 端口 9222')
  assert.equal(shopSlotText(shop({ collectPort: null })), 'fanhe-main · 端口未登记')
})

test('采集器状态：在线、从未启动、离线三态必须分开', () => {
  assert.equal(collectorView(null, NOW).tone, 'muted')

  const online = collectorView({ lastSeenAt: '2026-10-22T11:59:00.000Z', online: true }, NOW)
  assert.equal(online.tone, 'ok')
  assert.match(online.detail, /最后心跳/)

  /* 「从未启动」与「离线」的下一步动作不同：一个要注册计划任务，一个要重启进程。
     合并成一句「离线」会让人去重启一个不存在的东西。 */
  const never = collectorView({ lastSeenAt: null, online: false }, NOW)
  assert.equal(never.tone, 'error')
  assert.match(never.label, /从未启动/)
  assert.match(never.detail, /sync-shops/)

  const stale = collectorView({ lastSeenAt: '2026-10-22T09:00:00.000Z', online: false }, NOW)
  assert.equal(stale.tone, 'warn')
  assert.match(stale.label, /离线/)
  assert.match(stale.detail, /小时前/)
})

test('端口未登记要能被识别出来', () => {
  /* 这条不只是文案问题：补槽位那条链路只处理「库里有端口」的店，
     端口为空时它连碰都不碰，槽位丢了就补不回来。 */
  assert.equal(needsPortRegistration({ collectPort: null }), true)
  assert.equal(needsPortRegistration({}), true, '字段缺失也算没登记')
  assert.equal(needsPortRegistration({ collectPort: 9222 }), false)
})
