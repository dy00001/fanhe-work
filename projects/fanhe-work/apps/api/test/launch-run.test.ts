/**
 * 启动接口的集成测试，外加代理核心的纯函数测试。
 *
 * 这个文件要验证的东西里，有一半是**安全边界**而不是功能：只认配置 id 不认命令、
 * 来源必须是回环、别人的配置取不到。这些边界的价值全在「绕过前端直接调」这条路径
 * 上，所以一律用 `inject` 走完整路由链路（preHandler、schema、序列化），而不是直接
 * 调 service —— 直接调 service 等于把最有意义的那一段漏掉。
 *
 * 另一半是**真的把进程拉起来**。这里不启动微信（测试机不一定装了，装了也不该在跑
 * 测试时弹窗），而是用当前这个 Node 可执行文件加 `-e` 让它立刻退出：要验证的是
 * 「我们交给操作系统的命令与参数是对的」，而不是「某个具体客户端能被拉起」。
 * 后者属于手工验收，见 DEVELOPMENT-PLAN 的阶段三出口条件。
 */

import './test-env.js'

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'

import { ROLE_CODES, type RoleCode } from '@fanhe/shared'

import { resolveTestDatabaseUrl, TEST_DATA_PREFIX } from './helpers/db.js'

// test-env.ts 已经把 DATABASE_URL 指向一个不可达地址，这里在 env.ts 被求值之前
// 换回真实值。下面一律用动态 import，静态 import 会被提升到本段之前执行。
const databaseUrl = resolveTestDatabaseUrl()
if (databaseUrl !== null) {
  process.env.DATABASE_URL = databaseUrl
}

const { isLoopbackAddress } = await import('../src/launch/loopback.js')
const { buildLaunchCommand, buildLaunchEnv, needsHiddenConsole, shouldStripFromLaunchEnv } =
  await import('../src/launch/agent.js')
const { prisma } = await import('../src/db/prisma.js')
const { hashPassword } = await import('../src/auth/password.js')
const { login } = await import('../src/auth/login.js')
const { buildApp } = await import('../src/app.js')

const TEST_PASSWORD = 'integration-test-password'
/** RFC 5737 的 TEST-NET-2 段。本文件独占一个地址，清理时能精确圈定。 */
const TEST_IP = '198.51.100.41'
/** 一个非回环的地址，用来验证来源判定。 */
const REMOTE_IP = '203.0.113.7'

/**
 * 一个真实存在的可执行文件：跑测试的这个 Node 自己。
 *
 * 用它而不是 `cmd.exe` 之类，是因为它跨平台且一定存在 —— 测试跑起来就证明它在。
 */
const NODE_PATH = process.execPath
/** 一个存在但**不是**可执行文件的路径。用来触发进程创建失败。 */
const NON_EXECUTABLE_PATH = fileURLToPath(new URL('../package.json', import.meta.url))

// ---------------------------------------------------------------------------
// 纯函数。不依赖数据库，因此不随集成测试一起跳过。
// ---------------------------------------------------------------------------

describe('回环来源判定', () => {
  test('三种回环写法都认', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true)
    assert.equal(isLoopbackAddress('::1'), true)
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  })

  test('整个 127.0.0.0/8 段都算回环', () => {
    // RFC 1122 把整段定义为回环，Windows 与 Linux 都默认把整段指向 lo。
    // 只认 127.0.0.1 会在有人用 127.0.0.2 访问时误判成远程。
    assert.equal(isLoopbackAddress('127.0.0.2'), true)
    assert.equal(isLoopbackAddress('127.255.255.254'), true)
  })

  test('局域网与公网地址一律判否', () => {
    assert.equal(isLoopbackAddress('192.168.1.10'), false)
    assert.equal(isLoopbackAddress('10.0.0.1'), false)
    assert.equal(isLoopbackAddress('203.0.113.7'), false)
    assert.equal(isLoopbackAddress('::ffff:192.168.1.10'), false)
    assert.equal(isLoopbackAddress('::2'), false)
  })

  test('畸形地址判否，不因为「看着像」就放过', () => {
    // 这条函数是安全边界。边界上的宽松判断等于没有判断：1271.0.0.1 的前缀里
    // 有 "127"，127.0.0.abc 看着也像回环，但两者都不是合法地址。
    assert.equal(isLoopbackAddress('127.0.0.1.5'), false)
    assert.equal(isLoopbackAddress('127.0.0.abc'), false)
    assert.equal(isLoopbackAddress('1271.0.0.1'), false)
    assert.equal(isLoopbackAddress('127.0.0.256'), false)
  })

  test('拿不到地址时判否', () => {
    // 默认放行的那一侧永远是错的一侧。
    assert.equal(isLoopbackAddress(undefined), false)
    assert.equal(isLoopbackAddress(''), false)
  })
})

