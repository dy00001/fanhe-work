/**
 * 事件记录的跨进程结构。
 *
 * 与 note.ts 的分工一致：这里只放**传输形态与取值规则**，不放行为。事件的读写、
 * 归属校验与排序留在 apps/api 内部；而「哪些状态算合法」「标题有多长算过长」这类
 * 判断放在这里，因为前端表单要即时提示、服务端要强制校验，两边必须共用同一条
 * 规则 —— 各写一份的结果是「表单说可以，提交后 400」。
 *
 * **状态的每一次变化都留痕，不做原地修改。** 这是这个板块与纪要最根本的区别：
 * 纪要的字段被改掉就是改掉了，而事件从「未完成」到「已完成」这件事本身要被记下来
 * ——「谁在什么时候完成的」「为什么又被撤销了」是详情面板要回答的问题，只留一个
 * 当前状态答不了。因此状态不是事件行上的一个可变列那么简单，它的每次流转都会往
 * `event_logs` 追一行，`events.status` 只是那份流水的最新投影（见 T3-12）。
 */

// ---------------------------------------------------------------------------
// 取值域
// ---------------------------------------------------------------------------

/**
 * 事件状态。只有两档，不做「进行中」「已取消」这类中间态。
 *
 * 加一档的代价不只是多一个取值：每个视图都要回答「它算完成组还是未完成组」，
 * 而「进行中」这类状态在两个分组里都说不通，最后会被塞进一个「其他」组 ——
 * 分组界面一旦出现「其他」，用户就得自己去翻它里面有什么。
 *
 * 状态流转是双向的：`todo → done`（勾选完成）与 `done → todo`（撤销）。撤销不是
 * 删除日志，而是再追加一行，因此「完成过又撤销」这件事在历史里看得见。
 */
export const EVENT_STATUSES = ['todo', 'done'] as const
export type EventStatus = (typeof EVENT_STATUSES)[number]

/**
 * 优先级。三档，`normal` 是默认值。
 *
 * 用三个具名档而不是 1~5 的整数：整数需要一个「多少算高」的约定，而这个约定只
 * 存在于写代码的人的脑子里，界面上表现为「优先级 3 到底急不急」。三档具名的取值
 * 可以原样出现在筛选器里，不需要任何换算说明。
 */
export const EVENT_PRIORITIES = ['low', 'normal', 'high'] as const
export type EventPriority = (typeof EVENT_PRIORITIES)[number]

/**
 * 状态变更日志的动作码。
 *
 * **做成字符串常量而不是数据库枚举**，与 `LAUNCH_RUN_OUTCOMES` 同一条理由：这是
 * 一条会随功能演进的取值域（将来可能加上「改期」「指派」），新增一种动作不该需要
 * 一次数据库迁移。代价是库侧没有约束，读出来由 `isEventLogAction` 收窄，认不出的
 * 取值按「未知动作」原样展示 —— 历史记录宁可显示得含糊，也不该因为认不出就丢掉。
 *
 * 三个动作的边界：
 * - `created`  —— 事件被创建。`fromStatus` 为 null，`toStatus` 为 `todo`。
 * - `completed` —— 未完成 → 已完成。由勾选切换触发（T3-11）。
 * - `reopened` —— 已完成 → 未完成。撤销入口走的也是这条，与勾选切换同一个接口。
 *
 * **编辑标题、正文、标签、优先级不写日志。** 详情面板要回答的是「状态怎么变的」，
 * 把每次改标题也塞进去，这条流水就会从「状态变更历史」变成一份全字段的修改记录，
 * 而后者真正的归宿是审计，不是这里。少写这一类的代价是「谁改了标题」暂时查不到，
 * 而那个问题当前没有人问。
 */
export const EVENT_LOG_ACTIONS = ['created', 'completed', 'reopened'] as const
export type EventLogAction = (typeof EVENT_LOG_ACTIONS)[number]

