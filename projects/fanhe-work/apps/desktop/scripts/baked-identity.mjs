#!/usr/bin/env node
/**
 * 从**已构建的前端产物**里读回构建期注入的三个身份值（T7-05）。
 *
 * ## 这个模块补的是什么
 *
 * `apps/web/vite.config.ts` 的 `define` 把三个值**文本替换**进产物：
 *
 *   __APP_VERSION__  ← 仓库根 `package.json` 的 `version`（构建那一刻的值）
 *   __BUILD_TIME__   ← 构建那一刻的 `new Date().toISOString()`
 *   __COMMIT_SHA__   ← 构建那一刻的 `git rev-parse --short HEAD`
 *
 * 它们是「这份 bundle 是用哪份代码、什么时候构建的」的**唯一凭据**，而三者都只在
 * 构建期成立。于是有一个不会当场报错的坏法：**产物是旧的，而版本号是新的** ——
 * 打包链路 `dist` 只跑 `sync-version.mjs && tsc && electron-builder`，不重建 web，
 * 所以打进安装包里的是上一次的 `apps/web/dist`。
 *
 * 这个坏法在 2026-10-14 真实发生过（见 `docs/WORK-STATUS.md` 与
 * `docs/P0-UPDATE-VERIFICATION.md` §0.5）：`v0.1.2` 的安装包里烧着 `0.1.1`，
 * 用户装完之后菜单那行显示的还是旧版本号，**看起来像更新失败**。
 *
 * ## 为什么按「三连」的形状去认，而不是搜某个版本号字符串
 *
 * 搜 `'0.1.2'` 这种写法有两个毛病：一是**每次发版都要改断言里的常量**，而一条需要
 * 维护的断言迟早会被漏掉（本项目已经吃过一次：验证手册把「待验版本」写成常量，
 * 下次发版就静默失效）；二是它只能回答「有没有」，回答不了「产物里烧的到底是哪个版本」。
 *
 * 改成认形状之后，`extractBakedIdentities` 返回的是**产物自己说的那个版本**，调用方
 * 再拿它去和仓库根比对 —— 判据里不含任何需要随版本更新的常量，因此不会过期。
 *
 * 形状取自实测。esbuild 压缩后这三个值紧挨在一起，是**同一处**的三个连续字符串字面量
 * （`apps/web/src/lib/version.ts` 的三个 `typeof` 守卫），形态如下：
 *
 *     var sg=`0.1.1`,cg=`2026-10-14T14:40:32.661Z`,lg=`dd4e9e6`,ug=sg,dg=cg,fg=lg;
 *
 * 于是判据是「版本 + ISO 时刻 + 提交短号」这个**有序三连**，中间那个必须是带 `Z` 的
 * ISO 8601，第三个必须是 7~40 位十六进制或字面量 `unknown`（git 不可用时的降级值）。
 * 这个组合足够具体，不会误命中依赖包里的版本串。
 *
 * ⚠️ **三个字面量之间不是裸逗号。** 实测压缩后中间夹着下一次赋值（`cg=`、`lg=`），
 * 按「逗号 + 引号」去写会一条都匹配不上，而失败信息是「找不到三连」—— 那会把人
 * 引向「产物不是这套流程产出的」这个错误结论。这一条是写这个模块时真的踩过的。
 *
 * ## 引号三种都认
 *
 * 打包器按「哪种引号需要转义最少」来选，实测当前选的是反引号。写死一种的话，换一次
 * 打包配置或换一个版本的值就可能整条断言突然变红 —— 而那种红比不红更糟。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 三连的形状。
 *
 * **三个字面量之间不能只写逗号。** 实测压缩后中间夹着下一次赋值：
 *
 *     var sg=`0.1.1`,cg=`2026-10-14T14:40:32.661Z`,lg=`dd4e9e6`,ug=sg,dg=cg,fg=lg;
 *
 * 而**未压缩**时夹的是 `; var b = `（十几个字符）。写死一种分隔符，换一次打包配置
 * 就会整条断言变红 —— 而那种红比不红更糟。所以中间用「有限宽度的非引号字符」来容：
 * `[^`"']{0,40}`。
 *
 * 这个宽度是**有意收窄**的。它能跨过赋值语句，但跨不过另一个字符串字面量（引号本身
 * 被排除），所以三个值必须确实挨在一起。宽度若放开成任意长度，这条判据就退化成
 * 「产物里同时出现过这三类东西」，而旧产物里也可能因为别的原因出现它们。
 *
 * `g` 标志是有意的：产物里可能不止一处（例如同一个值被内联进多个 chunk），
 * 调用方要能看见**全部**，而不是只看见第一个。
 */
const IDENTITY_TRIPLE =
  /(?:`|"|')(\d+\.\d+\.\d+)(?:`|"|')[^`"']{0,40}(?:`|"|')(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)(?:`|"|')[^`"']{0,40}(?:`|"|')([0-9a-f]{7,40}|unknown)(?:`|"|')/g

