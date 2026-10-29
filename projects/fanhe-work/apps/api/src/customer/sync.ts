/**
 * 每日同步：把 Obsidian「客户聊天记录库」的最新状态搬进工作台。
 *
 * 链路是 **抓取任务重写 md → 本脚本重解并更新库 → 前端照常读接口**。前端不需要
 * 任何改动就能看到新数字，因为列表的「N 条消息」「最近消息」、详情页的消息条数与
 * 首末时间早就在读这些列了。
 *
 * ## 为什么不能让 api 自己定时扫目录
 *
 * api 跑在容器里，compose 里**没有任何卷挂载**，看不到宿主机的 D 盘。容器内的
 * 定时任务永远扫出 0 个文件，而且它「成功跑完」—— 这类失败不会留下痕迹。
 * 所以同步必须由宿主机侧发起（与运营看板「采集机跑完 POST 进来」同一个约束）。
 *
 * ## 哪些字段无条件跟，哪些必须挡
 *
 * | 字段 | 处理 | 理由 |
 * |---|---|---|
 * | 消息条数、首末消息时间、图片/语音跳过数 | 无条件覆盖 | 聊天记录里的事实，重算永远比旧值更准 |
 * | 群文件名 | 无条件覆盖 | 群改名后要跟着变，否则排障时对不上文件 |
 * | 客户阶段 | **有条件**更新 | 阶段是人的判断，只有「未复核 + 非看板/人工来源」才跟 AI |
 * | 金额 | **绝不碰** | md 里 frontmatter 的金额是脏的（实测把手机号当合同额） |
 * | 订单与环节 | **绝不碰** | 来自看板的人工核验，不在这条链路上 |
 *
 * ## 阶段为什么默认不跟
 *
 * `ai_stage` 是模型从聊天里推断的，每天重跑结果可能来回跳。51 个待复核客户里
 * 大部分来源是 `ai_stage`，跟着更新是用户明确要的；但两类必须挡住：
 *   - 已复核（`reviewStatus !== 'pending'`）：人签过字，不能再被模型改动；
 *   - 来源是 `board` / `manual`：看板是人工核验过的订单事实，人工录入的是人填的，
 *     都不是模型能覆盖的。
 * 挡下来的客户进报告的 `stageHeld`，**不静默丢弃** —— 否则「为什么这个客户的
 * 阶段没跟着变」永远查不清。
 */

import fs from 'node:fs'

