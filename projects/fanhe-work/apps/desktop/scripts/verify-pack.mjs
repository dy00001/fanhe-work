#!/usr/bin/env node
/**
 * 打包产物的验收脚本（T6-03a）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify-pack.mjs
 *   node --experimental-strip-types scripts/verify-pack.mjs <安装目录>
 *   node --experimental-strip-types scripts/verify-pack.mjs --keep-broken
 *   （或 `pnpm --filter @fanhe/desktop verify:pack`）
 *
 * ## 为什么要有这个脚本，而不是手工 `ls` 一眼
 *
 * 打包能「成功」与产物能「用」之间隔着好几件事：extraResources 有没有真的落地、
 * 随包的 `agent.ts` 在 Node 的模块类型判定下能不能加载、asar 里是不是缺了共享包的
 * 解析入口。这些的共同点是**打包器不会因为它们出错而失败** —— 它们只在用户双击
 * 图标那一刻才炸。所以必须有一条把它们全部钉住的断言。
 *
 * ## 为什么断言里要写「逐字节一致」
 *
 * 「resources/web 下有 index.html」这类断言几乎恒真，挡不住「拷的是上一轮的旧产物」
 * 这种最常见的坏法。与源目录逐字节比对才排得掉陈旧副本。
 *
 * ## 为什么**不**在脚本里 spawn 子进程（这是本机实测的硬约束，不是风格偏好）
 *
 * 自动化会话里的 node 起子进程一律失败 —— 连 `spawnSync('cmd.exe', ['/c','echo','hi'])`
 * 都返回 `errno -4082 / EBUSY`，任何被 spawn 的目标都一样。早期版本用 `spawnSync` 去
 * 探两个运行时，结果 **stderr 是空的**，看起来像 agent.ts 加载失败，实则是子进程没起
 * 来，属于「把没验的说成验失败了」。所以本脚本只做**进程内** `import()`，需要另一个
 * 运行时（安装目录里那个 exe）时把命令打印出来交给人工执行 —— 见结尾「手工步骤」。
 * 装完之后如果需要更贴近现场，可以直接改成对安装目录跑：
 *   node --experimental-strip-types scripts/verify-pack.mjs "C:/Users/<你>/AppData/Local/Programs/梵禾 Work"
 *
 * ## 反例测试（脚本自带，见「四」）
 *
 * 全绿的脚本可能只是断言恒真，所以脚本会**主动破坏**两份临时副本：
 * 一份把 `package.json` 改成 `commonjs`（必须 SyntaxError）、
 * 一份往 `agent.ts` 里注入语法错误（必须抛错）。
 * 只有在人为破坏下真的报 FAIL，才证明「加载成功」那条断言有判据。改动只发生在临时
 * 副本上，产物本身不动。
 */
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdtempSync,
  cpSync,
  writeFileSync,
  appendFileSync,
  rmSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { join, dirname, resolve as resolvePath, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

// asar 是 CJS，用 createRequire 而不是 import 去加载它。
const require_ = createRequire(import.meta.url)

const here = dirname(fileURLToPath(import.meta.url))
const desktopDir = resolvePath(here, '..')

/** 向上找工作区根（以 `pnpm-workspace.yaml` 为标记 —— 子包里也有 package.json，不能用它）。 */
function findRepoRoot(from) {
  let current = from
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

const repoRoot = findRepoRoot(desktopDir)
if (repoRoot === null) {
  console.error('[verify-pack] 找不到工作区根（向上没有 pnpm-workspace.yaml）。')
  process.exit(2)
}

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const keepBroken = argv.includes('--keep-broken')
const positional = argv.filter((a) => !a.startsWith('--'))
const installDir =
  positional[0] !== undefined
    ? resolvePath(positional[0])
    : join(desktopDir, 'release', 'win-unpacked')

// ── 断言框架 ────────────────────────────────────────────────────────────
let pass = 0
const failures = []

function check(label, fn) {
  try {
    const detail = fn()
    pass += 1
    console.log(`  ok   ${label}${detail ? `  —  ${detail}` : ''}`)
  } catch (error) {
    failures.push({ label, message: error instanceof Error ? error.message : String(error) })
    console.log(
      `  FAIL ${label}\n         ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function checkAsync(label, fn) {
  try {
    const detail = await fn()
    pass += 1
    console.log(`  ok   ${label}${detail ? `  —  ${detail}` : ''}`)
  } catch (error) {
    failures.push({ label, message: error instanceof Error ? error.message : String(error) })
    console.log(
      `  FAIL ${label}\n         ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// ── asar 读取 ───────────────────────────────────────────────────────────
// electron-builder 把 @electron/asar 装在 .pnpm 下，顶层没有。与其猜路径，
// 不如枚举目录 —— 版本号会随升级变，写死就会在下次升级时静默地找不到。
function loadAsar() {
  const pnpmDir = join(repoRoot, 'node_modules', '.pnpm')
  if (!existsSync(pnpmDir)) throw new Error(`没有 ${pnpmDir}`)
  const entry = readdirSync(pnpmDir).find((name) => name.startsWith('@electron+asar@'))
  if (entry === undefined) throw new Error('.pnpm 下找不到 @electron/asar，无法读 asar 清单')
  const main = join(pnpmDir, entry, 'node_modules', '@electron', 'asar', 'lib', 'asar.js')
  expect(existsSync(main), `@electron/asar 存在但入口不在 ${main}`)
  return require_(main)
}

// ── 开跑 ────────────────────────────────────────────────────────────────
console.log(`[verify-pack] 安装目录 ${installDir}`)
console.log(`[verify-pack] 工作区根 ${repoRoot}`)

if (!existsSync(installDir)) {
  console.error('[verify-pack] 目录不存在。先跑 `pnpm --filter @fanhe/desktop dist:dir`。')
  process.exit(2)
}

const resourcesDir = join(installDir, 'resources')
const asarPath = join(resourcesDir, 'app.asar')
const sourceWebDist = join(repoRoot, 'apps', 'web', 'dist')
const sourceAgent = join(repoRoot, 'apps', 'api', 'src', 'launch', 'agent.ts')
const rootManifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))

console.log('\n一、asar 内的应用本体')
check('resources/app.asar 存在且非空', () => {
  expect(existsSync(asarPath), `没有 ${asarPath}`)
  const size = statSync(asarPath).size
  expect(size > 1024 * 1024, `app.asar 只有 ${size} 字节，不像装进了完整应用`)
  return `${(size / 1024 / 1024).toFixed(1)} MB`
})

let asarFiles = []
check('能读出 asar 清单', () => {
  const asar = loadAsar()
  asarFiles = asar.listPackage(asarPath).map((p) => p.split(sep).join('/'))
  expect(asarFiles.length > 0, 'asar 清单为空')
  return `${asarFiles.length} 项`
})

// `files` 是显式白名单，缺任何一项都会在启动时才炸，所以逐项钉住。
for (const required of ['/dist/main.js', '/dist/preload.js', '/package.json']) {
  check(`asar 含 ${required}`, () => {
    expect(
      asarFiles.includes(required),
      `asar 里没有 ${required}（检查 electron-builder.yml 的 files）`,
    )
  })
}

// 这两项最容易被漏：共享包的解析入口（package.json）与其实体。
// 少了 package.json，Node 解析 `require('@fanhe/shared')` 时找不到 main/exports。
for (const required of [
  '/node_modules/@fanhe/shared/package.json',
  '/node_modules/@fanhe/shared/dist/index.js',
]) {
  check(`asar 含 ${required}`, () => {
    expect(
      asarFiles.includes(required),
      `asar 里没有 ${required}。外壳运行时真的会 require('@fanhe/shared')（agent.ts 的 isAbsoluteExecutablePath 是取值导入，不是 import type），缺了它安装后启动即抛模块解析错误`,
    )
  })
}

check('asar 不含 src/ 与 test/（files 是显式白名单，不是默认 **/*）', () => {
  const leaked = asarFiles.filter((p) => p.startsWith('/src/') || p.startsWith('/test/'))
  expect(
    leaked.length === 0,
    `asar 里有 ${leaked.length} 项源码/测试：${leaked.slice(0, 5).join(', ')}`,
  )
})

check('asar 内的版本号等于仓库根版本', () => {
  const asar = loadAsar()
  const manifest = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
  expect(
    manifest.version === rootManifest.version,
    `asar 里是 ${manifest.version}，仓库根是 ${rootManifest.version}。跑一次 scripts/sync-version.mjs；若已是同值，说明打包读到的不是这份 package.json`,
  )
  return manifest.version
})

console.log('\n二、extraResources 落地情况')
check('resources/web/index.html 存在', () => {
  const target = join(resourcesDir, 'web', 'index.html')
  expect(existsSync(target), `没有 ${target}（extraResources: ../web/dist → web）`)
})

check('前端产物与 apps/web/dist 逐字节一致（挡陈旧副本）', () => {
  expect(existsSync(sourceWebDist), `源目录 ${sourceWebDist} 不存在，先构建 web`)
  const a = sha256(join(resourcesDir, 'web', 'index.html'))
  const b = sha256(join(sourceWebDist, 'index.html'))
  expect(
    a === b,
    `resources/web/index.html 与 apps/web/dist/index.html 不一致（${a.slice(0, 8)} vs ${b.slice(0, 8)}）—— 拷的是旧产物`,
  )
  return a.slice(0, 12)
})

check('resources/web/index.html 引用了 assets（不是空壳）', () => {
  const html = readFileSync(join(resourcesDir, 'web', 'index.html'), 'utf8')
  expect(
    /assets\/[^"']+\.js/.test(html),
    'index.html 里找不到 assets/*.js 的引用，前端产物可能不完整',
  )
})

check('resources/agent/agent.ts 存在且与源码逐字节一致', () => {
  const target = join(resourcesDir, 'agent', 'agent.ts')
  expect(
    existsSync(target),
    `没有 ${target}（extraResources: ../api/src/launch/agent.ts → agent/agent.ts）`,
  )
  const a = sha256(target)
  const b = sha256(sourceAgent)
  expect(
    a === b,
    `随包的 agent.ts 与 apps/api/src/launch/agent.ts 不一致（${a.slice(0, 8)} vs ${b.slice(0, 8)}）`,
  )
  return a.slice(0, 12)
})

check('resources/agent/package.json 内容为 {"type":"module"}', () => {
  const target = join(resourcesDir, 'agent', 'package.json')
  expect(
    existsSync(target),
    `没有 ${target}。缺了它，agent.ts 每次加载都会打 MODULE_TYPELESS_PACKAGE_JSON 告警`,
  )
  const manifest = JSON.parse(readFileSync(target, 'utf8'))
  expect(
    manifest.type === 'module',
    `内容是 ${JSON.stringify(manifest)}，type 必须是 module —— 写成 commonjs 会让 agent.ts 加载直接 SyntaxError（反例已证）`,
  )
  return manifest.type
})

console.log('\n三、随包 agent.ts 的实际加载（进程内 import）')
const agentFile = join(resourcesDir, 'agent', 'agent.ts')

// 断言的是「这条路径能加载出这些导出」，而不是「文件存在」——
// 后者在文件内容是半截的情况下也成立。
const EXPECTED_EXPORTS = [
  'PATH_INSPECT_TIMEOUT_MS',
  'RUN_DEDUPE_WINDOW_MS',
  'buildLaunchCommand',
  'inspectExecutablePath',
  'runLaunchProfile',
]

if (!existsSync(agentFile)) {
  console.log('  skip agent.ts 不存在，跳过本节的加载断言')
} else {
  await checkAsync('安装目录里的 agent.ts 能加载且导出齐备', async () => {
    let mod
    try {
      mod = await import(pathToFileURL(agentFile).href)
    } catch (error) {
      // 挂上 cause 而不是只留一行 message：这条断言失败时真正要看的是原始堆栈
      // （它指向 agent.ts 里的哪一行），只带文本会把现场丢掉。
      throw new Error(
        `加载抛错：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
        { cause: error },
      )
    }
    const names = Object.keys(mod)
    const missing = EXPECTED_EXPORTS.filter((name) => !names.includes(name))
    expect(
      missing.length === 0,
      `导出里缺 ${missing.join(', ')}。实际导出：${names.join(', ')}。注意 agent.ts 依赖零运行时依赖，随包的是 TS 源码本身，不需要编译`,
    )
    return `${names.length} 个导出`
  })

  // ── 反例：证明上面那条断言不是恒真 ──────────────────────────────────
  console.log('\n四、反例测试（证明第三节的断言能证伪）')
  const tempRoot = mkdtempSync(join(tmpdir(), 'fanhe-verify-pack-'))
  try {
    // 反例 1：把最近的 package.json 改成 commonjs。
    // 这条钉住的是「模块类型由最近的 package.json 决定」这个 Node 行为 ——
    // 也就是 resources/agent/package.json 这一份文件存在的全部理由。
    await checkAsync('反例 · package.json 改成 commonjs 后必须加载失败', async () => {
      const variant = join(tempRoot, 'as-commonjs')
      cpSync(join(resourcesDir, 'agent'), variant, { recursive: true })
      writeFileSync(join(variant, 'package.json'), '{"type":"commonjs"}\n')
      let error = null
      try {
        await import(pathToFileURL(join(variant, 'agent.ts')).href)
      } catch (caught) {
        error = caught
      }
      expect(
        error !== null,
        '把 type 改成 commonjs 之后居然还能加载 —— 那么第三节「加载成功」那条断言就不能证明 package.json 起了作用',
      )
      expect(
        error instanceof SyntaxError || /Cannot use import statement/.test(String(error?.message)),
        `加载确实失败了，但错误不是预期的模块类型错误，而是：${String(error?.message).split('\n')[0]}`,
      )
      return `如预期失败（${error.name}）`
    })

    // 反例 2：往源码里注入语法错误。
    // 这条钉住的是「真的解析了文件内容」，排除「断言的是缓存/空壳」。
    await checkAsync('反例 · 往 agent.ts 注入语法错误后必须加载失败', async () => {
      const variant = join(tempRoot, 'broken-source')
      cpSync(join(resourcesDir, 'agent'), variant, { recursive: true })
      appendFileSync(join(variant, 'agent.ts'), '\nconst = = =\n')
      let error = null
      try {
        await import(pathToFileURL(join(variant, 'agent.ts')).href)
      } catch (caught) {
        error = caught
      }
      expect(error !== null, '注入了语法错误却仍能加载 —— 说明加载断言没有真正解析文件内容')
      return `如预期失败（${error.name}）`
    })
  } finally {
    if (keepBroken) console.log(`  (保留临时目录 ${tempRoot})`)
    else rmSync(tempRoot, { recursive: true, force: true })
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────
console.log('')
if (failures.length === 0) {
  console.log(`[verify-pack] PASS —— ${pass} 项断言全过。`)
} else {
  console.log(
    `[verify-pack] FAIL —— ${failures.length} 项未过（共 ${pass + failures.length} 项）：`,
  )
  for (const f of failures) console.log(`  - ${f.label}`)
}

// ── 手工步骤（脚本起不了子进程，见文件头） ──────────────────────────────
const exeName = readdirSync(installDir).find(
  (n) => n.endsWith('.exe') && !/^(elevate|Uninstall)/i.test(n),
)
if (exeName !== undefined) {
  const exePath = join(installDir, exeName)
  console.log('\n手工步骤：用安装目录里那个运行时再验一次（本脚本起不了子进程，原因见文件头）')
  console.log(
    `  ELECTRON_RUN_AS_NODE=1 "${exePath}" --input-type=module -e "console.log(Object.keys(await import(process.argv[1])).sort().join(','))" "file:///${agentFile.split(sep).join('/')}"`,
  )
  console.log(
    '  预期输出一行导出名，且 stderr 为空（既无 MODULE_TYPELESS_PACKAGE_JSON，也无 SyntaxError）。',
  )
  console.log(`  若想跑完整应用： "${exePath}" --smoke`)
}

process.exit(failures.length === 0 ? 0 : 1)
