import type { QuoteSource } from '@fanhe/shared'

import { prisma } from '../db/prisma.js'

import type { QuoteWriteAccess } from './access.js'

/**
 * 产品排序：把维护台里拖出来的顺序落库。
 *
 * ## 为什么单开一个文件，不塞进 `store.ts`
 *
 * `store.ts` 是查价侧的读路径（搜索、详情、取图、改价）。这里是维护台的一个纯排序
 * 动作：只改 `sort_order`，**不改价格、不写审计、不 bump 数据集版本**。混进去之后
 * 「一次拖动会不会让全端重拉价格」这个问题就要去读 `store.ts` 才知道答案。
 *
 * ## 不 bump 版本号
 *
 * 版本号的语义是「你手里的价格还成不成立」。排序变了、价格没变 —— 让它跟着变，
 * 等于每次拖动一下其他端的查价面板都要重拉 1225 条。分类重排（`reorderCategories`）
 * 出于同一个理由也不 bump。
 *
 * ## 只改顺序，不动条目号
 *
 * `ledger_no` 是印在报价单上、用来跟纸质台账对号的编号。拖动一次就重编它，等于每次
 * 调顺序都改一遍全部条目的对外编号 —— 所以顺序在 `sort_order` 里，与条目号无关。
 */

export type ItemOrderFailure = 'invalid_order' | 'not_found'

export type ItemOrderResult<T> = { ok: true; value: T } | { ok: false; reason: ItemOrderFailure }

type Operator = { userId: string; access: QuoteWriteAccess }

/**
 * 一次事务里写多少行。
 *
 * 一个主类最多六百多条（五金 596）。全部塞进一次 `$transaction` 也能过，但那样每次
 * 拖动都要持有一个很长的写事务，与并发的改价撞上时更容易互相等。分批写没有原子性
 * 上的损失 —— 顺序本身不是「要么全对要么全错」的东西，而最后一批失败时前端会重取
 * 列表，看到的就是库里的真实顺序。
 */
const WRITE_CHUNK = 200

/**
 * 重排一个主类下的产品。
 *
 * `order` 是**这一屏看到的那些条目键**的新顺序（最多 `PAGE_SIZE_MAX` 条）。服务端
 * 把它接在前面、其余行按原有相对次序接在后面，然后整段重写下标：
 *
 * ```
 * 新顺序 = order + (该主类下没提到过的行，保持原相对次序)
 * ```
 *
 * 只给提到的行写下标 0..k-1 是不行的：没提到的行 `sort_order` 还是 0，会跟第 0 名
 * 撞在一起，整张列表的顺序立刻散掉。这一点在 `ReorderQuoteItemsRequest` 的注释里
 * 也写了一遍 —— 两处都要看，因为改这里的人可能只改一边。
 */
export async function reorderItems(
  source: QuoteSource,
  order: readonly string[],
  operator: Operator,
): Promise<ItemOrderResult<{ updated: number }>> {
  // 先去重再判空：重复的 code 会让「写进去的顺序」与「数组下标」错位，而结果只是
  // 某一行没动 —— 看起来像「拖了没反应」。
  const codes: string[] = []
  const seen = new Set<string>()
  for (const raw of order) {
    const code = raw.trim()
    if (code === '') return { ok: false, reason: 'invalid_order' }
    if (seen.has(code)) return { ok: false, reason: 'invalid_order' }
    seen.add(code)
    codes.push(code)
  }
  if (codes.length === 0) return { ok: false, reason: 'invalid_order' }

  const [rows, matched] = await Promise.all([
    prisma.quoteItem.findMany({
      where: { source },
      orderBy: [{ sortOrder: 'asc' }, { ledgerNo: 'asc' }, { code: 'asc' }],
      select: { code: true },
    }),
    prisma.quoteItem.count({ where: { source, code: { in: codes } } }),
  ])

  // 少一条就整批拒绝。这不是可以「尽力而为」的地方：拖动的语义是「这一整段的新
  // 顺序」，少了几条还照写，剩下的位置会被顶掉，而界面上看不出少了哪一条。
  if (matched !== codes.length) return { ok: false, reason: 'not_found' }

  const current = rows.map((row) => row.code)
  const rest = current.filter((code) => !seen.has(code))
  const next = [...codes, ...rest]

  // 顺序没变就别写。拖动常常落在原地（尤其按住的是一个已经在该位置的行），
  // 而 596 行一起改写只是白写一遍。
  const unchanged = next.every((code, index) => code === current[index])
  if (unchanged) {
    void operator
    return { ok: true, value: { updated: 0 } }
  }

  // 必须整段重写：老数据全 0，只有这样才会把「没提到的行」排到后面去。见文件头。
  for (let start = 0; start < next.length; start += WRITE_CHUNK) {
    const slice = next.slice(start, start + WRITE_CHUNK)
    await prisma.$transaction(
      slice.map((code, offset) =>
        prisma.quoteItem.update({
          where: { code },
          data: { sortOrder: start + offset },
        }),
      ),
    )
  }

  void operator
  return { ok: true, value: { updated: next.length } }
}
