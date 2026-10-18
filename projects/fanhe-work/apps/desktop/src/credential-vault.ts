/**
 * 第三方账号密码的本机凭据库。
 *
 * ## 它解决的是什么
 *
 * QQ 与千牛的「记住密码 + 自动登录」只能记一个账号，多账号时第二个起不来。于是启动
 * 配置需要一个「这条配置该填哪个账号密码」的地方。**密码只存在于本机**：加密后落盘、
 * 只在主进程内解密、绝不过 IPC 回传、绝不上服务端。
 *
 * ## 三条硬约束（与 `apps/web/src/lib/credential.ts` 同一套，但强度更高）
 *
 * 1. **明文不落盘。** 每条凭据用 `safeStorage.encryptString` 加密后才写文件，磁盘上
 *    只有密文。
 * 2. **密钥不在本进程里。** Windows 下 `safeStorage` 底层是 DPAPI，密钥由 OS 按当前
 *    用户派生。主进程调得到「加/解密」这两个入口，**拿不到密钥本身**。
 * 3. **凭据不出本机。** 没有任何 IPC 会把明文密码送回渲染进程（`status` 只给掩码
 *    账号），也没有任何网络请求。
 *
 * 与 `lib/credential.ts` 的差别正是关键：那份的密钥由浏览器托管、落在渲染进程够得到的
 * 地方（一次同源 XSS 就能调用它解密），它自己的注释也已写明「阶段四应换成主进程的
 * `safeStorage`」。**这里就是那个替换的落地处**，只不过服务的是启动配置，不是登录页。
 *
 * ## 与共享包 / 数据库的关系
 *
 * 共享包的 `LaunchProfile` **没有任何密码字段**，Prisma 也没有对应列，这个约定继续
 * 有效。那边管的是「工作台（服务端 / 共享包 / 数据库）不保存密码」；本机凭据库是同一
 * 条边界的另一侧，由共享包原话里那句「免密只能走 OS 凭据接口（Windows DPAPI 或
 * Electron safeStorage）」明确许可。配置与凭据用本地 `profileId` 映射关联，因此**不需要
 * 给配置表加一列**。
 *
 * ## 文件为什么必须自包含
 *
 * `apps/desktop` 的单测是 `node --experimental-strip-types --test`，只按字面解析
 * import 说明符，而 CJS 产出的 TypeScript 要求相对导入写成 `./foo.js`。于是「一个 `.ts`
 * import 另一个 `.ts` 且用 `.js` 后缀」这一生产正确的写法会让单测整个文件报模块缺失。
 * 所有**被测**的外壳模块（`launch-icon.ts` / `launch-registry.ts` / `brand-icon.ts` /
 * `launch-login-click.ts`）都是零相对导入。本文件遵循同一条约定。
 */

import { randomBytes } from 'node:crypto'

import { LAUNCH_CREDENTIAL_LIMITS } from '@fanhe/shared'

/* ------------------------------------------------------------------ *
 * 一、磁盘格式
 * ------------------------------------------------------------------ */

/** 一条凭据的明文。只在加密前与解密后存在于内存。 */
export type StoredCredential = {
  account: string
  password: string
}

/**
 * 磁盘上的一个条目。
 *
 * `blob` 是 `base64(safeStorage.encryptString(JSON.stringify(StoredCredential)))`。
 * `profileId` 与 `label` **是明文**，这是刻意的取舍：见下面 `type VaultFile` 的说明。
 */
export type VaultItem = {
  /** 关联的启动配置 id。服务端生成的 uuid，跨机稳定，天然适合做本地映射的键。 */
  profileId: string
  /** 用户可见的提示，取配置的显示名。非机密。 */
  label: string
  /** 密文，base64。 */
  blob: string
  /** 最近一次写入时刻，ISO 8601。 */
  updatedAt: string
}

/**
 * 凭据库文件的明文外壳。
 *
 * **外壳里不放任何账号密码，只放「哪条配置有一份凭据」与「它当时叫什么」。** 这样即使
 * 整份文件被拷到另一台机器上解不开（DPAPI 按用户绑定，这是必然的），用户仍然能看到
 * 「这台机器上原本存着『QQ · 工作号』的密码」，从而知道该重新填哪几条。若整个条目全
 * 加密，那种情况下界面上只会是一片空白，用户不知道该补哪一个。
 */
