/**
 * 纪要草稿的本机暂存。
 *
 * 与 `lib/preferences.ts` 同源 —— 都落在浏览器 localStorage，换机、换浏览器、清缓存
 * 即丢，也不跨设备同步（跨设备是阶段五服务端化的事）—— 但**取舍相反**：那边的读写
 * 失败一律静默回落，因为它丢的只是「侧栏是宽是窄」；这里丢的是用户刚敲进去的工作，
 * 因此读失败仍然静默（等价于「没有草稿」，退回到没有这个功能之前的行为），写失败
 * 则先让掉一条最旧的再试一次，仍然失败才回调一次让界面告知用户「别以为存住了」。
 *
 * **槽（slot）名 = 编辑器的身份**，取自父组件传给编辑器 `key` 的那个值：
 * `fanhe-work.draft.note.<id>`（编辑已有纪要）与 `fanhe-work.draft.note.new`
 * （新建中尚未提交）。前缀与 `fanhe-work.ui.` 并列，既能按前缀整体清理，又不会碰到
 * 会话与凭据类数据。
 *
 * **值里带结构版本号 `v`。** 将来改结构（例如 `tags` 从数组变成字符串）时，没有版本
 * 号的旧草稿会把界面打崩；读到不认识的版本一律丢弃，**不做迁移** —— 草稿是可有可无的
 * 副本，为它写一套迁移逻辑，收益不抵它引入的分支。
 *
 * **只存本机、不进数据库、不进审计。** 与既有判断一致：纪要属私有用量，而一条尚未
 * 提交的草稿连「这条纪要存在」都还不成立。
 */

/** 草稿的值。字段与 `NoteEditor` 的表单值一致。 */
export type NoteDraftValues = {
  title: string
  content: string
  tags: string[]
}

/**
 * 落盘后再读回来的草稿。
 *
 * **不存 `noteId`**：槽名里已经有它，再存一份就会出现「槽名说 A、值里写 B」的漂移。
 * **存 `savedAt`**：过期清理的依据、提示条要说「上次自动保存于 X」、排查时唯一的
 * 时间线索。
 */
export type NoteDraft = NoteDraftValues & {
  /** 上次自动保存时刻，ISO 8601。 */
  savedAt: string
}

/** 实际写进存储的形态，比 `NoteDraft` 多一个版本号。 */
type StoredDraft = NoteDraft & { v: number }

/**
 * 存储接口。
 *
 * 刻意只暴露用到的四个方法，而不是直接摸 `window.localStorage`：单测在 Node 里跑，
 * 那里没有 `localStorage`，而给 `window` 打补丁会让测试与被测代码共用同一份全局状态
 * （用例之间互相污染，失败顺序还依赖执行顺序）。
 */
export interface DraftStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** 所有以 `prefix` 开头的键。清理只在这个范围内进行。 */
  keysWithPrefix(prefix: string): string[]
}

/** 草稿写入的可选项。 */
export type DraftWriteOptions = {
  /** 存储实现。省略时用浏览器 localStorage。 */
  storage?: DraftStorage
  /**
   * 写失败（写满了、存储被禁）时的回调。
   *
   * **只在彻底写不进去时调用一次**，不是每次输入都调：这条提示是「别以为存住了」的
   * 告知，重复弹的结果是用户学会忽略它，那它就不再是提示了。
   */
  onWriteError?: () => void
}

/**
 * 存储键前缀。**清理与容量统计一律以它为准**，绝不按前缀外扫 —— 扫到会话令牌那类
 * 数据再删掉，代价与「草稿多占了几十 KB」完全不成比例。前缀与既有的
 * `fanhe-work.ui.`（见 `lib/preferences.ts`）并列。
 */
const DRAFT_PREFIX = 'fanhe-work.draft.note.'

/** 新建中的槽名。整条前缀下只有它是固定的，其余都以纪要 id 结尾。 */
const NEW_SLOT = 'new'

/** 结构版本号。读到不等于它的值一律按损坏处理。 */
const DRAFT_VERSION = 1

/**
 * 草稿保留时长。
 *
 * 超过就清掉：一条一周前的未保存内容，用户多半已经忘了它是关于什么的，恢复出来反而
 * 像是界面自己冒出了一段来路不明的文字。7 天取在「周末没关电脑，周一回来还在」与
 * 「不留陈年垃圾」之间。
 */
const MAX_DRAFT_AGE_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 最多保留几条草稿。
 *
 * 单条理论上约 200KB（正文上限 10 万字符），而 localStorage 通常只有 5MB 配额，
 * 20 条足够覆盖「同时改着好些条」的真实场景。不做单条截断：把用户的正文砍掉一半
 * 再恢复出来，比不恢复更糟。
 */
