/**
 * 案例库的跨进程结构：品类 id、文件夹、图片归属、同步快照。
 *
 * **这里只放「两边都要一致」的东西**：品类 id 取值域（服务端拿它挡非法分类，前端拿
 * 它拼界面）、文件夹名规则（表单即时提示与服务端强制校验必须同一条）、以及同步快照
 * 的传输形状。图片地址不进来 —— 它们属于 web 的静态资源，服务端没有理由知道
 * `/cases/album/cabinet-1.webp` 这种路径。
 *
 * **随前端分发的图片不入库，只有「图片被放进哪个文件夹」入库。** 这是一条刻意的最小化
 * 表示：图片来自随前端分发的静态清单（`apps/web/src/lib/case-catalog.ts`），库里再存一遍
 * 就等于同一件事有两个真相，而新加一张图还要先跑一次数据迁移。库里只记录覆盖关系，
 * 没有行的图片就是「未归档」，界面按静态清单补齐即可。
 *
 * **用户自己上传的图片是例外，它必须入库。** 2026-10-29 加的「上传图片」不能走静态
 * 清单：那张图不在任何一次构建里，也不该为了它重发一次版。于是库里多一张 `case_uploads`
 * 存字节本体，快照里多一段 `uploads` 描述它们。两者在展示层被抹平成同一种东西 ——
 * 界面上的「一张图」不区分来源，只有 `itemId` 不同。
 *
 * **快照带一个 revision。** 它是「这个账号的案例库被改过多少次」的单调计数，用来回答
 * 一个很便宜的问题：本机手上的这份还是不是最新的。多设备同步全靠它判断要不要重绘，
 * 而不必逐字段比对 —— 比对会给出「看起来一样但真的变了」这种既难解释又难测的中间态。
 */

/**
 * 品类 id 的唯一事实来源。
 *
 * 顺序即界面顺序，前九个是主力品类，后四个（榻榻米、阳台柜、浴室柜、铝木柜）是
 * 2026-10-29 扩进来的「其它空间」。顺序写在这里而不是由前端排：前端那份
 * `CASE_CATEGORIES` 要按它来排，两边顺序不一致的表现是「弹窗里第一个是橱柜、
 * 首页第一个是衣柜」，而这种偏差没人会在评审时注意到。
 *
 * 前端有一项测试拿 `CASE_CATEGORIES.map(c => c.id)` 与这个数组比对，任何一边增删
 * 品类而另一边没跟，都会在门禁里红。
 */
export const CASE_CATEGORY_IDS = [
  'cabinet',
  'wardrobe',
  'bookcase',
  'shoe-cabinet',
  'wine-cabinet',
  'door-set',
  'tv-cabinet',
  'sideboard',
  'wall-panel',
  'tatami',
  'balcony-cabinet',
  'bathroom-cabinet',
  'aluminum-wood-cabinet',
] as const

export type CaseCategoryId = (typeof CASE_CATEGORY_IDS)[number]

const CASE_CATEGORY_ID_SET: ReadonlySet<string> = new Set(CASE_CATEGORY_IDS)

/**
 * 判断一个字符串是不是合法品类 id。
 *
 * 用 Set 而不是数组 `includes`：这条判断在批量接口里会被每个 itemId 间接触发一次，
 * 数组查找是线性的，而它完全没必要是。类型收窄写在这里，调用方就不必再断言。
 */
export function isCaseCategoryId(value: string): value is CaseCategoryId {
  return CASE_CATEGORY_ID_SET.has(value)
}

/**
 * 字段上限。
 *
 * `FOLDER_NAME_MAX` 给 24：文件夹名是贴在筛选条上的一个标签，超过两行就会把筛选条
 * 撑高、把图片区顶下去。24 个汉字足够表达「主卧衣柜 · 灰玻」这类命名。
 *
 * `FOLDERS_PER_CATEGORY_MAX` 给 30：一个品类的图集总共几十张，文件夹再多就失去了
 * 「帮你快速缩小范围」的意义，反而变成一层需要滚动的筛选器。它同时也是一道防滥用的
 * 闸门 —— 上限由服务端强制，界面在接近上限时禁用「新建」。
 *
 * `BATCH_MAX` 是一次移动的图片数上限。它只用来挡住超大的请求体，正常一批不会超过
 * 一个品类的图片总数。
 */
