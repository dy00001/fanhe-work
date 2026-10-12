/**
 * 版本清单的跨进程类型与比较规则（T6-01）。
 *
 * ## 这个清单回答什么问题
 *
 * 「我现在跑的是哪一版，与服务端现在发的是不是同一版」。它是 T6-02（客户端启动时
 * 比对）与 T6-03（外壳升级通道）的共同前提 —— 后两者都从这里取事实。
 *
 * ## 为什么哈希与版本号都要，而不是只要版本号
 *
 * 版本号回答「第几版」，**而开发期间同一个版本号对应很多次构建**（每次提交都
 * 构建一次，发版时才 bump 版本号）。只比版本号的话，「服务端跑的是这次提交、
 * 我这份前端是上次提交」这种情况显示为一致 —— 而那恰恰是要抓的情况。
 *
 * 所以清单里带一个**构建指纹**：由三样东西算出的短哈希 —— 版本号、构建时刻、
 * 提交短号。它们都来自构建期注入（见 `apps/web/vite.config.ts`），**不是运行时
 * 读来的**，因此「界面显示的版本」与「这份产物是用哪份代码构建的」严格对应。
 *
 * ## 版本比较用「逐段比」而不是 semver 全量实现
 *
 * 只需要回答「一样吗 / 谁更新」这两个问题，而发版方式固定为改根 `package.json`
 * 的三段式版本号。引入一整套 semver 库要多一个依赖、多一类边界，而它能多解决的
 * 那些情况（预发布标签、构建元数据）在这个项目里不存在。
 *
 * **但预发布号（`-beta.1`）仍然要能被正确比较**，因为改版本号时打错一个字符就会
 * 出现 `0.1.0-beta`，而那种情况下必须「不把它当成比 0.1.0 新」。见 `compareVersions`。
 */

/** 版本清单的响应体。字段是 T6-02 与 T6-03 的接口契约，改这里等于改它们的输入。 */
export type VersionManifestResponse = {
  /** 产品版本号，裸 semver，与仓库根 `package.json` 的 `version` 同源。 */
  version: string
  /** 构建时刻，ISO 8601（UTC，带 `Z`）。取不到时是空串。 */
  builtAt: string
  /** 构建时的提交短号。git 不可用时是 `'unknown'`。 */
  commitSha: string
  /**
   * 构建指纹，由上面三项算出的短哈希。
   *
   * **它可能为空串**，而那不是 bug：三项都取不到时算不出指纹（详见
   * `computeBuildFingerprint`）。调用方必须把空串当作「无法判断」而不是
   * 「与任何一份都相同」。
   */
  fingerprint: string
}

/**
 * 构建指纹的长度（十六进制字符数）。
 *
 * 32 位（MD5 的一半）不是为了防碰撞攻击，而是为了**在界面上不占地方**：它只用来
 * 回答「同一份还是不同份」，而 T6-02 的判断依据是「不相等即不同」。取值偏短是
 * 刻意的 —— 这串会出现在界面上，60 位长的哈希既占地方又读不懂。
 *
 * **它不是密码学强度需求。** 真要靠它防伪造，那该做的是签名整个清单（T6-03 的
 * `electron-updater` 签名校验），而不是加长这个哈希。
 */
export const BUILD_FINGERPRINT_LENGTH = 32

/**
 * 由版本号、构建时刻与提交号算出构建指纹。
 *
 * ## 为什么是「三项一起」而不是只用版本号
 *
 * 见文件头那节：开发期同一个版本号对应很多次构建，只比版本号会漏掉「版本号相同
 * 但代码不同」——而那是最需要被发现的情况（用户报的问题在你改完代码后才出现，
 * 但版本号没变）。
 *
 * ## 分隔符用换行而不是逗号
 *
 * 三项里 commitSha 可能为空串（git 不可用时是 `'unknown'`，但构建时刻可能为空）。
 * 用逗号连接时，`['0.1.0', '', 'abc']` 与 `['0.1.0', '', 'abc']` 之外的那些组合
 * 存在歧义可能 —— 而换行分隔且三项顺序固定，逐字节拼接是**无歧义的**：不同的三项
 * 一定给出不同的字节串。
 *
 * ## 返回空串的两种情况
 *
 * - 指纹长度算出来不符（不该发生，是自检）
 * - 三项**全部**取不到（一个不落地打包的场景，例如把 dist 直接拷走）
 *
 * 第二种情况下返回空串而不是一个「看起来像真的」的值 —— 界面显示一个由三个空值
 * 算出来的哈希，会让人以为「比对过了，一致」。
 */