export type VaultFile = {
  /** 格式版本。读到不认识的版本时按损坏处理，不要试图将就。 */
  v: number
  items: readonly VaultItem[]
}

/** 当前格式版本。 */
export const VAULT_FORMAT_VERSION = 1

/**
 * 构造一个空库。
 *
 * 单独一个函数而不是各处写 `{ v: 1, items: [] }`：版本号与空数组的构造只有一处，
 * 将来改版本时不会漏掉某个默认值。
 */
export function emptyVaultFile(): VaultFile {
  return { v: VAULT_FORMAT_VERSION, items: [] }
}

/** 反序列化凭据库文件。内容非法或版本不认识时返回 null（调用方据此拒绝写入）。 */
export function parseVaultFile(text: string): VaultFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null

  const candidate = parsed as { v?: unknown; items?: unknown }
  if (candidate.v !== VAULT_FORMAT_VERSION) return null
  if (!Array.isArray(candidate.items)) return null

  const items: VaultItem[] = []
  for (const raw of candidate.items) {
    if (typeof raw !== 'object' || raw === null) return null
    const item = raw as {
      profileId?: unknown
      label?: unknown
      blob?: unknown
      updatedAt?: unknown
    }
    if (typeof item.profileId !== 'string' || item.profileId === '') return null
    if (typeof item.blob !== 'string' || item.blob === '') return null
    items.push({
      profileId: item.profileId,
      label: typeof item.label === 'string' ? item.label : '',
      blob: item.blob,
      updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
    })
  }
  return { v: VAULT_FORMAT_VERSION, items }
}

/** 序列化凭据库文件。 */
export function serializeVaultFile(file: VaultFile): string {
  return JSON.stringify({ v: file.v, items: file.items })
}

/** 写入一条（同 profileId 覆盖），返回新数组。纯函数，不碰磁盘。 */
export function upsertVaultItem(
  items: readonly VaultItem[],
  item: VaultItem,
): readonly VaultItem[] {
  const next = items.filter((existing) => existing.profileId !== item.profileId)
  next.push(item)
  return next
}

/** 删掉一条，返回新数组。纯函数，不碰磁盘。 */
export function removeVaultItem(
  items: readonly VaultItem[],
  profileId: string,
): readonly VaultItem[] {
  return items.filter((existing) => existing.profileId !== profileId)
}

/* ------------------------------------------------------------------ *
 * 二、账号掩码
 * ------------------------------------------------------------------ */

/** 只有账号要掩码。取「前三 + 四星 + 后四」是因为国内手机号 11 位时正好得到 `138****8888`。 */
const MASK_HEAD_LONG = 3
const MASK_TAIL_LONG = 4
const MASK_HEAD_SHORT = 1
const MASK_TAIL_SHORT = 2

/**
 * 把账号掩成可用于回显的形式。
 *
 * **为什么要掩**：`status` 必须让界面显示出「这条配置存的是哪个账号」，否则用户改配置
 * 时不知道该不该重新填。但完整账号不属于「为了展示而必须回传」的信息，掩一下能把
 * 「每次打开对话框都暴露一次完整账号」收窄成「用户主动要看时再看」。
 *
 * 短账号（4 位及以下）整体掩掉：那种字符串的信息量全在前几个字符里，掩一半等于没掩。
 * 空串返回空串，由调用方决定怎么显示。
 */
export function maskAccount(account: string): string {
  if (account === '') return ''
  const chars = Array.from(account)
  if (chars.length <= 4) return '*'.repeat(chars.length)
  if (chars.length <= 8) {
    const head = chars.slice(0, MASK_HEAD_SHORT).join('')
    const tail = chars.slice(-MASK_TAIL_SHORT).join('')
    return `${head}***${tail}`
  }
  const head = chars.slice(0, MASK_HEAD_LONG).join('')
  const tail = chars.slice(-MASK_TAIL_LONG).join('')
  return `${head}****${tail}`
}

/* ------------------------------------------------------------------ *
 * 三、输入归一（形态复核）
 * ------------------------------------------------------------------ */

/**
 * 账号长度上限。QQ 号 11 位、旺旺名通常更短，64 已远远够。
 *
 * 取值来自共享包的 `LAUNCH_CREDENTIAL_LIMITS`，**不在本文件另写一个数字**：界面预检与
 * 服务端形态复核都要用同一个上限，三处各写一份的结果是「表单说可以、保存失败」。
 */
