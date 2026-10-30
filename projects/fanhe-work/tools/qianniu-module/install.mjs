#!/usr/bin/env node
/**
 * 把千牛取数模块装进运行时包（runtime/sycm-cli）。
 *
 * 为什么需要这个脚本：`runtime/` 在 .gitignore 里（第三方交付包，不入库），而千牛模块是
 * 我们自己写的源码。所以源码留在仓库（本目录 module/），运行时那份是「装出来的」——
 * 换机器 / 重装运行时之后，跑一次本脚本就能恢复，不用凭记忆重写。
 *
 * 用法：
 *   node tools/qianniu-module/install.mjs           # 装（覆盖运行时里的同名文件）
 *   node tools/qianniu-module/install.mjs --check   # 只比对，不一致时退出码 1
 *
 * 运行时目录定位顺序：环境变量 SYCM_CLI_DIR > 工作区根下的 runtime/sycm-cli。
 * 工作区根靠向上找 `.ws-root`（或 infra/portable）得到 —— 盘符在 E:/F: 之间变，不能写死。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, 'module')

/** 目标文件的相对路径清单（相对 module/ 与 runtime/sycm-cli/ 是同一套结构）。 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(relative(SOURCE, full).replaceAll('\\', '/'))
  }
  return out
}

function findWorkspaceRoot(start) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.ws-root')) || existsSync(join(dir, 'infra', 'portable'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

const check = process.argv.includes('--check')
const runtimeDir = process.env.SYCM_CLI_DIR
  ? resolve(process.env.SYCM_CLI_DIR)
  : (() => {
      const root = findWorkspaceRoot(HERE)
      return root ? join(root, 'runtime', 'sycm-cli') : null
    })()

if (!runtimeDir || !existsSync(join(runtimeDir, 'tb', 'platforms', 'sycm'))) {
  console.error(
    '✗ 找不到运行时包（runtime/sycm-cli）。设 SYCM_CLI_DIR 指向它，或确认工作区根下有 runtime/sycm-cli。',
  )
  process.exit(2)
}

const files = walk(SOURCE)
const missing = []
const drifted = []
let copied = 0

for (const rel of files) {
  const src = join(SOURCE, rel)
  const dst = join(runtimeDir, rel)
  if (!existsSync(dst)) {
    missing.push(rel)
  } else if (readFileSync(src, 'utf8') !== readFileSync(dst, 'utf8')) {
    drifted.push(rel)
  }
  if (!check) {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    copied += 1
  }
}

if (check) {
  if (missing.length === 0 && drifted.length === 0) {
    console.log(`✓ 运行时里的千牛模块与仓库源码一致（${files.length} 个文件）。`)
    process.exit(0)
  }
  if (missing.length) console.log(`✗ 缺 ${missing.length} 个文件：\n  ${missing.join('\n  ')}`)
  if (drifted.length) console.log(`✗ 内容不一致 ${drifted.length} 个：\n  ${drifted.join('\n  ')}`)
  console.log('\n跑一次不带 --check 的安装即可对齐。')
  process.exit(1)
}

console.log(`✓ 已装入 ${copied} 个文件 → ${runtimeDir}`)
if (missing.length) console.log(`  （其中 ${missing.length} 个是新增）`)
if (drifted.length) console.log(`  （其中 ${drifted.length} 个覆盖了运行时里的旧版本）`)
console.log('\n下一步：')
console.log('  cd "' + join(runtimeDir) + '"')
console.log('  scripts\\qianniu.cmd doctor')
console.log('  scripts\\qianniu.cmd review-pending --limit 5')
