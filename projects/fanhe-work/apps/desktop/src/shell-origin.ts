/**
 * 外壳来源（origin）的稳定性 —— 端口该试哪几个。
 *
 * ## 为什么需要这个文件
 *
 * 外壳把界面托管在 `http://127.0.0.1:<端口>` 上（见 `server.ts`），而
 * **localStorage 与 IndexedDB 都是按 origin 分区的，origin 里包含端口**。
 * 原来的实现用 `server.listen(0, …)` 把端口交给系统随机分配，于是每次启动端口都不同，
 * 也就等于**每次启动都换一个存储分区**：主题、侧栏折叠、纪要草稿、记住的账号、
 * 设备标识全都留在上一个分区里 —— 界面上看到的就是「设置丢了」。
 *
 * 实测（本机 `%APPDATA%\梵禾 Work`）：`IndexedDB/` 下同时躺着
 * `http_127.0.0.1_49901.indexeddb.leveldb` 与 `http_127.0.0.1_57352.indexeddb.leveldb`
 * 两份互不可见的存储，`Local Storage/leveldb/000003.log` 里也同时出现这两个来源。
 *
 * 「更新」只是把这件事放大成不可忽视的问题：装完新版重启，端口再换一次，用户看到
 * 的就是「更新之后设置全没了」。**根因不在更新流程，在端口。**
 *
 * ## 办法：把端口钉住，且优先钉回「已经有数据的那一个」
 *
 * 候选顺序（`shellPortCandidates`）：
 *
 *   1. 偏好文件里记着的端口 —— 上次实际用的那个；
 *   2. 已有存储的旧端口，**按最近使用倒序**。首次升级时这一条会命中，于是旧数据
 *      原地继续可用：不迁移、不复制、不丢；
 *   3. 一段固定端口，从 `SHELL_PORT_BASE` 起；
 *   4. `0`（交给系统分配）—— 只在前面全被占时才走到，且 `main.ts` 会打警告。
 *
 * ## 为什么旧端口排在「一段固定端口」前面
 *
 * 因为要保的是**已有数据**。用户机器上此刻的数据躺在某个随机端口的分区里，换到一段
 * 全新的端口等于把它留在一个再也访问不到的地方 —— 那不叫「不丢」，那叫「找不着」。
 * 代价是随机端口落在 Windows 的动态端口区间（49152~65535）里，长期看有被别的进程
 * 占去的可能；被占时按候选顺序顺延，并打一条说得清的警告，而不是静默地开一个新分区。
 *
 * ## 为什么是纯函数
 *
 * 本模块不 import `electron`、不碰文件系统：读偏好文件、列 `IndexedDB/` 目录都在
 * `main.ts`，这里只回答「给定这些事实，该按什么顺序试端口」。于是它能被
 * `test/shell-origin.test.mjs` 直接加载断言，不必真的起一个 Electron。
 */

/**
 * 兜底端口段的起点。
 *
 * 41873 落在 IANA 的注册端口区间（1024~49151）里，**刻意避开 Windows 的动态端口
 * 区间（49152~65535）** —— 那一段是内核分给出站连接的，放一个长期监听的端口进去
 * 等于天天和临时连接抢号。
 *
 * 取一个不常见的具体数值而不是某个「好看的」整数（如 8000 / 3000）：那些正是别的
 * 开发工具最可能占用的号，撞上就得顺延，而顺延意味着换分区。
 */
export const SHELL_PORT_BASE = 41873

/** 兜底端口段里连试几个。 */
export const SHELL_PORT_SPAN = 8

/**
 * 端口偏好的文件名，落在 `userData` 下。
 *
 * 放 `userData` 而不是工作区：它描述的是**这台机器上这个安装**的存储分区，
 * 与工作区无关，而且安装态根本没有工作区（T6-03a）。
 */
export const SHELL_ORIGIN_FILE = 'shell-origin.json'

const MIN_PORT = 1
const MAX_PORT = 65535

/** 一个可用的 TCP 端口号：正整数且不超过 65535。`0` 不算（它表示「交给系统」）。 */
export function isValidPort(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT
  )
}

/**
 * 从偏好文件的内容里读出端口，形状不对返回 `null`。
 *
 * 逐个字段查类型而不是直接取值：这个文件是**磁盘上的**，可能被手工改过、被别的
 * 版本写过、或者写到一半断电。拿一个 `undefined` 去 `listen` 会得到一个语义完全
 * 无关的错误，而「读不出偏好」的正确反应只是「按没有偏好处理」。
 */
export function parseStoredPort(payload: unknown): number | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const port = (payload as { port?: unknown }).port
  return isValidPort(port) ? port : null
}

