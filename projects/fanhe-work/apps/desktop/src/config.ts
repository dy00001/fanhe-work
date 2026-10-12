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
  /** 配置是从哪来的，供界面与日志说明「现在为什么连到这个地址」。 */
  source: 'environment' | 'file' | 'default'
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
  /** 环境变量来源，默认 `process.env`。 */
  env?: NodeJS.ProcessEnv
}): Promise<LoadResult> {
  const env = options.env ?? process.env
  const fromDir = options.fromDir

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
  if (workspaceRoot === null) {
    return {
      config: { serviceUrl: DEFAULT_SERVICE_URL },
      source: 'default',
      path: '',
      warning: `未找到工作区根（向上找不到 .ws-root），退回缺省服务地址 ${DEFAULT_SERVICE_URL}。`,
    }
  }

  const path = configPathFor(workspaceRoot)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return {
      config: { serviceUrl: DEFAULT_SERVICE_URL },
      source: 'default',
      path,
      warning: `未找到服务地址配置（${path}），退回缺省 ${DEFAULT_SERVICE_URL}。`,
    }
  }

  const parsed = parseConfig(raw)
  if (!parsed.ok) {
    return {
      config: { serviceUrl: DEFAULT_SERVICE_URL },
      source: 'default',
      path,
      warning: `服务地址配置不可用（${parsed.error}），退回缺省 ${DEFAULT_SERVICE_URL}。`,
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

/** 配置里是否应当带一句说明。写文件时带上，好让手工编辑的人知道每个值可选什么。 */
export function renderConfigFile(config: ServiceConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

/** 供界面显示的来源说明。 */
export function describeSource(source: LoadResult['source']): string {
  if (source === 'environment') return '环境变量覆盖'
  if (source === 'file') return '配置文件'
  return '缺省值'
}

/** 该路径是不是一个可用于写入的绝对路径。防止把配置写到相对路径或空串。 */
export function isWritablePath(path: string): boolean {
  return path !== '' && isAbsolute(path)
}
