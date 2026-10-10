import type {
  ApiErrorResponse,
  CreateLaunchProfileRequest,
  DeleteLaunchProfileResponse,
  InitializeOwnerResponse,
  LaunchProfileListResponse,
  LaunchProfileResponse,
  LoginResponse,
  LogoutResponse,
  MeResponse,
  RefreshResponse,
  ReorderLaunchProfilesRequest,
  RunLaunchProfileResponse,
  SetupStatusResponse,
  UpdateLaunchProfileRequest,
} from '@fanhe/shared'

/**
 * 传输层。
 *
 * 只负责三件事：拼请求、解析响应、把失败规范化成一个错误类型。它不认识令牌，
 * 也不认识登录状态 —— 那两件事在 session.ts。分开是因为刷新令牌的流程本身要
 * 调用这里的接口，若这里再反过来依赖会话状态，两边就互相引用了。
 *
 * 所有失败都收敛成 ApiError，调用方只处理一种错误类型。网络中断、HTTP 错误码、
 * 响应体不是 JSON 这三种情况在这里被拉平，调用方不必各写一遍判断。
 */

/**
 * 接口基址。
 *
 * 开发期留空，由 Vite 的 `/api` 代理转到后端，浏览器看到的始终是同源地址，
 * 因此不需要 CORS。打包进 Electron 后前端可能从 file:// 或自定义协议加载，
 * 那时用 VITE_API_BASE_URL 指向本机服务。留成配置而不是写死，是因为这个地址
 * 在两种形态下不同，而它是构建期常量，写死会让打包产物只能用于一种形态。
 */
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? ''

/** 请求失败。`code` 是服务端给的机器可读码，`message` 是可直接展示的文案。 */
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /** 429 时的建议等待秒数，其它情况为 null。 */
  readonly retryAfterSeconds: number | null

  constructor(status: number, code: string, message: string, retryAfterSeconds: number | null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }

  /** 网络层面没有拿到响应，status 为 0。 */
  get isNetworkError(): boolean {
    return this.status === 0
  }

  get isUnauthorized(): boolean {
    return this.status === 401
  }

  get isRateLimited(): boolean {
    return this.status === 429
  }
}

type RequestOptions = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  accessToken?: string | null
}

/**
 * 把响应体解析成 JSON，解析不了就返回 null。
 *
 * 先取文本再解析，不直接调 response.json()：失败响应可能没有响应体（例如
 * 网关返回的 502），直接解析会抛出一个与真实原因无关的语法错误，掩盖掉状态码
 * 这个更有用的信息。
 */
function parseJson(text: string): unknown {
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function readErrorPayload(payload: unknown): { code: string; message: string } {
  if (typeof payload === 'object' && payload !== null) {
    const candidate = payload as Partial<ApiErrorResponse>
    const code = typeof candidate.error === 'string' ? candidate.error : 'unknown_error'
    const message =
      typeof candidate.message === 'string' ? candidate.message : '请求失败，请稍后重试'
    return { code, message }
  }
  return { code: 'unknown_error', message: '请求失败，请稍后重试' }
}

async function request<T>(path: string, options: RequestOptions): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
  }
  if (options.accessToken !== undefined && options.accessToken !== null) {
    headers.authorization = `Bearer ${options.accessToken}`
  }

  // 请求体按需赋值，不在对象字面量里写 `body: undefined`。开启
  // exactOptionalPropertyTypes 后，显式传 undefined 与「没有这个属性」不再等价，
  // 而 RequestInit.body 的取值域是 BodyInit | null，不含 undefined。
  const init: RequestInit = { method: options.method, headers }
  if (options.body !== undefined) {
    init.body = JSON.stringify(options.body)
  }

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, init)
  } catch {
    // fetch 只在网络层面失败时抛异常。这里统一成 status 0，与「拿到了响应但
    // 状态码是错误」区分开：前者重试有意义，后者重试只是重复同样的拒绝。
    throw new ApiError(0, 'network_error', '无法连接服务器，请确认后端已启动', null)
  }

  const payload = parseJson(await response.text())

  if (!response.ok) {
    const { code, message } = readErrorPayload(payload)
    const retryAfterHeader = response.headers.get('retry-after')
    const retryAfterSeconds =
      retryAfterHeader === null || Number.isNaN(Number(retryAfterHeader))
        ? null
        : Number(retryAfterHeader)
    throw new ApiError(response.status, code, message, retryAfterSeconds)
  }

  return payload as T
}

