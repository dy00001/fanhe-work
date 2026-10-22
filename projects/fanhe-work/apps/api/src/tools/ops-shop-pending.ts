/**
 * 列出待同步的店铺代号（DB 直读）。
 *
 * ## 为什么需要它
 *
 * `GET /api/ops/shops/pending` 的鉴权是「token + 回环」，而容器化之后宿主机
 * 走 `127.0.0.1:8787` 进来，容器看到的源地址是 docker 网关（172.x），回环校验
 * 必然失败 —— 实测返回 `forbidden_origin`。这不是配置错误，是那条校验的设计后果：
 * 它本来就不打算接受跨网络边界的调用。
 *
 * 采集器必须跑在宿主机的 Windows 上（要 CDP 连本机 Edge），所以它永远在「边界
 * 之外」。与 `ops-import.ts` 同一条思路：给计划任务一条不经过 HTTP 的直连路径，
 * 走同一个 `listPendingShopCodes`，不存在两套口径。
 *
 * ## 用法（在 apps/api 下）
 *
 *   node_modules/.bin/tsx src/tools/ops-shop-pending.ts [--limit 5]
 *
 * 输出一行 JSON：`{"codes":["s2"]}`，由采集器解析。
 */
import { touchCollectorHeartbeat } from '../ops/collector-heartbeat.js'
import { listPendingShopCodes } from '../ops/shop-binding.js'
import { prisma } from '../db/prisma.js'

const argv = process.argv.slice(2)
const index = argv.indexOf('--limit')
const limit = index >= 0 ? Number(argv[index + 1]) : 5

/* 「有人来拉待办」就是心跳。容器化之后走的是这条 DB 直连路径，HTTP 那条走不到，
   所以两处都要写 —— 少写一处，界面就会把在跑的采集器显示成离线。 */
await touchCollectorHeartbeat('local')

const codes = await listPendingShopCodes(Number.isFinite(limit) ? limit : 5)
console.log(JSON.stringify({ codes }))
await prisma.$disconnect()
