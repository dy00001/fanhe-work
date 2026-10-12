// 数据库备份与恢复（T5-03）。
//
// ## 为什么需要它
//
// **卷是整套部署里唯一的单点。** 代码在 git 里可以重拉、镜像可以重建、配置可以
// 重写，而命名卷里的数据只有一份 —— 卷损坏、误删、或换机时忘了带过来，数据就没
// 了。所以「能不能恢复」比「有没有备份」更要紧：一份没验证过能恢复的备份，等于
// 没有备份。
//
// 另一个理由是**数据库不随 U 盘走**（这是工作区一贯的约定）。代码跟着介质走、
// 数据留在机器上，那么换机时数据只能靠这个脚本重建 —— 它是数据跨机器的唯一通道。
//
// ## 用法
//
//   node tools/checks/db-backup.mjs backup             备份
//   node tools/checks/db-backup.mjs list               列出已有备份
//   node tools/checks/db-backup.mjs verify             校验最新备份（真恢复一次到临时库）
//   node tools/checks/db-backup.mjs restore <文件名> --force
//
// ## 三个刻意的选择
//
// **备份落在宿主机目录，不落进卷里。** 备份放在卷内看似省事，实际是陷阱：卷坏了
// 备份跟着一起坏，等于没有备份。备份必须在数据之外。
//
// **restore 默认不覆盖，要显式加 `--force`。** 恢复是唯一会**主动破坏现有数据**的
// 操作，所以它不能是「顺手就能做」的那类。缺 `--force` 时它会先打印源库与备份的
// 行数再退出 —— 让人能判断这一步该不该做。
//
// **verify 是真恢复，不是「文件能打开」。** 文件头对、校验和一致，都不代表能恢复
// 出来。verify 会在库里建一个临时库、把备份真的恢复进去、逐表比行数，然后删掉
// 临时库。**这是唯一能证明备份可用的判据。**

import { execFile, spawn } from 'node:child_process'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))

function findWorkspaceRoot(start) {
  let current = resolve(start)
  for (;;) {
    if (existsSync(join(current, '.ws-root'))) return current
    const parent = dirname(current)
    if (parent === current) throw new Error(`从 ${start} 向上找不到 .ws-root`)
    current = parent
  }
}

const WS_ROOT = findWorkspaceRoot(here)
const REPO = join(WS_ROOT, 'projects', 'fanhe-work')

/** 备份目录：工作区的 data/ 下（该目录被根 .gitignore 排除）。 */
const BACKUP_DIR = join(REPO, 'data', 'backups')

const DB_CONTAINER = 'fanhe-work-db'
const DB_NAME = 'fanhe_work'
const DB_USER = 'fanhe'

