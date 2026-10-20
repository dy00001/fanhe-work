/**
 * 案例展示的品类清单。
 *
 * **这一版没有「案例」这张表。** 原型里的 9 张卡是视频替代帧，库里既没有案例实体，也
 * 没有封面素材（见 `docs/NEXT-TASKS-2026-10-12.md` 的 U-01）。`cases` 字段预留为
 * `readonly CaseSlot[]`、当前为空数组，结构按「将来接接口」的形状写：品类有稳定
 * `id`，案例带 `categoryId` 与可空封面；等案例落库，把 `CASE_CATEGORIES` 换成一次查询
 * 结果即可，调用方（首页横滑条与「全部品类」弹窗）都不用动——这正是把清单单独拎出来的
 * 原因。
 *
 * **数据本身不编名。** 案例标题留空串（类型即如此，不是 null）、封面为 null，界面据此
 * 渲染「封面待补」与占位标题。**留空是刻意的**——编一个客户名或方案名放进库里，后面接
 * 真实数据时没人分得清哪条是假数据。
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
  /** 当前为空数组——案例库尚未建立。等接上数据，这里才会被填上 `CaseSlot`。 */
  cases: readonly CaseSlot[]
}

/**
 * 九个品类，顺序即界面顺序。
 *
 * 与原型逐条一致，一个不多一个不少。`id` 用英文是为了将来进 URL 与接口参数时不必再
 * 转一层拼音；`name` 才是给用户看的。
 */
export const CASE_CATEGORIES: readonly CaseCategory[] = [
  { id: 'cabinet', name: '橱柜', cases: [] },
  { id: 'wardrobe', name: '衣柜', cases: [] },
  { id: 'bookcase', name: '书柜', cases: [] },
  { id: 'shoe-cabinet', name: '鞋柜', cases: [] },
  { id: 'wine-cabinet', name: '酒柜', cases: [] },
  { id: 'door-set', name: '套装门', cases: [] },
  { id: 'tv-cabinet', name: '电视柜', cases: [] },
  { id: 'sideboard', name: '餐边柜', cases: [] },
  { id: 'wall-panel', name: '护墙板', cases: [] },
]
