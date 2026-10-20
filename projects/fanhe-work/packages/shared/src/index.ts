/**
 * web 与 api 两个应用共享的类型与常量。
 *
 * 只放两边都要用的东西：跨进程传输的结构、需要严格一致的字面量集合。
 * 只在一个应用里用到的类型留在那个应用内部，塞进来会让这个包变成杂物间，
 * 最后没人知道某个导出还有没有人在用。
 *
 * 注意本包不依赖任何运行时框架，也不引入数据库客户端 —— api 侧的 Prisma
 * 类型留在 apps/api，一旦从这里导出，web 的构建就会被拖上数据库依赖。
 */

export * from './account.js'
export * from './audit.js'
export * from './auth.js'
export * from './event.js'
export * from './launch.js'
export * from './navigation.js'
export * from './note.js'
export * from './ops.js'
export * from './permissions.js'
export * from './user-admin.js'
export * from './version.js'

export const APP_NAME = '梵禾 Work'
export const API_PORT = 8787

export type HealthResponse = {
  status: string
  service: string
  time: string
}
