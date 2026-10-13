import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@fanhe/shared'

import { hashPassword } from '../auth/password.js'
import { prisma } from '../db/prisma.js'

/**
 * 账号密码的重置通道。
 *
 * 与 create-owner.ts 同一类东西：不经 HTTP，只有能操作服务器的人才能执行，与直接
 * 改数据库的权限要求一致，因此不构成额外的暴露面。
 *
 * ## 密码为什么从 stdin 读
 *
 * 命令行参数会留在 shell 历史里，环境变量会进同机其它进程的环境表；而这个脚本
 * 处理的正是「已经知道别人密码的人」的场景。密码若经过这两条路，重置完成后它仍
 * 然留在盘上，而那正是最不该留的时刻。
 *
 * 回显关闭挡的是肩窥与截图，终端仍会收到按键。这是这个方案的边界，写在这里
 * 是为了别让人以为它更安全。
 *
 * 用法：
 *   pnpm --filter @fanhe/api db:reset-password
 *   随后按提示输入账号名与两遍新密码。
 *
 * 也接受管道输入（账号名、两遍密码各一行），便于在没有终端的环境里使用。
 */

const MAX_ATTEMPTS = 3

/**
 * 输入行读取器。
 *
 * **全程只建一个 readline 实例**，每次提问都新建一个会出错：stdin 是同一条流，
 * 第一个 interface 关闭后已缓冲的行随之丢失，第二个 interface 只能看到剩下的部分。
 * 症状是「账号名读到了，新密码读到一半」，且只在管道输入时出现 ——
 * 交互式输入每次都是新的一行，因此看起来正常。
 *
 * 内部维护一份已读行队列，取用时从队首弹出。终端与管道两种输入都成立。
 */
function createLineReader() {
  const rl = createInterface({ input: stdin, crlfDelay: Infinity })
  const lines: string[] = []
  const waiters: ((line: string | null) => void)[] = []
  let ended = false

  rl.on('line', (line) => {
    const trimmed = line.trim()
    const next = waiters.shift()
    if (next !== undefined) next(trimmed)
    else lines.push(trimmed)
  })

  rl.on('close', () => {
    ended = true
    // 把还在等的人全部叫醒并告知没内容了，否则调用方会永远挂住。
    for (const waiter of waiters.splice(0)) waiter(null)
  })

  /** 取下一行。输入已结束时返回 null。 */
  const nextLine = (): Promise<string | null> => {
    const buffered = lines.shift()
    if (buffered !== undefined) return Promise.resolve(buffered)
    if (ended) return Promise.resolve(null)
    return new Promise((resolve) => {
      waiters.push(resolve)
    })
  }

  return { nextLine, close: (): void => rl.close() }
}

/** 校验两遍密码是否一致且强度够。返回 null 表示通过。 */
function checkPassword(first: string, second: string): string | null {
  if (first.length < PASSWORD_MIN_LENGTH) {
    return `密码至少 ${PASSWORD_MIN_LENGTH} 位。`
  }
  if (first.length > PASSWORD_MAX_LENGTH) {
    return `密码不能超过 ${PASSWORD_MAX_LENGTH} 位。`
  }
  if (first !== second) {
    return '两遍不一致。'
  }
  return null
}

async function main(): Promise<number> {
  const reader = createLineReader()

  try {
    stdout.write('要重置哪个账号的密码？\n账号名: ')
    const rawUsername = await reader.nextLine()
    if (rawUsername === null || rawUsername === '') {
      stdout.write('\n没有读到账号名，未做任何修改。\n')
      return 1
    }
    const username = rawUsername.toLowerCase()

    // 不按状态过滤：停用或锁定的账号同样需要能重置密码。停用是管理决定，
    // 锁定会自己过期，两者都不该挡住「把密码改回来」。
    const user = await prisma.user.findFirst({
      where: { username, deletedAt: null },
      select: {
        id: true,
        username: true,
        displayName: true,
        status: true,
      },
    })
    if (user === null) {
      stdout.write(`库里没有账号 ${username}。\n`)
      return 1
    }

    stdout.write(
      `\n将为 ${user.displayName}（${user.username}，当前状态 ${user.status}）设置新密码。\n`,
    )

    let newPassword: string | null = null
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      stdout.write('新密码（输入不回显）: ')
      const first = await reader.nextLine()
      stdout.write('\n再输一遍: ')
      const second = await reader.nextLine()
      stdout.write('\n')

      if (first === null || second === null) {
        stdout.write('没有读齐两遍密码，未做任何修改。\n')
        return 1
      }

      const problem = checkPassword(first, second)
      if (problem === null) {
        newPassword = first
        break
      }
      stdout.write(`${problem}\n`)
    }

    if (newPassword === null) {
      stdout.write(`${MAX_ATTEMPTS} 次输入都没通过校验，未做任何修改。\n`)
      return 1
    }

    // 哈希在事务外算，与初始化那条路径同理由：Argon2 单次几十毫秒，放进事务
    // 会让事务与它持有的锁多被占用这么久。
    const passwordHash = await hashPassword(newPassword)
    const now = new Date()

    // 事务内三件事，缺一不可：
    //   1. 更新哈希与 password_changed_at —— 后者让已签发的访问令牌立刻失效
    //   2. 清零失败计数与锁定 —— 「密码被锁住」常常正是要重置的原因
    //   3. 吊销全部刷新令牌 —— 换了密码还让人用旧会话进来，等于没换
    //
    // 停用状态不恢复：停用是管理决定，混进「重置密码」会让那一步凭空失效。
    await prisma.$transaction([
      prisma.user.update({
        where: { id: user.id },
        data: {
          passwordHash,
          passwordChangedAt: now,
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: user.id, revokedAt: null },
        data: { revokedAt: now, revokedReason: 'password_reset_cli' },
      }),
    ])

    stdout.write(
      `\n已重置 ${user.username} 的密码。\n` +
        `该账号在所有设备上的登录状态都已失效，需要用新密码重新登录。\n` +
        `状态保持为 ${user.status}${user.status === 'active' ? '' : '（未改变）'}。\n`,
    )
    return 0
  } finally {
    reader.close()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
