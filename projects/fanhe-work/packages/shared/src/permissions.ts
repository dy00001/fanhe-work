/**
 * 权限点与角色的唯一事实来源。
 *
 * 服务端做校验、前端做菜单与按钮的可见性，两边引用同一份常量。把这些字符串
 * 分别写在前后端，最终一定会出现前端藏了按钮、后端照旧放行这类不一致 ——
 * 而这类不一致在界面上完全看不出来，只能靠人读代码发现。
 *
 * 命名固定三段式 模块.对象.操作，与 permissions.code 一一对应。三段之外不再
 * 加层级：权限点清单要能被人在评审时一次读完，更深的命名会迅速失控。
 *
 * 关于客户与运营平台：实施方案里 member 对这两处的权限写的是「按授权」，
 * 而数据模型中没有 user_permissions 表，两者的对象清单也还没定。因此这里
 * 不预先编造权限点，等阶段三这两个模块的对象确定后再追加。追加只需新增常量
 * 与权限行，不动表结构。
 */

/** 权限点的模块段。与 permissions.module 的取值域一致。 */
export const PERMISSION_MODULES = ['system', 'personal'] as const
export type PermissionModule = (typeof PERMISSION_MODULES)[number]

/**
 * 全部权限点。新增权限只改这一处，类型、清单与种子数据都由它派生。
 * system 段对应管理后台，personal 段对应个人工作台的三个板块。
 */
export const PERMISSIONS = {
  SYSTEM_USER_READ: 'system.user.read',
  SYSTEM_USER_MANAGE: 'system.user.manage',
  SYSTEM_ROLE_READ: 'system.role.read',
  SYSTEM_ROLE_MANAGE: 'system.role.manage',
  SYSTEM_AUDIT_READ: 'system.audit.read',

  PERSONAL_LAUNCH_READ: 'personal.launch.read',
  PERSONAL_LAUNCH_WRITE: 'personal.launch.write',
  PERSONAL_NOTE_READ: 'personal.note.read',
  PERSONAL_NOTE_WRITE: 'personal.note.write',
  PERSONAL_EVENT_READ: 'personal.event.read',
  PERSONAL_EVENT_WRITE: 'personal.event.write',
} as const

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS]

export const ALL_PERMISSIONS: readonly PermissionCode[] = Object.values(PERMISSIONS)

/** 权限点的中文说明，用于管理界面展示与种子数据。 */
const PERMISSION_DESCRIPTIONS: Record<PermissionCode, string> = {
  [PERMISSIONS.SYSTEM_USER_READ]: '查看账号列表与详情',
  [PERMISSIONS.SYSTEM_USER_MANAGE]: '创建、停用账号，重置密码',
  [PERMISSIONS.SYSTEM_ROLE_READ]: '查看角色及其权限分配',
  [PERMISSIONS.SYSTEM_ROLE_MANAGE]: '修改角色与权限分配',
  [PERMISSIONS.SYSTEM_AUDIT_READ]: '查看审计日志',

  [PERMISSIONS.PERSONAL_LAUNCH_READ]: '查看一键登录启动配置',
  [PERMISSIONS.PERSONAL_LAUNCH_WRITE]: '新增、修改、删除启动配置并启动',
  [PERMISSIONS.PERSONAL_NOTE_READ]: '查看工作纪要',
  [PERMISSIONS.PERSONAL_NOTE_WRITE]: '撰写、修改、删除工作纪要',
  [PERMISSIONS.PERSONAL_EVENT_READ]: '查看事件记录',
  [PERMISSIONS.PERSONAL_EVENT_WRITE]: '新增、勾选完成、删除事件记录',
}

export type PermissionMeta = {
  code: PermissionCode
  module: PermissionModule
  object: string
  action: string
  description: string
}

/**
 * 权限点清单。三段由 code 拆分得到，不手写，避免 code 与三段列出现不一致。
 * 拆分结果不是三段时直接抛错：这是在模块加载期就暴露的编码错误，不该等到
 * 写库时才因为列值不合法而失败。
 */
export const PERMISSION_CATALOG: readonly PermissionMeta[] = ALL_PERMISSIONS.map((code) => {
  const parts = code.split('.')
  const [module, object, action] = parts
  if (parts.length !== 3 || !module || !object || !action) {
    throw new Error(`权限点编码必须为 模块.对象.操作 三段式，收到：${code}`)
  }
  return {
    code,
    module: module as PermissionModule,
    object,
    action,
    description: PERMISSION_DESCRIPTIONS[code],
  }
})

// ---------------------------------------------------------------------------
// 角色
// ---------------------------------------------------------------------------

export const ROLE_CODES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member',
  VIEWER: 'viewer',
} as const

export type RoleCode = (typeof ROLE_CODES)[keyof typeof ROLE_CODES]