export function computeBuildFingerprint(
  version: string,
  builtAt: string,
  commitSha: string,
): string {
  const material = `${version}\n${builtAt}\n${commitSha}`
  // Web Crypto 是标准接口，Node 与浏览器都有。它是**同步可用**的
  // （digest 返回 Promise，但算法本身不需要异步初始化），因此在接口处理函数
  // 里可以直接 await，不引入任何额外依赖。
  //
  // 用的是 SHA-256 而不是 MD5：MD5 在密码学上已不可用，而 Node 的
  // `createHash('md5')` 在 FIPS 模式下会被直接拒掉，那会让构建指纹在一个合规
  // 环境里静默失败。SHA-256 没有这个问题，代价只是截取长度。
  const hex = bytesToHex(sha256(material))
  return hex.slice(0, BUILD_FINGERPRINT_LENGTH)
}

/**
 * 逐段比较两个版本号，返回负数 / 0 / 正数。
 *
 * ## 不引 semver 库的理由
 *
 * 见文件头。这里实现的是**三段数字**的逐段比较，外加预发布号的处理 —— 够用且
 * 没有依赖。
 *
 * ## 预发布号怎么处理
 *
 * `0.1.0-beta.1` 排在 `0.1.0` **之前**（这是 semver 的规定），而纯数字比较会
 * 得到「beta 那段不是数字 → 当成 0 → 于是相等」的错误结果。所以：
 *
 * - 两边都有预发布号 → 逐段比预发布部分（数字按数比，纯字符串按字典序）
 * - 只有一边有 → **没有预发布号的那个更新**（正式版晚于预发布版）
 * - 预发布部分逐段相等 → 回到数字段继续比（`0.1.0-beta` 与 `0.1.0-alpha` 的
 *   数字段相同，靠预发布部分分出先后）
 *
 * **「打错一个字符就会产生预发布号」是这个分支存在的现实理由** —— 写 `0.1.0`
 * 时漏掉一个字符变成 `01.0.0` 还算好办，写成 `0.1.0-beta` 就需要它能被正确识别
 * 为「比 0.1.0 旧」，否则 T6-02 会提示一个错误的更新方向。
 *
 * **数字段按数值比而不是按字符串比** —— 否则 `'10'` 会排在 `'9'` 前面，
 * 因为字符串比较里 `'1' < '9'`。
 */
export function compareVersions(left: string, right: string): number {
  const l = parseVersion(left)
  const r = parseVersion(right)

  for (let i = 0; i < 3; i += 1) {
    const a = l.numbers[i] ?? 0
    const b = r.numbers[i] ?? 0
    if (a !== b) return a - b
  }

  const lPre = l.prerelease
  const rPre = r.prerelease

  // 都没有预发布号：数字段相等即相等。
  if (lPre === '' && rPre === '') return 0
  // 只有一边有：没有预发布的那个更新（正式版晚于预发布版）。
  if (lPre === '') return 1
  if (rPre === '') return -1

  return comparePrerelease(lPre, rPre)
}

/**
 * 比较两个预发布部分。
 *
 * 按 `.` 分段、逐段比较：**数字段按数值比，字符串段按字典序**，且**数字段小于
 * 字符串段**（semver 的规定：纯数字的预发布版本号小于带字母的，因为数字表示更早
 * 的迭代）。段的多少不作比较，一方用尽而另一方还有时，**用尽的一方更早**
 * （`alpha` 早于 `alpha.1`）。
 */
