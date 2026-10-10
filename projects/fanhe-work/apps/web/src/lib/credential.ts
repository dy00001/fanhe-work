/**
 * 「记住账号密码」的客户端凭据存储。
 *
 * 三件事必须同时成立，缺一条这个功能就不该存在。
 *
 * **明文不落盘。** 凭据用 AES-GCM 加密后才写入 localStorage，磁盘上只有密文与
 * 初始向量。明文只存在于内存，用完即弃。
 *
 * **密钥读不出来。** 加密密钥以 `extractable: false` 生成，存进 IndexedDB。
 * 同源脚本可以用它加解密，但无法把密钥本身导出带走。
 *
 * **凭据不出本机。** 这里只写 localStorage 与 IndexedDB，没有任何网络请求，
 * 服务端数据库里也不会有它的影子。密钥落在浏览器 profile 中，profile 在系统盘
 * 而不在 U 盘上，因此凭据不随工作空间移动。
 *
 * **安全强度的边界要说清楚。** 密钥由浏览器托管，一次同源 XSS 就能调用它解密。
 * 这与把密码明文放进 localStorage 相比是数量级的差别，但低于操作系统密钥链：
 * 后者把密钥交给 DPAPI 或 Keychain，渲染进程根本拿不到。阶段四的 Electron 外壳
 * 落地后，应把本文件的实现换成主进程的 `safeStorage`，加密发生在渲染进程够不到
 * 的地方。替换只涉及本文件，登录页调用的是下面这几个函数，不需要改。
 *
 * 与 `session.ts` 的分工：那边管会话令牌，寿命短、可撤销、随登录状态生灭；这里
 * 管登录凭据，寿命无限，只在用户明确勾选时写入。两者都落 localStorage，但互不
 * 依赖，退出登录不会清掉已记住的凭据。
 */

const CREDENTIAL_STORAGE_KEY = 'fanhe-work.credential'

/** 密钥库。用 IndexedDB 而不是 localStorage，因为 localStorage 只能存字符串，
 *  `CryptoKey` 存进去会被转成 `[object CryptoKey]`。 */
const KEY_DATABASE_NAME = 'fanhe-work'
const KEY_DATABASE_VERSION = 1
const KEY_STORE_NAME = 'keys'
const KEY_RECORD_ID = 'credential-key'

/** AES-GCM 的初始向量长度。12 字节是 RFC 5288 为 GCM 规定的推荐值。 */
const IV_BYTES = 12

export type RememberedCredential = {
  username: string
  password: string
}

/** 落盘的密文结构。`v` 留给将来的格式变更，读到不认识的版本时按解密失败处理。 */
type CredentialPayload = {
  v: number
  iv: string
  data: string
}

const PAYLOAD_VERSION = 1

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return window.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * 解码 base64url。
 *
 * 返回类型写明 `Uint8Array<ArrayBuffer>` 而不是裸的 `Uint8Array`。TypeScript 5.7
 * 起 `Uint8Array` 带上了缓冲区类型参数，默认值是 `ArrayBufferLike`，其中包含
 * `SharedArrayBuffer`；而 Web Crypto 的参数类型要求底层是普通的 `ArrayBuffer`。
 * 不写这一笔，`subtle.decrypt` 的 `iv` 参数就会在编译期被拒。
 */
function decodeBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replaceAll('-', '+').replaceAll('_', '/')
  // 编码时去掉了尾部填充，解码前补回来。`atob` 对缺失填充的容错因实现而异。
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = window.atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/**
 * 密钥库连接。缓存在模块作用域，一次会话只打开一次。
 *
 * 不缓存的话每次读写都要开一个连接再关掉。打开 IndexedDB 在随机读写慢的介质上
 * 可以花掉数秒（实测把浏览器 profile 放在 U 盘上时约 5.8 秒），而登录页每次挂载
 * 都要读一次密钥，这个代价会直接变成「密码框几秒钟之后才被填上」。
 */
let keyDatabase: Promise<IDBDatabase> | null = null

function openKeyDatabase(): Promise<IDBDatabase> {
  if (keyDatabase !== null) return keyDatabase

  keyDatabase = new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(KEY_DATABASE_NAME, KEY_DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(KEY_STORE_NAME)) {
        database.createObjectStore(KEY_STORE_NAME)
      }
    }
    request.onsuccess = () => {
      const database = request.result
      // 另一个标签页要升级这个库时，当前连接必须让路，否则升级会被它无限期阻塞。
      database.onversionchange = () => {
        database.close()
        keyDatabase = null
      }
      // 存储被清理或磁盘异常时，浏览器会主动关掉连接。不把缓存置空的话，之后每次
      // 操作都会拿到一个已经失效的连接，失败且无法自愈。
      database.onclose = () => {
        keyDatabase = null
      }
      resolve(database)
    }
    request.onerror = () => {
      keyDatabase = null
      reject(request.error ?? new Error('无法打开密钥库'))
    }
  })

  return keyDatabase
}

