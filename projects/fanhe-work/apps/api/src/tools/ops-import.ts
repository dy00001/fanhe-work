/**
 * 历史回填：把采集侧导出的契约 JSON 直接写进库。
 *
 * 为什么需要一条「绕过 HTTP」的路径：日常采集走 `POST /api/ops/ingest`（回环 +
 * 共享密钥），那条路要 API 进程在跑、要配 token。而回填是**一次性动作** —— 新机
 * 部署、库被重建、想把 30 天基线再灌一遍时，为它先起一个服务再配一套密钥没有
 * 收益，反而多一处会配错的地方。
 *
 * 两条路径共用同一个 `ingestOpsSnapshot`。这一点必须守住：回填与日常写入如果走
 * 两套代码，「回填进去的数」与「每天采进来的数」就会在 `revised`、去重、窗口
 * 清理这些细节上分叉，而分叉出来的差异不会被任何测试发现。
 *
 * 用法（在 apps/api 下）：
 *   node_modules/.bin/tsx src/tools/ops-import.ts [契约 JSON 路径]
 * 不传路径时读 `tools/collector/data/ingest/ops-ingest.json`。
 */
import fs from 'node:fs'
import path from 'node:path'

import type { OpsIngestRequest } from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import { ingestFailureMessage, ingestOpsSnapshot } from '../ops/ingest.js'

const DEFAULT_RELATIVE = path.join(
  '..',
  '..',
  'tools',
  'collector',
  'data',
  'ingest',
  'ops-ingest.json',
)

function resolveInputPath(argv: readonly string[]): string {
  const explicit = argv[2]
  if (explicit !== undefined && explicit.trim() !== '') return path.resolve(explicit)
  return path.resolve(process.cwd(), DEFAULT_RELATIVE)
}

/**
 * 只做「够不够用」的形状检查。
 *
 * 真正的校验在 `ingestOpsSnapshot` 里（窗口合法性、行数上限、日期落在窗口内）。
 * 这里只挡一种情况：文件根本不是一个契约对象 —— 那种输入会让后面的校验给出
 * 「窗口不合法」这种误导性的报错。
 */
function parsePayload(raw: string, file: string): OpsIngestRequest {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`${file} 不是一个 JSON 对象`)
  }
  const candidate = parsed as Partial<OpsIngestRequest>
  if (candidate.contractVersion !== 1) {
    throw new Error(`${file} 的 contractVersion 不是 1，当前只认 v1 契约`)
  }
  if (!Array.isArray(candidate.daily) || !Array.isArray(candidate.dimensions)) {
    throw new Error(`${file} 缺少 daily / dimensions 数组`)
  }
  return candidate as OpsIngestRequest
}

async function main(): Promise<void> {
  const file = resolveInputPath(process.argv)
  if (!fs.existsSync(file)) {
    console.error(`找不到契约文件：${file}`)
    console.error('先在 tools/collector 下跑 node scripts/export-ingest.mjs 生成它。')
    process.exitCode = 1
    return
  }

  const payload = parsePayload(fs.readFileSync(file, 'utf8'), file)
  console.log(`读入 ${path.basename(file)}：窗口 ${payload.window.from} ~ ${payload.window.to}`)
  console.log(`逐日 ${payload.daily.length} 行，维度 ${payload.dimensions.length} 行`)

  const started = Date.now()
  const result = await ingestOpsSnapshot(payload)
  if (!result.ok) {
    console.error(`写入失败：${ingestFailureMessage(result.reason)} —— ${result.detail}`)
    process.exitCode = 1
    return
  }

  console.log('写入完成。')
  console.log(`  店铺 id      ${result.data.shopId}`)
  console.log(`  批次 id      ${result.data.runId}`)
  console.log(`  逐日行       ${result.data.dailyWritten}`)
  console.log(`  维度行       ${result.data.dimensionsWritten}`)
  console.log(`  被改写天数   ${result.data.revisedDays}`)
  console.log(`  耗时         ${Date.now() - started} ms`)
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
  .finally(() => {
    void prisma.$disconnect()
  })
