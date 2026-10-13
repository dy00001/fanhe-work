/**
 * 签名身份档案（signing identity record）的解析与比对（T6-03d）。
 *
 * ## 它解决的问题
 *
 * 签名身份（`CN=Fanhe Work` 那张自签证书）**只存在于本机证书库里**，而证书库
 * 随机器不随盘、也不进版本控制（`DEVELOPMENT-PLAN.md` 6.3 第 6 条）。这条设计是
 * 对的 —— 私钥不该跟 U 盘走 —— 但它留下一个后果：
 *
 *   **一旦证书没了，没有任何东西记得「当初签的是哪一张」。**
 *
 * 2026-10-13 实测到了这个后果：`Cert:\CurrentUser\My` 被清空，`dist:dir` 直接报
 * `Cannot find certificate CN=Fanhe Work`。而当时的补救动作（重跑 `signing:cert`）
 * 会生成一张**新证书** —— 主体名相同、指纹不同 —— **已经装着 v0.1.0 / v0.1.1 的
 * 机器会永久收不到更新**。这个坑没有任何提示，因为旧实现里根本没有「之前用的是什么
 * 身份」这个概念。
 *
 * ## 「换了证书为什么致命」—— 说准，否则会被当成形式主义
 *
 * 直觉给的答案是「因为 `publisherName` 变了」，**这是错的**，而且是查过源码的：
 * `publisherName` 由证书的 Subject DN 推出来 ——
 * `app-builder-lib/out/publish/PublishManager.js:202` 调
 * `windowsSignToolManager.js` 的 `computePublisherName`，实现是
 * `publisherName || certInfo.bloodyMicrosoftSubjectDn`（那个 `CN=ms` 回落只走
 * AppX 无证书分支，与本项目无关）。同 CN 就同字符串，实测产物里写的就是
 * `publisherName: [Fanhe Work]`。**换一张同 CN 的证书不会让它变样。**
 *
 * 真正断掉的是它**上面那一层**：
 *
 *   electron-updater 只在 `data.Status === 0`（Valid）时才进入发布者名比对
 *   （`electron-updater/out/windowsExecutableCodeSignatureVerifier.js:56`）。
 *   而 `Status` 要求证书链能走到一张**本机受信任**的根。
 *
 * 自签证书的根是**逐机**导入的（`create-signing-cert.ps1` 第 3 步只装当前用户），
 * 所以：**换证书 = 换信任根 = 已装机器上没有它 → `Status` 变 `UnknownError`(1)
 * → 整段比对被跳过 → 更新被拒**。与 T6-03b 在本机撞到的是同一个闸，只是换机后重现。
 *
 * 结论（已装机器收不到更新）不变，但**原因不同**：要补的是**信任根**，不是
 * `publisherName`。按错的因果去修，会去改一个本来就没问题的配置项。
 *
 * 所以这里引入一份**身份档案**：由 `create-signing-cert.ps1` 在每次创建 / 复用 /
 * 轮换证书时写一份 JSON，记下当前身份与历史身份。有了它才能：
 *
 *   1. 换机器 / 证书丢失时，知道**该找回哪一张**（而不是只能新建一张）；
 *   2. 打包前**比对**产物实际用的身份与档案是否一致，把「静默换身份」变成断言；
 *   3. 需要轮换时，明确知道这会让哪些已发布版本收不到更新。
 *
 * ## 为什么是 .mjs 而不是 .ts，也不放在 src/
 *
 * `src/` 是 tsc 的输入、`dist/**` 又整目录进 asar（见 `electron-builder.yml` 的
 * `files`）—— 放进去等于把构建期工具打进用户装的包里。而本模块的两个消费者
 * （`verify-pack.mjs` 与 `test/*.test.mjs`）都能直接吃 ESM，所以放 scripts/ 下
 * 用 `.mjs` 最省事，也顺手避开了「改了 TS 要先 tsc」这一步。
 *
 * ## 这一层的边界
 *
 * 这里**只做纯函数**：解析文本、校验形状、比对身份、拼一句话。不读文件、不碰
 * 证书库、不起子进程。读文件与生成档案在 `create-signing-cert.ps1`（写）与
 * `verify-pack.mjs`（读）里，而「怎么把一份坏档案说清楚」留在这一层，是为了让
 * 它可被单测直接喂坏输入 —— 见 `test/signing-identity.test.mjs`。
 */

