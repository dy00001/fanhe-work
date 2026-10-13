/**
 * 版本号单一来源的一致性测试（T6-03a）。
 *
 * ## 它守的是什么
 *
 * T6-01 定下的不变量是「产品版本号的唯一来源是仓库根 `package.json`」。web 侧由
 * `vite.config.ts` 构建期注入、api 侧运行时向上找根 —— 那两处都有实现保证。
 * **只有 `apps/desktop` 这一份是抄过来的**，因为 electron-builder 打的包其
 * `app.getVersion()` 读的就是被打包的那份 `package.json`。
 *
 * 靠 `sync-version.mjs` 在打包前抄一次是行得通的，但那只是「打包时会同步」——
 * 平时 `pnpm test` 不会发现两份数字已经分叉。而分叉的后果不是报错，是**更新通道
 * 从此说错话**：客户端自称 `0.0.0`，那是「比任何正式版都旧」的值，于是「有可用更新」
 * 永远为真。这正是 9.49 记的那个「看起来完全合法的错误答案」。
 *
 * 所以这条不变量的看门人放这里：**门禁跑得过就说明两份一致**，而不是等打包才发现。
 *
 * ## 断言的是「相等」，而不是「等于某个具体数字」
 *
 * 写成 `assert.equal(desktop.version, '0.1.0')` 会在每次发版时挡路，而它要防的
 * 分叉与具体数字无关。相等才是那条不变量。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 向上找 `pnpm-workspace.yaml`。判据不能换成「有没有 package.json」——见 9.49。 */
function findRepoRoot(start) {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = join(current, '..')
    if (parent === current) return null
    current = parent
  }
}

test('desktop 的版本号与仓库根一致（否则更新通道会说错话）', () => {
  const repoRoot = findRepoRoot(here)
  assert.notEqual(repoRoot, null, '向上找不到 pnpm-workspace.yaml，测试自身的定位方式坏了')

  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
  const desktop = JSON.parse(
    readFileSync(join(repoRoot, 'apps', 'desktop', 'package.json'), 'utf8'),
  )

  assert.equal(
    desktop.version,
    root.version,
    `apps/desktop/package.json 的版本（${desktop.version}）与仓库根（${root.version}）不一致。` +
      `跑 \`node apps/desktop/scripts/sync-version.mjs\` 同步，并把结果一并提交 —— ` +
      `electron-builder 打的包其 app.getVersion() 读的就是被同步的那一份。`,
  )
})
