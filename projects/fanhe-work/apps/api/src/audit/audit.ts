import type { AuditAction } from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import type { AuditResult, Prisma } from '../generated/prisma/client.js'

/**
 * 审计日志的写入入口。
 *
 * `audit_logs` 是追加写的流水表，只增不改不删，所以这里只有 create，没有 update 与
 * delete。它的保留策略与 `login_attempts` 正好相反：后者只覆盖一个限速窗口，超期
 * 必须清理；审计要长期保留，清理不在代码里做。
 *
 * 两条必须守住的规则。
 *
 * 一是**写入失败不能让主流程失败**。一次登录不该因为审计表出问题而登不进来，账号
 * 恢复脚本也不该因为同样的原因停住。但也不能静默吞掉：记录缺失意味着「出了事却查
 * 不到痕迹」，与没出事一样糟。所以捕获之后仍然出声。
 *
 * 二是**不许写入密码、令牌明文或它们的哈希**。审计是长期保留且 owner 可读的，
 * 凭证一旦落进去就没有回收的余地。
 *
 * 出错时走 console 而不是 Fastify 的 request.log，是因为写入点分布在 service 层，
 * 那里拿不到请求级的 logger。审计写入失败属于异常路径，此时留下一条带动作名的错误
 * 信息已经够定位。
 */

/** 结构化的最小日志接口。console 与 Fastify 的 logger 都满足它。 */
export type AuditLogger = {
  error: (context: unknown, message?: string) => void
}

/**
 * 请求级的审计上下文。服务层不持有 request，需要 ip 与 userAgent 的地方由调用方
 * 传进来。命令行入口没有这两项，留空即可。
 */
export type AuditContext = {
  ip?: string | undefined
  userAgent?: string | undefined
}

export type AuditRecord = {
  action: AuditAction
  /** 结果。默认 success，失败事件显式传 failure。 */
  result?: AuditResult | undefined
  /** 操作者。账号不存在、未认证或事件与具体账号无关时留空。 */
  actor?: { id: string; name: string } | undefined
  /** 操作对象。例如被整链撤销的会话、被创建的账号。 */
  target?: { type: string; id: string } | undefined
  /** 补充信息。**不得包含凭证。** */
  detail?: Prisma.InputJsonValue | undefined
  ip?: string | undefined
  userAgent?: string | undefined
}

export async function recordAudit(
  record: AuditRecord,
  logger: AuditLogger = console,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: record.action,
        result: record.result ?? 'success',
        actorId: record.actor?.id ?? null,
        // actorName 是快照，与 actorId 同时写入。外键用的是 SetNull 而不是 Cascade，
        // 账号被删除后 actorId 会置空；没有这份快照，「谁做的」这个问题在账号删除后
        // 就再没有答案了。
        actorName: record.actor?.name ?? null,
        targetType: record.target?.type ?? null,
        targetId: record.target?.id ?? null,
        ip: record.ip ?? null,
        userAgent: record.userAgent ?? null,
        // detail 为 null 与「没有这个键」在 Prisma 里是两种写法，只有显式给出
        // JsonNull / DbNull 才会写 NULL。这里干脆在缺省时整个键都不传，让列走它
        // 自己的默认值。
        ...(record.detail === undefined ? {} : { detail: record.detail }),
      },
    })
  } catch (error) {
    logger.error({ err: error, action: record.action }, '审计日志写入失败')
  }
}
