/**
 * 「服务端是不是已经有新版本了」的判定（T6-02）。
 *
 * ## 这一层负责什么
 *
 * 取服务端版本清单 → 校验拿到的确实是清单 → 与本机清单比对 → 得出**该不该提示**。
 * 界面只拿结论，不自己判断任何一项。
 *
 * ## 🔴 判定的依据是版本号，不是指纹是否相等
 *
 * 这一点与 T6-01 记录的事实直接相关：**两侧的指纹必然不相等**，而且这不是缺陷：
 *
 * - 前端的三个值来自 Vite 构建期的文本替换（`lib/version.ts`），是真实值；
 * - 服务端的清单在容器里跑，`.dockerignore` 排掉了 `.git`、镜像层也不记录构建时刻，
 *   所以 `builtAt` 恒为 `''`、`commitSha` 恒为 `'unknown'`（T6-01 已在生产验证过）。
 *
 * 于是 `compareManifests` 走不到 `same` 那一支：指纹不同 → 落到版本号比较 →
 * 同号时归 `ahead`。**而 `same` 与 `ahead` 在界面上都不提示**，所以这个事实对
 * 用户可见的行为没有影响：`outdated`（服务端版本号更大）是唯一会提示的分支，
 * 而它的判定完全由 `compareVersions` 决定。
 *
 * **不要因为「指纹总是不同」就去改 `compareManifests` 让它在这种情况下返回 `same`。**
 * 那会让「服务端跑的是这次提交、我这份前端是上次提交」被报成一致 —— 而那恰恰是
 * 这个指纹要抓的情况（见 shared 包 `version.ts` 的文件头）。
 *
 * ## 形状不对时降级为 `unknown`，不报错
 *
 * 响应会**先经过 Cloudflare 那一层**（T5-04）。今天源站直连、Tunnel 正常返回清单；
 * 但 T5-05 的 Access 落地后，任何未通过认证的请求会先拿到 Access 的登录/拦截页 ——
 * 那是 HTTP 200 + HTML 正文。再往后，网关超时页、CDN 的错误页也是同一类。
 *
 * 这些响应都**不能**当成「服务端有更新」，也不能让整条路径抛出去：比对是**非关键路径**，
 * 崩掉的表现是应用起不来，而它的全部价值只是少一次提示。所以任何一步拿不准都归
 * `unknown`，而 `unknown` 不提示（理由见 shared 包 `compareManifests` 的注释）。
 *
 * ## 单开文件而不是写进 TopBar
 *
 * 同 `lib/theme.ts` 的理由：react-refresh 无法在一个同时导出组件与 hook 的文件里
 * 确定该保留哪一部分的状态；而且这一层是纯逻辑，可以在 Node 里直接测。
 *
 * ## 这一层不 import 任何相对路径的模块
 *
 * 取数由调用方以参数传进来（`useVersionCheck` 传 `versionManifestRequest`），本机清单
 * 的三项也由它传进来。表面看是多绕两层，实际是被测试逼出来的：**本项目的前端模块
 * 之间一律用无扩展名的相对引用**（`'./api'`、`'./version'`，Vite 侧风格），而 Node 的
 * ESM 解析要求写全扩展名 —— 一旦在模块顶层 import 其中任何一个，
 * `test/*.test.mjs` 就会在**加载阶段**报 `ERR_MODULE_NOT_FOUND`，连这一层里所有纯函数
 * 用例都跑不了（报出来的还是一个与被测逻辑毫无关系的模块解析错误）。
 *
 * 唯一的例外是 `@fanhe/shared`：那是包引用，Node 按 `exports` 字段解析，与扩展名无关。
 *
 * **不要为了「少绕一层」把扩展名补上。** 补了之后 Vite 侧仍能跑，但本文件与其余前端
 * 模块的风格就不一致了，而不一致会在下一个文件里被再次复制。
 *
 * 与 `lib/version.ts` 里「时区偏移当参数传」同款：把环境相关的东西推到边界上，
 * 纯逻辑就能在任何环境里被测。
 */

import {
  type VersionComparison,
  type VersionManifestResponse,
  compareManifests,
  computeBuildFingerprint,
} from '@fanhe/shared'

/**
 * 版本检查的超时。
 *
 * `/api/version` 只做「读根 `package.json` + 算一次哈希」，同机在毫秒级，走公网也就一个
 * 往返。5 秒足够覆盖冷启动与跨网延迟，又不至于让菜单里那一行提示悬着不出现。
 *
 * **不设更短。** 局域网里被代理或 DNS 慢解析时，2 秒会误杀成 `unknown` —— 而误杀的方向
 * 是「不提示更新」，用户因此以为自己是最新版，而实际不是。宁可多等几秒。
 */
export const VERSION_CHECK_TIMEOUT_MS = 5000

