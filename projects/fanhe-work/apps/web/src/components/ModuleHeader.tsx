import type { NavItem } from '@fanhe/shared'

/**
 * 已落地模块的页头。
 *
 * T2-04 之前它叫 `ModulePage`，同时承担两件事：已排期模块的页头，以及占位模块的
 * 「功能开发中」标注。占位渲染在 T2-04 移交给 `pages/PlaceholderPage.tsx` 之后，
 * 这里只剩页头一件事，因此改名并去掉占位标注分支。
 *
 * 之所以保留这一层而不是把两行标记摊进各页面：标题与规划说明的排版在已落地的模块页
 * 上是一致的，各写一份的话改一次要改多处，而这类偏差只在来回切换页面时才看得出来。
 */
export function ModuleHeader({ item }: { item: NavItem }) {
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <h1 className="text-base font-medium text-foreground">{item.label}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.summary}</p>
    </section>
  )
}
