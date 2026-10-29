/**
 * 案例库接口的集成测试。
 *
 * 需要真实数据库：这里要验证的东西一半依赖库的真实行为 —— 归属隔离靠 where 条件落到
 * SQL 上才算数、事务里「自增修订号 + 写数据」是否原子、软删除后的可见性靠 deletedAt
 * 过滤。用内存替身测这些，测的是替身自己。
 *
 * 用 `inject` 驱动完整路由链路（preHandler、schema、序列化）。这些接口的价值有一半在
 * 「绕过前端直接调」这条路径上：跨品类写入、越权访问别人文件夹，都必须由服务端挡住。
 *
 * **修订号是本文件的重点。** 客户端靠它判断「要不要重绘」，判错的表现是「另一台设备
 * 改了、这一台没反应」或者「只读了一次却不停重绘」，两者都不会报错。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'

import { ROLE_CODES, type RoleCode } from '@fanhe/shared'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

// test-env.ts 已经把 DATABASE_URL 指向一个不可达地址，这里在 env.ts 被求值之前换回
// 真实值。下面一律用动态 import，静态 import 会被提升到本段之前执行。
const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
/** RFC 5737 的 TEST-NET-2 段。本文件独占一个地址，清理时能精确圈定。 */
const TEST_IP = '198.51.100.44'

