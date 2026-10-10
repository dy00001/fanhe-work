import { prisma } from '../db/prisma.js'

/**
 * 数据库连接自检。只回答一个问题：这台机器上的连接配置对不对。
 *
 * 换机器之后、改完 .env 之后、应用迁移之后，都应该先跑一次它。
 *
 * 它同时走两条路径。原始 SQL 能通，说明连接串、驱动适配器与网络都没问题；
 * 类型化客户端能通，说明生成的客户端与 schema 对得上、迁移确实落到了库上。
 * 两条都过才算真的配好了，只过其中一条往往是更隐蔽的问题：比如连上了库但
 * 迁移没应用，此时原始 SQL 通而 prisma.user.count() 会因为表不存在而失败。
 */

type TableRow = { table_name: string }

const tables = await prisma.$queryRaw<TableRow[]>`
  SELECT table_name
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name
`

const names = tables.map((row) => row.table_name)
console.log(`连接成功，public 模式下 ${names.length} 张表：`)
for (const name of names) {
  console.log(`  - ${name}`)
}

const [users, roles, permissions, rolePermissions] = await Promise.all([
  prisma.user.count(),
  prisma.role.count(),
  prisma.permission.count(),
  prisma.rolePermission.count(),
])

console.log('')
console.log('类型化客户端读取行数：')
console.log(`  users             ${users}`)
console.log(`  roles             ${roles}`)
console.log(`  permissions       ${permissions}`)
console.log(`  role_permissions  ${rolePermissions}`)

if (roles === 0) {
  console.log('')
  console.log('roles 为空，说明种子数据尚未写入，这一步属于 T1-02。')
}

await prisma.$disconnect()
