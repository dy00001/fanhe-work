/**
 * 跨包的路径解析。
 *
 * ## 为什么需要它
 *
 * T4-03 要复用 `apps/api/src/launch/agent.ts`，而那份文件是 **TypeScript 源码**，
 * `apps/api` 的构建产物在 `apps/api/dist/` —— 但 `desktop` 刻意用 CommonJS，
 * `api` 那边的产物是 ESM。两边模块系统不同，且**没有必要**去解这个结：真正需要
 * 的只有「主进程能调 `runLaunchProfile` 这一个函数」。
 *
 * 因此走 `import()` 动态加载 **TS 源码**。Node 的类型剥离（`--experimental-strip-types`
 * 或 Electron 内置的等价能力）能直接执行 `.ts`，不需要构建，也就不引入构建顺序
 * 依赖 —— `agent.ts` 改完，外壳下一次启动就用新的，不存在「忘了先构建 api」。
 *
 * ## 为什么在加载前显式检查
 *
 * `import()` 一个不存在的路径会抛 `MODULE_NOT_FOUND`，而那条消息指向的是
 * `node_modules` 里的一个中间路径，看不出「真正缺的是 apps/api 的源码目录」。
 * 所以先 `existsSync` 一次，缺了就抛一条能直接照着修的说明。
 *
 * ## 路径怎么推出来的
 *
 * **从 `fromDir` 向上，不写盘符。** 盘符在 `E:` / `F:` 之间变（工作空间在可移动
 * 介质上），而工作区里有 `.ws-root` 这个稳定标记。产物里传进来的 `fromDir` 是
 * `apps/desktop/dist`，源码里（类型剥离路径）是 `apps/desktop/src`，两者到工作区
 * 根的距离差一级 —— `paths.ts` 因此同时认这两种深度。
 *
 * ## 为什么 `fromDir` 是必填参数
 *
 * 写成 `fromDir = __dirname` 看着更省事，实际是**定时炸弹**：默认参数只在实参为
 * `undefined` 时求值，于是「谁忘了传」会变成一条只在那一刻炸的、且栈里指向
 * `paths.ts` 内部的报错。T4-02 的 `config.ts` 已经踩过同一类问题的另一面
 * （参数默认值里的 `__dirname` 在 ESM 路径下不存在），沿用同一条约定：由跑在
 * CommonJS 的 `main.ts` 显式传 `__dirname`。
 *
 * 顺带收获是**这段逻辑可测了**。模块内不留 `__dirname`，单测就能在 ESM 里直接
 * 传一个自己造的目录进去，断言「找不到 `.ws-root` 时怎么报」「仓库结构变了怎么报」
 * 这些真实分支 —— 而它们恰恰是最容易在换机时才暴露的那几条。
 */
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 从本文件所在位置向上找 `.ws-root`。找不到返回 null，不抛。 */
function findWorkspaceRoot(startDir: string): string | null {
  let current = resolve(startDir)
  for (;;) {
    if (existsSync(join(current, '.ws-root'))) return current
    const parent = join(current, '..')
    if (parent === current) return null
    current = parent
  }
}

/**
 * 工作区根。产物与源码两种深度都能定位。
 *
 * 返回 null 表示**找不到**而不是抛错：调用方（`main.ts`）会把它当成「本机代理不可
 * 用」这一种情况来处理，而那是一个已知的、需要能被界面报出来的状态，不该在模块
 * 加载期就把整个外壳带崩。
 */
export function locateWorkspaceRoot(fromDir: string): string | null {
  return findWorkspaceRoot(fromDir)
}

/**
 * `apps/api` 的源码目录。
 *
 * 抛错的情形有两种，都给出可照着修的话：找不到工作区根（介质缺 `.ws-root`），
 * 以及根下没有 `projects/fanhe-work/apps/api`（仓库结构变了）。
 */
export function apiSourceRoot(workspaceRoot: string): string {
  const apiRoot = join(workspaceRoot, 'projects', 'fanhe-work', 'apps', 'api', 'src')
  if (!existsSync(apiRoot)) {
    throw new Error(
      `未找到 api 源码目录：${apiRoot}。` +
        `本机代理直接加载 apps/api/src/launch/agent.ts 的源码（不构建产物），` +
        `确认工作区里 apps/api/src 是否完整。`,
    )
  }
  return apiRoot
}

