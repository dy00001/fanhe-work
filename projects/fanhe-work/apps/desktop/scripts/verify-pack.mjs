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
  openSync,
  readSync,
  closeSync,
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

// electron-updater 是运行期依赖（T6-03b）：主进程 `require('electron-updater')`。
// 它在 `dependencies` 里，electron-builder 会自动收进 asar —— **但这属于「打包器
// 行为」而不是「我们的配置」**（electron-builder.yml 的 files 里并没有列它），
// 与 @fanhe/shared 那一组是同一种情况，所以同样要钉住。
//
// 为什么不能只靠「typecheck 通过」：typecheck 看的是 node_modules 里的类型，
// 而这里要证明的是**它进了产物**。少了它，安装后启动就会在加载期抛模块解析错误。
for (const required of [
  '/node_modules/electron-updater/package.json',
  '/node_modules/electron-updater/out/main.js',
]) {
  check(`asar 含 ${required}`, () => {
    expect(
      asarFiles.includes(required),
      `asar 里没有 ${required}。它必须是 apps/desktop/package.json 的 **dependencies**（不是 devDependencies），否则 electron-builder 不会收它`,
    )
  })
}

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

// ── 三、代码签名（T6-03c） ───────────────────────────────────────────────
/**
 * 读 PE 的 Certificate Table 目录项（数据目录第 4 项）。大小非零即有内嵌签名。
 *
 * 本函数只判「**有没有**签上」。「**签成了谁**」是另一件事，走
 * `scripts/verify-signature.ps1` 生成的报告（见下面「签名身份报告」）——
 * 两者必须分开，因为 electron-updater 比的是**发布者身份**，光有签名不够。
 *
 * 为什么不在这里直接调 `Get-AuthenticodeSignature`：它是 PowerShell 的，
 * 而本进程起不了子进程（原因见文件头），且本沙箱的 PowerShell 会静默吞掉 stdout。
 * 那份 .ps1 把结果写进文件、这里读回来，是唯一能真正拿到文本的通道。
 *
 * 🔴 判据是报告里的 `Status == Valid`（数值 0），不是 `Status != NotSigned`。
 *
 * 这里原来写的是后者，理由是「自签证书在没导入过它的机器上必然不可信，那不是打包
 * 缺陷」。**那条理由错了，而且它掩盖了一个真的阻塞项**（T6-03b 才发现）：
 *
 *   electron-updater 的 Windows 校验只在 `data.Status === 0` 时才进入发布者名比对
 *   （`windowsExecutableCodeSignatureVerifier.js`），而 `SignatureStatus` 的 0 就是
 *   `Valid`。其余任何值都会整段跳过匹配、**更新被拒** —— 包括未受信链产生的
 *   `UnknownError`（数值 1）。所以对自签方案来说，「不是 NotSigned」不是一个更低的
 *   门槛，而是一个**永远过不了 electron-updater** 的门槛。
 *
 * 实测（本机，修复前后）：`STATUS=UnknownError VALUE=1` → 把自签证书加进
 * `CurrentUser\\Root` → `STATUS=Valid VALUE=0`。加根的动作在
 * `scripts/create-signing-cert.ps1` 第 3 步里，见那里的注释。
 */
function peCertificateTable(file) {
  const buf = Buffer.alloc(4096)
  const fd = openSync(file, 'r')
  // 刻意不给初值：`read` 只在 try 里被赋值、且 readSync 抛错时这里根本走不到，
  // 给个 `= 0` 会被 no-useless-assignment 判为「赋了没用的值」。
  let read
  try {
    read = readSync(fd, buf, 0, buf.length, 0)
  } finally {
    closeSync(fd)
  }
  const d = buf.subarray(0, read)
  expect(d.length >= 0x40, `文件头不足 64 字节，不像 PE：${file}`)
  expect(d.readUInt16LE(0) === 0x5a4d, `没有 MZ 头，不是 PE：${file}`)
  const peOffset = d.readUInt32LE(0x3c)
  expect(
    d.subarray(peOffset, peOffset + 4).toString('latin1') === 'PE\0\0',
    `没有 PE 签名：${file}`,
  )
  const optionalHeader = peOffset + 4 + 20
  const magic = d.readUInt16LE(optionalHeader)
  expect(
    magic === 0x20b || magic === 0x10b,
    `可选头 magic 是 0x${magic.toString(16)}，不认识：${file}`,
  )
  // PE32+ 的数据目录从可选头偏移 112 起，PE32 从 96 起；第 4 项（0-based）是 Certificate Table。
  const entry = optionalHeader + (magic === 0x20b ? 112 : 96) + 4 * 8
  return { offset: d.readUInt32LE(entry), size: d.readUInt32LE(entry + 4) }
}