describe('启动命令组装', () => {
  const baseProfile = {
    id: 'profile-1',
    software: 'wechat',
    name: '微信 · 工作号',
    executablePath: 'C:\\Program Files\\Tencent\\WeChat\\WeChat.exe',
    args: ['--multi-instance', ''],
    icon: null,
    sortOrder: 0,
    createdAt: '2026-10-11T00:00:00.000Z',
    updatedAt: '2026-10-11T00:00:00.000Z',
  }

  test('命令取可执行文件路径，参数原样透传', () => {
    const command = buildLaunchCommand(baseProfile)
    assert.equal(command.command, baseProfile.executablePath)
    // 空串参数必须活到最后一刻：它表示一个显式的空参数，过滤掉会改变命令行。
    assert.deepEqual(command.args, ['--multi-instance', ''])
  })

  test('工作目录取可执行文件所在目录', () => {
    const command = buildLaunchCommand(baseProfile)
    assert.equal(command.cwd, 'C:\\Program Files\\Tencent\\WeChat')
  })

  test('返回的数组是副本，改它不会影响配置对象', () => {
    const profile = { ...baseProfile, args: ['--a'] }
    const command = buildLaunchCommand(profile)
    command.args.push('--b')
    assert.deepEqual(profile.args, ['--a'])
  })
})

/**
 * 控制台窗口的显隐。
 *
 * 这一条钉的是两个相反方向的坏法：GUI 客户端被隐藏启动 → 点了没反应（spawn 仍报成功）；
 * 脚本被可见启动 → 闪黑框。判据只能按扩展名分，用例把两侧都固定住。
 */
describe('needsHiddenConsole（控制台窗口显隐）', () => {
  test('GUI 客户端（.exe）不隐藏，否则主窗口可能一起被藏起来', () => {
    assert.equal(needsHiddenConsole('C:\\Program Files\\Tencent\\QQNT\\QQ.exe'), false)
    assert.equal(needsHiddenConsole('D:\\Apps\\AliWorkbench\\AliWorkbench.exe'), false)
  })

  test('扩展名大小写不影响判定', () => {
    assert.equal(needsHiddenConsole('D:\\Apps\\Foo.EXE'), false)
    assert.equal(needsHiddenConsole('D:\\Scripts\\Run.CMD'), true)
  })

  test('脚本与批处理必须隐藏，否则会闪一个黑框', () => {
    assert.equal(needsHiddenConsole('D:\\Scripts\\launch.cmd'), true)
    assert.equal(needsHiddenConsole('D:\\Scripts\\launch.bat'), true)
    assert.equal(needsHiddenConsole('D:\\Scripts\\launch.ps1'), true)
  })

  test('无扩展名按脚本处理（保守：宁可隐藏，不闪窗）', () => {
    assert.equal(needsHiddenConsole('D:\\Tools\\run'), true)
  })
})

/**
 * 交给被启动客户端的环境。
 *
 * 钉的是真机事故：宿主注入的 `NODE_OPTIONS=--require=<fs 劫持 shim>` 被原样传给客户端，
 * 而 Electron 系的客户端（QQNT）会执行 `--require`，启动即崩。这几条用例守住「注入通道
 * 一律剔掉、普通变量一律保留」这条边界。
 */
describe('buildLaunchEnv（交给被启动客户端的环境）', () => {
  test('剔掉 Node 的代码注入入口', () => {
    assert.equal(shouldStripFromLaunchEnv('NODE_OPTIONS'), true)
    assert.equal(shouldStripFromLaunchEnv('NODE_PATH'), true)
    assert.equal(shouldStripFromLaunchEnv('NODE_REPL_EXTERNAL_MODULE'), true)
  })

  test('剔掉所有 ELECTRON_ 前缀的运行控制开关', () => {
    assert.equal(shouldStripFromLaunchEnv('ELECTRON_RUN_AS_NODE'), true)
    assert.equal(shouldStripFromLaunchEnv('ELECTRON_NO_ATTACH_CONSOLE'), true)
    // 前缀判定不误伤「只是名字里含 electron」的普通变量。
    assert.equal(shouldStripFromLaunchEnv('MY_ELECTRON_THING'), false)
  })

  test('真机事故复现：--require 注入被剔掉，普通变量照常保留', () => {
    const env = buildLaunchEnv({
      NODE_OPTIONS: '--require="D:/host/shim/node-language-shim.cjs"',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'C:\\Windows',
      APPDATA: 'C:\\Users\\x\\AppData\\Roaming',
      TEMP: 'C:\\Temp',
      SystemRoot: 'C:\\Windows',
    })
    assert.equal('NODE_OPTIONS' in env, false, '注入通道必须被剔掉')
    assert.equal('ELECTRON_RUN_AS_NODE' in env, false)
    // 客户端要用的系统变量一个都不能少，否则「某些机器上点启动没反应」。
    assert.equal(env.PATH, 'C:\\Windows')
    assert.equal(env.APPDATA, 'C:\\Users\\x\\AppData\\Roaming')
    assert.equal(env.TEMP, 'C:\\Temp')
    assert.equal(env.SystemRoot, 'C:\\Windows')
  })

  test('不改动入参对象（不就地删调用方的 process.env）', () => {
    const source: NodeJS.ProcessEnv = { NODE_OPTIONS: '--require=x', PATH: 'p' }
    const env = buildLaunchEnv(source)
    assert.equal(source.NODE_OPTIONS, '--require=x', '源对象不该被改动')
    assert.equal('NODE_OPTIONS' in env, false)
  })
})

