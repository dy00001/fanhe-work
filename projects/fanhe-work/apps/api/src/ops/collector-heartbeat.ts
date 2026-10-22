/**
 * 采集器心跳的读写。
 *
 * ## 心跳就是「有人来拉待办」
 *
 * 没有单独的 `POST /heartbeat` 端点，也不需要。常驻进程每一轮都会来问「有没有
 * 待同步的店」，那个动作本身就是存活证明。把它做成显式端点会多出一条链路
 * （新路由、新鉴权、新 CLI），而它要回答的问题只有一个：有没有人在接单。
 *
 * 两种传输各写一次：
 *
 *   - HTTP：`GET /api/ops/shops/pending` 的 handler 里
 *   - DB 直连：`tools/ops-shop-pending.ts` 里
 *
 * 两处调同一个 `touchCollectorHeartbeat`，所以「换传输方式导致心跳断掉」这类
 * 分叉不会发生。
 *
 * ## 写失败不影响主流程
 *
 * 心跳写不进去时只记日志。拉待办是主流程，它不该因为一张统计表的 upsert 失败
 * 而整体报错；界面上表现成「离线」，这已经是可接受的降级。
 */
import {
  OPS_COLLECTOR_ONLINE_WINDOW_MS,
  isCollectorOnline,
  type OpsCollectorStatus,
} from '@fanhe/shared'

import { prisma } from '../db/prisma.js'

/**
 * 单行表的主键。
 *
 * 允许用 `OPS_HEARTBEAT_ID` 换掉，只为集成测试：那条用例要写心跳、还要把它改成
 * 过期时间来验离线，而真实运行时那一行由常驻进程每分钟刷新。测试直接写 'watch'
 * 会在 `after` 里把生产行删掉 —— 界面随即显示「采集器从未启动」，而那台机器上
 * 进程好端端跑着。换成独立 id 后，测试只碰自己那一行。
 */
const HEARTBEAT_ID = process.env.OPS_HEARTBEAT_ID?.trim() || 'watch'

/** 记录一次心跳。`source` 是 `http` 或 `local`，仅用于排查。 */
export async function touchCollectorHeartbeat(source: 'http' | 'local'): Promise<void> {
  try {
    await prisma.opsCollectorHeartbeat.upsert({
      where: { id: HEARTBEAT_ID },
      create: { id: HEARTBEAT_ID, lastSeenAt: new Date(), source },
      update: { lastSeenAt: new Date(), source },
    })
  } catch (error) {
    console.warn('[ops] 采集器心跳写入失败：', error)
  }
}

/**
 * 读采集器状态。
 *
 * 用 `OPS_COLLECTOR_ONLINE_WINDOW_MS` 判定，与前端展示同源 —— 阈值只写一处，
 * 否则会出现「接口说在线、界面说离线」这种没人能解释的分歧。
 */
export async function readCollectorStatus(nowMs: number = Date.now()): Promise<OpsCollectorStatus> {
  const row = await prisma.opsCollectorHeartbeat.findUnique({
    where: { id: HEARTBEAT_ID },
    select: { lastSeenAt: true },
  })
  const lastSeenAt = row === null ? null : row.lastSeenAt.toISOString()
  return { lastSeenAt, online: isCollectorOnline(lastSeenAt, nowMs) }
}

export { OPS_COLLECTOR_ONLINE_WINDOW_MS }
