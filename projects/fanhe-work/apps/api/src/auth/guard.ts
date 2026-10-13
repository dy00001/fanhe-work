import {
  ALL_PERMISSIONS,
  hasPermission,
  mergePermissions,
  ROLE_CODES,
  type PermissionCode,
} from '@fanhe/shared'
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify'

import { prisma } from '../db/prisma.js'
import { isStaleByPasswordChange, verifyAccessToken } from './tokens.js'

/**
 * 服务端的认证与授权守卫。
 *
 * 分成两步，职责不重叠。**认证**回答「你是谁」，只解析访问令牌并确认账号可用。
 * **授权**回答「你能不能做这件事」，在认证结果之上比对权限点。
 *
 * 权限校验只能发生在服务端。前端的菜单隐藏与按钮禁用承担的是体验职责，任何人
 * 改一个请求就能绕过。两边的权限点取自同一份常量（`@fanhe/shared`），但只有
 * 服务端这一步是强制的。
 */

export type AuthContext = {
  userId: string
  username: string
  displayName: string
  roleCode: string
  /** 角色 code 的层级。账号管理用它判定「能不能操作这个账号」。 */
  roleRank: number
  permissions: readonly PermissionCode[]
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * 当前请求的认证结果。null 表示未认证，由守卫在解析成功后写入。
     *
     * 用 null 而不是 undefined 作为初值，是因为 Fastify 的 decorateRequest
     * 需要一个确定的默认值，而 undefined 在序列化与判空上更容易被误判。
     */
    authContext: AuthContext | null
  }
}

/**
 * 挂上认证结果的容器。必须在注册任何使用守卫的路由之前调用。
 *
 * Fastify 要求自定义属性通过 decorateRequest 声明，直接往 request 上赋值会
 * 绕开它对该对象的形状优化。
 */
export function registerAuthSupport(app: FastifyInstance): void {
  app.decorateRequest('authContext', null)
}

const KNOWN_PERMISSIONS = new Set<string>(ALL_PERMISSIONS)

/**
 * 把库里的权限码收窄成已知的权限点。
 *
 * 库里可能存在清单里已经删掉的权限点，例如权限清单调整后种子还没重跑。这些码
 * 在精确匹配下本来也命中不了任何 required，把它们过滤掉是为了让「权限只能来自
 * 这份清单」在类型层面也成立，而不是靠调用方自觉。
 */
function toPermissionCodes(codes: readonly string[]): PermissionCode[] {
  return codes.filter((code): code is PermissionCode => KNOWN_PERMISSIONS.has(code))
}

/**
 * 算出一个账号最终持有的权限点。
 *
 * 三部分合并：角色自带的、账号级授予的、账号级拒绝的。合并规则见共享包的
 * mergePermissions —— 拒绝优先于授予。
 *
 * **owner 短路返回全部权限点，不查 user_permissions。** 这让「owner 不可降权」
 * 成为服务端的一条硬规则：即便有人往 owner 的 user_permissions 里写了 denied 行，
 * 也不生效。想给 owner 降权的人看到的是静默无效 —— 那正是应该的，owner 是这个
 * 系统最后的入口，降权它等于把自己锁在外面，而这类操作只有误操作一种成因，
 * 不该有成功的路径。
 *
 * 短路同时省掉 owner 每次请求的一次查询。
 */
async function resolvePermissions(
  userId: string,
  roleCode: string,
  rolePermissions: readonly string[],
): Promise<PermissionCode[]> {
  if (roleCode === ROLE_CODES.OWNER) {
    return [...ALL_PERMISSIONS]
  }

  const overrides = await prisma.userPermission.findMany({
    where: { userId },
    select: { granted: true, permission: { select: { code: true } } },
  })

  const granted: PermissionCode[] = []
  const denied: PermissionCode[] = []
  for (const row of overrides) {
    // 过滤未知码的理由与 toPermissionCodes 相同：库里可能残留权限清单里已删掉的
    // 权限点，它们在精确匹配下本来就命中不了任何 required，但留着会让「这个账号
    // 持有哪些权限」的展示凭空多出几项。
    const code = toPermissionCodes([row.permission.code])[0]
    if (code === undefined) continue
    if (row.granted) granted.push(code)
    else denied.push(code)
  }

  return mergePermissions(toPermissionCodes(rolePermissions), granted, denied)
}

