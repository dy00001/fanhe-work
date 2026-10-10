import { ApiError, logoutRequest, meRequest, refreshRequest } from './api'

/**
 * 客户端会话。
 *
 * 两种令牌在客户端也必须分开存放，理由是它们的寿命与用途不同。
 *
 * **访问令牌只放内存。** 它短命（默认 15 分钟）、无状态、不可撤销，泄露后的
 * 可用窗口就是它的剩余寿命。放进 localStorage 会让任何一次 XSS 都能把它读走，
 * 而它又无法被服务端提前作废。放内存意味着刷新页面就丢，这正是可以接受的代价：
 * 丢掉之后用刷新令牌换一个新的即可。
 *
 * **刷新令牌放 localStorage。** 它长期有效、可撤销，是「刷新页面不用重新登录」
 * 的唯一依据，因此必须持久化。它的风险面由轮换与重放检测兜底：一个被复制的
 * 刷新令牌在合法客户端下次刷新后就会失效。
 *
 * 这条取舍的边界要写清楚：localStorage 对 XSS 是敞开的。当前形态是桌面外壳内的
 * 单页应用，不加载任何第三方脚本，风险面可控。若将来引入第三方脚本或做多用户
 * 共用浏览器，正确的做法是改成 HttpOnly Cookie 承载刷新令牌，那时改的是这里与
 * 服务端的两处，不影响其它模块。
 */

const REFRESH_TOKEN_STORAGE_KEY = 'fanhe-work.refresh-token'

/**
 * 提前多久续期。
 *
 * 不能等到过期那一刻才续：从发起请求到服务端返回有一段网络往返，若卡在边界上，
 * 请求会带着一个刚好过期的访问令牌出发，结果是「每次续期都先失败一次」。
 * 提前 60 秒留出这段余量。
 */
const REFRESH_SKEW_MS = 60_000

/** 提前量的下限。过期时间很近时也不能把定时器设成 0，否则会连发请求。 */
const MIN_REFRESH_DELAY_MS = 5_000

let accessToken: string | null = null
let accessTokenExpiresAt = 0

/**
 * 会话代数。每次清空会话递增一次，用来识别「这次续期属于哪一代会话」。
 *
 * 存在的理由是登出与在飞的续期之间存在竞态：用户点登出时，一次续期可能正好在
 * 路上。请求已经发出，无法取消，它返回后会执行 `applyTokens`，把刚被登出清掉的
 * 刷新令牌又写回 localStorage。表现是「点了登出，刷新页面却又进去了」——登出没有
 * 真正生效，而界面上看不出任何异常。
 *
 * 因此改为在写回之前比对代数：代数变了说明会话已经被清空，这次结果直接丢弃。
 */
let sessionEpoch = 0

function readRefreshToken(): string | null {
  try {
    return window.localStorage.getItem(REFRESH_TOKEN_STORAGE_KEY)
  } catch {
    // 隐私模式或存储被禁用时读取会抛异常。此时降级成「不能持久化」，
    // 当前标签页仍可正常使用，只是刷新后会回到登录页。
    return null
  }
}

function writeRefreshToken(token: string): void {
  try {
    window.localStorage.setItem(REFRESH_TOKEN_STORAGE_KEY, token)
  } catch {
    // 写不进去不是致命错误，同上降级。
  }
}

function removeRefreshToken(): void {
  try {
    window.localStorage.removeItem(REFRESH_TOKEN_STORAGE_KEY)
  } catch {
    // 忽略。
  }
}

/** 是否存在可用于恢复会话的刷新令牌。用于决定启动时要不要尝试静默续期。 */
export function hasStoredRefreshToken(): boolean {
  return readRefreshToken() !== null
}

export function getAccessToken(): string | null {
  return accessToken
}

/** 访问令牌的过期时刻（epoch 毫秒）。没有会话时为 0。 */
export function getAccessTokenExpiresAt(): number {
  return accessTokenExpiresAt
}

/**
 * 距离下一次续期应当等待多少毫秒。没有会话时返回 null。
 *
 * 返回值已经过下限裁剪，调用方可以直接拿去设定时器。把裁剪放在这里而不是调用方，
 * 是为了让「提前量」与「最小间隔」这两个参数只有一处定义。
 */
export function nextRefreshDelayMs(): number | null {
  if (accessToken === null) return null
  const delay = accessTokenExpiresAt - REFRESH_SKEW_MS - Date.now()
  return Math.max(delay, MIN_REFRESH_DELAY_MS)
}

