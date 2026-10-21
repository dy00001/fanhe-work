/**
 * 五店占位：把另外四家店建成「已登记、暂无数据」的记录。
 *
 * 为什么需要这一步：看板的五店并列指标带要求界面固定五列，而库里目前只有一家店。
 * 若只靠前端硬凑四个空卡，切店时会拿到 404（接口找不到这个 code），于是「点一下
 * 就报错」；而把四家店建成真实记录，切店拿到的是「这家店存在但还没有数据」，界面
 * 统一走占位态，交互与有数据的店完全一致。
 *
 * 这四行**不是演示数据**：它们的 `lastCollectedAt` 为空、没有任何逐日行，界面上
 * 一律标「待接入」。等分店授权到位，采集器按 code 写入即可，不需要改代码或迁移。
 *
 * 幂等：按 code upsert，重复执行不会产生新行，也不会改动已经采到数据的店。
 */
import { prisma } from '../db/prisma.js'

/**
 * 已授权的主店由采集器建档（code=fanhe-main），不在这里重复创建。
 *
 * s2 与 s3 已有真名（雅素、简作）并完成千牛登录，只是还没采到数据；
 * s4 与 s5 仍是占位。这里的名字只在新建时生效，已有记录走 update 分支不会改名。
 * 名称必须与 `tools/collector/shops.config.json` 逐字一致，否则首次采集会被
 * ingest 的 upsert 覆盖成配置里的写法。
 */
const PLACEHOLDER_SHOPS = [
  { code: 's2', name: '雅素' },
  { code: 's3', name: '简作' },
  { code: 's4', name: '分店 4' },
  { code: 's5', name: '分店 5' },
] as const

for (const shop of PLACEHOLDER_SHOPS) {
  await prisma.ecomShop.upsert({
    where: { code: shop.code },
    create: { code: shop.code, name: shop.name, platform: 'taobao' },
    // 只保证「这条记录存在且启用」，不动名称：店家真名到位后由人改库或由采集器更新，
    // 每次跑这个脚本把名字覆盖回「分店 N」会抹掉人工维护的信息。
    update: { enabled: true },
  })
}

const shops = await prisma.ecomShop.findMany({
  orderBy: { createdAt: 'asc' },
  select: { code: true, name: true, lastCollectedAt: true },
})
console.log(`店铺 ${shops.length} 家：`)
for (const shop of shops) {
  console.log(
    `  ${shop.code.padEnd(12)} ${shop.name}${shop.lastCollectedAt === null ? '  （暂无数据）' : ''}`,
  )
}

await prisma.$disconnect()
