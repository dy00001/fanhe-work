import type { NavCode, NavItem } from '@fanhe/shared'

type NavRailProps = {
  /** 已按当前权限过滤后的导航项，顺序即界面顺序。 */
  items: readonly NavItem[]
  /** 导航清单的总项数。与 `items.length` 一起构成可见范围的对照。 */
  total: number
  activeCode: NavCode | null
  onSelect: (code: NavCode) => void
}

/**
 * 左侧导航。
 *
 * 阶段一的临时形态：只承担「按权限过滤 + 选中态」两件事，宽度取 224px 以对齐
 * 实施方案第五章的布局规格，但不含折叠、顶栏、面包屑与二级导航 —— 那几项属
 * 阶段二 T2-02 的布局骨架，届时本组件会被整体替换，而过滤逻辑
 * （`filterNavigation`）与选中项的解析（`resolveActiveNav`）继续沿用。
 *
 * 之所以把 `total` 传进来而不是用 `NAV_ITEMS.length`，是为了让这个组件不依赖
 * 清单本身：它只画传进来的东西，可见范围的判断全在共享包里完成。组件一旦自己
 * 去读清单，过滤就有两处实现，而其中一处迟早会漏改。
 *
 * 底部那行「可见 N / 共 M」是给开发者看的，不是给最终用户看的。只看菜单本身
 * 无法区分「过滤生效了」与「清单本来就只有这几项」；把两个数摆在一起，阶段一
 * 验收清单里「四种角色可见范围符合预期」这一条才有可观察的落点。
 */
export function NavRail({ items, total, activeCode, onSelect }: NavRailProps) {
  return (
    <nav className="w-56 shrink-0 border-r border-line bg-card px-3 py-4">
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = item.code === activeCode
          return (
            <li key={item.code}>
              <button
                type="button"
                onClick={() => onSelect(item.code)}
                aria-current={active ? 'page' : undefined}
                className={
                  active
                    ? 'flex w-full items-center justify-between gap-2 rounded-lg bg-accent-soft px-3 py-2 text-left text-sm font-medium text-ink'
                    : 'flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-soft transition-colors hover:bg-surface'
                }
              >
                <span>{item.label}</span>
                {item.planned && <span className="shrink-0 text-xs text-ink-faint">开发中</span>}
              </button>
            </li>
          )
        })}
      </ul>

      <p className="mt-4 px-3 text-xs text-ink-faint">
        可见 {items.length} / 共 {total} 项
      </p>
    </nav>
  )
}