export function loginRequest(input: {
  username: string
  password: string
  deviceId?: string
  deviceName?: string
}): Promise<LoginResponse> {
  return request<LoginResponse>('/api/auth/login', { method: 'POST', body: input })
}

export function refreshRequest(refreshToken: string): Promise<RefreshResponse> {
  return request<RefreshResponse>('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken },
  })
}

export function logoutRequest(
  refreshToken: string,
  scope: 'session' | 'device' | 'all' = 'session',
): Promise<LogoutResponse> {
  return request<LogoutResponse>('/api/auth/logout', {
    method: 'POST',
    body: { refreshToken, scope },
  })
}

/** 取当前用户与展开后的权限。需要访问令牌，由 session 层负责附加。 */
export function meRequest(accessToken: string): Promise<MeResponse> {
  return request<MeResponse>('/api/auth/me', { method: 'GET', accessToken })
}

export function setupStatusRequest(): Promise<SetupStatusResponse> {
  return request<SetupStatusResponse>('/api/setup/status', { method: 'GET' })
}

export function initializeOwnerRequest(input: {
  username: string
  password: string
  displayName: string
}): Promise<InitializeOwnerResponse> {
  return request<InitializeOwnerResponse>('/api/setup/initialize', {
    method: 'POST',
    body: input,
  })
}

/**
 * 启动配置的六条接口。
 *
 * 全部要访问令牌，由 `lib/launch.ts` 经 `withAccessToken` 附加 —— 这一层只负责
 * 「拼地址、发请求、把失败规范化」，与上面的认证接口一致。
 *
 * **id 一律经过 `encodeURIComponent`。** 它来自服务端返回的 UUID，理论上不含需要
 * 转义的字符，但路径是拼接出来的字符串：一旦上游某天换成用户可控的标识，未转义的
 * 值可以直接改写请求路径（`../` 之类）。这一行是零成本的兜底。
 */

export function launchProfilesRequest(accessToken: string): Promise<LaunchProfileListResponse> {
  return request<LaunchProfileListResponse>('/api/launch/profiles', { method: 'GET', accessToken })
}

export function createLaunchProfileRequest(
  accessToken: string,
  input: CreateLaunchProfileRequest,
): Promise<LaunchProfileResponse> {
  return request<LaunchProfileResponse>('/api/launch/profiles', {
    method: 'POST',
    body: input,
    accessToken,
  })
}

export function updateLaunchProfileRequest(
  accessToken: string,
  id: string,
  input: UpdateLaunchProfileRequest,
): Promise<LaunchProfileResponse> {
  return request<LaunchProfileResponse>(`/api/launch/profiles/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    accessToken,
  })
}

/**
 * 重排。
 *
 * 提交**整个列表的 id 顺序**（见共享包里该结构的注释），因此这里收的是一个数组而不是
 * 「某条挪到某处」。返回重排后的完整列表 —— 界面按服务端落库的结果重绘，不自己推算。
 */
export function reorderLaunchProfilesRequest(
  accessToken: string,
  ids: readonly string[],
): Promise<LaunchProfileListResponse> {
  const body: ReorderLaunchProfilesRequest = { ids }
  return request<LaunchProfileListResponse>('/api/launch/profiles/order', {
    method: 'PUT',
    body,
    accessToken,
  })
}

export function deleteLaunchProfileRequest(
  accessToken: string,
  id: string,
): Promise<DeleteLaunchProfileResponse> {
  return request<DeleteLaunchProfileResponse>(`/api/launch/profiles/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    accessToken,
  })
}

/** 启动。请求体为空 —— 能启动什么完全由服务端那条配置决定。 */
export function runLaunchProfileRequest(
  accessToken: string,
  id: string,
): Promise<RunLaunchProfileResponse> {
  return request<RunLaunchProfileResponse>(`/api/launch/profiles/${encodeURIComponent(id)}/run`, {
    method: 'POST',
    accessToken,
  })
}
