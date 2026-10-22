/**
 * 采集链路自检（数据库一侧的真相）。
 *
 * ## 为什么单独做成一条 CLI
 *
 * 「看板为什么没有数」有五种可能，分散在五处：槽位表没这家店、Edge 没起来、
 * 登录态失效、待办没人拉、入库失败。前三种只有宿主机知道，后两种只有库知道。
 * 这个脚本负责出后两种，`tools/collector/scripts/doctor.mjs` 负责前三种，两者
 * 拼成一张表。
 *
 * 与 `ops-shop-pending.ts` 同一条理由走 DB 直连：容器化之后宿主机调不到需要回环
 * 鉴权的接口。
 *
 * ## 输出
 *
 * 一行 JSON，字段全部是「可以被机器判断」的原始事实，不做措辞 —— 措辞在 .mjs
 * 那一侧，因为同一份事实要给人和给脚本看两遍。
 *
 *   {
 *     "collector": { "online": true, "lastSeenAt": "...", "ageSeconds": 42 },
 *     "pending": ["s2"],
 *     "shops": [
 *       { "code": "fanhe-main", "enabled": true, "loginState": "authenticated",
 *         "loginCheckedAt": "...", "collectPort": 9222,
 *         "lastCollectedAt": "...", "syncRequestedAt": null, "lastSyncError": null }
 *     ]
 *   }
 *
 * 用法（在 apps/api 下）：
 *   node_modules/.bin/tsx src/tools/ops-doctor.ts
 */
import { isCollectorOnline } from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import { listPendingShopCodes } from '../ops/shop-binding.js'

const heartbeat = await prisma.opsCollectorHeartbeat.findUnique({
  where: { id: 'watch' },
  select: { lastSeenAt: true, source: true },
})

const nowMs = Date.now()
const lastSeenAt = heartbeat === null ? null : heartbeat.lastSeenAt.toISOString()
const collector = {
  online: isCollectorOnline(lastSeenAt, nowMs),
  lastSeenAt,
  source: heartbeat?.source ?? null,
  ageSeconds:
    lastSeenAt === null ? null : Math.max(0, Math.round((nowMs - Date.parse(lastSeenAt)) / 1000)),
}

const [pending, shops] = await Promise.all([
  listPendingShopCodes(20),
  prisma.ecomShop.findMany({
    where: { enabled: true },
    orderBy: { createdAt: 'asc' },
    select: {
      code: true,
      name: true,
      enabled: true,
      loginState: true,
      loginCheckedAt: true,
      collectPort: true,
      lastCollectedAt: true,
      syncRequestedAt: true,
      lastSyncError: true,
      boundAt: true,
    },
  }),
])

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString())

console.log(
  JSON.stringify({
    collector,
    pending,
    shops: shops.map((shop) => ({
      code: shop.code,
      name: shop.name,
      enabled: shop.enabled,
      boundAt: iso(shop.boundAt),
      loginState: shop.loginState,
      loginCheckedAt: iso(shop.loginCheckedAt),
      collectPort: shop.collectPort,
      lastCollectedAt: iso(shop.lastCollectedAt),
      syncRequestedAt: iso(shop.syncRequestedAt),
      lastSyncError: shop.lastSyncError,
      /* 是否被请求过同步，由上面两个字段共同决定，不在这里推导第二遍。 */
    })),
  }),
)

await prisma.$disconnect()
