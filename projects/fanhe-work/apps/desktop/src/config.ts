/**
 * 服务地址配置（T4-02）。
 *
 * ## 这份配置放在哪，为什么
 *
 * 落在**工作区的 `.config/fanhe-work/`**，不落 Electron 的 `userData`。理由是
 * `userData` 与「配置」是两类东西：
 *
 * - `userData` 里装的是 Chromium 的缓存（Cache / Code Cache / GPU Cache）与
 *   `credential.ts` 的凭据密钥库。缓存是高频随机写，搬进 U 盘既慢又伤盘，这与
 *   「数据库刻意不进 U 盘」是同一条理由；凭据跟着介质走还会改变「profile 在系统盘、
 *   凭据不随工作空间移动」这个安全语义。
 * - 服务地址是**该跟着这套工作空间走的配置**：它描述的是「这套工作空间接哪个服务」，
 *   换台机器时带着走才对，而工作区根由 `.ws-root` 标记、与盘符无关。
 *
 * `.config/` 是工作区既有的逐机配置目录（`infra/portable/ws-env.sh` 把
 * `XDG_CONFIG_HOME` 指向那里，根 `.gitignore` 也已排除），所以这不是新造一个位置。
 *
 * ## 为什么要显式做成文件
 *
 * T4-01 把 `FANHE_SERVICE_URL` 当环境变量常量读，那在开发期够用，但环境变量无法
 * 持久化、且换机时用户要在外面重新设一遍。这份文件补上的正是这一段。
 *
 * **环境变量没有被删掉，它降级成「一次性覆盖」**：设了就赢过文件，下次启动就没了。
 * 这样开发与验证仍可用环境变量指一个临时端点，而日常使用不依赖它。
 *
 * ## 形状
 *
 * 只有一个字段 `serviceUrl`。本机与远程**不是两个槽位**，而是同一个地址的两种取值 ——
 * 「切换」的本质就是把这一项改成另一个 URL（`http://127.0.0.1:8787` ↔ 远程地址）。
 * 做成两个槽位（`localUrl` / `remoteUrl` + `active`）会引入一个真实存在的坏处：
 * 远程地址没配时切过去，外壳会以「没有可用地址」启动，而这与「配错了」在现场
 * 看起来一模一样。单字段下，配错会当场被校验挡下，报的是「这不是一个合法地址」。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

/** 配置文件相对工作区根的位置。 */
const CONFIG_RELATIVE_PATH = join('.config', 'fanhe-work', 'service.json')

/**
 * 缺省值。指向本机 API 的开发期地址，与 T4-01 原来那个常量一致 ——
 * 配置缺失时应当退回「和以前一样的行为」，而不是让外壳起不来。
 */
export const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8787'

export type ServiceConfig = {
  /** `/api` 反代的目标，形如 `http://127.0.0.1:8787` 或 `https://example.tld`。 */
  serviceUrl: string
}

export type LoadResult = {
  /** 最终生效的配置。 */
  config: ServiceConfig
  /**
   * 配置是从哪来的，供界面与日志说明「现在为什么连到这个地址」。
   *
   * `local-probe` 是安装态专有的来源：没有配置文件，但启动时探测到本机跑着
   * api，于是改用它并写回文件。加这一项而不是复用 `default`，是因为两者在
   * 排障时含义完全不同 —— 「用的是内置兜底」和「探测到了本机服务」该被区分开。
   */
  source: 'environment' | 'file' | 'default' | 'local-probe'
  /** 文件路径。仅在 `source === 'file'` 或写回时有意义。 */
  path: string
  /**
   * 读文件时遇到的问题。**不抛错**：配置坏了不等于外壳起不来，退回缺省并把
   * 原因报出来，比让用户对着一个空白窗口猜要强。
   */
  warning: string | null
}

/**
 * 从工作区根推导配置文件的绝对路径。
 *
 * 向上找 `.ws-root` 而不是用环境变量或写死盘符 —— 盘符在 `E:` / `F:` 之间变，
 * 而 `.ws-root` 是工作区自己声明的稳定标记。与 `infra/portable/ws-locate.ps1`
 * 同一套判据。
 */
