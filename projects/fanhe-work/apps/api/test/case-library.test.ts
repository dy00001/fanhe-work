/**
 * 案例库接口的集成测试。
 *
 * 需要真实数据库：这里要验证的东西一半依赖库的真实行为 —— 归属写入靠 where 条件落到
 * SQL 上才算数、事务里「自增修订号 + 写数据」是否原子、软删除后的可见性靠 deletedAt
 * 过滤。用内存替身测这些，测的是替身自己。
 *
 * **案例库是全账号共用一份的**，所以这些用例不能像别的文件那样「每个用例发一个账号，
 * 各玩各的」。做法是给案例库指定一个一次性归属账号（`FANHE_CASE_LIBRARY_ACCOUNT`），
 * 每个用例前把它名下的四张表清空。真实素材库挂在主账号名下，测试碰不到 —— 这一条很
 * 重要：共享之后，用例会移动 `cabinet-1` 这类真实图片，指错账号就是改用户的真实数据。
 *
 * 用 `inject` 驱动完整路由链路（preHandler、schema、序列化）。这些接口的价值有一半在
 * 「绕过前端直接调」这条路径上：跨品类写入、指向不存在的文件夹，都必须由服务端挡住。
 *
 * **修订号是本文件的重点。** 客户端靠它判断「要不要重绘」，判错的表现是「另一台设备
 * 改了、这一台没反应」或者「只读了一次却不停重绘」，两者都不会报错。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, beforeEach, describe, test } from 'node:test'

import { ROLE_CODES, type RoleCode } from '@fanhe/shared'

import type { LightMyRequestResponse } from 'fastify'

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
  /** 一次性账号，只当案例库的归属。没有人用它登录，删掉它等于清空整份测试素材库。 */
  let libraryOwnerId = ''

  before(async () => {
    const role = await prisma.role.findUnique({
      where: { code: ROLE_CODES.MEMBER },
      select: { id: true },
    })
    if (role === null) throw new Error('库里没有 member 角色，先执行 pnpm db:seed')
    roleIds.set(ROLE_CODES.MEMBER, role.id)
    passwordHash = await hashPassword(TEST_PASSWORD)

    /**
     * 案例库已经改成全账号共用一份。**如果不改指归属，这些用例会直接写进真实素材库** ——
     * 它们会建文件夹、还会把 `cabinet-1` 这类真实图片挪来挪去，改掉用户自己整理好的结果。
     *
     * 所以给测试单独指定一个归属账号：它从不登录，只承载测试数据，`after` 删掉它就把
     * 整份测试素材库（四张表）连带清空了。
     */
    const owner = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}case-owner-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
        passwordHash,
        displayName: '案例库归属测试账号',
        roleId: role.id,
      },
      select: { id: true, username: true },
    })
    libraryOwnerId = owner.id
    createdUserIds.push(owner.id)
    process.env.FANHE_CASE_LIBRARY_ACCOUNT = owner.username

    app = buildApp({ logger: false })
  })

  /**
   * 每个用例前清空那份一次性素材库。
   *
   * 库共用之后「上一轮建的文件夹还在」是常态，而下面大部分用例的前提是一个空库（比如
   * 「建文件夹后快照里只有 1 个」）。清理范围严格限定在 `libraryOwnerId` 名下 —— 真实
   * 素材库挂在主账号名下，碰不到。
   */
  beforeEach(async () => {
    await prisma.caseItemPlacement.deleteMany({ where: { userId: libraryOwnerId } })
    await prisma.caseUpload.deleteMany({ where: { userId: libraryOwnerId } })
    await prisma.caseFolder.deleteMany({ where: { userId: libraryOwnerId } })
    await prisma.caseLibraryState.deleteMany({ where: { userId: libraryOwnerId } })
  })

  after(async () => {
    await app.close()
    delete process.env.FANHE_CASE_LIBRARY_ACCOUNT
    if (libraryOwnerId !== '') {
      // 外键是 Cascade，删账号本可连带清掉。这里显式删一次：级联生效与否取决于外键
      // 真的建上了，而「测试留下的数据没清干净」会在下次运行时表现为莫名其妙的计数不符。
      await prisma.caseItemPlacement.deleteMany({ where: { userId: libraryOwnerId } })
      await prisma.caseUpload.deleteMany({ where: { userId: libraryOwnerId } })
      await prisma.caseFolder.deleteMany({ where: { userId: libraryOwnerId } })
      await prisma.caseLibraryState.deleteMany({ where: { userId: libraryOwnerId } })
    }
    if (createdUserIds.length > 0) {
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
    uploads: { itemId: string; categoryId: string; width: number; height: number }[]
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

  test('空库的快照：修订号为 0，四个列表都为空', async () => {
    const { headers } = await signIn()
    const library = await readLibrary(headers)
    assert.equal(library.revision, 0)
    assert.deepEqual(library.folders, [])
    assert.deepEqual(library.placements, [])
    assert.deepEqual(library.uploads, [])
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

  test('别的品类的 itemId 被拒，但把图片挪进别的品类的文件夹是允许的', async () => {
    const { headers } = await signIn()
    const wardrobeLibrary = await createFolder(headers, '长衣区', 'wardrobe')
    const wardrobeFolderId = wardrobeLibrary.folders.find((folder) => folder.name === '长衣区')?.id
    assert.ok(wardrobeFolderId !== undefined)

    // ① itemId 的前缀与 categoryId 不符 —— 这仍然要拒。服务端不掌握前端有哪些图，
    //    能校验的只有「`wardrobe-1` 这种命名属于衣柜」这一条。
    const wrongItem = await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers,
      payload: { categoryId: 'cabinet', itemIds: ['wardrobe-1'], folderId: wardrobeFolderId },
    })
    assert.equal(wrongItem.statusCode, 400)
    assert.equal(wrongItem.json().error, 'invalid_items')

    // ② 图片属于橱柜、目标文件夹属于衣柜 —— 这是**跨品类移动**，2026-10-29 起允许。
    const crossed = await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers,
      payload: { categoryId: 'cabinet', itemIds: ['cabinet-1'], folderId: wardrobeFolderId },
    })
    assert.equal(crossed.statusCode, 200, `跨品类移动应被接受：${crossed.body}`)
    assert.deepEqual((crossed.json().library as Library).placements, [
      { itemId: 'cabinet-1', folderId: wardrobeFolderId },
    ])

    // 归属行的 categoryId 跟目标文件夹走。快照不读它（客户端靠 folderId 反查文件夹），
    // 但库里留一列「这张图属于橱柜」而它正躺在衣柜的文件夹里，会把下一个人带偏。
    const row = await prisma.caseItemPlacement.findFirst({
      // 查归属账号而不是当前登录用户：库是全账号共用的，行落在归属账号名下。
      where: { userId: libraryOwnerId, itemId: 'cabinet-1' },
      select: { categoryId: true },
    })
    assert.equal(row?.categoryId, 'wardrobe')

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

  test('案例库全账号共用：一个人建的文件夹，另一个人看得见也改得动', async () => {
    const first = await signIn()
    const created = await createFolder(first.headers, '主卧灰玻')
    const folderId = created.folders[0]?.id
    assert.ok(folderId !== undefined)

    // 换一个登录用户读同一份库：文件夹在，修订号也一致 —— 「各自一份」已经不存在了。
    const second = await signIn()
    const secondLibrary = await readLibrary(second.headers)
    assert.deepEqual(
      secondLibrary.folders.map((folder) => folder.name),
      ['主卧灰玻'],
    )
    assert.equal(secondLibrary.revision, created.revision)

    // 「编辑」包含改名与移动。只读共享不算共用，这里把两条写路径都走一遍。
    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/cases/folders/${folderId}`,
      headers: second.headers,
      payload: { name: '主卧 灰玻（改）' },
    })
    assert.equal(rename.statusCode, 200, rename.body)
    assert.equal(
      (rename.json().library as Library).folders.find((folder) => folder.id === folderId)?.name,
      '主卧 灰玻（改）',
    )

    const move = await app.inject({
      method: 'PUT',
      url: '/api/cases/placements',
      headers: second.headers,
      payload: { categoryId: 'cabinet', itemIds: ['cabinet-1'], folderId },
    })
    assert.equal(move.statusCode, 200, move.body)

    // 第一个账号回来看到的是第二个人改完的样子。
    const firstLibrary = await readLibrary(first.headers)
    assert.equal(
      firstLibrary.folders.find((folder) => folder.id === folderId)?.name,
      '主卧 灰玻（改）',
    )
    assert.deepEqual(firstLibrary.placements, [{ itemId: 'cabinet-1', folderId }])
  })

  // -------------------------------------------------------------------------
  // 上传图片
  // -------------------------------------------------------------------------
  //
  // 这一组盯的是「字节与归属」两件事同时成立：只存字节不写归属 → 传上去但不显示；
  // 只写归属不存字节 → 界面上是一个永远加载不出来的格子。两者都不会报错。

  /** 1×1 的 PNG。压缩那一层在浏览器里，接口只认字节与魔数。 */
  const PNG_1X1 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

  async function uploadOne(
    headers: { authorization: string },
    overrides: {
      categoryId?: string
      folderId?: string | null
      data?: string
      width?: number
    } = {},
  ): Promise<{
    statusCode: number
    body: string
    headers: Record<string, unknown>
    json: () => { library?: Library; error?: string }
  }> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cases/uploads',
      headers,
      payload: {
        categoryId: overrides.categoryId ?? 'cabinet',
        folderId: overrides.folderId ?? null,
        items: [
          {
            data: overrides.data ?? PNG_1X1,
            thumb: PNG_1X1,
            width: overrides.width ?? 1,
            height: 1,
          },
        ],
      },
    })
    return response
  }

  test('上传：字节入库、快照里多一条、itemId 带品类前缀', async () => {
    const { headers } = await signIn()
    const response = await uploadOne(headers)

    assert.equal(response.statusCode, 201, `上传失败：${response.body}`)
    const library = response.json().library as Library
    assert.equal(library.uploads.length, 1)

    const upload = library.uploads[0]
    assert.ok(upload !== undefined)
    assert.match(upload.itemId, /^cabinet-u[0-9a-f]{32}$/)
    assert.equal(upload.categoryId, 'cabinet')
    assert.equal(upload.width, 1)
    // 上传不是「整理」，但修订号同样要动：另一台设备的图集要能自己刷新出来。
    assert.equal(library.revision, 1)

    // 取图：原图与缩略图都要能拿到，且 content-type 来自魔数而不是客户端声明。
    for (const variant of ['thumb', 'full']) {
      // 显式标注类型：`app` 的类型是从 buildApp 推出来的，而 inject 的返回又指回它，
      // 不标注的话 tsc 会报「image 在自身的初始化里被引用」—— 一个纯推断问题。
      const image: LightMyRequestResponse = await app.inject({
        method: 'GET',
        url: `/api/cases/uploads/${upload.itemId}/${variant}`,
        headers,
      })
      assert.equal(image.statusCode, 200, `取 ${variant} 失败：${image.body}`)
      assert.equal(image.headers['content-type'], 'image/png')
      assert.ok(Number(image.headers['content-length'] ?? 0) > 0)
      // 字节永不变，所以允许浏览器永久缓存 —— 这一条要是丢了，图集每次打开都回源。
      assert.match(String(image.headers['cache-control']), /immutable/)
    }
  })

  test('上传：指定文件夹时直接落进去', async () => {
    const { headers } = await signIn()
    const withFolder = await createFolder(headers, '主卧')
    const folderId = withFolder.folders[0]?.id
    assert.ok(folderId !== undefined)

    const response = await uploadOne(headers, { folderId })
    assert.equal(response.statusCode, 201, `上传失败：${response.body}`)
    const library = response.json().library as Library
    const upload = library.uploads[0]
    assert.ok(upload !== undefined)
    assert.deepEqual(library.placements, [{ itemId: upload.itemId, folderId }])
  })

  test('上传：不是图片的字节被拒（400），空清单被 schema 挡住', async () => {
    const { headers } = await signIn()
    // 一段合法的 base64，但不是任何图片格式 —— 只能靠魔数拦。
    const notImage = Buffer.from('这不是图片，只是一段中文').toString('base64')
    const rejected = await uploadOne(headers, { data: notImage })
    assert.equal(rejected.statusCode, 400, `应当拒绝：${rejected.body}`)
    assert.equal(rejected.json().error, 'invalid_image')

    const empty = await app.inject({
      method: 'POST',
      url: '/api/cases/uploads',
      headers,
      payload: { categoryId: 'cabinet', folderId: null, items: [] },
    })
    assert.equal(empty.statusCode, 400)
  })

  test('上传：目标文件夹属于别的品类时拒绝，不把新图放进没打开过的图集', async () => {
    const { headers } = await signIn()
    const wardrobeFolder = await createFolder(headers, '长衣区', 'wardrobe')
    const folderId = wardrobeFolder.folders[0]?.id
    assert.ok(folderId !== undefined)

    const response = await uploadOne(headers, { folderId })
    assert.equal(response.statusCode, 409, `应当拒绝：${response.body}`)
    assert.equal(response.json().error, 'folder_unavailable')

    // 拒绝之后库里不该留下任何一行 —— 字节与归属在同一个事务里。
    const library = await readLibrary(headers)
    assert.equal(library.uploads.length, 0)
  })

  test('删除上传图：快照里消失，取图变 404，静态图不受影响', async () => {
    const { headers } = await signIn()
    const created = await uploadOne(headers)
    const upload = (created.json().library as Library).uploads[0]
    assert.ok(upload !== undefined)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/cases/uploads/${upload.itemId}`,
      headers,
    })
    assert.equal(removed.statusCode, 200, `删除失败：${removed.body}`)
    assert.equal((removed.json().library as Library).uploads.length, 0)

    const gone = await app.inject({
      method: 'GET',
      url: `/api/cases/uploads/${upload.itemId}/thumb`,
      headers,
    })
    assert.equal(gone.statusCode, 404)

    // 静态清单里的图没有可删的行，删它只能是 404 —— 而不是把别的东西删掉。
    const staticItem = await app.inject({
      method: 'DELETE',
      url: '/api/cases/uploads/cabinet-1',
      headers,
    })
    assert.equal(staticItem.statusCode, 404)
  })

  test('上传图全账号共用：别人也取得到、也删得掉', async () => {
    const uploader = await signIn()
    const colleague = await signIn()
    const created = await uploadOne(uploader.headers)
    const upload = (created.json().library as Library).uploads[0]
    assert.ok(upload !== undefined)

    // 另一个账号的图集里直接就有这张图，不需要「分享」这个动作。
    const colleagueLibrary = await readLibrary(colleague.headers)
    assert.ok(
      colleagueLibrary.uploads.some((item) => item.itemId === upload.itemId),
      '别人的图集里应当能看到这张上传图',
    )

    const peek = await app.inject({
      method: 'GET',
      url: `/api/cases/uploads/${upload.itemId}/full`,
      headers: colleague.headers,
    })
    assert.equal(peek.statusCode, 200, `同事应能取到原图：${peek.body}`)
    assert.equal(peek.headers['content-type'], 'image/png')

    // 未认证仍然 401。共用是「账号内共用」，不是公开 —— 图片是客户家的实景，
    // 不靠「地址猜不到」保护。
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/cases/uploads/${upload.itemId}/full`,
    })
    assert.equal(anonymous.statusCode, 401)

    // 「编辑」包含删除：同事删掉之后，上传者那边也没了。
    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/cases/uploads/${upload.itemId}`,
      headers: colleague.headers,
    })
    assert.equal(remove.statusCode, 200, remove.body)
    const uploaderLibrary = await readLibrary(uploader.headers)
    assert.equal(uploaderLibrary.uploads.filter((item) => item.itemId === upload.itemId).length, 0)
  })
})