export type RoleDefinition = {
  code: RoleCode
  name: string
  description: string
  /** 层级高低。数值大的可以管理数值小的，同层之间互相不可管理。 */
  rank: number
  /** 内置角色不允许在界面上删除。四个角色全部内置。 */
  isSystem: boolean
  /** 授权模式，写法见 expandGrants。种子阶段展开成具体的权限行。 */
  grants: readonly string[]
}

export const ROLES: readonly RoleDefinition[] = [
  {
    code: ROLE_CODES.OWNER,
    name: '超级管理员',
    description: '全部权限，含账号与角色管理、审计查看',
    rank: 100,
    isSystem: true,
    grants: ['*'],
  },
  {
    code: ROLE_CODES.ADMIN,
    name: '管理员',
    description: '业务模块全部读写，可管理普通成员',
    rank: 80,
    isSystem: true,
    // 不含 system.role.manage 与 system.audit.read：改角色和看审计属于 owner 的职责。
    // system.user.manage 给了，但「只能管理比自己低级的账号」这条限制由服务端按
    // rank 判定，不是靠少给一个权限点来实现 —— 权限点是二值的，表达不了层级。
    grants: [
      'personal.*',
      PERMISSIONS.SYSTEM_USER_READ,
      PERMISSIONS.SYSTEM_USER_MANAGE,
      PERMISSIONS.SYSTEM_ROLE_READ,
    ],
  },
  {
    code: ROLE_CODES.MEMBER,
    name: '成员',
    description: '个人工作台全权',
    rank: 50,
    isSystem: true,
    grants: ['personal.*'],
  },
  {
    code: ROLE_CODES.VIEWER,
    name: '只读访客',
    description: '仅查看，不可写',
    rank: 10,
    isSystem: true,
    grants: ['personal.*.read'],
  },
]

/**
 * 判断一个权限点是否命中一条授权模式。支持四种写法：
 *
 *   `*`                  全部权限
 *   `personal.*`         模块下的全部权限
 *   `personal.note.*`    对象上的全部操作
 *   `personal.note.read` 单个权限点
 *
 * 按点号分段逐段比较，不用正则：正则要转义元字符，而权限点里除了 `*` 都是
 * 字母数字，分段比较更短也更好读。段数不等直接不命中，所以 `personal.*`
 * 不会意外匹配到 `personal.note.read.extra` 这类更长的编码。
 */
export function matchesGrant(pattern: string, code: PermissionCode): boolean {
  if (pattern === '*') return true
  const patternSegments = pattern.split('.')
  const codeSegments = code.split('.')
  if (patternSegments.length !== codeSegments.length) return false
  return patternSegments.every(
    (segment, index) => segment === '*' || segment === codeSegments[index],
  )
}

/**
 * 把授权模式展开成具体的权限点集合。
 *
 * 展开只在种子阶段做一次，运行时只做精确匹配。把通配匹配放到请求路径上意味着
 * 每个请求都要重新解析一遍模式，而角色与权限的对应关系在进程启动后就固定了，
 * 没有理由为它付出每请求的开销。
 */
export function expandGrants(grants: readonly string[]): PermissionCode[] {
  const resolved = new Set<PermissionCode>()
  for (const code of ALL_PERMISSIONS) {
    if (grants.some((pattern) => matchesGrant(pattern, code))) {
      resolved.add(code)
    }
  }
  return [...resolved]
}

/**
 * 把 ROLES 的授权模式展开成一张「角色 → 权限点」的表。
 *
 * 累加器先断言成目标类型再逐项填充：ROLES 每一项的 code 都是 RoleCode，
 * 循环会把四个键全部写到，所以这个断言在运行期成立。这里没有改用
 * Object.fromEntries，因为它推导出的键类型是 string，与 RoleCode 不重叠，
 * 转型会被 TS 直接拒绝，绕过去只能再套一层 unknown，反而更弱。
 */
function buildRolePermissions(): Record<RoleCode, readonly PermissionCode[]> {
  const table = {} as Record<RoleCode, readonly PermissionCode[]>
  for (const role of ROLES) {
    table[role.code] = expandGrants(role.grants)
  }
  return table
}

/** 每个角色展开后的权限点，供种子脚本直接使用。新增角色只改 ROLES 一处。 */
export const ROLE_PERMISSIONS = buildRolePermissions()

/**
 * 服务端权限校验的唯一入口。
 *
 * 只做精确匹配，不做通配 —— 通配已在种子阶段展开完毕。这条限制是有意的：
 * 如果这里接受模式串，调用方就可能把用户输入拼进来，而权限判断接受不可信
 * 输入是越权的经典成因。
 *
 * 权限校验只能发生在服务端。前端的菜单隐藏与按钮禁用只承担体验职责，
 * 任何人改一个请求就能绕过它们。
 */
export function hasPermission(
  granted: readonly PermissionCode[],
  required: PermissionCode,
): boolean {
  return granted.includes(required)
}