export const ACCOUNT_MAX = LAUNCH_CREDENTIAL_LIMITS.ACCOUNT_MAX

/** 密码长度上限。128 已覆盖绝大多数密码管理器的上限，再长对本功能没有意义。 */
export const PASSWORD_MAX = LAUNCH_CREDENTIAL_LIMITS.PASSWORD_MAX

/** 一次查询的配置 id 个数上限。 */
export const STATUS_QUERY_MAX = 128

/** 归一一个配置 id。非字符串、空串、超长一律 null。 */
export function normalizeProfileId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > ACCOUNT_MAX) return null
  return trimmed
}

/** 归一一组配置 id。去重、保序、限长。 */
export function normalizeProfileIds(input: unknown): string[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const ids: string[] = []
  for (const raw of input) {
    const id = normalizeProfileId(raw)
    if (id === null || seen.has(id)) continue
    if (ids.length >= STATUS_QUERY_MAX) break
    seen.add(id)
    ids.push(id)
  }
  return ids
}

/** 一次保存请求归一后的结果。 */
export type CredentialInput = {
  profileId: string
  account: string
  password: string
  label: string
}

/**
 * 归一一次保存请求。
 *
 * 三项都不能为空、都不能超长。**空密码是拒绝而不是存进去**：存一个空密码会让后续的
 * 自动填表把空串打进密码框，表现是「填了但登录不上」，而用户看不出是哪一步出的问题。
 */
export function normalizeCredentialInput(value: unknown): CredentialInput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>

  const profileId = normalizeProfileId(raw['profileId'])
  if (profileId === null) return null

  if (typeof raw['account'] !== 'string' || typeof raw['password'] !== 'string') return null
  const account = raw['account'].trim()
  const password = raw['password']
  if (account === '' || password === '') return null
  if (account.length > ACCOUNT_MAX) return null
  if (password.length > PASSWORD_MAX) return null

  const label = typeof raw['label'] === 'string' ? raw['label'].slice(0, ACCOUNT_MAX) : ''
  return { profileId, account, password, label }
}

/* ------------------------------------------------------------------ *
 * 四、运行时类型
 * ------------------------------------------------------------------ */

/**
 * 一条配置的凭据状态。
 *
 * **`none`、`saved`、`undecryptable` 是三个不同的状态，不是一个。** 前两者用户看到的
 * 都是「密码框空的」，但前者要说「还没填」，后者要说「换机或换 Windows 用户后本机解不
 * 开，请重新填」。混成一个「没有密码」会让用户在换机后反复重填、反复失败，而他无法从
 * 界面看出问题不在自己身上。
 */
export const CREDENTIAL_STATES = ['none', 'saved', 'undecryptable'] as const

export type CredentialState = (typeof CREDENTIAL_STATES)[number]

/** 回给渲染进程的一条状态。**不含明文密码，也不含完整账号。 */
export type CredentialStatusResult = {
  profileId: string
  state: CredentialState
  /** 掩码后的账号；没有凭据或解不开时为 null。 */
  accountMasked: string | null
  /** 明文外壳里的提示（配置显示名），用于在解不开时告诉用户原本存的是哪一条。 */
  label: string
}

/** 一次写操作的结果。`ok` 为 false 时 `detail` 是可展示的原因。 */
export type CredentialWriteResult = { ok: true } | { ok: false; reason: string; detail: string }

/* ------------------------------------------------------------------ *
 * 五、依赖注入与运行
 * ------------------------------------------------------------------ */

/**
 * 凭据库需要的外部能力。
 *
 * 全部注入而不是在模块里 `import` Electron 与 `fs`：这个模块要能在 Node 单测里被直接
 * 驱动，而 Electron 的 `app` / `safeStorage` 在没有 app 运行时统统不可用。注入也让
 * 「解不开」「文件损坏」这些分支可以被精确构造，而不必靠真机复现。
 */
export type CredentialVaultDeps = {
  /** 读文件。文件不存在或读不到时返回 null。 */
  readFile: (path: string) => Promise<string | null>
  /** 写文件。 */
  writeFile: (path: string, content: string) => Promise<void>
  /** 改名。用于原子写入的落定一步。 */
  rename: (from: string, to: string) => Promise<void>
  /** 删文件。用于清理写入失败留下的临时文件。删不到时调用方自己吞掉异常。 */
  unlink: (path: string) => Promise<void>
  encrypt: (plaintext: string) => Buffer
  decrypt: (ciphertext: Buffer) => string
  isEncryptionAvailable: () => boolean
}

