/**
 * 案例展示的品类清单与案例位。
 *
 * **这一版没有「案例」这张表。** 原型里的九张卡是视频替代帧，库里既没有案例实体，
 * 也没有封面素材（见 `docs/NEXT-TASKS-2026-10-12.md` 的 U-01）。因此这里给出的是
 * 「位子」而不是「内容」：每个品类固定三个案例位，标题留空、封面为 `null`，界面据此
 * 渲染「封面待补」与占位标题。**留空是刻意的** —— 编一个客户名或方案名放进库里，
 * 后面接真实数据时没人分得清哪条是假数据。
 *
 * 结构按「将来接接口」的形状写：品类有稳定 `id`，案例带 `categoryId`，筛选与计数
 * 都只看 id。等案例落库，把 `CASE_CATEGORIES` 换成一次查询结果即可，卡片结构、筛选、
 * 计数三处都不用动 —— 那正是把清单单独拎出来的原因。
 */

/** 一个案例位。字段是「接上真实数据之后仍然成立」的那几个，不多留。 */
export type CaseSlot = {
  /** 稳定标识。将来以它作列表 key，不从标题推 —— 标题会改，id 不会。 */
  id: string
  /** 所属品类 id。冗余存一份，便于将来单条案例脱离分组独立查询。 */
  categoryId: string
  /** 案例标题。空串表示尚未录入，界面显示占位文案。 */
  title: string
  /** 封面地址。`null` 表示封面待补。 */
  cover: string | null
}

export type CaseCategory = {
  id: string
  name: string
  cases: readonly CaseSlot[]
}

/**
 * 每个品类留三个案例位。
 *
 * 取三而不是四：弹窗里三列排下来正好一行，九个品类各一行，纵向节奏一致；取四会让
 * 每组的最后一行只剩一张卡，看起来像漏了。
 */
const SLOTS_PER_CATEGORY = 3

function buildCategory(id: string, name: string): CaseCategory {
  return {
    id,
    name,
    cases: Array.from({ length: SLOTS_PER_CATEGORY }, (_, index) => ({
      id: `${id}-${index + 1}`,
      categoryId: id,
      title: '',
      cover: null,
    })),
  }
}

/**
 * 九个品类，顺序即界面顺序。
 *
 * 与原型逐条一致，一个不多一个不少。`id` 用英文是为了将来进 URL 与接口参数时不必
 * 再转一层拼音；`name` 才是给用户看的。
 */
export const CASE_CATEGORIES: readonly CaseCategory[] = [
  buildCategory('cabinet', '橱柜'),
  buildCategory('wardrobe', '衣柜'),
  buildCategory('bookcase', '书柜'),
  buildCategory('shoe-cabinet', '鞋柜'),
  buildCategory('wine-cabinet', '酒柜'),
  buildCategory('door-set', '套装门'),
  buildCategory('tv-cabinet', '电视柜'),
  buildCategory('sideboard', '餐边柜'),
  buildCategory('wall-panel', '护墙板'),
]

/** 「全部」这一档的取值。用独立常量而不是散落的字符串字面量，拼错会在导入处就报。 */
export const ALL_CASE_CATEGORIES = 'all'

/** 案例位总数。由数据算出来，不在文案里写死 —— 加了品类而计数没跟着变是最常见的错。 */
export function countCaseSlots(categories: readonly CaseCategory[]): number {
  return categories.reduce((total, category) => total + category.cases.length, 0)
}

/**
 * 按品类筛选。
 *
 * 认不出的 id 一律退回「全部」，而不是返回空列表：空列表看起来像「这个品类没有案例」，
 * 而真实原因是筛选值不对（例如将来品类改名后旧链接还留着旧 id）。让用户看到全部，
 * 比让他看到一片空白更接近事实。
 */
export function filterCaseCategories(
  categories: readonly CaseCategory[],
  categoryId: string,
): readonly CaseCategory[] {
  if (categoryId === ALL_CASE_CATEGORIES) return categories
  const matched = categories.filter((category) => category.id === categoryId)
  return matched.length > 0 ? matched : categories
}
