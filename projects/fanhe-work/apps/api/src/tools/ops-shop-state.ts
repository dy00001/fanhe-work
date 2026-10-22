/**
 * 采集器回写店铺状态（DB 直写）。
 *
 * 与 `ops-shop-pending.ts` 成对：容器化之后 HTTP 版（`POST /api/ops/shops/<code>/state`）
 * 会被回环校验挡在门外，而「登录态」与「失败原因」是界面唯一的行动指引，不能
 * 因此停在 unknown。
 *
 * 走同一个 `reportShopState`，校验、字段与幂等行为与 HTTP 版完全一致。
 *
 * ## 用法（在 apps/api 下）
 *
 *   node_modules/.bin/tsx src/tools/ops-shop-state.ts <状态 JSON 路径>
 *
 * JSON 形状与 HTTP 请求体一致：
 *   { "code": "fanhe-main", "loginState": "authenticated",
 *     "lastSyncError": null, "collectedAt": "2026-10-22T15:00:00.000Z",
 *     "clearSyncRequest": true }
 *
 * 用文件而不是命令行参数传中文失败原因：cmd 与 PowerShell 的编码不一致会把
 * 「登录态失效」变成乱码写进库，而乱码在界面上看起来像另一个问题。
 */
import fs from 'node:fs'
import path from 'node:path'

import { prisma } from '../db/prisma.js'
import { reportShopState } from '../ops/shop-binding.js'

function readPayload(argv: readonly string[]): unknown {
  const file = argv[2]
  if (file === undefined || file.trim() === '') {
    throw new Error('缺少状态 JSON 路径。用法：tsx src/tools/ops-shop-state.ts <文件>')
  }
  const resolved = path.resolve(file)
  if (!fs.existsSync(resolved)) throw new Error(`状态文件不存在：${resolved}`)
  return JSON.parse(fs.readFileSync(resolved, 'utf8')) as unknown
}

const payload = readPayload(process.argv)
const result = await reportShopState(payload)

if (!result.ok) {
  console.error(`状态回写被拒绝（${result.reason}）：${result.message}`)
  await prisma.$disconnect()
  process.exit(1)
}

console.log(
  `状态已回写：${result.shop.code} loginState=${result.shop.loginState} syncRequestedAt=${
    result.shop.syncRequestedAt ?? 'null'
  }`,
)
await prisma.$disconnect()
