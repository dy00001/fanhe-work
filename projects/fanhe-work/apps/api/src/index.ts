import { buildApp } from './app.js'
import { env } from './config/env.js'

const app = buildApp()

/**
 * 启动前的配置自检。
 *
 * ## 为什么需要显式写这一段
 *
 * `config/env.ts` 里的 `JWT_SECRET` 是**惰性求值**的（getter）—— 只有真的去读
 * `env.jwt.secret` 才会检查它。这是为了让只需要数据库的脚本（`db:seed`）不必
 * 持有一把签名密钥，代价是「import 这个模块就会校验」这件事不再成立。
 *
 * 而**「配置缺失就在服务对外之前失败」这条不能丢**。env.ts 的原注释说明了理由：
 * 连接串写错的后果是连到别的库上做迁移，那比启动失败难发现得多。同样的道理适用
 * 于签名密钥 —— 短于 32 字节的密钥会让 HS256 变得可暴力搜索，而那种故障要等到
 * 有人伪造登录才暴露。
 *
 * 所以这里显式读一次：读它就等于跑一遍 `requireSecret` 的校验（长度按字节算，
 * 密钥里有多字节字符时按字符数判断会放过一个远短于要求的密钥）。
 *
 * **代价是这个自检只能覆盖被读到的字段。** 新增「启动时必须存在」的配置时要一并
 * 加到这里 —— 惰性化之后，漏加的后果是那个字段直到真正被用到才报错，而那时服务
 * 已经对外了。这是惰性化换来解耦的代价，此处是它的登记处。
 */
function assertRequiredEnv(): void {
  // 读一次即校验。赋值给变量是为了让「读」这件事在代码里显式可见，而不是写成
  // 一句看起来像无意义表达式的 `env.jwt.secret`。
  const secret = env.jwt.secret
  if (secret.length === 0) {
    // 走不到这里 —— requireSecret 缺失时会抛。这条只是防止将来有人把 requireSecret
    // 改成「返回空串」而静默放过。
    throw new Error('JWT_SECRET 校验未生效：读到了空值。')
  }
}

try {
  assertRequiredEnv()
  await app.listen({ port: env.port, host: env.host })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