/**
 * 本机清单的原始三项。**由调用方传入**，理由见文件头那节。
 *
 * 指纹在这里算而不是由调用方给：它就是这三项的摘要，而「摘要与被摘要的东西分开放」
 * 会在某次只改了三项之一时静默不一致。
 */
export type LocalVersionInput = {
  version: string
  builtAt: string
  commitSha: string
}

/**
 * 版本标签：`v0.1.0`。
 *
 * **这里内联而不是复用 `lib/version.ts` 的 `formatVersionLabel`。** 复用要先 import
 * 那个模块，而那会撞上文件头那节的扩展名问题；而这个函数只有一行 `v${x}`，
 * 「同一个格式规则写两遍」的真实风险是改了一处忘了另一处 —— 由下面这条测试钉住：
 * `version-check.test.mjs` 里断言了本函数对 `0.1.0` 与 `1.0.0-rc.1` 的输出，
 * 与 `version.test.mjs` 里那两条同值。**改一处必须改两处，否则这条会红。**
 */
function formatVersionLabel(version: string): string {
  return `v${version}`
}

/**
 * 把传输层拿到的未知值校验成清单，形状不对就返回 `null`。
 *
 * **逐个字段查类型，而不是只查 `version`。** 少一个字段不会让这里崩，但会让
 * `compareManifests` 拿一个 `undefined` 去比 —— 而它内部第一件事就是
 * `local.fingerprint === ''`，`undefined === ''` 为假，于是这一层被绕过，
 * 错误推迟到 `compareVersions` 里的 `undefined.split` 才暴露。**把错误留在它出现
 * 的地方，是这个函数存在的全部意义。**
 *
 * **`fingerprint` 缺失时按三项重算**，而不是判定形状不对。服务端是同一次构建产物，
 * 它算出来的指纹就是这三项的哈希；一个只回了三个字段的响应（将来若字段增删）
 * 完全可以补出正确的指纹，而因为少一个派生字段就报「拿不到清单」是更差的失败。
 *
 * 数组被显式排除：`typeof [] === 'object'`，不排它的话 `payload[0]` 这类取值会
 * 在后面某处得到一个语义完全错的答案。
 */
export function parseVersionManifest(payload: unknown): VersionManifestResponse | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null

  const candidate = payload as Partial<VersionManifestResponse>
  const { version, builtAt, commitSha } = candidate

  // 版本号必须是**非空**字符串。空串会让 `compareVersions` 把它解析成 0.0.0，
  // 于是任何服务端版本都被判成「更新」—— 一个方向完全错误的提示。
  if (typeof version !== 'string' || version === '') return null

  // 这两个字段只用于展示，缺失时按空串处理（与 shared 包对空串的约定一致：
  // 「取不到」用空串表示）。
  const safeBuiltAt = typeof builtAt === 'string' ? builtAt : ''
  const safeCommitSha = typeof commitSha === 'string' ? commitSha : ''

  const fingerprint =
    typeof candidate.fingerprint === 'string' && candidate.fingerprint !== ''
      ? candidate.fingerprint
      : computeBuildFingerprint(version, safeBuiltAt, safeCommitSha)

  return { version, builtAt: safeBuiltAt, commitSha: safeCommitSha, fingerprint }
}

/** 比对结果到界面文案。`null` 表示不提示。 */
export type UpdateNotice = {
  /** 服务端那一版的版本标签（带 `v` 前缀）。 */
  latestVersion: string
  /** 菜单里那一行。 */
  text: string
  /** 悬停说明：把两边的版本号都写出来。 */
  title: string
  /**
   * 这一行被选中时该做什么。
   *
   * `reload` —— 浏览器态：刷新页面就会拿到新的前端产物。
   * `install` —— 桌面态：界面是内置产物，刷新不会变；要交给外壳的更新通道去装。
   *   见 `lib/host.ts` 的文件头（这是 T6-03b 收口 T6-02 的那一处）。
   */
  action: UpdateNoticeAction
}

export type UpdateNoticeAction = 'reload' | 'install'

/**
 * 宿主。**内联而不是从 `lib/host.ts` import。**
 *
 * 理由与下面 `formatVersionLabel` 那段一样：本模块 import 任何相对路径模块都会撞上
 * 文件头那节的扩展名问题，连纯函数用例都跑不了。
 *
 * 「同一套取值写两处会漂移」由测试钉住：`version-check.test.mjs` 里直接把
 * `detectHost(...)` 的返回值喂给 `buildUpdateNotice`，所以两个模块对这一组取值的
 * 理解一旦分叉，用例就会红。
 */
export type UpdateNoticeHost = 'browser' | 'desktop'

