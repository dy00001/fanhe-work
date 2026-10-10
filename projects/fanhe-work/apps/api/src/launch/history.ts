import { isLaunchRunOutcome, type LaunchRunOutcomeCode, type LaunchRunRecord } from '@fanhe/shared'

import { prisma } from '../db/prisma.js'

/**
 * 启动记录的写入与查询。
 *
 * 它回答的是界面上那两句话：「这条配置现在能不能启动」（路径状态，见 `agent.ts`）与
 * 「它多久没成功启动过了」（本模块）。前者靠一次 stat，后者只能靠历史 —— 进程创建
 * 那一刻的信息没有别的地方会留下来。
 *
 * **写记录不是主流程。** 调用它时启动尝试已经有了结果，记录写不进去不该改变真实
 * 结果：因此写入失败一律吞掉并出声，与 `audit.ts` 的 `recordAudit` 同一条
 * 取舍。这也是 agent 模块刻意不碰数据库的原因 —— 见 `agent.ts` 顶部。
 *
 * **保留策略与 `audit_logs` 相反。** 这张表会被反复写入，且只服务于最近的情况，
 * 因此按用户保留最近若干条，写入时顺带清理。审计日志要长期保留且不可删，两者的
 * 取舍标准是「出事时这条记录还有没有用」。
 */

/**
 * 每个用户保留的启动记录条数上限。
 *
 * 用条数而不是天数：个人工作台的启动频率完全不可预测（一天点三十次与三个月点一次
 * 都正常），按天数保留会让表的规模取决于使用强度，而按条数给出的上界是确定的 ——
 * 表的大小 = 用户数 × 这个值，可以直接算出来。
 *
 * 500 条限定近期摘要的规模，不保证每条配置永久保留最后成功。清理挂在写入路径上，
 * 不另开定时任务：表只在写入时增长，闲置用户无需定时扫描。
 */
export const LAUNCH_HISTORY_MAX_PER_USER = 500

/**
 * 结构化的最小日志接口。console 与 Fastify 的 logger 都满足它。
 *
 * 与 `agent.ts` 里 `LaunchLogger` 同一个形状、同一条理由：本模块要在两种宿主里运行
 * （api 进程与将来的外壳主进程），不能依赖某一种日志实现。
 */
export type LaunchHistoryLogger = {
  error: (context: unknown, message?: string) => void
}

export type LaunchRunRecordInput = {
  userId: string
  profileId: string
  /** 配置名的快照，见 schema 中该列的注释。 */
  profileName: string
  /** 路径的快照，同上。 */
  executablePath: string
  outcome: LaunchRunOutcomeCode
  /** 子进程 id。失败时为 null。 */
  pid: number | null
  /** 结果确认时刻；成功时沿用代理的进程创建时刻，不受后续写库延迟影响。 */
  startedAt?: string
}

export type LaunchHistoryOptions = {
  logger?: LaunchHistoryLogger
  /**
   * 覆盖保留条数。只为测试而存在：验证清理逻辑要造出超过上限的记录，而用真实的
   * 500 会让那条用例写入五百行。生产路径一律用默认值。
   */
  maxPerUser?: number
}

type HistoryRow = {
  id: string
  profileId: string
  outcome: string
  pid: number | null
  startedAt: Date
}

function toRecord(row: HistoryRow): LaunchRunRecord {
  return {
    id: row.id,
    profileId: row.profileId,
    // 库侧没有约束（理由见共享包该函数的注释），所以这里是唯一的收窄点。认不出的
    // 取值按失败处理：它只可能来自手工改库或回滚到旧版本，而把那种行显示成
    // 「启动成功」是最坏的结果。
    outcome: isLaunchRunOutcome(row.outcome) ? row.outcome : 'spawn_failed',
    pid: row.pid,
    startedAt: row.startedAt.toISOString(),
  }
}

