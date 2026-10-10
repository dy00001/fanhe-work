import { DISPLAY_NAME_MAX_LENGTH } from '@fanhe/shared'

import { createOwnerAccount } from '../auth/setup.js'
import { prisma } from '../db/prisma.js'

/**
 * owner 账号的恢复通道。
 *
 * 正常路径是首次初始化引导（HTTP）。这个脚本用于引导已经无法使用的场合：owner
 * 账号被误删，或者初始化时账号名输错导致没人能登录。它跳过「是否已初始化」的判断，
 * 那正是需要绕过的部分。
 *
 * 密码从环境变量读，不从命令行参数读。参数会留在 shell 历史与进程列表里，而同机
 * 的其它进程能读到进程列表。
 *
 * 用法：
 *   OWNER_USERNAME=admin OWNER_PASSWORD=... pnpm db:create-owner
 */

async function main(): Promise<number> {
  const username = process.env.OWNER_USERNAME ?? ''
  const password = process.env.OWNER_PASSWORD ?? ''
  const rawDisplayName = process.env.OWNER_DISPLAY_NAME ?? ''
  const displayName = rawDisplayName.trim() === '' ? username : rawDisplayName.trim()

  if (username === '' || password === '') {
    console.error('需要设置 OWNER_USERNAME 与 OWNER_PASSWORD 环境变量。')
    console.error('用法：OWNER_USERNAME=admin OWNER_PASSWORD=... pnpm db:create-owner')
    return 1
  }

  // displayName 不经过 HTTP 的 schema 校验，长度要在这里自己看一眼。否则超长会
  // 一路走到数据库，报出的是「value too long for type character varying(64)」，
  // 看不出是哪个变量的问题。
  if (displayName.length > DISPLAY_NAME_MAX_LENGTH) {
    console.error(`OWNER_DISPLAY_NAME 不能超过 ${DISPLAY_NAME_MAX_LENGTH} 个字符。`)
    return 1
  }

  const result = await createOwnerAccount(
    { username, password, displayName },
    { requireUninitialized: false },
  )

  if (!result.ok) {
    console.error(`创建失败：${result.reason}`)
    return 1
  }

  console.log(`已创建 owner 账号 ${result.data.username}（${result.data.displayName}）。`)
  console.log('该账号可以立即用于登录。')
  return 0
}

try {
  process.exitCode = await main()
} finally {
  await prisma.$disconnect()
}
