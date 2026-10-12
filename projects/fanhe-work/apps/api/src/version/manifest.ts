import type { FastifyInstance } from 'fastify'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeBuildFingerprint } from '@fanhe/shared'
import type { VersionManifestResponse } from '@fanhe/shared'

/**
 * 版本清单（T6-01）。
 *
 * ## 这份清单与界面上那个版本号的区别
 *
 * 界面上显示的版本号（`apps/web/src/lib/version.ts`）是**构建期注入**的：版本号、
 * 构建时刻、提交短号三者都由 vite 的 `define` 写进前端产物。
 *
 * 而 api 这一侧拿不到那三个值里的两个：
 *
 * - **提交号拿不到**：`.dockerignore` 排掉了 `.git`，构建上下文里没有 git 仓库，
 *   `git rev-parse` 在容器里必然失败（构建阶段与运行阶段都不行）。
 * - **构建时刻拿不到**：镜像层一旦建好，「这层是什么时候建的」不在容器可见的任何
 *   文件里。
 *
 * **这不是缺陷而是这个包的形态决定的**：api 是「服务端」，它的身份应当由**部署
 * 的是什么版本**回答，而不是「某次构建发生在几点几分」。
 *
 * ## 那指纹还能起什么作用
 *
 * 它仍然有用，但**作用范围变了** —— 它只能区分「不同的 api 镜像」，而**不能**和
 * 前端那份指纹直接相等比对。这一点在接口字段的注释里写明了，因为 T6-02 拿到的
 * 两份清单会来自不同来源，**误把它们当成同一个哈希体系会得出错误结论**
 * （见 `VersionManifestResponse.fingerprint` 与 `compareManifests` 的注释）。
 *
 * **换句话说：T6-02 要比的是「版本号」，不是「指纹」。** 指纹在这里的作用是
 * 「同一个版本号下是不是同一份服务端产物」—— 而那对单用户部署意义不大，
 * 它的价值在于**为将来的多实例部署留一个能区分实例的依据**。
 *
 * ## 为什么版本号在运行时读文件而不是构建期注入
 *
 * 读文件的好处是**镜像里那份 package.json 就是真正的版本来源**，不存在「注入的值
 * 与镜像里的文件对不上」那种情况 —— 而那恰恰是注入式最常见的失效：改了
 * package.json 但忘了重新构建，接口报的还是旧版本。
 *
 * **而这是唯一不需要改 Dockerfile 的做法。** 运行时阶段已经 COPY 了根
 * `package.json`（它与 `pnpm-lock.yaml` 一起被 COPY 是为了 pnpm 的链接式布局），
 * 所以那份文件本来就在镜像里，只是顺带地被用上了。
 *
 * 代价是**启动时读一次文件**（而不是构建期算好）。这个开销是一次性的、可忽略的
 * 读操作，而收益是「接口报的版本与镜像里的清单严格一致」。
 */

export type VersionInfo = {
  /** 产品版本号，取自仓库根 `package.json`。 */
  version: string
  /**
   * 构建时刻，ISO 8601。
   *
   * **这一侧恒为空串**，理由见文件头：镜像里没有「构建发生在什么时候」这个事实。
   * 字段保留在类型里是为了让 T6-02 能用同一份 `VersionManifestResponse` 处理两侧，
   * 而前端那份是有的 —— **两侧字段集不同却共用一个类型，比分两个类型更省事**，
   * 也免掉 T6-02 里「这个字段在服务端侧是不是有效」的一堆分支。
   */
  builtAt: string
  /**
   * 构建时的提交短号。**这一侧恒为 `'unknown'`**，理由同上。
   *
   * 它取 `'unknown'` 而不是空串，是为了让 T6-02 拿到一个**能显示出来**的值 ——
   * 空串在界面上是一块空白，读者不知道那是「没有」还是「出错了」，而
   * `'unknown'` 明确说了「这一侧拿不到」。
   */
  commitSha: string
}

/**
 * 从模块自身的位置向上找仓库根，读它的 `package.json`。
 *
 * ## 为什么不用 `process.cwd()`，也不用写死层数
 *
 * `process.cwd()` 取决于容器的工作目录，而那个值能被 `--workdir` 或启动脚本改掉
 * —— 一旦被改，`readFileSync('package.json')` 要么报 ENOENT，要么读到**另一个**
 * package.json（比如 `apps/api/package.json`，那份的 `version` 是 `0.0.0`）。
 *
 * **那是最坏的一种失败：不报错、返回一个看起来合法的值、而它是错的。** 而
 * `0.0.0` 恰好是「永远比任何正式版都旧」的那个值，于是接口会永远说
 * 「服务端有更新」。
 *
 * **写死层数同样不行**，只是错法不同：编译产物在 `dist/version/manifest.js`
 * （根在四层之上），源码在 `src/version/manifest.ts`（也是四层，因为 `src` 与
 * `dist` 同深度）。两者恰好一致是这个方案能成立的前提，而**它是个巧合** ——
 * 目录一调整就会静默读错。
 *
 * ## 所以逐级上溯，认 `pnpm-workspace.yaml` 为根
 *
 * 那份文件是 pnpm workspace 的标记文件，**只有仓库根有**，且它不参与构建产物。
 * 找到它就说明「再往上没有意义了」，此时的 `package.json` 就是唯一来源。
 *
 * **这个判据不能换成「目录里有没有 package.json」** —— 沿路每一层都有
 * （`apps/api/package.json`、`apps/web/package.json`…），那会停在最近的那一层，
 * 而那几份的 `version` 都是 `0.0.0`。
 *
 * **查找以模块自身位置为起点**（`import.meta.url`），那个位置由文件的实际落点
 * 决定，不受工作目录、`--workdir` 或启动脚本的影响。
 */
function readProductVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url))

  for (const candidate of walkUp(here)) {
    try {
      // 先确认这是根，再读版本号。**顺序不能反** —— 沿路每一层都有
      // package.json，先读它就可能读到 `0.0.0`。
      if (!existsSync(resolve(candidate, 'pnpm-workspace.yaml'))) continue

      const parsed = JSON.parse(readFileSync(resolve(candidate, 'package.json'), 'utf8')) as {
        version?: unknown
      }
      if (typeof parsed.version === 'string' && parsed.version !== '') {
        return parsed.version
      }
    } catch {
      // 继续往上找。中间层缺文件或内容不是合法 JSON 都属正常 ——
      // 这里只把「这一层不是根」这件事当作「不是」。
    }
  }

  throw new Error(
    `从 ${here} 向上找不到仓库根（认 pnpm-workspace.yaml 为标记），` +
      '镜像构建可能漏 COPY 了清单 —— 这会让版本清单接口说谎，所以这里直接失败。',
  )
}

/** 从 `start` 逐级向上产出候选目录，到文件系统根为止（不含根本身）。 */
function* walkUp(start: string): Generator<string> {
  let current = resolve(start)
  for (;;) {
    const parent = dirname(current)
    if (parent === current) return
    current = parent
    yield current
  }
}

/**
 * 当前这份 api 的版本事实。
 *
 * **在进程内缓存，但不是模块加载时算的** —— 见 `getVersionManifest` 的注释。
 */
let cached: VersionInfo | null = null

function getVersionInfo(): VersionInfo {
  if (cached === null) {
    cached = {
      version: readProductVersion(),
      builtAt: '',
      commitSha: 'unknown',
    }
  }
  return cached
}

/**
 * 当前这份 api 的完整版本清单。
 *
 * **为什么懒算而不是模块加载时就算。** 模块加载时读文件有两个问题：一是**读不到
 * 就抛**，而模块加载期的抛错会表现为一段极难定位的启动栈；二是**测试里替换起来
 * 麻烦**（要改模块缓存）。
 *
 * 懒算把它变成「第一次有人问版本时读一次」，代价是那次调用多一次文件读 —— 可忽略。
 */
export function getVersionManifest(): VersionManifestResponse {
  const info = getVersionInfo()
  return {
    version: info.version,
    builtAt: info.builtAt,
    commitSha: info.commitSha,
    // **指纹由「这一侧自己有的那三项」算出** —— 即版本号、空串、`unknown`。
    // 它的稳定性因此只取决于版本号：同一个 api 镜像每次启动算出的指纹一样，
    // 而升级版本后指纹变。**它与前端那份指纹不相等，这是上面那节说明的性质，
    // 不是 bug。**
    fingerprint: computeBuildFingerprint(info.version, info.builtAt, info.commitSha),
  }
}

/**
 * 版本清单路由。
 *
 * ## 不设门禁，但**它确实会泄露构建信息**
 *
 * 版本号与提交号对外可见，这是这类接口的固有性质，不是配置疏漏。判断依据：
 *
 * - 它不泄露任何**用户数据**、不暴露任何凭据、不改变任何状态。
 * - T6-02 需要它在**登录之前**可用 —— 否则「服务端有新版本」这条提示本身就要先
 *   登录才看得到，而那正是「客户端太旧以致什么都跑不起来」的情形。
 * - 提交短号与版本号已经在客户端产物里明文可见（`version.ts` 那几个注入常量），
 *   对外可见不增加任何信息量。
 *
 * **但如果将来给它加上「是否最新」这类可推导的信息（比如「你的版本落后几个版本」
 * 或「当前有多少客户端在线」），那就要重新评估** —— 那时报出去的才是可被利用的
 * 信息量，而本文件这条注释就是那时的复查起点。
 */
export function registerVersionRoutes(app: FastifyInstance): void {
  app.get('/api/version', async () => {
    const body: VersionManifestResponse = getVersionManifest()
    return body
  })
}
