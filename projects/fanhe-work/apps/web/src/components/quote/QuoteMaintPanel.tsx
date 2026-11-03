import type { QuoteAccessStateResponse, QuoteMetaResponse } from '@fanhe/shared'
import { useState } from 'react'

import { minutesUntil } from '../../lib/quote-display'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'

import { QuoteCategoryManager } from './maint/QuoteCategoryManager'
import { QuoteImportPanel } from './maint/QuoteImportPanel'
import { QuoteProductManager } from './maint/QuoteProductManager'
import { QuoteRevisionList } from './maint/QuoteRevisionList'

/**
 * 价格与产品维护台。**这是价格的唯一在线入口。**
 *
 * ## 从「说明书」改成「操作台」
 *
 * 上一版这一屏是六节说明文档（数据入口、字段映射、同步机制、商品图、授权、记录），
 * 因为静态稿第 4 节的原话是「本期只读，不可写」。结果是点进来什么都不能做 ——
 * 2026-11-03 用户报「价格维护页面不可操作」就是这么来的。
 *
 * 这一版把说明整块去掉，换成四个真正能干活的区：分类、产品与价格、批量导入、
 * 变更记录。说明性的内容（谁能改、图怎么绑、字段从哪来）不再占这一屏 —— 需要
 * 的时候看代码注释与文档，界面留给操作。
 *
 * ## 为什么把改价从查价面板搬过来
 *
 * 查价面板是**查**的地方。改价按钮混在结果表右侧，会让「点一条看看多少钱」与
 * 「改它的价」共用同一块区域，手滑的代价是改错一条真实在用的价格。搬到这里之后
 * 查价面板回归只读，改价要先过维护口令、再进这一屏 —— 两步都是有意的。
 *
 * ## 四个区共用一次授权
 *
 * 口令在进入这一屏之前就已经验过（`PriceGateDialog`），30 分钟内有效。这里不再
 * 逐区校验，但每个写操作都带 `x-quote-unlock`，过期时服务端返回 403，界面上给
 * 一句「口令已失效」—— 不静默失败。
 */
export function QuoteMaintPanel({
  open,
  onOpenChange,
  access,
  meta,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  access: QuoteAccessStateResponse | null
  meta: QuoteMetaResponse | null
  /** 任何写操作成功后通知外层：重新拉 meta 与结果列表。 */
  onChanged: () => void
}) {
  const [tab, setTab] = useState<TabKey>('categories')
  /** 变更记录的重取开关。别的区改完东西，切过去时要看到最新几条。 */
  const [revisionToken, setRevisionToken] = useState(0)

  const remaining = minutesUntil(access?.unlockedUntil ?? null)
  const badge =
    access === null
      ? '读取权限中'
      : access.direct
        ? '超级管理员 · 免口令'
        : remaining !== null && remaining > 0
          ? `已解锁 · 剩余 ${remaining} 分钟`
          : '需要维护口令'
  const badgeClass =
    access !== null && (access.direct || (remaining !== null && remaining > 0))
      ? 'bg-[color-mix(in_srgb,var(--m-teal)_11%,transparent)] text-m-teal border-[color-mix(in_srgb,var(--m-teal)_22%,transparent)]'
      : 'bg-[color-mix(in_srgb,var(--m-amber)_12%,transparent)] text-m-amber border-[color-mix(in_srgb,var(--m-amber)_24%,transparent)]'

  function handleChanged(): void {
    setRevisionToken((value) => value + 1)
    onChanged()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 尺寸用内联 style：`w-[min(1180px,96vw)]` 这类带 `min()` 的任意值在 Tailwind v4
          里会被整条丢弃（11-02 踩过），表现为面板被内容压成一条竖线。 */}
      <DialogContent
        showCloseButton={false}
        style={{
          width: 'min(1180px, 96vw)',
          height: 'min(820px, 92vh)',
          maxWidth: 'none',
          maxHeight: 'none',
        }}
        className="grid grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden rounded-2xl p-0"
      >
        <div className="flex items-center gap-3 border-b border-border-soft px-5 py-3.5">
          <div>
            <DialogTitle className="flex items-center gap-2 text-base font-medium">
              价格与产品维护
              <span
                className={`inline-flex items-center rounded-full border px-2 text-[11px] leading-[18px] font-normal ${badgeClass}`}
              >
                {badge}
              </span>
            </DialogTitle>
            <DialogDescription className="mt-1 text-xs text-muted-foreground-weak">
              分类 · 产品与价格 · 批量导入 · 变更记录
            </DialogDescription>
          </div>
          <button
            type="button"
            onClick={() => {
              onOpenChange(false)
            }}
            className="ml-auto inline-flex h-8 items-center rounded-[9px] border border-border bg-card px-3 text-[13px] hover:bg-accent"
          >
            关闭
          </button>
        </div>

        <div className="flex min-h-0">
          <nav aria-label="维护分区" className="w-[142px] shrink-0 border-r border-border-soft p-2">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-current={tab === item.key ? 'page' : undefined}
                onClick={() => setTab(item.key)}
                className={
                  tab === item.key
                    ? 'mb-0.5 block w-full rounded-[9px] bg-secondary px-2.5 py-2 text-left'
                    : 'mb-0.5 block w-full rounded-[9px] px-2.5 py-2 text-left hover:bg-accent'
                }
              >
                <span
                  className={
                    tab === item.key
                      ? 'block text-[13px] font-medium text-foreground'
                      : 'block text-[13px] text-muted-foreground'
                  }
                >
                  {item.label}
                </span>
                <span className="mt-0.5 block text-[10.5px] leading-[1.5] text-muted-foreground-weak">
                  {item.hint}
                </span>
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 overflow-hidden p-4">
            {tab === 'categories' && <QuoteCategoryManager onChanged={handleChanged} />}
            {tab === 'products' && (
              <QuoteProductManager access={access} onChanged={handleChanged} />
            )}
            {tab === 'import' && <QuoteImportPanel onChanged={handleChanged} />}
            {tab === 'revisions' && <QuoteRevisionList reloadToken={revisionToken} />}
          </div>
        </div>

        <div className="flex items-center gap-2.5 border-t border-border-soft px-5 py-2.5 text-xs text-muted-foreground-weak">
          <span>改动即时生效，报价查价页刷新即可看到</span>
          <span className="ml-auto">
            数据版本{' '}
            <code className="font-mono">
              {meta === null ? '…' : meta.version.slice(0, 12) || '未导入'}
            </code>
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

type TabKey = 'categories' | 'products' | 'import' | 'revisions'

const TABS: readonly { key: TabKey; label: string; hint: string }[] = [
  { key: 'categories', label: '分类', hint: '改名 · 合并 · 排序' },
  { key: 'products', label: '产品与价格', hint: '新增 · 改价 · 上下架' },
  { key: 'import', label: '批量导入', hint: 'Excel / CSV / PDF' },
  { key: 'revisions', label: '变更记录', hint: '谁改了什么' },
]
