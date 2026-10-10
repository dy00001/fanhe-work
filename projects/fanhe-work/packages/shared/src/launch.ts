/**
 * 一键登录启动配置的跨进程结构。
 *
 * 与 auth.ts 的分工一致：这里只放**传输形态与取值规则**，不放行为。配置的读写、
 * 排序与所有权校验留在 apps/api 内部；而「什么算合法的软件标识」「什么算绝对路径」
 * 这类判断放在这里，是因为前端表单要即时提示、服务端要强制校验，两边必须用同一条
 * 规则 —— 各写一份的结果是「表单说可以，提交后 400」。
 *
 * **本模块的字段里有本机绝对路径。** 这是整个项目唯一一处「受版本控制的文件不出现
 * 盘符」这条约定管不到的地方，因为它压根不进版本控制：路径存运行时数据库，数据库
 * 的数据目录在忽略规则里。换机后路径可能失效，那是 T3-04 的失效提示要处理的事，
 * 不是靠不存路径来回避 —— 不存路径等于这个板块没有功能。
 *
 * **工作台不保存任何第三方账号的密码。** 实施方案 6.1 明确了这条边界：免密登录只能
 * 走操作系统凭据接口（Windows DPAPI 或 Electron safeStorage），属阶段四之后的事，
 * 本期不做。因此这里没有任何密码字段，`args` 里若被用户填进密码，那是用户的自主
 * 选择，与「工作台代管密码」是两回事 —— 后者才是需要安全边界的东西。
 */

/**
 * 内置软件标识。
 *
 * 用字符串常量而不是数据库枚举：新增一个软件只需在这里加一项，不必写迁移。与权限点
 * 清单同一条思路（清单在共享包、不动表结构）。代价是数据库侧没有约束，因此服务端
 * 必须用 `isLaunchSoftware` 校验 —— 这一条不能省，否则库里会攒下一批前端认不出的
 * 标识，表现为「列表里某几行的图标是空白」，而且不报错。
 *
 * `custom` 表示由用户自行填写可执行文件路径的软件。它同样走一套完整配置，不另开
 * 一条代码路径：多账号诉求对自定义软件同样成立。
 */
export const LAUNCH_SOFTWARES = ['wechat', 'qq', 'qianniu', 'custom'] as const

export type LaunchSoftware = (typeof LAUNCH_SOFTWARES)[number]

export function isLaunchSoftware(value: string): value is LaunchSoftware {
  return (LAUNCH_SOFTWARES as readonly string[]).includes(value)
}

/**
 * 字段长度上限。路由 schema 与 service 校验共用一份。
 *
 * 上限存在的理由与登录接口里的密码上限相同：没有上限时，一个几 MB 的请求体会先被
 * 完整读进来再交给校验。这里另有一层考虑 —— 这些值要写进数据库列，列宽定死在
 * `schema.prisma` 里，两侧不一致时表现为「插入时才报错」，而不是「提交时就告诉
 * 用户太长了」。改列宽时要连同这里一起改。
 */
export const LAUNCH_PROFILE_LIMITS = {
  NAME_MAX: 64,
  EXECUTABLE_PATH_MAX: 1024,
  /** 单个启动参数的长度上限。 */
  ARG_MAX: 512,
  /** 启动参数的个数上限。 */
  ARGS_MAX_COUNT: 32,
  ICON_MAX: 64,
} as const

/**
 * 判断一个路径是不是绝对路径。
 *
 * 只做形态判断，**不查文件是否存在**：存在性检查属于 T3-04 的失效提示，而它必须在
 * 真正要启动的那一刻做 —— 配置创建时文件在、三个月后可能已被卸载，把检查结果固化
 * 进配置反而会给出一个过期的结论。
 *
 * 三种形态都要认，因为工作空间是多机轮换的，同一份配置可能在 Windows 与 Unix 环境下
 * 被读取：
 *
 *   `C:\...` 与 `C:/...`   盘符
 *   `\\server\share`       网络共享（UNC）
 *   `/usr/bin/...`         Unix 绝对路径
 *
 * 相对路径一律拒绝。存下相对路径的配置在任何机器上都启动不了，而失败点很远 ——
 * 它会在用户点击启动时才以「找不到文件」的形式出现，那时已经看不出是当初填错了。
 */
