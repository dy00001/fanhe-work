import type { OpsCollectStatus, OpsMetricSource } from '@fanhe/shared'
import type { ReactNode } from 'react'

import {
  collectStatusLabel,
  collectStatusTone,
  sourceHint,
  sourceLabel,
  type CollectStatusTone,
} from '../../lib/ops-display'
import { cn } from '../../lib/utils'

/**
 * 口径徽标与状态徽标。
 *
 * 两件事合在一个文件，因为它们共用同一套色档与尺寸：分开写会很快出现「口径徽标
 * 是 11px、状态徽标是 12px」这种只有并排时才看得出的差异。
 *
 * **色档不写死颜色，只选语义档。** 真正的色值在 `index.css` 的令牌里，亮暗两套
 * 各一份。组件里写 `text-[#0f6e56]` 会让暗色模式下对比度掉下来，而这个问题在
 * 浅色主题下永远看不到。
 */

type Tone = 'neutral' | 'teal' | 'amber' | 'warn' | 'danger' | 'muted'

/**
 * 色档只改**文字色**，边框一律 `border-border`。
 *
 * 原型的做法是给每种色档配一个 `color-mix` 描边，观感更精致；但那种写法只能通过
 * Tailwind 的任意值语法塞进类名（`border-[color-mix(in_srgb,var(--m-teal)_35%,...)]`），
 * 一旦 Tailwind 的解析规则变化就会静默失效 —— 徽标会退回成一条黑边，而这类问题
 * 只能靠肉眼发现。文字色有现成令牌（`text-m-teal` 等），是稳定的那一种。
 */
const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-border text-muted-foreground',
  teal: 'border-border text-m-teal',
  amber: 'border-border text-m-amber',
  warn: 'border-border text-m-amber',
  danger: 'border-border text-destructive',
  muted: 'border-dashed border-border text-muted-foreground-weak',
}

const SOURCE_TONE: Record<OpsMetricSource, Tone> = {
  daily: 'teal',
  derived: 'amber',
  period: 'muted',
}

export function OpsChip(props: { tone?: Tone; title?: string; children: ReactNode }) {
  return (
    <span
      title={props.title}
      className={cn(
        'inline-flex shrink-0 items-center rounded border px-1 text-[11px] leading-[18px]',
        TONE_CLASS[props.tone ?? 'neutral'],
      )}
    >
      {props.children}
    </span>
  )
}

/**
 * 口径徽标。鼠标悬停给出解释，因为「整段」这种词在界面上没有上下文。
 *
 * 用原生 `title` 而不是 Tooltip 组件：这几个徽标出现在密集的卡片里，浮层容易
 * 盖住相邻的数字，而它们要传达的信息只有一句话。
 */
export function OpsSourceChip(props: { source: OpsMetricSource }) {
  return (
    <OpsChip tone={SOURCE_TONE[props.source]} title={sourceHint(props.source)}>
      {sourceLabel(props.source)}
    </OpsChip>
  )
}

/** 无权限时替换金额的位置。它必须看起来「不是 0」，所以用文字而不是破折号。 */
export function OpsMaskedChip() {
  return (
    <OpsChip tone="muted" title="当前账号没有 ops.finance.read 权限">
      无权限
    </OpsChip>
  )
}

const STATUS_TONE: Record<CollectStatusTone, Tone> = {
  ok: 'teal',
  warn: 'warn',
  bad: 'danger',
  idle: 'muted',
}

export function OpsCollectStatusChip(props: { status: OpsCollectStatus | null }) {
  return (
    <OpsChip tone={STATUS_TONE[collectStatusTone(props.status)]}>
      {collectStatusLabel(props.status)}
    </OpsChip>
  )
}
