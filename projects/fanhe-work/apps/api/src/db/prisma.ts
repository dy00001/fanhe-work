import { PrismaPg } from '@prisma/adapter-pg'

import { env } from '../config/env.js'
import { PrismaClient } from '../generated/prisma/client.js'

/**
 * 数据库客户端。
 *
 * Prisma 7 起客户端不再自带查询引擎，SQL 提供方必须通过驱动适配器接入。
 * PostgreSQL 用 @prisma/adapter-pg，连接池由 pg 提供，适配器接受 pg 的
 * PoolConfig 或一个连接串。
 *
 * 单例挂在 globalThis 而不是用模块级常量：开发期 tsx watch 每次热重载都会
 * 重新执行模块，模块级常量会随之新建一个连接池，改几十次之后数据库的连接数
 * 就被占满，而报错出现在别处。挂到 globalThis 上可以跨重载复用同一个池。
 * 生产环境只加载一次，不需要这层，所以只在非生产环境下写入。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient }

function createClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: env.databaseUrl })
  return new PrismaClient({ adapter })
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient()

if (env.nodeEnv !== 'production') {
  globalForPrisma.prisma = prisma
}
