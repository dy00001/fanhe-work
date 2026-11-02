import { cn } from '../../lib/utils'
import { donutArcs, percentText, type StageTone } from '../../lib/customer-display'

/**
 * 环形图（手写 SVG，不引图表库）。
 *
 * 与运营看板那张柱状图同一条取舍：这里只需要「一段弧 + 悬停读数 + 点击下钻」，
 * 而任何图表库都会带进第二套主题系统（与「令牌唯一来源」冲突）和几十 KB 的体积。
 *
 * **颜色按阶段色调分五档，不给 14 个状态各配一色。** 同一档里的两个阶段在环上相邻
 * 且同色时靠 1% 的间隙分开，读图靠右侧图例逐条对齐，不靠猜颜色。给 14 个状态各配
 * 一色的结果是环上出现 14 种颜色，而人眼最多同时分辨五六种，多出来的只是噪音；
 * 更要紧的是列表与详情里阶段徽标用的就是这五档色调，环上换一套配色会让同一屏出现
 * 两套颜色语言。
 */
export type DonutSlice = {
  key: string
  label: string
  value: number
  tone: StageTone
}

/** 色调到 SVG 描边与图例圆点。**写死成完整类名**，拼字符串的类名 Tailwind 扫不到。 */
const TONE_CLASS: Record<StageTone, { stroke: string; dot: string }> = {
  neutral: { stroke: 'stroke-m-neutral', dot: 'bg-m-neutral' },
  progress: { stroke: 'stroke-m-blue', dot: 'bg-m-blue' },
  warn: { stroke: 'stroke-m-amber', dot: 'bg-m-amber' },
  done: { stroke: 'stroke-m-teal', dot: 'bg-m-teal' },
  danger: { stroke: 'stroke-destructive', dot: 'bg-destructive' },
}

export function CustomerDonut(props: {
  title: string
  note: string
  slices: readonly DonutSlice[]
  /** 环心的大字。 */
  centerValue: string
  /** 环心的小字，说明大字是什么。 */
  centerLabel: string
  /** 数值格式化。金额与人数用不同的写法，由调用方给。 */
  formatValue: (value: number) => string
  /** 没有数据时的说明。 */
  emptyText: string
  /** 点击某一段。给了才渲染成可点，没给就是纯展示。 */
  onSelect?: ((key: string) => void) | undefined
}) {
  const values = props.slices.map((slice) => slice.value)
  const arcs = donutArcs(values)
  const total = values.reduce((sum, value) => sum + value, 0)

  return (
    <section className="flex flex-col rounded-xl border border-border bg-card p-4">
      <div className="flex items-baseline gap-2">
        <h3 className="text-sm font-medium text-foreground">{props.title}</h3>
        <p className="ml-auto text-[11px] text-muted-foreground-weak">{props.note}</p>
      </div>

      {total <= 0 ? (
        <p className="flex flex-1 items-center justify-center py-10 text-sm text-muted-foreground-weak">
          {props.emptyText}
        </p>
      ) : (
        <div className="mt-3 flex flex-1 flex-col gap-4 sm:flex-row sm:items-center">
          <div className="relative mx-auto w-36 shrink-0">
            <svg viewBox="0 0 120 120" className="size-36" role="img" aria-label={props.title}>
              {/* 底环。没有它时，数据只有一段会看起来像加载到一半。 */}
              <circle
                cx="60"
                cy="60"
                r="48"
                fill="none"
                strokeWidth="14"
                className="stroke-muted"
              />
              {props.slices.map((slice, index) => {
                const arc = arcs[index]
                if (arc === undefined || arc.fraction <= 0) return null
                // 1% 的间隙。同色相邻的两段没有它就连成一段，读起来像少了一个阶段。
                const span = Math.max(arc.fraction * 100 - 1, 0.5)
                return (
                  <circle
                    key={slice.key}
                    cx="60"
                    cy="60"
                    r="48"
                    fill="none"
                    strokeWidth="14"
                    pathLength={100}
                    strokeDasharray={`${span} ${100 - span}`}
                    strokeDashoffset={-arc.start * 100}
                    transform="rotate(-90 60 60)"
                    className={cn(
                      TONE_CLASS[slice.tone].stroke,
                      props.onSelect === undefined
                        ? undefined
                        : 'cursor-pointer transition-opacity hover:opacity-80',
                    )}
                    onClick={
                      props.onSelect === undefined
                        ? undefined
                        : () => {
                            props.onSelect?.(slice.key)
                          }
                    }
                  >
                    <title>{`${slice.label} ${props.formatValue(slice.value)}（${percentText(arc.fraction)}）`}</title>
                  </circle>
                )
              })}
            </svg>
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-xl font-medium text-foreground tabular-nums">
                {props.centerValue}
              </span>
              <span className="mt-0.5 text-[11px] text-muted-foreground-weak">
                {props.centerLabel}
              </span>
            </div>
          </div>

          {/* 图例既是读数表，也是键盘可达的入口。环上的弧只有鼠标点得到，
              键盘用户走这一列按钮，两条路径落到同一个动作。 */}
          <ul className="flex min-w-0 flex-1 flex-col gap-0.5">
            {props.slices.map((slice, index) => {
              const arc = arcs[index]
              const fraction = arc?.fraction ?? 0
              const row = (
                <>
                  <span className={cn('size-2 shrink-0 rounded-sm', TONE_CLASS[slice.tone].dot)} />
                  <span className="truncate text-xs text-muted-foreground">{slice.label}</span>
                  <span className="ml-auto shrink-0 text-xs text-foreground tabular-nums">
                    {props.formatValue(slice.value)}
                  </span>
                  <span className="w-10 shrink-0 text-right text-[11px] text-muted-foreground-weak tabular-nums">
                    {percentText(fraction)}
                  </span>
                </>
              )
              return (
                <li key={slice.key}>
                  {props.onSelect === undefined ? (
                    <div className="flex items-center gap-2 rounded-md px-1 py-1">{row}</div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        props.onSelect?.(slice.key)
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent"
                    >
                      {row}
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </section>
  )
}