/**
 * 找出文本里所有的身份三连。
 *
 * 返回数组，元素形如 `{ version, builtAt, commit, index }`。找不到就是空数组 ——
 * **空数组与「找到了但版本不对」是两件事**，调用方要分开处理：前者说明产物不是这套
 * 构建流程产出的（或形状变了），后者才是「陈旧产物」。
 */
export function extractBakedIdentities(text) {
  if (typeof text !== 'string') return []
  const found = []
  // 每次调用都要重置 lastIndex：正则带 `g` 时它是有状态的，复用同一个字面量会在
  // 第二次调用时从上次停下的位置继续，于是「同样的输入」得出不同的结果。
  IDENTITY_TRIPLE.lastIndex = 0
  for (;;) {
    const match = IDENTITY_TRIPLE.exec(text)
    if (match === null) break
    found.push({
      version: match[1],
      builtAt: match[2],
      commit: match[3],
      index: match.index,
    })
  }
  return found
}

/** 第一个三连；没有则返回 `null`。多数调用方只关心「产物自报的版本是多少」。 */
export function extractBakedIdentity(text) {
  const all = extractBakedIdentities(text)
  return all.length === 0 ? null : all[0]
}

/**
 * 读一个前端产物目录（`apps/web/dist` 或安装目录的 `resources/web`）里那份被入口引用的 JS。
 *
 * **按 `index.html` 引用的文件名去读，而不是 glob `assets/*.js`**：后者会把上一轮
 * 留下、已经没有任何入口引用的旧 chunk 也算进来，于是「产物里有某个版本号」可能只是
 * 因为它躺在一个死文件里，而界面根本不会执行到它。
 *
 * 返回 `{ text, files }`；`files` 是被读进来的文件名（用于报错时说清读了什么）。
 * 找不到 `index.html`、或它没引用任何脚本时抛错 —— 这两种都是「产物不完整」，
 * 不该被降级成「没有身份」。
 */
export function readBakedBundle(webRoot) {
  const htmlPath = join(webRoot, 'index.html')
  if (!existsSync(htmlPath)) {
    throw new Error(
      `${htmlPath} 不存在 —— 前端产物还没构建（先跑 \`pnpm --filter @fanhe/web build\`）`,
    )
  }
  const html = readFileSync(htmlPath, 'utf8')
  const names = [...html.matchAll(/assets\/([^"']+\.js)/g)].map((m) => m[1])
  if (names.length === 0) {
    throw new Error(`${htmlPath} 里没有引用任何 assets/*.js —— 产物不完整，不是「没有版本号」`)
  }
  const text = names.map((name) => readFileSync(join(webRoot, 'assets', name), 'utf8')).join('\n')
  return { text, files: names }
}

/**
 * 读产物目录并直接给出身份三连。
 *
 * 返回 `{ identity, identities, files }`；`identity` 为 `null` 表示产物里找不到三连
 * （形状变了，或这份产物不是这套构建流程产出的）。
 */
export function readBakedIdentity(webRoot) {
  const { text, files } = readBakedBundle(webRoot)
  const identities = extractBakedIdentities(text)
  return {
    identity: identities.length === 0 ? null : identities[0],
    identities,
    files,
  }
}

/**
 * 读仓库根 `package.json` 的版本号。
 *
 * 单独一个函数而不是让调用方自己 `JSON.parse`：**版本号的唯一来源**这件事在本项目
 * 是条硬约定（`apps/web/vite.config.ts` 与 `apps/desktop/scripts/sync-version.mjs`
 * 的文件头都写了），多一处自己解析就多一处将来会认错文件的地方。
 */
export function readRootVersion(repoRoot) {
  const manifestPath = join(repoRoot, 'package.json')
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    throw new Error(`${manifestPath} 里没有可用的 version 字段`)
  }
  return parsed.version
}

/**
 * 在 `start` 起逐级向上找仓库根（认 `pnpm-workspace.yaml` 为标记）。
 *
 * 认 `pnpm-workspace.yaml` 而不是 `package.json`：沿路每一层都有 `package.json`
 * （`apps/desktop/`、`apps/`…），认它会停在最近那层、拿到一个 `0.0.0`。
 * 与 `sync-version.mjs` 和 `apps/api/src/version/manifest.ts` 同一条理由，必须一致。
 */
export function findRepoRoot(start) {
  let current = start
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = join(current, '..')
    if (parent === current) break
    current = parent
  }
  return null
}

/** 列出目录下所有文件的相对路径（用 `/` 分隔），排序后返回。`verify-pack.mjs` 也在用。 */
export function listTree(dir) {
  const files = []
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(current, entry.name), relative)
      else files.push(relative)
    }
  }
  walk(dir, '')
  return files.sort()
}
