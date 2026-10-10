import 'dotenv/config'
import { defineConfig } from 'prisma/config'

/**
 * Prisma 7 把两件事从 schema.prisma 移到了本文件。
 *
 * 一是连接串。schema 的 datasource 块只剩 provider，url 与 directUrl 都在这里。
 * 二是 .env 的加载。v7 不再自动读取 .env，必须自己 import dotenv，而且它必须是
 * 第一条 import —— 晚于 prisma/config 的话，下面读 process.env 会拿到 undefined。
 *
 * DATABASE_URL 留了本地默认值，目的是让 `prisma generate` 在没有数据库、也没有
 * .env 的机器上照样跑得通。generate 只读 schema 不建连接；真正连库的命令
 * （migrate、db pull、studio）拿到默认值连不上会直接报错退出，不会静默连错库。
 *
 * 连接串指向本机实例而不是工作空间内部，是因为数据库不随 U 盘移动：换一台机器
 * 就要在那一台的 .env 里指向那一台的 PostgreSQL。这条规则写在项目 README 里。
 */
const FALLBACK_DATABASE_URL = 'postgresql://fanhe:fanhe@127.0.0.1:5432/fanhe_work?schema=public'

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma migrate dev` 与 `prisma migrate reset` 会自动执行这一条。
    //
    // 前置条件是 @fanhe/shared 已经构建：种子脚本从那里取权限点与角色定义，
    // 保持单一事实来源。根目录的 `pnpm db:seed` 与 `pnpm db:migrate` 会先构建
    // 一次，直接调用 api 内的脚本则不会。
    seed: 'tsx src/db/seed.ts',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? FALLBACK_DATABASE_URL,
  },
})