/**
 * 比对结果 → 提示文案。只有 `outdated` 提示。
 *
 * **`same` / `ahead` / `unknown` 一律返回 `null`。** 前两个是「不需要提示」，
 * `unknown` 是「无法判断」—— 把无法判断报成「有更新」比不报更糟（它会让用户在
 * 没有更新的情况下反复去找「怎么更新」，而那个按钮不存在）。
 *
 * 传 `localVersion` 与 `host` 做参数而不是读模块常量：这样测试能钉住文案而不必改
 * 构建常量，与 `lib/version.ts` 里那批 `build*` / `format*` 同款。**不给默认值** ——
 * 这一层不 import `version.ts` / `host.ts`（理由见文件头），而一个「忘了传就报错」的
 * 必填参数比一个悄悄退化成 `undefined` 的默认值更容易在测试里发现。
 *
 * 🔴 **两个宿主的文案必须不同，且这不是装饰。** 桌面外壳加载的是内置产物，
 * 「刷新页面即可更新」在那儿是一句做不到的话：用户照做、页面没变，此后他不再信这条
 * 提示 —— 而这一行的全部价值就是让他知道有新版本。
 */
export function buildUpdateNotice(
  comparison: VersionComparison,
  localVersion: string,
  host: UpdateNoticeHost,
): UpdateNotice | null {
  if (comparison.outcome !== 'outdated') return null

  const latestLabel = formatVersionLabel(comparison.latest.version)
  if (host === 'desktop') {
    return {
      latestVersion: comparison.latest.version,
      // 「点此重启更新」而不是「重启后生效」：外壳把这一行接到了真实的安装动作上
      // （T6-03b 的 `update:install`，它装完就让应用退出重启），把话说成「你自己去重启」
      // 会让人以为还得手动做什么，而现在点一下就够了。
      text: `已可更新到 ${latestLabel}，点此重启更新`,
      title: `本机 ${formatVersionLabel(localVersion)} · 服务端 ${latestLabel} · 点此安装并重启`,
      action: 'install',
    }
  }

  return {
    latestVersion: comparison.latest.version,
    text: `服务端已是 ${latestLabel}，刷新页面即可更新`,
    title: `本机 ${formatVersionLabel(localVersion)} · 服务端 ${latestLabel}`,
    action: 'reload',
  }
}

/**
 * 取服务端清单的那一步。收 `signal` 是为了能真的中断传输。
 *
 * **只承诺「resolve 成拿到的那个值」，不承诺形状。** 响应会先经过 Cloudflare 那一层，
 * 那里给什么就是什么（见文件头）；形状校验在 `parseVersionManifest`。
 */
export type ManifestFetcher = (signal: AbortSignal) => Promise<unknown>

/**
 * 发起一次版本检查，返回结果与取消句柄。
 *
 * **返回句柄而不是只返回 Promise**，因为取消这件事必须由发起方掌握：只有在它才知道
 * 「下一次检查已经开始了，上一次该作废」。把 controller 藏在函数内部、另设一个
 * `aborted` 标志给调用方看的那种写法会**看起来能取消、实际只置了个标志** ——
 * 请求照跑到底，只是结果被丢弃。
 *
 * **超时用 `AbortSignal` 而不是 `setTimeout` 后丢弃结果。** 后者让那次请求继续跑完并
 * 占着连接；真正的取消能停掉传输。顺带说，`api.ts` 会把中断归成 `network_error`，
 * 对这个「拿不到就是拿不到」的判断没有影响。
 *
 * **fetch 作为参数传入**（见文件头那节为什么不能在这里 import `./api`）。它同时也是
 * 测试的入口：注入一个返回固定值的假 fetch 就能覆盖「形状不对 → unknown」这条路径，
 * 而那正是这一层最需要被钉住的行为。
 */
export function startVersionCheck(
  fetchManifest: ManifestFetcher,
  local: LocalVersionInput,
): {
  result: Promise<VersionComparison>
  abort: () => void
} {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, VERSION_CHECK_TIMEOUT_MS)

  const result = (async (): Promise<VersionComparison> => {
    try {
      const payload = await fetchManifest(controller.signal)
      const remote = parseVersionManifest(payload)
      // 拿到的不是清单 —— 最可能是 Cloudflare Access 的登录页（T5-05 之后）。
      // 降级而不是报错，理由见文件头。
      if (remote === null) return { outcome: 'unknown' }
      // 本机指纹在这里算，而不是调用方算好传进来：算一次 SHA-256 的开销可以忽略，
      // 而「指纹与三项分开放」会在某次只改了三项之一时静默不一致。
      const localManifest: VersionManifestResponse = {
        ...local,
        fingerprint: computeBuildFingerprint(local.version, local.builtAt, local.commitSha),
      }
      return compareManifests(localManifest, remote)
    } catch {
      return { outcome: 'unknown' }
    } finally {
      clearTimeout(timer)
    }
  })()

  return {
    result,
    abort: () => {
      clearTimeout(timer)
      controller.abort()
    },
  }
}