function stamp() {
  // 用连字符分隔：文件名会进 Windows 路径，而冒号在不少工具里是保留字符。
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

async function docker(...args) {
  const { stdout } = await run('docker', args, { maxBuffer: 1024 * 1024 * 256 })
  return stdout.trim()
}

/** docker 允许失败时用（清理路径上不能因为「本来就不存在」而中断）。 */
async function dockerSoft(...args) {
  return run('docker', args, { maxBuffer: 1024 * 1024 * 256 })
    .then(({ stdout }) => stdout.trim())
    .catch(() => '')
}

/** 容器里跑 psql 拿裸值（`-tAc` 免去对齐表头的噪声）。 */
async function psql(sql, database = DB_NAME) {
  return docker('exec', DB_CONTAINER, 'psql', '-U', DB_USER, '-d', database, '-tAc', sql)
}

function listBackups() {
  if (!existsSync(BACKUP_DIR)) return []
  return readdirSync(BACKUP_DIR)
    .filter((name) => name.endsWith('.dump'))
    .sort()
    .reverse()
}

async function tableCounts() {
  const tables = await psql(
    'SELECT table_name FROM information_schema.tables ' +
      "WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name",
  )
  const counts = {}
  for (const raw of tables.split('\n')) {
    const name = raw.trim()
    if (name === '') continue
    // 表名来自 information_schema 而非用户输入，但仍然引号化 —— 便宜的保险。
    const quoted = `"${name.replaceAll('"', '""')}"`
    counts[name] = Number((await psql(`SELECT count(*) FROM ${quoted}`)) || '0')
  }
  return counts
}

function formatCounts(counts) {
  return Object.entries(counts)
    .map(([table, count]) => `${table}=${count}`)
    .join(' ')
}

async function ensureDbRunning() {
  const state = await dockerSoft('inspect', '-f', '{{.State.Status}}', DB_CONTAINER)
  if (state !== 'running') {
    console.error(`数据库容器 ${DB_CONTAINER} 未在运行（当前：${state || '不存在'}）。`)
    console.error('先执行： infra\\portable\\ws-compose.cmd up -d --wait')
    process.exit(1)
  }
}

/**
 * 取 pg_dump 的二进制输出。
 *
 * **不能用 promisify(execFile)**：它按 utf-8 解码 stdout，而归档是二进制 ——
 * 解码会替换非法字节序列，写下来的文件因此损坏。症状是「备份文件在、
 * pg_restore 报 truncated」，看起来像备份坏了而实际是取的时候坏的。
 * `spawn` + Buffer 收集是这里唯一正确的形状。
 */
function dumpToBuffer() {
  return new Promise((res, rej) => {
    const child = spawn('docker', [
      'exec',
      DB_CONTAINER,
      'pg_dump',
      '-U',
      DB_USER,
      '-d',
      DB_NAME,
      '-Fc',
      '--no-owner',
      '--no-acl',
    ])
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', rej)
    child.on('close', (code) => {
      if (code === 0) res(Buffer.concat(out))
      else rej(new Error(`pg_dump 退出码 ${code}：${Buffer.concat(err).toString().slice(0, 500)}`))
    })
  })
}

/**
 * 把宿主机上的备份文件送进容器里的 pg_restore。
 *
 * 走 stdin（`docker exec -i`）是容器读到宿主文件的唯一途径 —— 备份不能放进卷里
 * （理由见文件头），而容器看不到宿主机的路径。
 *
 * pg_restore 也会把**日志**写到 stdout，与归档内容混在一起；所以这里把 stdout
 * 丢掉，只在失败时用 stderr 报错，不去解析它。
 */
function restoreFromFile(target, database, extraArgs = []) {
  return new Promise((res, rej) => {
    const child = spawn(
      'docker',
      [
        'exec',
        '-i',
        DB_CONTAINER,
        'pg_restore',
        '-U',
        DB_USER,
        '-d',
        database,
        '--no-owner',
        '--no-acl',
        '--exit-on-error',
        ...extraArgs,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )
    const err = []
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('error', rej)
    child.on('close', (code) => {
      if (code === 0) res()
      else
        rej(new Error(`pg_restore 退出码 ${code}：${Buffer.concat(err).toString().slice(0, 500)}`))
    })
    const stream = createReadStream(target)
    stream.on('error', rej)
    stream.pipe(child.stdin)
  })
}

async function backup() {
  await ensureDbRunning()
  mkdirSync(BACKUP_DIR, { recursive: true })

  const name = `fanhe-work-${stamp()}.dump`
  const target = join(BACKUP_DIR, name)
  console.log(`备份 ${DB_NAME} → ${target}`)

  // `-Fc` 是自定义格式：单文件、压缩，且能 selective 恢复（不像纯 SQL 文本只能
  // 整体重放）。对「恢复」这个用途它是对的选择。
  const buffer = await dumpToBuffer()
  writeFileSync(target, buffer)

  const digest = createHash('sha256').update(buffer).digest('hex').slice(0, 16)
  const counts = await tableCounts()

  // 校验和与行数落成同名 .meta —— **备份不带这些就只是一堆字节**，而「文件在」
  // 与「文件能恢复」是两件事。
  writeFileSync(
    `${target}.meta.json`,
    JSON.stringify(
      {
        name,
        createdAt: new Date().toISOString(),
        bytes: buffer.length,
        sha256_16: digest,
        tableCounts: counts,
      },
      null,
      2,
    ),
    'utf8',
  )

  console.log(`完成：${(buffer.length / 1024).toFixed(1)} KB，sha256 前 16 位 ${digest}`)
  console.log(`各表行数：${formatCounts(counts)}`)
  console.log('校验：node tools/checks/db-backup.mjs verify')
  return 0
}

async function verify() {
  const name = listBackups()[0]
  if (!name) {
    console.error('没有可用备份。先执行 backup。')
    return 1
  }
  const target = join(BACKUP_DIR, name)
  const metaPath = `${target}.meta.json`
  console.log(`校验最新备份：${name}`)

  // 归档魔数是 PGDMP。这是最便宜的「确实是归档」判据 —— 但它**只是第一关**。
  const raw = readFileSync(target)
  if (raw.subarray(0, 5).toString('latin1') !== 'PGDMP') {
    console.error('  FAIL  文件头不是 PGDMP —— 这不是 pg_dump 自定义格式的归档')
    return 1
  }
  console.log('  PASS  文件头是 PGDMP（自定义格式归档）')

  if (!existsSync(metaPath)) {
    console.error('  FAIL  缺同名 .meta.json（记录行数与校验和的那份）')
    return 1
  }
  const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
  const digest = createHash('sha256').update(raw).digest('hex').slice(0, 16)
  if (digest !== meta.sha256_16) {
    console.error(`  FAIL  校验和不符：meta 记 ${meta.sha256_16}，实际 ${digest}`)
    console.error('        —— 文件被改动过或写坏了')
    return 1
  }
  console.log(`  PASS  校验和一致（${digest}）`)

  // 恢复演练是本命令的核心：**文件头对不代表能恢复**。
  const probeDb = `backup_verify_${Date.now().toString(36)}`
  console.log(`  恢复演练到临时库 ${probeDb} …`)
  try {
    await psql(`CREATE DATABASE ${probeDb}`)
    await restoreFromFile(target, probeDb)
    console.log('  PASS  恢复过程无错误（--exit-on-error）')

    let mismatch = 0
    for (const [table, expected] of Object.entries(meta.tableCounts)) {
      const quoted = `"${table.replaceAll('"', '""')}"`
      const actual = Number((await psql(`SELECT count(*) FROM ${quoted}`, probeDb)) || '0')
      if (actual !== expected) {
        console.error(`  FAIL  ${table}：备份记录 ${expected}，恢复后 ${actual}`)
        mismatch += 1
      }
    }
    if (mismatch > 0) return 1
    console.log(`  PASS  全部 ${Object.keys(meta.tableCounts).length} 张表行数与备份时一致`)
    return 0
  } catch (error) {
    console.error(`  FAIL  ${error.message}`)
    return 1
  } finally {
    // 无论成败都删掉临时库 —— 留一个残库会让人以为那是可用的数据。
    await dockerSoft(
      'exec',
      DB_CONTAINER,
      'psql',
      '-U',
      DB_USER,
      '-d',
      'postgres',
      '-c',
      `DROP DATABASE IF EXISTS ${probeDb}`,
    )
    console.log(`  临时库 ${probeDb} 已删除`)
  }
}

async function restore(name) {
  await ensureDbRunning()
  if (!name) {
    console.error('要指定备份文件名。先跑 list 看有哪些。')
    return 1
  }
  const target = join(BACKUP_DIR, name)
  if (!existsSync(target)) {
    console.error(`找不到备份：${name}`)
    console.error(`可用：${listBackups().join(' ') || '(无)'}`)
    return 1
  }

  const metaPath = `${target}.meta.json`
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null

  console.log(`即将用 ${name} 覆盖数据库 ${DB_NAME}。`)
  console.log(`当前各表行数：${formatCounts(await tableCounts())}`)
  if (meta) console.log(`备份时行数：  ${formatCounts(meta.tableCounts)}`)

  if (!process.argv.includes('--force')) {
    console.error('\n这是唯一会主动破坏现有数据的操作，因此必须显式确认：')
    console.error(`  node tools/checks/db-backup.mjs restore ${name} --force`)
    return 1
  }

  try {
    // `--clean --if-exists`：先删后建。**不加 --clean 的话恢复是「插入」**，
    // 库里已有同主键的行会让结果变成两份叠加 —— 那看起来成功了而实际是错的，
    // 且要等用户看到重复数据才发现。
    await restoreFromFile(target, DB_NAME, ['--clean', '--if-exists'])
  } catch (error) {
    console.error(`恢复失败：${error.message}`)
    console.error('**恢复可能是部分完成的** —— 请立刻跑一次 verify 看现在的库是什么样子。')
    return 1
  }

  const after = await tableCounts()
  console.log(`恢复后行数：${formatCounts(after)}`)
  if (meta) {
    let bad = 0
    for (const [table, expected] of Object.entries(meta.tableCounts)) {
      if (after[table] !== expected) {
        console.error(`  不一致：${table} 期望 ${expected}，实际 ${after[table]}`)
        bad += 1
      }
    }
    if (bad > 0) {
      console.error(`恢复完成但有 ${bad} 张表与备份时不一致 —— 这不是一次成功的恢复。`)
      return 1
    }
    console.log('与备份记录逐表一致。')
  }
  console.log('\n注意：迁移状态也一并恢复了。若备份来自较旧的库，补跑一次：')
  console.log('  infra\\portable\\ws-compose.cmd run --rm migrate')
  return 0
}

function list() {
  const files = listBackups()
  if (files.length === 0) {
    console.log('还没有备份。执行：node tools/checks/db-backup.mjs backup')
    return 0
  }
  console.log(`备份目录：${BACKUP_DIR}`)
  for (const name of files) {
    const size = statSync(join(BACKUP_DIR, name)).size
    const hasMeta = existsSync(join(BACKUP_DIR, `${name}.meta.json`))
    console.log(`  ${name}  ${(size / 1024).toFixed(1)} KB${hasMeta ? '' : '  (缺 meta)'}`)
  }
  return 0
}

const restoreName = process.argv[3]
const handlers = {
  backup,
  verify,
  restore: () => restore(restoreName),
  list,
}

const handler = handlers[process.argv[2] ?? '']
if (!handler) {
  console.error('用法：node tools/checks/db-backup.mjs <backup|verify|restore <文件名>|list>')
  console.error('restore 需额外加 --force —— 它是唯一会主动破坏现有数据的操作。')
  process.exit(1)
}

try {
  process.exitCode = await handler()
} catch (error) {
  console.error('脚本出错：')
  console.error(error.stderr ?? error.message)
  process.exitCode = 1
}
