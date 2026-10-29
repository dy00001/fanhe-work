/**
 * 同步 CLI 参数解析的测试。
 *
 * 这一组存在的理由是 2026-10-29 的一个真缺陷：`tools\crm\sync-daily.cmd --dry-run`
 * 会**真的写库**。参数经 `ws-run.ps1`（`[CmdletBinding()]`）时被 PowerShell 绑成它
 * 自己的参数，`--dry-run` 静默消失，日志照常打印「模式：写库」，没有人看得出问题。
 *
 * 所以这里重点测两件事：
 *   1. 环境变量这条通路真的能开干跑（批处理现在只走它）；
 *   2. 认不出的参数必须**抛错**。忽略一个拼错的 `--dryrun` 等于把试跑变成真写。
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { describe, test } from 'node:test'

import { DEFAULT_CHAT_DIR, parseSyncArgs } from '../src/customer/sync-args.js'

/** 假装在 apps/api 下运行，别名表按相对路径解析。 */
const CWD = path.resolve('C:', 'repo', 'projects', 'fanhe-work', 'apps', 'api')

describe('parseSyncArgs', () => {
  test('没有参数就是写库', () => {
    const args = parseSyncArgs(['node', 'customer-sync'], {}, CWD)
    assert.equal(args.dryRun, false)
    assert.equal(args.verbose, false)
    assert.equal(args.chatDir, DEFAULT_CHAT_DIR)
    assert.equal(args.aliasesFile, path.resolve(CWD, '..', '..', 'data', 'customer-aliases.json'))
  })

  test('直接调 tsx 时命令行开关有效', () => {
    const args = parseSyncArgs(['node', 'customer-sync', '--dry-run', '--verbose'], {}, CWD)
    assert.equal(args.dryRun, true)
    assert.equal(args.verbose, true)
  })

  test('批处理走的环境变量也能开干跑', () => {
    const args = parseSyncArgs(['node', 'customer-sync'], { FANHE_SYNC_DRY: '1' }, CWD)
    assert.equal(args.dryRun, true)
  })

  test('环境变量接受 true 和 yes，大小写不敏感', () => {
    assert.equal(parseSyncArgs(['node', 'x'], { FANHE_SYNC_DRY: 'TRUE' }, CWD).dryRun, true)
    assert.equal(parseSyncArgs(['node', 'x'], { FANHE_SYNC_VERBOSE: ' Yes ' }, CWD).verbose, true)
  })

  test('环境变量为 0 / false / 空时不算开', () => {
    for (const raw of ['0', 'false', 'no', '', '  ']) {
      const args = parseSyncArgs(['node', 'x'], { FANHE_SYNC_DRY: raw }, CWD)
      assert.equal(args.dryRun, false, `FANHE_SYNC_DRY=${JSON.stringify(raw)} 不该开干跑`)
    }
  })

  test('--dir 覆盖环境变量里的目录，且按 cwd 解析成绝对路径', () => {
    const args = parseSyncArgs(
      ['node', 'x', '--dir', 'E:\\备份\\客户聊天记录库'],
      { FANHE_CHAT_DIR: 'D:\\旧路径' },
      CWD,
    )
    assert.equal(args.chatDir, path.resolve(CWD, 'E:\\备份\\客户聊天记录库'))
  })

  test('认不出的参数必须抛错，不能退化成写库', () => {
    // 少一个横线是最常见的输入错误，也正是最危险的：它本该是干跑。
    assert.throws(() => parseSyncArgs(['node', 'x', '--dryrun'], {}, CWD), /认不出的参数/)
    assert.throws(() => parseSyncArgs(['node', 'x', '--dry-run=1'], {}, CWD), /认不出的参数/)
  })

  test('--dir 后面没跟路径要抛错', () => {
    assert.throws(() => parseSyncArgs(['node', 'x', '--dir'], {}, CWD), /--dir/)
    assert.throws(() => parseSyncArgs(['node', 'x', '--dir', '  '], {}, CWD), /--dir/)
  })
})
