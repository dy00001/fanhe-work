/**
 * 跨包路径解析的回归测试（T4-03）。
 *
 * 这一层看着只是「拼路径」，但它守着本机代理能不能在**换机之后**照样工作 ——
 * `paths.ts` 全部逻辑的依据是「工作区里有 `.ws-root`」，而工作空间在可移动介质上。
 * 换机时最容易出的事就是介质里少了一格目录，或者盘符从 `E:` 变成 `F:`。
 *
 * 这类失败在真实环境里的表现是「外壳开得起来、界面也在，点启动就报本机代理不可用」，
 * 原因却在一条 `join()` 里。所以这里把三条会抛的分支逐条钉住，并且**断言报错文本
 * 里带着可照着修的信息** —— 只断言「抛了」的话，真出事时仍然不知道该改哪。
 *
 * 与 `agent.test.mjs` 同款，直接测 `src/paths.ts` 源码，不构建。
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

import { apiLaunchModule, apiSourceRoot, locateWorkspaceRoot } from '../src/paths.ts'

/**
 * 干净暂存根。**不能用 `os.tmpdir()`** —— 经 `ws-run.cmd` 跑时它被指向工作区的
 * `.tmp`，而那就在 `.ws-root` 底下，于是「向上找不到标记」这条用例会因为测试自己
 * 造的工作区在标记之下而永远失败。固定落系统盘，与 `config.test.mjs` 同理。
 */
const SYSTEM_SCRATCH = join(
  process.env['SystemDrive'] ?? 'C:',
  'Users',
  'Administrator',
  'AppData',
  'Local',
  'Temp',
  'fanhe-desktop-test',
)
await mkdir(SYSTEM_SCRATCH, { recursive: true })

/** 造一个带 `.ws-root` 的假工作区，返回根目录。 */
async function makeWorkspace() {
  const root = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-paths-'))
  await writeFile(join(root, '.ws-root'), '', 'utf8')
  return root
}

test('从深层目录向上找得到工作区根', async () => {
  const root = await makeWorkspace()
  const deep = join(root, 'projects', 'fanhe-work', 'apps', 'desktop', 'dist')
  await mkdir(deep, { recursive: true })

  try {
    // 这条正是外壳产物 `__dirname` 的深度。写死成二级会与源码路径那条一起坏掉，
    // 而它俩只差一级，肉眼极难分辨。
    assert.equal(locateWorkspaceRoot(deep), root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('找不到标记时返回 null 而不是抛错', async () => {
  // 从盘符根起算最稳妥：那里一定没有 .ws-root。
  assert.equal(locateWorkspaceRoot(join(process.env['SystemDrive'] ?? 'C:', 'Windows')), null)
})

test('根下没有 api 源码时报出具体缺哪个目录', async () => {
  const root = await makeWorkspace()
  try {
    assert.throws(
      () => apiSourceRoot(root),
      (error) => {
        const message = error.message
        assert.match(message, /未找到 api 源码目录/)
        assert.match(message, /apps/, '报错里要能看出缺的是哪一段')
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工作区不完整时，加载代理核心报的是可照着修的话', async () => {
  const root = await makeWorkspace()
  // 刻意只造一半：有 .ws-root，没有 api 源码。这是最像真实的「介质拷漏了」。
  await mkdir(join(root, 'projects', 'fanhe-work', 'apps'), { recursive: true })

  await assert.rejects(apiLaunchModule(root), (error) => {
    assert.match(error.message, /未找到 api 源码目录/)
    return true
  })
  await rm(root, { recursive: true, force: true })
})

test('真实工作区里能加载到 api 的 agent 核心', async () => {
  // 这条是整套 T4-03 的存在理由：外壳复用的必须**是 api 那一份**，
  // 而不是某份拷贝 —— 拷贝会漂移，而漂移表现为「改了 agent 但外壳行为没变」。
  const loaded = await apiLaunchModule(process.cwd())

  assert.equal(typeof loaded.runLaunchProfile, 'function')
  assert.equal(typeof loaded.buildLaunchCommand, 'function')
  assert.equal(typeof loaded.inspectExecutablePath, 'function')
})

test('同一个目录连着加载两次拿到的是同一个实例（去重表因此跨调用生效）', async () => {
  // `recentRuns` 去重缓存挂在模块作用域上，而它存在的理由是防「连点起五个微信」。
  // 这个特性完全依赖「第二次 import 拿到同一实例」，所以值得钉住。
  const first = await apiLaunchModule(process.cwd())
  const second = await apiLaunchModule(process.cwd())
  assert.equal(first, second)
})

test('工作区路径里有空格也能加载（import 收的是 URL，不是路径）', async () => {
  // 本工作区就叫「fanhe Work」。ESM 加载器只认 file: 协议，喂 Windows 绝对路径会
  // 抛 ERR_UNSUPPORTED_ESM_URL_SCHEME —— 而且工作区名一旦不带空格就看不出问题，
  // 换个介质立刻坏。这条把它钉死。
  const root = await locateWorkspaceRoot(process.cwd())
  assert.notEqual(root, null)
  assert.match(root, /\s/, `工作区根应含空格，实际 ${root}`)

  const loaded = await apiLaunchModule(process.cwd())
  assert.equal(typeof loaded.runLaunchProfile, 'function')
})
