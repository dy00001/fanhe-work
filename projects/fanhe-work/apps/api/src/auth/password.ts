import {
  Algorithm,
  Version,
  hash as argon2Hash,
  parseOptions,
  verify as argon2Verify,
} from '@node-rs/argon2'

import { env } from '../config/env.js'

/**
 * 密码哈希。
 *
 * 算法固定为 Argon2id。选它而不是 bcrypt 的理由不是「更新」，而是 bcrypt 有
 * 一个会静默出错的上限：它只取输入的前 72 字节，多出来的部分被直接丢掉。
 * 于是两个前 72 字节相同、后面不同的密码会被判为同一个，而且不会报任何错。
 * Argon2id 同时抵抗 GPU 并行与旁路攻击，是当前密码哈希竞赛的胜出者。
 *
 * 参数从环境变量读，默认取 OWASP 对 Argon2id 的最低推荐档，说明见 config/env.ts。
 * 改参数不会让已有密码失效 —— PHC 编码的哈希串自带生成时的参数，校验时按串里的
 * 参数走，只有新密码才用新参数。needsRehash 用来判断哪些旧哈希值得顺手重算。
 *
 * 依赖选 @node-rs/argon2 而非官方 argon2 包，是被环境约束决定的：本机没有 MSVC
 * 编译器，而官方包靠 postinstall 脚本拉预编译二进制，工作空间的 pnpm 配置里
 * onlyBuiltDependencies 为空，脚本被禁，就只能退回源码编译然后必然失败。
 * @node-rs/argon2 的二进制由 optionalDependencies 按平台分发，包内不含任何
 * 安装脚本，因此不受该限制；换机器只要同为 win32-x64 就不需要重新编译。
 */

/**
 * Argon2 规范要求内存至少是并行度的 8 倍（m >= 8p）。低于这个值原生层会抛错，
 * 但那条报错只说参数非法，不说是哪一项配错了。在模块加载期就拦住，报错能直接
 * 指向两个环境变量的名字。
 */
if (env.argon2.memoryCost < 8 * env.argon2.parallelism) {
  throw new Error(
    `Argon2 要求 ARGON2_MEMORY_KIB 至少是 ARGON2_PARALLELISM 的 8 倍，` +
      `当前为 ${env.argon2.memoryCost} KiB 与 ${env.argon2.parallelism}。`,
  )
}

/** 当前配置。算法显式写出，不依赖库的默认值 —— 默认值会随版本变。 */
const HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: env.argon2.memoryCost,
  timeCost: env.argon2.timeCost,
  parallelism: env.argon2.parallelism,
} as const

/**
 * 计算密码哈希，返回 PHC 编码的字符串。
 *
 * 盐由库内部生成，不需要调用方传，也不该传：让调用方提供盐就等于给了用固定盐
 * 的机会，而固定盐会让相同的密码产生相同的哈希，一次拖库就能看出哪些账号同密码。
 *
 * 密码本身的长度与复杂度不在这里校验。那是密码策略，属于业务规则，放在输入
 * 校验层；这里只负责「给定一个字符串，返回它的哈希」。
 */
export async function hashPassword(plain: string): Promise<string> {
  return argon2Hash(plain, HASH_OPTIONS)
}

/**
 * 校验密码是否与哈希匹配。
 *
 * 不抛异常，一切失败都返回 false。哈希串格式非法时原生层会抛错，调用方一旦漏接，
 * 500 与 401 的差别本身就成了一个可探测的信号 —— 等于告诉对方这个账号的哈希串
 * 坏了。这里统一收口成 false。
 *
 * 不传 options：PHC 串里已经带了生成时的参数，库会按串里的参数校验，这正是
 * 「改配置不会让已有密码失效」能成立的原因。
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, plain)
  } catch {
    return false
  }
}

/**
 * 判断一个已有哈希是否该按当前配置重新计算。
 *
 * 参数解析交给库的 parseOptions，不自己拆 PHC 串。这里有一处容易踩错：库的
 * Version 枚举是 V0x10 = 0、V0x13 = 1，而 PHC 串里写的是 v=19，两者不是同一个
 * 数。按字面量 19 去比对，会让每一个哈希都被判为需要重算。
 *
 * 只在参数确实变弱时返回 true：数值项用「小于当前配置」而不是「不等于」，
 * 因为把配置调低不该反过来让全库重算一遍。
 *
 * 解析失败返回 false。调用点在登录成功之后，那里已经证明过这个哈希是有效的；
 * 而且垃圾数据不该触发重算。
 *
 * 调用方不必因为 true 就立刻重算并写库 —— 等密码校验通过时顺手重算一次即可，
 * 这样不会给登录路径引入额外分支，也不需要一次全表更新。
 */
export function needsRehash(hash: string): boolean {
  let parsed: ReturnType<typeof parseOptions>
  try {
    parsed = parseOptions(hash)
  } catch {
    return false
  }

  return (
    parsed.algorithm !== Algorithm.Argon2id ||
    parsed.version !== Version.V0x13 ||
    parsed.memoryCost < env.argon2.memoryCost ||
    parsed.timeCost < env.argon2.timeCost ||
    parsed.parallelism < env.argon2.parallelism
  )
}
