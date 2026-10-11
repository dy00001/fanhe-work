#!/usr/bin/env node
/**
 * 启动外壳。
 *
 * 存在的唯一理由是 `ELECTRON_RUN_AS_NODE`：这个变量一旦为真，electron 可执行
 * 文件会退化成纯 Node 运行时——不建窗口，`require('electron')` 返回的是可执行
 * 文件路径而不是 API。CI、部分 IDE 的集成终端，以及自动化代理的会话里都会带上
 * 它，而症状是「外壳一启动就抛 `Cannot read properties of undefined (reading 'on')`」，
 * 指向 `app` 却与外壳代码毫无关系，很容易被误诊成 Electron 没装好。
 *
 * 因此在拉起 electron 之前显式摘掉这一个变量，其余环境原样透传 ——
 * `ELECTRON_*` 的缓存重定向、代理变量等都必须保留。
 *
 * 这里用 Node 起子进程而不是在 npm 脚本里写 `set VAR=`：清变量的写法在 cmd 与
 * sh 下不同，而 Node 脚本只有一份，且「为什么要清」这件事有地方写下来。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// 在纯 Node 下 `require('electron')` 返回的就是可执行文件的绝对路径。
const electronPath = require('electron')
if (typeof electronPath !== 'string') {
  console.error('[launch] 当前已在 electron 运行时内，请直接使用 electron . 启动。')
  process.exit(1)
}

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const args = ['.']

// 受限环境（没有桌面会话的服务进程、容器、部分 CI）里 Chromium 的渲染进程沙箱
// 起不来，症状是加载以 `ERR_FAILED (-2)` 结束、且没有任何更具体的原因，很容易
// 被误诊成内置服务或前端产物有问题。这类环境必须显式声明自己撑不住沙箱：
//
//   FANHE_NO_SANDBOX=1
//
// 做成开关而不是默认值，是因为关掉沙箱是实打实的安全降级，不该由「在哪儿跑」
// 悄悄决定 —— 普通桌面环境必须保持沙箱开启。
if (process.env.FANHE_NO_SANDBOX === '1') {
  args.push('--no-sandbox')
}

args.push(...process.argv.slice(2))

const child = spawn(electronPath, args, {
  stdio: 'inherit',
  env,
})

child.on('error', (error) => {
  console.error(`[launch] 无法启动 electron：${error.message}`)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`[launch] electron 被信号 ${signal} 终止。`)
    process.exit(1)
  }
  process.exit(code ?? 0)
})
