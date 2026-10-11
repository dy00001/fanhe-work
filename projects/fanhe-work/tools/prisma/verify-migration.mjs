/**
 * Apply the initial migration to an in-process PostgreSQL and exercise it.
 *
 * PGlite is PostgreSQL compiled to WebAssembly, and it is already on disk as a
 * transitive dependency of the Prisma CLI. It is not the project's database and
 * nothing here changes that; the point is narrower. The real instance is not
 * reachable yet, and a migration that has never been executed is a text file,
 * not evidence. Running it here proves the DDL parses, that the objects it
 * claims to create exist afterwards, and that the constraints actually behave.
 *
 * What this does NOT prove: behaviour under the real PostgreSQL version, the
 * `_prisma_migrations` bookkeeping, or anything about concurrency. Those wait
 * for the real server.
 *
 * 本文件由 .tmp 归档而来，做了两处改动：
 *   1. 盘符换成向上查找 .ws-root 得到的工作区根（受版本控制的文件不写盘符）。
 *   2. PGlite 的路径原本把版本号写进目录名（`@electric-sql+pglite@0.4.3`），依赖一升级
 *      就找不到；改成在 .pnpm 里按前缀查找。
 *
 * **这是一份快照，不是通用校验器。** 它绑定在第一个迁移上，下面的断言（六张表、
 * 两个枚举、22 个索引、五个外键）描述的是 T1-01 时的库形态。要校验后面的迁移，
 * 得改 MIGRATION 并重写这些断言 —— 期望值本身就是要人工想清楚的部分。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** 工作区根：向上找 .ws-root，不写盘符。 */
function findWorkspaceRoot(start) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.ws-root'))) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('未找到 .ws-root，请把脚本放回工作空间内运行')
    dir = parent
  }
}

const WS_ROOT = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)))
const REPO = join(WS_ROOT, 'projects', 'fanhe-work')

const pnpmDir = join(REPO, 'node_modules', '.pnpm')
const pgliteDir = readdirSync(pnpmDir).find((name) => name.startsWith('@electric-sql+pglite@'))
if (pgliteDir === undefined) {
  throw new Error(`未在 ${pnpmDir} 找到 @electric-sql/pglite`)
}
const PGLITE_ENTRY = join(
  pnpmDir,
  pgliteDir,
  'node_modules',
  '@electric-sql',
  'pglite',
  'dist',
  'index.js',
)
const MIGRATION = join(REPO, 'apps/api/prisma/migrations/20261010150103_init/migration.sql')

const { PGlite } = await import(pathToFileURL(PGLITE_ENTRY).href)

const report = []
const say = (line = '') => report.push(line)