const MAX_DRAFT_COUNT = 20

/** 把「编辑哪一条」折成一个存储键。`null` 表示新建。 */
export function draftKey(noteId: string | null): string {
  return `${DRAFT_PREFIX}${noteId ?? NEW_SLOT}`
}

/** 默认存储：浏览器 localStorage 的一层薄壳。 */
function browserStorage(): DraftStorage {
  return {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
    keysWithPrefix: (prefix) => {
      const matched: string[] = []
      // 逐下标取键而不是 Object.keys(localStorage)：后者的键顺序无保证，且在某些
      // 实现里会把原型属性也带出来。
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index)
        if (key !== null && key.startsWith(prefix)) matched.push(key)
      }
      return matched
    },
  }
}

/**
 * 读取某个槽里的草稿。没有、读不出、版本不认识、结构损坏、已过期，一律返回 `null`。
 *
 * **异常一律吞掉**：隐私模式、存储被禁、配额异常都可能让 `getItem` 直接抛。此时
 * 「没有草稿」是唯一安全的答案 —— 退回没有这个功能之前的行为，界面照常工作。
 */
export function readNoteDraft(
  noteId: string | null,
  storage: DraftStorage = browserStorage(),
): NoteDraft | null {
  const key = draftKey(noteId)

  let raw: string | null
  try {
    raw = storage.getItem(key)
  } catch {
    return null
  }
  if (raw === null) return null

  const draft = parseDraft(raw)
  // 结构损坏（旧版本留下的、手改过的）留着没有意义，顺手清掉；清不掉也不影响本次
  // 读取的结果。
  if (draft === null || isDraftEmpty(draft)) {
    removeQuietly(storage, key)
    return null
  }

  if (isExpired(draft.savedAt)) {
    removeQuietly(storage, key)
    return null
  }

  return draft
}

/**
 * 写入草稿。
 *
 * 三个字段全空时**清槽而不是写一条空草稿** —— 空草稿与「没有草稿」在界面上完全一样，
 * 留着只会在容量统计里占位。
 *
 * 写入前先做一次过期与容量清理（`sweepStale`），因此调用方不必自己找时机。
 */
export function writeNoteDraft(
  noteId: string | null,
  values: NoteDraftValues,
  options: DraftWriteOptions = {},
): void {
  const storage = options.storage ?? browserStorage()
  const key = draftKey(noteId)

  if (isValuesEmpty(values)) {
    removeQuietly(storage, key)
    return
  }

  sweepStale(storage, key)

  const stored: StoredDraft = {
    v: DRAFT_VERSION,
    title: values.title,
    content: values.content,
    // 拷贝一份而不是存引用：调用方传进来的多半就是组件当前的状态对象，存引用会让
    // 「写完之后又被就地改掉」这种事无声地改到已经落盘的内容上。
    tags: [...values.tags],
    savedAt: new Date().toISOString(),
  }
  const payload = JSON.stringify(stored)

  try {
    storage.setItem(key, payload)
    return
  } catch {
    // 多半是配额写满。让掉一条最旧的再试一次 —— 那一条正是最不可能还被需要的那条。
  }

  if (evictOldest(storage, key)) {
    try {
      storage.setItem(key, payload)
      return
    } catch {
      // 仍然写不进去，落到下面的回调。
    }
  }

  options.onWriteError?.()
}

/** 清掉一个槽的草稿。用户点「丢弃草稿」、以及保存成功之后调用。 */
export function clearNoteDraft(
  noteId: string | null,
  storage: DraftStorage = browserStorage(),
): void {
  removeQuietly(storage, draftKey(noteId))
}

/**
 * 两个值是否等价。
 *
 * 标题按 **trim 后**比较，正文与标签原样。这个不对称是有意的，与 `NoteEditor` 原先
 * 那份 `hasChanges` 完全同一口径：服务端保存标题时会 trim，正文不会（Markdown 里的
 * 前导空白有意义）。**两处规则合并到这一个函数**，各写一份的结果是「界面上看不出
 * 改动，草稿却一直存在」这类没人能一眼解释的现象。
 *
 * 标签按位置逐个比对，不排序：`['甲','乙']` 与 `['乙','甲']` 是两次不同的编辑。
 */
export function isSameDraftValues(
  saved: { title: string; content: string; tags: readonly string[] },
  current: { title: string; content: string; tags: readonly string[] },
): boolean {
  return (
    saved.title === current.title.trim() &&
    saved.content === current.content &&
    saved.tags.length === current.tags.length &&
    saved.tags.every((tag, index) => tag === current.tags[index])
  )
}

