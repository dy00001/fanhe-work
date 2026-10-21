import type {
  ApiErrorResponse,
  CreateEventRequest,
  CreateLaunchProfileRequest,
  CreateManagedUserRequest,
  CreateManagedUserResponse,
  CreateNoteRequest,
  DeleteEventResponse,
  DeleteLaunchProfileResponse,
  DeleteNoteResponse,
  EventListResponse,
  EventLogListResponse,
  EventResponse,
  EventTagListResponse,
  InitializeOwnerResponse,
  LaunchProfileListResponse,
  LaunchProfileResponse,
  LaunchProfileStatusListResponse,
  LoginResponse,
  LogoutResponse,
  ManagedUserActionResponse,
  ManagedUserDetailResponse,
  ManagedUserListResponse,
  MeResponse,
  NoteListResponse,
  NoteResponse,
  OpsDashboardResponse,
  OpsHealthResponse,
  OpsShopBoardsResponse,
  NoteTagListResponse,
  PermissionCatalogResponse,
  PermissionCode,
  RefreshResponse,
  ReorderLaunchProfilesRequest,
  RoleListResponse,
  RunLaunchProfileResponse,
  SetEventStatusRequest,
  SetNoteArchivedRequest,
  SetNotePinnedRequest,
  SetupStatusResponse,
  UpdateEventRequest,
  UpdateLaunchProfileRequest,
  UpdateManagedUserRequest,
  UpdateNoteRequest,
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
  /**
   * 中断信号。**只有版本清单那条请求会传**（见 `versionManifestRequest`）——
   * 它由界面上的一个动作触发（打开账号菜单），网络不通时那个 Promise 会永远挂着，
   * 而挂着的 Promise 在 React 里就是一个永不 settle 的状态机。
   *
   * 做成可选而不是给所有请求都设默认超时：给全部接口统一加超时是一件需要逐个核对
   * 业务上限的事（备份、启动配置这些接口的正常耗时远长于查版本），顺手在这里设一个
   * 「看起来合理」的值会让它们在正常使用时被误杀。
   */
  signal?: AbortSignal
  /**
   * 单次请求的超时（毫秒）。只给「知道正常耗时上限」的接口用。
   *
   * 不给全局设默认值，理由与上面 signal 那段相同：备份、启动配置这些接口的正常
   * 耗时远长于查版本，一个「看起来合理」的默认值会让它们在正常使用时被误杀。
   * 运营看板三个读接口的耗时是已知的（单店、单区间、纯读库），所以它们单独设。
   *
   * 与 `signal` 互斥：两者都表达「什么时候放弃等待」，同时给会互相覆盖。
   */
  timeoutMs?: number
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
  // signal 同样只在真的给了才写上去：RequestInit.signal 的取值域是 AbortSignal | null，
  // 不含 undefined，而 exactOptionalPropertyTypes 下显式传 undefined 与「没这个属性」
  // 不再等价。
  if (options.signal !== undefined) {
    init.signal = options.signal
  }

  /*
   * 超时用 AbortController 实现，而不是 Promise.race。
   *
   * race 只让「等待」提前结束，请求本身还在跑，响应回来之后仍然会占着连接；
   * abort 会真的把请求掐掉。差别在弱网下很明显：race 攒下一堆悬挂请求，abort 不会。
   */
  const limitMs = options.timeoutMs
  let timer: ReturnType<typeof setTimeout> | null = null
  let controller: AbortController | null = null
  if (limitMs !== undefined && options.signal === undefined) {
    controller = new AbortController()
    init.signal = controller.signal
    timer = setTimeout(() => {
      controller?.abort()
    }, limitMs)
  }

  let response: Response
  let body: string
  try {
    response = await fetch(`${API_BASE_URL}${path}`, init)
    // 读响应体也在超时窗口内：只给 fetch 计时会在「响应头回来了、响应体一直不来」
    // 这种半通状态下漏掉 —— 而桌面壳反代最常见的失败正是这一种。
    body = await response.text()
  } catch {
    // 超时与网络失败在 fetch 眼里都是 AbortError，靠自己的 signal 状态区分。
    if (controller !== null && controller.signal.aborted) {
      throw new ApiError(
        0,
        'timeout',
        `服务器超过 ${Math.round((limitMs ?? 0) / 1000)} 秒没有响应`,
        null,
      )
    }
    // fetch 只在网络层面失败时抛异常。这里统一成 status 0，与「拿到了响应但
    // 状态码是错误」区分开：前者重试有意义，后者重试只是重复同样的拒绝。
    throw new ApiError(0, 'network_error', '无法连接服务器，请确认后端已启动', null)
  } finally {
    if (timer !== null) clearTimeout(timer)
  }

  const payload = parseJson(body)

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

/**
 * 取服务端当前的版本清单。
 *
 * **不附访问令牌**，与该接口不设门禁一致（理由见服务端 `version/manifest.ts` 的注释）。
 *
 * **返回 `unknown` 而不是 `VersionManifestResponse`。** 上面的 `request<T>` 对成功响应
 * 是直接 `as T` 的断言，不做任何形状检查 —— 平时那没问题（响应体形状由服务端代码保证，
 * 改坏了会立刻在别处暴露），但这条路径拿到的响应会**先经过 Cloudflare 那一层**：
 * T5-05 落地后它会先返回 Access 的登录/拦截页，那是一个 HTTP 200 + HTML 正文。
 * 按 `as` 断言它会变成一个「版本号是 undefined 的清单」，而这个错误要到比对时才暴露，
 * 报出来的是 `compareVersions` 里的 `undefined.split`。
 *
 * 所以形状校验放在 `lib/version-check.ts`（那里能降级为 `unknown`），这里只负责取数与
 * 把 HTTP 错误规范化。**这不是重复校验，而是把「断言」与「校验」分开**：这一层是传输，
 * 不知道什么叫版本清单。
 *
 * 超时 5 秒。`/api/version` 是读根目录的 `package.json` 再算一次哈希，正常在毫秒级；
 * 5 秒足够覆盖冷启动与跨公网往返，又不至于让菜单里的那一行提示悬着不出现。
 */
export function versionManifestRequest(signal?: AbortSignal): Promise<unknown> {
  return request<unknown>('/api/version', {
    method: 'GET',
    // 与上面那条注释同源：signal 只在给了时才写进 RequestOptions（exactOptionalPropertyTypes）。
    ...(signal === undefined ? {} : { signal }),
  })
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

/**
 * 每条配置的路径状态与最近一次启动。
 *
 * 与列表分成两条请求，理由在服务端那一条路由的注释里：这一条要查文件系统，最坏会
 * 等满超时，而列表本身不该被它拖住。
 */
export function launchProfileStatusRequest(
  accessToken: string,
): Promise<LaunchProfileStatusListResponse> {
  return request<LaunchProfileStatusListResponse>('/api/launch/profiles/status', {
    method: 'GET',
    accessToken,
  })
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

/**
 * 工作纪要的八条接口。
 *
 * 与启动配置同一条分工：这一层只拼地址、发请求、把失败规范化成 `ApiError`；令牌由
 * `lib/notes.ts` 经 `withAccessToken` 附加。**id 同样一律过 `encodeURIComponent`**，
 * 理由与启动配置那一段完全相同。
 *
 * 置顶与归档各占一条幂等 `PUT`，**不并进 `PATCH`**。这不是接口设计上的偏好，而是界面
 * 需要它：改标题失败与置顶失败对用户是两件事，反馈位置与重试范围都不同。混在一条
 * 路径上，界面就只能给出一个笼统的「保存失败」。
 */

/** 列表筛选。字段都可省略，服务端按「省略即不加该条件」处理。 */
export type NoteListQuery = {
  tag?: string | undefined
  /** 只看已归档。省略即只看未归档 —— 归档项退出默认列表。 */
  archived?: boolean | undefined
  from?: string | undefined
  to?: string | undefined
  /** 关键词，服务端同时匹配标题与正文。空串不发送（服务端也按不检索处理）。 */
  q?: string | undefined
}

/**
 * 列表。
 *
 * **只把真正给了的条件拼进查询串。** 服务端那份 querystring schema 是
 * `additionalProperties: false`，多带一个它不认识的参数会直接 400；而
 * `archived` 在字符串语境下只接受 `'true'` / `'false'` 两个字面量，
 * 因此布尔值必须在这里转成字符串，不能靠 `String(false)` 之外的任何写法。
 */
export function notesRequest(
  accessToken: string,
  query: NoteListQuery = {},
): Promise<NoteListResponse> {
  const search = new URLSearchParams()
  if (query.tag !== undefined && query.tag !== '') search.set('tag', query.tag)
  if (query.archived === true) search.set('archived', 'true')
  if (query.from !== undefined && query.from !== '') search.set('from', query.from)
  if (query.to !== undefined && query.to !== '') search.set('to', query.to)
  // 检索词同样只在非空时发送。全空白不必在这里拦：服务端会 trim 后按「不检索」处理，
  // 两处都拦反而多一条要同步的规则（`normalizeSearchQuery` 是那条规则的唯一出处）。
  if (query.q !== undefined && query.q !== '') search.set('q', query.q)
  const queryString = search.toString()
  return request<NoteListResponse>(`/api/notes${queryString === '' ? '' : `?${queryString}`}`, {
    method: 'GET',
    accessToken,
  })
}

/**
 * 标签清单。供标签输入框给出候选。
 *
 * 单独一条请求而不是从上面那份列表里聚合：列表将来分页之后，前端手上只有一页，
 * 推不出全量标签，而候选恰恰需要全量。共享包里该类型的注释写了同一件事。
 */
export function noteTagsRequest(accessToken: string): Promise<NoteTagListResponse> {
  return request<NoteTagListResponse>('/api/notes/tags', { method: 'GET', accessToken })
}

export function noteRequest(accessToken: string, id: string): Promise<NoteResponse> {
  return request<NoteResponse>(`/api/notes/${encodeURIComponent(id)}`, {
    method: 'GET',
    accessToken,
  })
}

export function createNoteRequest(
  accessToken: string,
  input: CreateNoteRequest,
): Promise<NoteResponse> {
  return request<NoteResponse>('/api/notes', { method: 'POST', body: input, accessToken })
}

export function updateNoteRequest(
  accessToken: string,
  id: string,
  input: UpdateNoteRequest,
): Promise<NoteResponse> {
  return request<NoteResponse>(`/api/notes/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    accessToken,
  })
}

export function deleteNoteRequest(accessToken: string, id: string): Promise<DeleteNoteResponse> {
  return request<DeleteNoteResponse>(`/api/notes/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    accessToken,
  })
}

export function setNotePinnedRequest(
  accessToken: string,
  id: string,
  input: SetNotePinnedRequest,
): Promise<NoteResponse> {
  return request<NoteResponse>(`/api/notes/${encodeURIComponent(id)}/pin`, {
    method: 'PUT',
    body: input,
    accessToken,
  })
}

export function setNoteArchivedRequest(
  accessToken: string,
  id: string,
  input: SetNoteArchivedRequest,
): Promise<NoteResponse> {
  return request<NoteResponse>(`/api/notes/${encodeURIComponent(id)}/archive`, {
    method: 'PUT',
    body: input,
    accessToken,
  })
}

/**
 * 事件记录的七条接口（列表 / 标签 / 变更历史 / 新增 / 修改 / 状态切换 / 删除）。
 *
 * 与上面两个板块同一条分工：这一层只拼地址、发请求、把失败规范化成 `ApiError`；
 * 令牌由 `lib/events.ts` 经 `withAccessToken` 附加。**id 同样一律过
 * `encodeURIComponent`**，理由与启动配置那一段完全相同。
 *
 * **状态变更走自己的那条路径**（`PUT .../status`），不并进 `PATCH` —— 服务端把它
 * 单独开一条是因为它是唯一需要留痕的改动（见 `setEventStatusRequest` 的注释）。
 * 变更历史是同一条 `:id` 下的另一个子资源，读它不改变任何东西，因此是 `GET`。
 */
export type EventListQuery = {
  /** 只看某一状态。省略即两组都返回，由界面分组。 */
  status?: 'todo' | 'done' | undefined
  /** 只看带这个标签的事件。空串不发送。 */
  tag?: string | undefined
  from?: string | undefined
  to?: string | undefined
  /** 关键词，服务端同时匹配标题与描述。空串不发送（服务端也按不检索处理）。 */
  q?: string | undefined
}

/**
 * 列表。
 *
 * **只把真正给了的条件拼进查询串。** 服务端那份 querystring schema 是
 * `additionalProperties: false`，多带一个它不认识的参数会直接 400。与 `notesRequest`
 * 是同一条约定，也同样是「只在非空时发送」——两处都拦反而多一条要同步的规则
 * （`normalizeSearchQuery` 才是「什么叫空」的唯一出处）。
 */
export function eventsRequest(
  accessToken: string,
  query: EventListQuery = {},
): Promise<EventListResponse> {
  const search = new URLSearchParams()
  if (query.status !== undefined) search.set('status', query.status)
  if (query.tag !== undefined && query.tag !== '') search.set('tag', query.tag)
  if (query.from !== undefined && query.from !== '') search.set('from', query.from)
  if (query.to !== undefined && query.to !== '') search.set('to', query.to)
  if (query.q !== undefined && query.q !== '') search.set('q', query.q)
  const queryString = search.toString()
  return request<EventListResponse>(`/api/events${queryString === '' ? '' : `?${queryString}`}`, {
    method: 'GET',
    accessToken,
  })
}

/**
 * 标签清单。供标签输入框给出候选，与列表分开一次请求 —— 列表将来分页之后前端手上
 * 只有一页，推不出全量，而候选恰恰需要全量。理由与 `noteTagsRequest` 相同。
 */
export function eventTagsRequest(accessToken: string): Promise<EventTagListResponse> {
  return request<EventTagListResponse>('/api/events/tags', { method: 'GET', accessToken })
}

export function createEventRequest(
  accessToken: string,
  input: CreateEventRequest,
): Promise<EventResponse> {
  return request<EventResponse>('/api/events', { method: 'POST', body: input, accessToken })
}

export function updateEventRequest(
  accessToken: string,
  id: string,
  input: UpdateEventRequest,
): Promise<EventResponse> {
  return request<EventResponse>(`/api/events/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    accessToken,
  })
}

/**
 * 状态切换。勾选完成与撤销共用这一条，撤销就是把它设回 `todo`。
 *
 * 用 `PUT` 而不是 `POST`：它替换的是「这条事件处于哪个状态」这个整体，服务端因此
 * 天然幂等 —— 重复提交同一个状态不会写出第二条日志。**这一点是界面敢做乐观更新的
 * 前提**：切换失败时重发一次就够了，不必先问「上一次到底成没成」。
 *
 * `comment` 不进这个函数。界面的勾选是「做完了」这一个动作，没有可填备注的位置；
 * 留一个参数在这里而没人传，只会让人以为界面上某处能填。要写备注时再加。
 */
export function setEventStatusRequest(
  accessToken: string,
  id: string,
  input: SetEventStatusRequest,
): Promise<EventResponse> {
  return request<EventResponse>(`/api/events/${encodeURIComponent(id)}/status`, {
    method: 'PUT',
    body: input,
    accessToken,
  })
}

/**
 * 状态变更历史。详情面板（T3-12）的唯一数据来源。
 *
 * **这是唯一一条「查别人的东西」的接口，因此它的 404 尤其重要。** `event_logs` 表上
 * 没有 `user_id` 列，归属完全靠服务端在读之前先确认事件属于当前账号；不对的话一律
 * 返回 404（不是 403 —— 用 403 会让任何一种响应都变成「这个 UUID 存在」的探针）。
 * 因此界面这一侧**不要自己判归属**，也不要把 404 说成「你没有权限」：那等于承认它存在。
 * 与另外两条 `:id` 路由共用同一个说法，见 `eventFailureExit`。
 *
 * 顺序（按发生时间升序）由服务端定，界面照着画。
 */
export function eventLogsRequest(accessToken: string, id: string): Promise<EventLogListResponse> {
  return request<EventLogListResponse>(`/api/events/${encodeURIComponent(id)}/logs`, {
    method: 'GET',
    accessToken,
  })
}

/**
 * 删除。服务端是**软删除且幂等**，响应里的 `removed` 表示本次是否真的改动了一行。
 * 界面不区分「删掉了」与「本来就不在」（两者对它都是「这条已经不在列表里」），
 * 这个布尔值留作排查用，与另外两个板块一致。
 */
export function deleteEventRequest(accessToken: string, id: string): Promise<DeleteEventResponse> {
  return request<DeleteEventResponse>(`/api/events/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    accessToken,
  })
}

// ---------------------------------------------------------------------------
// 账号与权限管理
// ---------------------------------------------------------------------------

/** 账号列表。只返回当前账号能管理的那些，外加当前账号自己。 */
export function managedUsersRequest(accessToken: string): Promise<ManagedUserListResponse> {
  return request<ManagedUserListResponse>('/api/system/users', {
    method: 'GET',
    accessToken,
  })
}

/**
 * 账号详情。除账号本身，还返回角色自带的权限与账号级覆盖。
 *
 * 界面需要「角色默认权限」才能算出勾选框的初始状态：光看最终权限无法区分
 * 「这个权限是角色给的」与「这个权限是单独授予的」，而这两种在再次保存时的
 * 处理方式不同。
 */
export function managedUserDetailRequest(
  accessToken: string,
  id: string,
): Promise<ManagedUserDetailResponse> {
  return request<ManagedUserDetailResponse>(`/api/system/users/${encodeURIComponent(id)}`, {
    method: 'GET',
    accessToken,
  })
}

/**
 * 创建账号。
 *
 * 返回值含 `effectivePermissions`，让界面在创建成功后就能显示「这个账号实际能做
 * 什么」，不必再拉一次详情 —— 少一次往返，也少一处「创建成功但列表还没刷新」
 * 的中间态。
 */
export function createManagedUserRequest(
  accessToken: string,
  input: CreateManagedUserRequest,
): Promise<CreateManagedUserResponse> {
  return request<CreateManagedUserResponse>('/api/system/users', {
    method: 'POST',
    accessToken,
    body: input,
  })
}

/** 编辑账号。只传要改的字段，服务端按部分更新处理。 */
export function updateManagedUserRequest(
  accessToken: string,
  id: string,
  input: UpdateManagedUserRequest,
): Promise<ManagedUserActionResponse> {
  return request<ManagedUserActionResponse>(`/api/system/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    accessToken,
    body: input,
  })
}

/**
 * 删除账号。要求独立的 `system.user.delete` 权限。
 *
 * 服务端是软删除，且会一并吊销该账号的全部会话 —— 停用与删除都必须立刻生效，
 * 否则「删掉了」只是不再登录，已登录的人还能继续用。
 */
export function deleteManagedUserRequest(
  accessToken: string,
  id: string,
): Promise<ManagedUserActionResponse> {
  return request<ManagedUserActionResponse>(`/api/system/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    accessToken,
  })
}