/**
 * 从 IndexedDB 的分片目录名里读出端口。
 *
 * Chromium 给每个来源建一个目录，名字形如
 * `http_127.0.0.1_49901.indexeddb.leveldb`（主机名里的 `.` 与 `:` 被换成 `_`）。
 *
 * **这是枚举「哪些来源有数据」最可靠的一条路**：它是一次目录列表，不需要解析
 * leveldb 的内容，也就不会因为 Chromium 换了存储格式而失效。代价是只覆盖用过
 * IndexedDB 的来源 —— 只用过 localStorage 的来源由 `parseOriginPortsInText` 补。
 */
export function parseOriginDirName(name: string): number | null {
  const matched = /^http_127\.0\.0\.1_(\d{1,5})\.indexeddb\.leveldb$/.exec(name)
  if (matched === null) return null
  const port = Number(matched[1])
  return isValidPort(port) ? port : null
}

/**
 * 从任意文本里扫出回环来源的端口。
 *
 * 用来补 `parseOriginDirName` 覆盖不到的那一半：localStorage 的 leveldb 是**单库**，
 * 来源名写在键里（`_http://127.0.0.1:49901\0\1<键名>`），没有按来源分的目录。
 * 那串来源名在 leveldb 的 `.log` / `.ldb` 里是**明文**，所以一次正则扫描就够。
 *
 * 扫不出东西不是错误：新装的机器本来就没有任何来源。这里只承诺「扫到的都算数」。
 */
export function parseOriginPortsInText(text: string): number[] {
  const ports = new Set<number>()
  // 两种形态都收：leveldb 里是 `http://…:端口`，目录名里是 `http_127.0.0.1_端口`。
  const pattern = /(?:http:\/\/127\.0\.0\.1:|http_127\.0\.0\.1_)(\d{1,5})/g
  for (const matched of text.matchAll(pattern)) {
    const port = Number(matched[1])
    if (isValidPort(port)) ports.add(port)
  }
  return [...ports]
}

/**
 * 按优先级给出要依次尝试的端口。
 *
 * `legacy` 应当**按最近使用倒序**传进来（`main.ts` 按目录 mtime 排）：最新的那一份
 * 最可能是用户刚刚在用的分区，也就最可能是他想找回的那一份。
 *
 * 末尾永远补一个 `0`：端口全被占时宁可开一个新分区（并打警告），也不能让外壳
 * 起不来 —— 「设置看不到」比「打不开」轻得多。
 */
export function shellPortCandidates(
  stored: number | null,
  legacy: readonly number[] = [],
): number[] {
  const ordered: number[] = []
  const seen = new Set<number>()

  const push = (port: number): void => {
    if (!isValidPort(port) || seen.has(port)) return
    seen.add(port)
    ordered.push(port)
  }

  if (stored !== null) push(stored)
  for (const port of legacy) push(port)
  for (let offset = 0; offset < SHELL_PORT_SPAN; offset += 1) push(SHELL_PORT_BASE + offset)

  // `0` 不走 `push`：`isValidPort(0)` 为假，而这里正是要它。
  ordered.push(0)
  return ordered
}

/**
 * 这次是不是**换了一个没有数据的来源**。
 *
 * 为真时 `main.ts` 会打一条醒目警告：本次启动看不到上次的数据，以及为什么。
 * 判据刻意要求 `legacy` 非空 —— 一台全新的机器上「用的不是旧端口」是正常状态，
 * 不该报警告，否则这条警告会在每台新机器上出现一次，然后被所有人忽略。
 */
export function isFreshOrigin(port: number, legacy: readonly number[]): boolean {
  return legacy.length > 0 && !legacy.includes(port)
}

/**
 * 把「端口 → 最近一次被写的时刻」排成候选顺序：新的在前。
 *
 * ## 为什么单独抽出来
 *
 * 因为**并列时的顺序不能靠运气**。两个来源的时间戳一模一样时，排序的结果取决于
 * `Map` 的插入顺序，而插入顺序又取决于文件系统的目录枚举顺序 —— NTFS 上不保证是
 * 字典序。于是「哪一份数据会被认出来」在两次运行之间可能不同，而这个模块存在的
 * 全部意义就是「同一台机器上结果永远一样」。
 *
 * 实测（本机 `%APPDATA%\梵禾 Work`）：两个来源的 IndexedDB 目录相差 4 分钟
 * （49901 更晚），但它们同时出现在同一个 localStorage 日志文件里，而那个文件的时间
 * 把两者的差别抹平了 —— 排序于是退化成枚举顺序，外壳挑中了**较旧**的那一个。
 * 所以这里既有并列时的确定性兜底（见下），`main.ts` 那一侧也改成不让粗信号覆盖精信号。
 *
 * 并列时按端口**降序**。这个方向是任意的，但必须**确定**：一个会变的顺序会让同一台
 * 机器上「哪一份旧数据能找回来」变成掷骰子。
 */
export function orderLegacyPorts(seen: ReadonlyMap<number, number>): number[] {
  return [...seen.entries()]
    .filter(([port]) => isValidPort(port))
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])
    .map(([port]) => port)
}
