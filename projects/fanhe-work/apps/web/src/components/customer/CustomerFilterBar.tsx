import { CUSTOMER_STAGES } from '@fanhe/shared'
import { X } from 'lucide-react'
import { useState } from 'react'

import {
  CUSTOMER_RANGE_OPTIONS,
  SCOPE_OPTIONS,
  activeFilterCount,
  clearFilter,
  customInputs,
  customRange,
  resolveCustomerRange,
  type CustomerFilterKey,
  type CustomerFilters,
} from '../../lib/customer-filters'
import { stageLabel } from '../../lib/customer-display'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'

/**
 * 两栏共用的筛选条。
 *
 * 综合看板与客户进度用同一个组件、同一份状态（存在地址栏里），因此「在看板筛了
 * 海外，点进进度页还是海外」是构造上成立的，不靠两处各维护一份再手动同步。
 *
 * **自定义区间用两个日期框，改动即刻生效，不做「确定」按钮。** 起止两个值互相
 * 依赖（终点必须晚于起点），加一个暂存态就要处理「暂存到一半时列表显示什么」，
 * 而那个中间态在界面上无法解释。逐次生效时，任何一次选择都对应一个合法区间。
 */
export function CustomerFilterBar(props: {
  filters: CustomerFilters
  onChange: (next: CustomerFilters) => void
  /** 当前时刻，用于「自定义」的初始日期与区间文案。 */
  now: Date
}) {
  /**
   * 搜索框的输入暂存。`null` 表示「用户还没动过这个框」，此时显示地址里生效的关键词。
   *
   * 直接用一个空字符串做初值会有一个说不通的状态：从带 `?q=李` 的链接进来（或按了
   * 浏览器后退），框里是空的、下面却挂着一个「关键词「李」」的标签。两处说的不是
   * 同一件事，而使用者只会以为自己看到的是全部客户。
   */
  const [draft, setDraft] = useState<string | null>(null)
  const { filters } = props
  const inputs = customInputs(filters.range)
  const activeCount = activeFilterCount(filters)
  const searchValue = draft ?? filters.q

  const patch = (next: Partial<CustomerFilters>) => props.onChange({ ...filters, ...next })

  const chips: { key: CustomerFilterKey; label: string }[] = []
  if (filters.range.key !== 'all') chips.push({ key: 'range', label: filters.range.label })
  // 从选项表里反查文案，而不是把地址里的字符串直接当类型用：手改过的地址可能带一个
  // 不存在的地区或阶段，那时标签应当消失，不该把英文枚举值印在界面上。
  const scopeOption = SCOPE_OPTIONS.find((option) => option.value === filters.scope)
  if (scopeOption !== undefined) chips.push({ key: 'scope', label: scopeOption.label })
  const stageValue = CUSTOMER_STAGES.find((stage) => stage === filters.stage)
  if (stageValue !== undefined) chips.push({ key: 'stage', label: stageLabel(stageValue) })
  if (filters.q !== '') chips.push({ key: 'q', label: `关键词「${filters.q}」` })
  if (filters.pendingReview) chips.push({ key: 'review', label: '只看待复核' })

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted-foreground">时间范围</span>
          <div className="flex flex-wrap items-center gap-1">
            {CUSTOMER_RANGE_OPTIONS.map((option) => {
              const selected = filters.range.key === option.key
              return (
                <button
                  key={option.key}
                  type="button"
                  onClick={() => {
                    if (option.key === 'custom') {
                      // 已经在自定义档上时不重置用户填过的日期。
                      if (filters.range.key === 'custom') return
                      // 切到自定义时先落一个「今天」，否则区间会退化成「全部」，
                      // 而用户看到的是按钮已经选中、数据却是全量。
                      patch({
                        range: customRange(dayText(props.now), dayText(props.now)) ?? filters.range,
                      })
                      return
                    }
                    patch({
                      range: resolveCustomerRange(
                        { preset: option.key, from: null, to: null },
                        props.now,
                      ),
                    })
                  }}
                  className={cn(
                    'rounded-md border px-2 py-1 text-xs transition-colors',
                    selected
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {option.label}
                </button>
              )
            })}
          </div>
        </div>

        {filters.range.key === 'custom' ? (
          <div className="flex items-end gap-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="customer-range-from" className="text-xs text-muted-foreground">
                起始日
              </label>
              <Input
                id="customer-range-from"
                type="date"
                value={inputs.from}
                onChange={(event) => {
                  const next = customRange(event.target.value, inputs.to)
                  if (next !== null) patch({ range: next })
                }}
                className="w-36"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="customer-range-to" className="text-xs text-muted-foreground">
                截止日
              </label>
              <Input
                id="customer-range-to"
                type="date"
                value={inputs.to}
                onChange={(event) => {
                  const next = customRange(inputs.from, event.target.value)
                  if (next !== null) patch({ range: next })
                }}
                className="w-36"
              />
            </div>
          </div>
        ) : null}

        <form
          className="flex items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            patch({ q: searchValue.trim() })
            // 交回给地址：之后输入框显示的就是生效值，标签与框不会再对不上。
            setDraft(null)
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label htmlFor="customer-search" className="text-xs text-muted-foreground">
              搜索客户
            </label>
            <Input
              id="customer-search"
              value={searchValue}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="姓名、昵称或显示名"
              className="w-48"
            />
          </div>
          <Button type="submit" variant="outline" size="sm">
            查询
          </Button>
        </form>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="customer-scope" className="text-xs text-muted-foreground">
            地区
          </label>
          {/* 用原生 select 而不是造一个下拉组件：这里只需要「选一个值」，
              原生元素自带键盘操作与读屏支持，造一个反而要补齐这些。 */}
          <select
            id="customer-scope"
            value={filters.scope}
            onChange={(event) => patch({ scope: event.target.value })}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
          >
            <option value="">全部地区</option>
            {SCOPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="customer-stage" className="text-xs text-muted-foreground">
            阶段
          </label>
          <select
            id="customer-stage"
            value={filters.stage}
            onChange={(event) => patch({ stage: event.target.value })}
            className="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground"
          >
            <option value="">全部阶段</option>
            {CUSTOMER_STAGES.map((value) => (
              <option key={value} value={value}>
                {stageLabel(value)}
              </option>
            ))}
          </select>
        </div>

        <label className="flex h-8 items-center gap-2 text-sm text-muted-foreground">
          <Checkbox
            checked={filters.pendingReview}
            onCheckedChange={(checked) => patch({ pendingReview: checked === true })}
          />
          只看待复核
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-2">
        <span className="text-[11px] text-muted-foreground-weak">
          {activeCount === 0 ? '未设筛选，统计全量客户' : `生效 ${activeCount} 项`}
        </span>

        {chips.map((chip) => (
          <span
            key={chip.key}
            className="inline-flex items-center gap-1 rounded-md bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground"
          >
            {chip.label}
            <button
              type="button"
              aria-label={`移除筛选：${chip.label}`}
              onClick={() => {
                // 去掉关键词标签时把输入框一并交回地址，否则框里还留着刚被撤掉的那个词。
                if (chip.key === 'q') setDraft(null)
                props.onChange(clearFilter(filters, chip.key))
              }}
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}

        {filters.range.degraded ? (
          <span className="text-[11px] text-destructive">
            地址里的自定义区间不完整，已回到全部时间
          </span>
        ) : null}

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={activeCount === 0}
          onClick={() => {
            setDraft(null)
            props.onChange({
              range: resolveCustomerRange({ preset: 'all', from: null, to: null }, props.now),
              scope: '',
              stage: '',
              q: '',
              pendingReview: false,
            })
          }}
        >
          重置筛选
        </Button>
      </div>
    </section>
  )
}

/** 本地日期 → `YYYY-MM-DD`，供 `input[type=date]` 与自定义区间初始化共用。 */
function dayText(value: Date): string {
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
}
