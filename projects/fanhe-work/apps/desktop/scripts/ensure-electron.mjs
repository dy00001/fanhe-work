#!/usr/bin/env node
/**
 * 确保 electron 的平台二进制已就位。
 *
 * ## 为什么需要这一步
 *
 * electron 的 npm 包只是外壳，真正的运行时是安装时另外下载的一份平台压缩包。
 * 常规版本把这次下载写在 `scripts.postinstall` 里，由包管理器触发；**但 44.7.0
 * 的 tarball 里没有任何 install 脚本**（`hasInstallScript` 为空，`scripts` 整个
 * 缺失），下载逻辑只存在于 `install.js`，且仅以 `install-electron` 这个 bin 的
 * 形式暴露。于是「装完依赖」并不等于「二进制就位」，`onlyBuiltDependencies`
 * 那类白名单对它也不起作用。
 *
 * 这一步把缺失的下载补上，并且是**幂等**的：`install.js` 自己会在开头检查
 * `path.txt` 与 `dist/`，已安装就直接退出。因此它可以在每次安装与每次启动前
 * 无条件执行，代价只是一次文件存在性判断。
 *
 * ## 缓存落点
 *
 * 下载由 `@electron/get` 完成，缓存目录取 `electron_config_cache`。工作区入口
 * （`infra/portable/ws-env.*`）已把它指向 `<工作区根>/.cache/electron`，所以经
 * 入口执行时压缩包落在 U 盘内、不会写系统盘。**本脚本不自己拼缓存路径**，只把
 * 当前环境原样交给 `install.js` —— 让「缓存在哪」这件事只有一处定义。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)

/** 已安装的二进制绝对路径；未安装返回 null。判据与 install.js 的 isInstalled 一致。 */
function findInstalledBinary(electronDir) {
  const pathFile = join(electronDir, 'path.txt')
  if (!existsSync(pathFile)) return null
  const relative = readFileSync(pathFile, 'utf8').trim()
  if (relative === '') return null
  const binary = join(electronDir, 'dist', relative)
  return existsSync(binary) ? binary : null
}

let electronDir
try {
  electronDir = dirname(require.resolve('electron/package.json'))
} catch {
  // 依赖还没装。这不是本脚本能修的，也不该让它把整次安装判失败 —— 真正缺
  // electron 时，编译会以「找不到模块」的方式明确报出来。
  console.warn('[ensure-electron] 未解析到 electron 包，跳过（请先完成依赖安装）。')
  process.exit(0)
}

const existing = findInstalledBinary(electronDir)
if (existing !== null) {
  console.log(`[ensure-electron] 二进制已就位：${existing}`)
  process.exit(0)
}

console.log('[ensure-electron] 未发现 electron 二进制，开始下载……')
execFileSync(process.execPath, [join(electronDir, 'install.js')], {
  cwd: electronDir,
  stdio: 'inherit',
})

if (findInstalledBinary(electronDir) === null) {
  console.error('[ensure-electron] 下载结束但二进制仍缺失，安装不完整。')
  process.exit(1)
}

console.log('[ensure-electron] 完成。')