/**
 * 写入一条启动记录。
 *
 * **记真实启动尝试，成功与失败都记，去重请求不记。** 去重调用复用上一次的结果，
 * 再记会让连点变成多条指向同一 pid 的成功记录。判断留给拿到代理结果的调用方。
 */
export async function recordLaunchRun(
  input: LaunchRunRecordInput,
  options: LaunchHistoryOptions = {},
): Promise<void> {
  const logger = options.logger ?? console
  const maxPerUser = options.maxPerUser ?? LAUNCH_HISTORY_MAX_PER_USER

  try {
    await prisma.launchHistory.create({
      data: {
        userId: input.userId,
        profileId: input.profileId,
        profileName: input.profileName,
        executablePath: input.executablePath,
        outcome: input.outcome,
        pid: input.pid,
        ...(input.startedAt === undefined ? {} : { startedAt: new Date(input.startedAt) }),
      },
    })
    await trimHistory(input.userId, maxPerUser)
  } catch (error) {
    // 吞掉异常但出声：历史是辅助信息，不能把已确认的启动结果替换成写库失败。
    logger.error({ err: error, profileId: input.profileId }, '启动记录写入失败')
  }
}

/**
 * 清掉超出保留条数的旧记录。
 *
 * 排序的次级键取 id：同一个毫秒内写入的多条记录单靠 `startedAt` 分不出先后，而
 * 「保留最近 N 条」在并列时若由数据库随便挑，就可能把刚写进去的那一条当成最旧的删掉。
 * id 用作稳定的次级排序键；同毫秒的 uuid v7 不保证生成先后顺序，但能消除并列歧义。
 */
async function trimHistory(userId: string, maxPerUser: number): Promise<void> {
  const stale = await prisma.launchHistory.findMany({
    where: { userId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    skip: maxPerUser,
    select: { id: true },
  })
  if (stale.length === 0) return

  await prisma.launchHistory.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } })
}

/**
 * 每条配置最近一次启动。
 *
 * 先按配置与时间倒序排列，再用 Prisma 的 distinct 取每组第一条，避免逐配置查询。
 * 不假定 distinct 会生成原生 DISTINCT ON：Prisma 可在客户端去重，读取规模由每用户
 * 500 条保留窗口限制。这里的排序决定「最新」的语义，而非依赖数据库默认行顺序。
 */
export async function loadLastRuns(
  userId: string,
  profileIds: readonly string[],
): Promise<Map<string, LaunchRunRecord>> {
  if (profileIds.length === 0) return new Map()

  const rows = await prisma.launchHistory.findMany({
    where: { userId, profileId: { in: [...profileIds] } },
    orderBy: [{ profileId: 'asc' }, { startedAt: 'desc' }, { id: 'desc' }],
    distinct: ['profileId'],
    select: { id: true, profileId: true, outcome: true, pid: true, startedAt: true },
  })

  return new Map(rows.map((row) => [row.profileId, toRecord(row)]))
}

/**
 * 每条配置最近一次**成功**启动的时刻。
 *
 * 与 `loadLastRuns` 分开，是因为最近一次失败时用户真正想知道的是「上一次成功是什么
 * 时候」。单独限定 success 能把两种语义区分开；摘要仅覆盖保留窗口，旧成功记录
 * 被清理后返回 null，不表示这条配置在全部历史中从未成功。
 */
export async function loadLastSuccessAt(
  userId: string,
  profileIds: readonly string[],
): Promise<Map<string, string>> {
  if (profileIds.length === 0) return new Map()

  const rows = await prisma.launchHistory.findMany({
    where: { userId, profileId: { in: [...profileIds] }, outcome: 'success' },
    orderBy: [{ profileId: 'asc' }, { startedAt: 'desc' }, { id: 'desc' }],
    distinct: ['profileId'],
    select: { profileId: true, startedAt: true },
  })

  return new Map(rows.map((row) => [row.profileId, row.startedAt.toISOString()]))
}
