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

/**
 * 读取一个密钥类环境变量，并强制最小长度。
 *
 * 不给默认值。默认密钥是最容易一路带到生产环境的东西，而签名密钥一旦泄露，
 * 等于任何人都能伪造登录态 —— 这类事故不会在开发期暴露，只在出事时暴露。
 *
 * 长度按字节算而不是按字符算：密钥里出现中文或其它多字节字符时，按字符数判断
 * 会把一个远短于要求的密钥放过去。
 */
function requireSecret(name: string, minBytes: number): string {
  const value = requireEnv(name)
  const actual = Buffer.byteLength(value, 'utf8')
  if (actual < minBytes) {
    throw new Error(`${name} 至少需要 ${minBytes} 字节，当前为 ${actual} 字节。`)
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

  /**
   * 会话令牌。
   *
   * 访问令牌是 JWT，短期、无状态，服务端不存；刷新令牌是不透明随机串，只存
   * 哈希、可撤销。两者分工的理由见 auth/tokens.ts。
   */
  jwt: {
    /**
     * 访问令牌的签名密钥，必填。32 字节下限来自 HS256 的密钥长度要求 ——
     * 密钥短于摘要长度时，攻击者可以暴力搜索密钥空间而不是伪造签名。
     *
     * 生成方式：`node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`。
     *
     * ## 用 getter 而不是直接求值，这是 T5-03 才暴露出来的一条
     *
     * 本文件在**模块加载时**求值整个 env 对象，而这里是 `requireSecret(...)` ——
     * 于是任何 import 了这个模块的脚本都被迫提供 `JWT_SECRET`，哪怕它根本不签发
     * 令牌。`src/db/seed.ts` 就是这样撞上的：它只需要 `DATABASE_URL`，却因为
     * `db/prisma.ts` 引了 env 而在容器里报「缺少环境变量 JWT_SECRET」。
     *
     * **那个容器的整件事就是建表 + 写种子**，它没有理由持有签名密钥 —— 给了它
     * 等于扩大密钥的暴露面，而且以后每加一个运维脚本就要重复注入一次。
     *
     * 改成 getter 之后，只有真的去读 `env.jwt.secret` 才会求值。
     *
     * **代价是「启动即失败」不再自动发生**，所以 `index.ts` 在 listen 之前显式读
     * 一次（见那里的 `assertRequiredEnv`）—— 把「加载时校验」换成「启动时校验」，
     * 时机差几毫秒，而配置缺失仍是在服务对外之前暴露。
     */
    get secret(): string {
      return requireSecret('JWT_SECRET', 32)
    },
    /** 访问令牌有效期，默认 15 分钟。短到即使泄露也很快失效。 */
    accessTtlSeconds: readInt('ACCESS_TOKEN_TTL_SECONDS', 900, 60, 24 * 3600),
    /** 刷新令牌有效期，默认 30 天。决定「多久不用就要重新登录」。 */
    refreshTtlDays: readInt('REFRESH_TOKEN_TTL_DAYS', 30, 1, 365),
    /**
     * 轮换宽限期，单位秒。
     *
     * 已轮换的令牌在宽限期内被再次提交，判为并发竞态而非泄露。同一客户端的
     * 多个窗口或标签页会几乎同时刷新，此时把整条链撤掉会让用户无端掉线。超出
     * 宽限期的重复提交才视为令牌已泄露，按 familyId 整链撤销。
     *
     * 设为 0 即严格模式：任何重复提交都触发整链撤销。代价是并发刷新必然导致
     * 重新登录，除非客户端保证同一时刻只有一个刷新请求在飞。
     */
    rotationGraceSeconds: readInt('REFRESH_ROTATION_GRACE_SECONDS', 10, 0, 300),
  },

  /**
   * 登录限速。
   *
   * 两个维度同时生效，各自解决不同的问题。账号维度防的是针对某个账号猜密码，
   * 连续失败若干次后锁定该账号。IP 维度防的是从一个来源批量扫账号，在一个
   * 时间窗口内失败次数超限后拒绝该 IP 的登录请求，不论它提交的用户名是否存在。
   *
   * 只做账号维度挡不住用户名枚举。攻击者用一批不存在的用户名试密码，每个账号
   * 的失败计数都停在 0，永远不会触发锁定。只做 IP 维度挡不住换 IP 的分布式
   * 爆破。两者都要有，缺任何一边都留下一整类攻击。
   */
  login: {
    /** 账号维度：连续失败多少次后锁定。 */
    maxFailedAttempts: readInt('LOGIN_MAX_FAILED_ATTEMPTS', 5, 1, 1000),
    /** 账号维度：锁定时长，单位分钟。 */
    lockMinutes: readInt('LOGIN_LOCK_MINUTES', 15, 1, 1440),
    /** IP 维度：统计窗口长度，单位分钟。窗口是滑动的，不按固定区间分桶。 */
    ipWindowMinutes: readInt('LOGIN_IP_WINDOW_MINUTES', 15, 1, 1440),
    /**
     * IP 维度：窗口内失败多少次后拒绝该 IP。
     *
     * 默认值明显高于账号维度的 5 次，因为一个 IP 后面可能有多个人（NAT、办公网
     * 出口、共用宽带），阈值定得太低会把正常用户一起挡在外面。个人工作台的场景
     * 下这个值很少被触及。
     */
    ipMaxFailedAttempts: readInt('LOGIN_IP_MAX_FAILED_ATTEMPTS', 20, 1, 100000),
    /**
     * 登录尝试记录的保留期，单位小时。超期记录在写入时顺带清理。
     *
     * 保留期必须显著长于 IP 窗口，否则窗口还没滑完记录就被删了，计数会偏小，
     * 限速会提前失效。两者之间存在约束关系，调参时要一起看。
     */
    attemptRetentionHours: readInt('LOGIN_ATTEMPT_RETENTION_HOURS', 168, 1, 8760),
  },
  /**
   * 运营数据采集入口的共享密钥。
   *
   * 采集器是计划任务，没有用户会话，所以这条接口不能走登录态。鉴权拆成两层：
   * 来源必须是回环（复用 `launch/loopback.ts`），并且请求头里带对这把密钥。
   * 回环校验只是纵深防御 —— 桌面壳反代之后，所有请求的远端地址都可能是回环。
   *
   * **不设默认值，也不在启动时强制要求。** 没配的时候采集入口返回 503 并说明
   * 原因，而不是让整个 API 起不来：读接口与页面不依赖它，为了一个离线功能
   * 挡住所有人不合理。
   *
   * 用 getter 的理由与 `jwt.secret` 相同：本文件在模块加载期求值，直接读会让
   * 每个 import 了 env 的脚本都被迫提供这一项（seed、create-owner 都会撞上）。
   */
  ops: {
    get ingestToken(): string | null {
      const value = process.env.OPS_INGEST_TOKEN
      return value === undefined || value.trim() === '' ? null : value
    },
  },

  /**
   * 案例库的归属账号（用户名）。
   *
   * 案例库是全账号共用一份的素材库，正常情况下归属「持 owner 角色、最早创建的账号」，
   * 由 `case-library/scope.ts` 解析。这个配置项用来**改指到别的账号**，唯一真实的
   * 使用者是集成测试：测试必须有一个只放测试数据的一次性账号，否则它会往真实素材库里
   * 塞文件夹、还会挪动 `cabinet-1` 这类真实图片的归属。
   *
   * 用 getter 的理由与 `jwt.secret`、上面那个 token 相同：本文件在模块加载期求值，
   * 直接读会让每个 import 了 env 的脚本都被迫提供这一项。而且测试是在跑起来之后才建
   * 那个账号、再设这个变量，求值时机必须晚于模块加载。
   */
  caseLibrary: {
    get ownerUsername(): string | null {
      const value = process.env.FANHE_CASE_LIBRARY_ACCOUNT
      return value === undefined || value.trim() === '' ? null : value.trim()
    },
  },
} as const
