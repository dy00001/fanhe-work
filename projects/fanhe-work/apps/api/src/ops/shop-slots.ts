/**
 * 采集槽位文件的读写（`tools/collector/shops.config.json`）。
 *
 * ## 为什么绑定入口要碰这个文件
 *
 * 采集器认店靠的是**文件**，平台认店靠的是**库**。两份事实源并存是既有设计，
 * 不是疏忽：采集器必须能在平台不可达时照常跑（`tools/collector/README.md` 的
 * 边界），所以它不能改成每次启动都去问 API。
 *
 * 代价是「绑定成功但采集器不认识这家店」这种半成功状态。这个模块的职责就是把
 * 半成功压到最小：能在本机找到配置文件就同步写进去，找不到（容器部署、只读挂载）
 * 就明确返回 `manual`，由界面把该粘贴的片段显示出来。
 *
 * ## 三条纪律
 *
 *   1. **只增改自己那一行。** 其它店铺的 `note`、`qianniu`、`collect` 一律原样保留。
 *      整份重写会把人工维护的备注抹掉，而备注是排查串店时唯一的线索。
 *   2. **原子替换。** 先写 `.tmp` 再 `rename`。直接覆盖时进程被杀会留下半个 JSON，
 *      采集器 `loadConfig()` 会直接抛错，整个采集端起不来。
 *   3. **失败不抛。** 槽位写不进去不该让绑定失败：库里已经有这条店，采集器下次
 *      读到配置后仍能按 code 采。返回 `manual` 让界面去提示。
 */
import fs from 'node:fs'
import path from 'node:path'

export type SlotSyncResult =
  { kind: 'synced'; path: string } | { kind: 'manual'; reason: string; snippet: string }

type SlotInput = {
  code: string
  name: string
  port: number
}

/**
 * 从进程工作目录向上找配置文件。
 *
 * 开发态 API 跑在 `apps/api`，向上两级就是仓库根；容器里工作目录是 `/app` 或
 * `/repo`，没有 `tools/collector`，于是自然落到 `manual`。用「向上找」而不是
 * 用相对路径常量，是为了让 `pnpm --filter` 切换工作目录时也不会写错位置。
 *
 * `OPS_SLOTS_FILE` 可以覆盖这个查找：集成测试必须能写一份临时槽位表，否则
 * 一次 `pnpm test` 就会把测试店铺永久写进仓库里的真实配置（首版就是这样把
 * `zz-test-ops-bind` 写进去的）。
 */
export function findSlotsFile(startDir: string = process.cwd()): string | null {
  const override = process.env.OPS_SLOTS_FILE
  if (override !== undefined && override.trim() !== '') return override.trim()

  let current = path.resolve(startDir)
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = path.join(current, 'tools', 'collector', 'shops.config.json')
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return null
}

/** 界面可直接展示的片段。找不到配置文件时返回它，避免让人凭记忆手写。 */
export function slotSnippet(input: SlotInput): string {
  return JSON.stringify(
    {
      code: input.code,
      name: input.name,
      port: input.port,
      collect: true,
      state: 'active',
      note: '由工作台绑定入口创建',
    },
    null,
    2,
  )
}

/**
 * 把一家店写进槽位表。已存在同 code 时只更新 name/port，其余字段保留。
 *
 * 端口冲突直接拒绝，且**不自动换端口**：换端口意味着界面显示的和人配置的不是
 * 一个值，而采集器按文件走，出了问题很难对上。
 */
export function upsertSlot(input: SlotInput, startDir?: string): SlotSyncResult {
  const file = findSlotsFile(startDir)
  if (file === null) {
    return {
      kind: 'manual',
      reason: '当前运行环境找不到 tools/collector/shops.config.json（容器部署属正常情况）',
      snippet: slotSnippet(input),
    }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (error) {
    return {
      kind: 'manual',
      reason: `槽位表读取失败：${error instanceof Error ? error.message : String(error)}`,
      snippet: slotSnippet(input),
    }
  }

  const shops = Array.isArray(parsed.shops) ? (parsed.shops as Array<Record<string, unknown>>) : []
  const occupied = shops.find(
    (shop) => shop.code !== input.code && Number(shop.port) === input.port,
  )
  if (occupied !== undefined) {
    return {
      kind: 'manual',
      reason: `端口 ${input.port} 已被槽位 ${String(occupied.code)} 占用，请换一个端口后重试`,
      snippet: slotSnippet(input),
    }
  }

  const existing = shops.find((shop) => shop.code === input.code)
  if (existing !== undefined) {
    existing.name = input.name
    existing.port = input.port
    if (existing.collect === undefined) existing.collect = true
  } else {
    shops.push({
      code: input.code,
      name: input.name,
      port: input.port,
      collect: true,
      state: 'active',
      note: '由工作台绑定入口创建',
    })
  }
  parsed.shops = shops

  try {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return { kind: 'synced', path: file }
  } catch (error) {
    return {
      kind: 'manual',
      reason: `槽位表写入失败：${error instanceof Error ? error.message : String(error)}`,
      snippet: slotSnippet(input),
    }
  }
}

/** 解绑时把 `collect` 关掉。**不删行**：删掉会丢失该店的人工备注与千牛对照信息。 */
export function disableSlot(code: string, startDir?: string): SlotSyncResult {
  const file = findSlotsFile(startDir)
  if (file === null) {
    return {
      kind: 'manual',
      reason: '找不到槽位表，需人工把该店的 collect 改为 false',
      snippet: code,
    }
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch (error) {
    return {
      kind: 'manual',
      reason: `槽位表读取失败：${error instanceof Error ? error.message : String(error)}`,
      snippet: code,
    }
  }
  const shops = Array.isArray(parsed.shops) ? (parsed.shops as Array<Record<string, unknown>>) : []
  const target = shops.find((shop) => shop.code === code)
  if (target === undefined) return { kind: 'synced', path: file }
  target.collect = false
  target.state = 'disabled'
  try {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return { kind: 'synced', path: file }
  } catch (error) {
    return {
      kind: 'manual',
      reason: `槽位表写入失败：${error instanceof Error ? error.message : String(error)}`,
      snippet: code,
    }
  }
}
