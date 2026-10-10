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
    // seed 命令在 T1-02 补上 `tsx prisma/seed.ts`。此时文件还不存在，
    // 提前写进来会让 `prisma migrate dev` 在迁移完成后因找不到脚本而失败。
  },
  datasource: {
    url: process.env.DATABASE_URL ?? FALLBACK_DATABASE_URL,
  },
})