/** 档案格式的版本。**加字段不改它，改字段含义才改它**（改了要让老档案能被识别为老）。 */
export const SIGNING_IDENTITY_SCHEMA_VERSION = 1

/**
 * 工具链版本。与 schema 版本是两件事：
 *
 *   schemaVersion  说的是「这份文件长什么样」；
 *   toolingVersion 说的是「是哪一版脚本写的它」。
 *
 * v1 = 只管建证书与信任根（T6-03c）；
 * v2 = 引入身份档案、导入 / 导出、轮换闸（T6-03d）。
 *
 * 记它的用途只有一个：拿一份档案时能判断「写它的那版脚本知不知道轮换的后果」。
 */
export const SIGNING_TOOLING_VERSION = 2

/** 默认签名主体。与 `electron-builder.yml` 的 `certificateSubjectName` 是同一个值。 */
export const DEFAULT_SUBJECT = 'CN=Fanhe Work'

/** 档案文件名。默认落在证书库之外的用户目录（见 `defaultIdentityPath`）。 */
export const DEFAULT_IDENTITY_FILE_NAME = 'signing-identity.json'

/** 身份档案默认所在目录（相对 `%LOCALAPPDATA%`）。刻意**不在工作区内**。 */
export const DEFAULT_IDENTITY_DIR_SEGMENTS = ['FanheWork', 'signing']

/**
 * 指纹形状：40 个十六进制字符（SHA-1，证书库给的就是这个长度）。
 *
 * 大小写不统一（`Get-ChildItem` 给大写、某些工具给小写），所以比对前一律归一。
 * 允许中间有空格：`certutil` 的输出习惯每两个字符插一个空格。
 */
const THUMBPRINT_RE = /^[0-9a-f]{40}$/i

/** 把指纹归一成大写、去掉所有空白；非法输入返回 `null`（而不是一个看着像指纹的串）。 */
export function normalizeThumbprint(value) {
  if (typeof value !== 'string') return null
  const compact = value.replace(/\s+/g, '')
  if (!THUMBPRINT_RE.test(compact)) return null
  return compact.toUpperCase()
}

/** 形状校验的薄封装。`null` 与 `''` 都是「不是指纹」。 */
export function isThumbprint(value) {
  return normalizeThumbprint(value) !== null
}

/**
 * 两个指纹是不是同一个（归一后比）。
 *
 * 任一为空一律判 `false`：**「都读不到」不等于「一样」**。这一条是有意的 ——
 * 在打包验收里，把两个空值判成相等会让「没读到指纹」变成一条通过的断言。
 */
export function sameThumbprint(a, b) {
  const left = normalizeThumbprint(a)
  const right = normalizeThumbprint(b)
  if (left === null || right === null) return false
  return left === right
}

/**
 * 从 DN 里取 CN 的简单名：`CN=Fanhe Work` → `Fanhe Work`。
 *
 * 不处理 RFC 4514 的转义逗号（`CN=a\,b`）—— 本项目的主体是固定 ASCII 字面量，
 * 为一个不会出现的输入写一个转义解析器只会让这段更难读。取不到时返回空串，
 * 由调用方决定是报错还是降级。
 */
export function simpleNameFromSubject(subject) {
  if (typeof subject !== 'string') return ''
  for (const part of subject.split(',')) {
    const m = /^\s*CN\s*=\s*(.+?)\s*$/i.exec(part)
    if (m !== null) return m[1]
  }
  return ''
}

/**
 * 默认档案路径。`LOCALAPPDATA` 缺失时返回 `null`（由调用方决定怎么报）。
 *
 * 为什么落在 `%LOCALAPPDATA%` 而不是证书库里：证书库只能存证书，存不下「历史」
 * 与「哪一版脚本写的」。放这里与证书同机、同样不随盘走。
 */
