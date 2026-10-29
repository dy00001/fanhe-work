/**
 * 读取 Obsidian「客户聊天记录库」里的群文件，抽出「聊天事实」。
 *
 * 这一层不碰数据库、不碰 Prisma，纯函数进出，因此可以拿一段文本直接测。
 *
 * ## 每次重解整份文件，不做增量
 *
 * 抓取任务每次重写整个 md：`msg_count`、`date_range`、正文表格一起变，文件里
 * 没有「上次读到哪」的锚点。所以同步只能整份重解。60 个文件共 3.4MB，实测
 * 百毫秒级 —— 做增量的复杂度换不来任何速度。
 *
 * ## 按 `username` 匹配，不按文件名
 *
 * 文件名就是群名，群一改名文件就改名。frontmatter 里的 `username` 形如
 * `56024028793@chatroom`，与 `customers.chatroom` 是同一个值，改名后仍然对得上。
 * 按文件名匹配的症状是「这个客户昨天还在列表里，今天没了」，而且**不会报错** ——
 * 少掉的行看起来和「客户本来就少」完全一样。
 *
 * ## 与 `tools/crm/dryrun.mjs` 的关系
 *
 * 那边有一套同名同义的解析（建表前的一次性干跑工具）。两边的消息行正则、跳过
 * 条数正则、frontmatter 取字段方式必须一致，否则会算出两个不同的 `msgRows`。
 * 因此 `tools/crm` 那套只用于历史核对，**日常链路只走这里**；改动任一侧都要跑
 * `test/archive.test.ts` 的样本断言。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 消息行固定为 `| YYYY-MM-DD HH:MM | 发送人 | 内容 |`。 */
const MESSAGE_LINE = /^\| \d{4}-\d{2}-\d{2} \d{2}:\d{2} \|/