export function findWorkspaceRoot(startDir: string): string | null {
  let current = resolve(startDir)
  for (;;) {
    if (existsSync(join(current, '.ws-root'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function configPathFor(workspaceRoot: string): string {
  return join(workspaceRoot, CONFIG_RELATIVE_PATH)
}

/**
 * 校验一个服务地址。
 *
 * 只收 `http:` / `https:`：反代发出去的是 `fetch`，它只认这两种协议，`ws:` /
 * `file:` 之类到这里就会被 `fetch` 拒掉，而报错发生在请求发出之后，比在这里挡下
 * 难查得多。末尾斜杠在这里归掉 —— 反代侧本来也会归一次，但配置值本身干净一点
 * 能让界面显示与文件内容一致。
 */
export function normalizeServiceUrl(
  value: unknown,
): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof value !== 'string') return { ok: false, error: 'serviceUrl 必须是字符串' }
  const trimmed = value.trim()
  if (trimmed === '') return { ok: false, error: 'serviceUrl 不能为空' }

  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: `serviceUrl 不是合法地址：${trimmed}` }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `serviceUrl 只支持 http 与 https，收到 ${parsed.protocol}` }
  }
  return { ok: true, value: trimmed.replace(/\/+$/, '') }
}

/** 解析配置文件内容。坏文件返回原因，不抛。 */
export function parseConfig(
  raw: string,
): { ok: true; config: ServiceConfig } | { ok: false; error: string } {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: `配置文件不是合法 JSON：${detail}` }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: '配置文件顶层应是一个对象' }
  }

  const record = data as Record<string, unknown>
  // 缺 `serviceUrl` 当作缺省，而不是报错：一个刚被创建出来的空配置也是有效的起点。
  if (record['serviceUrl'] === undefined)
    return { ok: true, config: { serviceUrl: DEFAULT_SERVICE_URL } }

  const normalized = normalizeServiceUrl(record['serviceUrl'])
  if (!normalized.ok) return { ok: false, error: normalized.error }
  return { ok: true, config: { serviceUrl: normalized.value } }
}

/**
 * 读配置。优先级：环境变量 → 配置文件 → 缺省。
 *
 * `fromDir` 是**必填**的，调用方自己决定从哪儿开始向上找 `.ws-root`。本模块刻意
 * 不用 `__dirname` 也不用 `import.meta.url` 来自己推断，两个都不成立：
 *
 * - `__dirname` 只在 CommonJS 里有效。而本模块有两条加载路径：生产走 `dist/` 下
 *   tsc 编出的 CJS（`apps/desktop` 刻意不带 `"type": "module"`，为的是保住沙箱化
 *   的预加载脚本），单测则由 Node 的类型剥离直接加载 `src/config.ts`，那条路径
 *   按 ESM 处理，`__dirname` 根本没有。写成 `__dirname ?? …` 这种兜底并不能同时
 *   覆盖两边 —— 在 ESM 里连引用它都会在**函数参数默认值求值时**抛
 *   `ReferenceError`，而那个时机早于任何显式传参，表现为「一调这个函数就炸」。
 * - `import.meta.url` 反过来：`tsconfig` 用 `module: NodeNext`，产物是 CJS，
 *   TypeScript 会以 TS1470 拒绝它（`The 'import.meta' meta-property is not
 *   allowed in files which will build into CommonJS output`）。
 *
 * 于是把这件事交回调用方：`main.ts` 跑在 CJS 里，`__dirname` 在那里有定义，
 * 由它传进来；单测传一个临时目录。这也让「从哪儿找工作区根」成为显式可测的输入，
 * 而不是藏在模块内部的一个隐式前提。
 */