let failures = 0
function check(label, condition, detail = '') {
  if (condition) {
    say(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    say(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const db = new PGlite()

say('=== 1. 应用迁移 ===')
const sql = readFileSync(MIGRATION, 'utf8')
say(`  migration.sql 首行: ${sql.split('\n')[0]}`)
await db.exec(sql)
say('  exec 完成，无异常')

say('')
say('=== 2. 表 ===')
const tables = await db.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
   ORDER BY table_name`,
)
const tableNames = tables.rows.map((r) => r.table_name)
say(`  实际: ${tableNames.join(', ')}`)
const expectedTables = [
  'audit_logs',
  'permissions',
  'refresh_tokens',
  'role_permissions',
  'roles',
  'users',
]
check('六张表全部建立', JSON.stringify(tableNames) === JSON.stringify(expectedTables))

say('')
say('=== 3. 枚举 ===')
const enums = await db.query(
  `SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS labels
   FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   GROUP BY t.typname ORDER BY t.typname`,
)
for (const row of enums.rows) {
  say(`  ${row.typname}: ${row.labels}`)
}
check('两个枚举已建立', enums.rows.length === 2)
check(
  'user_status 取值正确',
  enums.rows.find((r) => r.typname === 'user_status')?.labels === 'active,locked,disabled',
)
check(
  'audit_result 取值正确',
  enums.rows.find((r) => r.typname === 'audit_result')?.labels === 'success,failure',
)

say('')
say('=== 4. 索引 ===')
const indexes = await db.query(
  `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`,
)
say(`  共 ${indexes.rows.length} 个`)
check(
  '索引数量为 22（16 显式 + 6 主键）',
  indexes.rows.length === 22,
  `实际 ${indexes.rows.length}`,
)

say('')
say('=== 5. 外键 ===')
const fkeys = await db.query(
  `SELECT conname, confdeltype FROM pg_constraint WHERE contype = 'f' ORDER BY conname`,
)
for (const row of fkeys.rows) {
  const action = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' }[
    row.confdeltype
  ]
  say(`  ${row.conname}: ON DELETE ${action}`)
}
check('五个外键全部建立', fkeys.rows.length === 5)
check(
  'users.role_id 为 RESTRICT',
  fkeys.rows.find((r) => r.conname === 'users_role_id_fkey')?.confdeltype === 'r',
)
check(
  'audit_logs.actor_id 为 SET NULL',
  fkeys.rows.find((r) => r.conname === 'audit_logs_actor_id_fkey')?.confdeltype === 'n',
)
check(
  'refresh_tokens.user_id 为 CASCADE',
  fkeys.rows.find((r) => r.conname === 'refresh_tokens_user_id_fkey')?.confdeltype === 'c',
)

say('')
say('=== 6. 冒烟：写入与约束行为 ===')
const roleId = '00000000-0000-7000-8000-000000000001'
const permId = '00000000-0000-7000-8000-000000000002'
const userId = '00000000-0000-7000-8000-000000000003'

await db.exec(`
  INSERT INTO roles (id, code, name, description, is_system, rank, updated_at)
  VALUES ('${roleId}', 'owner', '超级管理员', '全部权限', true, 100, CURRENT_TIMESTAMP);

  INSERT INTO permissions (id, code, module, "object", action, description, updated_at)
  VALUES ('${permId}', 'system.user.read', 'system', 'user', 'read', '查看账号', CURRENT_TIMESTAMP);

  INSERT INTO role_permissions (id, role_id, permission_id)
  VALUES (gen_random_uuid(), '${roleId}', '${permId}');

  INSERT INTO users (id, username, password_hash, display_name, role_id, updated_at)
  VALUES ('${userId}', 'fanhe', 'argon2id-placeholder', '梵禾', '${roleId}', CURRENT_TIMESTAMP);

  INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, expires_at)
  VALUES (gen_random_uuid(), '${userId}', 'hash-a', gen_random_uuid(), CURRENT_TIMESTAMP + INTERVAL '30 days');

  INSERT INTO audit_logs (id, actor_id, actor_name, action, result)
  VALUES (gen_random_uuid(), '${userId}', '梵禾', 'user.login', 'success');
`)
say('  六张表各写入一行，全部成功')

const joined = await db.query(
  `SELECT u.username, r.code AS role_code, p.code AS perm_code
   FROM users u
   JOIN roles r ON r.id = u.role_id
   JOIN role_permissions rp ON rp.role_id = r.id
   JOIN permissions p ON p.id = rp.permission_id`,
)
check(
  '三表联结可读',
  joined.rows.length === 1 && joined.rows[0].perm_code === 'system.user.read',
  JSON.stringify(joined.rows[0] ?? null),
)

let duplicateRejected = false
try {
  await db.exec(
    `INSERT INTO users (id, username, password_hash, display_name, role_id, updated_at)
     VALUES (gen_random_uuid(), 'fanhe', 'x', '重复', '${roleId}', CURRENT_TIMESTAMP)`,
  )
} catch {
  duplicateRejected = true
}
check('username 唯一约束生效', duplicateRejected)

let badFkRejected = false
try {
  await db.exec(
    `INSERT INTO users (id, username, password_hash, display_name, role_id, updated_at)
     VALUES (gen_random_uuid(), 'ghost', 'x', '幽灵', gen_random_uuid(), CURRENT_TIMESTAMP)`,
  )
} catch {
  badFkRejected = true
}
check('users.role_id 外键生效', badFkRejected)

let roleDeleteRejected = false
try {
  await db.exec(`DELETE FROM roles WHERE id = '${roleId}'`)
} catch {
  roleDeleteRejected = true
}
check('角色被账号引用时不可删除（RESTRICT）', roleDeleteRejected)

await db.exec(`DELETE FROM audit_logs WHERE actor_id = '${userId}'`)
await db.exec(`INSERT INTO audit_logs (id, actor_id, actor_name, action, result)
               VALUES (gen_random_uuid(), '${userId}', '梵禾', 'user.logout', 'success')`)
await db.exec(`DELETE FROM refresh_tokens WHERE user_id = '${userId}'`)
await db.exec(`DELETE FROM users WHERE id = '${userId}'`)
const orphan = await db.query(`SELECT actor_id, actor_name FROM audit_logs ORDER BY action`)
check(
  '删除账号后审计日志保留且 actor_id 置空',
  orphan.rows.length === 1 &&
    orphan.rows[0].actor_id === null &&
    orphan.rows[0].actor_name === '梵禾',
  JSON.stringify(orphan.rows),
)

say('')
say('=== 7. uuid(7) 形态检查 ===')
const uuidSample = await db.query(`SELECT gen_random_uuid()::text AS v4`)
say(`  服务端 gen_random_uuid() 版本位: ${uuidSample.rows[0].v4[14]}`)
say('  说明：本项目主键由 Prisma 客户端生成 UUIDv7，数据库侧没有默认值，')
say('        因此上表只用于确认列类型为 uuid 而非 text。')
const idType = await db.query(
  `SELECT data_type FROM information_schema.columns WHERE table_name='users' AND column_name='id'`,
)
check('users.id 列类型为 uuid', idType.rows[0].data_type === 'uuid', idType.rows[0].data_type)

say('')
say(failures === 0 ? `全部通过（0 失败）` : `存在 ${failures} 项失败`)

const outDir = join(WS_ROOT, '.tmp')
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'migration-verify.txt'), report.join('\n'), 'utf8')

await db.close()
process.exit(failures === 0 ? 0 : 1)