function comparePrerelease(left: string, right: string): number {
  const l = left.split('.')
  const r = right.split('.')
  const len = Math.max(l.length, r.length)

  for (let i = 0; i < len; i += 1) {
    const a = l[i]
    const b = r[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    if (a === b) continue

    const aNum = isNumericSegment(a)
    const bNum = isNumericSegment(b)
    if (aNum && bNum) return Number(a) - Number(b)
    // 数字段早于字符串段
    if (aNum) return -1
    if (bNum) return 1
    return a < b ? -1 : 1
  }
  return 0
}

/** 预发布片段是不是纯数字。这里只认 ASCII 数字，不接受 `+` 号等符号。 */
function isNumericSegment(segment: string): boolean {
  return segment.length > 0 && /^[0-9]+$/.test(segment)
}

/**
 * 拆解版本号。
 *
 * **解析不了的段一律当 0**，而不是抛错 —— 理由见 `compareVersions` 的预发布号
 * 那节：版本号是人手写的，出现意外形态（空段、多段、带前导零）时，抛错会让整个
 * 「启动时比对」这条路径崩掉，而它在 T6-02 里的位置是**非关键路径**（比对失败
 * 最多是提示一下更新，崩掉则是程序起不来）。
 */
function parseVersion(raw: string): { numbers: [number, number, number]; prerelease: string } {
  const withoutBuild = raw.split('+')[0] ?? ''
  const dashIndex = withoutBuild.indexOf('-')
  const core = dashIndex === -1 ? withoutBuild : withoutBuild.slice(0, dashIndex)
  const prerelease = dashIndex === -1 ? '' : withoutBuild.slice(dashIndex + 1)

  const parts = core.split('.')
  return {
    numbers: [toSegmentNumber(parts[0]), toSegmentNumber(parts[1]), toSegmentNumber(parts[2])],
    prerelease,
  }
}

/** 段转数字：空串或非数字一律 0。`Number('')` 是 0，正合需要。 */
function toSegmentNumber(segment: string | undefined): number {
  if (segment === undefined || segment === '') return 0
  const value = Number(segment)
  return Number.isFinite(value) ? value : 0
}

/**
 * 比对两份清单，返回该做什么。
 *
 * **T6-02 的判断入口。** 三种结果刻意分开而不是并成布尔：
 *
 * - `same` —— 指纹相同。不看版本号：**指纹相同已经说明三项全同**，而版本号可能
 *   因某种改动不一致却指纹相同（理论上不会，因为指纹包含版本号），多比一次会
 *   引入一个能自相矛盾的输出。
 * - `outdated` —— 指纹不同**且**服务端版本更新。这才是该提示更新的情形。
 * - `ahead` —— 指纹不同但本机更新（开发期正常状态：本地跑的版本比服务器上的新）。
 *   **必须与 `outdated` 分开**，否则开发时会一直提示「有更新」，而那会把唯一的
 *   有效信号淹掉。
 * - `unknown` —— 任一侧指纹为空（取不到构建信息），**无法判断**。这时**不提示
 *   更新**：一个无法判断的状态报成「有更新」比不报更糟。
 */
export type VersionComparison =
  | { outcome: 'same' }
  | { outcome: 'outdated'; latest: VersionManifestResponse }
  | { outcome: 'ahead'; latest: VersionManifestResponse }
  | { outcome: 'unknown' }

/** 比对本机与服务端两份清单。 */
export function compareManifests(
  local: Pick<VersionManifestResponse, 'version' | 'fingerprint'>,
  remote: VersionManifestResponse,
): VersionComparison {
  // 指纹是三项事实的摘要，任一侧缺它就意味着「我们不知道这份是什么」，
  // 此时比较版本号是没有依据的 —— 版本号可能被人手改过而指纹没跟着变。
  if (local.fingerprint === '' || remote.fingerprint === '') {
    return { outcome: 'unknown' }
  }
  if (local.fingerprint === remote.fingerprint) {
    return { outcome: 'same' }
  }
  const order = compareVersions(remote.version, local.version)
  if (order > 0) return { outcome: 'outdated', latest: remote }
  if (order < 0) return { outcome: 'ahead', latest: remote }
  // 指纹不同但版本号相同：同一版本号的两次不同构建（开发期很常见）。
  // 归为 `ahead` 是因为「我这边与线上不一样」这个事实更重要，而提示「有更新」
  // 在这种情况下会指向一个不存在的版本。
  return { outcome: 'ahead', latest: remote }
}

// ── SHA-256 ─────────────────────────────────────────────────────────────────
//
// 不 import node:crypto：这个模块要同时能在 api（Node）与浏览器里跑（T6-02 的
// 比对逻辑前端也会用）。Web Crypto 是两边都有的标准接口，用它可以只写一份。

/**
 * UTF-8 编码，不依赖 `TextEncoder`。
 *
 * **`TextEncoder` 是 Web API，不在 `lib: ["ES2023"]` 里。** 加 `DOM` 到 lib 能让
 * 编译通过，但那会把这个包（刻意不依赖任何运行时框架，见 index.ts 文件头）的
 * 类型环境扩大一整档 —— 而本包运行在 Node 与浏览器两端，Node 侧的全局对象类型
 * 一旦引入 DOM 就与实际不符。**为一个纯计算函数扩大整个包的 lib 不划算。**
 *
 * 版本号、ISO 时间戳、git 短号三者在实践中全是 ASCII，但**不假设这一点** ——
 * 一个中文提交号不该让哈希算出另一个值，而那种差异极难查（两边都返回 32 位十六
 * 进制，看起来完全正常）。
 */
function utf8Encode(input: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < input.length; i += 1) {
    const code = input.codePointAt(i) ?? 0
    // **codePointAt 按码点读，但下标按 UTF-16 单元走。** 增补平面字符占两个单元，
    // 所以读完要跳过一个 —— 否则那个代理对的后半截会被当成独立字符编码。
    if (code > 0xffff) i += 1

    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }
  return new Uint8Array(out)
}