export function isAbsoluteExecutablePath(value: string): boolean {
  if (value.startsWith('/')) return true
  if (value.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * 一条启动配置。
 *
 * `software` 与 `AuthenticatedUser.role` 同样是字符串而不是收窄后的字面量联合：
 * 库里读出来的就是字符串，收窄需要在服务端做一次运行期断言，而失败的代价只是
 * 「类型好看一点」。需要穷举判断时在消费侧对照 `LAUNCH_SOFTWARES` 收窄。
 *
 * 时间字段是 ISO 字符串而不是 Date：跨进程传输的 JSON 里没有 Date 类型，让服务端
 * 先转成字符串，比让前端拿到字符串再自己解析要少一处约定。
 */
export type LaunchProfile = {
  id: string
  software: string
  /** 显示名。同一软件配置多条时靠它区分，例如「微信 · 工作号」。 */
  name: string
  /** 本机可执行文件绝对路径。形态由 `isAbsoluteExecutablePath` 判定。 */
  executablePath: string
  /**
   * 启动参数，**按数组存**，不是一个待分词的字符串。
   *
   * 这是刻意的：Windows 的命令行分词规则（双引号成对、`\` 不作转义、`""` 表示空串）
   * 与 POSIX 不同，自己实现一套分词必然在某个边界上与客户端实际行为不一致，而那种
   * 不一致只在特定参数上暴露。存数组则把「哪些是一个参数」这件事交还给用户，启动时
   * 直接传给子进程，中间不再有解析环节。
   */
  args: readonly string[]
  /** 图标标识。为空时前端按 `software` 取默认图标。 */
  icon: string | null
  /** 列表中的排序序号，升序。同一次重排后会写成一串连续的整数。 */
  sortOrder: number
  createdAt: string
  updatedAt: string
}

export type LaunchProfileListResponse = {
  profiles: readonly LaunchProfile[]
}

export type LaunchProfileResponse = {
  profile: LaunchProfile
}

/**
 * 新增请求。
 *
 * 不含 `sortOrder`：新配置一律排在末尾，由服务端取当前最大值加一。让客户端传排序
 * 值意味着它必须知道当前的最大值是多少，于是每次新增都要先拉一次列表 —— 而这个
 * 往返换来的只是「客户端可以选择插在哪里」，那是拖拽排序该做的事，不是新增。
 */
export type CreateLaunchProfileRequest = {
  software: string
  name: string
  executablePath: string
  args?: readonly string[]
  icon?: string | null
}

/**
 * 修改请求。所有字段可选，只改传入的那些。
 *
 * `software` 允许修改。它决定默认图标与参数模板，用户选错了软件时改一下比删掉重建
 * 方便，而改它不影响其余字段的语义。
 *
 * 没有 `sortOrder`：排序走单独的重排接口，那里一次提交整个顺序。允许在修改接口里
 * 顺带改排序，会让「改个名字」与「挪个位置」共用一条路径，而后者需要同时调整其它行
 * 的序号才能保持连续，两者的失败处理完全不同。
 */
export type UpdateLaunchProfileRequest = {
  software?: string
  name?: string
  executablePath?: string
  args?: readonly string[]
  icon?: string | null
}

/**
 * 重排请求。
 *
 * 提交**整个列表的 id 顺序**，而不是「把某个 id 移到某个位置」。后者需要服务端自己
 * 推导出最终顺序，而推导规则（移到目标之前还是之后）在边界上很容易与界面理解不一致；
 * 提交完整顺序则把「最终长什么样」这件事完全交给界面，服务端只负责落库。
 *
 * 服务端会校验这个数组恰好覆盖当前用户的全部配置：少一个 id 意味着有一行没有新位置，
 * 多一个 id 意味着客户端拿着一份过期的列表在操作。
 */
export type ReorderLaunchProfilesRequest = {
  ids: readonly string[]
}

/** 删除响应。软删除是幂等的，`removed` 说明本次是否真的改动了一行。 */
export type DeleteLaunchProfileResponse = {
  removed: boolean
}

/**
 * 启动一条配置的响应。
 *
 * **请求体是空的：只传配置 id，不接受路径与参数。** 这条边界必须守住 —— 若接口
 * 允许把路径和参数一起提交，它就成了一个「本机任意命令执行」入口，任何拿到会话
 * 的人（或任何一个能向回环端口发请求的页面）都能运行任意程序。只认配置 id 之后，
 * 能启动什么完全由用户自己事先配置的那几条决定。
 *
 * 没有 `status` 之类的「运行中」概念：工作台不是进程管理器。`spawn` 之后就把
 * 子进程交还给操作系统，此后它的生死与工作台无关（关掉工作台不该连带关掉微信）。
 * 因此这里返回的只是一次「创建进程」这个动作的结果，不是进程的状态。
 */
export type RunLaunchProfileResponse = {
  /** 被启动的配置 id。回显出来是为了让客户端能对上自己刚点的是哪一条。 */
  profileId: string
  /** 子进程 id。进程创建成功后由操作系统分配。 */
  pid: number
  /** 进程创建时刻，ISO 8601。 */
  startedAt: string
  /**
   * 本次是否命中了去重窗口。
   *
   * 为 `true` 时表示这个请求没有真的创建进程，而是复用了上一次的结果（`pid` 与
   * `startedAt` 都是上一次的）。界面不需要区分这两种情况 —— 用户看到的都是
   * 「已启动」；它的用处是排查时能分辨「点了一下」和「点了一下但被合并掉了」。
   */
  deduplicated: boolean
}
