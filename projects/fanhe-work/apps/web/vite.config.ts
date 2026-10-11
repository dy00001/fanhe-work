import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 产品版本号的**唯一来源**。
 *
 * 读的是仓库根 `package.json` 的 `version`，不是 `apps/web` 那一份：版本号回答的是
 * 「这是梵禾 Work 的哪一版」，而梵禾 Work 是整个仓库（web + api + 将来的 desktop），
 * 不是其中某一个包。放在应用自己那一份里，将来 api 或桌面壳要报版本时就会出现第二个
 * 来源，而两份版本号迟早会不一致 —— 那时「用户装的是哪一版」就没人答得上来。
 *
 * 发版时改根 `package.json` 的 `version` 一处（或在仓库根跑 `pnpm version patch`），
 * 重新构建即生效。**不要在别处再写一个版本号**：写第二处的那一刻起，界面上的版本与
 * 实际发布的版本就分成两个事实了。
 */
const productPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string }

/**
 * 当前提交的短哈希。
 *
 * 版本号回答「这是第几版」，提交号回答「这是哪一次构建」—— 同一个版本号可能对应很多次
 * 提交（开发期间的每次构建都是），排查「用户报的问题在哪次提交之后出现」时只有提交号
 * 能对上。它是**构建期信息**，不写进任何受版本控制的文件，否则每提交一次就要改一次
 * 版本文件，而那种改动会把 diff 搅乱。
 *
 * git 不可用（打包环境、源码压缩包）时返回 `'unknown'` 而不是抛错：一个拿不到提交号的
 * 构建仍然是有用的构建，让它整体失败是本末倒置。这一条不是防御性代码 —— 打包产物里
 * 常常既没有 `.git` 也没有 `git` 命令。
 */
function readCommitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return 'unknown'
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // 构建期常量。用 `define` 而不是环境变量文件：它们由构建过程自己算出来，不是需要
  // 人去填的配置，`define` 让「值从哪来」这件事留在它唯一的来源旁边。
  // 值一律经 `JSON.stringify` 包成字符串字面量 —— `define` 做的是文本替换，
  // 直接塞裸字符串会把 `0.1.0` 变成一个语法错误。
  define: {
    __APP_VERSION__: JSON.stringify(productPackage.version),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __COMMIT_SHA__: JSON.stringify(readCommitSha()),
  },
  resolve: {
    // Mirrors the `@/*` path mapping in tsconfig.json. shadcn/ui component
    // sources import through this alias, so both ends have to agree: the
    // compiler needs it to typecheck, the bundler needs it to resolve.
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Bind the IPv4 loopback explicitly. Vite defaults to the `localhost`
    // hostname, which on Windows resolves to the IPv6 loopback ::1 only, so
    // the server would be unreachable at 127.0.0.1 and would not match the
    // API host below. Pinning the address keeps both ends on the same stack.
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // The API runs on the loopback interface only. Proxying through the dev
      // server keeps the browser origin single, so no CORS policy is needed
      // during development.
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
})
