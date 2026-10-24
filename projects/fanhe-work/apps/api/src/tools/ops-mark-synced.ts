/**
 * 把一次成功的采集回写到平台（DB 直写）。
 *
 * ## 为什么需要它
 *
 * 宿主上有两个执行者：常驻的 `sync-shops.mjs` 与定时跑日增的 `run-daily.ps1`。
 * 后者此前采完就结束，不碰库里的任何状态。后果是「界面与现实不一致」的三种表现：
 *
 *   1. 用户点过「立即同步」，日增确实采了，但 `sync_requested_at` 还在，
 *      界面一直显示「等待采集器」，直到常驻进程再白跑一遍。
 *   2. 日增成功说明登录态是好的，但 `login_state` 不更新，界面继续显示「未校验」
 *      甚至旧的「需重新登录」。
 *   3. 心跳只由常驻进程写。常驻任务停掉但日增照跑时，界面显示「采集器离线」，
 *      而数据其实每天在更新 —— 这是最误导人的一种。
 *
 * 所以一次成功采集之后，这三件事都要落库。**只在真的成功时调**（退出码 0 或 2），
 * 失败时不写，否则会把「失败」记成「成功」。
 *
 * ## 参数
 *
 *   --codes a,b     这次真的采了的店铺代号
 *   --all           所有启用且配了端口的店（不确定时不要用）
 *
 * 用法（在 apps/api 下）：
 *   node_modules/.bin/tsx src/tools/ops-mark-synced.ts --codes fanhe-main
 */
import { touchCollectorHeartbeat } from '../ops/collector-heartbeat.js'
import { prisma } from '../db/prisma.js'

const argv = process.argv.slice(2)

function argValue(name: string): string | null {
  const index = argv.indexOf(name)
  if (index < 0) return null
  return argv[index + 1] ?? null
}

const all = argv.includes('--all')
const rawCodes = argValue('--codes') ?? ''

const codes = all
  ? (
      await prisma.ecomShop.findMany({
        where: { enabled: true, collectPort: { not: null } },
        select: { code: true },
      })
    ).map((shop) => shop.code)
  : rawCodes
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')

if (codes.length === 0) {
  console.error('[mark-synced] 需要 --codes 或 --all')
  process.exit(2)
}

const now = new Date()
const result = await prisma.ecomShop.updateMany({
  where: { code: { in: codes } },
  data: {
    /* 这次确实采过了，待办就没有存在意义。 */
    syncRequestedAt: null,
    lastSyncError: null,
    /* 采到数据本身就证明登录态可用；留着「需重新登录」会让人去重登一次。 */
    loginState: 'authenticated',
    loginCheckedAt: now,
  },
})

/* 日增跑成功也是「采集器在工作」，心跳要跟上，否则界面会说采集器离线。 */
await touchCollectorHeartbeat('local')

console.log(JSON.stringify({ updated: result.count, codes }))
await prisma.$disconnect()