export function defaultIdentityPath(env = process.env) {
  const base = env.LOCALAPPDATA ?? env.LocalAppData
  if (typeof base !== 'string' || base === '') return null
  return [base, ...DEFAULT_IDENTITY_DIR_SEGMENTS, DEFAULT_IDENTITY_FILE_NAME].join('\\')
}

/** 身份档案里的历史项。 */
function parseHistoryEntry(raw, index) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `history[${index}] 不是对象` }
  }
  const thumbprint = normalizeThumbprint(raw.thumbprint)
  if (thumbprint === null) {
    return { ok: false, reason: `history[${index}].thumbprint 不是 40 位十六进制指纹` }
  }
  if (typeof raw.subject !== 'string' || raw.subject === '') {
    return { ok: false, reason: `history[${index}].subject 为空` }
  }
  return {
    ok: true,
    value: {
      thumbprint,
      subject: raw.subject,
      replacedAt: typeof raw.replacedAt === 'string' ? raw.replacedAt : '',
      reason: typeof raw.reason === 'string' ? raw.reason : '',
    },
  }
}

/**
 * 解析一份身份档案文本。
 *
 * 返回 `{ ok: true, identity }` 或 `{ ok: false, reason }` —— **不抛异常**。
 * 理由是调用方的处理方式不同：`verify-pack.mjs` 要把「档案坏了」报成一条 FAIL 并
 * 继续跑完剩下的断言；而一个抛出去的异常会让整个验收停在半路、后面的断言一条都不跑，
 * 看起来像「脚本崩了」而不是「档案坏了」。
 *
 * 前导 BOM 会被剥掉：PS 5.1 的 `Set-Content -Encoding UTF8` 会写 BOM，而
 * `JSON.parse('\uFEFF{...}')` 直接抛。这一条是踩出来的，不是防御性编程。
 *
 * 校验只针对**本模块与验收脚本真正会用到的字段**（主体、指纹、版本、时间），
 * 其余字段（密钥长度之类）缺失时降级成空串而不是判错 —— 加字段不该让旧档案失效。
 */
export function parseSigningIdentity(text) {
  if (typeof text !== 'string') return { ok: false, reason: '档案内容不是文本' }
  const cleaned = text.replace(/^\uFEFF/, '').trim()
  if (cleaned === '') return { ok: false, reason: '档案是空的' }

  let raw
  try {
    raw = JSON.parse(cleaned)
  } catch (error) {
    return { ok: false, reason: `不是合法 JSON：${error instanceof Error ? error.message : ''}` }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: '档案顶层必须是对象' }
  }

  if (raw.schemaVersion !== SIGNING_IDENTITY_SCHEMA_VERSION) {
    return {
      ok: false,
      reason:
        `schemaVersion 是 ${JSON.stringify(raw.schemaVersion)}，` +
        `本工具只认 ${SIGNING_IDENTITY_SCHEMA_VERSION} —— ` +
        '要么档案来自更新的工具链（升级本工具），要么它根本不是身份档案',
    }
  }

  if (!Number.isInteger(raw.toolingVersion) || raw.toolingVersion < 1) {
    return {
      ok: false,
      reason: `toolingVersion 必须是 >= 1 的整数，得到 ${JSON.stringify(raw.toolingVersion)}`,
    }
  }

  if (typeof raw.subject !== 'string' || raw.subject === '') {
    return { ok: false, reason: 'subject 为空' }
  }

  const thumbprint = normalizeThumbprint(raw.thumbprint)
  if (thumbprint === null) {
    return {
      ok: false,
      reason: `thumbprint 不是 40 位十六进制指纹：${JSON.stringify(raw.thumbprint)}`,
    }
  }

  if (typeof raw.notAfter !== 'string' || raw.notAfter === '') {
    return { ok: false, reason: 'notAfter 为空 —— 没有到期时间就无法判断该不该轮换' }
  }

  if (!Array.isArray(raw.history)) {
    return { ok: false, reason: 'history 必须是数组（没有历史就写 []）' }
  }

  const history = []
  for (let i = 0; i < raw.history.length; i += 1) {
    const entry = parseHistoryEntry(raw.history[i], i)
    if (!entry.ok) return { ok: false, reason: entry.reason }
    history.push(entry.value)
  }

  // simpleName 允许缺 —— 从 subject 推得出来，没必要让一份手写的档案因为漏了它而失效。
  const simpleName =
    typeof raw.simpleName === 'string' && raw.simpleName !== ''
      ? raw.simpleName
      : simpleNameFromSubject(raw.subject)

  return {
    ok: true,
    identity: {
      schemaVersion: SIGNING_IDENTITY_SCHEMA_VERSION,
      toolingVersion: raw.toolingVersion,
      subject: raw.subject,
      simpleName,
      thumbprint,
      notBefore: typeof raw.notBefore === 'string' ? raw.notBefore : '',
      notAfter: raw.notAfter,
      keyAlgorithm: typeof raw.keyAlgorithm === 'string' ? raw.keyAlgorithm : '',
      keyLength: Number.isInteger(raw.keyLength) ? raw.keyLength : 0,
      hashAlgorithm: typeof raw.hashAlgorithm === 'string' ? raw.hashAlgorithm : '',
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      history,
    },
  }
}

