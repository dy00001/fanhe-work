#!/usr/bin/env node
/**
 * 打包前的**前置闸**：产物里烧进的版本号必须等于仓库根的版本号（T7-05）。
 *
 * ## 为什么需要它，以及为什么它不是「再写一条文档」
 *
 * 打包链路 `apps/desktop/package.json` 的 `dist` 只跑
 * `sync-version.mjs && tsc && electron-builder`，**不重建 web**。而 web 的版本号是
 * **构建期**由 `vite.config.ts` 的 `define` 从仓库根 `package.json` 文本替换进去的。
 *
 * 于是有一条不会当场报错、只在用户装完之后才显形的路：
 *
 *   1. 先构建前端（此时版本号还是旧的）
 *   2. 之后才提升版本号
 *   3. 打包 —— 打进安装包里的是第 1 步那份产物
 *
 * **注意第 1 步与第 2 步的顺序。** 既有文档写的是「先 `pnpm --filter @fanhe/web build`
 * 再 `dist`」，这条顺序**被执行了**，但它漏掉了更靠前的一步：**版本号必须在构建前端
 * 之前就定下来**。2026-10-14 就是这样发出 `v0.1.2` 的 —— 前端构建于 22:41（版本号
 * 还是 `0.1.1`），版本号 22:57 才提到 `0.1.2`，安装包 22:54 打出来。用户装完 0.1.2，
 * 菜单那行显示的还是 `v0.1.1`，看起来像更新失败。
 *
 * 所以这里的判据刻意是**绝对**的：产物自报的版本 == 仓库根当前版本。它不含任何
 * 需要随发版更新的常量，因此不会像「把待验版本写成常量」那样在下次发版时静默失效。
 *
 * ## 为什么是「拒绝」而不是「自动重建前端」
 *
 * 自动重建看着更省事，代价是：`dist` 从「纯打包」变成「打包 + 构建」，而它要经
 * `infra/portable/ws-run.cmd` 这个便携入口运行（工作区在可移动介质上、盘符会变）。
 * 在一个包脚本里再嵌一层包管理器，会把「用哪个 pnpm、store 落在哪」变成一个新的
 * 出错面 —— 而那个出错面**当场看不出来**，与本项目已经吃过一次亏的形态一致。
 *
 * 拒绝的代价是发版清单上多一条命令，收益是错误**在花掉 6 分钟打包之前**就以
 * 可读的方式停下来，并且消息里直接写着正确顺序。
 *
 * ## 用法
 *
 *   node scripts/check-web-build.mjs                 # 检查 apps/web/dist
 *   node scripts/check-web-build.mjs <目录>           # 检查别处（如安装目录的 resources/web）
 *
 * 退出码：0 = 可以打包；1 = 产物与当前版本不符（消息里给出正确顺序）；2 = 环境问题。
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findRepoRoot, readBakedIdentity, readRootVersion } from './baked-identity.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const repoRoot = findRepoRoot(here)
if (repoRoot === null) {
  console.error('[web-build] 从 ' + here + ' 向上找不到仓库根（认 pnpm-workspace.yaml 为标记）。')
  process.exit(2)
}

const target =
  process.argv[2] === undefined ? join(repoRoot, 'apps', 'web', 'dist') : resolve(process.argv[2])

const rootVersion = readRootVersion(repoRoot)

/**
 * 正确的顺序。**把顺序写进失败消息里**，而不是只写「产物过期了」——
 * 上一次的失效恰恰不是「没人跑构建」，而是「跑了，但顺序错了一步」。
 */
function printCorrectOrder() {
  console.error('')
  console.error('  正确顺序是「先定版本号，再构建前端，最后打包」：')
  console.error('')
  console.error('    1) 改仓库根 package.json 的 version，并提交')
  console.error('    2) pnpm --filter @fanhe/web build')
  console.error('    3) pnpm --filter @fanhe/desktop dist')
  console.error('')
  console.error('  ⚠️ 第 1 步必须早于第 2 步。前端产物的版本号是**构建期**烧进去的，')
  console.error('     先构建再提版本号，打进包里的就还是旧号 —— 而它看起来完全正常。')
  console.error('')
}

if (!existsSync(target)) {
  console.error(`[web-build] 目录不存在：${target}`)
  printCorrectOrder()
  process.exit(1)
}

let read
try {
  read = readBakedIdentity(target)
} catch (error) {
  console.error(
    `[web-build] 读不出前端产物：${error instanceof Error ? error.message : String(error)}`,
  )
  printCorrectOrder()
  process.exit(1)
}

if (read.identity === null) {
  console.error(
    `[web-build] 在 ${read.files.join(', ')} 里找不到构建期身份三连（版本 + 构建时刻 + 提交号）。`,
  )
  console.error('            要么产物不是这套构建流程产出的，要么注入值的形态变了')
  console.error('            （见 scripts/baked-identity.mjs 头部对「三连形状」的说明）。')
  printCorrectOrder()
  process.exit(1)
}

const { version, builtAt, commit } = read.identity
const distinctVersions = [...new Set(read.identities.map((i) => i.version))]

if (version !== rootVersion || distinctVersions.some((v) => v !== rootVersion)) {
  console.error('')
  console.error(
    `[web-build] ❌ 版本号不符：产物里烧的是 ${distinctVersions.join(' / ')}，仓库根是 ${rootVersion}`,
  )
  console.error(`            产物构建于 ${builtAt}（提交 ${commit}）`)
  console.error(`            检查的是 ${target}`)
  printCorrectOrder()
  process.exit(1)
}

console.log(`[web-build] ok  产物版本 ${version} == 仓库根 ${rootVersion}`)
// 构建时刻与提交号一并打出来：**硬判据只有版本号**，但这两项是排查时的第一手线索
// （「这份产物是什么时候、从哪个提交来的」），而它们不花任何代价就能顺手给出。
console.log(`[web-build]     构建于 ${builtAt} · 提交 ${commit} · 读了 ${read.files.length} 个脚本`)
