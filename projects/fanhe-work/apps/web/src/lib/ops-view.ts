/**
 * 看板的视图与区间预设。
 *
 * 从 `OpsToolbar.tsx` 搬出来，理由只有一条但很实际：**组件文件里导出常量会触发
 * `react-refresh/only-export-components`** —— 一个文件同时导出组件与普通值时，
 * Vite 的热更新无法判断「这次改动要不要整块重挂」，于是每次改一个文案都刷新整个
 * 页面，状态全丢。项目其余组件文件都遵守这条，这里也照办。
 *
 * 这些值是**页面状态的取值域**，不只是工具条的内部细节：地址栏里的 `?view=` 与
 * `?p=` 直接对应它们，路由层与页面都在用。
 */

export const OPS_VIEWS = [
  { key: 'overview', label: '总览' },
  { key: 'trade', label: '交易' },
  { key: 'items', label: '商品' },
  { key: 'flow', label: '流量' },
  { key: 'service', label: '服务' },
  { key: 'ads', label: '推广' },
  { key: 'content', label: '内容' },
] as const

export type OpsView = (typeof OPS_VIEWS)[number]['key']

/**
 * 区间预设。
 *
 * 只到 90 天，没有「单日」。单日在原型里存在，但那一档需要把访客与买家按 1/30
 * 折算并标红字；现在接口给的是真实逐日值，选自定义区间并让起止同一天即可拿到
 * 真值，没必要再提供一种会打折的读数。
 */
export const OPS_PRESETS = [
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '14d', label: '近 14 天', days: 14 },
  { key: '30d', label: '近 30 天', days: 30 },
  { key: '90d', label: '近 90 天', days: 90 },
] as const

export type OpsPresetKey = (typeof OPS_PRESETS)[number]['key']

/** `custom` 不是预设之一，它是「手输起止日期」这一档。 */
export type OpsPreset = OpsPresetKey | 'custom'

export function isOpsView(value: string | null): value is OpsView {
  return OPS_VIEWS.some((view) => view.key === value)
}

export function isOpsPreset(value: string | null): value is OpsPreset {
  if (value === 'custom') return true
  return OPS_PRESETS.some((preset) => preset.key === value)
}

/** 预设 → 天数。`custom` 没有固定天数，调用方必须自己给 from / to。 */
export function presetDays(preset: OpsPresetKey): number {
  const found = OPS_PRESETS.find((item) => item.key === preset)
  return found === undefined ? 30 : found.days
}
