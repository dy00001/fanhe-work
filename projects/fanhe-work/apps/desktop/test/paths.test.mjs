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

import {
  apiLaunchModule,
  apiSourceRoot,
  bundledAgentPath,
  locateWorkspaceRoot,
  webDistRoot,
} from '../src/paths.ts'

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

/*
 * 以下是 T6-03a 新增的「装完之后」那一半。
 *
 * 那些用例守的是一件开发态看不见的事：**安装包形态下根本没有工作区**，
 * 于是原来那条「向上找 .ws-root」的路必然走不通，而那不是出错。
 */

/** 造一个「随包资源」目录：resources/agent/{agent.ts,package.json}。 */
async function makeBundledAgent(root, marker) {
  const dir = join(root, 'resources', 'agent')
  await mkdir(dir, { recursive: true })
  // 旁边这份 package.json 不是装饰：`.ts` 的模块类型由最近的 package.json 决定，
  // 缺失会告警、写成 commonjs 会让加载直接失败（见 docs/T6-03-UPDATE-CHANNEL.md §3.5）。
  // 这里照抄真实布局，顺带让测试输出保持干净。
  await writeFile(join(dir, 'package.json'), '{"type":"module"}\n', 'utf8')
  await writeFile(
    join(dir, 'agent.ts'),
    `export function runLaunchProfile() { return { ok: true, marker: ${JSON.stringify(marker)} } }\n` +
      `export function inspectExecutablePath() { return Promise.resolve('ok') }\n`,
    'utf8',
  )
  return bundledAgentPath(join(root, 'resources'))
}

test('安装态：没有工作区时退到随包资源加载代理', async () => {
  // 这一条是 T6-03a 的存在理由。临时目录上方没有 .ws-root，正是装完之后的样子；
  // 此时 `locateWorkspaceRoot` 返回 null，而 null 表示「这一形态本该如此」，
  // 不是「出错了」—— 所以必须能接着往随包资源走，而不是抛错。
  const root = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-paths-packed-'))
  try {
    const bundled = await makeBundledAgent(root, 'packed')
    const loaded = await apiLaunchModule(join(root, 'app', 'resources'), bundled)

    assert.equal(typeof loaded.runLaunchProfile, 'function')
    assert.equal(
      loaded.runLaunchProfile().marker,
      'packed',
      '必须真的加载了随包那一份，而不是碰巧从别处拿到一个同名的函数',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('安装态：介质残缺（有 .ws-root 但没有 api 源码）也要能降级', async () => {
  // 这一条不是假想分支。`apiSourceRoot` 在缺目录时**抛错**，如果降级只挡在
  // 「找不到 .ws-root」那一支上，一台插着残缺介质的机器就会在到达随包资源之前
  // 被那条抛错顶掉 —— 报的还是「确认工作区完整」，与安装态的事实不符。
  const root = await makeWorkspace()
  await mkdir(join(root, 'projects', 'fanhe-work', 'apps'), { recursive: true })
  const bundled = await makeBundledAgent(root, 'packed')

  try {
    const loaded = await apiLaunchModule(root, bundled)
    assert.equal(loaded.runLaunchProfile().marker, 'packed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('两处都没有时报一条同时说清两条路的话', async () => {
  const root = await mkdtemp(join(SYSTEM_SCRATCH, 'fanhe-paths-none-'))
  try {
    // 随包路径指向一个不存在的文件：这是「打包时漏投了资源」的样子。
    await assert.rejects(
      apiLaunchModule(root, join(root, 'resources', 'agent', 'agent.ts')),
      (error) => {
        assert.match(error.message, /本机代理核心没找到/)
        // 报错要同时提到开发态与安装态该查什么 —— 只提一边的话，另一种形态的人照着查会白费工夫。
        assert.match(error.message, /开发态/)
        assert.match(error.message, /安装态/)
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('开发态不传随包路径时，报错文本与 T4-03 完全一致', async () => {
  // 降级是**加**上去的一条路，不是把原来的路改掉。这条用「不传第二个参数」把
  // 老行为钉死：否则将来有人图省事把参数改成必填，介质拷漏时的报错就会变味，
  // 而那正是这类故障唯一的线索。
  const root = await makeWorkspace()
  try {
    await assert.rejects(apiLaunchModule(root), (error) => {
      assert.match(error.message, /未找到 api 源码目录/)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('前端产物落点：开发态取工作区兄弟目录，安装态取 resources/web', () => {
  const fromDir = join('C:', 'ws', 'projects', 'fanhe-work', 'apps', 'desktop', 'dist')

  assert.equal(
    webDistRoot({ packaged: false, resourcesPath: 'C:\\ignored', fromDir }),
    join('C:', 'ws', 'projects', 'fanhe-work', 'apps', 'web', 'dist'),
    '开发态不看 resourcesPath —— 它在那儿没有意义',
  )
  assert.equal(
    webDistRoot({ packaged: true, resourcesPath: 'C:\\App\\resources', fromDir }),
    join('C:\\App\\resources', 'web'),
    '安装态必须走 resourcesPath，asar 里没有 apps/web/dist 这个兄弟目录',
  )
})

test('随包代理路径的形状与打包配置一致', () => {
  // 这条看着像废话，但它钉的是**两处配置的一致性**：`electron-builder.yml` 把
  // agent.ts 投到 `agent/agent.ts`，而这个函数负责算出它在哪儿。两边各写一遍、
  // 其中一边改了，症状是装完之后点启动说「本机代理不可用」。
  assert.equal(
    bundledAgentPath('C:\\App\\resources'),
    join('C:\\App\\resources', 'agent', 'agent.ts'),
  )
})
