/**
 * 案例展示的品类清单与案例位。
 *
 * **三样东西要分清：品类、品类封面、案例。**
 *
 *   - 品类封面：每个品类一张代表图，放 `public/cases/<id>.webp`，随 `dist` 一起分发。
 *     零接口、零鉴权、两端（nginx 与桌面端静态服务）行为天然一致，首屏不会因为网络
 *     失败而空一块。代价是换图要重新发版，这对一年换几次封面图的场景是可接受的。
 *   - 案例：同一品类下的其它实景图，放 `public/cases/album/<id>-<n>.webp`。点开品类卡
 *     看到的就是它们，连同封面在内一起排成一条。**仍然走静态分发**，理由同上。
 *   - 案例实体表：库里仍然没有「案例」这张表（见 `docs/NEXT-TASKS-2026-10-12.md` 的
 *     U-01）。`CaseSlot` 的形状是按「将来接接口」写的：稳定 `id`、`categoryId`、可空
 *     `title` 与 `cover`。等案例落库，把 `CASE_CATEGORIES` 换成一次查询结果即可，
 *     调用方（首页横滑条、全部品类弹窗、图集弹窗）都不用动。
 *
 * **数据本身不编名。** 案例标题留空串（类型即如此，不是 null），界面用序号兜底。留空是
 * 刻意的——编一个客户名或方案名放进库里，后面接真实数据时没人分得清哪条是假数据。等
 * 真要显示名字，那是案例落库之后的事。
 *
 * **素材只入重编码后的 webp，不入手机原图。** 远端仓库是 public，系统还挂着公网隧道，
 * 客户家实景原图一旦入库等同公开。封面统一缩放至 800px 宽、q80（13 张合计 285 KB）；
 * 案例图统一 1000px 宽、q74（43 张合计 1633 KB）。二者都由
 * `.tmp/cases-review/finalize.py` 生成，脚本与挑选记录不进仓库。
 */

/**
 * 清单文件只依赖共享包，不依赖本目录下的其它模块 —— 前端测试用 Node 的类型擦除直接
 * 跑这些 `.ts`，而 Node 的 ESM 解析要求相对导入带扩展名（仓库约定不写）。因此一条
 * **运行期**的相对导入就会让整份测试跑不起来。类型导入不受影响（会被擦掉）。
 */
import { caseCoverItemId } from '@fanhe/shared'

/** 一个案例位。字段是「接上真实数据之后仍然成立」的那几个，不多留。 */
export type CaseSlot = {
  /** 稳定标识。将来以它作列表 key，不从标题推 —— 标题会改，id 不会。 */
  id: string
  /** 所属品类 id。冗余存一份，便于将来单条案例脱离分组独立查询。 */
  categoryId: string
  /** 案例标题。空串表示尚未录入，界面显示占位文案。 */
  title: string
  /** 封面地址。`null` 表示封面待补。**图集里的「原图」就是它。** */
  cover: string | null
  /**
   * 缩略图地址，320px 宽，指向 `public/cases/thumbs/`。
   *
   * **缩略图与原图是两套文件，不是同一张图的两个尺寸参数。** 网格里一屏要排十几张，
   * 每张都取 1000px 的原图，首次进入图集要下 1.6MB；而点开放大只发生在用户真的想看
   * 细节的时候，那时再取原图才有意义。两套文件的生成脚本与挑选记录不入库，与封面同源。
   */
  thumb: string | null
}

export type CaseCategory = {
  id: string
  name: string
  /**
   * 品类封面地址，指向 `public/cases/` 下的静态图。`null` 表示封面待补。
   *
   * 与 `CaseSlot.cover` 的区别：这一张是「品类的门面」，一个品类只有一张；`CaseSlot`
   * 里的封面属于某一条具体案例，一个品类有多条。
   */
  cover: string | null
  /** 该品类下的案例。空数组表示尚未整理，界面只显示封面。 */
  cases: readonly CaseSlot[]
}

/**
 * 按张数生成案例位。
 *
 * 文件名由 `categoryId` 与序号拼出来，不手写地址：43 条路径手写一遍必然出一次「橱柜卡
 * 配了衣柜的图」这类串行错误，而它在界面上表现为「看起来都挺合适」，肉眼很难发现。这里
 * 少一个可写错的字段，测试再核对磁盘文件，两边就闭上了。
 *
 * 传错张数不会静默通过：测试会拿生成出来的路径去磁盘上找，找不到就 FAIL。
 */