import {
  CUSTOMER_LIMITS,
  CUSTOMER_STAGES,
  customerDisplayName,
  customerShortName,
  normalizeRegion,
  type CustomerStage,
  type CreateCustomerRequest,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import { readArchiveDir, type ArchiveReadFailure, type ArchiveStats } from './archive.js'
import { insertCustomer, type CustomerArchiveExtras, type CustomerOrigin } from './customers.js'
import { parseLogTime } from './log-time.js'
import { arbitrateStage } from './stage-rules.js'

export type SyncOptions = {
  /** Obsidian 客户聊天记录库目录（绝对路径，宿主机上的）。 */
  chatDir: string
  /** 别名表，只用来读 `excludedGroups`（人工决定不收的群）。 */
  aliasesFile: string
  /** 只算不写。报告里的 `updated` / `created` 表示「将会」。 */
  dryRun: boolean
}

/** 阶段没跟的原因。逐条都不是异常，是设计。 */
export type StageHoldReason =
  'reviewed' | 'manual_authority' | 'board_authority' | 'no_evidence' | 'unchanged' | 'empty_file'

/** 新客户没建的原因。 */
export type SkipNewReason = 'excluded' | 'unreadable' | 'invalid' | 'empty_file'

export type SyncChange = {
  chatroom: string
  displayName: string
  /** 变了的列名，如 `['msgRows','lastMessageAt']`。 */
  fields: string[]
  /** 阶段变更时形如 `consulting → producing（ai_stage）`。 */
  stage?: string | undefined
}

export type SyncReport = {
  dryRun: boolean
  /** 目录里的 `.md` 文件数（含汇总文档）。 */
  scanned: number
  /** 带 `@chatroom` 的群文件数。 */
  groups: number
  /** 命中库内客户的群数。 */
  matched: number
  updated: number
  unchanged: number
  /** 新建的待复核客户数。 */
  created: number
  createdNames: string[]
  /** 库里有、但目录里找不到文件的客户。不删，只报告。 */
  missingFile: string[]
  duplicateChatrooms: { chatroom: string; files: string[] }[]
  failures: ArchiveReadFailure[]
  /** 被排除清单挡下的新群。 */
  skippedNew: { file: string; reason: SkipNewReason }[]
  stageChanged: number
  stageHeld: Record<StageHoldReason, number>
  changes: SyncChange[]
}

/** 库内客户的同步所需列。单独声明是为了让「同步会读哪些字段」一眼可见。 */
export type SyncExistingRow = {
  id: string
  chatroom: string
  displayName: string
  shortName: string
  reviewStatus: string
  stage: string
  stageSource: string
  msgRows: number
  firstMessageAt: Date | null
  lastMessageAt: Date | null
  skipImg: number
  skipVoice: number
  groupFile: string | null
}

/**
 * 聊天事实里要改的列。
 *
 * 字段写成**纯可选**（不带 `| undefined`）而不是 `?: X | undefined`：这个对象会
 * 被直接展开进 Prisma 的 update 入参，而 `exactOptionalPropertyTypes` 下
 * 「值为 undefined」与「没有这个键」不等价 —— 后者才是「这一列不动」的意思。
 * `diffActiveFields` 只在真变化时赋值，所以这里不会出现 undefined。
 */
export type ActivePatch = {
  msgRows?: number
  firstMessageAt?: Date
  lastMessageAt?: Date
  skipImg?: number
  skipVoice?: number
  groupFile?: string
}

const DATE_EPSILON = 0

function sameTime(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return Math.abs(a.getTime() - b.getTime()) <= DATE_EPSILON
}

/**
 * 算出「聊天事实」里哪几列需要改。
 *
 * **空文件一格都不改。** 抓取偶发失败会留下一个只有 frontmatter 的 md，此时
 * `msgRows = 0`、首末时间为 `null`。照直写下去会把一个聊了 628 条消息的客户
 * 清成「0 条消息、无最近消息」—— 而界面上它看起来只是「这个客户很久没说话了」，
 * 不会有人怀疑是同步写坏的。
 */
export function diffActiveFields(row: SyncExistingRow, stat: ArchiveStats): ActivePatch {
  if (stat.msgRows === 0) return {}

  const patch: ActivePatch = {}
  if (stat.msgRows !== row.msgRows) patch.msgRows = stat.msgRows

  const first = parseLogTime(stat.firstMessageAt)
  if (first !== null && !sameTime(first, row.firstMessageAt)) patch.firstMessageAt = first

  const last = parseLogTime(stat.lastMessageAt)
  if (last !== null && !sameTime(last, row.lastMessageAt)) patch.lastMessageAt = last

  if (stat.skipImg !== row.skipImg) patch.skipImg = stat.skipImg
  if (stat.skipVoice !== row.skipVoice) patch.skipVoice = stat.skipVoice
  if (stat.file !== row.groupFile) patch.groupFile = stat.file

  return patch
}

export type StageDecision =
  | { kind: 'update'; stage: CustomerStage; source: 'ai_stage' | 'ledger' }
  | { kind: 'hold'; reason: StageHoldReason }

/**
 * 阶段要不要跟。
 *
 * 顺序不能换：先挡已复核，再挡人工/看板来源，最后才仲裁。把「已复核」放到后面
 * 的结果是「人工确认过的阶段被 AI 推翻」—— 而那正是客户平台的 21 个权限点里
 * `customer.import.review` 存在的意义所在。
 */
export function decideStage(row: SyncExistingRow, aiStage: string | null): StageDecision {
  if (row.reviewStatus !== 'pending') return { kind: 'hold', reason: 'reviewed' }

  // `manual` 是人工录入与阶段推进接口写入的来源。复核被退回（改成 pending）时
  // 这一挡仍然有效：人填的东西不该因为「还没复核」就被模型改掉。
  if (row.stageSource === 'manual') return { kind: 'hold', reason: 'manual_authority' }

  // 看板是人工核验到环节的订单事实，优先级最高。**看板不在这条同步链路上**，
  // 所以来源为看板的客户一律不动，而不是拿 AI 重算一遍把看板结论冲掉。
  if (row.stageSource === 'board') return { kind: 'hold', reason: 'board_authority' }

  const arbitration = arbitrateStage({
    boardStage: null,
    aiStage,
    displayName: row.displayName,
    shortName: row.shortName,
  })

  if (arbitration.stage === null) return { kind: 'hold', reason: 'no_evidence' }
  if (arbitration.stage === row.stage) return { kind: 'hold', reason: 'unchanged' }
  if (!(CUSTOMER_STAGES as readonly string[]).includes(arbitration.stage)) {
    return { kind: 'hold', reason: 'no_evidence' }
  }

  const source = arbitration.source === 'ledger' ? 'ledger' : 'ai_stage'
  return { kind: 'update', stage: arbitration.stage, source }
}

/**
 * 从群文件名推客户名。
 *
 * 只剥后缀，不做别的猜测。推不准的代价是「新客户的名字是整条群名」，人工复核时
 * 改一下就好；而按关键词乱切（比如把「绿城」当人名）的代价是造出一个查无此人的
 * 客户，还会被当成真名去匹配看板与台账。
 */
export function nameFromGroupFile(file: string): string {
  const suffixes = [
    'VIP设计沟通交流群',
    'VIP设计沟通群',
    'VIP设计群',
    '设计沟通交流群',
    '设计沟通群',
    '装修沟通群',
    '装修交流群',
    '沟通群',
  ]
  let name = file.trim()
  for (const suffix of suffixes) {
    if (name.toLowerCase().endsWith(suffix.toLowerCase())) {
      name = name.slice(0, name.length - suffix.length).trim()
      break
    }
  }
  if (name === '') name = file.trim()
  return name.slice(0, CUSTOMER_LIMITS.REAL_NAME_MAX)
}

/** 新客户的地区一律 `待确认`。猜地区的代价见 `nameFromGroupFile` 的注释。 */
export const PENDING_REGION = '待确认'

export type NewCustomerPlan = {
  input: CreateCustomerRequest
  origin: CustomerOrigin
  extras: CustomerArchiveExtras
}

/**
 * 为「库里没有、排除清单也没有」的群拟一份客户档案。
 *
 * 置信度写 `none` 而不是 `low`：`low` 意味着「有身份判断，但不太确定」，而这里
 * 根本没有判断依据（没看聊天内容、没有别名表记录）。给 `none` 才能让复核队列
 * 把它们与「AI 抽出来待确认」的那批分开。
 */
export function planNewCustomer(stat: ArchiveStats): NewCustomerPlan | null {
  if (stat.chatroom === null) return null

  const realName = nameFromGroupFile(stat.baseName)
  if (realName.trim() === '') return null

  const region = normalizeRegion(PENDING_REGION)
  if (region.length > CUSTOMER_LIMITS.REGION_MAX) return null

  const arbitration = arbitrateStage({
    boardStage: null,
    aiStage: stat.aiStage,
    displayName: customerDisplayName(region, realName),
    shortName: customerShortName(realName, region),
  })

  const stage = arbitration.stage ?? 'consulting'

  return {
    input: {
      chatroom: stat.chatroom,
      realName,
      region,
      stage,
    },
    origin: {
      nameSource: 'groupname',
      confidence: 'none',
      reviewStatus: 'pending',
      stageSource: arbitration.stage === null ? 'none' : arbitration.source,
    },
    extras: {
      msgRows: stat.msgRows,
      firstMessageAt: parseLogTime(stat.firstMessageAt),
      lastMessageAt: parseLogTime(stat.lastMessageAt),
      skipImg: stat.skipImg,
      skipVoice: stat.skipVoice,
      groupFile: stat.file,
    },
  }
}

function emptyStageHeld(): Record<StageHoldReason, number> {
  return {
    reviewed: 0,
    manual_authority: 0,
    board_authority: 0,
    no_evidence: 0,
    unchanged: 0,
    empty_file: 0,
  }
}

/** 读别名表里的排除清单。文件缺失不是致命错误：新客户照建，报告里体现不出差异。 */
function readExcludedGroups(aliasesFile: string): Set<string> {
  try {
    const doc = JSON.parse(fs.readFileSync(aliasesFile, 'utf8')) as {
      excludedGroups?: unknown
    }
    const list = Array.isArray(doc.excludedGroups) ? doc.excludedGroups : []
    return new Set(list.filter((v): v is string => typeof v === 'string'))
  } catch {
    return new Set()
  }
}

export async function syncCustomersFromArchive(options: SyncOptions): Promise<SyncReport> {
  const { stats, failures } = readArchiveDir(options.chatDir)
  const excluded = readExcludedGroups(options.aliasesFile)

  // 同一个 chatroom 出现在两个文件里，说明有一个是复制/改名失败留下的。
  // 取先出现的那个（文件名排序稳定），其余进报告等人工处理。
  const byChatroom = new Map<string, ArchiveStats>()
  const duplicateChatrooms: { chatroom: string; files: string[] }[] = []
  for (const stat of stats) {
    if (stat.chatroom === null) continue
    const seen = byChatroom.get(stat.chatroom)
    if (seen === undefined) {
      byChatroom.set(stat.chatroom, stat)
      continue
    }
    const group = duplicateChatrooms.find((d) => d.chatroom === stat.chatroom)
    if (group === undefined) {
      duplicateChatrooms.push({ chatroom: stat.chatroom, files: [seen.file, stat.file] })
    } else {
      group.files.push(stat.file)
    }
  }

  const existing = await prisma.customer.findMany({
    select: {
      id: true,
      chatroom: true,
      displayName: true,
      shortName: true,
      reviewStatus: true,
      stage: true,
      stageSource: true,
      msgRows: true,
      firstMessageAt: true,
      lastMessageAt: true,
      skipImg: true,
      skipVoice: true,
      groupFile: true,
    },
  })
  const rowByChatroom = new Map<string, SyncExistingRow>(existing.map((row) => [row.chatroom, row]))

  const report: SyncReport = {
    dryRun: options.dryRun,
    scanned: stats.length + failures.length,
    groups: byChatroom.size,
    matched: 0,
    updated: 0,
    unchanged: 0,
    created: 0,
    createdNames: [],
    missingFile: [],
    duplicateChatrooms,
    failures,
    skippedNew: [],
    stageChanged: 0,
    stageHeld: emptyStageHeld(),
    changes: [],
  }

  for (const stat of byChatroom.values()) {
    // `byChatroom` 只收 `chatroom !== null` 的项，这里再判一次只为把类型收窄成
    // `string`：同名 null 在上面已经被 `continue` 掉了，走到这一行必不为空。
    const chatroom = stat.chatroom
    if (chatroom === null) continue
    const row = rowByChatroom.get(chatroom)
    if (row === undefined) {
      // 未入库的群：先看排除清单。清单按群名维护，所以这一步是全流程里唯一
      // 依赖文件名的地方 —— 已入库的客户按 chatroom 匹配，改名不影响。
      if (excluded.has(stat.baseName)) {
        report.skippedNew.push({ file: stat.file, reason: 'excluded' })
        continue
      }
      // 空文件不建客户：一条消息都没有的群文件通常是抓取失败留下的残骸，建进库
      // 就是一条「0 条消息、无最近消息」的假客户，而且它会一直躺在复核队列里。
      if (stat.msgRows === 0) {
        report.skippedNew.push({ file: stat.file, reason: 'empty_file' })
        continue
      }
      const plan = planNewCustomer(stat)
      if (plan === null) {
        report.skippedNew.push({ file: stat.file, reason: 'invalid' })
        continue
      }
      report.created += 1
      report.createdNames.push(plan.input.realName)
      if (!options.dryRun) {
        const created = await insertCustomer(plan.input, plan.origin, plan.extras)
        if (!created.ok) {
          report.created -= 1
          report.createdNames.pop()
          report.skippedNew.push({ file: stat.file, reason: 'invalid' })
        }
      }
      continue
    }

    report.matched += 1
    const fields: string[] = []
    const patch = diffActiveFields(row, stat)
    for (const key of Object.keys(patch)) fields.push(key)

    // 空文件连阶段也不判：抓取失败留下的残文件里，`ai_stage` 可能还是上一轮的
    // 旧值，照它算出来的阶段与「今天真的没聊」毫无关系。报告里记 `empty_file`
    // 是为了让「这个客户今天为什么没更新」有据可查，而不是顺手改点别的。
    const decision: StageDecision =
      stat.msgRows === 0 ? { kind: 'hold', reason: 'empty_file' } : decideStage(row, stat.aiStage)
    if (decision.kind === 'hold') {
      report.stageHeld[decision.reason] += 1
    } else {
      fields.push('stage')
    }

    if (fields.length === 0) {
      report.unchanged += 1
      continue
    }

    report.updated += 1
    const change: SyncChange = {
      chatroom,
      displayName: row.displayName,
      fields,
    }
    if (decision.kind === 'update') {
      report.stageChanged += 1
      change.stage = `${row.stage} → ${decision.stage}（${decision.source}）`
    }
    report.changes.push(change)

    if (options.dryRun) continue

    await prisma.customer.update({
      where: { id: row.id },
      data:
        decision.kind === 'update'
          ? { ...patch, stage: decision.stage, stageSource: decision.source }
          : patch,
    })
  }

  // 库里有、目录里没有：不删。客户是资产，文件删了可能是误删或换了存放目录，
  // 自动删除会让「客户清单少了三个人」这件事在几个月后被当成从没录过。
  //
  // 只报告**曾经有群文件**的那批。手工录入的客户（`chatroom` 是 `manual:` 前缀、
  // `groupFile` 为 null）本来就没有文件，把它们也列出来，等于每天在报告里堆一串
  // 永远存在的名字 —— 而一份「每天都有十几条提示」的报告，读的人第二周就不看了，
  // 真正「文件消失了」的那一条也就一起被忽略。
  for (const row of existing) {
    if (row.groupFile === null) continue
    if (!byChatroom.has(row.chatroom)) report.missingFile.push(row.displayName)
  }

  return report
}