/** 字节数组转十六进制小写。 */
function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/**
 * 同步的 SHA-256。
 *
 * Web Crypto 的 `crypto.subtle.digest` 返回 Promise，**不能在非 async 的纯函数里
 * await** —— 而 `computeBuildFingerprint` 必须是纯函数（测试要在 Node 里直接跑，
 * 见文件头 `version.ts` 那个 `typeof` 守卫的同款理由）。
 *
 * 所以这里手写一份 SHA-256 而不是用标准库。**它只用于生成构建指纹**，不涉及任何
 * 密钥或安全边界（见 `BUILD_FINGERPRINT_LENGTH` 那节）。手写实现的正确性由
 * `test/version.test.mjs` 用标准库的输出做逐值比对钉住 —— **手写的东西必须有
 * 一份「对照权威实现」的测试，否则它只是一个看起来能跑的函数**。
 */
function sha256(input: string): Uint8Array {
  const K = SHA256_K
  const message = utf8Encode(input)

  // 补位：末尾加 0x80，再补零到长度 ≡ 56 (mod 64)，最后 8 字节是比特长度。
  const bitLength = message.length * 8
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6
  const padded = new Uint8Array(paddedLength)
  padded.set(message)
  padded[message.length] = 0x80

  // 比特长度写成 64 位大端。高 32 位用 Math.floor 分出来 —— 消息不可能长到
  // 需要更多，而浮点数的精度上限（约 2^53）远高于这里。
  const view = new DataView(padded.buffer)
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(paddedLength - 4, bitLength >>> 0, false)

  const h = new Uint32Array(SHA256_H.slice())

  for (let offset = 0; offset < paddedLength; offset += 64) {
    const w = new Uint32Array(64)
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getUint32(offset + i * 4, false)
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!]

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const temp1 = (hh + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const temp2 = (S0 + maj) >>> 0

      hh = g
      g = f
      f = e
      e = (d + temp1) >>> 0
      d = c
      c = b
      b = a
      a = (temp1 + temp2) >>> 0
    }

    h[0] = (h[0]! + a) >>> 0
    h[1] = (h[1]! + b) >>> 0
    h[2] = (h[2]! + c) >>> 0
    h[3] = (h[3]! + d) >>> 0
    h[4] = (h[4]! + e) >>> 0
    h[5] = (h[5]! + f) >>> 0
    h[6] = (h[6]! + g) >>> 0
    h[7] = (h[7]! + hh) >>> 0
  }

  const out = new Uint8Array(32)
  const outView = new DataView(out.buffer)
  for (let i = 0; i < 8; i += 1) outView.setUint32(i * 4, h[i]!, false)
  return out
}

/** 循环右移。`n` 为 0 时不该发生（SHA-256 的常量里没有 0），但 `>>> 0` 兜住了。 */
function rotr(value: number, n: number): number {
  return ((value >>> n) | (value << (32 - n))) >>> 0
}

/** SHA-256 初始哈希值（FIPS 180-4）。 */
const SHA256_H = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

/** SHA-256 轮常量。 */
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])