/**
 * 档案与「当前证书」是不是同一个身份。
 *
 * 比对**主体 + 指纹**两项：只比主体会漏掉「同一主题名下换了一张证书」这个
 * 正是本项目踩过的坑（主体一样、指纹不同，更新校验照样失败）。
 */
export function sameIdentity(identity, current) {
  if (identity === null || identity === undefined) return false
  if (typeof current !== 'object' || current === null) return false
  if (identity.subject !== current.subject) return false
  return sameThumbprint(identity.thumbprint, current.thumbprint)
}

/** 一句话描述一个身份，用于日志与报告。 */
export function describeIdentity(identity) {
  if (identity === null || identity === undefined) return '(无身份档案)'
  const parts = [`${identity.subject}`, `thumbprint=${identity.thumbprint}`]
  if (identity.notAfter !== '') parts.push(`notAfter=${identity.notAfter}`)
  parts.push(`tooling=v${identity.toolingVersion}`)
  if (identity.history.length > 0) parts.push(`history=${identity.history.length}`)
  return parts.join(' ')
}

/**
 * 描述「档案里的身份」与「现在手上的身份」差在哪。
 *
 * 返回空串表示没有漂移。**必须区分「换了证书」与「只是证书不在」**：前者是
 * 有意的轮换，后者是意外丢失 —— 两种情况的补救动作完全不同（轮换要接受旧版
 * 收不到更新，并到**每台**机器上补装新根；丢失应该去把原证书找回来）。
 *
 * 注意这里描述的是**信任根断了**，不是 `publisherName` 变了 —— 后者同 CN 就不会变，
 * 详见本文件头部「换了证书为什么致命」一节。
 */
export function describeIdentityDrift(identity, current) {
  if (identity === null || identity === undefined) return ''
  if (typeof current !== 'object' || current === null || current.thumbprint === undefined) {
    return '档案里有身份，但当前读不到任何证书'
  }
  const currentThumb = normalizeThumbprint(current.thumbprint)
  if (currentThumb === null) {
    return '档案里有身份，但当前证书的指纹读不出来'
  }
  if (currentThumb === identity.thumbprint) {
    return identity.subject === current.subject
      ? ''
      : `指纹相同但主体不同：档案是 ${identity.subject}，当前是 ${current.subject}`
  }
  return (
    `当前证书不是档案里的那一张：档案 thumbprint=${identity.thumbprint}（${identity.subject}），` +
    `当前 thumbprint=${currentThumb}` +
    (current.subject === undefined ? '' : `（${current.subject}）`) +
    '。**换证书 = 换信任根**，而已装机器上没有这张新证书的根，' +
    'electron-updater 会因 Status≠Valid 拒绝每一个下载到的版本（不报错，只静默失败）'
  )
}