export const CASE_LIBRARY_LIMITS = {
  FOLDER_NAME_MAX: 24,
  FOLDERS_PER_CATEGORY_MAX: 30,
  ITEM_ID_MAX: 64,
  BATCH_MAX: 200,
  /**
   * 一个品类最多能上传多少张。
   *
   * 300 是「一张 1200px 的 webp 约 150KB」乘出来的量级：满额约 45MB 字节存在库里，
   * 单账号到顶也就一个手机相册的量。设上限不是防恶意（这层只要求登录），而是防
   * 「拖一整个文件夹进来」这种手滑 —— 那时候界面上应该给出一个明确的界，而不是
   * 让一次请求把库撑大几百兆。
   */
  UPLOADS_PER_CATEGORY_MAX: 300,
  /**
   * 一次最多选几张。
   *
   * 与 `UPLOAD_BATCH_MAX` 是同一个数：选多少就一次传多少，不做队列。10 张在弱网下
   * 大约十几秒，界面有进度可看；再多就该让用户分两批，而不是挂着一个转圈三分钟。
   */
  UPLOAD_BATCH_MAX: 10,
  /**
   * 单张原图的字节上限（**编码后**的字节，不是手机原图）。
   *
   * 客户端在上传前已经把它压到 `UPLOAD_EDGE_MAX` 宽，正常落在 100–400KB。2.5MB 是给
   * 「一张细节极多的全屋实景」留的余量（约 6 倍），同时也是一道拒绝闸门：超过它的
   * 多半是没走压缩（比如直接选了 HEIC 原图），让它悄悄入库只会让以后的同步越来越慢。
   */
  UPLOAD_BYTES_MAX: 2.5 * 1024 * 1024,
  /** 缩略图上限。320px 的 webp 通常 10KB 上下，512KB 已经松得离谱。 */
  UPLOAD_THUMB_BYTES_MAX: 512 * 1024,
  /**
   * 原图最长边的上限。**这是压缩目标，不是校验条件** —— 服务端不重新编码（那要引入
   * 一个图像库），只按字节数把关；这个值由客户端使用，两边写同一个常量，避免出现
   * 「前端按 1000px 压、文档里写 1600px」这种对不上的说明。
   */
  UPLOAD_EDGE_MAX: 1600,
} as const

/** 一个自定义文件夹。 */
export type CaseFolder = {
  id: string
  categoryId: string
  name: string
  createdAt: string
  updatedAt: string
}

/**
 * 一张图片的归属。
 *
 * `folderId` 为 `null` 表示「未归档」。**这个状态不落库**（见文件头：没有行就是未归档），
 * 但类型里保留它，是因为未归档是一个用户能主动选择的目标 —— 把图片从文件夹里移出来
 * 时提交的就是 `folderId: null`，快照里也可能出现它（客户端把「移动成功」乐观地写成
 * 这一行，比等一次往返更接近用户感受）。
 */
export type CasePlacement = {
  itemId: string
  folderId: string | null
}

/**
 * 一次同步的完整状态。
 *
 * **每次写操作都返回整个快照，而不是只返回被改的那一行。** 这里不追求响应体最小：
 * 一个账号的案例库最多是「30 个文件夹 × 13 个品类 + 几百条归属」，序列化后十几 KB，
 * 而「让客户端自己推算改完之后的状态」会在多设备并发时算错 —— 算错的表现是界面显示的
 * 归属与库里不一致，且刷新一次就好，属于最难复现的一类问题。全量回传让客户端只有
 * 一条规则：用服务端给的这份替换本地的。
 */
export type CaseLibrarySnapshot = {
  /** 单调递增的修订号。0 表示这个账号从没改过案例库。 */
  revision: number
  folders: readonly CaseFolder[]
  placements: readonly CasePlacement[]
  /**
   * 自己上传的图片。**只有描述，没有字节** —— 字节要走取图接口单独拿。
   *
   * 放进快照而不是另开一条列表接口：展示层需要「这个品类有哪些图」这件事一次拿全，
   * 否则每打开一个品类都要多一次往返，而两次响应之间还可能出现「归属里有一张图、
   * 清单里没有」的错位。它每行只有四个短字段，几十行不过几 KB。
   */
  uploads: readonly CaseUpload[]
}