/**
 * 加载 `apps/api/src/launch/agent.ts`。
 *
 * **每次调用都重新加载的代价是刻意的**：Node 的模块缓存按 URL 索引，同一个 URL 第二次
 * `import()` 会拿到同一个实例。这本来正是想要的（去重缓存要跨调用生效），但它要求
 * 加载路径**在进程内保持稳定** —— 本函数每次都从同一个 `fromDir` 推导，天然满足。
 *
 * 反过来，如果为了「省一次加载」把实例缓存到模块级变量，那么 `agent.ts` 里的
 * `recentRuns` 去重表就在**两个壳实例**之间不共享 —— 一旦将来支持多窗口或热重载，
 * 去重会静默失效，症状是「任务管理器里躺着五个微信」，而那条规则的注释正好写着它
 * 要防的就是这件事。
 *
 * ## 为什么 `import()` 的参数是 URL 而不是路径
 *
 * `import()` 走的是 ESM 加载器，它只认 `file:` / `data:` / `node:` 这三种协议。
 * 直接喂一条 Windows 绝对路径（`F:\...\agent.ts`）会被当成协议名为 `f` 的 URL 而
 * 拒掉：`ERR_UNSUPPORTED_ESM_URL_SCHEME`。
 *
 * 这一条是**只有真机才暴露**的：前一层单测用的是假 agent 模块，从不真的 import，
 * 于是它在 desktop 全绿的情况下一直是坏的。因此必须 `pathToFileURL` 转一次，
 * 顺带也把工作区路径里的空格（`fanhe Work`）正确编码掉 —— 手拼 `file://` 十有八九
 * 会漏掉这一步，而漏掉的症状是「路径里有空格时才坏」，更难查。
 *
 * ## 装完之后没有工作区（T6-03a）
 *
 * 开发态吃的是工作区里的源码，改完 `agent.ts` 下次启动即生效。但**安装包形态下根本
 * 没有工作区** —— `locateWorkspaceRoot` 会返回 `null`，而那不是出错，是那一形态的
 * 正常状态。所以这里多一条 `bundledAgent` 降级：找不到工作区时就加载随包资源
 * （安装目录 `resources/agent/agent.ts`，见 `electron-builder.yml`）。
 *
 * **`bundledAgent` 是可选参数，且开发态调用方不传它。** 这一条是刻意的：不传时
 * 三条分支的行为与 T4-03 一字不差（报错文本也一样），于是既有的路径回归测试不需要
 * 为了让新分支通过而放宽。传了才启用降级。
 *
 * 降级能成立的前提是**那份源码运行时依赖为零**（只有 node 内建 + 一条会被抹掉的
 * `import type`），所以它可以原样投递、不必编译 —— 这一点已实测，见
 * `docs/T6-03-UPDATE-CHANNEL.md` §3.2。
 */
export async function apiLaunchModule(fromDir: string, bundledAgent?: string): Promise<unknown> {
  // 「传了随包路径」就是「允许降级」的信号。开发态的调用方不传，于是四条失败分支
  // 各自还抛原来那句话（报错文本被 T4-03 的测试钉着），行为与那时一字不差。
  const target = resolveWorkspaceAgent(fromDir, bundledAgent !== undefined)
  if (target !== null) return await import(pathToFileURL(target).href)

  if (bundledAgent !== undefined && existsSync(bundledAgent)) {
    return await import(pathToFileURL(bundledAgent).href)
  }

  throw new Error(
    `本机代理核心没找到。工作区侧从 ${fromDir} 推不出 apps/api/src/launch/agent.ts，` +
      `随包侧 ${String(bundledAgent)} 也不存在。` +
      `开发态查工作区是否完整（要有 .ws-root 与 apps/api/src）；` +
      `安装态查安装目录下 resources/agent/agent.ts 有没有随包投出。`,
  )
}

/**
 * 工作区里的代理源码路径；推不出来时按 `lenient` 决定是抛错还是返回 `null`。
 *
 * `lenient === false`（开发态）**逐条抛出可照着修的话**，这是 T4-03 定下的行为：
 * 「介质拷漏了」与「盘符变了」在外壳上的表现都是「点启动说本机代理不可用」，
 * 原因却在一条 `join()` 里，所以报错必须说清缺的是哪一段。
 *
 * `lenient === true`（安装态）**一律返回 `null` 不抛**：装完之后根本没有工作区，
 * 那是那一形态的正常状态而不是错误，此时该做的是接着去找随包资源。
 * 四条分支都要覆盖到 —— 只覆盖「找不到 .ws-root」是不够的：一台插着残缺介质的
 * 机器会走到「有根但没有 api 源码」那一支，而那一支原来会抛错把降级顶掉。
 */
function resolveWorkspaceAgent(fromDir: string, lenient: boolean): string | null {
  const root = locateWorkspaceRoot(fromDir)
  if (root === null) {
    if (lenient) return null
    throw new Error(
      `未找到工作区根（从 ${fromDir} 向上找不到 .ws-root）。` +
        `本机代理需要定位 apps/api 源码，确认工作区完整。`,
    )
  }

  let apiRoot: string
  try {
    apiRoot = apiSourceRoot(root)
  } catch (error) {
    if (lenient) return null
    throw error
  }

  const target = join(apiRoot, 'launch', 'agent.ts')
  if (!existsSync(target)) {
    if (lenient) return null
    throw new Error(`未找到本机代理核心：${target}。确认 apps/api/src/launch/agent.ts 存在。`)
  }
  return target
}

/**
 * 前端构建产物的落点。
 *
 * 开发态它是 `apps/desktop/dist` 的上两级兄弟（`apps/web/dist`），由
 * `pnpm --filter @fanhe/web build` 生成；**打包态 asar 里没有兄弟目录**，
 * 产物由 `electron-builder.yml` 的 extraResources 投到 `resources/web`。
 *
 * 参数是显式的而不是在函数里读 `app.isPackaged` / `process.resourcesPath`：
 * 那两样都要求在 Electron 运行时里才拿得到，而这个模块要能在纯 Node 的单测里直接跑
 * （与 `locateWorkspaceRoot` 的 `fromDir` 同一条理由）。
 */
export function webDistRoot(options: {
  packaged: boolean
  resourcesPath: string
  fromDir: string
}): string {
  if (options.packaged) return join(options.resourcesPath, 'web')
  return resolve(options.fromDir, '../../web/dist')
}

/**
 * 随包投出的本机代理源码路径（`electron-builder.yml` 的 `agent/agent.ts`）。
 *
 * 单列一个函数是为了让「安装态去哪儿找」这件事只有一个定义处 —— 它同时被
 * `main.ts` 与说明文档引用，两处各写一遍迟早会偏。
 */
export function bundledAgentPath(resourcesPath: string): string {
  return join(resourcesPath, 'agent', 'agent.ts')
}
