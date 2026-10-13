/**
 * 测试用的「干净暂存根」。
 *
 * ## 为什么不能直接用 `os.tmpdir()`
 *
 * 经 `infra/portable/ws-run.cmd` 跑时，`TEMP` / `TMP` 都被重定向到工作区介质上的
 * `.tmp/`，而 `os.tmpdir()` 读的正是这两个变量 —— 于是它返回 `<工作区>/.tmp`。
 * 那意味着从这里派生的任何目录**向上找都会命中工作区的 `.ws-root`**，而
 * 「找不到工作区标记时返回 null」这类用例断言的东西就被运行环境本身否掉了。
 *
 * ## 为什么不能写死 `C:\Users\Administrator\…`
 *
 * 这里原来就是这么写的（`join(SystemDrive, 'Users', 'Administrator', 'AppData', …)`）。
 * 它在本机可行只是因为**当初那台机器的账户名恰好是 Administrator**。换成任何别的
 * 账户名，`mkdir` 会因为无权在别人的用户目录下建目录而报 `EPERM`，而症状是
 * **整个测试文件加载失败**（报告里是一条 `not ok … test\xxx.test.mjs`），不是某条
 * 断言变红 —— 看起来像测试文件坏了，实际是路径选错了。2026-10-13 在账户名 `dy`
 * 的机器上实测到：`config.test.mjs` 与 `paths.test.mjs` 合计 16 条用例全灭。
 *
 * ## 办法：从 `LOCALAPPDATA` 推
 *
 * 与 `apps/web/test/e2e-auth.mjs` 的 `systemTempDir()` 同款：`LOCALAPPDATA` 不在
 * 入口脚本的重定向映射表里，所以它仍然指向真实的用户临时目录，且天然是**当前用户
 * 可写**的。非 Windows 退回 `os.tmpdir()`。
 *
 * 这份是 `test/` 与 `test/acceptance/` 下所有需要它的脚本的**唯一一份**实现：
 * 五个脚本各抄一遍的时候，改对了四处、漏了第五处的表现就是「本机全绿、换台机器
 * 整个文件不跑」。
 */
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 真实的系统临时目录。见文件头。 */
export function systemTempDir() {
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA']
    if (localAppData) return join(localAppData, 'Temp')
  }
  return tmpdir()
}

/** 干净暂存根：真实系统临时目录下一个固定的子目录，导入时确保存在。 */
export const SYSTEM_SCRATCH = join(systemTempDir(), 'fanhe-desktop-test')

await mkdir(SYSTEM_SCRATCH, { recursive: true })