export async function loadServiceConfig(options: {
  /** 从哪个目录开始向上找 `.ws-root`。 */
  fromDir: string
  /** 工作区根。给定则跳过向上查找，主要给测试与显式场景用。 */
  workspaceRoot?: string | null
  /**
   * 配置目录。给定则**不用工作区根**，配置落在 `<configDir>/service.json`。
   *
   * 装完之后没有工作区（T6-03a），而「服务地址」这件配置必须有地方落盘、且要能被
   * `service:set` 写回 —— 否则界面上的「切换服务地址」在安装版里是死的。安装态的
   * 调用方传 `app.getPath('userData')`，与凭据密钥库同在系统盘的逐用户目录里。
   *
   * **开发态不传这个参数**，于是路径仍由 `.ws-root` 推出、配置随工作空间走，
   * 与 T4-02 的行为一字不差。
   */
  configDir?: string
  /**
   * 什么配置都读不到时的兜底地址。缺省是 `DEFAULT_SERVICE_URL`。
   *
   * 安装态要传线上地址：那条「退回本机 8787」的兜底在开发机上恰好是对的（api 容器
   * 就在那儿），装到别人机器上却会连一个不存在的本机端口 —— 界面是坏的，而冒烟在本机
   * 还能全绿。**兜底值必须按形态给，不能共用一个。**
   */
  defaultUrl?: string
  /** 环境变量来源，默认 `process.env`。 */
  env?: NodeJS.ProcessEnv
}): Promise<LoadResult> {
  const env = options.env ?? process.env
  const fromDir = options.fromDir
  const fallbackUrl = options.defaultUrl ?? DEFAULT_SERVICE_URL

  const override = normalizeServiceUrl(env['FANHE_SERVICE_URL'])
  if (override.ok) {
    return {
      config: { serviceUrl: override.value },
      source: 'environment',
      path: '',
      warning:
        env['FANHE_SERVICE_URL'] === undefined
          ? null
          : `环境变量 FANHE_SERVICE_URL（${override.value}）覆盖了配置文件。它是一次性覆盖，退出后失效。`,
    }
  }

  const workspaceRoot = options?.workspaceRoot ?? findWorkspaceRoot(fromDir)

  // 路径的两条来源互斥：显式给了配置目录就用它（安装态），否则由工作区根推（开发态）。
  let path: string
  if (options.configDir !== undefined) {
    path = join(options.configDir, 'service.json')
  } else if (workspaceRoot !== null) {
    path = configPathFor(workspaceRoot)
  } else {
    return {
      config: { serviceUrl: fallbackUrl },
      source: 'default',
      path: '',
      warning: `未找到工作区根（向上找不到 .ws-root），退回缺省服务地址 ${fallbackUrl}。`,
    }
  }

  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return {
      config: { serviceUrl: fallbackUrl },
      source: 'default',
      path,
      warning: `未找到服务地址配置（${path}），退回缺省 ${fallbackUrl}。`,
    }
  }

  const parsed = parseConfig(raw)
  if (!parsed.ok) {
    return {
      config: { serviceUrl: fallbackUrl },
      source: 'default',
      path,
      warning: `服务地址配置不可用（${parsed.error}），退回缺省 ${fallbackUrl}。`,
    }
  }

  return { config: parsed.config, source: 'file', path, warning: null }
}

/** 写配置。会自动建目录。 */
export async function saveServiceConfig(
  path: string,
  config: ServiceConfig,
): Promise<ServiceConfig> {
  const normalized = normalizeServiceUrl(config.serviceUrl)
  if (!normalized.ok) throw new Error(normalized.error)

  const next: ServiceConfig = { serviceUrl: normalized.value }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  return next
}

/**
 * 探测一个地址上是否跑着 api。
 *
 * 判据是「有没有 HTTP 层」，不是「业务是否成功」：未带令牌的 `/api/health`
 * 可能回 401，那也证明端口上有个服务在听。把 401 当失败会让这个探测在最需要
 * 它的场合（刚装完、还没登录）判死。
 *
 * 用 `node:http` 而不是 `fetch`：主进程里的 fetch 会带上 Electron 的网络栈与
 * 代理设置，而这里要的是一个纯粹的「本机端口通不通」，不该受代理影响 —— 这台
 * 机器上代理恰好会把回环请求也劫持掉。
 *
 * 超时取 1.2 秒：本机回环端口要么立刻回，要么根本没人听。给长了只是在启动
 * 路径上白等，而这段代码跑在首屏之前。
 */