export type CaseLibraryResponse = {
  library: CaseLibrarySnapshot
}

/** 新建文件夹。`categoryId` 必须落在 {@link CASE_CATEGORY_IDS} 里。 */
export type CreateCaseFolderRequest = {
  categoryId: string
  name: string
}

/** 重命名。只改名字。 */
export type RenameCaseFolderRequest = {
  name: string
}

/**
 * 批量移动。
 *
 * 语义是**整体赋值**而不是增量：提交的每个 itemId 都被设成 `folderId`（`null` 即移出
 * 文件夹）。因此重复提交同一个请求不会产生副作用，客户端在失败后重试不必先问
 * 「上一次到底成没成」—— 与事件状态切换用 `PUT` 是同一条判断。
 *
 * `categoryId` 是**这些图片当前所在的品类**，只用来校验 itemId 前缀（图片清单在前端，
 * 服务端能拿到的只有「`wardrobe-3` 这种命名属于衣柜」这一条线索）。
 *
 * **它不要求等于目标文件夹所在品类。** 2026-10-29 放开跨品类移动：整理图库时最常见的
 * 动作就是把一张放错品类的图挪到隔壁品类去（`主卧` 下的图其实拍的是 `次卧`）。限制成
 * 同品类的话，用户只能先把它「移出文件夹」再也没法归到正确品类，等于缺了半个功能。
 * 放开之后这张图在源品类里不再显示、在目标品类里出现 —— 「移动」就是移动。
 */
export type MoveCaseItemsRequest = {
  categoryId: string
  itemIds: readonly string[]
  folderId: string | null
}

/**
 * 文件夹名归一：去首尾空白，把中间的连续空白压成一个空格。
 *
 * 压中间空白而不只是 trim：文件夹名贴在筛选条上，`主卧  衣柜` 与 `主卧 衣柜` 在界面上
 * 宽度不同、在重名判断里却是两个名字。归一放在共享包，前端提交前与后端落库前用同一条
 * 规则 —— 各写一份的结果是「界面认为不重名，提交后 409」。
 *
 * 不做大小写折叠。中文没有大小写问题，而英文名 `Living` 与 `living` 是否算同一个，
 * 取决于使用者的意图（同一套作品里也可能真有 `Living A` / `living B` 这种区分），
 * 替用户决定会让他失去这个能力。
 */
export function normalizeCaseFolderName(input: string): string {
  return input.replace(/\s+/g, ' ').trim()
}

/**
 * 判断文件夹名是否合法。空串与超长都不合法。
 *
 * **内部先归一一次，不假设调用方已经归一。** 长度要按归一后的值判断（用户粘贴带缩进
 * 的多行文本时，归一后可能刚好在上限内），而只由 `'   '` 组成的输入如果不归一会通过
 * 「长度大于 0」这一关 —— 库里于是存进一个看起来是空名字的文件夹，界面上它就是一条
 * 空白筛选条。让这个函数自己兜住，比要求每个调用点都记得先归一可靠。
 */
export function isValidCaseFolderName(name: string): boolean {
  const normalized = normalizeCaseFolderName(name)
  return normalized.length > 0 && normalized.length <= CASE_LIBRARY_LIMITS.FOLDER_NAME_MAX
}

/**
 * 判断一张图片是否属于某个品类。
 *
 * 图片 id 的形如 `cabinet-3`，前缀即品类。服务端不掌握图片清单（那是前端的静态资源），
 * 因此只能用这条命名约定来挡住「把衣柜的图放进橱柜的文件夹」这类跨品类写入 ——
 * 挡不住的只是「不存在的编号」，而它对界面无害：客户端渲染时按静态清单查一遍，
 * 查不到的自然不画出来。
 */
export function caseItemIdBelongsTo(itemId: string, categoryId: string): boolean {
  return itemId.startsWith(`${categoryId}-`)
}