/** 重置密码。服务端会吊销该账号全部会话并清零锁定计数。 */
export function resetManagedUserPasswordRequest(
  accessToken: string,
  id: string,
  newPassword: string,
): Promise<ManagedUserActionResponse> {
  return request<ManagedUserActionResponse>(
    `/api/system/users/${encodeURIComponent(id)}/reset-password`,
    { method: 'POST', accessToken, body: { newPassword } },
  )
}

/**
 * 设置账号级权限覆盖。整体替换，不是增量。
 *
 * 请求体是 `{ granted, denied }` 两组而不是一个最终集合：服务端需要区分「取消一个
 * 勾选」（写 denied 行）与「从没勾过」（不写行），而这两者在保存时做的事不同。
 */
export function setManagedUserPermissionsRequest(
  accessToken: string,
  id: string,
  permissions: { granted: readonly PermissionCode[]; denied: readonly PermissionCode[] },
): Promise<ManagedUserActionResponse> {
  return request<ManagedUserActionResponse>(
    `/api/system/users/${encodeURIComponent(id)}/permissions`,
    { method: 'PUT', accessToken, body: permissions },
  )
}

/** 权限点清单，供勾选树渲染。 */
export function permissionCatalogRequest(accessToken: string): Promise<PermissionCatalogResponse> {
  return request<PermissionCatalogResponse>('/api/system/permissions', {
    method: 'GET',
    accessToken,
  })
}