export function probeServiceHealth(baseUrl: string, timeoutMs = 1200): Promise<boolean> {
  let url: URL
  try {
    url = new URL(`${baseUrl.replace(/\/+$/, '')}/api/health`)
  } catch {
    return Promise.resolve(false)
  }
  if (url.protocol !== 'http:') return Promise.resolve(false)

  return new Promise((resolveProbe) => {
    let settled = false
    const finish = (alive: boolean): void => {
      if (settled) return
      settled = true
      resolveProbe(alive)
    }

    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port === '' ? 80 : Number(url.port),
        path: url.pathname,
        method: 'GET',
        timeout: timeoutMs,
      },
      (res) => {
        // 响应体不读，但要消费掉，否则连接不会释放。
        //
        // 任何状态码都算活着。实测过只认 200 的写法：401 会被判死，而
        // `test/config.test.mjs` 里「401 也算」那条用例就是为了拦住这种回归。
        res.resume()
        finish(true)
      },
    )
    req.on('timeout', () => {
      req.destroy()
      finish(false)
    })
    req.on('error', () => finish(false))
    req.end()
  })
}

/**
 * 安装态兜底：没有配置文件时，先看看本机有没有 api，别直接绕公网。
 *
 * ## 为什么需要
 *
 * `loadServiceConfig` 在配置文件缺失时退回 `defaultUrl`，而安装态那个值是内置
 * 的公网隧道地址。于是本机明明跑着 api，桌面端却从公网绕一圈回来：隧道一断界面
 * 全挂，而本地服务其实一切正常。2026-10-28 的登录失败就是这样 —— 数据库里
 * `failed_login_attempts` 是 0，说明请求根本没到后端。
 *
 * ## 什么时候不动手
 *
 * 只在 `source === 'default'` 时生效。配置文件存在、或环境变量给了值，都表示
 * 用户已经表过态，不该被探测结果覆盖。
 *
 * ## 为什么写回文件
 *
 * 启动路径上不该每次都花一秒去探一个基本不变的事实。写回之后 `service:set`
 * 那条界面入口读到的也是同一个值，不会出现「界面显示隧道地址、实际连本地」。
 * 写失败不算错：下次启动重新探测一次就是了。
 */
export async function adoptReachableLocalService(
  current: LoadResult,
  options: {
    probeUrl?: string
    probe?: (url: string) => Promise<boolean>
    persist?: boolean
  } = {},
): Promise<LoadResult> {
  if (current.source !== 'default') return current

  const target = options.probeUrl ?? DEFAULT_SERVICE_URL
  // 兜底值本来就是本机地址（开发态就是这种情形），没有可改的东西。
  if (current.config.serviceUrl === target) return current

  const probe = options.probe ?? probeServiceHealth
  const alive = await probe(target)
  if (!alive) {
    const note = `已探测本机 ${target}，没有响应。`
    return { ...current, warning: current.warning === null ? note : `${current.warning}${note}` }
  }

  const persist = options.persist ?? true
  let warning = `未找到服务地址配置，已探测到本机服务可用（${target}），改用本地直连。`
  if (persist && isWritablePath(current.path)) {
    try {
      await saveServiceConfig(current.path, { serviceUrl: target })
      warning += `已写入 ${current.path}，下次启动直接读它。`
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      warning += `写入失败（${detail}），下次启动会重新探测。`
    }
  }

  return { config: { serviceUrl: target }, source: 'local-probe', path: current.path, warning }
}

/** 配置里是否应当带一句说明。写文件时带上，好让手工编辑的人知道每个值可选什么。 */
export function renderConfigFile(config: ServiceConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** 供界面显示的来源说明。 */
export function describeSource(source: LoadResult['source']): string {
  if (source === 'environment') return '环境变量覆盖'
  if (source === 'file') return '配置文件'
  if (source === 'local-probe') return '本机探测'
  return '缺省值'
}

/** 该路径是不是一个可用于写入的绝对路径。防止把配置写到相对路径或空串。 */
export function isWritablePath(path: string): boolean {
  return path !== '' && isAbsolute(path)
}