/** 从消息行里取时间，不带时区。时区换算统一在 `parseLogTime` 做。 */
const MESSAGE_TIME = /^\| (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \|/

export type ArchiveStats = {
  /**
   * 群文件名，**含 `.md`**。写进 `customers.groupFile`，也用于排障。
   *
   * 带后缀是历史约定的延续：建表前那批 53 条（来自预览 JSON）存的就是
   * `上海树姐VIP设计沟通群.md`。剥掉后缀的代价是**每一轮同步都判定这 53 条
   * 全部「有变化」**，报告里永远是「更新 53」—— 数字本身看起来正常，但它把
   * 真正的变化埋得一点痕迹都不剩。
   */
  file: string
  /** 不含 `.md` 的基名。排除清单按群名维护，比对用这个。 */
  baseName: string
  /** 形如 `56024028793@chatroom`。缺失表示这不是一个客户群文件。 */
  chatroom: string | null
  /** 正文表格里的消息行数。以它为准，不用 frontmatter 的声明值。 */
  msgRows: number
  /** frontmatter 声明的条数，仅用于对账：两者不一致说明文件被手改过。 */
  declaredMsgCount: number | null
  /** `YYYY-MM-DD HH:MM`，本地时间，无时区。 */
  firstMessageAt: string | null
  lastMessageAt: string | null
  skipImg: number
  skipVoice: number
  /** AI 阶段原文，如「已下单」。到契约状态的映射见 `stage-rules.ts`。 */
  aiStage: string | null
  aiStageConf: number | null
}

export type ArchiveReadFailure = {
  file: string
  reason: 'unreadable' | 'no_chatroom'
}

export type ArchiveReadResult = {
  stats: ArchiveStats[]
  failures: ArchiveReadFailure[]
}

/**
 * frontmatter 有两块是常态（实测 44/55 个文件）：业务字段（`ai_schema`、金额、
 * `ai_stage`）在一块，身份字段（`username`、`msg_count`）在另一块。
 */
function splitFrontmatter(text: string): { standard: string; ai: string; count: number } {
  const parts = text.split(/^---$/m)
  const blocks: string[] = []
  for (let i = 1; i < parts.length; i += 2) {
    const block = parts[i]
    if (block !== undefined) blocks.push(block)
  }
  return {
    standard: blocks.find((b) => /^username:/m.test(b)) ?? '',
    ai:
      blocks.find((b) => /^ai_schema:/m.test(b)) ?? blocks.find((b) => /^合同金额:/m.test(b)) ?? '',
    count: blocks.length,
  }
}

/**
 * 取一个 frontmatter 字段。
 *
 * 必须用 `[ \t]*` 而不是 `\s*`：`\s` 含换行，空值字段会把下一行的内容当成自己的
 * 值。实测「合同金额:」为空时，取到的是下一行的「已收金额: 0」。
 */
function getField(block: string, key: string): string | null {
  const m = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
  if (!m) return null
  const value = (m[1] ?? '').trim().replace(/^"(.*)"$/, '$1')
  return value === '' ? null : value
}

/**
 * 解一份群文件。
 *
 * `msgRows` 取正文实际行数而不是 `msg_count`：后者是抓取脚本自己写的声明值，
 * 两者在 60 个文件上当前一致，但声明值出错时我们没有任何独立校验手段。
 */
export function parseArchiveText(text: string, file: string): ArchiveStats {
  const fm = splitFrontmatter(text)

  const lines = text.split('\n')
  let msgRows = 0
  let firstMessageAt: string | null = null
  let lastMessageAt: string | null = null
  for (const line of lines) {
    if (!MESSAGE_LINE.test(line)) continue
    msgRows += 1
    const m = line.match(MESSAGE_TIME)
    const time = m?.[1] ?? null
    if (time === null) continue
    if (firstMessageAt === null) firstMessageAt = time
    lastMessageAt = time
  }

  const skipImg = Number((text.match(/已跳过\s*(\d+)\s*条图片消息/) ?? [])[1] ?? 0)
  const skipVoice = Number((text.match(/语音消息\s*(\d+)\s*条/) ?? [])[1] ?? 0)
  const declared = Number(getField(fm.standard, 'msg_count') ?? 0)

  return {
    file,
    baseName: file.replace(/\.md$/, ''),
    chatroom: getField(fm.standard, 'username'),
    msgRows,
    declaredMsgCount: Number.isFinite(declared) && declared > 0 ? declared : null,
    firstMessageAt,
    lastMessageAt,
    skipImg: Number.isFinite(skipImg) ? skipImg : 0,
    skipVoice: Number.isFinite(skipVoice) ? skipVoice : 0,
    aiStage: getField(fm.ai, 'ai_stage') ?? getField(fm.ai, '阶段'),
    aiStageConf: Number(getField(fm.ai, 'ai_stage_conf') ?? 0) || null,
  }
}

/** 目录下的群文件名（**含 `.md`**），按名称排序便于报告稳定。 */
export function listArchiveFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort()
}

/**
 * 读一整个目录。
 *
 * 单文件读失败不中断整轮：一个 3.4MB 的库里有 60 个文件，任何一个被编辑器锁住
 * 都不该让当天所有客户停止更新。失败项进 `failures`，由调用方决定怎么报。
 */
export function readArchiveDir(dir: string): ArchiveReadResult {
  const stats: ArchiveStats[] = []
  const failures: ArchiveReadFailure[] = []

  for (const file of listArchiveFiles(dir)) {
    let text: string
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8')
    } catch {
      failures.push({ file, reason: 'unreadable' })
      continue
    }
    const parsed = parseArchiveText(text, file)
    if (parsed.chatroom === null) {
      // 「客户关注点总结」「客户订单进度总台账」这类汇总文档落在同一目录里，
      // 它们没有 username。不是错误，只是不属于客户群。
      failures.push({ file, reason: 'no_chatroom' })
      continue
    }
    stats.push(parsed)
  }

  return { stats, failures }
}
