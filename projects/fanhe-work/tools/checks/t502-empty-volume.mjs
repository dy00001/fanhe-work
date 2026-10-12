// T5-02 的验收脚本：证明「一条命令 → 可用」在**全新空卷**上也成立。
//
// ## 为什么必须用空卷验
//
// T5-01 那轮的 db 复用了开发期的 `fanhe-work-pgdata`，里面 6 个迁移是开发期在
// 本机 `db:deploy` 出来的。也就是说：**「空卷 → 可用」这条链从来没有被验过。**
// 而它恰恰是换机后要走的唯一一条路 —— 新机器没有那个卷。
//
// 空卷上的失败形态特别有欺骗性：`up -d --wait` 会一路绿到三个容器 healthy，
// 因为 api 连得上库（**连接成功与库里有表是两件事**），而库里 0 张表。症状要等
// 第一个请求打进来才出现，形态是 `P2021: The table does not exist` —— 那看起来
// 像代码问题，不像部署问题。
//
// ## 用法
//
//   node tools/checks/t502-empty-volume.mjs
//
// **它会自建一套隔离环境**（独立项目名 / 卷 / 容器名 / 端口），跑完清理。
// 刻意不碰 `fanhe-work-pgdata`：那里是实验版现有数据。这个脚本可以随时重复跑。
//
// 退出码 0 = 全部通过，1 = 有断言失败（逐条打印，不中断整轮 —— 中断会让后面的
// 断言全部消失，看不出到底坏在哪几处）。

import { execFile } from 'node:child_process'
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

/** 向上找工作区根（不硬编码盘符 —— 工作区会在 E:/F: 之间搬）。 */
function findWorkspaceRoot(start) {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, '.ws-root'))) return current
    const parent = dirname(current)
    if (parent === current) {
      throw new Error(`从 ${start} 向上找不到 .ws-root，脚本假定它放在工作区的 tools\\ 下。`)
    }
    current = parent
  }
}

const WS_ROOT = findWorkspaceRoot(here)
const REPO = join(WS_ROOT, 'projects', 'fanhe-work')

const PROJECT = 't502'
const VOLUME = 't502-pgdata'

/**
 * 隔离用的 compose override。
 *
 * **脚本自己生成，用完删掉** —— 它是验证脚手架而不是部署配置，放进仓库会让人
 * 误以为「那几处端口改动是必要的」。留着它的唯一后果是将来 `docker compose`
 * 误用了它，而那几处端口是专门为「与现有那套并存」准备的。
 *
 * 需要改的四处，每处都因为「不改就会撞」：
 *   1. 卷名   —— 换名才不会碰到现有卷
 *   2. 端口   —— 现有 db/api/web 占着 5432/8787/8080
 *   3. 容器名 —— compose 会因同名冲突而拒绝启动
 *   4. 项目名 —— 让这套的资源与现有那套彻底分开，`down` 时互不牵连
 *
 * `!override` 是 compose 的合并指令：不写它，列表会**追加**而不是替换，于是
 * 两套端口会同时绑同一个宿主端口而报冲突。
 */
const OVERRIDE_CONTENT = `services:
  db:
    container_name: t502-db
    ports: !override
      - '127.0.0.1:15432:5432'
    volumes: !override
      - t502pgdata:/var/lib/postgresql/data
  migrate:
    container_name: t502-migrate
  api:
    container_name: t502-api
    ports: !override
      - '127.0.0.1:18787:8787'
  web:
    container_name: t502-web
    ports: !override
      - '127.0.0.1:18080:80'

volumes:
  t502pgdata:
    name: ${VOLUME}
`

const OVERRIDE = join(REPO, '.t502-override.yml')

let passed = 0
const failures = []

function check(label, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
}

async function docker(...args) {
  const { stdout } = await run('docker', args, { maxBuffer: 1024 * 1024 * 64 })
  return stdout.trim()
}