async function databaseReachable(): Promise<boolean> {
  if (databaseUrl === null) return false
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

const reachable = await databaseReachable()

if (!reachable) {
  // 必须显式出声。静默跳过会把「没跑」显示成「跑过了」。
  console.warn('[case-library.test] 数据库不可达，案例库接口的集成测试未执行')
}

describe('案例库接口', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  const roleIds = new Map<RoleCode, string>()
  let passwordHash = ''
  let app: ReturnType<typeof buildApp>

  before(async () => {
    const role = await prisma.role.findUnique({
      where: { code: ROLE_CODES.MEMBER },
      select: { id: true },
    })
    if (role === null) throw new Error('库里没有 member 角色，先执行 pnpm db:seed')
    roleIds.set(ROLE_CODES.MEMBER, role.id)
    passwordHash = await hashPassword(TEST_PASSWORD)
    app = buildApp({ logger: false })
  })

  after(async () => {
    await app.close()
    if (createdUserIds.length > 0) {
      // 外键是 Cascade，删账号本可连带清掉。这里显式删一次：级联生效与否取决于外键
      // 真的建上了，而「测试留下的数据没清干净」会在下次运行时表现为莫名其妙的计数不符。
      await prisma.caseItemPlacement.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.caseFolder.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.caseLibraryState.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
  })

  async function signIn(): Promise<{ userId: string; headers: { authorization: string } }> {
    const roleId = roleIds.get(ROLE_CODES.MEMBER)
    if (roleId === undefined) throw new Error('roleId 未初始化')
    const user = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        passwordHash,
        displayName: '案例库测试',
        roleId,
      },
      select: { id: true, username: true },
    })
    createdUserIds.push(user.id)

    const result = await login({ username: user.username, password: TEST_PASSWORD, ip: TEST_IP })
    if (!result.ok) throw new Error(`测试账号登录失败：${result.reason}`)
    return { userId: user.id, headers: { authorization: `Bearer ${result.data.accessToken}` } }
  }

  type Library = {
    revision: number
    folders: { id: string; categoryId: string; name: string }[]
    placements: { itemId: string; folderId: string | null }[]
  }

  async function readLibrary(headers: { authorization: string }): Promise<Library> {
    const response = await app.inject({ method: 'GET', url: '/api/cases/library', headers })
    assert.equal(response.statusCode, 200, `读案例库失败：${response.body}`)
    return response.json().library as Library
  }

  async function createFolder(
    headers: { authorization: string },
    name: string,
    categoryId = 'cabinet',
  ): Promise<Library> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cases/folders',
      headers,
      payload: { categoryId, name },
    })
    assert.equal(response.statusCode, 201, `建文件夹失败：${response.body}`)
    return response.json().library as Library
  }

  test('未认证时返回 401', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/cases/library' })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'unauthorized')
  })

  test('新账号的快照是空的，修订号为 0', async () => {
    const { headers } = await signIn()
    const library = await readLibrary(headers)
    assert.equal(library.revision, 0)
    assert.deepEqual(library.folders, [])
    assert.deepEqual(library.placements, [])
  })

  test('建文件夹：落库、修订号自增、名字被归一', async () => {
    const { headers } = await signIn()
    const library = await createFolder(headers, '  主卧   灰玻  ')

    assert.equal(library.revision, 1)
    assert.equal(library.folders.length, 1)
    assert.equal(library.folders[0]?.name, '主卧 灰玻')
    assert.equal(library.folders[0]?.categoryId, 'cabinet')
  })

  test('同品类重名返回 409，改名后的重名同样被拒', async () => {
    const { headers } = await signIn()
    const first = await createFolder(headers, '客厅')
    const folderId = first.folders[0]?.id
    assert.ok(folderId !== undefined)

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/cases/folders',
      headers,
      payload: { categoryId: 'cabinet', name: '客厅' },
    })
    assert.equal(duplicate.statusCode, 409)
    assert.equal(duplicate.json().error, 'duplicate_name')

    // 别的品类下同名是允许的 —— 重名判断按品类分组。
    const otherCategory = await createFolder(headers, '客厅', 'wardrobe')
    assert.equal(otherCategory.folders.length, 2)

    // 按品类 + 名字定位，不按下标：快照里的顺序是 createdAt，前面已经插了一个别的品类的
    // 同名文件夹，用下标会拿到 wardrobe 的那个，改名自然不冲突（测试自己假红）。
    const second = await createFolder(headers, '玄关')
    const target = second.folders.find(
      (folder) => folder.categoryId === 'cabinet' && folder.name === '玄关',
    )
    assert.ok(target !== undefined, '没找到刚建的「玄关」文件夹')
    const clash = await app.inject({
      method: 'PATCH',
      url: `/api/cases/folders/${target.id}`,
      headers,
      payload: { name: '客厅' },
    })
    assert.equal(clash.statusCode, 409, `改成重名应被拒：${clash.body}`)
    assert.equal(clash.json().error, 'duplicate_name')

    // 别的品类的同名文件夹不受影响，也没被改掉。
    const wardrobe = await readLibrary(headers)
    assert.equal(
      wardrobe.folders.filter(
        (folder) => folder.name === '客厅' && folder.categoryId === 'wardrobe',
      ).length,
      1,
    )
  })

  test('空白名与不存在的品类分别返回 400', async () => {
    const { headers } = await signIn()
    const blank = await app.inject({
      method: 'POST',
      url: '/api/cases/folders',
      headers,
      payload: { categoryId: 'cabinet', name: '     ' },
    })
    assert.equal(blank.statusCode, 400)
    assert.equal(blank.json().error, 'invalid_name')

    const badCategory = await app.inject({
      method: 'POST',
      url: '/api/cases/folders',
      headers,
      payload: { categoryId: 'bedroom', name: '主卧' },
    })
    assert.equal(badCategory.statusCode, 400)
    assert.equal(badCategory.json().error, 'invalid_category')
  })

  test('移动：写入归属并自增修订号；移出即删除归属行', async () => {
    const { headers } = await signIn()
    const created = await createFolder(headers, '主卧灰玻')
    const folderId = created.folders[0]?.id
    assert.ok(folderId !== undefined)
    assert.equal(created.revision, 1)

    const moved = await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers,
      payload: { categoryId: 'cabinet', itemIds: ['cabinet-1', 'cabinet-2'], folderId },
    })
    assert.equal(moved.statusCode, 200, moved.body)
    const afterMove = moved.json().library as Library
    assert.equal(afterMove.revision, 2)
    assert.deepEqual(
      [...afterMove.placements].sort((left, right) => left.itemId.localeCompare(right.itemId)),
      [
        { itemId: 'cabinet-1', folderId },
        { itemId: 'cabinet-2', folderId },
      ],
    )

    // 幂等：同一请求再发一次，归属不变、修订号仍然加一（它记录的是「改过一次」，
    // 不是「内容变过」——客户端拿它当「要不要重取」的信号，多取一次无害）。
    const again = await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers,
      payload: { categoryId: 'cabinet', itemIds: ['cabinet-1'], folderId },
    })
    assert.equal(again.statusCode, 200)
    assert.equal((again.json().library as Library).placements.length, 2)

    const removed = await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers,
      payload: { categoryId: 'cabinet', itemIds: ['cabinet-1', 'cabinet-2'], folderId: null },
    })
    assert.equal(removed.statusCode, 200)
    assert.deepEqual((removed.json().library as Library).placements, [])
  })

  test('跨品类的图片、以及不存在的文件夹都被拒', async () => {
    const { headers } = await signIn()
    const created = await createFolder(headers, '主卧灰玻')
    const folderId = created.folders[0]?.id
    assert.ok(folderId !== undefined)

    const crossed = await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers,
      payload: { categoryId: 'cabinet', itemIds: ['wardrobe-1'], folderId },
    })
    assert.equal(crossed.statusCode, 400)
    assert.equal(crossed.json().error, 'invalid_items')

    // 目标文件夹在别的设备上被删掉的情形：不是 404，而是 409 —— 请求本身合法，
    // 只是与当前状态冲突，界面应当重取快照再让用户重选。
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers,
      payload: { categoryId: 'cabinet', itemIds: ['cabinet-1'], folderId: randomUUID() },
    })
    assert.equal(missing.statusCode, 409)
    assert.equal(missing.json().error, 'folder_unavailable')
  })

  test('删文件夹：文件夹消失，里面的图片回到未归档', async () => {
    const { headers } = await signIn()
    const created = await createFolder(headers, '主卧灰玻')
    const folderId = created.folders[0]?.id
    assert.ok(folderId !== undefined)

    await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers,
      payload: { categoryId: 'cabinet', itemIds: ['cabinet-1', 'cabinet-2'], folderId },
    })

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/cases/folders/${folderId}`,
      headers,
    })
    assert.equal(deleted.statusCode, 200, deleted.body)
    const library = deleted.json().library as Library
    assert.deepEqual(library.folders, [])
    // 关键：图片没有被删掉，只是不再属于任何文件夹。
    assert.deepEqual(library.placements, [])

    // 重复删除是 404（文件夹已经不在）。界面据此把那个筛选条件退回去。
    const again = await app.inject({
      method: 'DELETE',
      url: `/api/cases/folders/${folderId}`,
      headers,
    })
    assert.equal(again.statusCode, 404)
  })

  test('删掉文件夹后可以再建同名的一个（软删除不与唯一性打架）', async () => {
    const { headers } = await signIn()
    const first = await createFolder(headers, '客厅')
    const folderId = first.folders[0]?.id
    assert.ok(folderId !== undefined)
    await app.inject({ method: 'DELETE', url: `/api/cases/folders/${folderId}`, headers })

    const second = await createFolder(headers, '客厅')
    assert.equal(second.folders.length, 1)
    assert.notEqual(second.folders[0]?.id, folderId)
  })

  test('账号之间互不可见，也改不动别人的文件夹', async () => {
    const owner = await signIn()
    const created = await createFolder(owner.headers, '主卧灰玻')
    const folderId = created.folders[0]?.id
    assert.ok(folderId !== undefined)

    const stranger = await signIn()
    const strangerLibrary = await readLibrary(stranger.headers)
    assert.deepEqual(strangerLibrary.folders, [])
    assert.equal(strangerLibrary.revision, 0)

    // 拿别人的 id 去改名 / 删除 / 移动，一律 404 —— 用 403 等于确认「这个 id 存在」。
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/cases/folders/${folderId}`,
      headers: stranger.headers,
      payload: { name: '抢过来' },
    })
    assert.equal(rename.statusCode, 404)

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/cases/folders/${folderId}`,
      headers: stranger.headers,
    })
    assert.equal(remove.statusCode, 404)

    // 别人的文件夹也不能当移动目标。
    const move = await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers: stranger.headers,
      payload: { categoryId: 'cabinet', itemIds: ['cabinet-1'], folderId },
    })
    assert.equal(move.statusCode, 409)

    // 原主人的数据完好无损。
    const ownerLibrary = await readLibrary(owner.headers)
    assert.equal(ownerLibrary.folders[0]?.name, '主卧灰玻')
  })
})
