/**
 * 店铺绑定的写模型。
 *
 * ## 一次绑定实际改了三处
 *
 *   1. `ecom_shops`：登记店铺本体，并置 `syncRequestedAt` 作为「请采集器尽快采一次」的信号。
 *   2. `shops.config.json`：采集器认店的唯一来源（能写就写，写不了返回 manual）。
 *   3. 登录态：**不由这里写**。绑定入口没有能力判断浏览器里那个号还能不能用，
 *      判据只有采集器的 `login-check.mjs`。这里只把 `loginState` 置为 `unknown`。
 *
 * 第 3 条是这一层最重要的边界。平台侧一旦开始「推断」登录态，就会出现界面说
 * 已登录、采集器说没登录的两套结论，而人只会相信界面上那个绿点。
 *
 * ## 为什么写操作都不删行
 *
 * 解绑走 `enabled = false`。逐日指标、维度快照、采集批次都以 `shopId` 为外键，
 * 删店等于级联删历史，而历史是唯一能解释「上个月的数字为什么是这样」的东西。
 * 重新绑定同一个 code 时，历史自然接上。
 */
import {
  OPS_COLLECT_PORT_MAX,
  OPS_COLLECT_PORT_MIN,
  validateShopBindInput,
  validateShopStateReport,
  type OpsShopSummary,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'
import {
  OPS_SHOP_SUMMARY_SELECT,
  isShopVisible,
  toOpsShopSummary,
  type OpsShopViewer,
} from './query.js'
import { disableSlot, upsertSlot, type SlotSyncResult } from './shop-slots.js'

export type ShopMutationFailure = {
  ok: false
  reason: 'invalid' | 'duplicate' | 'port_conflict' | 'not_found' | 'not_bound' | 'forbidden'
  message: string
}

export type ShopMutationSuccess = {
  ok: true
  shop: OpsShopSummary
  slot: SlotSyncResult
}

export type ShopMutationResult = ShopMutationSuccess | ShopMutationFailure

/** 端口唯一性。只比「启用中的店」：解绑的店保留端口占位没有意义。 */
async function portTaken(port: number, exceptCode: string): Promise<string | null> {
  const occupied = await prisma.ecomShop.findFirst({
    where: { enabled: true, collectPort: port, code: { not: exceptCode } },
    select: { code: true },
  })
  return occupied === null ? null : occupied.code
}

/**
 * 挑一个没被占用的采集端口。
 *
 * ## 为什么界面不问端口了还要分配
 *
 * 端口是旧 CDP 链路（每店一个 Edge 调试端口）的产物，插件链路取数完全不经过它。
 * 但采集器的槽位表仍要求参与采集的店有唯一端口 —— `lib/shops.mjs` 遇到
 * `collect: true` 却没有 port 会直接抛错，**整份配置都加载不起来**，五家店一起停。
 * 所以「界面不问」必须配一个自动分配，否则绑定出来的店永远进不了槽位表。
 *
 * 从 `OPS_COLLECT_PORT_MIN` 起顺排，跳过启用中的店已占用的值。解绑的店不算占用：
 * 它已经不参与采集，留着端口只会把后来的店往高位推。
 */
async function nextFreePort(): Promise<number> {
  const rows = await prisma.ecomShop.findMany({
    where: { enabled: true, collectPort: { not: null } },
    select: { collectPort: true },
  })
  const taken = new Set(rows.map((row) => row.collectPort))
  for (let port = OPS_COLLECT_PORT_MIN; port <= OPS_COLLECT_PORT_MAX; port += 1) {
    if (!taken.has(port)) return port
  }
  /* 端口段用尽是理论上的情况（一万六千多个）。返回起点让下面那条 portTaken
     查重把它当成冲突报出来，比在这里抛一个没人接的异常干净。 */
  return OPS_COLLECT_PORT_MIN
}

/**
 * 绑定一家店。
 *
 * `syncRequestedAt` 在创建时就置为当前时刻，这是「绑定后自动同步」的触发点：
 * 采集器的 `sync-shops.mjs` 轮询 `GET /api/ops/shops/pending`，看到这家店就
 * 立刻跑一轮采集。**不在这里直接调采集器**，因为 API 可能跑在容器里，碰不到
 * 宿主机的 Edge 与调试端口。
 */
export async function bindShop(input: unknown, actorUserId: string): Promise<ShopMutationResult> {
  const validated = validateShopBindInput(input)
  if (!validated.ok) return { ok: false, reason: 'invalid', message: validated.message }
  const value = validated.value

  const existing = await prisma.ecomShop.findUnique({
    where: { code: value.code },
    select: { id: true, enabled: true },
  })
  if (existing !== null && existing.enabled) {
    return {
      ok: false,
      reason: 'duplicate',
      message: `店铺代号 ${value.code} 已被占用，换一个代号或先在列表里解绑`,
    }
  }

  /* 调用方没给端口就自动分配。这一步不能省：槽位表要求参与采集的店必须有唯一
     端口，缺了会让采集器整份配置加载失败，五家店一起停。 */
  const collectPort = value.collectPort ?? (await nextFreePort())

  const takenBy = await portTaken(collectPort, value.code)
  if (takenBy !== null) {
    return {
      ok: false,
      reason: 'port_conflict',
      message: `端口 ${collectPort} 已被店铺 ${takenBy} 使用`,
    }
  }

  const now = new Date()
  /* 同一个 code 之前解绑过时走「重新启用」，历史数据原地接上，不新建行。 */
  const row =
    existing === null
      ? await prisma.ecomShop.create({
          data: {
            code: value.code,
            name: value.name,
            platform: value.platform,
            sellerNick: value.sellerNick,
            collectPort,
            boundAt: now,
            loginState: 'unknown',
            syncRequestedAt: now,
            /* 谁绑的归谁。公共店留给种子与导入，绑定入口一律记人。 */
            ownerId: actorUserId,
          },
          select: OPS_SHOP_SUMMARY_SELECT,
        })
      : await prisma.ecomShop.update({
          where: { code: value.code },
          data: {
            name: value.name,
            platform: value.platform,
            sellerNick: value.sellerNick,
            collectPort,
            enabled: true,
            boundAt: now,
            loginState: 'unknown',
            loginCheckedAt: null,
            lastSyncError: null,
            syncRequestedAt: now,
          },
          select: OPS_SHOP_SUMMARY_SELECT,
        })

  /* 槽位写入失败不算绑定失败：库里已经有了，采集器下次读配置仍能按 code 采。 */
  const slot = upsertSlot({ code: value.code, name: value.name, port: collectPort })

  return { ok: true, shop: toOpsShopSummary(row), slot }
}

/**
 * 修改店铺。只允许改名称、掌柜、端口、启用状态。
 *
 * 代号不可改：它同时是槽位键、采集目录名、ingest 的 upsert 键。改代号等于
 * 把这家店的历史留在一个再也采不到的地方。
 */
export async function updateShop(
  code: string,
  patch: unknown,
  viewer: OpsShopViewer,
): Promise<ShopMutationResult> {
  if (!(await isShopVisible(code, viewer))) {
    return { ok: false, reason: 'forbidden', message: `店铺 ${code} 不在你的可见范围内` }
  }
  const current = await prisma.ecomShop.findUnique({
    where: { code },
    select: {
      code: true,
      name: true,
      platform: true,
      sellerNick: true,
      collectPort: true,
      enabled: true,
      ownerId: true,
    },
  })
  if (current === null) {
    return { ok: false, reason: 'not_found', message: `店铺 ${code} 不存在` }
  }

  const raw = typeof patch === 'object' && patch !== null ? (patch as Record<string, unknown>) : {}

  /* 改归属：只接受 null（设为公共）或一个存在的账号 id。不校验存在性会让库里
     留下一个指向空账号的归属，那家店此后对非管理员彻底不可见。 */
  let nextOwnerId = current.ownerId
  if (raw.ownerId !== undefined) {
    if (raw.ownerId === null) {
      nextOwnerId = null
    } else if (typeof raw.ownerId === 'string' && raw.ownerId !== '') {
      const owner = await prisma.user.findUnique({
        where: { id: raw.ownerId },
        select: { id: true },
      })
      if (owner === null) {
        return { ok: false, reason: 'invalid', message: `归属账号 ${raw.ownerId} 不存在` }
      }
      nextOwnerId = owner.id
    } else {
      return { ok: false, reason: 'invalid', message: 'ownerId 只能是账号 id 或 null' }
    }
  }

  const merged = {
    code: current.code,
    name: raw.name ?? current.name,
    platform: current.platform,
    sellerNick: raw.sellerNick === undefined ? current.sellerNick : raw.sellerNick,
    collectPort: raw.collectPort ?? current.collectPort,
  }
  const validated = validateShopBindInput(merged)
  if (!validated.ok) return { ok: false, reason: 'invalid', message: validated.message }
  const value = validated.value

  /* 早期种子里进来的店没有 collect_port，界面也不再让人补登记。改任何字段时
     顺带分配一个 —— 否则这家店永远进不了槽位表，也永远采不到。 */
  const collectPort = value.collectPort ?? (await nextFreePort())

  const takenBy = await portTaken(collectPort, code)
  if (takenBy !== null) {
    return {
      ok: false,
      reason: 'port_conflict',
      message: `端口 ${collectPort} 已被店铺 ${takenBy} 使用`,
    }
  }

  const enabled = raw.enabled === undefined ? current.enabled : raw.enabled === true
  const row = await prisma.ecomShop.update({
    where: { code },
    data: {
      name: value.name,
      sellerNick: value.sellerNick,
      collectPort,
      enabled,
      ownerId: nextOwnerId,
    },
    select: OPS_SHOP_SUMMARY_SELECT,
  })

  const slot = enabled
    ? upsertSlot({ code, name: value.name, port: collectPort })
    : disableSlot(code)

  return { ok: true, shop: toOpsShopSummary(row), slot }
}

/** 解绑。软删，历史保留；槽位表的 collect 置 false 而不是删行。 */
export async function unbindShop(code: string, viewer: OpsShopViewer): Promise<ShopMutationResult> {
  if (!(await isShopVisible(code, viewer))) {
    return { ok: false, reason: 'forbidden', message: `店铺 ${code} 不在你的可见范围内` }
  }
  const current = await prisma.ecomShop.findUnique({ where: { code }, select: { id: true } })
  if (current === null) {
    return { ok: false, reason: 'not_found', message: `店铺 ${code} 不存在` }
  }
  const row = await prisma.ecomShop.update({
    where: { code },
    data: { enabled: false, syncRequestedAt: null },
    select: OPS_SHOP_SUMMARY_SELECT,
  })
  return { ok: true, shop: toOpsShopSummary(row), slot: disableSlot(code) }
}

/**
 * 请求立即同步。界面上那个「立即同步」按钮就调它。
 *
 * 只写一个时间戳，不等待采集结果：采集一轮要几十秒到几分钟，把它做成同步
 * 请求会让界面长时间转圈，而且超时后无法区分「没采」与「采了但慢」。
 */
export async function requestShopSync(
  code: string,
  viewer: OpsShopViewer,
): Promise<ShopMutationResult> {
  if (!(await isShopVisible(code, viewer))) {
    return { ok: false, reason: 'forbidden', message: `店铺 ${code} 不在你的可见范围内` }
  }
  const current = await prisma.ecomShop.findUnique({
    where: { code },
    select: { enabled: true },
  })
  if (current === null) {
    return { ok: false, reason: 'not_found', message: `店铺 ${code} 不存在` }
  }
  if (!current.enabled) {
    return { ok: false, reason: 'not_bound', message: `店铺 ${code} 已解绑，重新绑定后才能同步` }
  }
  const row = await prisma.ecomShop.update({
    where: { code },
    data: { syncRequestedAt: new Date(), lastSyncError: null },
    select: OPS_SHOP_SUMMARY_SELECT,
  })
  /* 「立即同步」不碰槽位表，所以这里的 slot 是一个占位：kind 用 synced 表示
     「没有槽位问题需要处理」，path 留空。changed 恒为 false。 */
  return {
    ok: true,
    shop: toOpsShopSummary(row),
    slot: { kind: 'synced', path: '', changed: false },
  }
}

/**
 * 采集器拉取待同步的店铺。
 *
 * 返回 code 而不是整行：采集器只需要知道「该跑哪家」，其余信息它从本地
 * `shops.config.json` 取。让采集器依赖平台的数据形状，等于把两个进程的发布
 * 绑在一起。
 */
export async function listPendingShopCodes(limit = 5): Promise<string[]> {
  const rows = await prisma.ecomShop.findMany({
    where: { enabled: true, syncRequestedAt: { not: null } },
    orderBy: { syncRequestedAt: 'asc' },
    take: Math.min(Math.max(limit, 1), 20),
    select: { code: true },
  })
  return rows.map((row) => row.code)
}

export type ShopStateReportResult = { ok: true; shop: OpsShopSummary } | ShopMutationFailure

/**
 * 采集器回写登录态与失败原因。
 *
 * `clearSyncRequest` 为真时清空 `syncRequestedAt`。清空的条件由采集器判断：
 * 只有「这一轮确实处理过这家店」才置真。崩溃时不置真，下一轮自动重试。
 */
export async function reportShopState(report: unknown): Promise<ShopStateReportResult> {
  const validated = validateShopStateReport(report)
  if (!validated.ok) return { ok: false, reason: 'invalid', message: validated.message }
  const value = validated.value

  const current = await prisma.ecomShop.findUnique({
    where: { code: value.code },
    select: { id: true },
  })
  if (current === null) {
    return { ok: false, reason: 'not_found', message: `店铺 ${value.code} 不存在` }
  }

  const row = await prisma.ecomShop.update({
    where: { code: value.code },
    data: {
      loginState: value.loginState,
      loginCheckedAt: new Date(),
      lastSyncError: value.lastSyncError,
      ...(value.collectedAt === null ? {} : { lastCollectedAt: new Date(value.collectedAt) }),
      ...(value.clearSyncRequest ? { syncRequestedAt: null } : {}),
    },
    select: OPS_SHOP_SUMMARY_SELECT,
  })
  return { ok: true, shop: toOpsShopSummary(row) }
}