/** 三个字段是否全空。空草稿不落盘，见 `writeNoteDraft`。 */
function isValuesEmpty(values: {
  title: string
  content: string
  tags: readonly string[]
}): boolean {
  return values.title.trim() === '' && values.content.trim() === '' && values.tags.length === 0
}

/** 读回来的一份草稿是否全空。与 `isValuesEmpty` 同一判据，用在读侧。 */
function isDraftEmpty(draft: NoteDraft): boolean {
  return isValuesEmpty(draft)
}

/** 是否已超过保留时长。时间戳解析不出（手改过的）按过期处理。 */
function isExpired(savedAt: string): boolean {
  const timestamp = Date.parse(savedAt)
  if (Number.isNaN(timestamp)) return true
  return Date.now() - timestamp > MAX_DRAFT_AGE_MS
}

/** 反序列化。任何一处不符合预期都返回 `null`，绝不抛。 */
function parseDraft(raw: string): NoteDraft | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  // `typeof null === 'object'`，因此 null 要单独挡一次。
  if (typeof parsed !== 'object' || parsed === null) return null

  const record = parsed as Record<string, unknown>
  if (record.v !== DRAFT_VERSION) return null
  if (typeof record.title !== 'string') return null
  if (typeof record.content !== 'string') return null
  if (typeof record.savedAt !== 'string') return null
  if (!Array.isArray(record.tags)) return null

  const tags: unknown[] = record.tags
  if (!tags.every((tag) => typeof tag === 'string')) return null

  return {
    title: record.title,
    content: record.content,
    tags: tags as string[],
    savedAt: record.savedAt,
  }
}

/** 读一个键里的保存时刻。读不出、结构不认识都返回 `null`（调用方按最旧处理）。 */
function readSavedAt(storage: DraftStorage, key: string): number | null {
  try {
    const raw = storage.getItem(key)
    if (raw === null) return null
    const draft = parseDraft(raw)
    if (draft === null) return null
    const timestamp = Date.parse(draft.savedAt)
    return Number.isNaN(timestamp) ? null : timestamp
  } catch {
    return null
  }
}

/**
 * 写入前的清理：先扫过期，再在最坏情况下让位。
 *
 * `keepKey` 是本次即将写入的那个键，**不参与淘汰** —— 否则新写入的草稿会在同一轮里
 * 把自己清掉。
 */
function sweepStale(storage: DraftStorage, keepKey: string): void {
  let keys: string[]
  try {
    keys = storage.keysWithPrefix(DRAFT_PREFIX)
  } catch {
    return
  }

  const alive: { key: string; savedAt: number }[] = []
  for (const key of keys) {
    const savedAt = readSavedAt(storage, key)
    if (savedAt === null || Date.now() - savedAt > MAX_DRAFT_AGE_MS) {
      removeQuietly(storage, key)
      continue
    }
    if (key === keepKey) continue
    alive.push({ key, savedAt })
  }

  // 留出本次要写的那一个位置，因此边界是「不少于上限就再让一条」。
  alive.sort((a, b) => a.savedAt - b.savedAt)
  while (alive.length >= MAX_DRAFT_COUNT) {
    const oldest = alive.shift()
    if (oldest === undefined) break
    removeQuietly(storage, oldest.key)
  }
}

/**
 * 让掉一条最旧的草稿。返回是否真的让掉了 —— 没有可让的（只剩即将写入的那一条）时
 * 返回 `false`，调用方据此跳过重试。
 */
function evictOldest(storage: DraftStorage, keepKey: string): boolean {
  let keys: string[]
  try {
    keys = storage.keysWithPrefix(DRAFT_PREFIX)
  } catch {
    return false
  }

  const candidates: { key: string; savedAt: number }[] = []
  for (const key of keys) {
    if (key === keepKey) continue
    // 读不出时刻的按最旧处理：它的价值无从判断，而它占的位置是确定的。
    candidates.push({ key, savedAt: readSavedAt(storage, key) ?? 0 })
  }
  if (candidates.length === 0) return false

  candidates.sort((a, b) => a.savedAt - b.savedAt)
  const oldest = candidates[0]
  if (oldest === undefined) return false
  removeQuietly(storage, oldest.key)
  return true
}

/** 删一个键，失败不抛 —— 删不掉不是致命问题，留着一条过期草稿而已。 */
function removeQuietly(storage: DraftStorage, key: string): void {
  try {
    storage.removeItem(key)
  } catch {
    // 见上。
  }
}