export type CredentialVault = {
  /** 查一组配置的凭据状态。不返回任何明文。 */
  status: (profileIds: readonly string[]) => Promise<readonly CredentialStatusResult[]>
  /** 仅供主进程启动后自动填写使用。明文不得通过 IPC、日志或网络传递。 */
  getForLaunch: (profileId: string) => Promise<StoredCredential | null>
  /** 保存一条。加密不可用时拒绝，并给出可展示的原因。 */
  save: (input: CredentialInput) => Promise<CredentialWriteResult>
  /** 删掉一条。软删除是幂等的：本来就没有也返回 ok。 */
  remove: (profileId: string) => Promise<CredentialWriteResult>
}

/**
 * 读库的三种结果。
 *
 * `missing` 是正常状态（第一次用），`corrupt` 是**必须停下**的状态：把一份解析不了的
 * 文件当成空库，下一次保存就会把用户原有的凭据全部覆盖掉。那种丢失是静默的，用户只
 * 会发现「密码得重填一遍」，而不会知道是文件坏了。
 */
type VaultReadResult =
  { kind: 'missing' } | { kind: 'corrupt'; detail: string } | { kind: 'ok'; file: VaultFile }

async function readVault(vaultPath: string, deps: CredentialVaultDeps): Promise<VaultReadResult> {
  let text: string | null
  try {
    text = await deps.readFile(vaultPath)
  } catch (error) {
    return { kind: 'corrupt', detail: error instanceof Error ? error.message : String(error) }
  }
  if (text === null || text.trim() === '') return { kind: 'missing' }

  const file = parseVaultFile(text)
  if (file === null) return { kind: 'corrupt', detail: '文件内容不是本程序认识的凭据库格式' }
  return { kind: 'ok', file }
}

/**
 * 原子写入：写临时文件再改名。
 *
 * **为什么不直接写目标文件**：直接写会在中途崩溃或磁盘满时留下一个截断的文件，而那份
 * 文件里装着用户所有的第三方密码。截断的代价不是「少一条」，是「全部要重填」。写临时
 * 文件再改名让「落定」变成一次元数据操作，读者要么看到旧内容、要么看到新内容，
 * 不会看到半份。
 *
 * 临时文件名带随机后缀：同一台机器上两个外壳实例（或一次失败留下的残留）不会互相踩。
 * 失败时清理临时文件，不留垃圾；清理本身失败也只留一个 `.tmp`，不影响目标文件。
 */