// ---------------------------------------------------------------------------
// 集成测试
// ---------------------------------------------------------------------------

async function databaseReachable(): Promise<boolean> {
  if (databaseUrl === null) {
    return false
  }
  try {
    await prisma.$queryRaw`SELECT 1`
    return true
  } catch {
    return false
  }
}

const reachable = await databaseReachable()

if (!reachable) {
  // 必须显式出声。describe 的 skip 只会让整个 suite 从统计里消失，总数变少而
  // skipped 与 fail 都是 0，输出全绿。静默跳过会把「没跑」显示成「跑过了」。
  console.warn('[launch-run.test] 数据库不可达，启动接口的集成测试未执行')
}

describe('启动接口', { skip: reachable ? false : '数据库不可达，跳过集成测试' }, () => {
  const createdUserIds: string[] = []
  const roleIds = new Map<RoleCode, string>()
  let passwordHash = ''
  let app: ReturnType<typeof buildApp>

  before(async () => {
    for (const code of [ROLE_CODES.MEMBER, ROLE_CODES.VIEWER]) {
      const role = await prisma.role.findUnique({ where: { code }, select: { id: true } })
      if (role === null) {
        throw new Error(`库里没有 ${code} 角色，先执行 pnpm db:seed`)
      }
      roleIds.set(code, role.id)
    }
    passwordHash = await hashPassword(TEST_PASSWORD)
    app = buildApp({ logger: false })
  })

  after(async () => {
    await app.close()
    if (createdUserIds.length > 0) {
      await prisma.launchProfile.deleteMany({ where: { userId: { in: createdUserIds } } })
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } })
    }
    // 本文件用 login 取令牌，会顺带写入登录尝试与审计。
    await prisma.loginAttempt.deleteMany({ where: { ip: TEST_IP } })
    await prisma.auditLog.deleteMany({ where: { ip: TEST_IP } })
    await prisma.$disconnect()
  })

  /** 建一个指定角色的账号并登录，返回访问令牌。 */
  async function signIn(roleCode: RoleCode): Promise<{ userId: string; token: string }> {
    const roleId = roleIds.get(roleCode)
    if (roleId === undefined) {
      throw new Error(`未知角色：${roleCode}`)
    }

    const user = await prisma.user.create({
      data: {
        username: `${TEST_DATA_PREFIX}${randomUUID().replaceAll('-', '').slice(0, 20)}`,
        passwordHash,
        displayName: '启动接口测试',
        roleId,
      },
      select: { id: true, username: true },
    })
    createdUserIds.push(user.id)

    const result = await login({ username: user.username, password: TEST_PASSWORD, ip: TEST_IP })
    if (!result.ok) {
      throw new Error(`测试账号登录失败：${result.reason}`)
    }
    return { userId: user.id, token: result.data.accessToken }
  }

  function authHeader(token: string): { authorization: string } {
    return { authorization: `Bearer ${token}` }
  }

  /** 建一条配置，返回它的 id。路径默认用当前这个 Node。 */
  async function createProfile(
    token: string,
    executablePath: string = NODE_PATH,
    args: readonly string[] = ['-e', 'process.exit(0)'],
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/launch/profiles',
      headers: authHeader(token),
      payload: {
        software: 'custom',
        name: `启动测试 ${randomUUID().slice(0, 8)}`,
        executablePath,
        args,
      },
    })
    assert.equal(response.statusCode, 201, `建配置失败：${response.body}`)
    return response.json().profile.id
  }

  test('未认证时返回 401', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${randomUUID()}/run`,
    })
    assert.equal(response.statusCode, 401)
    assert.equal(response.json().error, 'unauthorized')
  })

  test('只读访客不能启动', async () => {
    const { token } = await signIn(ROLE_CODES.VIEWER)
    const response = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${randomUUID()}/run`,
      headers: authHeader(token),
    })
    // 403 而不是 404：这里被挡下的是「这个角色没有写权限」，与「配置存不存在」无关。
    assert.equal(response.statusCode, 403)
    assert.equal(response.json().error, 'forbidden')
  })

  test('启动成功，返回进程 id', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const id = await createProfile(token)

    const response = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${id}/run`,
      headers: authHeader(token),
    })
    assert.equal(response.statusCode, 200, `启动失败：${response.body}`)

    const body = response.json()
    assert.equal(body.profileId, id)
    assert.ok(Number.isInteger(body.pid) && body.pid > 0, `pid 不合法：${body.pid}`)
    assert.equal(body.deduplicated, false)
    // 时间是 ISO 串，不是数字时间戳：跨进程的 JSON 里没有 Date 类型。
    assert.match(body.startedAt, /^\d{4}-\d{2}-\d{2}T/)
  })

  test('去重窗口内的重复请求不再创建进程', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const id = await createProfile(token)
    const headers = authHeader(token)

    const first = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${id}/run`,
      headers,
    })
    assert.equal(first.statusCode, 200)

    // 紧接着再点一次。两次之间没有等待，一定落在 3 秒窗口内 —— 这条断言依赖的
    // 就是这个窗口，所以两次请求必须在同一个用例里连着发，不能拆成两个用例。
    const second = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${id}/run`,
      headers,
    })
    assert.equal(second.statusCode, 200)

    const firstBody = first.json()
    const secondBody = second.json()
    assert.equal(secondBody.deduplicated, true, '第二次请求应当命中去重窗口')
    assert.equal(secondBody.pid, firstBody.pid, '去重时应当沿用第一次的进程 id')
    assert.equal(secondBody.startedAt, firstBody.startedAt)
  })

  test('路径不存在时返回 409 并指出是文件的问题', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    // 形态合法（绝对路径）所以能存进去，但文件不在。这正是「配置建好之后软件被
    // 卸载」那种情形：入库时只能校验形态，存在性要到启动这一刻才知道。
    const missing = join(dirname(NODE_PATH), `zz-not-here-${randomUUID()}.exe`)
    const id = await createProfile(token, missing)

    const response = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${id}/run`,
      headers: authHeader(token),
    })
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error, 'executable_missing')
  })

  test('路径指向目录时同样按文件问题处理', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const id = await createProfile(token, dirname(NODE_PATH))

    const response = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${id}/run`,
      headers: authHeader(token),
    })
    // 复制路径时选到文件夹是很常见的错误，它与「文件不存在」在用户看来是同一件事：
    // 路径不对，去改。
    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error, 'executable_missing')
  })

  test('文件存在但不是可执行程序时返回 500', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    // 一个真实存在、且确实是文件、但操作系统无法执行的路径（JSON 文本）。
    // 进程创建会失败，而失败通过 error 事件异步到达 —— 这条用例真正验证的是
    // 「我们等到了那个事件」，而不是 spawn 一返回就报成功。
    const id = await createProfile(token, NON_EXECUTABLE_PATH, [])

    const response = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${id}/run`,
      headers: authHeader(token),
    })
    assert.equal(response.statusCode, 500)
    assert.equal(response.json().error, 'spawn_failed')
  })

  test('非回环来源一律按配置不存在处理', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const id = await createProfile(token)

    const response = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${id}/run`,
      headers: authHeader(token),
      remoteAddress: REMOTE_IP,
    })
    // 404 而不是 403：403 等于向远程探测者确认「这个端点存在，只是不给你用」。
    // 与「配置真的不存在」共用同一个响应，两者从外面看不出区别。
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error, 'not_found')
  })

  test('别人的配置取不到', async () => {
    const owner = await signIn(ROLE_CODES.MEMBER)
    const other = await signIn(ROLE_CODES.MEMBER)
    const id = await createProfile(owner.token)

    const response = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${id}/run`,
      headers: authHeader(other.token),
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error, 'not_found')
  })

  test('不存在的配置 id 返回 404', async () => {
    const { token } = await signIn(ROLE_CODES.MEMBER)
    const response = await app.inject({
      method: 'POST',
      url: `/api/launch/profiles/${randomUUID()}/run`,
      headers: authHeader(token),
    })
    assert.equal(response.statusCode, 404)
    assert.equal(response.json().error, 'not_found')
  })
})
