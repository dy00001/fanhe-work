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

/**
 * 读取一个整数环境变量，未设置时取默认值。
 *
 * 上下界是必需的，不是防御性冗余：Argon2 的 memoryCost 直接决定单次哈希占用
 * 多少内存，多写一位数就会让每个登录请求吃掉几 GB，而现象是进程被系统杀掉，
 * 报错不指向配置。这类数值配置不设上界，等于把 OOM 变成一个找不到原因的故障。
 */
function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数，收到：${raw}`)
  }
  return value
}

export const env = {
  /** PostgreSQL 连接串。数据库不随 U 盘移动，换一台机器就要改这一项。 */
  databaseUrl: requireEnv('DATABASE_URL'),
  /** 只监听回环。工作空间在可移动介质上，开发期不应对局域网可达。 */
  host: process.env.HOST ?? '127.0.0.1',
  port: readPort(),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  /**
   * 密码哈希参数。默认值是 OWASP 对 Argon2id 给出的最低推荐档
   * （m=19456 KiB，t=2，p=1，约 19 MiB）。
   *
   * 三者的关系是：内存换时间，时间换安全。调高 memoryCost 的收益最直接，
   * 代价是并发登录时每个请求都要占住这么多内存 —— 并发 10 就是 190 MiB。
   * 部署机器的内存和预期的并发数决定能开到多高，所以做成配置而不是写死。
   *
   * 改这些值不会让已有密码失效：PHC 编码的哈希串自带生成时的参数，
   * 校验时按串里的参数走，新密码才用新参数。
   */
  argon2: {
    memoryCost: readInt('ARGON2_MEMORY_KIB', 19456, 8, 4 * 1024 * 1024),
    timeCost: readInt('ARGON2_TIME_COST', 2, 1, 100),
    parallelism: readInt('ARGON2_PARALLELISM', 1, 1, 64),
  },
} as const
