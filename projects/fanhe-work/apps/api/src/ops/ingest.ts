import {
  OPS_DIMENSION_TYPES,
  OPS_LIMITS,
  isValidOpsRange,
  opsRangeDays,
  type OpsCollectSource,
  type OpsDimensionType,
  type OpsIngestRequest,
  type OpsIngestResponse,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import type { Prisma } from '../generated/prisma/client.js'
import { fromDbDate, toDbDate } from './date.js'

/**
 * 采集数据入库。
 *
 * 这一层只做一件事：把「平台给了什么」写进库，并保证重复跑不产生新行。**不做
 * 口径推导、不做区间聚合、不做单位换算** —— 单位换算在采集侧的导出契约里完成了，
 * 再换一次就会有人把分当元乘除两遍。
 *
 * 三条纪律：
 *
 *   1. **幂等。** 同一份 payload 跑两次，结果完全一致，`revised` 只在「值与库里
 *      不同」时为真。平台会回溯改数（昨天的 GMV 今天变了），`revised` 是这件事
 *      唯一的痕迹，不能写成「只要写就 true」。
 *   2. **空不等于零。** payload 里 `null` 原样入库，不补 0。补 0 会让日均被系统
 *      性拉低，而且从数字上看不出来。
 *   3. **批次必留痕。** 每次写入都建一行 `EcomCollectRun`，哪怕最后失败。没有它，
 *      「昨天为什么没数」只能靠翻脚本日志，而计划任务的日志通常没人看。
 */

export type IngestFailureReason =
  'invalid_window' | 'invalid_shop' | 'invalid_daily' | 'invalid_dimension' | 'too_many_rows'

export type IngestResult =
  { ok: true; data: OpsIngestResponse } | { ok: false; reason: IngestFailureReason; detail: string }

const FAILURE_MESSAGE: Record<IngestFailureReason, string> = {
  invalid_window: '窗口不合法',
  invalid_shop: '店铺信息不合法',
  invalid_daily: '逐日数据不合法',
  invalid_dimension: '维度数据不合法',
  too_many_rows: '单次上报行数超出上限',
}

export function ingestFailureMessage(reason: IngestFailureReason): string {
  return FAILURE_MESSAGE[reason]
}

function fail(reason: IngestFailureReason, detail: string): IngestResult {
  return { ok: false, reason, detail }
}

/** 逐日一行与库里已有行是否不同。null 与 null 相同，null 与 0 不同。 */
function isRevised(
  next: {
    payAmountFen: number | null
    visitors: number | null
    payBuyers: number | null
    itemVisitors: number | null
  },
  prev: {
    payAmountFen: number | null
    visitors: number | null
    payBuyers: number | null
    itemVisitors: number | null
  },
): boolean {
  return (
    next.payAmountFen !== prev.payAmountFen ||
    next.visitors !== prev.visitors ||
    next.payBuyers !== prev.payBuyers ||
    next.itemVisitors !== prev.itemVisitors
  )
}

function isDimensionType(value: string): value is OpsDimensionType {
  return (OPS_DIMENSION_TYPES as readonly string[]).includes(value)
}

/**
 * 落库。
 *
 * 整个写入在一个事务里：逐日与维度必须同进同退。半截写入会让看板出现「日趋势有
 * 数、商品榜是上一期」的组合，而这种组合在界面上看不出异常 —— 数字都在，只是
 * 窗口不一致。
 */
export async function ingestOpsSnapshot(payload: OpsIngestRequest): Promise<IngestResult> {
  if (!isValidOpsRange(payload.window)) {
    return fail(
      'invalid_window',
      `窗口 ${payload.window.from} ~ ${payload.window.to} 非法：需为 YYYY-MM-DD 且跨度 1 到 ${OPS_LIMITS.RANGE_MAX_DAYS} 天`,
    )
  }
  const statFrom = toDbDate(payload.window.from)
  const statTo = toDbDate(payload.window.to)
  if (statFrom === null || statTo === null) {
    return fail('invalid_window', '窗口日期无法解析成业务日')
  }

  const shopCode = payload.shop.code.trim()
  const shopName = payload.shop.name.trim()
  if (shopCode === '' || shopCode.length > OPS_LIMITS.SHOP_CODE_MAX) {
    return fail('invalid_shop', `店铺代号长度需在 1 到 ${OPS_LIMITS.SHOP_CODE_MAX} 之间`)
  }
  if (shopName === '' || shopName.length > OPS_LIMITS.SHOP_NAME_MAX) {
    return fail('invalid_shop', `店铺名称长度需在 1 到 ${OPS_LIMITS.SHOP_NAME_MAX} 之间`)
  }

  if (payload.daily.length > OPS_LIMITS.DAILY_MAX_ROWS) {
    return fail(
      'too_many_rows',
      `逐日行数 ${payload.daily.length} 超过 ${OPS_LIMITS.DAILY_MAX_ROWS}`,
    )
  }
  if (payload.dimensions.length > OPS_LIMITS.INGEST_DIMENSION_MAX) {
    return fail(
      'too_many_rows',
      `维度行数 ${payload.dimensions.length} 超过 ${OPS_LIMITS.INGEST_DIMENSION_MAX}`,
    )
  }

  // 逐日行先全部过一遍再写库：一条不合法就整批拒绝，不做「写一半、报一条」。
  const dailyRows: { statDate: Date; date: string; values: OpsIngestRequest['daily'][number] }[] =
    []
  const seenDates = new Set<string>()
  for (const row of payload.daily) {
    const statDate = toDbDate(row.date)
    if (statDate === null) return fail('invalid_daily', `日期 ${row.date} 不合法`)
    if (seenDates.has(row.date)) return fail('invalid_daily', `日期 ${row.date} 重复出现`)
    seenDates.add(row.date)
    if (row.date < payload.window.from || row.date > payload.window.to) {
      // 逐日行超出声明窗口，说明上报方的区间与数据不一致。放进去会让「区间求和」
      // 与「窗口」对不上，而这类错位只会在月末对账时暴露。
      return fail(
        'invalid_daily',
        `日期 ${row.date} 落在窗口 ${payload.window.from} ~ ${payload.window.to} 之外`,
      )
    }
    dailyRows.push({ statDate, date: row.date, values: row })
  }

  const dimensionRows: {
    type: OpsDimensionType
    key: string
    label: string
    metrics: Prisma.InputJsonObject
  }[] = []
  for (const row of payload.dimensions) {
    if (!isDimensionType(row.type)) {
      return fail('invalid_dimension', `未知维度类型 ${row.type}`)
    }
    const key = row.key.trim()
    const label = row.label.trim()
    if (key === '' || key.length > OPS_LIMITS.DIMENSION_KEY_MAX) {
      return fail('invalid_dimension', `维度键长度需在 1 到 ${OPS_LIMITS.DIMENSION_KEY_MAX} 之间`)
    }
    if (label === '' || label.length > OPS_LIMITS.DIMENSION_LABEL_MAX) {
      return fail(
        'invalid_dimension',
        `维度名称长度需在 1 到 ${OPS_LIMITS.DIMENSION_LABEL_MAX} 之间`,
      )
    }
    dimensionRows.push({
      type: row.type,
      key,
      label,
      metrics: row.metrics as Prisma.InputJsonObject,
    })
  }

  const source: OpsCollectSource = payload.source
  const startedAt = Date.now()

  const result = await prisma.$transaction(async (tx) => {
    const shop = await tx.ecomShop.upsert({
      where: { code: shopCode },
      create: {
        code: shopCode,
        name: shopName,
        platform: payload.shop.platform,
        sellerNick: payload.shop.sellerNick,
      },
      update: {
        name: shopName,
        platform: payload.shop.platform,
        sellerNick: payload.shop.sellerNick,
      },
      select: { id: true },
    })

    const run = await tx.ecomCollectRun.create({
      data: {
        shopId: shop.id,
        statFrom,
        statTo,
        trigger: payload.trigger.slice(0, OPS_LIMITS.TRIGGER_MAX),
        source,
        status: 'running',
        rawPath:
          payload.rawPath === null ? null : payload.rawPath.slice(0, OPS_LIMITS.RAW_PATH_MAX),
      },
      select: { id: true },
    })

    const existing = await tx.ecomDailyMetric.findMany({
      where: { shopId: shop.id, statDate: { in: dailyRows.map((row) => row.statDate) } },
      select: {
        statDate: true,
        payAmountFen: true,
        visitors: true,
        payBuyers: true,
        itemVisitors: true,
      },
    })
    const existingByDate = new Map(
      existing.map((row) => [
        fromDbDate(row.statDate) ?? '',
        {
          payAmountFen: row.payAmountFen,
          visitors: row.visitors,
          payBuyers: row.payBuyers,
          itemVisitors: row.itemVisitors,
        },
      ]),
    )

    let revisedDays = 0
    for (const row of dailyRows) {
      const next = {
        payAmountFen: row.values.payAmountFen,
        visitors: row.values.visitors,
        payBuyers: row.values.payBuyers,
        itemVisitors: row.values.itemVisitors,
      }
      const prev = existingByDate.get(row.date)
      const revised = prev !== undefined && isRevised(next, prev)
      if (revised) revisedDays += 1

      await tx.ecomDailyMetric.upsert({
        where: { shopId_statDate: { shopId: shop.id, statDate: row.statDate } },
        create: { shopId: shop.id, statDate: row.statDate, ...next, source },
        update: { ...next, source, revised, collectedAt: new Date() },
      })
    }

    for (const row of dimensionRows) {
      await tx.ecomDimensionSnapshot.upsert({
        where: {
          shopId_dimType_statFrom_statTo_dimKey: {
            shopId: shop.id,
            dimType: row.type,
            statFrom,
            statTo,
            dimKey: row.key,
          },
        },
        create: {
          shopId: shop.id,
          dimType: row.type,
          statFrom,
          statTo,
          dimKey: row.key,
          dimLabel: row.label,
          metrics: row.metrics,
        },
        update: { dimLabel: row.label, metrics: row.metrics, collectedAt: new Date() },
      })
    }

    /*
     * 清掉同一窗口里本次没上报的旧行。
     *
     * 为什么必须清：商品下架、渠道改名后，旧行会永远留在库里，而看板是「按窗口取
     * 这一批行」，多出来的行不会报错，只会让排行里出现早已不存在的对象。只清本窗口
     * 的行，历史窗口一行不动 —— 历史是既成事实，不该被今天的采集改写。
     */
    const keep = new Map<OpsDimensionType, string[]>()
    for (const row of dimensionRows) {
      const list = keep.get(row.type) ?? []
      list.push(row.key)
      keep.set(row.type, list)
    }
    for (const type of OPS_DIMENSION_TYPES) {
      const keys = keep.get(type) ?? []
      await tx.ecomDimensionSnapshot.deleteMany({
        where: {
          shopId: shop.id,
          dimType: type,
          statFrom,
          statTo,
          dimKey: { notIn: keys.length === 0 ? [''] : keys },
        },
      })
    }

    const status = dailyRows.length === 0 && dimensionRows.length === 0 ? 'failed' : 'succeeded'
    await tx.ecomCollectRun.update({
      where: { id: run.id },
      data: {
        status,
        dailyRows: dailyRows.length,
        dimensionRows: dimensionRows.length,
        finishedAt: new Date(),
        durationMs: Date.now() - startedAt,
        errorMessage: status === 'failed' ? '上报内容为空' : null,
      },
    })

    if (status === 'succeeded') {
      await tx.ecomShop.update({
        where: { id: shop.id },
        data: { lastCollectedAt: new Date() },
      })
    }

    return {
      shopId: shop.id,
      runId: run.id,
      dailyWritten: dailyRows.length,
      dimensionsWritten: dimensionRows.length,
      revisedDays,
    }
  })

  return {
    ok: true,
    data: {
      ...result,
      range: { from: payload.window.from, to: payload.window.to },
    },
  }
}

/** 供日志用的窗口摘要。天数一并给出，方便在日志里一眼看出是不是多传了区间。 */
export function describeOpsWindow(from: string, to: string): string {
  return `${from}~${to}（${opsRangeDays({ from, to })} 天）`
}