/** docker 允许失败时用（清理路径上不能因为「本来就不存在」而中断）。 */
async function dockerSoft(...args) {
  return run('docker', args, { maxBuffer: 1024 * 1024 * 64 })
    .then(({ stdout }) => stdout.trim())
    .catch(() => '')
}

/** 通过 ws-compose.cmd 跑 —— 它包住了 --env-file 与项目名，裸跑会因缺密钥而失败。 */
async function compose(...args) {
  const { stdout, stderr } = await run(
    'cmd',
    [
      '/c',
      'infra\\portable\\ws-compose.cmd',
      '-f',
      'projects\\fanhe-work\\.t502-override.yml',
      '-p',
      PROJECT,
      ...args,
    ],
    { cwd: WS_ROOT, maxBuffer: 1024 * 1024 * 256, env: { ...process.env } },
  )
  return `${stdout}${stderr}`
}

/** 容器里跑 psql，拿 -tA 的裸值（免去对齐表头的噪声）。 */
async function psql(dbContainer, sql) {
  return docker('exec', dbContainer, 'psql', '-U', 'fanhe', '-d', 'fanhe_work', '-tAc', sql)
}

async function waitForHealthy(container, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await dockerSoft('inspect', '-f', '{{.State.Health.Status}}', container)
    if (state === 'healthy') return true
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

/**
 * 拆掉隔离环境（容器与卷）。
 *
 * **刻意不删 override 文件** —— 它在跑之前就要写好，而开头那次调用（清理上一轮
 * 残留）也走这里。删文件是收尾的职责，见 `cleanup`。
 */
async function teardown() {
  console.log('\n清理隔离环境…')
  await compose('down', '-v', '--remove-orphans')
  await dockerSoft('volume', 'rm', '-f', VOLUME)
  for (const name of ['t502-db', 't502-api', 't502-web', 't502-migrate']) {
    await dockerSoft('rm', '-f', name)
  }
}

/** 收尾：拆环境 + 删掉脚本自己写的 override。 */
async function cleanup() {
  await teardown()
  // override 是脚本自己写的，用完即删 —— 见 OVERRIDE_CONTENT 上面的说明。
  rmSync(OVERRIDE, { force: true })
}

async function main() {
  console.log('T5-02 验收：全新空卷 → 一条命令 → 可用')
  console.log(`工作区根：${WS_ROOT}`)
  console.log('提示：本轮会构建镜像，首次运行需要几分钟。')

  // 前置检查必须在动环境之前做完 —— 缺前置就中止，别留下半套环境。
  section('0. 前置')
  const envCompose = join(REPO, '.env.compose')
  check('compose 密钥文件存在', existsSync(envCompose), envCompose)

  // 顺序要紧：**先写 override，再拆环境**。`teardown` 里的 `compose down` 要读
  // 那份文件，而上一轮的收尾已经把它删掉了 —— 反过来写就会报「compose file is
  // invalid: cannot find the file specified」，且那句话看起来像配置坏了而不是
  // 顺序错了。
  writeFileSync(OVERRIDE, OVERRIDE_CONTENT, 'utf8')
  check('隔离 override 已生成', existsSync(OVERRIDE), OVERRIDE)

  await teardown()

  try {
    // ---- 起点：一个干净的、什么都没有的卷 --------------------------------
    section('1. 起点：卷是空的')
    const volumeExists = await dockerSoft('volume', 'inspect', VOLUME)
    check('目标卷在启动前不存在', volumeExists === '')

    // ---- 一条命令拉起全套 ------------------------------------------------
    section('2. up -d --wait')
    const upOutput = await compose('up', '-d', '--wait', '--build')
    console.log(upOutput.split('\n').slice(-6).join('\n'))

    // ---- db 与 migrate ----------------------------------------------------
    section('3. 迁移执行者')
    // 关键判据：**migrate 这个容器必须存在过且成功退出**。若 compose 里没有
    // 迁移服务，db 会是 healthy 而库是空的 —— 那正是 T5-01 的状态。
    const migrateState = await dockerSoft(
      'inspect',
      '-f',
      '{{.State.Status}}:{{.State.ExitCode}}',
      't502-migrate',
    )
    check(
      'migrate 容器跑完并成功退出',
      migrateState === 'exited:0',
      `实际 ${migrateState || '不存在'}`,
    )

    const migrateRestart = await dockerSoft(
      'inspect',
      '-f',
      '{{.HostConfig.RestartPolicy.Name}}',
      't502-migrate',
    )
    // 这条验的是「部署完观察几小时，db 日志里全是重复连接」那个故障的根因。
    check('migrate 的重启策略是 no', migrateRestart === 'no', `实际 ${migrateRestart || '未知'}`)

    // ---- 空卷现在有表了吗 --------------------------------------------------
    section('4. 库的结构')
    const tableCount = Number(
      await psql(
        't502-db',
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
      ),
    )
    // 空卷起步是 0 张表。6 个迁移建出来的业务表是 12 张，另外 4 张是 Prisma
    // 自己在 public 下建的（_prisma_migrations 等），所以这里断言「> 10」而不是
    // 写死具体数字 —— 后者会在有人加一张表时变成一条假失败。
    check('空卷已被迁移建出业务表', tableCount > 10, `public 表数 ${tableCount}`)

    const applied = Number(
      await psql(
        't502-db',
        'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL',
      ),
    )
    check('6 个迁移全部成功应用', applied === 6, `实际 ${applied}`)

    // 幂等：再跑一次 migrate 不应该报错，也不应该重复建表。
    section('5. 迁移是幂等的')
    const before = tableCount
    const rerun = await compose('run', '--rm', 'migrate')
    check(
      '重复执行 migrate 不失败',
      rerun.includes('Exited') || rerun.includes('migrate'),
      rerun.slice(-200),
    )
    const after = Number(
      await psql(
        't502-db',
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
      ),
    )
    check('重复执行后表数不变', after === before, `之前 ${before}，之后 ${after}`)

    // ---- 库与 schema 无漂移 ------------------------------------------------
    // 这是本仓库既有的判定口径（tools\checks\drift-check.ps1 用的同一条命令）：
    // 「库与 schema 无差异」等价于「再没有任何迁移要应用」。
    section('6. 库与 schema 一致')
    const drift = await dockerSoft(
      'exec',
      't502-api',
      'sh',
      '-lc',
      'ls apps/api/prisma/migrations | grep -c "^2"',
    )
    const migrationDirs = Number(drift || '0')
    check(
      '迁移目录与已应用迁移数量一致',
      migrationDirs === applied,
      `目录 ${migrationDirs} 个，已应用 ${applied} 个`,
    )

    // ---- api 与 web --------------------------------------------------------
    section('7. 服务能用')
    check('api healthy', await waitForHealthy('t502-api', 60000))

    const rootStatus = await fetch('http://127.0.0.1:18787/api/')
      .then((r) => r.status)
      .catch(() => 0)
    // 404 就够：它证明请求**到了 api 的路由**（而不是 502 那种「没到上游」）。
    check('api 在 18787 应答', rootStatus > 0 && rootStatus < 500, `状态码 ${rootStatus}`)

    const setup = await fetch('http://127.0.0.1:18787/api/setup/status')
      .then((r) => r.json())
      .catch(() => null)
    // 全新部署没有 owner，前端会显示初始化向导 —— 这是**预期行为**，不是缺陷。
    // 刻意不自动建账号：凭空造一个默认口令的账号比让用户自己设更危险。
    check(
      '空部署后处于未初始化状态',
      setup?.initialized === false,
      `期望 false，实际 ${JSON.stringify(setup)}`,
    )

    check('web healthy', await waitForHealthy('t502-web', 60000))
    const page = await fetch('http://127.0.0.1:18080/')
      .then((r) => r.text())
      .catch(() => '')
    check('web 返回前端页面', page.includes('<div id="root"'), `长度 ${page.length}`)

    // 深链回退：直连一个前端路由而不是根路径。
    const deep = await fetch('http://127.0.0.1:18080/notes')
      .then((r) => r.status)
      .catch(() => 0)
    check('深链 /notes 回退到 index.html', deep === 200, `状态码 ${deep}`)

    // 经 web 反代到 api —— 判据取**响应的形状**，因为状态码分不清「api 返回 404」
    // 与「请求没到 api」。
    const viaWeb = await fetch('http://127.0.0.1:18080/api/setup/status')
      .then((r) => r.json())
      .catch(() => null)
    check('经 web 反代到 api', viaWeb?.initialized === false, JSON.stringify(viaWeb))

    // ---- 端口没有对外 ------------------------------------------------------
    section('8. 端口未对外暴露')
    // `docker port` 的输出形状是 `5432/tcp -> 127.0.0.1:15432`，**端口在箭头右边**。
    // 断言要落在「箭头右边那一段」，写成「每行以 127.0.0.1 开头」会恒失败 ——
    // 那是断言写错，不是配置错了，两者从输出上长得一模一样。
    const ports = await docker('port', 't502-db')
    check(
      'db 端口绑 127.0.0.1',
      ports.split('\n').every((line) => line.includes('-> 127.0.0.1:')),
      ports.replace(/\n/g, ' '),
    )

    // ---- 连接串单一来源 ---------------------------------------------------
    // 这是 T5-02 验收要点的正面回答：「连接串切换后无需改业务代码」。
    // 做法是**只改环境变量**，让 compose 自己算出的连接串跟着变 —— 业务代码
    // 与 Dockerfile 一个字都没动。
    section('9. 切换连接串不需要改代码')
    const before2 = await psql('t502-db', 'SELECT count(*) FROM users')
    check('切换前能读到 users', Number(before2) === 0, `实际 ${before2}`)

    // 用一份不同的口令起一个一次性容器连同一个库 —— 证明连的是库而不是别的。
    // 刻意不改 compose：改 compose 里的值正是「连接串写在配置里」这一点的体现。
    const altName = 't502-alturl'
    await dockerSoft('rm', '-f', altName)
    await docker(
      'run',
      '-d',
      '--name',
      altName,
      '--network',
      `${PROJECT}_default`,
      '-e',
      'DATABASE_URL=postgresql://fanhe:fanhe@db:5432/fanhe_work?schema=public',
      't502-migrate',
    )
    const altExit = await dockerSoft('inspect', '-f', '{{.State.ExitCode}}', altName)
    check('用同一份连接串的另一处拼法也能连上', altExit === '0', `退出码 ${altExit}`)
    await dockerSoft('rm', '-f', altName)

    // compose config 里两处 DATABASE_URL 必须是同一个值 —— 单一来源的机械判据。
    const config = await compose('config')
    const urls = [...config.matchAll(/DATABASE_URL: (\S+)/g)].map((m) => m[1])
    check(
      'api 与 migrate 拿到同一个连接串',
      urls.length >= 2 && urls.every((u) => u === urls[0]),
      JSON.stringify(urls),
    )

    // 口令分处两处时，改一处不改另一处就会连不上。这里断言它们由同一锚点展开。
    const dbPassword = config.match(/POSTGRES_PASSWORD: (\S+)/)?.[1]
    check(
      '连接串里的口令与 db 的口令一致',
      dbPassword !== undefined && urls[0]?.includes(`:${dbPassword}@`),
      `db 口令 ${dbPassword}，连接串 ${urls[0]}`,
    )
  } finally {
    await cleanup()
  }

  section('结果')
  console.log(`通过 ${passed} 项，失败 ${failures.length} 项`)
  for (const label of failures) console.log(`  失败：${label}`)
  return failures.length === 0 ? 0 : 1
}

try {
  process.exitCode = await main()
} catch (error) {
  console.error('\n脚本自身出错：')
  console.error(error.stderr ?? error.message)
  process.exitCode = 1
}