/**
 * 读回 `scripts/verify-signature.ps1` 写出的报告。
 *
 * 报告是 `KEY=VALUE` 与 `EXE=<名字>` 交替的平铺文本（.ps1 里刻意不写 JSON，
 * 免得为了转义再引入一层出错机会）。这里只取签名身份相关的几列，其余忽略。
 * 解析不出任何 EXE 时 `byName` 为空，由调用方的断言把它报成失败 ——
 * 而不是静默地「没有坏消息就是好消息」。
 *
 * `statusValue` 是 `SignatureStatus` 的数值。**它是判据本身**（见上面的
 * 「判据是 Status == Valid」那节）：electron-updater 比的就是这个数字与 0，
 * 所以这里也按数字比，而不是按 `Status` 那个名字比 —— 名字是给人看的，
 * 数值才是上游真正用的东西。
 */
/**
 * 报告列名 → 对象字段。
 *
 * 🔴 必须是**显式映射**，不能靠 `kv[1].toLowerCase()` 去猜：`STATUS_VALUE` 的小写是
 * `status_value`，而字段名是 camelCase 的 `statusValue`，`'status_value' in current`
 * 为假 → 这一列被**静默丢掉**。症状极具误导性：报告里明明写着 `STATUS_VALUE=0`，
 * 断言却说「报告里没有这一列」。T6-03b 踩的正是这个 —— 列名从单词改成两词时只改了
 * 产生端，解析端没跟着改，而丢弃是无声的，直到有人真的按数值 0 去断言才暴露。
 *
 * 所以对表里没有的键**直接抛错**：一个被悄悄忽略的列，比一个报错的列危险得多。
 */
const REPORT_KEY_TO_FIELD = {
  PATH: 'path',
  SIZE: 'size',
  STATUS: 'status',
  STATUS_VALUE: 'statusValue',
  SUBJECT: 'subject',
  THUMBPRINT: 'thumbprint',
  ERROR: 'error',
}

function parseSignatureReport(text) {
  const byName = new Map()
  let count = 0
  let current = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^\uFEFF/, '')
    const exe = /^EXE=(.+)$/.exec(line)
    if (exe !== null) {
      current = {
        name: exe[1],
        status: '',
        statusValue: '',
        subject: '',
        thumbprint: '',
        path: '',
        size: '',
        error: '',
      }
      byName.set(current.name, current)
      continue
    }
    const kv = /^\s+([A-Z][A-Z_]*)=([\s\S]*)$/.exec(line)
    if (kv !== null && current !== null) {
      const field = REPORT_KEY_TO_FIELD[kv[1]]
      if (field === undefined) {
        throw new Error(
          `签名报告里出现了未登记的列 ${kv[1]}：请加进 REPORT_KEY_TO_FIELD，不要让它被静默忽略`,
        )
      }
      current[field] = kv[2].trim()
      continue
    }
    const total = /^EXE_COUNT=(\d+)$/.exec(line)
    if (total !== null) count = Number(total[1])
  }
  return { byName, count }
}

console.log('\n三、代码签名（T6-03c）')

