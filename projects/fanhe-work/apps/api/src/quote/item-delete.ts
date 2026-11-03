import type { DeleteQuoteItemResponse, QuoteSource } from '@fanhe/shared'

import { prisma } from '../db/prisma.js'

import type { QuoteWriteAccess } from './access.js'
import { bumpDataset } from './store.js'

/**
 * 物理删掉一条产品。
 *
 * ## 与「下架」的分工
 *
 * - **下架**（`status = archived`）：把这一行从搜索里拿走，但历史报价单上的条目号
 *   （`A037`）仍能查到、也能单独上架回来。多数情况下这才是该用的那个动作。
 * - **删除**（这里）：这一行从 `quote_items` 里消失。条目号从此查不到任何东西，
 *   不可撤销。
 *
 * 所以删除前先把整行快照写进 `quote_revisions`（`field = 'deleted'`）：名称、型号、
 * 规格、分类、条目号、价格、状态。事后有人拿着旧报价单来问「这条当时是什么」，
 * 翻审计还能答上来 —— 这一条是删除与「什么都不留」的唯一区别。
 *
 * ## 商品图只在「这一条自己持有图」时才删
 *
 * 图键可能是这一条的 `code`（`manual` 上传、`exact` 绑定），也可能是**产品族键**
 * （`fam-<摘要>`，150 张图覆盖 499 条条目就是靠它）。族图属于整个族，删了会把同款
 * 其他行的图一起弄没。所以删图的条件写死成 `imageKey === code`，并额外排掉
 * `bindType = 'family'` —— 两道锁，因为这里错了不报错、只是别的产品变空白。
 *
 * ## 不做「先下架才能删」
 *
 * 误导入的重复行往往一进来就是在售状态，强制先下架只是多一次点击。真正的保护是
 * **界面上的两次确认**（第一次点把按钮换成「确认删除」）与服务端这一份快照。
 */

export type ItemDeleteFailure =
  | 'not_found'
  /** 这一条不属于这个主类。多半是界面上的列表还没刷新，不能顺手删掉别的主类的东西。 */
  | 'wrong_source'

export type ItemDeleteResult =
  { ok: true; value: DeleteQuoteItemResponse } | { ok: false; reason: ItemDeleteFailure }

type Operator = { userId: string; access: QuoteWriteAccess }

/** `old_value` 只有 400 字。超了宁可截断，也不能让整条事务因为「字符串太长」失败。 */
const SNAPSHOT_MAX = 400

export async function deleteItem(
  input: { source: QuoteSource; code: string },
  operator: Operator,
): Promise<ItemDeleteResult> {
  const row = await prisma.quoteItem.findUnique({
    where: { code: input.code },
    select: {
      code: true,
      source: true,
      category: true,
      name: true,
      model: true,
      spec: true,
      ledgerNo: true,
      priceText: true,
      status: true,
    },
  })
  if (row === null) return { ok: false, reason: 'not_found' }
  if (row.source !== input.source) return { ok: false, reason: 'wrong_source' }

  const wasArchived = row.status === 'archived'
  const snapshot = [
    `名称=${row.name}`,
    `型号=${row.model}`,
    `规格=${row.spec}`,
    `分类=${row.category}`,
    `条目号=${row.ledgerNo}`,
    `价格=${row.priceText}`,
    `状态=${row.status}`,
  ]
    .join('；')
    .slice(0, SNAPSHOT_MAX)

  const version = await bumpDataset(`删除产品：${row.code}`)

  // 图在条目之前删：反过来的话，删完条目就再也查不到它的图键了（图行的 `imageKey`
  // 只是字符串，没有外键把它与条目绑在一起）。
  //
  // 「有没有删掉图」必须在事务**之前**数：事务跑完这个键上必然是 0 行，那时候再数
  // 只能得到「没有」，提示里就永远写着「未删图」。
  const ownImages = await prisma.quoteItemImage.count({
    where: { imageKey: row.code, bindType: { not: 'family' } },
  })

  await prisma.$transaction([
    prisma.quoteItemImage.deleteMany({
      where: { imageKey: row.code, bindType: { not: 'family' } },
    }),
    prisma.quoteItem.delete({ where: { code: row.code } }),
    prisma.quoteRevision.create({
      data: {
        itemCode: row.code,
        field: 'deleted',
        oldValue: snapshot,
        newValue: '',
        operatorId: operator.userId,
        unlockSessionId: operator.access.unlockSessionId,
        reason: wasArchived ? '删除（原为已下架）' : '删除',
      },
    }),
  ])

  return {
    ok: true,
    value: {
      version,
      code: row.code,
      name: row.name,
      wasArchived,
      imageRemoved: ownImages > 0,
    },
  }
}
