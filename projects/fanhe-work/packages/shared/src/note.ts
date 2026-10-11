/**
 * 工作纪要的跨进程结构。
 *
 * 与 launch.ts 的分工一致：这里只放**传输形态与取值规则**，不放行为。纪要的读写、
 * 归属校验与排序留在 apps/api 内部；而「什么算合法的标签」「标题长度上限是多少」
 * 这类判断放在这里，因为前端表单要即时提示、服务端要强制校验，两边必须共用同一条
 * 规则 —— 各写一份的结果是「表单说可以，提交后 400」。
 *
 * **正文按 Markdown 原文存，不存渲染结果。** 渲染是前端的事（T3-06），存渲染后的
 * HTML 意味着换一个渲染器就要重写全部历史数据，而且 HTML 里能塞脚本，读到它的人
 * 会面临一次注入。原文是唯一的事实来源，渲染只是它的一种投影。
 *
 * **标签用字符串数组，不另开关联表。** 个人工作台的标签是轻量场景：没有颜色、
 * 描述这类独立元数据，也不需要跨用户共享。开一张 tags 表加一张 note_tags 关联表，
 * 换来的查询能力（标签重命名、标签统计）用数组加一次聚合也能做到，而代价是两处
 * 级联维护与两次连接查询。这条判断与 `LaunchProfile.args` 用 `String[]` 同源。
 */

/**
 * 字段长度上限。路由 schema 与 service 校验共用一份。
 *
 * 上限存在的理由与启动配置相同：没有上限时，一个几 MB 的请求体会先被完整读进来
 * 再交给校验。正文上限给到 10 万字符，是按「一篇长文」的量级留的余量，它不是业务
 * 约束，而是防超大请求体的闸门。改列宽时要连同这里一起改。
 */
export const NOTE_LIMITS = {
  TITLE_MAX: 200,
  CONTENT_MAX: 100_000,
  TAG_MAX: 32,
  TAGS_MAX_COUNT: 20,
} as const

/**
 * 一条工作纪要。
 *
 * 时间字段是 ISO 字符串而不是 Date，与 `LaunchProfile` 同一条理由：跨进程传输的
 * JSON 里没有 Date 类型。
 *
 * `archivedAt` 用「时刻」而不是布尔：归档这个动作本身有先后，而「什么时候归档的」
 * 在回头看时是有用的信息（例如「这个月归档了哪些」）。为 null 表示未归档。这与
 * `deletedAt` 的软删除表达同构，区别在于归档的纪要仍然可读、可恢复，删除的不再
 * 出现在任何默认视图里。
 */
export type Note = {
  id: string
  /** 标题。 */
  title: string
  /** 正文，Markdown 原文。 */
  content: string
  /** 标签。已归一：去首尾空白、去重、无空串。 */
  tags: readonly string[]
  /** 是否置顶。置顶的排在列表最前。 */
  pinned: boolean
  /** 归档时刻，ISO 8601；未归档为 null。 */
  archivedAt: string | null
  createdAt: string
  updatedAt: string
}

export type NoteListResponse = {
  notes: readonly Note[]
}

export type NoteResponse = {
  note: Note
}

/**
 * 新增请求。
 *
 * 不含 `pinned` 与 `archivedAt`：新纪要一律不置顶、不归档。让客户端传意味着它要对
 * 这两个状态负责，而它们的语义是「用户事后对这条纪要做的动作」，不是它出生时的属性。
 *
 * `tags` 可省略，省略与空数组合并成同一个值：两种空会在重名判断与计数上产生分歧，
 * 而它们对用户是同一件事。
 */
export type CreateNoteRequest = {
  title: string
  content: string
  tags?: readonly string[]
}

/**
 * 修改请求。所有字段可选，只改传入的那些。
 *
 * 与 `UpdateLaunchProfileRequest` 同一条取舍：写成「缺省时填回原值」会让每次修改都
 * 触碰所有列，`updatedAt` 随之变化，而「这一行到底改了什么」就看不出来了。
 *
 * 不含 `pinned` 与 `archivedAt`：这两个状态各有独立接口。它们表达的是「用户对这条
 * 纪要做的动作」，与「编辑正文」是两件事，混在一条路径上会让失败处理与界面反馈都
 * 变复杂（改标题失败与置顶失败对用户是两回事）。
 */
export type UpdateNoteRequest = {
  title?: string
  content?: string
  tags?: readonly string[]
}

/** 置顶开关。用 PUT 是因为它替换的是这个布尔状态整体，天然幂等。 */
export type SetNotePinnedRequest = {
  pinned: boolean
}

/** 归档开关。语义与置顶同构，同样是幂等的整体替换。 */
export type SetNoteArchivedRequest = {
  archived: boolean
}

/** 删除响应。软删除是幂等的，`removed` 说明本次是否真的改动了一行。 */
export type DeleteNoteResponse = {
  removed: boolean
}

/** 一个标签及其未删除纪要条数。 */
export type NoteTagCount = {
  tag: string
  count: number
}

/**
 * 标签清单。供标签输入框给出候选。
 *
 * 单独一条接口而不是让前端从列表里自己聚合：列表分页之后，前端手上的那一页推不出
 * 全量标签，而标签候选恰恰需要全量 —— 少一个候选就意味着用户要么想起来原文，要么
 * 建一个新的近似标签，后者会让标签体系慢慢散掉。
 */
export type NoteTagListResponse = {
  tags: readonly NoteTagCount[]
}

/**
 * 标签归一化：去首尾空白、丢掉空串、按首次出现的顺序去重。
 *
 * 归一放在共享包而不是只放服务端，是因为前端也要在提交前把候选去重后显示出来。
 * 两边用同一份实现，才不会出现「界面显示三个标签、库里存了四个」这种计数对不上的
 * 情形。
 *
 * 去重按精确字符串比较，不做大小写折叠：中文标签没有大小写问题，而英文标签
 * 「Work」与「work」是否算同一个，取决于用户的意图，替用户决定反而会让他失去
 * 用大小写区分标签的能力。
 */
export function normalizeNoteTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of tags) {
    const tag = raw.trim()
    if (tag === '') continue
    if (seen.has(tag)) continue
    seen.add(tag)
    result.push(tag)
  }
  return result
}

/**
 * 判断一个标签是否合法。
 *
 * 只做长度判断，不限制字符集：标签是用户自己的分类词，允许中文、英文、数字与符号
 * 混排。长度上限与数据库列宽一致，两侧不一致时表现为「插入时才报错」，而不是
 * 「提交时就告诉用户太长了」。
 *
 * 逗号与换行会被前端用作输入分隔符，因此不在这里拦 —— 它们在那之前就被拆开了，
 * 能走到这里的已经是一个独立的标签。
 */
export function isValidNoteTag(value: string): boolean {
  return value.length > 0 && value.length <= NOTE_LIMITS.TAG_MAX
}
