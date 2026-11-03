import type { MergeQuoteItemsResponse, QuoteSource } from '@fanhe/shared'

import { prisma } from '../db/prisma.js'

import type { QuoteWriteAccess } from './access.js'
import { bumpDataset } from './store.js'

/**
 * 把同一个分类里的多条产品折叠成一条。
 *
 * ## 为什么这是「下架」而不是「删除」
 *
 * 历史报价单上印着条目号（`A037`）。物理删掉那一行，报价单上的编号就查不到任何
 * 东西 —— 客户来问「这一条当时为什么这么算」，只能回答「没有这条」。所以被折叠的行
 * 一律转 `archived`：搜索里不出现、维护台勾「含已下架」能看到、`PUT /items/:code/status`
 * 能单独上架回来。
 *
 * ## 归集规则（按顺序，全部可回溯）
 *
 * 1. **名称、型号、规格、分类、备注、条目号**：一律取 `keep` 那条，一个字都不动。
 *    合并是「把别的行收进来」，不是「重新生成一条」—— 台账原文改了就再也没法跟纸质
 *    表对号。
 * 2. **价格**：`keep` 的价格是空的（`priceKind === 'empty'`）时，从被折叠的行里按
 *    条目号顺序取第一条有价的抄过来。`keep` 本来有价就不动 —— 不做「取平均」「取最低」，
 *    那种规则没人能在事后解释清楚。
 * 3. **商品图**：`keep` 没有图时，从被折叠的行里取第一条有图的那张（键照抄）。
 * 4. **被折叠的行**：只改 `status = 'archived'` 与 `dataset_version`，其余字段原样。
 *
 * 第 2、3 条补了什么会回传给界面（`inherited`），并且单独进审计 —— 否则「合并完价格
 * 多出来了」是件让人怀疑数据被改过的事。
 */

export type ItemMergeFailure =
  | 'too_few'
  | 'not_found'
  /** 混进了别的分类 / 别的来源的条目。跨分类合并本质是改分类，不是合并。 */
  | 'cross_category'
  /** `keep` 不在候选里。 */
  | 'bad_target'
  /** 候选里有已下架的条目 —— 只合并还在售的。 */
  | 'inactive'

export type ItemMergeResult =
  { ok: true; value: MergeQuoteItemsResponse } | { ok: false; reason: ItemMergeFailure }

type Operator = { userId: string; access: QuoteWriteAccess }

export async function mergeItems(
  input: {
    source: QuoteSource
    category: string
    codes: readonly string[]
    keep: string
  },
  operator: Operator,
): Promise<ItemMergeResult> {
  // 去重再数：前端多选里出现重复 code 时不该报「太少」。
  const codes = [...new Set(input.codes.map((code) => code.trim()).filter((code) => code !== ''))]
  if (codes.length < 2) return { ok: false, reason: 'too_few' }
  if (!codes.includes(input.keep)) return { ok: false, reason: 'bad_target' }

  const rows = await prisma.quoteItem.findMany({
    where: { code: { in: codes } },
    select: {
      code: true,
      source: true,
      category: true,
      ledgerNo: true,
      status: true,
      priceKind: true,
      priceFen: true,
      priceText: true,
      imageKey: true,
    },
  })
  if (rows.length !== codes.length) return { ok: false, reason: 'not_found' }
  if (rows.some((row) => row.status !== 'active')) return { ok: false, reason: 'inactive' }
  if (rows.some((row) => row.source !== input.source || row.category !== input.category)) {
    return { ok: false, reason: 'cross_category' }
  }

  const kept = rows.find((row) => row.code === input.keep)
  if (kept === undefined) return { ok: false, reason: 'bad_target' }

  // 按条目号排，让「取第一条有价的」是可复现的规则，而不是「数据库返回的顺序」。
  const others = rows
    .filter((row) => row.code !== input.keep)
    .sort((a, b) => a.ledgerNo.localeCompare(b.ledgerNo, 'zh'))

  const inherited: string[] = []
  const patch: {
    datasetVersion: string
    priceKind?: string
    priceFen?: number | null
    priceText?: string
    imageKey?: string
  } = { datasetVersion: '' }

  if (kept.priceKind === 'empty') {
    const donor = others.find((row) => row.priceKind !== 'empty')
    if (donor !== undefined) {
      patch.priceKind = donor.priceKind
      patch.priceFen = donor.priceFen
      patch.priceText = donor.priceText
      inherited.push('价格')
    }
  }
  if (kept.imageKey === null) {
    const donor = others.find((row) => row.imageKey !== null)
    if (donor !== undefined && donor.imageKey !== null) {
      patch.imageKey = donor.imageKey
      inherited.push('商品图')
    }
  }

  const version = await bumpDataset(
    `产品合并：${input.category} 保留 ${kept.ledgerNo || kept.code}`,
  )
  patch.datasetVersion = version

  const archivedCodes = others.map((row) => row.code)
  const summary = others.map((row) => row.ledgerNo || row.code).join('、')

  await prisma.$transaction([
    prisma.quoteItem.update({ where: { code: kept.code }, data: patch }),
    prisma.quoteItem.updateMany({
      where: { code: { in: archivedCodes } },
      data: { status: 'archived', datasetVersion: version },
    }),
    // 保留条这一行记汇总：翻审计的人先看到「这三条并进了哪一条」，再往下看每一条的去向。
    prisma.quoteRevision.create({
      data: {
        itemCode: kept.code,
        field: 'product',
        oldValue: `合并 ${String(others.length)} 条：${summary}`.slice(0, 400),
        newValue: inherited.length === 0 ? '保留' : `保留（继承${inherited.join('、')}）`,
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: '产品合并，其余转已下架',
      },
    }),
    ...others.map((row) =>
      prisma.quoteRevision.create({
        data: {
          itemCode: row.code,
          field: 'status',
          oldValue: 'active',
          newValue: 'archived',
          operatorId: operator.userId,
          unlockSessionId: operator.access.unlockSessionId,
          reason: `合并到 ${kept.ledgerNo || kept.code}`,
        },
      }),
    ),
  ])

  return {
    ok: true,
    value: { version, kept: kept.code, archived: others.length, inherited },
  }
}
