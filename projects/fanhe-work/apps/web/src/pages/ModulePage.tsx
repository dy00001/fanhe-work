import type { NavItem } from '@fanhe/shared'

/**
 * 模块页面的统一头部。
 *
 * 五个一级模块的页面都由它承担：标题、占位标注、规划范围说明。之所以先统一到
 * 这里，是因为标题与标注的排版在五个页面上一字不差，各写一份的话改一次要改五处。
 *
 * **占位页的进一步细化属 T2-04**：那时会换成带插画与操作入口的独立页面。本组件
 * 现在只做「路由接通后每个模块都有一个能渲染的落点」，不预先造出 T2-04 的界面。
 *
 * 注意 `planned` 与 `module` 是正交的两个属性：系统设置已绑 `system` 段权限，
 * 但它仍是占位项，所以这里判断的是 `planned` 而不是 `module === null`。
 */
export function ModulePage({ item }: { item: NavItem }) {
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <div className="flex items-center gap-3">
        <h1 className="text-base font-medium text-foreground">{item.label}</h1>
        {item.planned && (
          <span className="rounded-md bg-accent px-2 py-0.5 text-xs text-muted-foreground">
            功能开发中
          </span>
        )}
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{item.summary}</p>
    </section>
  )
}
