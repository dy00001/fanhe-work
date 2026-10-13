/**
 * 权限展开的回归测试。
 *
 * 直接跑构建产物 dist，不跑源码：种子里写进库的就是 dist 展开的结果，测它才是
 * 测真实生效的那份代码。代价是运行前必须先 build，所以 test 脚本里带上 build。
 *
 * 用 Node 内置的测试运行器，不引第三方框架。这里要守的规则很少但很关键，
 * 为一个文件装一套 vitest 不划算；而 `assert` 与 `test` 已经够用。
 *
 * 存在的原因是一次真实事故：matchesGrant 早期要求模式段数与编码段数相等，
 * 于是 `personal.*`（2 段）永远匹配不上 `personal.launch.read`（3 段）。种子
 * 照样跑完、照样打印成功，只是 member 角色拿到了 0 个权限点 —— 没有报错，
 * 没有任何日志异常，只有把 17 和 29 这两个数摆在一起才看得出来。
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALL_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_CATALOG,
  ROLE_PERMISSIONS,
  expandGrants,
  matchesGrant,
} from '../dist/index.js'

const PERSONAL_READ = [
  PERMISSIONS.PERSONAL_LAUNCH_READ,
  PERMISSIONS.PERSONAL_NOTE_READ,
  PERMISSIONS.PERSONAL_EVENT_READ,
]

const PERSONAL_ALL = [
  PERMISSIONS.PERSONAL_LAUNCH_READ,
  PERMISSIONS.PERSONAL_LAUNCH_WRITE,
  PERMISSIONS.PERSONAL_NOTE_READ,
  PERMISSIONS.PERSONAL_NOTE_WRITE,
  PERMISSIONS.PERSONAL_EVENT_READ,
  PERMISSIONS.PERSONAL_EVENT_WRITE,
]

const sorted = (codes) => [...codes].sort()

/**
 * 权限点总数。
 *
 * **从 `PERMISSION_CATALOG` 派生，不写死数字。** 写死的写法下每加一个权限点就要改
 * 这里，而那次失败的表现是「某个角色的权限点数对不上」——它指向角色配置，而真正
 * 变的是清单。一个永远等于常量的断言其实什么都没验，但它确实能验「清单与常量
 * 同步」，因此保留，只是数字不再手写。
 */
const TOTAL_PERMISSIONS = PERMISSION_CATALOG.length

test('权限点清单与常量一致、无重复，且三段式拆分正确', () => {
  assert.equal(ALL_PERMISSIONS.length, TOTAL_PERMISSIONS)
  // 去重后长度不变，说明清单里没有重复项。重复的权限码会让种子里的授权关联
  // 插入两次，而 role_permissions 的复合唯一约束会让整个种子事务失败。
  assert.equal(new Set(ALL_PERMISSIONS).size, TOTAL_PERMISSIONS)
  assert.deepEqual(sorted(ALL_PERMISSIONS), sorted(PERMISSION_CATALOG.map((p) => p.code)))
})

test('`*` 覆盖全部权限', () => {
  assert.equal(expandGrants(['*']).length, TOTAL_PERMISSIONS)
})

test('末尾通配符吞掉剩余段：`personal.*` 覆盖模块下全部权限', () => {
  assert.deepEqual(sorted(expandGrants(['personal.*'])), sorted(PERSONAL_ALL))
})

test('末尾通配符吞掉剩余段：`personal.note.*` 只覆盖该对象的读写', () => {
  assert.deepEqual(
    sorted(expandGrants(['personal.note.*'])),
    sorted([PERMISSIONS.PERSONAL_NOTE_READ, PERMISSIONS.PERSONAL_NOTE_WRITE]),
  )
})

test('非末尾通配符只吃一段：`personal.*.read` 只给读权限，不给写权限', () => {
  const expanded = expandGrants(['personal.*.read'])
  assert.deepEqual(sorted(expanded), sorted(PERSONAL_READ))
  for (const code of expanded) {
    assert.ok(!code.endsWith('.write'), `${code} 不该出现在只读角色的授权里`)
  }
})

test('模式比编码短且无通配符时不命中', () => {
  assert.equal(matchesGrant('personal.note', PERMISSIONS.PERSONAL_NOTE_READ), false)
  assert.equal(matchesGrant('personal', PERMISSIONS.PERSONAL_NOTE_READ), false)
})

test('模式比编码长时不命中', () => {
  assert.equal(matchesGrant('personal.note.read.extra', PERMISSIONS.PERSONAL_NOTE_READ), false)
})

test('模块名不同不命中', () => {
  assert.equal(matchesGrant('personal.*', PERMISSIONS.SYSTEM_USER_READ), false)
})

test('精确编码只命中自身', () => {
  assert.equal(matchesGrant(PERMISSIONS.PERSONAL_NOTE_READ, PERMISSIONS.PERSONAL_NOTE_READ), true)
  assert.equal(matchesGrant(PERMISSIONS.PERSONAL_NOTE_READ, PERMISSIONS.PERSONAL_NOTE_WRITE), false)
})

test('owner 拿到全部权限，其余三个角色按层级递减', () => {
  // **不断言具体点数，只断言层级关系。** 点数会随每个新权限点漂移，写死数字
  // 意味着每加一个权限点就要改一遍这里，而那次失败读起来像「角色配置错了」，
  // 真正变的却是清单。层级关系才是这条该守的东西。
  assert.deepEqual(sorted(ROLE_PERMISSIONS.owner), sorted(ALL_PERMISSIONS))

  const { owner, admin, member, viewer } = ROLE_PERMISSIONS
  assert.ok(owner.length > admin.length, 'owner 应当多于 admin')
  assert.ok(admin.length > member.length, 'admin 应当多于 member')
  assert.ok(member.length > viewer.length, 'member 应当多于 viewer')
})

test('owner 是唯一持有删除账号权限的角色', () => {
  // 删除与其它账号操作分成两个权限点。这条断言守的是「混在 manage 里的话，
  // 能改名的账号就能删人」那条设计意图 —— 少一个权限点，多一个能删人的角色。
  const withDelete = Object.entries(ROLE_PERMISSIONS)
    .filter(([, perms]) => perms.includes(PERMISSIONS.SYSTEM_USER_DELETE))
    .map(([code]) => code)
  assert.deepEqual(withDelete, ['owner'])
})

test('admin 有账号管理但没有角色管理与审计查看', () => {
  assert.ok(ROLE_PERMISSIONS.admin.includes(PERMISSIONS.SYSTEM_USER_MANAGE))
  assert.ok(!ROLE_PERMISSIONS.admin.includes(PERMISSIONS.SYSTEM_ROLE_MANAGE))
  assert.ok(!ROLE_PERMISSIONS.admin.includes(PERMISSIONS.SYSTEM_AUDIT_READ))
})

test('member 只拿到个人工作台权限', () => {
  for (const code of ROLE_PERMISSIONS.member) {
    assert.ok(code.startsWith('personal.'), `member 不该有 ${code}`)
  }
})

test('viewer 拿不到任何写权限', () => {
  for (const code of ROLE_PERMISSIONS.viewer) {
    assert.ok(!code.endsWith('.write'), `viewer 不该有 ${code}`)
  }
})
