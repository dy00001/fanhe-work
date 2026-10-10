/**
 * 测试用的环境变量。
 *
 * 必须作为测试文件的**第一个** import。ESM 按声明顺序执行互不依赖的顶层模块，
 * 排在前面才能保证 env.ts 加载时读到的是这些值 —— env.ts 在模块加载期就求值，
 * 晚一步就没用了。
 *
 * 用 `=` 而不是 `??=`：这些值决定断言的结果，必须是确定的，不能因为开发机的
 * .env 或 shell 里恰好设了同名变量就换一套参数。dotenv 不覆盖已存在的
 * process.env 变量，所以先设就能压住 .env 里的值。
 *
 * DATABASE_URL 指向一个不存在的实例，端口 1 上不会有人监听。不需要数据库的
 * 测试因此不会误连；需要数据库的测试必须自己显式跳过，不能默认它可用。
 */

process.env.DATABASE_URL = 'postgresql://unused:unused@127.0.0.1:1/unused'
process.env.JWT_SECRET = 'test-only-signing-key-at-least-32-bytes-long'
process.env.ARGON2_MEMORY_KIB = '19456'
process.env.ARGON2_TIME_COST = '2'
process.env.ARGON2_PARALLELISM = '1'

export {}
