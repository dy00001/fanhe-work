import { PERMISSION_CATALOG, ROLE_PERMISSIONS, ROLES, type RoleCode } from '@fanhe/shared'

import { prisma } from './prisma.js'

/**
 * 种子数据。可重复执行，重跑不产生副作用。
 *
 * 只写三类数据：权限点清单、四个内置角色、角色与权限的关联。
 *
 * **不创建任何账号。** 超级管理员由首次初始化引导创建（T1-08），在界面里由
 * 人设定用户名与密码。种子里塞一个带默认口令的管理员是最常见的一类事故来源：
 * 它会在每台部署过的机器上都存在，而且没人记得改。
 *
 * 权限点与角色都以 code 为键做 upsert，所以改了名称或说明后重跑即生效。
 * 角色权限关联做差集同步，新增缺失的、删除多余的 —— 四个内置角色的授权完全
 * 由代码定义，「多余」就是确实该移除的。
 *
 * 放在 src/db 而不是 Prisma 惯例的 prisma/seed.ts：api 的 tsconfig 把 rootDir
 * 限定为 src，放在 prisma 目录下会脱离类型检查，或者要为它再引一份 tsconfig。
 * 这个脚本是要写库的真实代码，不该落在检查范围之外。prisma.config.ts 里显式
 * 指向本文件，所以不存在找不到入口的问题。
 */

type SeedReport = {
  permissions: number
  roles: number
  grantsAdded: number
  grantsRemoved: number
}

async function seed(): Promise<SeedReport> {
  const knownRoleCodes = new Set<string>(ROLES.map((role) => role.code))

  return prisma.$transaction(async (tx) => {
    for (const meta of PERMISSION_CATALOG) {
      await tx.permission.upsert({
        where: { code: meta.code },
        create: {
          code: meta.code,
          module: meta.module,
          object: meta.object,
          action: meta.action,
          description: meta.description,
        },
        update: {
          module: meta.module,
          object: meta.object,
          action: meta.action,
          description: meta.description,
        },
      })
    }

    for (const role of ROLES) {
      await tx.role.upsert({
        where: { code: role.code },
        create: {
          code: role.code,
          name: role.name,
          description: role.description,
          rank: role.rank,
          isSystem: role.isSystem,
        },
        update: {
          name: role.name,
          description: role.description,
          rank: role.rank,
          isSystem: role.isSystem,
        },
      })
    }

    const roleRows = await tx.role.findMany({ select: { id: true, code: true } })
    const permissionRows = await tx.permission.findMany({ select: { id: true, code: true } })
    const permissionIdByCode = new Map(permissionRows.map((row) => [row.code, row.id]))

    let grantsAdded = 0
    let grantsRemoved = 0

    for (const role of roleRows) {
      // 只同步代码里定义过的角色。将来支持自建角色时，那些角色的授权由界面
      // 维护，种子脚本不该把它们抹掉 —— 少这一道判断，重跑一次种子就会清空
      // 用户自己配的权限，而且不会有任何报错。
      if (!knownRoleCodes.has(role.code)) continue

      const desiredCodes = ROLE_PERMISSIONS[role.code as RoleCode]
      const missingCodes = desiredCodes.filter((code) => !permissionIdByCode.has(code))
      if (missingCodes.length > 0) {
        // 静默跳过会留下一个权限不完整的角色，且看不出问题。这里直接失败。
        throw new Error(`角色 ${role.code} 引用了不存在的权限点：${missingCodes.join('、')}`)
      }
      const desiredIds = new Set(desiredCodes.map((code) => permissionIdByCode.get(code) as string))

      const current = await tx.rolePermission.findMany({
        where: { roleId: role.id },
        select: { id: true, permissionId: true },
      })
      const currentIds = new Set(current.map((row) => row.permissionId))

      const toAdd = [...desiredIds].filter((id) => !currentIds.has(id))
      const toRemove = current
        .filter((row) => !desiredIds.has(row.permissionId))
        .map((row) => row.id)

      if (toAdd.length > 0) {
        await tx.rolePermission.createMany({
          data: toAdd.map((permissionId) => ({ roleId: role.id, permissionId })),
        })
        grantsAdded += toAdd.length
      }
      if (toRemove.length > 0) {
        await tx.rolePermission.deleteMany({ where: { id: { in: toRemove } } })
        grantsRemoved += toRemove.length
      }
    }

    return {
      permissions: PERMISSION_CATALOG.length,
      roles: ROLES.length,
      grantsAdded,
      grantsRemoved,
    }
  })
}

const report = await seed()

console.log('种子写入完成。')
console.log(`  权限点        ${report.permissions}`)
console.log(`  内置角色      ${report.roles}`)
console.log(`  新增授权关联  ${report.grantsAdded}`)
console.log(`  移除授权关联  ${report.grantsRemoved}`)
console.log('')
console.log('未创建任何账号，超级管理员由首次初始化引导创建（T1-08）。')

await prisma.$disconnect()