/**
 * 品类封面在图集里的 itemId 后缀。
 *
 * 封面是一张真实的图：用户会想放大看，也可能想把它归到某个文件夹里。给它一个稳定 id
 * （`cabinet-cover`）之后，它在归属表里与其它图片走完全相同的路径，界面不需要为它写
 * 第二个分支。形如 `<品类>-cover` 与案例的 `<品类>-<序号>` 不会撞：序号全是数字。
 *
 * 放在共享包而不是前端：**它是服务端也在用的约定**（`caseItemIdBelongsTo` 用前缀判定
 * 归属，封面 id 必须同样满足这个前缀）。两边各写一个字面量，改一处就会让封面悄悄
 * 失去「能移动」的能力，而界面上只是拖不动，不报错。
 */
export const CASE_COVER_SUFFIX = 'cover'

export function caseCoverItemId(categoryId: string): string {
  return `${categoryId}-${CASE_COVER_SUFFIX}`
}

/**
 * 一张**自己上传**的图片。
 *
 * 与静态清单里的那一行是同一个东西的两个来源：界面拿到的都是「一个 itemId + 一张图」，
 * 区别只在字节从哪来（静态资源 / 取图接口）以及能不能删（静态图删不掉）。
 *
 * `width` / `height` 是原图的像素尺寸。**前端必须拿到它**：网格是 `object-cover` 的
 * 固定比例格子，没有尺寸就画不出占位，加载完还会跳一下版。服务端不重新编码图片，
 * 所以这两个值由上传方声明，只做范围校验。
 */
export type CaseUpload = {
  /** 形如 `wardrobe-u9f2c…`（32 位小写十六进制）。前缀仍是品类，见 {@link isCaseUploadItemId}。 */
  itemId: string
  /** 上传时所在的品类。跨品类移动之后它也不变 —— 它是「这张图来自哪」，不是「现在归谁」。 */
  categoryId: string
  width: number
  height: number
  createdAt: string
}

/**
 * 上传图片的 itemId 记号。
 *
 * 中间那个 `u` 是为了让「上传的」和「清单里的」在同一个命名空间里不打架：静态图是
 * `<品类>-<数字>`（`cabinet-3`）或 `<品类>-cover`，上传图是 `<品类>-u<32 位十六进制>`。
 * 服务端只靠这条约定就能回答「这个 id 该去 `case_uploads` 里找」。
 */
const CASE_UPLOAD_MARK = 'u'
const CASE_UPLOAD_TOKEN_PATTERN = /^[0-9a-f]{32}$/

/** 拼一个上传图片的 itemId。`token` 是去掉连字符的 UUID。 */
export function caseUploadItemId(categoryId: string, token: string): string {
  return `${categoryId}-${CASE_UPLOAD_MARK}${token}`
}

/**
 * 判断一个 itemId 是不是上传图片。
 *
 * **要求前缀是合法品类**，不能只匹配尾巴：`foo-u<32hex>` 这种只可能来自脏数据或改过的
 * 请求，把它们当成上传图会让服务端去查一张不存在的行、再回一个 404，而真正的事实是
 * 「这个 id 根本不合法」。
 */
export function isCaseUploadItemId(itemId: string): boolean {
  const match = /^(.*)-u([0-9a-f]{32})$/.exec(itemId)
  if (match === null) return false
  const categoryId = match[1] ?? ''
  const token = match[2] ?? ''
  return isCaseCategoryId(categoryId) && CASE_UPLOAD_TOKEN_PATTERN.test(token)
}

/**
 * 一次上传的一张图。
 *
 * `data` / `thumb` 是 **base64（不带 `data:` 前缀）**。用 JSON 而不是 multipart：这个
 * 仓库没有引入 multer 之类的依赖，为一次上传新增一个解析器不划算；而 base64 的代价
 * （体积 +33%）在「客户端已经压到 100–300KB」这个前提下完全可以接受。
 */
export type CreateCaseUploadItem = {
  data: string
  thumb: string
  width: number
  height: number
}

/**
 * 上传请求。
 *
 * `folderId` 不为 null 时，新图直接放进那个文件夹 —— 用户是在「某个文件夹」的筛选下
 * 点的上传，那就该落在那个文件夹里，而不是传完还要再选一遍移过去。**它必须属于
 * `categoryId` 这个品类**：与跨品类移动不同，上传时没有「这张图原来在哪」可言，
 * 允许落到别的品类只会让新图凭空出现在一个用户没打开的图集里。
 */
export type CreateCaseUploadsRequest = {
  categoryId: string
  folderId: string | null
  items: readonly CreateCaseUploadItem[]
}