/**
 * 收窄一个动作码。
 *
 * 读取侧用它决定「这个动作我认不认识」，而不是用它把值强行收窄成联合类型 ——
 * 认不出的取值要能原样展示（见 `EventLog.action` 的说明）。因此它的返回类型是
 * 类型谓词，调用方不满足时自己决定怎么显示，而不是被逼着抛错或丢数据。
 */
export function isEventLogAction(value: string): value is EventLogAction {
  return (EVENT_LOG_ACTIONS as readonly string[]).includes(value)
}

// ---------------------------------------------------------------------------
// 长度上限
// ---------------------------------------------------------------------------

/**
 * 字段长度上限。路由 schema 与 service 校验共用一份。
 *
 * 上限存在的理由与纪要相同：没有上限时，一个几 MB 的请求体会先被完整读进来再交给
 * 校验。描述上限给到 10 万字符，是按「一篇长文」的量级留的余量，它不是业务约束，
 * 而是防超大请求体的闸门。
 *
 * **这些值与 `NOTE_LIMITS` 刻意保持一致，但独立定义。** 一致性是为了让用户在两个
 * 板块看到同一套行为（同一个搜索框、同样长的标签）；独立定义是因为「事件标题该有
 * 多长」这个问题的归属是事件模块 —— 共用一份常量会让改纪要的上限时悄悄改了事件
 * 的，而两者的请求校验是各自独立的。改列宽时这里与 schema.prisma 要一起改。
 */
export const EVENT_LIMITS = {
  TITLE_MAX: 200,
  DESCRIPTION_MAX: 100_000,
  TAG_MAX: 32,
  TAGS_MAX_COUNT: 20,
  SEARCH_MAX: 64,
  /** 状态变更备注。撤销完成时说明原因用，是可选的一段短文。 */
  COMMENT_MAX: 200,
} as const

/**
 * 标签的归一与校验**复用纪要那一套**（`normalizeNoteTags` / `isValidNoteTag` /
 * `parseNoteTagInput`，见 note.ts），这里不再写第二份。
 *
 * 标签在两个板块里是同一个概念 —— 用户心里的「这个标签下有哪些东西」是跨板块的。
 * 各写一份的结果是同一个输入在纪要里被去重、在事件里没有，而两边界面看起来完全
 * 一样。名字里的 `note` 是历史，不是使用范围的限制。
 *
 * 将来若有第三个模块也需要标签，再把这三个函数搬到独立的 tag.ts 并让两边引用它；
 * 现在为两个使用方做那次搬家，换来的只是多一个文件。
 */

// ---------------------------------------------------------------------------
// 传输类型
// ---------------------------------------------------------------------------

/**
 * 一条事件记录。
 *
 * 时间字段是 ISO 字符串而不是 Date，与 `Note` / `LaunchProfile` 同一条理由：
 * 跨进程传输的 JSON 里没有 Date 类型。
 *
 * `completedBy` 是**完成人当时的显示名快照**，不是用户 id。详情面板要展示的是
 * 「谁完成的」，而账号随后可能改名甚至被删 —— 快照保证历史记录读得出来。这与
 * `audit_logs` 同时记 actorId 与 actorName 是同一条判断，只是这里对外只暴露名字：
 * 界面不需要 id，而 id 一旦暴露出去就会有人依赖它。
 *
 * 未完成时 `completedAt` 与 `completedBy` 都是 null，两者同步置空。留一个「完成了
 * 但不知道是谁」的中间状态没有意义 —— 那只会让详情面板多一个分支去猜。
 */
export type Event = {
  id: string
  /** 标题。 */
  title: string
  /** 描述，Markdown 原文。与纪要正文同一条理由：渲染是前端的事。 */
  description: string
  status: EventStatus
  priority: EventPriority
  /** 标签。已归一：去首尾空白、去重、无空串。 */
  tags: readonly string[]
  /** 截止时间，ISO 8601；未设为 null。 */
  dueAt: string | null
  /** 完成时刻，ISO 8601；未完成为 null。 */
  completedAt: string | null
  /** 完成人显示名快照；未完成为 null。 */
  completedBy: string | null
  createdAt: string
  updatedAt: string
}

