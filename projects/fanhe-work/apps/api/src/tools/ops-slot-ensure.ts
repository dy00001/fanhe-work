/**
 * 把库里已绑定的店铺补齐到采集槽位表（DB 直写）。
 *
 * ## 为什么由宿主机做，而不是 API
 *
 * 绑定入口在 API 里也试着写槽位表，但容器化之后它看不到宿主机的
 * `tools/collector/shops.config.json`（compose 只挂了 pgdata），只能返回
 * `manual` 让人手工粘贴。这不该由人来补 —— 库里有 `code` / `name` /
 * `collect_port`，文件该长什么样是完全确定的。
 *
 * 所以把这一步交给跑在宿主机上的常驻进程：每一轮开始前跑一次本脚本，把库里
 * 有端口、文件里缺失或不一致的店铺写进去。**不需要新增标记列** —— 「库里有端口」
 * 本身就是待办条件，重复执行是幂等的。
 *
 * ## 幂等与安全
 *
 * 复用 `upsertSlot`：已存在的行只更新 name/port，其它字段（`qianniu`、
 * `note`、`collect`、`state`）原样保留。整份重写会抹掉人工维护的备注，而备注
 * 是排查串店时唯一的线索。写文件走「先写 .tmp 再 rename」，进程被杀不会留下
 * 半个 JSON。
 *
 * 找不到槽位表时**不报错**（退出码 0）：那台机器可能没有仓库，这属于正常形态，
 * 由调用方决定要不要提示。
 *
 * ## 输出
 *
 *   {"applied":["fanhe-main"],"skipped":[{"code":"s2","reason":"..."}],"file":"..."}
 *
 * 用法（在 apps/api 下）：
 *   node_modules/.bin/tsx src/tools/ops-slot-ensure.ts
 */
import { prisma } from '../db/prisma.js'
import { findSlotsFile, upsertSlot } from '../ops/shop-slots.js'

const shops = await prisma.ecomShop.findMany({
  where: { enabled: true, collectPort: { not: null } },
  orderBy: { createdAt: 'asc' },
  select: { code: true, name: true, collectPort: true },
})

const file = findSlotsFile()
const applied: string[] = []
const unchanged: string[] = []
const skipped: Array<{ code: string; reason: string }> = []

if (file === null) {
  console.log(
    JSON.stringify({
      applied,
      skipped: shops.map((shop) => ({
        code: shop.code,
        reason: '找不到槽位表（当前环境没有 tools/collector）',
      })),
      file: null,
    }),
  )
  await prisma.$disconnect()
  process.exit(0)
}

for (const shop of shops) {
  if (shop.collectPort === null) continue
  const result = upsertSlot({ code: shop.code, name: shop.name, port: shop.collectPort })
  if (result.kind !== 'synced') {
    skipped.push({ code: shop.code, reason: result.reason })
    continue
  }
  /* 区分「写了」与「本来就对」：调用方只在真写了的时候打日志，
     否则每分钟一条「已补齐」会把日志刷满。 */
  if (result.changed) applied.push(shop.code)
  else unchanged.push(shop.code)
}

console.log(JSON.stringify({ applied, unchanged, skipped, file }))
await prisma.$disconnect()
