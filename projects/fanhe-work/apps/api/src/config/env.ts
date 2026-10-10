import 'dotenv/config'

/**
 * 环境变量的唯一读取处。
 *
 * 这个 import 必须排在最前。Prisma 7 起 .env 不再自动加载，dotenv 是显式调用的，
 * 晚于其它 import 的话下面读 process.env 会拿到 undefined。
 *
 * 缺失时直接抛错而不是给默认值。连接串写错的后果是连到别的库上做迁移，
 * 那比启动失败难发现得多，所以宁可在这里就停住。
 */

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `缺少环境变量 ${name}。在 apps/api 目录下执行 Copy-Item .env.example .env，再按本机情况填写。`,
    )
  }
  return value
}

function readPort(): number {
  const raw = process.env.PORT ?? '8787'
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 必须是 1 到 65535 之间的整数，收到：${raw}`)
  }
  return port
}

export const env = {
  /** PostgreSQL 连接串。数据库不随 U 盘移动，换一台机器就要改这一项。 */
  databaseUrl: requireEnv('DATABASE_URL'),
  /** 只监听回环。工作空间在可移动介质上，开发期不应对局域网可达。 */
  host: process.env.HOST ?? '127.0.0.1',
  port: readPort(),
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const