function album(categoryId: string, count: number): readonly CaseSlot[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${categoryId}-${index + 1}`,
    categoryId,
    title: '',
    cover: `/cases/album/${categoryId}-${index + 1}.webp`,
    thumb: `/cases/thumbs/${categoryId}-${index + 1}.webp`,
  }))
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
 * 案例张数按素材实际可用的数量给，不凑数：酒柜的池子里只有 2 张、能用的 1 张，就写 1。
 * 拿别的品类的图顶替过后，没人记得哪张是借来的。
 */
export const CASE_CATEGORIES: readonly CaseCategory[] = [
  { id: 'cabinet', name: '橱柜', cover: '/cases/cabinet.webp', cases: album('cabinet', 4) },
  { id: 'wardrobe', name: '衣柜', cover: '/cases/wardrobe.webp', cases: album('wardrobe', 4) },
  { id: 'bookcase', name: '书柜', cover: '/cases/bookcase.webp', cases: album('bookcase', 4) },
  {
    id: 'shoe-cabinet',
    name: '鞋柜',
    cover: '/cases/shoe-cabinet.webp',
    cases: album('shoe-cabinet', 4),
  },
  {
    id: 'wine-cabinet',
    name: '酒柜',
    cover: '/cases/wine-cabinet.webp',
    cases: album('wine-cabinet', 1),
  },
  { id: 'door-set', name: '套装门', cover: '/cases/door-set.webp', cases: album('door-set', 3) },
  {
    id: 'tv-cabinet',
    name: '电视柜',
    cover: '/cases/tv-cabinet.webp',
    cases: album('tv-cabinet', 4),
  },
  {
    id: 'sideboard',
    name: '餐边柜',
    cover: '/cases/sideboard.webp',
    cases: album('sideboard', 4),
  },
  {
    id: 'wall-panel',
    name: '护墙板',
    cover: '/cases/wall-panel.webp',
    cases: album('wall-panel', 4),
  },
  { id: 'tatami', name: '榻榻米', cover: '/cases/tatami.webp', cases: album('tatami', 3) },
  {
    id: 'balcony-cabinet',
    name: '阳台柜',
    cover: '/cases/balcony-cabinet.webp',
    cases: album('balcony-cabinet', 2),
  },
  {
    id: 'bathroom-cabinet',
    name: '浴室柜',
    cover: '/cases/bathroom-cabinet.webp',
    cases: album('bathroom-cabinet', 3),
  },
  {
    id: 'aluminum-wood-cabinet',
    name: '铝木柜',
    cover: '/cases/aluminum-wood-cabinet.webp',
    cases: album('aluminum-wood-cabinet', 3),
  },
]

/** 一张图在本地缓存里的两条地址。`src` 是原图，`thumb` 是缩略图。 */
export type CaseAssetFile = {
  id: string
  categoryId: string
  thumb: string
  src: string
}

/**
 * 全部图片文件，按品类顺序。**它是「要缓存什么」的唯一清单。**
 *
 * 从 `CASE_CATEGORIES` 派生而不是再写一份：缓存层的同步计划要遍历全部图，如果把清单
 * 抄一遍，新增一张图时最可能忘的就是它，而表现是「这张图永远没有本地缓存」——
 * 界面不报错，只是每次都走网络。
 */
export { caseCoverItemId }

export function caseAssetFiles(): readonly CaseAssetFile[] {
  const files: CaseAssetFile[] = []
  for (const category of CASE_CATEGORIES) {
    if (category.cover !== null) {
      files.push({
        id: caseCoverItemId(category.id),
        categoryId: category.id,
        // 封面本身就是 800px、20KB 出头的小图，够当缩略图用，不必再生成一份。
        thumb: category.cover,
        src: category.cover,
      })
    }
    for (const slot of category.cases) {
      if (slot.cover === null || slot.thumb === null) continue
      files.push({
        id: slot.id,
        categoryId: category.id,
        thumb: slot.thumb,
        src: slot.cover,
      })
    }
  }
  return files
}

/**
 * 图片集的指纹。**缓存失效的唯一依据。**
 *
 * 它是对「每张图的 id + 缩略图地址 + 原图地址」算的一个 FNV-1a 值。这样它的变化恰好
 * 对应「清单变了」：加一张图、换一张图、改一次张数，都会让它变；而代码里改了个标点、
 * 调了个顺序但图没动（顺序参与计算，所以顺序变了也会变），最坏只是多同步一次。
 *
 * **不做成手写的版本号常量。** 手写的那种，改图时忘了改它是常态，而后果是「缓存永远
 * 不刷新，用户看到的还是旧图」—— 一个不会报错、只能靠人记得的缺陷。这里让它从数据里
 * 自己长出来，忘不了。
 *
 * 也不用 `Math.random()` 或时间戳：那样每次进来都会全量重同步，缓存就白做了。
 */
export const CASE_ASSET_VERSION: string = fingerprint(caseAssetFiles())

function fingerprint(files: readonly CaseAssetFile[]): string {
  let hash = 0x811c9dc5
  for (const file of files) {
    for (const part of [file.id, file.thumb, file.src, '\n']) {
      for (let index = 0; index < part.length; index += 1) {
        hash ^= part.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193)
      }
    }
  }
  // 补零到 8 位：短哈希在界面上是要显示的（「缓存版本 a1b2c3d4」），不定长会让它
  // 看起来像被截断了。
  return (hash >>> 0).toString(16).padStart(8, '0')
}