/** 角色清单，供创建与编辑时的角色下拉。 */
export function roleListRequest(accessToken: string): Promise<RoleListResponse> {
  return request<RoleListResponse>('/api/system/roles', { method: 'GET', accessToken })
}

/**
 * 运营看板三个读接口的超时。
 *
 * 15 秒的取值依据：本机实测这三个接口在 30 天区间上都是几十毫秒，跨一层桌面壳反代
 * 也在百毫秒级。给到 15 秒是留给「机器刚开机、数据库冷启动、磁盘在扫描」这类情况，
 * 而不是留给正常路径。原来的实现没有超时，网络半通时界面会永久停在加载态，用户
 * 看到的只有转圈，没有任何可操作的信息。
 */
const OPS_READ_TIMEOUT_MS = 15_000

/**
 * 运营看板。查询参数只有三项：区间两端与店铺代号。
 *
 * 与 `notesRequest` 同一条约定：**只在有值时发送**。服务端 schema 是
 * `additionalProperties: false`，多带一个空串会直接 400，而空串在 URLSearchParams
 * 里是最容易顺手塞进去的东西。
 */
export function opsDashboardRequest(
  accessToken: string,
  query: { from?: string; to?: string; days?: number; shop?: string } = {},
): Promise<OpsDashboardResponse> {
  const search = new URLSearchParams()
  if (query.from !== undefined && query.from !== '') search.set('from', query.from)
  if (query.to !== undefined && query.to !== '') search.set('to', query.to)
  if (query.days !== undefined) search.set('days', String(query.days))
  if (query.shop !== undefined && query.shop !== '') search.set('shop', query.shop)
  const queryString = search.toString()
  return request<OpsDashboardResponse>(
    `/api/ops/dashboard${queryString === '' ? '' : `?${queryString}`}`,
    {
      method: 'GET',
      accessToken,
      timeoutMs: OPS_READ_TIMEOUT_MS,
    },
  )
}

