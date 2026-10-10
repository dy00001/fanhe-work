import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import dotenv from 'dotenv'

/**
 * 集成测试的数据库支持。
 *
 * `test-env.ts` 把 DATABASE_URL 固定成一个不可达地址，好让不需要数据库的测试
 * 不会误连。需要数据库的测试必须在 `env.ts` 被求值之前把它改回来，本模块负责
 * 找出真实值。
 *
 * 取值顺序是 `FANHE_TEST_DATABASE_URL` 优先，其次是 `apps/api/.env` 里的
 * `DATABASE_URL`。前者便于在另一台机器或 CI 上指向别的实例，后者是本机开发用的
 * 实例。两者都没有时返回 null，调用方据此**跳过**测试，而不是拿一个错的地址
 * 去连然后失败。
 *
 * 本模块刻意不 import `env.ts`：一旦引入，`env.ts` 会在连接串被覆盖之前求值，
 * 整个机制就失效了。
 */

/** 测试创建的数据统一带这个前缀，便于识别与清理。 */
export const TEST_DATA_PREFIX = 'zz_test_'

export function resolveTestDatabaseUrl(): string | null {
  const explicit = process.env.FANHE_TEST_DATABASE_URL
  if (explicit !== undefined && explicit.trim() !== '') {
    return explicit
  }

  const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env')
  try {
    const parsed = dotenv.parse(readFileSync(envPath))
    const url = parsed.DATABASE_URL
    if (url !== undefined && url.trim() !== '') {
      return url
    }
  } catch {
    // 没有 .env 文件时走到下面的返回 null，由调用方跳过测试。
  }
  return null
}
