/**
 * 没有任何可访问模块时的兜底界面。
 *
 * 走得到这里的情形只有一种：当前账号不持有任何模块的权限，可见清单为空。当前
 * 四个内置角色都至少持有 personal 段权限，所以它暂时不可达 —— 但分支不能省。
 * 可见清单为空时若直接解引用第一项，运行期会在离原因很远的地方抛出，而那时
 * 已经很难看出问题出在权限配置上。
 */
export function NoAccessPage() {
  return (
    <section className="rounded-xl border border-border bg-card p-6">
      <h1 className="text-base font-medium text-foreground">没有可访问的模块</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        当前账号没有任何模块的权限，请联系管理员分配角色。若刚刚被调整过权限，请退出后重新登录。
      </p>
    </section>
  )
}