/** 采集批次与新鲜度。需要 `ops.collect.read`，403 时界面收起健康面板。 */
export function opsHealthRequest(
  accessToken: string,
  query: { shop?: string; limit?: number } = {},
): Promise<OpsHealthResponse> {
  const search = new URLSearchParams()
  if (query.shop !== undefined && query.shop !== '') search.set('shop', query.shop)
  if (query.limit !== undefined) search.set('limit', String(query.limit))
  const queryString = search.toString()
  return request<OpsHealthResponse>(
    `/api/ops/health${queryString === '' ? '' : `?${queryString}`}`,
    {
      method: 'GET',
      accessToken,
      timeoutMs: OPS_READ_TIMEOUT_MS,
    },
  )
}

/** 五店并列指标带。与看板共用区间参数，但独立一次请求（切店是全局状态）。 */
export function opsShopBoardsRequest(
  accessToken: string,
  query: { from?: string; to?: string; days?: number } = {},
): Promise<OpsShopBoardsResponse> {
  const search = new URLSearchParams()
  if (query.from !== undefined && query.from !== '') search.set('from', query.from)
  if (query.to !== undefined && query.to !== '') search.set('to', query.to)
  if (query.days !== undefined) search.set('days', String(query.days))
  const queryString = search.toString()
  return request<OpsShopBoardsResponse>(
    `/api/ops/overview-shops${queryString === '' ? '' : `?${queryString}`}`,
    { method: 'GET', accessToken, timeoutMs: OPS_READ_TIMEOUT_MS },
  )
}