/**
 * 解析访问令牌，加载账号与权限。
 *
 * **每次请求都查库，不做缓存。** 访问令牌本身是无状态的，但授权必须有状态：
 * 权限点不放进令牌，否则改了角色授权后旧令牌仍带着旧权限，要等它过期才生效，
 * 而撤权需要立刻生效。加一层缓存会把这条保证退化成「最多延迟 N 秒」，且延迟
 * 长短取决于缓存是否命中，排查时看不出来。将来真要优化，正确做法是给角色加
 * 版本号、在授权变更时递增，而不是给缓存设一个拍脑袋的 TTL。
 *
 * 账号级权限覆盖让这条保证多了一个好处：调整某个账号的权限在**下一次请求**就
 * 生效，不需要等令牌过期，也不需要前端重新拉 /me 才能让服务端放行。
 *
 * 既然这趟查询本来就要做，顺带把 status 与 deletedAt 读出来。账号被停用或
 * 删除后，已经签发的访问令牌立刻失效，不必等它自然过期。
 */
async function resolveAuthContext(request: FastifyRequest): Promise<AuthContext | null> {
  const header = request.headers.authorization
  if (header === undefined || !header.startsWith('Bearer ')) {
    return null
  }

  const token = header.slice('Bearer '.length).trim()
  if (token === '') {
    return null
  }

  const claims = await verifyAccessToken(token)
  if (claims === null) {
    return null
  }

  // claims.sub 来自我们自己签发的令牌，签名校验已经保证了它的来源，因此不必
  // 担心它不是一个合法的 UUID。若在这里加一层格式判断，掩盖的是「签名校验被
  // 绕过」这种更严重的问题。
  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      username: true,
      displayName: true,
      status: true,
      deletedAt: true,
      // 用来判断这个令牌是不是改密之前签发的。**加这一列不新增查库** ——
      // 这一行查询本来就在，守卫每个请求都要读用户，只是多取一个字段。
      passwordChangedAt: true,
      role: {
        select: {
          code: true,
          rank: true,
          rolePermissions: {
            where: { permission: { deletedAt: null } },
            select: { permission: { select: { code: true } } },
          },
        },
      },
    },
  })

  if (user === null || user.deletedAt !== null || user.status !== 'active') {
    return null
  }

  // 改密之后，此前签发的访问令牌一律失效。
  //
  // **为什么不靠撤销刷新令牌来实现：** 撤销只能让「下一次刷新」拿不到新令牌，
  // 而手里那张访问令牌还能继续用到它自然过期（默认 15 分钟）。用户在另一台设备
  // 上改密，本机这一台仍然畅通无补 —— 那正是改密要解决的情形。
  //
  // **为什么不直接只比时间戳：** 见 isStaleByPasswordChange 的注释，`null`
  // 与「有值」之间的比较规则不能简化成相等。
  if (isStaleByPasswordChange(claims, user.passwordChangedAt)) {
    return null
  }

  const rolePermissions = user.role.rolePermissions.map((row) => row.permission.code)

  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    roleCode: user.role.code,
    roleRank: user.role.rank,
    permissions: await resolvePermissions(user.id, user.role.code, rolePermissions),
  }
}

/**
 * 取当前请求的认证结果，同一次请求内只查一次库。
 *
 * 失败不写入缓存，因此同一请求内若有多个守卫，未认证时可能重复查库。这条路径
 * 上第一个守卫就已经返回 401，重复只发生在「一个路由挂了多个守卫且请求未认证」
 * 这个罕见组合里，为它加一个「已尝试」标记不值得。
 */
async function loadAuthContext(request: FastifyRequest): Promise<AuthContext | null> {
  const cached = request.authContext
  if (cached !== null) {
    return cached
  }

  const context = await resolveAuthContext(request)
  if (context !== null) {
    request.authContext = context
  }
  return context
}

function sendUnauthorized(reply: FastifyReply): FastifyReply {
  return reply
    .code(401)
    .header('www-authenticate', 'Bearer')
    .send({ error: 'unauthorized', message: '请先登录' })
}

/** 要求已认证。通过后 `request.authContext` 一定有值。 */
export const requireAuth: preHandlerHookHandler = async (request, reply) => {
  const context = await loadAuthContext(request)
  if (context === null) {
    return sendUnauthorized(reply)
  }
}

/**
 * 要求持有指定权限点。
 *
 * 权限点用 `PermissionCode` 类型而不是字符串，调用方只能从 `@fanhe/shared`
 * 的清单里取值。写错一个字母会在编译期被拒绝，而不是变成一个永远返回 403 的
 * 路由 —— 后者在联调时表现为「权限配了却不生效」，排查方向会先落到数据库上。
 */
export function requirePermission(required: PermissionCode): preHandlerHookHandler {
  return async (request, reply) => {
    const context = await loadAuthContext(request)
    if (context === null) {
      return sendUnauthorized(reply)
    }

    if (!hasPermission(context.permissions, required)) {
      // 403 要记日志。与登录失败不同，这里已经知道是谁在访问，拒绝记录是排查
      // 「权限配错了」与「有人在试探」的唯一依据。
      request.log.warn(
        { userId: context.userId, role: context.roleCode, required },
        'permission denied',
      )
      return reply.code(403).send({
        error: 'forbidden',
        message: '没有执行该操作的权限',
      })
    }
  }
}
