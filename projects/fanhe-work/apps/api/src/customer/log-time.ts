/**
 * 聊天记录里的时间字符串转 `Date`。
 *
 * 单独成文件是因为**导入与每日同步两条路径都要用它**，而两处各写一份必然在
 * 某次改动后分叉：一边按本地时间、一边按 UTC，症状是每条 `lastMessageAt` 都
 * 差 8 小时 —— 界面上看起来只是「最近消息时间是早上」，不会有人当 bug 报。
 *
 * `2026-10-28 11:48` 不带时区，按 ES 规范以**本地时间**解析（本机 UTC+8），
 * 存进 `timestamptz` 即 `03:48Z`。前端格式化回本地仍是 11:48，与 md 里一致。
 */
export function parseLogTime(value: string | null | undefined): Date | null {
  if (value === null || value === undefined || value.trim() === '') return null
  const normalized = value.trim().replace(' ', 'T')
  const withSeconds = /T\d{2}:\d{2}$/.test(normalized) ? `${normalized}:00` : normalized
  const parsed = new Date(withSeconds)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