/** 记录一组新令牌。登录与续期都走这里，保证两处的过期计算一致。 */
export function applyTokens(tokens: {
  accessToken: string
  refreshToken: string
  expiresIn: number
}): void {
  accessToken = tokens.accessToken
  accessTokenExpiresAt = Date.now() + tokens.expiresIn * 1000
  writeRefreshToken(tokens.refreshToken)
}

/** 清空会话。登出、续期失败、令牌被撤销都走这里。 */
export function clearSession(): void {
  // 先递增代数，再清令牌。顺序反过来的话，在飞的续期可能恰好在这两步之间完成
  // 写回，把刚删掉的令牌放回来。
  sessionEpoch += 1
  accessToken = null
  accessTokenExpiresAt = 0
  removeRefreshToken()
}

/**
 * 用刷新令牌换一组新令牌。
 *
 * **同一时刻只允许一个续期请求在飞。** 页面打开时可能有多个请求同时拿到 401，
 * 各自触发一次续期。服务端对刷新令牌做轮换：第一个请求成功后旧令牌即作废，
 * 后续请求拿着同一个旧令牌提交，会被判为「已轮换令牌被重放」。若落在宽限期内
 * 只是失败，超出宽限期就会整链撤销，把用户直接踢下线。
 *
 * 因此这里把并发请求收敛到同一个 Promise 上。后到的调用方拿到的是同一个结果，
 * 不会产生第二次提交。
 */
let inFlightRefresh: Promise<string> | null = null

export function refreshSession(): Promise<string> {
  if (inFlightRefresh !== null) {
    return inFlightRefresh
  }

  const epoch = sessionEpoch
  const promise = (async (): Promise<string> => {
    const refreshToken = readRefreshToken()
    if (refreshToken === null) {
      throw new ApiError(401, 'no_refresh_token', '登录状态已失效，请重新登录', null)
    }
    const tokens = await refreshRequest(refreshToken)
    // 请求期间会话被清空了（用户登出，或续期失败后回登录页）。服务端那边可能已经
    // 完成轮换，但本机不该再持有这个凭证：写回去等于把刚登出的会话又放回
    // localStorage。抛错而不是静默返回，是为了让调用方走「续期失败」这条既有路径，
    // 而不是拿着一个已被丢弃的令牌继续请求。
    if (epoch !== sessionEpoch) {
      throw new ApiError(401, 'session_cleared', '登录状态已失效，请重新登录', null)
    }
    applyTokens(tokens)
    // 返回访问令牌而不是完整响应：调用方需要的只是「用哪个令牌重试」。
    return tokens.accessToken
  })()

  inFlightRefresh = promise
  return promise.finally(() => {
    // 只清理自己那一次。若期间已有新的续期开始，它的 Promise 已经替换了这一项，
    // 直接置空会把新的那次丢掉。
    if (inFlightRefresh === promise) {
      inFlightRefresh = null
    }
  })
}

/**
 * 带访问令牌执行一个请求，遇到 401 时续期一次再重试。
 *
 * 只重试一次。第二次仍然 401 说明问题不在令牌的时效上（例如账号已被停用），
 * 再试只是重复同样的拒绝，而且会让失效路径上的请求量翻倍。
 */
export async function withAccessToken<T>(call: (accessToken: string) => Promise<T>): Promise<T> {
  const current = getAccessToken()
  if (current === null) {
    return call(await refreshSession())
  }

  try {
    return await call(current)
  } catch (error) {
    if (error instanceof ApiError && error.isUnauthorized) {
      return call(await refreshSession())
    }
    throw error
  }
}

/** 取当前用户与权限，必要时先续期。 */
export function loadCurrentUser() {
  return withAccessToken((token) => meRequest(token))
}

/**
 * 结束会话。
 *
 * 先清本地令牌再通知服务端，顺序不能反。服务端撤销需要一次网络往返，失败或超时
 * 时若把本地令牌留着，用户会以为自己没退出。清掉本地令牌后，即使撤销请求失败，
 * 本机也已经退出，下次刷新会因没有刷新令牌而回到登录页。
 *
 * 撤销失败不向调用方抛错：登出的目标是「这个凭证不再可用」，而本机这一侧已经
 * 达成；把失败报给用户只会产生一个他无法处理的提示。
 */
export async function endSession(scope: 'session' | 'device' | 'all' = 'session'): Promise<void> {
  const refreshToken = readRefreshToken()
  clearSession()
  if (refreshToken === null) return
  try {
    await logoutRequest(refreshToken, scope)
  } catch {
    // 见上。本机已退出，服务端那一侧由令牌自然过期兜底。
  }
}
