/**
 * 案例展示的品类清单。
 *
 * **两类东西要分清：品类封面已经有了，案例实体还没有。**
 *
 *   - 品类封面：每个品类一张代表图，放 `public/cases/<id>.webp`，随 `dist` 一起分发。
 *     零接口、零鉴权、两端（nginx 与桌面端静态服务）行为天然一致，首屏不会因为网络
 *     失败而空一块。代价是换图要重新发版，这对一年换几次封面图的场景是可接受的。
 *   - 案例实体：库里仍然没有「案例」这张表（见 `docs/NEXT-TASKS-2026-10-12.md` 的
 *     U-01）。`cases` 字段保持 `readonly CaseSlot[]`、当前为空数组，形状按「将来接
 *     接口」写：品类有稳定 `id`，案例带 `categoryId` 与可空封面。等案例落库，把
 *     `CASE_CATEGORIES` 换成一次查询结果即可，调用方（首页横滑条与「全部品类」弹窗）
 *     都不用动——这正是把清单单独拎出来的原因。
 *
 * **数据本身不编名。** 案例标题留空串（类型即如此，不是 null）、封面为 null，界面据此
 * 渲染「封面待补」与占位标题。**留空是刻意的**——编一个客户名或方案名放进库里，后面接
 * 真实数据时没人分得清哪条是假数据。
 *
 * **封面素材只入重编码后的 webp，不入手机原图。** 远端仓库是 public，系统还挂着公网
 * 隧道，客户家实景原图一旦入库等同公开。`public/cases/` 下的文件统一缩放至 800px 宽、
 * WebP q80，单张 8~48 KB，十一个品类合计 234 KB。
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
  /**
   * 品类封面地址，指向 `public/cases/` 下的静态图。`null` 表示封面待补。
   *
   * 与 `CaseSlot.cover` 的区别：这一张是「品类的门面」，一个品类只有一张；`CaseSlot`
   * 里的封面属于某一条具体案例，将来一个品类会有多条。
   */
  cover: string | null
  /** 当前为空数组——案例库尚未建立。等接上数据，这里才会被填上 `CaseSlot`。 */
  cases: readonly CaseSlot[]
}

/**
 * 十三个品类，顺序即界面顺序。
 *
 * 前九个与原型逐条一致，一个不多一个不少。后四个（榻榻米、阳台柜、浴室柜、铝木柜）是
 * 2026-10-29 扩进来的：素材库里有成规模的真实交付，客户也按这四个叫法问，归到「其它
 * 空间」比塞进九个主力品类更诚实。追加在末尾，前九个的顺序不动，避免既有截图与文档
 * 对不上。
 *
 * `id` 用英文是为了将来进 URL 与接口参数时不必再转一层拼音；`name` 才是给用户看的。
 *
 * 十三个品类当前都有封面。`cover` 保留可空是为了两件事：将来新增品类时可以先上架后
 * 补图；某张封面被判定不能用时（画质、水印、客户隐私）能单独退回占位，不必删品类。
 */
export const CASE_CATEGORIES: readonly CaseCategory[] = [
  { id: 'cabinet', name: '橱柜', cover: '/cases/cabinet.webp', cases: [] },
  { id: 'wardrobe', name: '衣柜', cover: '/cases/wardrobe.webp', cases: [] },
  { id: 'bookcase', name: '书柜', cover: '/cases/bookcase.webp', cases: [] },
  { id: 'shoe-cabinet', name: '鞋柜', cover: '/cases/shoe-cabinet.webp', cases: [] },
  { id: 'wine-cabinet', name: '酒柜', cover: '/cases/wine-cabinet.webp', cases: [] },
  { id: 'door-set', name: '套装门', cover: '/cases/door-set.webp', cases: [] },
  { id: 'tv-cabinet', name: '电视柜', cover: '/cases/tv-cabinet.webp', cases: [] },
  { id: 'sideboard', name: '餐边柜', cover: '/cases/sideboard.webp', cases: [] },
  { id: 'wall-panel', name: '护墙板', cover: '/cases/wall-panel.webp', cases: [] },
  { id: 'tatami', name: '榻榻米', cover: '/cases/tatami.webp', cases: [] },
  { id: 'balcony-cabinet', name: '阳台柜', cover: '/cases/balcony-cabinet.webp', cases: [] },
  { id: 'bathroom-cabinet', name: '浴室柜', cover: '/cases/bathroom-cabinet.webp', cases: [] },
  {
    id: 'aluminum-wood-cabinet',
    name: '铝木柜',
    cover: '/cases/aluminum-wood-cabinet.webp',
    cases: [],
  },
]