/**
 * 一条状态变更日志。
 *
 * 只追加，不做更新与删除，因此没有 `updatedAt` —— 给它加一个更新时间戳反而会给出
 * 「这行被改过」的错误暗示，与 `audit_logs` 的处理一致。
 *
 * `fromStatus` / `toStatus` 都可为 null 且各有含义：创建时 `fromStatus` 为 null
 * （此前没有状态），而 `toStatus` 只有在「动作码认不出来」时才会是 null。
 *
 * **`action` 的类型是 `string` 而不是联合类型，这是有意的。** 库侧没有约束，而这条
 * 记录是只追加的历史：一个动作码在写入之后才被引入，旧版本的代码读它时必须能原样
 * 展示出来，而不是因为「类型上不该出现」就丢掉。写的一侧由 service 收口，只写
 * `EVENT_LOG_ACTIONS` 里那三个；读的一侧用 `isEventLogAction` 判断认不认识，不认识
 * 就把动作码本身显示出来。把类型收窄成联合类型会让「库里有第四种动作」这件事在
 * 类型层面撒谎。
 */
export type EventLog = {
  id: string
  action: string
  fromStatus: EventStatus | null
  toStatus: EventStatus | null
  /** 变更备注，可选。 */
  comment: string | null
  /** 操作人显示名快照；账号被物理清理后为 null，历史仍保留。 */
  actor: string | null
  createdAt: string
}

export type EventListResponse = {
  events: readonly Event[]
}

export type EventResponse = {
  event: Event
}

export type EventLogListResponse = {
  logs: readonly EventLog[]
}

/** 一个标签及其未删除事件条数。 */
export type EventTagCount = {
  tag: string
  count: number
}

export type EventTagListResponse = {
  tags: readonly EventTagCount[]
}

/**
 * 新增请求。
 *
 * 不含 `status` 与完成信息：新建的事件一律是 `todo`，完成时刻与完成人是「用户事后
 * 对这条事件做的动作」的产物，不是它出生时的属性。让客户端传意味着它要对这两个
 * 状态负责，而它与纪要的 `pinned` / `archivedAt` 是同一条取舍。
 *
 * `description` 与 `tags` 可省略，省略与空值合并成同一个值：两种空会在计数与展示上
 * 产生分歧，而它们对用户是同一件事。
 */
export type CreateEventRequest = {
  title: string
  description?: string
  priority?: EventPriority
  tags?: readonly string[]
  dueAt?: string | null
}

/**
 * 修改请求。所有字段可选，只改传入的那些。
 *
 * 与 `UpdateNoteRequest` 同一条取舍：写成「缺省时填回原值」会让每次修改都触碰所有
 * 列，`updatedAt` 随之变化，而「这一行到底改了什么」就看不出来了。
 *
 * 不含 `status`：状态变更走独立接口，因为它是唯一需要留痕的改动，而混进来会让
 * 「什么时候该追加日志」变成一件需要判断的事 —— 放在接口层就分清楚。
 *
 * `dueAt` 显式传 `null` 表示清除截止时间。这里「没传」与「传 null」必须区分开，
 * 因此不跟随筛选对象那种「缺失即 undefined 等价」的宽松处理。
 */
export type UpdateEventRequest = {
  title?: string
  description?: string
  priority?: EventPriority
  tags?: readonly string[]
  dueAt?: string | null
}

/**
 * 状态切换。用 PUT 而不是 POST：它替换的是「这条事件处于哪个状态」这个整体，天然
 * 幂等 —— 重复提交 `{ status: 'done' }` 的结果一样，也不会写出第二条日志。
 *
 * 勾选完成与撤销共用这一条：撤销就是把它设回 `todo`。分两条接口会增加一处权限与
 * 归属校验的复制，而它们的参数、返回值、失败处理完全相同。
 */
export type SetEventStatusRequest = {
  status: EventStatus
  /** 变更备注，可选。撤销时说明原因。 */
  comment?: string | null
}

/** 删除响应。软删除是幂等的，`removed` 说明本次是否真的改动了一行。 */
export type DeleteEventResponse = {
  removed: boolean
}