async function readStoredKey(): Promise<CryptoKey | null> {
  const database = await openKeyDatabase()
  return new Promise<CryptoKey | null>((resolve, reject) => {
    const request = database
      .transaction(KEY_STORE_NAME, 'readonly')
      .objectStore(KEY_STORE_NAME)
      .get(KEY_RECORD_ID)
    request.onsuccess = () => {
      const value: unknown = request.result
      // 结构化克隆能把 CryptoKey 原样存回来，所以正常情况下这里就是一个密钥。
      // 判一次类型是为了应对库里存着旧版本或别的程序写坏的数据。
      resolve(value instanceof CryptoKey ? value : null)
    }
    request.onerror = () => reject(request.error ?? new Error('无法读取密钥'))
  })
}

async function writeStoredKey(key: CryptoKey): Promise<void> {
  const database = await openKeyDatabase()
  await new Promise<void>((resolve, reject) => {
    const request = database
      .transaction(KEY_STORE_NAME, 'readwrite')
      .objectStore(KEY_STORE_NAME)
      .put(key, KEY_RECORD_ID)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error ?? new Error('无法写入密钥'))
  })
}

/** 本次会话内缓存的密钥，省掉每次读写都开一次 IndexedDB。 */
let cachedKey: CryptoKey | null = null

async function getOrCreateKey(): Promise<CryptoKey> {
  if (cachedKey !== null) return cachedKey

  const existing = await readStoredKey()
  if (existing !== null) {
    cachedKey = existing
    return existing
  }

  // extractable 传 false。这一位决定密钥能否被导出，是这套方案里唯一真正起作用的
  // 约束：即使有人在同源下执行脚本，也只能调用它，不能把密钥复制走。
  const created = await window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])
  await writeStoredKey(created)
  cachedKey = created
  return created
}

function readPayload(): CredentialPayload | null {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(CREDENTIAL_STORAGE_KEY)
  } catch {
    // 隐私模式下读取会抛异常，等同于没有记住过。
    return null
  }
  if (raw === null) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<CredentialPayload>
    if (candidate.v !== PAYLOAD_VERSION) return null
    if (typeof candidate.iv !== 'string' || typeof candidate.data !== 'string') return null
    return { v: candidate.v, iv: candidate.iv, data: candidate.data }
  } catch {
    return null
  }
}

function isRememberedCredential(value: unknown): value is RememberedCredential {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<RememberedCredential>
  return typeof candidate.username === 'string' && typeof candidate.password === 'string'
}

/**
 * 保存凭据。调用方只在登录成功之后调用它，否则会把输错的密码一并记住。
 *
 * 失败不抛错。凭据存储是增强功能，它不可用时登录本身仍然应该成功，把异常抛给
 * 登录流程会让一个次要能力拖垮主路径。环境不支持（无 `crypto.subtle`、隐私模式
 * 下 IndexedDB 被禁用）与写入失败都归到这一类。
 */
export async function saveCredential(credential: RememberedCredential): Promise<void> {
  try {
    const key = await getOrCreateKey()
    // 初始向量每次重新生成，绝不复用。AES-GCM 在同一密钥下重复使用初始向量会
    // 泄露明文异或关系，是这套方案里最容易写错、后果也最严重的一处。
    const iv = window.crypto.getRandomValues(new Uint8Array(IV_BYTES))
    const plaintext = new TextEncoder().encode(JSON.stringify(credential))
    const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext)

    const payload: CredentialPayload = {
      v: PAYLOAD_VERSION,
      iv: encodeBase64Url(iv),
      data: encodeBase64Url(new Uint8Array(ciphertext)),
    }
    window.localStorage.setItem(CREDENTIAL_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // 见函数头注释。这里不写日志：环境不支持是常态，写出来只会变成噪声。
  }
}

/**
 * 读取凭据。没有记住过、密钥丢失、密文被改动，三种情况一律返回 null。
 *
 * 后两种与「没有记住过」在界面上无法区分，也不该区分：用户看到的都是账号密码
 * 没被带出来，此时正确的动作是让他手动输入，而不是报一个他无法处理的错误。
 * 密文读不出来时顺手清掉，免得每次进登录页都重复一次注定失败的解密。
 */
export async function loadCredential(): Promise<RememberedCredential | null> {
  const payload = readPayload()
  if (payload === null) return null

  try {
    const key = await getOrCreateKey()
    const plaintext = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: decodeBase64Url(payload.iv) },
      key,
      decodeBase64Url(payload.data),
    )
    const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext))
    if (!isRememberedCredential(parsed)) {
      clearCredential()
      return null
    }
    return parsed
  } catch {
    clearCredential()
    return null
  }
}

/**
 * 清除已保存的凭据。
 *
 * 只删密文，不删密钥。密钥留着不影响任何事（没有密文可解），而删掉它会让同一
 * 份密钥保护的其他数据一起失效，将来若有别的数据用同一把密钥就会踩到。登出不会
 * 调用这里：记住账号密码与当前会话是两件事，退出登录不该顺手忘掉账号。
 */
export function clearCredential(): void {
  try {
    window.localStorage.removeItem(CREDENTIAL_STORAGE_KEY)
  } catch {
    // 忽略。
  }
}

/**
 * 是否已保存过凭据。
 *
 * 只判断密文在不在，不做解密。用于在界面渲染的第一帧决定复选框的初始状态，
 * 避免等一次异步解密才把勾选状态显示出来。真正要取出内容时仍走 `loadCredential`。
 */
export function hasStoredCredential(): boolean {
  return readPayload() !== null
}