// 期望的签名主体从打包配置里读，而不是在脚本里再写一份常量：
// 这样「配置说要签成谁」与「产物实际签成谁」必须对得上，两份常量漂移不会互相掩护。
const builderConfig = readFileSync(join(desktopDir, 'electron-builder.yml'), 'utf8')
const subjectMatch = /^\s*certificateSubjectName:\s*(.+?)\s*$/m.exec(builderConfig)
const configuredSubject = subjectMatch === null ? null : subjectMatch[1].replace(/^['"]|['"]$/g, '')

if (configuredSubject === null) {
  console.log('  skip electron-builder.yml 里没有 certificateSubjectName，本节签名断言未运行')
} else {
  console.log(`  (配置的签名主体：${configuredSubject})`)

  // 安装包与辅助程序所在目录（release/），与应用本体目录（release/win-unpacked）分开。
  const releaseDir = dirname(installDir)
  const listExesIn = (dir) =>
    !existsSync(dir)
      ? []
      : readdirSync(dir)
          .filter((n) => n.toLowerCase().endsWith('.exe') && !/^(elevate|uninstall)/i.test(n))
          .map((n) => ({ name: n, path: join(dir, n) }))

  // 「本轮」的起点 = app.asar 的写入时刻。electron-builder 每轮都会重写它，而
  // `release/` 下的安装包**不会**被 `--dir` 那一轮清掉 —— 上一轮完整 `dist` 留下的
  // 安装包会原地不动。拿它当判据，才能区分「这轮产出的」与「上轮留下的」，
  // 否则验收会对着一个三轮之前的安装包下结论。
  const roundStart = existsSync(asarPath) ? statSync(asarPath).mtimeMs : 0

  // ① 应用本体 —— 用户实际双击的那个。
  const appExes = listExesIn(installDir)
  check('应用本体目录里有 exe', () => {
    expect(appExes.length > 0, `${installDir} 下一个 exe 都没有（elevate/Uninstall 已排除）`)
    return appExes.map((e) => e.name).join(', ')
  })
  for (const exe of appExes) {
    check(`${exe.name} 有内嵌签名（PE 签名表非空）`, () => {
      const { offset, size } = peCertificateTable(exe.path)
      expect(size > 0, 'PE 签名表为空 —— 没签上。先确认证书在 CurrentUser\\My（跑 signing:cert）')
      return `签名表 ${size} 字节 @ 0x${offset.toString(16)}`
    })
  }

  // ② 安装包 —— 更新器下载后校验的正是它，所以这条比①更贴近更新链路。
  // 只在「本轮真的产出了安装包」时断言：`--dir` 只出 win-unpacked。
  const installerExes = listExesIn(releaseDir).filter((e) => /setup/i.test(e.name))
  const staleInstallers = installerExes.filter((e) => statSync(e.path).mtimeMs < roundStart)
  const freshInstallers = installerExes.filter((e) => statSync(e.path).mtimeMs >= roundStart)
  if (freshInstallers.length === 0) {
    console.log(
      `  未验证 本轮没产出安装包（目录里有 ${staleInstallers.length} 个，属上一轮，已排除）。\n` +
        '         `--dir` 只出 win-unpacked，所以「安装包已签名」与下面的 app-update.yml\n' +
        '         这两组断言**本轮既不算通过也不算失败** —— 跑完整 `dist` 才能验。',
    )
  } else {
    for (const exe of freshInstallers) {
      check(`${exe.name}（安装包）有内嵌签名`, () => {
        const { offset, size } = peCertificateTable(exe.path)
        expect(size > 0, '安装包 PE 签名表为空 —— 更新器校验下载包时会拒绝安装')
        return `签名表 ${size} 字节 @ 0x${offset.toString(16)}`
      })
    }
  }

  // ③ electron-updater 比对发布者用的就是这份文件。
  //
  // 它**只在真正的 nsis 构建里才会生成**，这一点不查源码会误判成 bug：electron-builder
  // 在 onAfterPack 里有一道 `isSuitableWindowsTarget` 闸（out/publish/PublishManager.js:391），
  // 只认 `nsis` / `nsis-*`（或 appx 且开了 electronUpdaterAware）。`--dir` 用的 `dir`
  // 目标不在此列 → 文件本来就不存在。所以这里跟着②一起判断，不对 `--dir` 报假 FAIL。
  //
  // 另一个前置条件是 `WinPackager.isForceCodeSigningVerification`（out/winPackager.js:26）
  // = `verifyUpdateCodeSignature !== false`。本项目没有把它设成 false，故为真，
  // publisherName 会被写进去；哪天有人为了「跳过校验」把它设成 false，这里就会先炸。
  if (freshInstallers.length === 0) {
    console.log('  未验证 app-update.yml（本轮无安装包 → 不是 nsis 构建 → 本来就不会生成它）')
  } else {
    check('resources/app-update.yml 存在且含 publisherName', () => {
      const target = join(resourcesDir, 'app-update.yml')
      expect(existsSync(target), `没有 ${target} —— electron-updater 从这里读更新源与发布者`)
      const m = /^\s*publisherName:\s*(.+?)\s*$/m.exec(readFileSync(target, 'utf8'))
      expect(
        m !== null,
        `app-update.yml 里没有 publisherName，更新校验就没有发布者可依据。内容：\n${readFileSync(target, 'utf8')}`,
      )
      return m[1]
    })

    check('publisherName 与配置的证书主体对得上', () => {
      const simpleName = configuredSubject.replace(/^CN=/, '')
      const m = /^\s*publisherName:\s*(.+?)\s*$/m.exec(
        readFileSync(join(resourcesDir, 'app-update.yml'), 'utf8'),
      )
      expect(m !== null, 'app-update.yml 里没有 publisherName')
      expect(
        m[1].includes(simpleName),
        `publisherName 是「${m[1]}」，配置的证书主体是「${configuredSubject}」（简单名 ${simpleName}）—— 对不上，说明签名用的不是这张证书`,
      )
      return m[1]
    })

    // ④ latest.yml 与实际安装包的一致性 —— 这是更新器的**完整性**那一层
    // （§八 第 1 条），与 ③ 的**身份**那一层（第 2 条）是两件事，都要钉。
    // 更新器下载后先按 latest.yml 的 sha512 校验，对不上直接丢弃，
    // 所以「元数据与实际文件对得上」是发布链路能用的前提。
    check('latest.yml 的 sha512/size 与实际安装包一致', () => {
      const latestPath = join(releaseDir, 'latest.yml')
      expect(existsSync(latestPath), `没有 ${latestPath}（配了 publish 才会产出）`)
      const text = readFileSync(latestPath, 'utf8')
      const fileMatch = /^path:\s*(.+?)\s*$/m.exec(text)
      expect(fileMatch !== null, 'latest.yml 里没有顶层的 path（安装包文件名）')
      const shaMatch = /^sha512:\s*(.+?)\s*$/m.exec(text)
      expect(shaMatch !== null, 'latest.yml 里没有顶层的 sha512')
      const declared = shaMatch[1]
      // sha512 的 base64 定长 88 字符；长度不对说明正则匹配到了别的东西，
      // 那样下面的相等断言可能只是「两边都为空」的假通过。
      expect(
        declared.length === 88,
        `latest.yml 的 sha512 解出来是 ${declared.length} 字符（应为 88），正则可能匹配错了行`,
      )

      const target = join(releaseDir, fileMatch[1])
      expect(existsSync(target), `latest.yml 指向 ${fileMatch[1]}，但 ${target} 不存在`)
      const actual = createHash('sha512').update(readFileSync(target)).digest('base64')
      expect(
        actual === declared,
        `latest.yml 声明的 sha512 与 ${fileMatch[1]} 的实际值不一致 —— 更新器会拒绝这个包`,
      )
      return `${fileMatch[1]} ${actual.slice(0, 16)}…`
    })
  }

  // 反例：证明上面那条「有内嵌签名」不是恒真。
  check('反例 · PE 解析器对非 PE 文件必须报错', () => {
    let threw = false
    try {
      peCertificateTable(join(resourcesDir, 'web', 'index.html'))
    } catch {
      threw = true
    }
    expect(threw, '对一个 HTML 文件也返回了结果 —— 那么「有内嵌签名」这条断言不可信')
    return '如预期抛错'
  })

  // ⑤ 签名身份 —— 只在有报告时才验，缺报告时**明说未验证**，不当成通过。
  const reportPath = join(releaseDir, 'signature-report.txt')
  if (!existsSync(reportPath)) {
    console.log(
      '  未验证 签名身份报告不存在，本节目前只证明了「签上了」、**没有**证明「签成了谁」。\n' +
        '         先跑 `pnpm --filter @fanhe/desktop verify:sign` 生成报告（沙箱里 PowerShell 的\n' +
        '         stdout 会被吞掉，只有落盘这一条路），再重跑本脚本。',
    )
  } else {
    const report = parseSignatureReport(readFileSync(reportPath, 'utf8'))

    // 报告是独立脚本对整个 release 目录扫出来的，可能含上一轮留下的产物。
    // 只对本轮真正产出的名字下结论，其余的明说被排除 —— 而不是默默算进去，
    // 也不是默默忽略（后者会让「报告里 3 项全过」听起来比实际覆盖得多）。
    const expectedNames = new Set([
      ...appExes.map((e) => e.name),
      ...freshInstallers.map((e) => e.name),
    ])
    const considered = [...report.byName.entries()].filter(([n]) => expectedNames.has(n))
    const ignored = [...report.byName.keys()].filter((n) => !expectedNames.has(n))
    if (ignored.length > 0) {
      console.log(`  (报告里 ${ignored.length} 项不属于本轮，已排除：${ignored.join(', ')})`)
    }

    check('签名报告覆盖了本轮全部产物', () => {
      expect(
        considered.length === expectedNames.size,
        `本轮有 ${expectedNames.size} 个产物（${[...expectedNames].join(', ')}），报告只覆盖了 ${considered.length} 个。先重跑 verify:sign`,
      )
      return `${considered.length} 个`
    })

    check('签名报告里每个产物都是 Valid（Status 数值为 0）', () => {
      // 按**数值**比，不按名字比：electron-updater 的判断是 `data.Status === 0`，
      // 而 0 就是 Valid。下面这条一旦变红，意味着更新通道会拒绝每一个下载到的版本。
      // 报告缺 STATUS_VALUE 与「真的不是 Valid」是两件事，必须分开报。
      // 前者不是签名问题 —— 别去动证书，改的是产生端或解析端。
      const missingValue = considered.filter(([, v]) => v.statusValue === '').map(([k]) => k)
      expect(
        missingValue.length === 0,
        `签名报告里读不到 STATUS_VALUE 这一列（${missingValue.join(', ')}）。\n` +
          '        两种可能：报告是旧版 verify-signature.ps1 生成的（重跑 verify:sign 即可），\n' +
          '        或解析器的列名映射漏了它（改本文件顶部的 REPORT_KEY_TO_FIELD）。\n' +
          '        ⚠️ 这**不是**签名本身的问题，不要去动证书。',
      )
      const notValid = considered
        .filter(([, v]) => v.statusValue !== '0')
        .map(([k, v]) => `${k}(Status=${v.status || '?'} 数值=${v.statusValue})`)
      expect(
        notValid.length === 0,
        `以下产物的签名状态不是 Valid：${notValid.join(', ')}。\n` +
          '        更新器只在 Status=Valid 时校验发布者，其余一律拒绝安装。\n' +
          '        最常见的原因是自签证书不在受信任根里 —— 跑一次 `pnpm --filter @fanhe/desktop signing:cert`。',
      )
      const statuses = [...new Set(considered.map(([, v]) => v.status))]
      return `${considered.length} 个 exe，状态 ${statuses.join('/')}`
    })

    // 反例：把「Valid」放宽成「不是 NotSigned」会漏掉哪一种情况，就在这条里说明白。
    check('反例 · 未受信链会穿过「不是 NotSigned」这条松判据', () => {
      const loose = { status: 'UnknownError', statusValue: '1' }
      expect(
        loose.status !== 'NotSigned' && loose.statusValue !== '0',
        '这条反例自身的前提不成立，说明对 SignatureStatus 的理解变了',
      )
      return 'UnknownError 确实不是 NotSigned，且确实不是 Valid'
    })

    check('签名报告里的主体与配置的证书主体一致', () => {
      const simpleName = configuredSubject.replace(/^CN=/, '')
      const subjects = [...new Set(considered.map(([, v]) => v.subject).filter(Boolean))]
      expect(subjects.length > 0, '报告里没有任何签名主体，无法证明用了哪张证书')
      expect(
        subjects.every((s) => s.includes(simpleName)),
        `报告里的签名主体是 ${JSON.stringify(subjects)}，配置的是「${configuredSubject}」—— 不是同一张证书`,
      )
      return subjects.join(' / ')
    })

    // 反例：证明上面两条依赖的解析器不是「怎么喂都返回一条」。
    check('反例 · 报告解析器对无关文本必须解析不出 EXE', () => {
      const garbage = parseSignatureReport('hello\nworld=1\n')
      expect(
        garbage.byName.size === 0,
        `喂无关文本却解析出 ${garbage.byName.size} 个 EXE —— 那么「每个产物都不是 NotSigned」可能只是恒真`,
      )
      return '如预期为空'
    })

    // 反例：证明「列名 → 字段」这层映射漏掉一列时是**响亮**的，而不是静默丢弃。
    // T6-03b 被一次静默丢弃骗过：STATUS_VALUE 明明写在报告里，断言却说「没有这一列」，
    // 于是先怀疑了报告陈旧、又怀疑了证书，真正的原因只是解析端少了一次改名。
    // 一个会被悄悄忽略的列，比一个会报错的列危险得多 —— 所以两条都要钉住。
    check('反例 · 未登记的列必须抛错，且 STATUS_VALUE 必须真的落到字段上', () => {
      let threw = false
      try {
        parseSignatureReport('EXE=a.exe\n  STATUS=Valid\n  WEIRD_COLUMN=x\n')
      } catch {
        threw = true
      }
      expect(threw, '未登记的列被静默忽略了 —— 那么任何一次列名改动都会退化成「断言看不到这一列」')
      const parsed = parseSignatureReport(
        'EXE=a.exe\n  STATUS=Valid\n  STATUS_VALUE=0\n',
      ).byName.get('a.exe')
      expect(
        parsed !== undefined && parsed.statusValue === '0',
        `STATUS_VALUE 没落到 statusValue（得到 ${JSON.stringify(parsed?.statusValue)}）` +
          ' —— 报告里有值却读不到，正是 T6-03b 踩过的那个坑',
      )
      return '未登记列抛错，且 STATUS_VALUE 确实落到 statusValue'
    })
  }
}

console.log('\n四、随包 agent.ts 的实际加载（进程内 import）')
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
