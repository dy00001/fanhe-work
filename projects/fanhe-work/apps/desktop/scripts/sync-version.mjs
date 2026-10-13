#!/usr/bin/env node
/**
 * 把仓库根的版本号同步进 `apps/desktop/package.json`。
 *
 * ## 为什么需要这一步
 *
 * T6-01 定下的不变量是「产品版本号的唯一来源是仓库根 `package.json`」：web 侧由
 * `vite.config.ts` 在构建期注入，api 侧在运行时向上找 `pnpm-workspace.yaml` 再读它。
 * 但 `apps/desktop` 这里有个它俩都没有的麻烦 —— **electron-builder 打的包，
 * 其 `app.getVersion()` 读的是被打包的那份 `package.json`**，也就是这个文件本身。
 *
 * 而这个文件的 `version` 一直是 `0.0.0`。`0.0.0` 恰好是「比任何正式版都旧」的值，
 * 于是更新通道会永远认为有新版 —— 这正是 T6-01 实施记录（`DEVELOPMENT-PLAN.md` 9.49）
 * 里记的那个「看起来完全合法的错误答案」。所以在打包之前必须先把它写对。
 *
 * ## 为什么写回源文件，而不是让打包器注入
 *
 * 让 electron-builder 在打包时替换版本看着更干净，代价是「磁盘上那份清单」与
 * 「运行时那个版本号」分叉 —— 排查时看到两个不同的数字，而它们各自都对。
 * 写回源文件只有一处事实，代价是 `apps/desktop/package.json` 会被改（一次 diff）。
 *
 * ## 为什么认 `pnpm-workspace.yaml` 而不是 `package.json`
 *
 * 与 `apps/api/src/version/manifest.ts` 同一条理由，且**必须一致**：沿路每一层都有
 * `package.json`（`apps/desktop/package.json`、`apps/package.json`… 实际是各包的），
 * 认它会停在最近那层、拿到 `0.0.0`。只有仓库根有 `pnpm-workspace.yaml`。
 *
 * ## 幂等
 *
 * 版本已经一致时不写文件（也不动 mtime）。这样它可以安全地挂在每次打包前面，
 * 而不会在 `format:check` / git 里制造无意义的改动。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 从 `start` 起逐级向上找 `pnpm-workspace.yaml`，找不到返回 null。 */
function findRepoRoot(start) {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = join(current, '..')
    if (parent === current) return null
    current = parent
  }
}

/** 读一份 package.json 的 `version`，形状不对就抛。 */
function readVersion(manifestPath) {
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const version = parsed.version
  if (typeof version !== 'string' || version === '') {
    throw new Error(`${manifestPath} 里没有可用的 version 字段。`)
  }
  return { parsed, version }
}

const here = dirname(fileURLToPath(import.meta.url))
// scripts/ 的上两级就是包根（apps/desktop）。
const packageRoot = resolve(here, '..')

const repoRoot = findRepoRoot(here)
if (repoRoot === null) {
  console.error(
    `[version] 从 ${here} 向上找不到仓库根（认 pnpm-workspace.yaml 为标记）。` +
      `盘符或目录结构变了？工作区根应当同时有 .ws-root 与 pnpm-workspace.yaml。`,
  )
  process.exit(1)
}

const source = join(repoRoot, 'package.json')
const target = join(packageRoot, 'package.json')

const { version } = readVersion(source)
const { parsed: desktopManifest, version: current } = readVersion(target)

if (current === version) {
  console.log(`[version] 已是 ${version}，无需改动。`)
  process.exit(0)
}

desktopManifest.version = version
// 保持与仓库其余 package.json 相同的形态：两空格缩进 + 结尾换行。
// 不调 prettier —— 那会整文件重排，把不相干的行一起改掉。
writeFileSync(target, `${JSON.stringify(desktopManifest, null, 2)}\n`, 'utf8')
console.log(`[version] ${current} → ${version}（来源 ${source}）`)