export async function writeVaultFileAtomic(
  vaultPath: string,
  content: string,
  deps: CredentialVaultDeps,
): Promise<CredentialWriteResult> {
  const tempPath = `${vaultPath}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await deps.writeFile(tempPath, content)
    await deps.rename(tempPath, vaultPath)
    return { ok: true }
  } catch (error) {
    try {
      await deps.unlink(tempPath)
    } catch {
      // 已经不在了，或者删不掉。后者只留一个 .tmp，不影响目标文件。
    }
    return {
      ok: false,
      reason: 'write_failed',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 加密一条凭据。失败（加密不可用）时返回 null，由调用方转成可展示的原因。 */
function encryptCredential(credential: StoredCredential, deps: CredentialVaultDeps): string | null {
  if (!deps.isEncryptionAvailable()) return null
  try {
    const buffer = deps.encrypt(JSON.stringify(credential))
    return buffer.toString('base64')
  } catch {
    return null
  }
}

/** 解密一条。任何失败（换机、换用户、密文被改）都返回 null，不抛。 */
function decryptCredential(blob: string, deps: CredentialVaultDeps): StoredCredential | null {
  try {
    const text = deps.decrypt(Buffer.from(blob, 'base64'))
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    const value = parsed as { account?: unknown; password?: unknown }
    if (typeof value.account !== 'string' || typeof value.password !== 'string') return null
    return { account: value.account, password: value.password }
  } catch {
    return null
  }
}

/**
 * 造一个本机凭据库。
 *
 * `vaultPath` 不进 deps 是刻意的：它是**数据**（放在哪个文件），而 deps 是**能力**。
 * 混在一起会让「换一个文件路径测试」这种最常见的用法变得要重造一份 deps。
 */
export function createCredentialVault(
  vaultPath: string,
  deps: CredentialVaultDeps,
): CredentialVault {
  async function status(profileIds: readonly string[]): Promise<readonly CredentialStatusResult[]> {
    if (profileIds.length === 0) return []

    const read = await readVault(vaultPath, deps)
    const items = read.kind === 'ok' ? read.file.items : []

    // 每个被问到的 id 都给一条结果，包括「没有凭据」的那种。前端要区分「还没填」与
    // 「解不开」，而只有拿到全部被问 id 的结果才能区分。
    const byId = new Map<string, VaultItem>()
    for (const item of items) {
      if (!byId.has(item.profileId)) byId.set(item.profileId, item)
    }

    const results: CredentialStatusResult[] = []
    for (const profileId of profileIds) {
      const item = byId.get(profileId)
      if (item === undefined) {
        results.push({ profileId, state: 'none', accountMasked: null, label: '' })
        continue
      }
      const credential = decryptCredential(item.blob, deps)
      if (credential === null) {
        results.push({
          profileId,
          state: 'undecryptable',
          accountMasked: null,
          label: item.label,
        })
        continue
      }
      results.push({
        profileId,
        state: 'saved',
        accountMasked: maskAccount(credential.account),
        label: item.label,
      })
    }
    return results
  }

  async function save(input: CredentialInput): Promise<CredentialWriteResult> {
    const blob = encryptCredential({ account: input.account, password: input.password }, deps)
    if (blob === null) {
      // 加密不可用时不落明文、也不报成功。提示要说清「这台机器的系统加密不可用」，
      // 而不是笼统的「保存失败」—— 后者会让用户去查网络。
      return {
        ok: false,
        reason: 'encryption_unavailable',
        detail: '本机系统加密暂不可用，密码未能保存。请重启应用后重试。',
      }
    }

    const read = await readVault(vaultPath, deps)
    if (read.kind === 'corrupt') {
      // 拒绝写入而不是覆盖。见 `VaultReadResult` 的说明：覆盖会静默丢掉全部凭据。
      return {
        ok: false,
        reason: 'vault_corrupt',
        detail: `本机凭据库已损坏，为避免丢失既有密码，本次没有保存。请备份并删除该文件后重试：${vaultPath}`,
      }
    }

    const currentItems = read.kind === 'ok' ? read.file.items : []
    const nextItems = upsertVaultItem(currentItems, {
      profileId: input.profileId,
      label: input.label,
      blob,
      updatedAt: new Date().toISOString(),
    })
    const written = await writeVaultFileAtomic(
      vaultPath,
      serializeVaultFile({ v: VAULT_FORMAT_VERSION, items: nextItems }),
      deps,
    )
    if (!written.ok) return written

    // **日志只回明文外壳能看的东西**：哪条配置写成功了。账号与密码一律不进日志 ——
    // 排障日志会被截图、会被打包发走，那是这套方案里最容易失守的一处。
    return { ok: true }
  }

  async function getForLaunch(profileId: string): Promise<StoredCredential | null> {
    const normalized = normalizeProfileId(profileId)
    if (normalized === null) return null
    const read = await readVault(vaultPath, deps)
    if (read.kind !== 'ok') return null
    const item = read.file.items.find((entry) => entry.profileId === normalized)
    return item === undefined ? null : decryptCredential(item.blob, deps)
  }

  async function remove(profileId: string): Promise<CredentialWriteResult> {
    const normalized = normalizeProfileId(profileId)
    if (normalized === null) {
      return { ok: false, reason: 'invalid_profile_id', detail: '配置 id 不合法' }
    }

    const read = await readVault(vaultPath, deps)
    if (read.kind === 'corrupt') {
      return {
        ok: false,
        reason: 'vault_corrupt',
        detail: `本机凭据库已损坏，本次没有删除。请备份并删除该文件后重试：${vaultPath}`,
      }
    }
    // 本来就没有这一条时直接返回 ok：删除的幂等性比「少一条也算成功」更重要。
    if (read.kind === 'missing') return { ok: true }

    const nextItems = removeVaultItem(read.file.items, normalized)
    if (nextItems.length === read.file.items.length) return { ok: true }
    return writeVaultFileAtomic(
      vaultPath,
      serializeVaultFile({ v: VAULT_FORMAT_VERSION, items: nextItems }),
      deps,
    )
  }

  return { status, getForLaunch, save, remove }
}
